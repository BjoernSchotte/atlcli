/**
 * The TUI's state and the pure functions that change it. Views render it,
 * commands and loaders update it through the store; nothing here touches the
 * terminal or the network, so it all tests without either.
 */
import type { JiraBoardColumn, JiraIssue } from "@atlcli/jira";
import type { TuiArea, TuiView } from "../index.js";

export type Focus = "nav" | "list" | "detail";

// ============ Lists ============

export interface ListState<T> {
  title: string;
  /** The JQL or CQL behind the list, shown in the header and the filter bar. */
  query: string;
  items: T[];
  selected: number;
  /** Ids of the multi-selected items. */
  marked: string[];
  loading: boolean;
  error?: string;
  hasMore?: boolean;
}

export function emptyList<T>(title = "", query = ""): ListState<T> {
  return { title, query, items: [], selected: 0, marked: [], loading: false };
}

const clamp = (n: number, count: number) => Math.max(0, Math.min(n, count - 1));

export function moveSelection<T>(list: ListState<T>, to: number): ListState<T> {
  const selected = clamp(to, list.items.length);
  return selected === list.selected ? list : { ...list, selected };
}

export function toggleMark<T>(list: ListState<T>, id: string): ListState<T> {
  return { ...list, marked: list.marked.includes(id) ? list.marked.filter((m) => m !== id) : [...list.marked, id] };
}

/** New items keep the selection on the same id when it is still there. */
export function withItems<T>(list: ListState<T>, items: T[], idOf: (item: T) => string, hasMore = false): ListState<T> {
  const current = list.items[list.selected];
  const keep = current ? items.findIndex((item) => idOf(item) === idOf(current)) : -1;
  const ids = new Set(items.map(idOf));
  return {
    ...list,
    items,
    hasMore,
    loading: false,
    error: undefined,
    selected: keep >= 0 ? keep : clamp(list.selected, items.length),
    marked: list.marked.filter((m) => ids.has(m)),
  };
}

// ============ Trees ============

export interface TreeNode {
  id: string;
  label: string;
  /** What the node is: "board", "sprint", "space", "page", … */
  kind: string;
  parent?: string;
  depth: number;
  /** Child ids once loaded; undefined = not loaded yet. */
  children?: string[];
  /** Whether the node can have children (shows ▸/▾). */
  expandable: boolean;
  loading?: boolean;
  /** Free data for the loader (board id, space key, page id, JQL, …). */
  data?: Record<string, unknown>;
}

export interface TreeState {
  nodes: Record<string, TreeNode>;
  roots: string[];
  expanded: string[];
  selected?: string;
}

export const emptyTree = (): TreeState => ({ nodes: {}, roots: [], expanded: [] });

/** The nodes on screen, depth-first, children of expanded nodes only. */
export function visibleNodes(tree: TreeState): TreeNode[] {
  const out: TreeNode[] = [];
  const walk = (ids: string[]) => {
    for (const id of ids) {
      const node = tree.nodes[id];
      if (!node) continue;
      out.push(node);
      if (tree.expanded.includes(id) && node.children) walk(node.children);
    }
  };
  walk(tree.roots);
  return out;
}

export function setChildren(tree: TreeState, parentId: string | undefined, children: Omit<TreeNode, "depth" | "parent">[]): TreeState {
  const depth = parentId ? (tree.nodes[parentId]?.depth ?? -1) + 1 : 0;
  const nodes = { ...tree.nodes };
  for (const child of children) nodes[child.id] = { ...child, parent: parentId, depth };
  const ids = children.map((c) => c.id);
  if (!parentId) return { ...tree, nodes, roots: ids, selected: tree.selected ?? ids[0] };
  nodes[parentId] = { ...nodes[parentId]!, children: ids, loading: false };
  return { ...tree, nodes };
}

export function setExpanded(tree: TreeState, id: string, open: boolean): TreeState {
  const has = tree.expanded.includes(id);
  if (open === has) return tree;
  return { ...tree, expanded: open ? [...tree.expanded, id] : tree.expanded.filter((e) => e !== id) };
}

export function moveTreeSelection(tree: TreeState, by: number | "top" | "bottom"): TreeState {
  const visible = visibleNodes(tree);
  if (visible.length === 0) return tree;
  const at = Math.max(0, visible.findIndex((n) => n.id === tree.selected));
  const to = by === "top" ? 0 : by === "bottom" ? visible.length - 1 : clamp(at + by, visible.length);
  return { ...tree, selected: visible[to]!.id };
}

// ============ Overlays ============

export interface PickerItem {
  id: string;
  label: string;
  hint?: string;
}

export type Overlay =
  | { kind: "help" }
  | { kind: "log"; selected: number }
  | { kind: "palette"; query: string; selected: number }
  | {
      kind: "picker";
      title: string;
      items: PickerItem[];
      query: string;
      selected: number;
      multi: boolean;
      marked: string[];
      /** The user toggled a mark (with tab), so `marked` is the answer even when empty. */
      toggled?: boolean;
      /** Free text the user typed is a valid answer (labels). */
      allowFree: boolean;
      /** Loads items for the query (user search); replaces `items`. */
      search?: (query: string) => Promise<PickerItem[]>;
      onSubmit: (ids: string[], free?: string) => void | Promise<void>;
    }
  | {
      kind: "confirm";
      title: string;
      lines: string[];
      /** Bulk changes over the threshold need a second `y`. */
      double: boolean;
      step: 0 | 1;
      onConfirm: () => void | Promise<void>;
    }
  | { kind: "prompt"; title: string; value: string; placeholder: string; onSubmit: (value: string) => void | Promise<void> }
  | { kind: "compose"; title: string; value: string; preview: boolean; onSubmit: (text: string) => void | Promise<void> }
  | {
      kind: "diff";
      title: string;
      before: string;
      after: string;
      /** Without it the diff is read-only. */
      onConfirm?: () => void | Promise<void>;
    };

