import { describe, expect, test } from "bun:test";
import { handleKey } from "./app.js";
import { loadIssues } from "./jira.js";
import { cardAt, kanbanColumns, kanbanStep } from "./kanban.js";
import { columnWindow, twoLines } from "./kanban-view.js";
import { topOverlay } from "./state.js";
import { commands, issue, setup, type TestSetup } from "./testing.js";

const status = (id: string, name: string, category: string) => ({ status: { id, name, statusCategory: { key: category } } }) as never;
const todo = status("1", "To Do", "new");
const doing = status("3", "In Progress", "indeterminate");
const done = status("5", "Done", "done");

// A-1 doing, A-2 todo, A-3 done, A-4 todo
const items = [issue("A-1", doing), issue("A-2", todo), issue("A-3", done), issue("A-4", todo)];
const board = [
  { name: "Backlog", statusIds: ["1"] },
  { name: "Doing", statusIds: ["3", "4"] },
  { name: "Review", statusIds: ["6"] },
  { name: "Done", statusIds: ["5"] },
];

const press = (t: TestSetup, ...keys: string[]) => {
  for (const key of keys) {
    const shifted = key.startsWith("shift+");
    const name = shifted ? key.slice(6) : key;
    const named = ["return", "escape", "tab", "space", "up", "down", "left", "right"].includes(name);
    handleKey({ ctx: t.ctx, commands: commands(), keymap: {} }, named ? { name, shift: shifted } : { name: key.toLowerCase(), sequence: key, shift: key !== key.toLowerCase() });
  }
};

describe("kanbanColumns", () => {
  test("the board's columns, cards in list order", () => {
    expect(kanbanColumns(items, board).map((c) => [c.name, c.items])).toEqual([
      ["Backlog", [1, 3]],
      ["Doing", [0]],
      ["Review", []],
      ["Done", [2]],
    ]);
  });

  test("statuses the board does not map get their own column", () => {
    const columns = kanbanColumns([...items, issue("A-5", status("9", "Blocked", "indeterminate"))], board);
    expect(columns.at(-1)).toEqual({ name: "Not on the board", statusIds: [], items: [4] });
  });

  test("without a board: one column per status, by category", () => {
    expect(kanbanColumns(items).map((c) => [c.name, c.statusIds, c.items])).toEqual([
      ["To Do", ["1"], [1, 3]],
      ["In Progress", ["3"], [0]],
      ["Done", ["5"], [2]],
    ]);
  });
});

describe("moving the cursor", () => {
  const columns = kanbanColumns(items, board);

  test("sideways skips empty columns and keeps the row where it can", () => {
    expect(cardAt(columns, 3)).toEqual({ column: 0, row: 1 });
    expect(kanbanStep(columns, 3, "right")).toBe(0);
    expect(kanbanStep(columns, 0, "right")).toBe(2);
    expect(kanbanStep(columns, 2, "left")).toBe(0);
    expect(kanbanStep(columns, 2, "right")).toBeUndefined();
  });

  test("up and down stay in the column", () => {
    expect(kanbanStep(columns, 1, "down")).toBe(3);
    expect(kanbanStep(columns, 3, "down")).toBe(3);
    expect(kanbanStep(columns, 3, "up")).toBe(1);
  });
});

describe("layout helpers", () => {
  test("the column window keeps the selected column on screen", () => {
    expect(columnWindow(4, 6, 3)).toBe(0);
    expect(columnWindow(8, 3, 0)).toBe(0);
    expect(columnWindow(8, 3, 4)).toBe(3);
    expect(columnWindow(8, 3, 7)).toBe(5);
  });

  test("a summary wraps into two lines and the second is cut", () => {
    expect(twoLines("Render Mermaid sequence diagrams as vectors", 20)).toEqual(["Render Mermaid", "sequence diagrams a…"]);
    expect(twoLines("Short", 20)).toEqual(["Short"]);
  });
});

describe("the board view", () => {
  const client = (moves: string[] = []) => ({
    search: () => ({ issues: items }),
    getIssue: (k: string) => items.find((i) => i.key === k)!,
    getBoardColumns: () => board,
    getTransitions: () => [
      { id: "11", name: "Back to backlog", to: { id: "1", name: "To Do" } },
      { id: "21", name: "Start", to: { id: "3", name: "In Progress" } },
    ],
    transitionIssue: (key: string, body: { transition: { id: string } }) => void moves.push(`${key}:${body.transition.id}`),
  });

  test("b shows the board with the board's columns; h/l/j/k move between cards", async () => {
    const t = setup(client());
    await loadIssues(t.ctx, "Sprint 42", "sprint = 1 ORDER BY rank ASC", 889);
    await t.settle();
    press(t, "b");
    await t.settle();
    expect(t.ctx.store.get().jira.view).toBe("board");
    expect(t.ctx.store.get().jira.columns[889]).toEqual(board);
    expect(t.ctx.store.get().jira.list.selected).toBe(0);
    press(t, "h", "j");
    expect(t.ctx.store.get().jira.list.selected).toBe(3);
    press(t, "l");
    expect(t.ctx.store.get().jira.list.selected).toBe(0);
    press(t, "return");
    expect(t.ctx.store.get()).toMatchObject({ zoom: true, focus: "detail" });
    press(t, "escape");
    expect(t.ctx.store.get()).toMatchObject({ zoom: false, focus: "list" });
  });

  test("shift+left moves the card at once, through the one fitting transition, and logs it", async () => {
    const moves: string[] = [];
    const t = setup(client(moves));
    await loadIssues(t.ctx, "Sprint 42", "sprint = 1 ORDER BY rank ASC", 889);
    await t.settle();
    press(t, "b");
    await t.settle();
    press(t, "shift+left");
    await t.settle();
    expect(moves).toEqual(["A-1:11"]);
    expect(topOverlay(t.ctx.store.get())).toBeUndefined();
    expect(t.ctx.store.get().log.at(-1)).toMatchObject({ ok: true, text: "A-1 → To Do", commands: ["atlcli jira issue transition --key A-1 --to 'Back to backlog' --profile test"] });
  });

  test("no transition into the column: a note, no write", async () => {
    const moves: string[] = [];
    const t = setup(client(moves));
    await loadIssues(t.ctx, "Sprint 42", "sprint = 1 ORDER BY rank ASC", 889);
    await t.settle();
    press(t, "b");
    await t.settle();
    press(t, "shift+right");
    await t.settle();
    expect(moves).toEqual([]);
    expect(t.toasts().at(-1)?.text).toBe('A-1 has no transition into "Review".');
  });

  test("a list without a board groups by status and loads no columns", async () => {
    const t = setup(client());
    await loadIssues(t.ctx, "Mine", "assignee = currentUser()");
    await t.settle();
    press(t, "b");
    await t.settle();
    expect(t.calls.some((c) => c.method === "getBoardColumns")).toBe(false);
    // Sorting keeps the board; a search from / does not.
    await loadIssues(t.ctx, "Sprint", "sprint = 1 ORDER BY rank ASC", 889);
    await loadIssues(t.ctx, "Sprint", "sprint = 1 ORDER BY rank ASC");
    expect(t.ctx.store.get().jira.boardId).toBe(889);
  });
});
