import { describe, expect, test } from "bun:test";
import { handleKey } from "./app.js";
import { updateNav } from "./commands.js";
import { rankPlan } from "./jira-agile.js";
import { loadIssues } from "./jira.js";
import { setChildren, topOverlay, type Overlay } from "./state.js";
import { commands, issue, setup, type TestSetup } from "./testing.js";

const press = (t: TestSetup, ...keys: string[]) => {
  for (const key of keys) {
    const named = ["return", "escape", "tab", "space", "up", "down"].includes(key);
    handleKey({ ctx: t.ctx, commands: commands(), keymap: {} }, named ? { name: key } : { name: key.toLowerCase(), sequence: key, shift: key !== key.toLowerCase() });
  }
};

/** Types into the open prompt and submits it. */
function answer(t: TestSetup, value: string) {
  t.ctx.store.set((s) => ({ ...s, overlays: [...s.overlays.slice(0, -1), { ...(topOverlay(s) as Extract<Overlay, { kind: "prompt" }>), value }] }));
  press(t, "return");
}

const keys = (list: { key: string }[]) => list.map((i) => i.key);
const items = ["A-1", "A-2", "A-3", "A-4"].map((k) => issue(k));

describe("rankPlan", () => {
  test("up and down pass the neighbour; top and bottom go to the ends", () => {
    expect(rankPlan(items, ["A-3"], "up")).toMatchObject({ before: "A-2" });
    expect(keys(rankPlan(items, ["A-3"], "up")!.order)).toEqual(["A-1", "A-3", "A-2", "A-4"]);
    expect(rankPlan(items, ["A-2"], "down")).toMatchObject({ after: "A-3" });
    expect(keys(rankPlan(items, ["A-4"], "top")!.order)).toEqual(["A-4", "A-1", "A-2", "A-3"]);
    expect(rankPlan(items, ["A-1"], "bottom")).toMatchObject({ after: "A-4" });
  });

  test("marked issues move as one block in list order, even with gaps", () => {
    const plan = rankPlan(items, ["A-2", "A-4"], "up")!;
    expect(plan.before).toBe("A-1");
    expect(keys(plan.order)).toEqual(["A-2", "A-4", "A-1", "A-3"]);
    expect(keys(rankPlan(items, ["A-1", "A-3"], "bottom")!.order)).toEqual(["A-2", "A-4", "A-1", "A-3"]);
  });

  test("nothing to do at the edge", () => {
    expect(rankPlan(items, ["A-1"], "up")).toBeUndefined();
    expect(rankPlan(items, ["A-1", "A-2"], "top")).toBeUndefined();
    expect(rankPlan(items, ["A-4"], "down")).toBeUndefined();
  });
});

describe("rank in the list", () => {
  test("R → Down → y: ranks after the next issue and reorders without a reload", async () => {
    const t = setup({ search: () => ({ issues: items }), getIssue: (k: string) => issue(k), rankIssues: () => [] });
    await loadIssues(t.ctx, "Sprint", "sprint = 1 ORDER BY rank ASC");
    await t.settle();
    press(t, "R", "down", "return", "y");
    await t.settle();
    expect(t.calls.find((c) => c.method === "rankIssues")?.args).toEqual([{ issues: ["A-1"], before: undefined, after: "A-2" }]);
    expect(keys(t.ctx.store.get().jira.list.items)).toEqual(["A-2", "A-1", "A-3", "A-4"]);
    expect(t.ctx.store.get().jira.list.selected).toBe(1);
    expect(t.calls.filter((c) => c.method === "search").length).toBe(1);
  });

  test("a list not sorted by rank asks to sort first and writes nothing", async () => {
    const t = setup({ search: () => ({ issues: items }), getIssue: (k: string) => issue(k) });
    await loadIssues(t.ctx, "Mine", "assignee = currentUser() ORDER BY updated DESC");
    await t.settle();
    press(t, "R");
    expect(t.ctx.store.get().overlays).toEqual([]);
    expect(t.toasts().at(-1)?.text).toContain("Sort the list by rank");
  });

  test("an issue Jira refused keeps the old order and names it", async () => {
    const t = setup({ search: () => ({ issues: items }), getIssue: (k: string) => issue(k), rankIssues: () => [{ issueKey: "A-2", errors: ["No permission"] }] });
    await loadIssues(t.ctx, "Sprint", "sprint = 1 ORDER BY rank ASC");
    await t.settle();
    press(t, "j", "R", "return", "y");
    await t.settle();
    expect(keys(t.ctx.store.get().jira.list.items)).toEqual(["A-1", "A-2", "A-3", "A-4"]);
    expect(t.toasts().at(-1)).toMatchObject({ kind: "error" });
    expect(t.toasts().at(-1)?.text).toContain("A-2 (No permission)");
  });
});

