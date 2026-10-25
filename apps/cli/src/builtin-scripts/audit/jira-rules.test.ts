/**
 * The built-in Jira audit rules (scripts) through the audit engine. Ported
 * from the pre-script tests of packages/jira/src/audit.test.ts with the same
 * expectations: the rewrite must find exactly what the old engine found.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import {
  type AuditRegistry,
  type AuditRules,
  type AuditRuleScript,
  auditJira,
  createAuditBaseline,
  DEFAULT_MARKDOWN_TEMPLATE,
  defaultAuditRules as defaultRules,
  type JiraAuditInput,
  markdownModel,
  parseAuditBaseline,
  parseAuditRules as parseRules,
  pruneAuditBaseline,
  renderAuditText,
  resolveAuditChecks,
  restrictAuditRules,
} from "@atlcli/audit";
import { initJinja, renderJinja } from "@atlcli/jinja";
import { createStatusCategoryResolver, type JiraIssue, type JiraStatus } from "@atlcli/jira";
import type { ScriptPort } from "@atlcli/script-runtime";
import { loadBuiltinAuditRules, registryOf } from "../../commands/audit-scripts.js";

let scripts: AuditRuleScript[];
let registry: AuditRegistry;
let STRICT: AuditRules;
beforeAll(async () => {
  await initJinja();
  scripts = await loadBuiltinAuditRules("jira");
  registry = registryOf(scripts);
  /** The strict profile, everything listed, no legacy cutoff: what a rule finds is what the test sees. */
  STRICT = { ...defaultRules(registry, "strict"), legacyDays: null };
});
const defaultAuditRules = (profile?: "minimal" | "default" | "strict") => defaultRules(registry, profile);
const parseAuditRules = (raw: unknown, source: string) => parseRules(raw, source, registry);
/** Rules only read issues they are given; nothing reaches a port. */
const port = {} as ScriptPort;

