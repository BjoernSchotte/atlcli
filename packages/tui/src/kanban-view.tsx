import type { ScrollBoxRenderable } from "@opentui/core";
import { useEffect, useRef } from "react";
import { updateList } from "./commands.js";
import { jira } from "./jira.js";
import { boardColumnsOf, cardAt, kanbanColumns, type KanbanColumn } from "./kanban.js";
import { moveSelection } from "./state.js";
import { clip, useApp, useEnv } from "./views.js";

/** Narrowest column; fewer columns show (around the selected one) when they do not fit. */
export const MIN_COLUMN = 24;

/** The first column on screen, so that `selected` is one of the `fit` shown. */
export function columnWindow(count: number, fit: number, selected: number): number {
  if (count <= fit) return 0;
  return Math.max(0, Math.min(selected - Math.floor(fit / 2), count - fit));
}

/** The summary in up to two lines of `width`, the second cut with … when it runs on. */
export function twoLines(text: string, width: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  let first = "";
  let n = 0;
  for (; n < words.length; n++) {
    const next = first ? `${first} ${words[n]}` : words[n]!;
    if (next.length > width && first) break;
    first = next;
  }
  const rest = words.slice(n).join(" ");
  return rest ? [clip(first, width), clip(rest, width)] : [clip(first, width)];
}

/** The list as a board: one bordered column per status group, cards in list (rank) order. */
export function KanbanPane({ width }: { width: number }) {
  const { theme, ctx } = useEnv();
  const list = useApp((s) => s.jira.list);
  const board = useApp(boardColumnsOf);
  const focused = useApp((s) => s.focus === "list" && s.overlays.length === 0);
  const columns = kanbanColumns(list.items, board);
  const at = cardAt(columns, list.selected);
  const fit = Math.max(1, Math.floor(width / MIN_COLUMN));
  const first = columnWindow(columns.length, fit, at?.column ?? 0);
  const shown = columns.slice(first, first + fit);
  const colWidth = Math.floor(width / Math.max(1, shown.length));
  const lastClick = useRef({ index: -1, at: 0 });

  const select = (index: number) => {
    const now = Date.now();
    const double = lastClick.current.index === index && now - lastClick.current.at < 400;
    lastClick.current = { index, at: now };
    ctx.store.set((s) => ({ ...s, focus: double ? "detail" : "list", zoom: double }));
    updateList(ctx, (l) => moveSelection(l, index), jira);
  };

  if (list.error || list.items.length === 0) {
    return (
      <box title={` ${list.title} · board `} style={{ border: true, borderColor: focused ? theme.focus : theme.border, width }}>
        <text fg={list.error ? theme.error : theme.dim} content={` ${list.error ?? (list.loading ? "Loading…" : "Nothing here.")}`} />
      </box>
    );
  }
  return (
    <box style={{ flexDirection: "row", width, flexShrink: 0 }}>
      {shown.map((column, n) => (
        <Column
          key={`${first + n}-${column.name}`}
          column={column}
          width={n === shown.length - 1 ? width - colWidth * (shown.length - 1) : colWidth}
          title={`${first > 0 && n === 0 ? `‹${first} ` : ""}${column.name} (${column.items.length})${n === shown.length - 1 && first + fit < columns.length ? ` ${columns.length - first - fit}›` : ""}`}
          active={focused && at?.column === first + n}
          select={select}
        />
      ))}
    </box>
  );
}

function Column({ column, width, title, active, select }: { column: KanbanColumn; width: number; title: string; active: boolean; select: (index: number) => void }) {
  const { theme } = useEnv();
  const list = useApp((s) => s.jira.list);
  const ref = useRef<ScrollBoxRenderable>(null);
  const inner = width - 4;
  useEffect(() => {
    if (column.items.includes(list.selected)) ref.current?.scrollChildIntoView(`card-${list.items[list.selected]?.key}`);
  }, [list.selected, column.items.length]);
  return (
    <scrollbox ref={ref} title={` ${clip(title, width - 4)} `} style={{ border: true, borderColor: active ? theme.focus : theme.border, width, flexShrink: 0, paddingLeft: 1 }}>
      {column.items.map((index) => {
        const issue = list.items[index]!;
        const f = issue.fields;
        const selected = index === list.selected;
        const marked = list.marked.includes(issue.key);
        return (
          <box
            key={issue.key}
            id={`card-${issue.key}`}
            style={{ flexDirection: "column", marginBottom: 1, backgroundColor: selected ? theme.selectedBg : undefined }}
            onMouseDown={(event) => {
              event.stopPropagation();
              select(index);
            }}
          >
            <box style={{ height: 1, flexDirection: "row" }}>
              {marked ? <text fg={theme.markedFg} content="● " style={{ flexShrink: 0 }} /> : null}
              <text fg={theme.key} content={issue.key} wrapMode="none" style={{ flexShrink: 0 }} />
              <text fg={theme.dim} content={clip(`  ${f.assignee?.displayName ?? "–"}`, Math.max(0, inner - issue.key.length - (marked ? 2 : 0)))} wrapMode="none" />
            </box>
            {twoLines(f.summary ?? "", inner).map((line, n) => (
              <text key={n} fg={theme.fg} content={line} wrapMode="none" />
            ))}
          </box>
        );
      })}
    </scrollbox>
  );
}
