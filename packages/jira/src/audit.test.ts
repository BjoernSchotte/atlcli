import { describe, expect, test } from "bun:test";
import {
  DEFAULT_JIRA_STALE_DAYS,
  JIRA_AUDIT_CHECKS,
  type JiraAuditCheck,
  auditJiraIssues,
  renderJiraAuditMarkdown,
  renderJiraAuditText,
} from "./audit.js";
import { createStatusCategoryResolver } from "./flow.js";
import type { JiraIssue, JiraStatus } from "./types.js";

const STATUSES: JiraStatus[] = [
  { id: "1", name: "To Do", statusCategory: { id: 2, key: "new", name: "To Do" } },
  { id: "2", name: "In Progress", statusCategory: { id: 4, key: "indeterminate", name: "In Progress" } },
  { id: "3", name: "Done", statusCategory: { id: 3, key: "done", name: "Done" } },
];
const resolve = createStatusCategoryResolver(STATUSES);
const NOW = new Date("2026-10-22T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
const ago = (d: number) => new Date(NOW.getTime() - d * DAY).toISOString();

function issue(key: string, opts: {
  status: "1" | "2" | "3";
  startedDaysAgo?: number;
  doneDaysAgo?: number;
  updatedDaysAgo?: number;
  assignee?: string | null;
  type?: { name: string; subtask?: boolean; hierarchyLevel?: number };
  parent?: boolean;
  points?: number;
  fixVersions?: number;
  project?: string;
}): JiraIssue {
  const histories = [];
  if (opts.startedDaysAgo !== undefined) {
    histories.push({ id: `${key}-s`, author: {}, created: ago(opts.startedDaysAgo), items: [{ field: "status", fieldtype: "jira", from: "1", fromString: "To Do", to: "2", toString: "In Progress" }] });
  }
  if (opts.doneDaysAgo !== undefined) {
    histories.push({ id: `${key}-d`, author: {}, created: ago(opts.doneDaysAgo), items: [{ field: "status", fieldtype: "jira", from: "2", fromString: "In Progress", to: "3", toString: "Done" }] });
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
    } as unknown as JiraIssue["fields"],
    changelog: { histories } as unknown as JiraIssue["changelog"],
  };
}

/** Done issues with the given cycle times in days, all finished 30 days ago. */
function doneSet(cycles: number[]): JiraIssue[] {
  return cycles.map((c, i) => issue(`D-${i + 1}`, { status: "3", startedDaysAgo: 30 + c, doneDaysAgo: 30 }));
}

function run(open: JiraIssue[], done: JiraIssue[], overrides: Partial<Parameters<typeof auditJiraIssues>[0]> = {}) {
  return auditJiraIssues({
    open,
    done,
    resolve,
    now: NOW,
    staleThresholds: DEFAULT_JIRA_STALE_DAYS,
    checks: new Set<JiraAuditCheck>(JIRA_AUDIT_CHECKS),
    includeTodo: false,
    projectsUsingVersions: new Set(),
    ...overrides,
  });
}

const only = (check: JiraAuditCheck) => ({ checks: new Set<JiraAuditCheck>([check]) });

