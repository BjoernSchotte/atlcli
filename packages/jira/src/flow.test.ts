import { describe, expect, test } from "bun:test";
import {
  attachChangelogs,
  buildIssueFlowTimeline,
  computeCumulativeFlow,
  computeFlowMetrics,
  createStatusCategoryResolver,
  isoWeek,
  parseStatusMap,
  percentile,
  renderAgingText,
  renderFlowText,
  renderSparkline,
  resolveStatusMap,
  statusScopeJql,
  loadSprintHistory,
} from "./flow.js";
import { calculateBurndown, calculateSprintMetrics, issueAt, latestSprints } from "./analysis.js";
import type { JiraClient } from "./client.js";
import type { JiraChangelogEntry, JiraIssue, JiraStatus } from "./types.js";

const STATUSES: JiraStatus[] = [
  { id: "1", name: "To Do", statusCategory: { id: 2, key: "new", name: "To Do" } },
  { id: "2", name: "In Progress", statusCategory: { id: 4, key: "indeterminate", name: "In Progress" } },
  { id: "3", name: "Code Review", statusCategory: { id: 2, key: "new", name: "To Do" } },
  { id: "4", name: "Done", statusCategory: { id: 3, key: "done", name: "Done" } },
  { id: "5", name: "Closed", statusCategory: { id: 3, key: "done", name: "Done" } },
];
const NAME: Record<string, string> = Object.fromEntries(STATUSES.map((s) => [s.id, s.name]));
const resolve = createStatusCategoryResolver(STATUSES);

/** An issue created at `created` that walked through `path` ([statusId, ISO] pairs). */
function issue(
  key: string,
  created: string,
  path: Array<[string, string]>,
  extra: Partial<JiraIssue["fields"]> = {}
): JiraIssue {
  const histories: JiraChangelogEntry[] = [];
  let from = "1";
  for (const [to, at] of path) {
    histories.push({
      id: `${key}-${at}`,
      author: { accountId: "u1", displayName: "U" } as JiraChangelogEntry["author"],
      created: at,
      items: [{ field: "status", fieldtype: "jira", from, fromString: NAME[from] ?? null, to, toString: NAME[to] ?? null }],
    });
    from = to;
  }
  const current = STATUSES.find((s) => s.id === from) ?? { id: from, name: `Status ${from}` };
  return {
    id: key.replace(/\D/g, ""),
    key,
    self: "",
    fields: {
      summary: `Summary ${key}`,
      issuetype: { id: "1", name: "Story" },
      project: { id: "1", key: "P" },
      status: current,
      created,
      ...extra,
    } as JiraIssue["fields"],
    changelog: { histories },
  };
}

describe("status mapping", () => {
  test("maps Jira status categories and lets overrides win by id or name, case-insensitively", () => {
    expect(resolve({ id: "2" })).toBe("wip");
    expect(resolve({ id: "3", name: "Code Review" })).toBe("todo");
    const overridden = createStatusCategoryResolver(STATUSES, { "code review": "wip", "5": "wip" });
    expect(overridden({ id: "3", name: "Code Review" })).toBe("wip");
    expect(overridden({ id: "5", name: "Closed" })).toBe("wip");
    expect(resolve({ id: "99", name: "Gone" })).toBeUndefined();
  });

  test("parseStatusMap accepts names with spaces and rejects unknown categories", () => {
    expect(parseStatusMap("Code Review=wip, Blocked = WIP")).toEqual({ "Code Review": "wip", Blocked: "wip" });
    expect(() => parseStatusMap("Code Review=doing")).toThrow(/Invalid status map entry/);
    expect(() => parseStatusMap("=wip")).toThrow();
  });

  test("resolveStatusMap: profile beats global per key, the flag beats both", () => {
    expect(
      resolveStatusMap(
        { Review: "todo", Blocked: "wip" },
        { review: "wip" },
        { Blocked: "todo" }
      )
    ).toEqual({ review: "wip", Blocked: "todo" });
  });
});

