/**
 * Commands every area shares: quitting, help, the palette, panes, moving in
 * the navigator and the list, scrolling the detail. Area modules add their
 * own (`jira.ts`, `wiki.ts`).
 */
import type { TuiArea } from "../index.js";
import type { Command, Ctx } from "./keymap.js";
import {
  cycleFocus,
  moveSelection,
  moveTreeSelection,
  pushOverlay,
  setExpanded,
  toggleMark,
  visibleNodes,
  type AppState,
  type ListState,
  type TreeNode,
  type TreeState,
} from "./state.js";

/** What an area (Jira, Wiki) plugs into the shell. */
export interface AreaModule {
  id: TuiArea;
  label: string;
  commands: Command[];
  /** Loads the navigator roots and the first list. */
  init(ctx: Ctx): Promise<void>;
  /** Loads a node's children (on expand). */
  expand(ctx: Ctx, node: TreeNode): Promise<void>;
  /** Shows what a node stands for in the list (a sprint's issues, a page's children). */
  open(ctx: Ctx, node: TreeNode): Promise<void>;
  /** The list selection changed: load the detail. */
  select(ctx: Ctx): void;
  /** Reloads the list and the open detail; `quiet` keeps the detail on screen while it reloads (auto-refresh). */
  refresh(ctx: Ctx, quiet?: boolean): Promise<void>;
  /** Id of a list item (issue key, page id). */
  itemId(state: AppState, index: number): string | undefined;
  /** Browser URL of the selected item. */
  url(ctx: Ctx): string | undefined;
}

type Slices = { nav: TreeState; list: ListState<unknown> };

const slices = (state: AppState): Slices => state[state.area] as unknown as Slices;

function setSlices(state: AppState, patch: Partial<Slices>): AppState {
  return { ...state, [state.area]: { ...state[state.area], ...patch } };
}

export function updateList(ctx: Ctx, change: (list: ListState<unknown>) => ListState<unknown>, area: AreaModule): void {
  const before = slices(ctx.store.get()).list;
  const after = change(before);
  if (after === before) return;
  ctx.store.set((s) => setSlices(s, { list: after }));
  if (after.selected !== before.selected || after.items !== before.items) area.select(ctx);
}

export function updateNav(ctx: Ctx, change: (tree: TreeState) => TreeState): void {
  ctx.store.set((s) => {
    const nav = change(slices(s).nav);
    return nav === slices(s).nav ? s : setSlices(s, { nav });
  });
}

/** Expands a node, loading its children the first time. */
export async function expandNode(ctx: Ctx, area: AreaModule, node: TreeNode): Promise<void> {
  updateNav(ctx, (t) => setExpanded(t, node.id, true));
  if (node.children === undefined && node.expandable) await area.expand(ctx, node);
}

export function selectedNode(state: AppState): TreeNode | undefined {
  const nav = slices(state).nav;
  return nav.selected ? nav.nodes[nav.selected] : undefined;
}

