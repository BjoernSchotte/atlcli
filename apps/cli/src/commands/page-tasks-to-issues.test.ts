import { describe, expect, test } from "bun:test";
import { extractPageTasks, markdownToStorage, taskFingerprint } from "@atlcli/confluence";
import { planTaskIssues, planTaskStatusSync, type IssueState, type TaskLedger } from "./page-tasks-to-issues.js";

const empty: TaskLedger = { v: 1, issues: {} };
const tasks = (markdown: string) => extractPageTasks(markdownToStorage(markdown));

describe("planTaskIssues", () => {
  test("matrix: create, linked, done, empty", () => {
    const plan = planTaskIssues(
      tasks("- [ ] write notes\n- [ ] see https://x.atlassian.net/browse/AB-1\n- [x] finished\n- [ ] @[Jane](557058:a)\n"),
      empty,
      { includeDone: false }
    );
    expect(plan.map((e) => [e.index, e.action, e.key])).toEqual([
      [0, "create", undefined],
      [1, "skip:linked", "AB-1"],
      [2, "skip:done", undefined],
      [3, "skip:empty", undefined],
    ]);
  });

  test("--include-done creates done tasks too", () => {
    expect(planTaskIssues(tasks("- [x] finished\n"), empty, { includeDone: true })[0]!.action).toBe("create");
  });

  test("ledger hit (crash before the page update) is not created twice", () => {
    const list = tasks("- [ ] write notes\n- [ ] write notes\n");
    const ledger: TaskLedger = { v: 1, issues: { "AB-7": { fingerprint: taskFingerprint(list[0]!) } } };
    const plan = planTaskIssues(list, ledger, { includeDone: false });
    // One ledger entry covers exactly one of two identical tasks.
    expect(plan.map((e) => [e.action, e.key])).toEqual([
      ["skip:ledger", "AB-7"],
      ["create", undefined],
    ]);
  });

  test("ledger entry whose link is already on the page is not reused", () => {
    const list = tasks("- [ ] a https://x.atlassian.net/browse/AB-7\n- [ ] a\n");
    const ledger: TaskLedger = { v: 1, issues: { "AB-7": { fingerprint: taskFingerprint({ text: "a" }) } } };
    expect(planTaskIssues(list, ledger, { includeDone: false }).map((e) => e.action)).toEqual(["skip:linked", "create"]);
  });

  test("ledger fingerprint mismatch (task text edited) creates", () => {
    const ledger: TaskLedger = { v: 1, issues: { "AB-7": { fingerprint: taskFingerprint({ text: "old text" }) } } };
    expect(planTaskIssues(tasks("- [ ] new text\n"), ledger, { includeDone: false })[0]!.action).toBe("create");
  });
});

describe("planTaskStatusSync", () => {
  const link = (key: string) => `https://x.atlassian.net/browse/${key}`;
  const states = (entries: Record<string, IssueState>) => new Map(Object.entries(entries));

  test("ticks a task once all its issues are done", () => {
    const list = tasks(`- [ ] a ${link("AB-1")}\n- [ ] b ${link("AB-2")} ${link("AB-3")}\n`);
    const plan = planTaskStatusSync(list, states({ "AB-1": "done", "AB-2": "done", "AB-3": "open" }), empty);
    expect(plan).toEqual([{ index: 0, action: "complete", keys: ["AB-1"] }]);
  });

  test("unticks only what the sync ticked; reports hand-ticked tasks", () => {
    const list = tasks(`- [x] a ${link("AB-1")}\n- [x] b ${link("AB-2")}\n`);
    const ledger: TaskLedger = { v: 1, issues: { "AB-1": { tickedBySync: true } } };
    const plan = planTaskStatusSync(list, states({ "AB-1": "open", "AB-2": "open" }), ledger);
    expect(plan.map((e) => e.action)).toEqual(["reopen", "report:ticked-but-open"]);
  });

  test("missing issues are reported, unlinked tasks ignored", () => {
    const list = tasks(`- [ ] a ${link("AB-9")}\n- [ ] plain\n`);
    expect(planTaskStatusSync(list, states({}), empty)).toEqual([{ index: 0, action: "report:missing", keys: ["AB-9"] }]);
  });
});