describe("buildIssueFlowTimeline", () => {
  test("straight-through flow", () => {
    const t = buildIssueFlowTimeline(
      issue("P-1", "2026-10-01T08:00:00.000Z", [["2", "2026-10-02T08:00:00.000Z"], ["4", "2026-10-05T08:00:00.000Z"]]),
      resolve
    );
    expect(t.startedAt).toBe("2026-10-02T08:00:00.000Z");
    expect(t.doneAt).toBe("2026-10-05T08:00:00.000Z");
    expect(t.intervals.map((i) => i.category)).toEqual(["todo", "wip", "done"]);
  });

  test("reopen after done keeps the first start and uses the last entry into done", () => {
    const t = buildIssueFlowTimeline(
      issue("P-2", "2026-10-01T00:00:00.000Z", [
        ["2", "2026-10-02T00:00:00.000Z"],
        ["4", "2026-10-03T00:00:00.000Z"],
        ["2", "2026-10-04T00:00:00.000Z"],
        ["4", "2026-10-06T00:00:00.000Z"],
        ["5", "2026-10-07T00:00:00.000Z"],
      ]),
      resolve
    );
    expect(t.startedAt).toBe("2026-10-02T00:00:00.000Z");
    // Done → Closed stays one done run, so the run's start counts.
    expect(t.doneAt).toBe("2026-10-06T00:00:00.000Z");
  });

  test("skipped wip and an unknown status", () => {
    const skipped = buildIssueFlowTimeline(
      issue("P-3", "2026-10-01T00:00:00.000Z", [["4", "2026-10-02T00:00:00.000Z"]]),
      resolve
    );
    expect(skipped.startedAt).toBeUndefined();
    expect(skipped.doneAt).toBe("2026-10-02T00:00:00.000Z");
    const unknown = buildIssueFlowTimeline(
      issue("P-4", "2026-10-01T00:00:00.000Z", [["99", "2026-10-02T00:00:00.000Z"]]),
      resolve
    );
    expect(unknown.unknownStatuses).toEqual(["99"]);
  });

  test("histories in any order are replayed oldest first", () => {
    const i = issue("P-5", "2026-10-01T00:00:00.000Z", [["2", "2026-10-02T00:00:00.000Z"], ["4", "2026-10-03T00:00:00.000Z"]]);
    i.changelog!.histories.reverse();
    expect(buildIssueFlowTimeline(i, resolve).doneAt).toBe("2026-10-03T00:00:00.000Z");
  });

  test("no transitions: the current status is the only interval; done falls back to resolutiondate", () => {
    const i = issue("P-6", "2026-10-01T00:00:00.000Z", [], {
      status: STATUSES[3],
      resolutiondate: "2026-10-04T00:00:00.000Z",
    });
    const t = buildIssueFlowTimeline(i, resolve);
    expect(t.intervals).toHaveLength(1);
    expect(t.doneAt).toBe("2026-10-04T00:00:00.000Z");
  });
});

describe("percentile (nearest rank)", () => {
  test("n=1, n=2, n=20 and P85 of seven values", () => {
    expect(percentile([], 50)).toBeUndefined();
    expect(percentile([4], 85)).toBe(4);
    expect(percentile([1, 2], 50)).toBe(1);
    expect(percentile([1, 2], 85)).toBe(2);
    const twenty = Array.from({ length: 20 }, (_, i) => i + 1);
    expect(percentile(twenty, 50)).toBe(10);
    expect(percentile(twenty, 85)).toBe(17);
    expect(percentile(twenty, 95)).toBe(19);
    expect(percentile([1, 2, 3, 4, 5, 6, 7], 85)).toBe(6);
  });
});