export function coreCommands(areas: Record<TuiArea, AreaModule>): Command[] {
  const current = (ctx: Ctx) => areas[ctx.store.get().area];
  const list = (by: number | "top" | "bottom" | "page" | "-page"): Command["run"] => (ctx) =>
    updateList(
      ctx,
      (l) => {
        const to = by === "top" ? 0 : by === "bottom" ? l.items.length - 1 : by === "page" ? l.selected + 10 : by === "-page" ? l.selected - 10 : l.selected + by;
        return moveSelection(l, to);
      },
      current(ctx)
    );
  const nav = (by: number | "top" | "bottom"): Command["run"] => (ctx) => updateNav(ctx, (t) => moveTreeSelection(t, by));
  const scroll = (by: number | "page" | "-page" | "top"): Command["run"] => (ctx) => ctx.store.set((s) => ({ ...s, detailScroll: { by, seq: (s.detailScroll?.seq ?? 0) + 1 } }));

  return [
    { id: "app.quit", title: "Quit", keys: ["q", "ctrl+c"], bar: "quit", run: (ctx) => ctx.quit() },
    { id: "app.help", title: "Help: keys of this pane", keys: ["?"], bar: "help", run: (ctx) => ctx.store.set((s) => pushOverlay(s, { kind: "help" })) },
    {
      id: "app.palette",
      title: "Command palette",
      keys: [":", "ctrl+k"],
      run: (ctx) => ctx.store.set((s) => pushOverlay(s, { kind: "palette", query: "", selected: 0 })),
    },
    { id: "app.area.jira", title: "Go to Jira", keys: ["1"], run: (ctx) => switchArea(ctx, areas, "jira") },
    { id: "app.area.wiki", title: "Go to Wiki", keys: ["2"], run: (ctx) => switchArea(ctx, areas, "wiki") },
    { id: "app.focus.next", title: "Next pane", keys: ["tab"], run: (ctx) => ctx.store.set((s) => cycleFocus(s, 1)) },
    { id: "app.focus.prev", title: "Previous pane", keys: ["shift+tab"], run: (ctx) => ctx.store.set((s) => cycleFocus(s, -1)) },
    {
      id: "app.nav.toggle",
      title: "Show or hide the navigator",
      keys: ["["],
      run: (ctx) => ctx.store.set((s) => ({ ...s, navOpen: !s.navOpen, focus: s.focus === "nav" && s.navOpen ? "list" : s.focus })),
    },
    {
      id: "app.zoom",
      title: "Detail pane fullscreen on/off",
      keys: ["z"],
      run: (ctx) => ctx.store.set((s) => ({ ...s, zoom: !s.zoom, focus: s.zoom ? s.focus : "detail" })),
    },
    { id: "app.pane.narrower", title: "Narrower pane (the focused one, or the list)", keys: ["<"], run: (ctx) => resizePane(ctx, -4) },
    { id: "app.pane.wider", title: "Wider pane (the focused one, or the list)", keys: [">"], run: (ctx) => resizePane(ctx, 4) },
    { id: "app.refresh", title: "Reload", keys: ["r", "f5"], bar: "reload", run: (ctx) => current(ctx).refresh(ctx) },
    {
      id: "app.open",
      title: "Open in the browser",
      keys: ["O"],
      run: async (ctx) => {
        const url = current(ctx).url(ctx);
        if (url) await ctx.opts.openUrl(url);
      },
    },
    {
      id: "app.copy.url",
      title: "Copy the URL",
      keys: ["Y"],
      run: (ctx) => {
        const url = current(ctx).url(ctx);
        if (url) copied(ctx, url);
      },
    },
    {
      id: "app.copy.id",
      title: "Copy the key or id",
      keys: ["y"],
      run: (ctx) => {
        const s = ctx.store.get();
        const id = current(ctx).itemId(s, slices(s).list.selected);
        if (id) copied(ctx, id);
      },
    },

    // Navigator
    { id: "nav.down", title: "Down", keys: ["j", "down"], focus: ["nav"], run: nav(1) },
    { id: "nav.up", title: "Up", keys: ["k", "up"], focus: ["nav"], run: nav(-1) },
    { id: "nav.top", title: "Top", keys: ["g", "home"], focus: ["nav"], run: nav("top") },
    { id: "nav.bottom", title: "Bottom", keys: ["G", "end"], focus: ["nav"], run: nav("bottom") },
    {
      id: "nav.open",
      title: "Open or expand",
      keys: ["return", "l", "right"],
      focus: ["nav"],
      bar: "open",
      run: async (ctx) => {
        const node = selectedNode(ctx.store.get());
        if (!node) return;
        if (node.expandable && !ctx.store.get()[ctx.store.get().area].nav.expanded.includes(node.id)) await expandNode(ctx, current(ctx), node);
        await current(ctx).open(ctx, node);
      },
    },
    {
      id: "nav.collapse",
      title: "Collapse or go to parent",
      keys: ["h", "left"],
      focus: ["nav"],
      run: (ctx) =>
        updateNav(ctx, (t) => {
          const node = t.selected ? t.nodes[t.selected] : undefined;
          if (!node) return t;
          if (t.expanded.includes(node.id)) return setExpanded(t, node.id, false);
          return node.parent ? { ...t, selected: node.parent } : t;
        }),
    },

    // List
    { id: "list.down", title: "Down", keys: ["j", "down"], focus: ["list"], run: list(1) },
    { id: "list.up", title: "Up", keys: ["k", "up"], focus: ["list"], run: list(-1) },
    { id: "list.top", title: "Top", keys: ["g", "home"], focus: ["list"], run: list("top") },
    { id: "list.bottom", title: "Bottom", keys: ["G", "end"], focus: ["list"], run: list("bottom") },
    { id: "list.pagedown", title: "Page down", keys: ["pagedown", "ctrl+f"], focus: ["list"], run: list("page") },
    { id: "list.pageup", title: "Page up", keys: ["pageup", "ctrl+b"], focus: ["list"], run: list("-page") },
    { id: "list.detail", title: "Show the detail", keys: ["return", "l", "right"], focus: ["list"], run: (ctx) => ctx.store.set((s) => ({ ...s, focus: "detail" })) },
    { id: "list.nav", title: "Go to the navigator", keys: ["h", "left"], focus: ["list"], run: (ctx) => ctx.store.set((s) => ({ ...s, navOpen: true, focus: "nav" })) },
    {
      id: "list.mark",
      title: "Mark for a bulk change",
      keys: ["space"],
      focus: ["list"],
      bar: "mark",
      run: (ctx) => {
        const s = ctx.store.get();
        const id = current(ctx).itemId(s, slices(s).list.selected);
        if (!id) return;
        updateList(ctx, (l) => toggleMark(l, id), current(ctx));
        list(1)(ctx);
      },
    },
    {
      id: "list.mark.all",
      title: "Mark all (again: none)",
      keys: ["V"],
      focus: ["list"],
      run: (ctx) => {
        const s = ctx.store.get();
        const ids = slices(s).list.items.map((_, i) => current(ctx).itemId(s, i)!).filter(Boolean);
        updateList(ctx, (l) => ({ ...l, marked: l.marked.length === ids.length ? [] : ids }), current(ctx));
      },
    },
    {
      id: "list.mark.clear",
      title: "Clear the marks",
      keys: ["U"],
      focus: ["list"],
      run: (ctx) => updateList(ctx, (l) => (l.marked.length ? { ...l, marked: [] } : l), current(ctx)),
    },

    // Detail
    { id: "detail.down", title: "Scroll down", keys: ["j", "down"], focus: ["detail"], run: scroll(1) },
    { id: "detail.up", title: "Scroll up", keys: ["k", "up"], focus: ["detail"], run: scroll(-1) },
    { id: "detail.pagedown", title: "Page down", keys: ["space", "pagedown", "ctrl+f"], focus: ["detail"], run: scroll("page") },
    { id: "detail.pageup", title: "Page up", keys: ["pageup", "ctrl+b"], focus: ["detail"], run: scroll("-page") },
    { id: "detail.top", title: "Top", keys: ["g", "home"], focus: ["detail"], run: scroll("top") },
    {
      id: "detail.back",
      title: "Back to the list",
      keys: ["escape", "h", "left"],
      focus: ["detail"],
      run: (ctx) => ctx.store.set((s) => ({ ...s, focus: "list", zoom: false })),
    },
  ];
}

/** Pane width limits; the detail keeps at least `MIN_DETAIL` columns. */
export const MIN_PANE = 16;

/** Grows or shrinks the nav (when focused) or the list pane by `by` columns. */
export function resizePane(ctx: Ctx, by: number): void {
  ctx.store.set((s) => {
    const which = s.focus === "nav" ? "navWidth" : "listWidth";
    const base = s[which] ?? (which === "navWidth" ? 32 : 60);
    return { ...s, [which]: Math.max(MIN_PANE, base + by) };
  });
}

function copied(ctx: Ctx, text: string): void {
  if (ctx.copy(text)) ctx.toast("success", `Copied: ${text}`);
  else ctx.toast("error", "This terminal does not support copying (OSC 52).");
}

async function switchArea(ctx: Ctx, areas: Record<TuiArea, AreaModule>, area: TuiArea): Promise<void> {
  const s = ctx.store.get();
  if (s.area === area) return;
  ctx.store.set((st) => ({ ...st, area, focus: "list", zoom: false }));
  if (visibleNodes(ctx.store.get()[area].nav).length === 0) await areas[area].init(ctx);
}