/** A navigator with Boards → one scrum board (7) → an active and a future sprint, focused on `selected`. */
function boardTree(t: TestSetup, selected: string) {
  updateNav(t.ctx, (tree) => setChildren(tree, undefined, [{ id: "g:boards", label: "Boards", kind: "group", expandable: true }]));
  updateNav(t.ctx, (tree) => setChildren(tree, "g:boards", [{ id: "b:7", label: "Team (scrum)", kind: "board", expandable: true, data: { boardId: 7, type: "scrum" } }]));
  updateNav(t.ctx, (tree) =>
    setChildren(tree, "b:7", [
      { id: "s:1", label: "● S1", kind: "sprint", expandable: false, data: { jql: "sprint = 1", sprintId: 1, name: "S1", state: "active" } },
      { id: "s:2", label: "○ S2", kind: "sprint", expandable: false, data: { jql: "sprint = 2", sprintId: 2, name: "S2", state: "future" } },
    ])
  );
  updateNav(t.ctx, (tree) => ({ ...tree, expanded: ["g:boards", "b:7"], selected }));
  t.ctx.store.set((s) => ({ ...s, focus: "nav" }));
}

const agileStub = (extra: Record<string, (...args: never[]) => unknown> = {}) => ({
  listBoards: () => ({ values: [{ id: 7, name: "Team", type: "scrum" }, { id: 9, name: "New", type: "kanban" }], isLast: true }),
  listSprints: () => ({ values: [] }),
  getBoardFilterJql: () => "project = AB ORDER BY Rank ASC",
  ...extra,
});

describe("boards and sprints in the navigator", () => {
  test("n on a scrum board creates a sprint there and reloads the board", async () => {
    const t = setup(agileStub({ createSprint: () => ({ id: 3 }) }));
    boardTree(t, "b:7");
    press(t, "n");
    expect(topOverlay(t.ctx.store.get())).toMatchObject({ kind: "prompt", title: "New sprint on Team (scrum): name" });
    answer(t, "Sprint 3");
    press(t, "y");
    await t.settle();
    expect(t.calls.find((c) => c.method === "createSprint")?.args).toEqual([{ name: "Sprint 3", originBoardId: 7 }]);
    expect(t.calls.some((c) => c.method === "listSprints")).toBe(true);
  });

  test("n on Boards creates a scrum board in the project and selects it", async () => {
    const t = setup(agileStub({ createBoard: () => ({ id: 9, name: "New", type: "kanban", filterId: 5, filterCreated: true }) }), { project: "AB" });
    boardTree(t, "g:boards");
    press(t, "n");
    answer(t, "New");
    press(t, "down", "return", "y");
    await t.settle();
    expect(t.calls.find((c) => c.method === "createBoard")?.args).toEqual([{ name: "New", type: "kanban", projectKeyOrId: "AB" }]);
    expect(t.ctx.store.get().jira.nav.selected).toBe("b:9");
  });

  test("S starts a future sprint with today and the end date", async () => {
    const t = setup(agileStub({ startSprint: () => ({}) }));
    boardTree(t, "s:2");
    press(t, "S");
    answer(t, "2030-01-31");
    press(t, "y");
    await t.settle();
    const [id, dates] = t.calls.find((c) => c.method === "startSprint")!.args as [number, { startDate: string; endDate: string }];
    expect(id).toBe(2);
    expect(dates.endDate).toBe("2030-01-31");
    expect(dates.startDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  test("S on the active sprint completes it", async () => {
    const t = setup(agileStub({ closeSprint: () => ({}) }));
    boardTree(t, "s:1");
    press(t, "S", "y");
    await t.settle();
    expect(t.calls.find((c) => c.method === "closeSprint")?.args[0]).toBe(1);
  });

  test("d on a board with its filter needs two y, then deletes board and filter", async () => {
    const t = setup(agileStub({ getBoardFilterId: () => "500", deleteBoard: () => undefined, deleteFilter: () => undefined }));
    boardTree(t, "b:7");
    press(t, "d", "down", "return", "y");
    expect(t.calls.some((c) => c.method === "deleteBoard")).toBe(false);
    press(t, "y");
    await t.settle();
    expect(t.calls.filter((c) => c.method.startsWith("delete")).map((c) => [c.method, c.args[0]])).toEqual([["deleteBoard", 7], ["deleteFilter", "500"]]);
    expect(t.ctx.store.get().jira.nav.selected).toBe("g:boards");
  });

  test("d on a sprint deletes it after two y", async () => {
    const t = setup(agileStub({ deleteSprint: () => undefined }));
    boardTree(t, "s:2");
    press(t, "d", "y", "y");
    await t.settle();
    expect(t.calls.find((c) => c.method === "deleteSprint")?.args).toEqual([2]);
    expect(t.ctx.store.get().jira.nav.selected).toBe("b:7");
  });

  test("outside the navigator n still makes an issue", async () => {
    const t = setup(agileStub({ listProjects: () => ({ values: [] }) }));
    boardTree(t, "b:7");
    t.ctx.store.set((s) => ({ ...s, focus: "list" }));
    press(t, "n");
    await t.settle();
    expect(topOverlay(t.ctx.store.get())).toMatchObject({ kind: "picker", title: "New issue: project" });
  });
});