describe("computeFlowMetrics", () => {
  const from = new Date("2026-10-01T00:00:00.000Z");
  const to = new Date("2026-10-14T23:59:59.999Z");
  const now = new Date("2026-10-15T00:00:00.000Z");

  function done(n: number, startDay: number, doneDay: number): JiraIssue {
    const d = (day: number) => `2026-10-${String(day).padStart(2, "0")}T12:00:00.000Z`;
    return issue(`P-${n}`, d(1), [["2", d(startDay)], ["4", d(doneDay)]]);
  }

  test("no P85 below five completions, and nothing is flagged in aging", () => {
    const m = computeFlowMetrics({
      issues: [done(1, 2, 4), done(2, 2, 6), issue("P-9", "2026-10-01T00:00:00.000Z", [["2", "2026-10-03T00:00:00.000Z"]])],
      resolve,
      from,
      to,
      now,
    });
    expect(m.cycleTime.count).toBe(2);
    expect(m.cycleTime.p50).toBe(2);
    expect(m.cycleTime.p85).toBeNull();
    expect(m.wip.aging[0]).toMatchObject({ key: "P-9", ageDays: 12, overP85: null });
    expect(renderAgingText(m)).toContain("P85 n/a d");
    expect(renderFlowText(m, "project = P")).toContain("fewer than 5 completed issues");
  });

  test("stats, throughput across an ISO week boundary, aging over P85, skipped wip", () => {
    const issues = [
      done(1, 2, 3), // cycle 1
      done(2, 2, 4), // 2
      done(3, 2, 5), // 3 (Mon 2026-10-05 starts W41)
      done(4, 2, 6), // 4
      done(5, 2, 12), // 10
      issue("P-6", "2026-10-01T00:00:00.000Z", [["4", "2026-10-06T00:00:00.000Z"]]), // skipped wip
      issue("P-7", "2026-09-01T00:00:00.000Z", [["2", "2026-09-02T00:00:00.000Z"]]), // aging, 43 days
      issue("P-8", "2026-10-01T00:00:00.000Z", [["2", "2026-10-13T00:00:00.000Z"]]), // aging, 2 days
      issue("P-10", "2026-08-01T00:00:00.000Z", [["2", "2026-08-02T00:00:00.000Z"], ["4", "2026-08-03T00:00:00.000Z"]]), // done before the window
    ];
    const m = computeFlowMetrics({ issues, resolve, from, to, now });
    expect(m.cycleTime).toEqual({ count: 5, min: 1, p50: 3, p85: 10, p95: 10, max: 10, mean: 4 });
    expect(m.leadTime.count).toBe(6);
    expect(m.diagnostics.skippedWip).toBe(1);
    expect(m.completed.map((c) => c.key)).toEqual(["P-1", "P-2", "P-3", "P-6", "P-4", "P-5"]);
    expect(m.throughput.weekly).toEqual([
      { week: "2026-W40", count: 2 },
      { week: "2026-W41", count: 3 },
      { week: "2026-W42", count: 1 },
    ]);
    expect(m.throughput.daily).toHaveLength(14);
    expect(m.wip.aging.map((a) => [a.key, a.overP85])).toEqual([["P-7", true], ["P-8", false]]);
    expect(renderAgingText(m)).toMatch(/^!\s+P-7/m);
  });

  test("an unmapped status keeps the issue out of cycle time", () => {
    const i = issue("P-1", "2026-10-01T00:00:00.000Z", [["2", "2026-10-02T00:00:00.000Z"], ["77", "2026-10-03T00:00:00.000Z"], ["4", "2026-10-04T00:00:00.000Z"]]);
    const m = computeFlowMetrics({ issues: [i], resolve, from, to, now });
    expect(m.completed[0].cycleDays).toBeNull();
    expect(m.diagnostics).toMatchObject({ excludedFromCycleTime: 1, unknownStatuses: ["77"] });
  });
});

describe("computeCumulativeFlow", () => {
  test("counts each issue's status at the end of every UTC day", () => {
    const issues = [
      // Moves to In Progress one millisecond before midnight UTC: counts as wip that day.
      issue("P-1", "2026-10-01T10:00:00.000Z", [["2", "2026-10-01T23:59:59.998Z"], ["4", "2026-10-03T00:00:00.000Z"]]),
      // Created after the first day's snapshot.
      issue("P-2", "2026-10-02T01:00:00.000Z", []),
    ];
    const cfd = computeCumulativeFlow({
      issues,
      resolve,
      from: new Date("2026-10-01T00:00:00.000Z"),
      to: new Date("2026-10-03T12:00:00.000Z"),
      groupBy: "status",
    });
    expect(cfd.columns.map((c) => c.name)).toEqual(["To Do", "In Progress", "Done"]);
    expect(cfd.days).toEqual([
      { date: "2026-10-01", counts: { "To Do": 0, "In Progress": 1, Done: 0 } },
      { date: "2026-10-02", counts: { "To Do": 1, "In Progress": 1, Done: 0 } },
      { date: "2026-10-03", counts: { "To Do": 1, "In Progress": 0, Done: 1 } },
    ]);
    const byCategory = computeCumulativeFlow({
      issues,
      resolve,
      from: new Date("2026-10-03T00:00:00.000Z"),
      to: new Date("2026-10-03T00:00:00.000Z"),
      groupBy: "category",
    });
    expect(byCategory.days[0].counts).toEqual({ todo: 1, done: 1 });
  });
});

