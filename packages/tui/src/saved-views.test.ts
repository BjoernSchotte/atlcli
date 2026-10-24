import { describe, expect, test } from "bun:test";
import type { TuiView } from "../index.js";
import { handleKey } from "./app.js";
import { jira, loadIssues } from "./jira.js";
import { savableQuery, viewNodes, withView } from "./saved-views.js";
import { initialState, topOverlay, type Overlay } from "./state.js";
import { commands, issue, setup, type TestSetup } from "./testing.js";
import { updateNav } from "./commands.js";

const press = (t: TestSetup, ...keys: string[]) => {
  for (const key of keys) {
    const named = ["return", "escape", "tab", "space", "up", "down"].includes(key);
    handleKey({ ctx: t.ctx, commands: commands(), keymap: {} }, named ? { name: key } : { name: key.toLowerCase(), sequence: key, shift: key !== key.toLowerCase() });
  }
};

function answer(t: TestSetup, value: string) {
  t.ctx.store.set((s) => ({ ...s, overlays: [...s.overlays.slice(0, -1), { ...(topOverlay(s) as Extract<Overlay, { kind: "prompt" }>), value }] }));
  press(t, "return");
}

const views: TuiView[] = [
  { area: "jira", name: "Bugs", query: "type = Bug" },
  { area: "wiki", name: "Howtos", query: 'label = "howto"' },
];

describe("saved views", () => {
  test("nodes per area, opened like any query", () => {
    expect(viewNodes(views, "jira")).toEqual([{ id: "v:Bugs", label: "Bugs", kind: "view", expandable: false, data: { name: "Bugs", jql: "type = Bug" } }]);
    expect(viewNodes(views, "wiki")[0]!.data).toEqual({ name: "Howtos", cql: 'label = "howto"' });
  });

  test("a view of the same area and name is replaced", () => {
    expect(withView(views, { area: "jira", name: "Bugs", query: "type = Bug AND priority = High" })).toEqual([
      views[1],
      { area: "jira", name: "Bugs", query: "type = Bug AND priority = High" },
    ]);
  });

  test("a page's children are no search and cannot be saved", () => {
    const s = initialState("wiki");
    expect(savableQuery({ ...s, wiki: { ...s.wiki, list: { ...s.wiki.list, query: "children:123" } } })).toBeUndefined();
    expect(savableQuery({ ...s, wiki: { ...s.wiki, list: { ...s.wiki.list, query: 'label = "x"' } } })).toBe('label = "x"');
  });

  test("F → saved view: stored through saveViews and shown in the navigator", async () => {
    const stored: TuiView[][] = [];
    const t = setup({ search: () => ({ issues: [issue("A-1")] }), getIssue: (k: string) => issue(k) }, { saveViews: async (v) => void stored.push(v) });
    await jira.init(t.ctx);
    await loadIssues(t.ctx, "Search", "project = A AND type = Bug");
    await t.settle();
    press(t, "F", "return");
    answer(t, "Bugs");
    await t.settle();
    expect(stored).toEqual([[{ area: "jira", name: "Bugs", query: "project = A AND type = Bug" }]]);
    const nav = t.ctx.store.get().jira.nav;
    expect(nav.nodes["g:views"]!.children).toEqual(["v:Bugs"]);
    expect(nav.selected).toBe("v:Bugs");
    expect(t.ctx.store.get().log).toEqual([]);
  });

  test("F → Jira filter: a favourite filter, asked first and logged", async () => {
    const t = setup({
      search: () => ({ issues: [issue("A-1")] }),
      getIssue: (k: string) => issue(k),
      createFilter: (input: { name: string }) => ({ id: "77", name: input.name }),
      getFavouriteFilters: () => [{ id: "77", name: "Bugs", jql: "type = Bug" }],
    });
    await jira.init(t.ctx);
    await loadIssues(t.ctx, "Search", "type = Bug");
    await t.settle();
    press(t, "F", "down", "return");
    answer(t, "Bugs");
    expect(topOverlay(t.ctx.store.get())?.kind).toBe("confirm");
    press(t, "y");
    await t.settle();
    expect(t.calls.find((c) => c.method === "createFilter")?.args).toEqual([{ name: "Bugs", jql: "type = Bug", favourite: true }]);
    expect(t.ctx.store.get().log.at(-1)?.commands).toEqual(["atlcli jira filter create --name=Bugs '--jql=type = Bug' --favourite --profile=test"]);
  });

  test("d deletes a saved view, or (y twice) a Jira filter", async () => {
    const stored: TuiView[][] = [];
    const t = setup({ search: () => ({ issues: [] }), deleteFilter: () => undefined, getFavouriteFilters: () => [] }, { saveViews: async (v) => void stored.push(v) });
    t.ctx.store.set((s) => ({ ...s, views }));
    await jira.init(t.ctx);
    t.ctx.store.set((s) => ({ ...s, focus: "nav" }));
    await jira.expand(t.ctx, t.ctx.store.get().jira.nav.nodes["g:views"]!);
    updateNav(t.ctx, (n) => ({ ...n, selected: "v:Bugs" }));
    press(t, "d", "y");
    await t.settle();
    expect(stored).toEqual([[views[1]]]);

    updateNav(t.ctx, (n) => ({ ...n, nodes: { ...n.nodes, "f:77": { id: "f:77", label: "Old", kind: "query", depth: 1, parent: "g:filters", expandable: false } }, selected: "f:77" }));
    press(t, "d", "y");
    expect(t.calls.some((c) => c.method === "deleteFilter")).toBe(false);
    press(t, "y");
    await t.settle();
    expect(t.calls.find((c) => c.method === "deleteFilter")?.args).toEqual(["77"]);
  });
});
