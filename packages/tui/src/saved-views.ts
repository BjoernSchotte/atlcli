/**
 * Saved views: the current list under a name. Local views (`tui.views`, this
 * computer) work in both areas; in Jira the list can also become a favourite
 * filter, which Jira's web UI and other devices see too.
 */
import type { TuiArea, TuiView } from "../index.js";
import { expandNode, updateNav } from "./commands.js";
import { confirmWrite } from "./jira-actions.js";
import { jira } from "./jira.js";
import type { Command, Ctx } from "./keymap.js";
import { logged } from "./log.js";
import { pushOverlay, setChildren, type AppState, type TreeNode } from "./state.js";

/** The navigator group of saved views; the same id in both areas. */
export const VIEWS_GROUP = "g:views";

export const viewsGroup = (): Omit<TreeNode, "depth" | "parent"> => ({ id: VIEWS_GROUP, label: "Saved views", kind: "group", expandable: true });

/** Navigator nodes for an area's views: query nodes the area opens like any other. */
export function viewNodes(views: TuiView[], area: TuiArea): Omit<TreeNode, "depth" | "parent">[] {
  return views
    .filter((v) => v.area === area)
    .map((v) => ({ id: `v:${v.name}`, label: v.name, kind: "view", expandable: false, data: { name: v.name, [area === "jira" ? "jql" : "cql"]: v.query } }));
}

/** The list's query when it can be saved: JQL in Jira, CQL in the wiki (not a page's children). */
export function savableQuery(state: AppState): string | undefined {
  const query = state[state.area].list.query.trim();
  if (!query) return undefined;
  if (state.area === "wiki" && /^(children|space):/.test(query)) return undefined;
  return query;
}

/** The views with `view` added, replacing one of the same area and name. */
export function withView(views: TuiView[], view: TuiView): TuiView[] {
  return [...views.filter((v) => !(v.area === view.area && v.name === view.name)), view];
}

const onNav = (state: AppState): TreeNode | undefined => {
  const nav = state[state.area].nav;
  return nav.selected ? nav.nodes[nav.selected] : undefined;
};

async function storeViews(ctx: Ctx, views: TuiView[]): Promise<boolean> {
  const saved = await ctx.task("Saving the view…", async () => {
    await ctx.opts.saveViews?.(views);
    return true;
  });
  if (!saved) return false;
  ctx.store.set((s) => ({ ...s, views }));
  const area = ctx.store.get().area;
  updateNav(ctx, (t) => setChildren(t, VIEWS_GROUP, viewNodes(views, area)));
  updateNav(ctx, (t) => ({ ...t, expanded: t.expanded.includes(VIEWS_GROUP) ? t.expanded : [...t.expanded, VIEWS_GROUP] }));
  return true;
}

function saveLocal(ctx: Ctx, name: string, query: string): void {
  const s = ctx.store.get();
  const view: TuiView = { area: s.area, name, query };
  const replaces = s.views.some((v) => v.area === view.area && v.name === name);
  void storeViews(ctx, withView(s.views, view)).then((ok) => {
    if (!ok) return;
    updateNav(ctx, (t) => ({ ...t, selected: `v:${name}` }));
    ctx.toast("success", `${replaces ? "Updated" : "Saved"} the view "${name}"${ctx.opts.saveViews ? "" : " (for this session)"}`);
  });
}

function saveFilter(ctx: Ctx, name: string, jql: string): void {
  confirmWrite(ctx, `Save as the Jira filter "${name}"?`, [jql, "A favourite filter: Jira's web UI and your other devices see it too."], [], [["jira", "filter", "create", "--name", name, "--jql", jql, "--favourite"]], async () => {
    const filter = await ctx.opts.jira.createFilter({ name, jql, favourite: true });
    const group = ctx.store.get().jira.nav.nodes["g:filters"];
    if (group) {
      await jira.expand(ctx, group);
      await expandNode(ctx, jira, ctx.store.get().jira.nav.nodes["g:filters"]!);
      updateNav(ctx, (t) => (t.nodes[`f:${filter.id}`] ? { ...t, selected: `f:${filter.id}` } : t));
    }
    return `Filter "${filter.name}" saved`;
  });
}

function save(ctx: Ctx): void {
  const state = ctx.store.get();
  const query = savableQuery(state);
  if (!query) return ctx.toast("info", "Only a search can be saved: open one from the navigator or search with /.");
  const ask = (then: (name: string) => void) =>
    ctx.store.set((s) =>
      pushOverlay(s, {
        kind: "prompt",
        title: "Save the list as",
        // Without the navigator's sprint marker ("● Sprint 42").
        value: state[state.area].list.title.replace(/^[●○]\s*/, ""),
        placeholder: "Name",
        onSubmit: (name) => (name.trim() ? then(name.trim()) : ctx.toast("error", "The name cannot be empty.")),
      })
    );
  if (state.area === "wiki") return ask((name) => saveLocal(ctx, name, query));
  ctx.store.set((s) =>
    pushOverlay(s, {
      kind: "picker",
      title: "Save the list as",
      items: [
        { id: "local", label: "A saved view", hint: "this computer" },
        { id: "filter", label: "A Jira favourite filter", hint: "everywhere" },
      ],
      query: "",
      selected: 0,
      multi: false,
      marked: [],
      allowFree: false,
      onSubmit: ([where]) => ask((name) => (where === "filter" ? saveFilter(ctx, name, query) : saveLocal(ctx, name, query))),
    })
  );
}

function remove(ctx: Ctx): void {
  const node = onNav(ctx.store.get())!;
  if (node.kind === "view") {
    const name = String(node.data!.name);
    const area = ctx.store.get().area;
    ctx.store.set((s) =>
      pushOverlay(s, {
        kind: "confirm",
        title: `Delete the view "${name}"?`,
        lines: ["Only the saved view goes; nothing in Jira or Confluence changes."],
        double: false,
        step: 0,
        onConfirm: async () => {
          if (await storeViews(ctx, ctx.store.get().views.filter((v) => !(v.area === area && v.name === name)))) ctx.toast("success", `View "${name}" deleted`);
        },
      })
    );
    return;
  }
  const id = node.id.slice("f:".length);
  ctx.store.set((s) =>
    pushOverlay(s, {
      kind: "confirm",
      title: `Delete the Jira filter "${node.label}"?`,
      lines: ["Boards and dashboards that use it stop working.", "Jira only lets you delete your own filters.", "This cannot be undone."],
      double: true,
      step: 0,
      onConfirm: async () => {
        const done = await ctx.task("Deleting…", () =>
          logged(ctx, [["jira", "filter", "delete", "--id", id, "--confirm"]], async () => {
            await ctx.opts.jira.deleteFilter(id);
            return `Filter "${node.label}" deleted`;
          })
        );
        if (!done) return;
        const group = ctx.store.get().jira.nav.nodes["g:filters"]!;
        updateNav(ctx, (t) => ({ ...t, selected: group.id }));
        await jira.expand(ctx, group);
        ctx.toast("success", done);
      },
    })
  );
}

export const viewCommands: Command[] = [
  { id: "app.view.save", title: "Save the list as a view (or, in Jira, a favourite filter)", keys: ["F"], focus: ["list", "detail"], run: save },
  {
    id: "app.view.delete",
    title: "Delete the selected saved view or Jira filter",
    keys: ["d"],
    focus: ["nav"],
    enabled: (s) => onNav(s)?.kind === "view" || (s.area === "jira" && onNav(s)?.id.startsWith("f:") === true),
    run: remove,
  },
];