describe("helpers", () => {
  test("renderSparkline: all zeros, a single value, a ramp", () => {
    expect(renderSparkline([0, 0, 0])).toBe("▁▁▁");
    expect(renderSparkline([5])).toBe("█");
    expect(renderSparkline([0, 7, 14])).toBe("▁▅█");
    expect(renderSparkline([])).toBe("");
  });

  test("isoWeek handles the year boundary", () => {
    expect(isoWeek("2026-01-01T00:00:00Z")).toBe("2026-W01");
    expect(isoWeek("2027-01-01T00:00:00Z")).toBe("2026-W53");
  });

  test("attachChangelogs keeps the issue fields and sorts are the fetcher's job", () => {
    const i = issue("P-1", "2026-10-01T00:00:00.000Z", [], { resolutiondate: "x" });
    const log: JiraChangelogEntry[] = [{ id: "1", author: {} as JiraChangelogEntry["author"], created: "2026-10-02T00:00:00.000Z", items: [] }];
    const [attached] = attachChangelogs([i], new Map([["P-1", log]]));
    expect(attached.fields.resolutiondate).toBe("x");
    expect(attached.changelog?.histories).toBe(log);
    expect(attachChangelogs([i], new Map())[0].changelog?.histories).toEqual([]);
  });
});

describe("calculateBurndown on ascending changelogs", () => {
  test("completion is the last transition, which needs oldest-first histories", () => {
    const sprint = {
      id: 1,
      name: "S1",
      state: "closed",
      startDate: "2026-10-01T00:00:00.000Z",
      endDate: "2026-10-04T00:00:00.000Z",
    } as Parameters<typeof calculateBurndown>[0];
    const i = issue(
      "P-1",
      "2026-10-01T00:00:00.000Z",
      [["2", "2026-10-02T09:00:00.000Z"], ["4", "2026-10-03T09:00:00.000Z"]],
      { customfield_10016: 3 } as Partial<JiraIssue["fields"]>
    );
    const burndown = calculateBurndown(sprint, [i], "customfield_10016");
    expect(burndown.map((d) => [d.date, d.remaining])).toEqual([
      ["2026-10-01", 3],
      ["2026-10-02", 3],
      ["2026-10-03", 0],
      ["2026-10-04", 0],
    ]);
  });
});

describe("sprint metrics under a status map", () => {
  // Regression: live sites keep "Fertig" in the In Progress category; sprint
  // report, burndown and review counted every such issue as not done.
  const sprint = {
    id: 1,
    name: "S1",
    state: "closed",
    startDate: "2026-10-01T00:00:00.000Z",
    endDate: "2026-10-03T00:00:00.000Z",
  } as Parameters<typeof calculateBurndown>[0];
  const points = { customfield_10016: 5 } as Partial<JiraIssue["fields"]>;
  const reviewed = issue("P-1", "2026-10-01T00:00:00.000Z", [["3", "2026-10-02T09:00:00.000Z"]], points);
  const mapped = createStatusCategoryResolver(STATUSES, { "Code Review": "done" });

  test("without a map, done is the Done category", () => {
    const m = calculateSprintMetrics(sprint, [reviewed], "customfield_10016");
    expect([m.completedIssues, m.completedPoints]).toEqual([0, 0]);
    expect(calculateBurndown(sprint, [reviewed], "customfield_10016").at(-1)?.remaining).toBe(5);
  });

  test("a status mapped to done counts as done in metrics and burndown", () => {
    const m = calculateSprintMetrics(sprint, [reviewed], "customfield_10016", undefined, mapped);
    expect([m.completedIssues, m.completedPoints, m.sayDoRatio]).toEqual([1, 5, 100]);
    expect(
      calculateBurndown(sprint, [reviewed], "customfield_10016", mapped).map((d) => [d.date, d.remaining])
    ).toEqual([
      ["2026-10-01", 5],
      ["2026-10-02", 0],
      ["2026-10-03", 0],
    ]);
  });
});