/** Picker items matching the query: every word in label or hint, case-insensitive. */
export function filterItems(items: PickerItem[], query: string): PickerItem[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return items;
  return items.filter((item) => {
    const text = `${item.label} ${item.hint ?? ""} ${item.id}`.toLowerCase();
    return words.every((w) => text.includes(w));
  });
}

// ============ Toasts ============

export interface Toast {
  id: number;
  kind: "info" | "success" | "error";
  text: string;
}

// ============ Command log ============

/** A write the TUI made, with the `atlcli` commands that do the same. */
export interface LogEntry {
  id: number;
  /** Local time, HH:MM:SS. */
  at: string;
  ok: boolean;
  /** What changed, or why it failed. */
  text: string;
  /** Shell lines, `atlcli …`; empty when the CLI has no equivalent. */
  commands: string[];
}

// ============ Areas ============

export type Loadable<T> = { status: "loading" } | { status: "error"; error: string } | { status: "ok"; value: T };

export type JiraTab = "details" | "comments" | "links" | "history";

export interface IssueDetail {
  issue: JiraIssue;
  /** Description as markdown. */
  description: string;
}

export interface JiraState {
  /** `flow.statusMap` done statuses as JQL knows them (untranslated names). */
  done: string[];
  nav: TreeState;
  list: ListState<JiraIssue>;
  details: Record<string, Loadable<IssueDetail>>;
  tab: JiraTab;
  /** The list as rows, or as a board of columns (`b`). */
  view: "list" | "board";
  /** The board the list came from (a board, one of its sprints, its backlog). */
  boardId?: number;
  /** Board columns, by board id, once loaded. */
  columns: Record<number, JiraBoardColumn[]>;
}

export type WikiTab = "page" | "info";

export interface WikiPageRow {
  id: string;
  title: string;
  spaceKey?: string;
  version?: number;
  updated?: string;
  author?: string;
}

export interface PageDetail {
  id: string;
  title: string;
  spaceKey?: string;
  version: number;
  markdown: string;
  labels: string[];
  author?: string;
  updated?: string;
  /** Why the page cannot be edited as markdown, if it cannot. */
  editBlocked?: string;
}

export interface WikiState {
  nav: TreeState;
  list: ListState<WikiPageRow>;
  details: Record<string, Loadable<PageDetail>>;
  tab: WikiTab;
}

export interface AppState {
  area: TuiArea;
  focus: Focus;
  navOpen: boolean;
  /** The detail pane fills the body. */
  zoom: boolean;
  /** Widths the user set by dragging a border or with < and >; unset = automatic. */
  navWidth?: number;
  listWidth?: number;
  overlays: Overlay[];
  toasts: Toast[];
  /** Writes of this session, oldest first. */
  log: LogEntry[];
  /** Saved views of this profile, both areas. */
  views: TuiView[];
  /** Busy indicator text, e.g. "Saving…". */
  busy?: string;
  /** A scroll request for the detail pane; `seq` changes on every request. */
  detailScroll?: { by: number | "page" | "-page" | "top"; seq: number };
  jira: JiraState;
  wiki: WikiState;
}

export function initialState(area: TuiArea = "jira"): AppState {
  return {
    area,
    focus: "list",
    navOpen: true,
    zoom: false,
    overlays: [],
    toasts: [],
    log: [],
    views: [],
    jira: { done: [], nav: emptyTree(), list: emptyList("Issues"), details: {}, tab: "details", view: "list", columns: {} },
    wiki: { nav: emptyTree(), list: emptyList("Pages"), details: {}, tab: "page" },
  };
}

export const topOverlay = (state: AppState): Overlay | undefined => state.overlays[state.overlays.length - 1];

export function pushOverlay(state: AppState, overlay: Overlay): AppState {
  return { ...state, overlays: [...state.overlays, overlay] };
}

export function popOverlay(state: AppState): AppState {
  return state.overlays.length === 0 ? state : { ...state, overlays: state.overlays.slice(0, -1) };
}

export function replaceTop(state: AppState, overlay: Overlay): AppState {
  return { ...state, overlays: [...state.overlays.slice(0, -1), overlay] };
}

/** The panes in focus order for the current layout. */
export function panes(state: AppState): Focus[] {
  if (state.zoom) return ["detail"];
  return state.navOpen ? ["nav", "list", "detail"] : ["list", "detail"];
}

export function cycleFocus(state: AppState, by: 1 | -1): AppState {
  const order = panes(state);
  const at = order.indexOf(state.focus);
  const focus = order[(at + by + order.length) % order.length]!;
  return focus === state.focus ? state : { ...state, focus };
}