describe("auditJiraIssues", () => {
  test("stuck-wip: warning above P85, error above P95, nothing at the boundary", () => {
    // Cycle times 1..20 days: P85 = 17, P95 = 19.
    const done = doneSet(Array.from({ length: 20 }, (_, i) => i + 1));
    const report = run(
      [
        issue("P-1", { status: "2", startedDaysAgo: 17 }),
        issue("P-2", { status: "2", startedDaysAgo: 18 }),
        issue("P-3", { status: "2", startedDaysAgo: 25 }),
      ],
      done,
      only("stuck-wip")
    );
    expect(report.findings.map((f) => [f.key, f.severity])).toEqual([["P-3", "error"], ["P-2", "warning"]]);
    expect(report.findings[1].detail).toContain("P85 (17.0 d)");
  });

  test("workflow: one finding per status holding resolved issues outside Done, unless mapped to done", () => {
    const resolved = [issue("P-1", { status: "2" }), issue("P-2", { status: "2" }), issue("P-3", { status: "1" })];
    const report = run([], [], { ...only("workflow"), resolvedNotDone: resolved, resolvedNotDoneTruncated: true });
    expect(report.findings.map((f) => [f.rule, f.key, f.status, f.severity])).toEqual([
      ["resolved-not-done", "P-1", "In Progress", "warning"],
      ["resolved-not-done", "P-3", "To Do", "warning"],
    ]);
    expect(report.findings[0].summary).toBe('Status "In Progress" (In Progress category)');
    expect(report.findings[0].detail).toContain('2+ resolved issue(s) outside the Done category (e.g. P-1, P-2)');
    expect(report.findings[0].detail).toContain('--status-map "In Progress=done"');

    const mapped = createStatusCategoryResolver(STATUSES, { "In Progress": "done" });
    const after = run([], [], { ...only("workflow"), resolvedNotDone: resolved, resolve: mapped });
    expect(after.findings.map((f) => f.key)).toEqual(["P-3"]);
    expect(run([], [], only("workflow")).findings).toEqual([]);
  });

  test("stuck-wip is skipped with a diagnostic below five completions", () => {
    const report = run([issue("P-1", { status: "2", startedDaysAgo: 100 })], doneSet([1, 2, 3, 4]), only("stuck-wip"));
    expect(report.findings).toEqual([]);
    expect(report.diagnostics[0]).toContain("stuck-wip skipped: 4 completed issue(s)");
  });

  test("unassigned-wip only for in-progress issues", () => {
    const report = run(
      [issue("P-1", { status: "2", startedDaysAgo: 1, assignee: null }), issue("P-2", { status: "1", assignee: null })],
      [],
      only("unassigned-wip")
    );
    expect(report.findings.map((f) => [f.key, f.severity])).toEqual([["P-1", "warning"]]);
  });

  test("stale levels at the exact thresholds; todo only with includeTodo", () => {
    const open = [
      issue("P-1", { status: "2", startedDaysAgo: 100, updatedDaysAgo: 29 }),
      issue("P-2", { status: "2", startedDaysAgo: 100, updatedDaysAgo: 30 }),
      issue("P-3", { status: "2", startedDaysAgo: 100, updatedDaysAgo: 60 }),
      issue("P-4", { status: "2", startedDaysAgo: 100, updatedDaysAgo: 90 }),
      issue("P-5", { status: "1", updatedDaysAgo: 120 }),
    ];
    expect(run(open, [], only("stale")).findings.map((f) => [f.key, f.severity])).toEqual([
      ["P-4", "error"],
      ["P-3", "warning"],
      ["P-2", "info"],
    ]);
    expect(run(open, [], { ...only("stale"), includeTodo: true }).findings[0]).toMatchObject({ key: "P-5", ageDays: 120 });
  });

  test("hygiene: no-parent exempts epics and subtasks; unestimated only with a points field; done-without-version only where versions exist", () => {
    const open = [
      issue("P-1", { status: "1", parent: false }),
      issue("P-2", { status: "1", parent: false, type: { name: "Epic", hierarchyLevel: 1 } }),
      issue("P-3", { status: "1", parent: false, type: { name: "Sub-task", subtask: true, hierarchyLevel: -1 } }),
      issue("P-4", { status: "2", startedDaysAgo: 1 }),
      issue("P-5", { status: "2", startedDaysAgo: 1, points: 3 }),
    ];
    const done = [issue("D-1", { status: "3", doneDaysAgo: 2, fixVersions: 0 }), issue("X-1", { status: "3", doneDaysAgo: 2, fixVersions: 0, project: "X" })];

    const without = run(open, done, { ...only("hygiene"), inOpenSprint: new Set(["P-4", "P-5"]) });
    expect(without.findings.map((f) => [f.rule, f.key])).toEqual([["no-parent", "P-1"]]);
    expect(without.diagnostics).toEqual(["unestimated-in-sprint skipped: no story points field detected."]);

    const withAll = run(open, done, {
      ...only("hygiene"),
      pointsField: "customfield_10016",
      inOpenSprint: new Set(["P-4", "P-5"]),
      projectsUsingVersions: new Set(["P"]),
    });
    expect(withAll.findings.map((f) => [f.rule, f.severity, f.key])).toEqual([
      ["unestimated-in-sprint", "warning", "P-4"],
      ["done-without-version", "info", "D-1"],
      ["no-parent", "info", "P-1"],
    ]);
    expect(withAll.summary).toEqual({
      total: 3,
      bySeverity: { error: 0, warning: 1, info: 2 },
      byCheck: { workflow: 0, "stuck-wip": 0, "unassigned-wip": 0, stale: 0, hygiene: 3 },
    });
  });

  test("renderers group by check and escape table cells", () => {
    const report = run([issue("P-1", { status: "2", startedDaysAgo: 1, assignee: null })], [], only("unassigned-wip"));
    report.findings[0].summary = "a | b";
    expect(renderJiraAuditText(report, "project = P")).toContain("In progress without assignee (1)\n  [warning] P-1  a | b — In progress without an assignee.");
    const md = renderJiraAuditMarkdown(report, "project = P", "https://x.atlassian.net");
    expect(md).toContain("| warning | [P-1](https://x.atlassian.net/browse/P-1) | a \\| b |  | In progress without an assignee. |");
    expect(renderJiraAuditText(run([], [], only("stale")), "q")).toContain("No findings.");
  });
});