describe("sprint metrics as of the sprint", () => {
  // Regression: metrics used the issues' current state. Old sprints showed
  // ~100 % predictability, work done after the sprint counted, and scope
  // change was always 0 (sprint ids were read from the names in fromString).
  const PF = "customfield_10036";
  const sprint = {
    id: 910,
    name: "S910",
    state: "closed",
    startDate: "2026-10-01T08:00:00.000Z",
    endDate: "2026-10-14T16:00:00.000Z",
    completeDate: "2026-10-14T16:00:00.000Z",
  } as Parameters<typeof calculateSprintMetrics>[0];
  const fertig = createStatusCategoryResolver(
    [...STATUSES, { id: "9", name: "Fertig", statusCategory: { id: 4, key: "indeterminate", name: "In Progress" } }],
    { Fertig: "done" }
  );
  /** Change items as live Cloud bulk changelogs send them (ids in from/to; empty values omitted). */
  const sprintItem = (from: string, to: string) =>
    ({ field: "Sprint", fieldtype: "custom", fieldId: "customfield_10020", from, fromString: "", to, toString: "S" }) as JiraChangelogEntry["items"][number];
  const pointsItem = (from: number | undefined, to: number) =>
    ({ field: "Story Points", fieldtype: "custom", fieldId: PF, ...(from === undefined ? {} : { fromString: String(from) }), toString: String(to) }) as unknown as JiraChangelogEntry["items"][number];
  function withHistory(base: JiraIssue, entries: Array<[string, JiraChangelogEntry["items"][number]]>): JiraIssue {
    const extra = entries.map(([created, item], i) => ({ id: `${base.key}-x${i}`, author: { accountId: "u1" }, created, items: [item] }) as JiraChangelogEntry);
    return { ...base, changelog: { histories: [...(base.changelog?.histories ?? []), ...extra] } } as JiraIssue;
  }
  const p = (n: number) => ({ [PF]: n }) as Partial<JiraIssue["fields"]>;

  // Committed 5, done in the sprint.
  const doneInSprint = issue("T-1", "2026-09-20T00:00:00.000Z", [["4", "2026-10-05T10:00:00.000Z"]], p(5));
  // Committed 3, finished only after the sprint.
  const doneLater = issue("T-2", "2026-09-20T00:00:00.000Z", [["4", "2026-10-20T10:00:00.000Z"]], p(3));
  // Estimate raised from 2 to 8 during the sprint; "Fertig" (In Progress category) in the sprint.
  const reestimated = withHistory(
    issue("T-3", "2026-09-20T00:00:00.000Z", [["9", "2026-10-10T10:00:00.000Z"]], p(8)),
    [["2026-10-03T09:00:00.000Z", pointsItem(2, 8)]]
  );
  // Added on day 2, done in the sprint.
  const added = withHistory(issue("T-4", "2026-09-20T00:00:00.000Z", [["4", "2026-10-08T10:00:00.000Z"]], p(1)), [
    ["2026-10-02T09:00:00.000Z", sprintItem("", "910")],
  ]);
  // Committed 4, moved to the next sprint during this one (still listed, as Jira keeps closed sprints).
  const removed = withHistory(issue("T-5", "2026-09-20T00:00:00.000Z", [], p(4)), [
    ["2026-10-06T09:00:00.000Z", sprintItem("910", "944")],
  ]);
  // Created inside the sprint, already in it: added, not committed.
  const createdLater = issue("T-6", "2026-10-03T00:00:00.000Z", [], p(2));
  // Finished before the sprint started: Jira lists it apart, it counts for nothing.
  const doneBefore = issue("T-9", "2026-09-20T00:00:00.000Z", [["4", "2026-09-28T10:00:00.000Z"]], p(8));
  const issues = [doneInSprint, doneLater, reestimated, added, removed, createdLater, doneBefore];

  test("committed at the start, completed at the end, scope change from sprint ids", () => {
    const m = calculateSprintMetrics(sprint, issues, PF, issues, fertig);
    // Committed: 5 + 3 + 2 (T-3 before re-estimate) + 4 = 14.
    expect(m.committedPoints).toBe(14);
    // Completed at the end: T-1 (5), T-3 Fertig (8), T-4 (1); not T-2, done later.
    expect([m.completedIssues, m.completedPoints]).toEqual([3, 14]);
    // In the sprint at the end: T-1, T-2, T-3, T-4, T-6.
    expect([m.totalIssues, m.incompleteIssues]).toEqual([5, 2]);
    expect([m.addedDuringSprint, m.removedDuringSprint]).toEqual([3, 4]);
    // Counts, not points (regression: the report's issues.added/removed held points).
    // Added: the moved-in issue and the one created during the sprint; removed: the moved-out one.
    expect([m.addedIssues, m.removedIssues]).toEqual([2, 1]);
    expect(m.sayDoRatio).toBe(100);
    expect(m.scopeChangePercent).toBe(50);
  });

  test("added and removed again during the sprint counts as both (as in Jira's sprint report; live: TCW 811)", () => {
    // Joined on day 2 at 6 points, moved out on day 4: not in the sprint at either end.
    const inAndOut = withHistory(issue("T-10", "2026-09-20T00:00:00.000Z", [], p(6)), [
      ["2026-10-02T09:00:00.000Z", sprintItem("", "910")],
      ["2026-10-04T09:00:00.000Z", sprintItem("910", "")],
    ]);
    const base = calculateSprintMetrics(sprint, issues, PF, issues, fertig);
    const m = calculateSprintMetrics(sprint, [...issues, inAndOut], PF, [...issues, inAndOut], fertig);
    expect([m.addedIssues - base.addedIssues, m.removedIssues - base.removedIssues]).toEqual([1, 1]);
    expect([m.addedDuringSprint - base.addedDuringSprint, m.removedDuringSprint - base.removedDuringSprint]).toEqual([6, 6]);
    // Never in the sprint at its end: not part of the totals or the commitment.
    expect([m.totalIssues, m.committedPoints]).toEqual([base.totalIssues, base.committedPoints]);
  });

  test("loadSprintHistory adds the issues Jira's sprint report lists as removed", async () => {
    const listed = issue("T-1", "2026-09-20T00:00:00.000Z", [], p(1));
    const punted = issue("T-20", "2026-09-20T00:00:00.000Z", [], p(2));
    const searched: string[] = [];
    const client = {
      getAllSprintIssues: async () => [listed],
      getSprintRemovedIssueKeys: async (board: number, id: number) => (board === 7 && id === 910 ? ["T-20", "T-1"] : []),
      search: async (jql: string) => (searched.push(jql), { issues: [punted] }),
      getChangelogs: async () => new Map(),
    } as unknown as JiraClient;
    const loaded = await loadSprintHistory(client, { id: 910, originBoardId: 7 }, ["summary"]);
    expect(loaded.map((i) => i.key)).toEqual(["T-1", "T-20"]);
    // Only the keys not already listed are fetched.
    expect(searched).toEqual(["key in (T-20)"]);
    // A failing report or no board: the sprint's list alone.
    const failing = { ...client, getSprintRemovedIssueKeys: async () => { throw new Error("403"); } } as unknown as JiraClient;
    expect((await loadSprintHistory(failing, { id: 910, originBoardId: 7 }, [])).map((i) => i.key)).toEqual(["T-1"]);
    expect((await loadSprintHistory(client, { id: 910 }, [])).map((i) => i.key)).toEqual(["T-1"]);
  });

  test("without the map, Fertig is not done; without changelogs, the current state counts", () => {
    expect(calculateSprintMetrics(sprint, issues, PF, issues, resolve).completedPoints).toBe(6);
    expect(calculateSprintMetrics(sprint, issues, PF).completedPoints).toBe(5 + 3 + 1 + 8);
  });

  test("an active sprint is measured now", () => {
    const active = { ...sprint, state: "active" as const, completeDate: undefined };
    const m = calculateSprintMetrics(active, issues, PF, issues, fertig);
    expect(m.completedPoints).toBe(5 + 3 + 8 + 1);
  });

  test("issueAt replays membership, estimate and status", () => {
    const before = new Date("2026-10-02T00:00:00.000Z");
    expect(issueAt(reestimated, 910, before, PF, fertig)).toEqual({ inSprint: true, points: 2, done: false });
    expect(issueAt(added, 910, before, PF, fertig)).toEqual({ inSprint: false, points: 1, done: false });
    expect(issueAt(createdLater, 910, before, PF, fertig).inSprint).toBe(false);
    // Sub-tasks follow their parent and never count (as in Jira's sprint report).
    const subtask = issue("T-8", "2026-09-20T00:00:00.000Z", [], { ...p(1), issuetype: { id: "5", name: "Sub-Task", subtask: true } });
    expect(issueAt(subtask, 910, new Date(), PF, fertig).inSprint).toBe(false);
    // An estimate set from empty: no points before it.
    const fresh = withHistory(issue("T-7", "2026-09-20T00:00:00.000Z", [], p(3)), [["2026-10-03T00:00:00.000Z", pointsItem(undefined, 3)]]);
    expect(issueAt(fresh, 910, before, PF).points).toBe(0);
  });

  test("burndown burns the committed scope; work done after the sprint stays", () => {
    const bd = calculateBurndown(sprint, issues, PF, fertig);
    expect(bd[0].remaining + bd[0].completed).toBe(14);
    // T-1 (5) and T-3 (committed at 2) burn down; T-2 is done after the sprint, T-4 was added.
    expect(bd.at(-1)?.remaining).toBe(14 - 5 - 2);
  });
});

