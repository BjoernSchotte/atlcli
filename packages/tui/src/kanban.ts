/**
 * The board view of a Jira list: columns from the board's configuration, or
 * one per status. The selection stays the list's, so every issue command
 * works on the selected card. Moving a card is a transition into a status of
 * the next column; it runs at once and goes into the command log.
 */
import type { JiraBoardColumn, JiraIssue } from "@atlcli/jira";
import { updateList } from "./commands.js";
import { jira, loadColumns, loadDetail, selectedIssue } from "./jira.js";
import { transitionArgv } from "./jira-actions.js";
import type { Command, Ctx } from "./keymap.js";
import { logged } from "./log.js";
import { moveSelection, pushOverlay, type AppState } from "./state.js";

export interface KanbanColumn {
  name: string;
  /** Statuses a card moved here may take; empty for "Not on the board". */
  statusIds: string[];
  /** Indexes into the list's items, in list (rank) order. */
  items: number[];
}

const CATEGORY_ORDER = ["new", "indeterminate", "done"];

/**
 * The columns for `items`: the board's, plus "Not on the board" for statuses
 * it does not map; without board columns, one column per status in the list,
 * ordered by status category.
 */
export function kanbanColumns(items: JiraIssue[], board?: JiraBoardColumn[]): KanbanColumn[] {
  const statusId = (i: JiraIssue) => String(i.fields.status?.id ?? "");
  if (board?.length) {
    const columns = board.map((c) => ({ name: c.name, statusIds: c.statusIds, items: [] as number[] }));
    const unmapped: number[] = [];
    items.forEach((issue, n) => {
      const column = columns.find((c) => c.statusIds.includes(statusId(issue)));
      if (column) column.items.push(n);
      else unmapped.push(n);
    });
    return unmapped.length ? [...columns, { name: "Not on the board", statusIds: [], items: unmapped }] : columns;
  }
  const byStatus = new Map<string, KanbanColumn & { rank: number }>();
  items.forEach((issue, n) => {
    const id = statusId(issue);
    let column = byStatus.get(id);
    if (!column) {
      const category = CATEGORY_ORDER.indexOf(issue.fields.status?.statusCategory?.key ?? "");
      column = { name: issue.fields.status?.name ?? "?", statusIds: [id], items: [], rank: (category < 0 ? 1 : category) * 1000 + byStatus.size };
      byStatus.set(id, column);
    }
    column.items.push(n);
  });
  return [...byStatus.values()].sort((a, b) => a.rank - b.rank).map(({ rank: _, ...column }) => column);
}

/** Where the selected card sits: column and position in it. */
export function cardAt(columns: KanbanColumn[], selected: number): { column: number; row: number } | undefined {
  for (const [column, c] of columns.entries()) {
    const row = c.items.indexOf(selected);
    if (row >= 0) return { column, row };
  }
  return undefined;
}

/** The item index after moving the cursor; columns without cards are skipped sideways. */
export function kanbanStep(columns: KanbanColumn[], selected: number, dir: "left" | "right" | "up" | "down"): number | undefined {
  const at = cardAt(columns, selected);
  if (!at) return columns.find((c) => c.items.length)?.items[0];
  const here = columns[at.column]!.items;
  if (dir === "up") return here[Math.max(0, at.row - 1)];
  if (dir === "down") return here[Math.min(here.length - 1, at.row + 1)];
  const by = dir === "left" ? -1 : 1;
  for (let c = at.column + by; c >= 0 && c < columns.length; c += by) {
    const items = columns[c]!.items;
    if (items.length) return items[Math.min(at.row, items.length - 1)];
  }
  return undefined;
}

/** The board's columns for the current list, if they are loaded; else undefined (one column per status). */
export function boardColumnsOf(state: AppState): JiraBoardColumn[] | undefined {
  const { boardId, columns } = state.jira;
  return boardId === undefined ? undefined : columns[boardId];
}

export const currentColumns = (state: AppState) => kanbanColumns(state.jira.list.items, boardColumnsOf(state));

const inBoard = (s: AppState) => s.area === "jira" && s.jira.view === "board";

function step(dir: "left" | "right" | "up" | "down"): Command["run"] {
  return (ctx) => {
    const s = ctx.store.get();
    const to = kanbanStep(currentColumns(s), s.jira.list.selected, dir);
    if (to !== undefined) updateList(ctx, (l) => moveSelection(l, to), jira);
  };
}