const STATUSES: JiraStatus[] = [
  { id: "1", name: "To Do", statusCategory: { id: 2, key: "new", name: "To Do" } },
  { id: "2", name: "In Progress", statusCategory: { id: 4, key: "indeterminate", name: "In Progress" } },
  { id: "3", name: "Done", statusCategory: { id: 3, key: "done", name: "Done" } },
  { id: "4", name: "Review", statusCategory: { id: 4, key: "indeterminate", name: "In Progress" } },
];
const resolve = createStatusCategoryResolver(STATUSES);
const NOW = new Date("2026-10-22T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
const ago = (d: number) => new Date(NOW.getTime() - d * DAY).toISOString();

type Change = { daysAgo: number; field: string; fieldId?: string; from?: string | null; to: string | null; toString?: string | null };

function issue(key: string, opts: {
  status: "1" | "2" | "3" | "4";
  startedDaysAgo?: number;
  doneDaysAgo?: number;
  updatedDaysAgo?: number;
  assignee?: string | null;
  type?: { name: string; subtask?: boolean; hierarchyLevel?: number };
  parent?: boolean;
  points?: number;
  fixVersions?: number;
  project?: string;
  duedate?: string;
  flagged?: boolean;
  changes?: Change[];
}): JiraIssue {
  const histories = [];
  if (opts.startedDaysAgo !== undefined) {
    histories.push({ id: `${key}-s`, author: {}, created: ago(opts.startedDaysAgo), items: [{ field: "status", fieldtype: "jira", from: "1", fromString: "To Do", to: "2", toString: "In Progress" }] });
  }
  if (opts.doneDaysAgo !== undefined) {
    histories.push({ id: `${key}-d`, author: {}, created: ago(opts.doneDaysAgo), items: [{ field: "status", fieldtype: "jira", from: "2", fromString: "In Progress", to: "3", toString: "Done" }] });
  }
  for (const [i, c] of (opts.changes ?? []).entries()) {
    histories.push({ id: `${key}-c${i}`, author: {}, created: ago(c.daysAgo), items: [{ field: c.field, fieldId: c.fieldId, fieldtype: "custom", from: c.from ?? null, fromString: null, to: c.to, toString: c.toString ?? c.to }] });
  }
  return {
    id: key,
    key,
    self: "",
    fields: {
      summary: `Summary ${key}`,
      status: STATUSES.find((s) => s.id === opts.status)!,
      issuetype: opts.type ?? { id: "1", name: "Story", subtask: false, hierarchyLevel: 0 },
      project: { id: "1", key: opts.project ?? "P" },
      created: ago(200),
      updated: ago(opts.updatedDaysAgo ?? 0),
      assignee: opts.assignee === null ? null : { accountId: "a", displayName: opts.assignee ?? "Ann" },
      ...(opts.parent === false ? {} : { parent: { id: "9", key: "P-EPIC" } }),
      fixVersions: Array.from({ length: opts.fixVersions ?? 1 }, (_, i) => ({ id: String(i), name: `v${i}` })),
      ...(opts.points !== undefined ? { customfield_10016: opts.points } : {}),
      ...(opts.duedate ? { duedate: opts.duedate } : {}),
      ...(opts.flagged ? { customfield_10021: [{ value: "Impediment" }] } : {}),
    } as unknown as JiraIssue["fields"],
    changelog: { histories } as unknown as JiraIssue["changelog"],
  };
}

/** Done issues with the given cycle times in days, all finished 30 days ago. */
function doneSet(cycles: number[]): JiraIssue[] {
  return cycles.map((c, i) => issue(`D-${i + 1}`, { status: "3", startedDaysAgo: 30 + c, doneDaysAgo: 30 }));
}

function only(checks: string, rules: AuditRules = STRICT): Pick<JiraAuditInput, "rules"> {
  return { rules: restrictAuditRules(rules, resolveAuditChecks(checks, registry, rules.custom.map((c) => c.id)) as Set<string>) };
}

function audit(input: Partial<JiraAuditInput>) {
  return auditJira(
    { rules: STRICT, registry, scripts, open: [], done: [], resolve, now: NOW, projectsUsingVersions: new Set(), useBaseline: true, query: "q", ...input },
    { port, now: NOW },
  );
}

async function run(open: JiraIssue[], done: JiraIssue[], overrides: Partial<JiraAuditInput> = {}) {
  return (await audit({ open, done, ...overrides })).report;
}

const rows = (r: { findings: Array<{ rule: string; key: string; severity: string }> }) => r.findings.map((f) => [f.rule, f.key, f.severity]);

describe("jira audit rules: rules", () => {
  test("stuck-wip: warning above P85, error above P95, nothing at the boundary", async () => {
    // Cycle times 1..20 days: P85 = 17, P95 = 19.
    const done = doneSet(Array.from({ length: 20 }, (_, i) => i + 1));
    const report = await run(
      [issue("P-1", { status: "2", startedDaysAgo: 17 }), issue("P-2", { status: "2", startedDaysAgo: 18 }), issue("P-3", { status: "2", startedDaysAgo: 25 })],
      done,
      only("stuck-wip")
    );
    expect(rows(report)).toEqual([["flow/stuck-wip", "P-3", "error"], ["flow/stuck-wip", "P-2", "warning"]]);
    expect(report.findings[1].detail).toContain("the cycle-time P85 (17.0 d)");
  });

  test("epics are left out of stuck-wip and its reference set (live: year-long epics flagged against story cycle times)", async () => {
    const epic = { name: "Epic", hierarchyLevel: 1 };
    const done = [...doneSet(Array.from({ length: 20 }, (_, i) => i + 1)), issue("E-1", { status: "3", startedDaysAgo: 900, doneDaysAgo: 30, type: epic })];
    const report = await run([issue("E-2", { status: "2", startedDaysAgo: 800, type: epic }), issue("P-1", { status: "2", startedDaysAgo: 25 })], done, only("stuck-wip,flow/status-aging"));
    expect(rows(report)).toEqual([["flow/stuck-wip", "P-1", "error"], ["flow/status-aging", "P-1", "error"]]);
    // The 870-day epic did not stretch the P95.
    expect(report.findings[0].detail).toContain("P95 (19.0 d)");
  });

  test("stuck-wip percentiles are skipped with a diagnostic below five completions; day thresholds still apply", async () => {
    const open = [issue("P-1", { status: "2", startedDaysAgo: 100 })];
    const report = await run(open, doneSet([1, 2, 3, 4]), only("stuck-wip"));
    expect(report.findings).toEqual([]);
    expect(report.diagnostics[0]).toContain("flow/stuck-wip percentiles skipped: 4 completed issue(s)");
    const days = parseAuditRules({ extends: "strict", rules: { "flow/stuck-wip": { warning: "60d", error: "off" } } }, "t");
    expect(rows(await run(open, doneSet([1, 2, 3, 4]), only("stuck-wip", { ...days, legacyDays: null })))).toEqual([["flow/stuck-wip", "P-1", "warning"]]);
  });

  test("status-aging compares the time in the current status with that status's history", async () => {
    // Done issues spent 1..10 days in "In Progress" (P85 = 9, P95 = 10).
    const done = Array.from({ length: 10 }, (_, i) => issue(`D-${i + 1}`, { status: "3", startedDaysAgo: 40 + i + 1, doneDaysAgo: 40 }));
    const open = [issue("P-1", { status: "2", startedDaysAgo: 9.5 }), issue("P-2", { status: "2", startedDaysAgo: 30 }), issue("P-3", { status: "4", startedDaysAgo: 30 })];
    const report = await run(open, done, only("flow/status-aging"));
    expect(rows(report)).toEqual([["flow/status-aging", "P-2", "error"], ["flow/status-aging", "P-1", "warning"]]);
    expect(report.findings[0].detail).toBe('In "In Progress" for 30 d, above the P95 for "In Progress" (10.0 d).');
    // "Review" has no history in the done set.
    expect(report.diagnostics.join(" ")).toContain('status-aging percentiles skipped for "Review"');
  });

  test("unassigned-wip only for in-progress issues", async () => {
    const report = await run([issue("P-1", { status: "2", startedDaysAgo: 1, assignee: null }), issue("P-2", { status: "1", assignee: null })], [], only("unassigned-wip"));
    expect(rows(report)).toEqual([["flow/unassigned-wip", "P-1", "error"]]);
  });

  test("stale levels at the exact thresholds; to do only when included", async () => {
    const open = [
      issue("P-1", { status: "2", startedDaysAgo: 100, updatedDaysAgo: 29 }),
      issue("P-2", { status: "2", startedDaysAgo: 100, updatedDaysAgo: 30 }),
      issue("P-3", { status: "2", startedDaysAgo: 100, updatedDaysAgo: 60 }),
      issue("P-4", { status: "2", startedDaysAgo: 100, updatedDaysAgo: 90 }),
      issue("P-5", { status: "1", updatedDaysAgo: 120 }),
    ];
    const wipOnly = parseAuditRules({ extends: "strict", rules: { "hygiene/stale": { include: ["wip"] } } }, "t");
    expect(rows(await run(open, [], only("stale", { ...wipOnly, legacyDays: null })))).toEqual([
      ["hygiene/stale", "P-4", "error"],
      ["hygiene/stale", "P-3", "warning"],
      ["hygiene/stale", "P-2", "info"],
    ]);
    expect((await run(open, [], only("stale"))).findings[0]).toMatchObject({ key: "P-5", ageDays: 120 });
  });

  test("overdue counts days after the due date; due-soon counts down to it", async () => {
    const rules = parseAuditRules({ rules: { "hygiene/overdue": { warning: "0d", error: "14d" }, "hygiene/due-soon": { info: "3d", warning: "1d" } }, minLevel: "info" }, "t");
    const open = [
      issue("P-1", { status: "2", duedate: "2026-10-21" }), // ended at 2026-10-22T00:00Z: 0.5 d overdue
      issue("P-2", { status: "2", duedate: "2026-10-01" }), // 20.5 d overdue
      issue("P-3", { status: "2", duedate: "2026-10-22" }), // due today: 0.5 d left
      issue("P-4", { status: "2", duedate: "2026-10-24" }), // 2.5 d left
      issue("P-5", { status: "2", duedate: "2026-11-30" }),
    ];
    const report = await run(open, [], only("hygiene/overdue,hygiene/due-soon", { ...rules, legacyDays: null }));
    expect(rows(report)).toEqual([
      ["hygiene/overdue", "P-2", "error"],
      ["hygiene/overdue", "P-1", "warning"],
      ["hygiene/due-soon", "P-3", "warning"],
      ["hygiene/due-soon", "P-4", "info"],
    ]);
    expect(report.findings[0].detail).toBe("Due 2026-10-01, 20 d overdue.");
    expect(report.findings[3].detail).toBe("Due 2026-10-24, in 3 d.");
  });

  test("flagged: duration from the changelog by field id, else a lower bound from the last update", async () => {
    const open = [
      issue("P-1", { status: "2", flagged: true, changes: [{ daysAgo: 20, field: "Markiert", fieldId: "customfield_10021", to: "10019", toString: "Impediment" }] }),
      issue("P-2", { status: "2", flagged: true, updatedDaysAgo: 2 }),
      issue("P-3", { status: "2" }),
    ];
    const report = await run(open, [], { ...only("hygiene/flagged"), flaggedField: "customfield_10021" });
    expect(rows(report)).toEqual([["hygiene/flagged", "P-1", "error"], ["hygiene/flagged", "P-2", "warning"]]);
    expect(report.findings.map((f) => f.detail)).toEqual(["Flagged for 20 d.", "Flagged for at least 2 d (since the last update)."]);
    expect((await run(open, [], only("hygiene/flagged"))).diagnostics.join(" ")).toContain("hygiene/flagged skipped: no Flagged field found");
  });

  test("hygiene: no-parent exempts epics and subtasks; unestimated only with a points field; done-without-version only where versions exist", async () => {
    const open = [
      issue("P-1", { status: "1", parent: false }),
      issue("P-2", { status: "1", parent: false, type: { name: "Epic", hierarchyLevel: 1 } }),
      issue("P-3", { status: "1", parent: false, type: { name: "Sub-task", subtask: true, hierarchyLevel: -1 } }),
      issue("P-4", { status: "2", startedDaysAgo: 1 }),
      issue("P-5", { status: "2", startedDaysAgo: 1, points: 3 }),
    ];
    const done = [issue("D-1", { status: "3", doneDaysAgo: 2, fixVersions: 0 }), issue("X-1", { status: "3", doneDaysAgo: 2, fixVersions: 0, project: "X" })];
    const hygiene = "no-parent,unestimated-in-sprint,done-without-version".split(",").map((r) => `hygiene/${r}`).join(",");

    const without = await run(open, done, { ...only(hygiene), inOpenSprint: new Set(["P-4", "P-5"]) });
    expect(rows(without)).toEqual([["hygiene/no-parent", "P-1", "warning"]]);
    expect(without.diagnostics).toEqual(["hygiene/unestimated-in-sprint skipped: no story points field detected."]);

    const withAll = await run(open, done, { ...only(hygiene), pointsField: "customfield_10016", inOpenSprint: new Set(["P-4", "P-5"]), projectsUsingVersions: new Set(["P"]) });
    expect(rows(withAll)).toEqual([
      ["hygiene/no-parent", "P-1", "warning"],
      ["hygiene/unestimated-in-sprint", "P-4", "error"],
      ["hygiene/done-without-version", "D-1", "warning"],
    ]);
    expect(withAll.summary).toEqual({
      total: 3,
      bySeverity: { error: 1, warning: 2, info: 0 },
      byRule: { "hygiene/no-parent": 1, "hygiene/unestimated-in-sprint": 1, "hygiene/done-without-version": 1 },
      suppressed: { quiet: 0, baseline: 0, legacy: 0 },
    });
  });
});

describe("jira audit rules: workflow rule", () => {
  /**
   * A resolved issue in `status`. `onEntry`: the move into the status set the
   * resolution (one history entry); otherwise it was set on an earlier move to
   * Done and kept. `undefined`: no history.
   */
  function resolvedIn(key: string, status: "2" | "4", onEntry?: boolean): JiraIssue {
    const base = issue(key, { status });
    const move = (to: string) => ({ field: "status", fieldId: "status", fieldtype: "jira", from: "1", fromString: null, to, toString: null });
    const resolution = { field: "resolution", fieldId: "resolution", fieldtype: "jira", from: null, fromString: null, to: "10000", toString: "Done" };
    const histories =
      onEntry === undefined
        ? []
        : onEntry
          ? [{ id: "h1", author: {}, created: ago(5), items: [move(status), resolution] }]
          : [{ id: "h1", author: {}, created: ago(9), items: [move("3"), resolution] }, { id: "h2", author: {}, created: ago(5), items: [move(status)] }];
    return { ...base, changelog: { histories } as unknown as JiraIssue["changelog"] };
  }
  const issues = [resolvedIn("P-1", "2", true), resolvedIn("P-2", "2", true), resolvedIn("P-3", "4", false), resolvedIn("P-4", "4", true), resolvedIn("P-5", "4", false)];

  test("the history tells a done status from resolutions kept on the way in", async () => {
    const report = await run([], [], { ...only("workflow"), resolvedNotDone: { issues, truncated: true } });
    expect(report.findings.map((f) => [f.key, f.status, f.subject])).toEqual([
      ["P-1", "In Progress", "status:2"],
      ["P-3", "Review", "status:4"],
    ]);
    expect(report.findings[0].summary).toBe('Status "In Progress" (In Progress category)');
    expect(report.findings[0].detail).toBe(
      '2+ resolved issue(s); for 2 the transition into this status set the resolution (P-1, P-2). If the status means done, move it to Done in the workflow, or map it: --status-map "In Progress=done"; if not, stop that transition from setting a resolution.'
    );
    expect(report.findings[1].detail).toBe(
      "3+ resolved issue(s); for 2 the resolution was set elsewhere and kept when they moved here (P-3, P-4, P-5). Fix: clear the resolution on these issues."
    );
    const unknown = await run([], [], { ...only("workflow"), resolvedNotDone: { issues: [resolvedIn("P-9", "2")], truncated: false } });
    expect(unknown.findings[0].detail).toContain("the history does not show where the resolution was set. Either the status means done");
  });

  test("a status mapped to done, or an override turning the rule off for a status, is not reported", async () => {
    const mapped = createStatusCategoryResolver(STATUSES, { "In Progress": "done" });
    expect((await run([], [], { ...only("workflow"), resolve: mapped, resolvedNotDone: { issues, truncated: false } })).findings.map((f) => f.key)).toEqual(["P-3"]);
    const rules = parseAuditRules({ extends: "strict", overrides: [{ match: { project: "P", status: "Review" }, rules: { "workflow/resolved-not-done": "off" } }] }, "t");
    expect((await run([], [], { ...only("workflow", rules), resolvedNotDone: { issues, truncated: false } })).findings.map((f) => f.key)).toEqual(["P-1"]);
    expect((await run([], [], only("workflow"))).findings).toEqual([]);
  });
});

describe("jira audit rules: overrides and custom rules", () => {
  test("overrides apply in order by project, type, status and JQL hits", async () => {
    const rules = parseAuditRules(
      {
        extends: "minimal",
        minLevel: "info",
        rules: { "flow/unassigned-wip": "info" },
        overrides: [
          { match: { project: "GROW" }, rules: { "flow/unassigned-wip": "warning" } },
          { match: { jql: "priority = Highest" }, rules: { "flow/unassigned-wip": "error" } },
          { match: { issueType: "Bug", status: "Review" }, rules: { "flow/unassigned-wip": "off" } },
        ],
      },
      "t"
    );
    const open = [
      issue("P-1", { status: "2", assignee: null }),
      issue("GROW-1", { status: "2", assignee: null, project: "GROW" }),
      issue("GROW-2", { status: "2", assignee: null, project: "GROW" }),
      issue("P-2", { status: "4", assignee: null, type: { name: "Bug" } }),
    ];
    const report = await run(open, [], { ...only("unassigned-wip", { ...rules, legacyDays: null }), jqlMatches: [undefined, new Set(["GROW-2"]), undefined] });
    expect(rows(report)).toEqual([
      ["flow/unassigned-wip", "GROW-2", "error"],
      ["flow/unassigned-wip", "GROW-1", "warning"],
      ["flow/unassigned-wip", "P-1", "info"],
    ]);
  });

  test("custom rules: each hit is a finding with the rule's message and severity", async () => {
    const rules = parseAuditRules({ minLevel: "info", custom: [{ id: "team/bug-without-component", jql: "issuetype = Bug AND component IS EMPTY", severity: "error", message: "Bug without a component." }] }, "t");
    const report = await run([], [], { ...only("custom", { ...rules, legacyDays: null }), custom: new Map([["team/bug-without-component", [issue("P-9", { status: "1" })]]]) });
    expect(report.findings).toEqual([
      expect.objectContaining({ rule: "team/bug-without-component", category: "custom", severity: "error", key: "P-9", detail: "Bug without a component." }),
    ]);
  });
});

describe("jira audit rules: suppression", () => {
  const open = [
    issue("P-1", { status: "2", startedDaysAgo: 300, updatedDaysAgo: 200, assignee: null }), // legacy (default 180 d)
    issue("P-2", { status: "2", startedDaysAgo: 5, assignee: null }),
    issue("P-3", { status: "2", startedDaysAgo: 5, parent: false }), // no-parent: info, quiet in default
  ];

  test("default profile: legacy cutoff, quiet info findings, baseline; workflow is never legacy", async () => {
    const rules = defaultAuditRules();
    const baseline = { schemaVersion: 1 as const, entries: [{ rule: "flow/unassigned-wip", subject: "P-2", acceptedAt: ago(1) }, { rule: "hygiene/stale", subject: "P-77", acceptedAt: ago(1) }] };
    const old = issue("W-1", { status: "4", updatedDaysAgo: 400 });
    const result = await audit({ rules, open, resolvedNotDone: { issues: [old], truncated: false }, baseline });
    const { report } = result;
    expect(rows(report)).toEqual([["workflow/resolved-not-done", "W-1", "warning"]]);
    expect(report.summary.suppressed).toEqual({ quiet: 1, baseline: 1, legacy: 2 });
    expect(report.legacy).toEqual({ "flow/unassigned-wip": 1, "hygiene/stale": 1 });
    expect(report.quiet).toEqual({ "hygiene/no-parent": 1 });
    expect(report.staleBaselineEntries).toBe(1);
    const text = renderAuditText(report);
    expect(text).toContain("Quiet: 1 finding(s) below warning (hygiene/no-parent 1); --min-level info lists them.");
    expect(text).toContain("Legacy: 2 finding(s) on issues not updated for 180 d");
    expect(text).toContain("Baseline: 1 entr(y/ies) no longer match; --prune-baseline removes them.");

    // --no-baseline lists everything at or above the min level.
    const all = (await audit({ rules, open, baseline, useBaseline: false })).report;
    expect(all.findings.map((f) => `${f.rule}:${f.key}`)).toEqual(["flow/unassigned-wip:P-1", "flow/unassigned-wip:P-2", "hygiene/stale:P-1"]);
    expect(all.legacyDays).toBeNull();

    // Updating keeps the accepted date of entries already there; pruning drops the stale one.
    const next = createAuditBaseline(result.candidates, NOW, baseline);
    expect(next.entries.find((e) => e.subject === "P-2")?.acceptedAt).toBe(ago(1));
    expect(next.entries.find((e) => e.subject === "status:4")).toMatchObject({ rule: "workflow/resolved-not-done", acceptedAt: NOW.toISOString() });
    expect(pruneAuditBaseline(baseline, result.candidates).entries.map((e) => e.subject)).toEqual(["P-2"]);
    expect(parseAuditBaseline(JSON.parse(JSON.stringify(next)))).toEqual(next);
    expect(() => parseAuditBaseline({ entries: [] })).toThrow();
  });
});

describe("renderers", () => {
  test("group by rule and escape table cells", async () => {
    const report = await run([issue("P-1", { status: "2", startedDaysAgo: 1, assignee: null })], [], { ...only("unassigned-wip"), query: "project = P", baseUrl: "https://x.atlassian.net" });
    report.findings[0]!.summary = "a | b";
    expect(renderAuditText(report)).toContain(
      "In progress without assignee — flow/unassigned-wip (1)\n  [error] P-1  a | b — In progress without an assignee."
    );
    const md = renderJinja(DEFAULT_MARKDOWN_TEMPLATE, markdownModel(report), { lines: true }).text;
    expect(md).toContain("| error | [P-1](https://x.atlassian.net/browse/P-1) | a \\| b |  | In progress without an assignee. |");
    expect(renderAuditText(await run([], [], only("stale")))).toContain("No findings.");
  });
});