describe("latestSprints", () => {
  test("keeps the most recent sprints, oldest first", () => {
    // Regression: velocity and predictability took Jira's first page, the oldest sprints.
    const s = (id: number, endDate: string, completeDate?: string) => ({ id, endDate, completeDate });
    const sprints = [s(3, "2025-06-18"), s(1, "2024-11-20"), s(2, "2024-12-04", "2025-06-01"), s(4, "2025-07-02")];
    expect(latestSprints(sprints, 2).map((x) => x.id)).toEqual([3, 4]);
    expect(latestSprints(sprints, 3).map((x) => x.id)).toEqual([2, 3, 4]);
    expect(latestSprints(sprints, 10)).toHaveLength(4);
  });
});

describe("createStatusCategoryResolver with changelog names", () => {
  test("a known id follows the site name's override even when the changelog names it differently", () => {
    // Live: the changelog says "Done" for the id of the site status "Fertig" (In Progress category).
    const statuses: JiraStatus[] = [{ id: "10001", name: "Fertig", statusCategory: { id: 4, key: "indeterminate", name: "In Progress" } }];
    const resolve = createStatusCategoryResolver(statuses, { Fertig: "done" });
    expect(resolve({ id: "10001", name: "Done" })).toBe("done");
    expect(resolve({ id: "10001" })).toBe("done");
    expect(resolve({ name: "fertig" })).toBe("done");
  });
});

describe("statusScopeJql", () => {
  test("without a map that moves statuses across done: the plain category", () => {
    const scope = statusScopeJql(STATUSES, createStatusCategoryResolver(STATUSES, { "Code Review": "wip" }));
    expect(scope).toEqual({ open: "statusCategory != Done", done: "statusCategory = Done" });
  });

  test("statuses mapped into and out of done are listed by id", () => {
    const resolve = createStatusCategoryResolver(STATUSES, { "In Progress": "done", Closed: "wip" });
    expect(statusScopeJql(STATUSES, resolve)).toEqual({
      open: "((statusCategory != Done AND status not in (2)) OR status in (5))",
      done: "((statusCategory = Done AND status not in (5)) OR status in (2))",
    });
  });
});