/** Moves the selected card to column `target`: the transition into one of its statuses. */
async function moveTo(ctx: Ctx, target: KanbanColumn): Promise<void> {
  const issue = selectedIssue(ctx.store.get());
  if (!issue) return;
  if (target.statusIds.includes(String(issue.fields.status?.id))) return;
  const transitions = await ctx.task("Loading transitions…", () => ctx.opts.jira.getTransitions(issue.key));
  if (!transitions) return;
  const fitting = transitions.filter((t) => t.to?.id !== undefined && target.statusIds.includes(String(t.to.id)));
  const run = async (t: (typeof transitions)[number]) => {
    const done = await ctx.task("Moving…", () =>
      logged(ctx, [transitionArgv([issue.key], t.name)], async () => {
        await ctx.opts.jira.transitionIssue(issue.key, { transition: { id: t.id } });
        return `${issue.key} → ${t.to?.name ?? t.name}`;
      })
    );
    // The reload updates the card's status, which moves it into its column.
    await loadDetail(ctx, issue.key, true);
    if (done) ctx.toast("success", done);
  };
  if (fitting.length === 0) return ctx.toast("info", `${issue.key} has no transition into "${target.name}".`);
  if (fitting.length === 1) return run(fitting[0]!);
  ctx.store.set((s) =>
    pushOverlay(s, {
      kind: "picker",
      title: `Move ${issue.key} to "${target.name}"`,
      items: fitting.map((t) => ({ id: t.id, label: t.name, hint: t.to?.name })),
      query: "",
      selected: 0,
      multi: false,
      marked: [],
      allowFree: false,
      onSubmit: ([id]) => run(fitting.find((t) => t.id === id)!),
    })
  );
}

function shift(by: -1 | 1): Command["run"] {
  return (ctx) => {
    const s = ctx.store.get();
    const columns = currentColumns(s);
    const at = cardAt(columns, s.jira.list.selected);
    const target = at ? columns[at.column + by] : undefined;
    if (target?.statusIds.length) return moveTo(ctx, target);
  };
}

function pickColumn(ctx: Ctx): void {
  const columns = currentColumns(ctx.store.get()).filter((c) => c.statusIds.length);
  ctx.store.set((s) =>
    pushOverlay(s, {
      kind: "picker",
      title: `Move ${selectedIssue(s)?.key ?? ""} to the column…`,
      items: columns.map((c, n) => ({ id: String(n), label: c.name, hint: `${c.items.length}` })),
      query: "",
      selected: 0,
      multi: false,
      marked: [],
      allowFree: false,
      onSubmit: ([n]) => moveTo(ctx, columns[Number(n)]!),
    })
  );
}

const board: Pick<Command, "area" | "focus" | "enabled"> = { area: "jira", focus: ["list"], enabled: inBoard };

export const kanbanCommands: Command[] = [
  {
    id: "jira.view.board",
    title: "Board view on/off: the list as columns",
    keys: ["b"],
    area: "jira",
    focus: ["list", "detail"],
    bar: "board",
    run: async (ctx) => {
      ctx.store.set((s) => ({ ...s, focus: "list", zoom: false, jira: { ...s.jira, view: s.jira.view === "board" ? "list" : "board" } }));
      await loadColumns(ctx);
    },
  },
  { id: "board.left", title: "Previous column", keys: ["h", "left"], ...board, run: step("left") },
  { id: "board.right", title: "Next column", keys: ["l", "right"], ...board, run: step("right") },
  { id: "board.up", title: "Card above", keys: ["k", "up"], ...board, run: step("up") },
  { id: "board.down", title: "Card below", keys: ["j", "down"], ...board, run: step("down") },
  {
    id: "board.open",
    title: "Show the card's issue",
    keys: ["return"],
    ...board,
    run: (ctx) => ctx.store.set((s) => ({ ...s, zoom: true, focus: "detail" })),
  },
  { id: "board.move.left", title: "Move the card one column left (transition)", keys: ["shift+left"], ...board, bar: "move", run: shift(-1) },
  { id: "board.move.right", title: "Move the card one column right (transition)", keys: ["shift+right"], ...board, run: shift(1) },
  { id: "board.move", title: "Move the card to a column (transition)", keys: ["m"], ...board, run: pickColumn },
];
