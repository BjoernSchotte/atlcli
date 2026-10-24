import { adfToMarkdown, calendarDay, changelogRows, type JiraIssue } from "@atlcli/jira";
import type { TuiColumn } from "../index.js";
import { readable } from "./jira.js";
import type { JiraTab } from "./state.js";
import { clip, DetailFrame, useApp, useEnv, type RowProps } from "./views.js";

const day = (iso?: string) => (iso ? calendarDay(iso) : "");

export const DEFAULT_COLUMNS: TuiColumn[] = ["key", "status", "assignee"];

/** A column's width and text; `key` fits the longest key in the list (SALESMARKETING-13662). */
function cell(column: TuiColumn, issue: JiraIssue, keyWidth: number): { width: number; text: string } {
  const f = issue.fields;
  switch (column) {
    case "key":
      return { width: keyWidth, text: issue.key };
    case "type":
      return { width: 10, text: f.issuetype?.name ?? "" };
    case "status":
      return { width: 13, text: f.status?.name ?? "" };
    case "priority":
      return { width: 10, text: f.priority?.name ?? "" };
    case "assignee":
      return { width: 15, text: f.assignee?.displayName ?? "–" };
    case "updated":
      return { width: 11, text: day(f.updated) };
  }
}

const COLUMN_COLOR: Record<TuiColumn, "key" | "status" | "dim" | "fg"> = { key: "key", type: "dim", status: "status", priority: "dim", assignee: "dim", updated: "dim" };

export function JiraRow({ item, width, marked }: RowProps<JiraIssue>) {
  const { theme, ctx } = useEnv();
  const keyWidth = useApp((s) => Math.min(24, Math.max(8, ...s.jira.list.items.map((i) => i.key.length)))) + 2;
  const configured = ctx.opts.config?.columns ?? DEFAULT_COLUMNS;
  // Narrow lists drop columns from the right until the summary keeps 20 characters.
  const columns: TuiColumn[] = [];
  let used = 2;
  for (const column of configured) {
    const w = cell(column, item, keyWidth).width;
    if (column !== "key" && used + w > width - 20) break;
    columns.push(column);
    used += w;
  }
  return (
    <>
      <text fg={theme.markedFg} content={marked ? "● " : "  "} style={{ flexShrink: 0 }} />
      {columns.map((column) => {
        const { width: w, text } = cell(column, item, keyWidth);
        return <text key={column} fg={theme[COLUMN_COLOR[column]]} content={clip(text, w - 1).padEnd(w)} wrapMode="none" style={{ flexShrink: 0 }} />;
      })}
      <text fg={theme.fg} content={item.fields.summary ?? ""} wrapMode="none" style={{ flexShrink: 1 }} />
    </>
  );
}

const TABS: JiraTab[] = ["details", "comments", "links", "history"];

export function JiraDetail() {
  const { theme, syntax, ctx } = useEnv();
  const issue = useApp((s) => s.jira.list.items[s.jira.list.selected]);
  const detail = useApp((s) => (issue ? s.jira.details[issue.key] : undefined));
  const tab = useApp((s) => s.jira.tab);
  if (!issue) return <DetailFrame title="Issue"><text fg={theme.dim} content="No issue selected." /></DetailFrame>;
  const full = detail?.status === "ok" ? detail.value.issue : issue;
  const f = full.fields;
  const comments = f.comment?.comments ?? [];
  const links = f.issuelinks ?? [];
  const subtasks = f.subtasks ?? [];
  const tabLabel = (t: JiraTab) =>
    t === "comments" ? `comments ${detail?.status === "ok" ? comments.length : ""}`.trim() : t === "links" ? `links ${detail?.status === "ok" ? links.length + subtasks.length + (f.parent ? 1 : 0) : ""}`.trim() : t;
  return (
    <DetailFrame
      title={issue.key}
      tabs={TABS.map(tabLabel)}
      active={tabLabel(tab)}
      onTab={(label) => {
        const t = TABS.find((x) => label.startsWith(x));
        if (t) ctx.store.set((s) => ({ ...s, jira: { ...s.jira, tab: t } }));
      }}
    >
      <text fg={theme.fg} content={f.summary ?? ""} attributes={1} />
      <text
        fg={theme.dim}
        content={[f.issuetype?.name, f.status?.name, f.priority?.name, f.assignee?.displayName ?? "unassigned"].filter(Boolean).join(" · ")}
      />
      <text content="" />
      {detail?.status === "error" ? <text fg={theme.error} content={detail.error} /> : null}
      {!detail || detail.status === "loading" ? <text fg={theme.dim} content="Loading…" /> : null}
      {detail?.status === "ok" && tab === "details" ? (
        <box style={{ flexDirection: "column" }}>
          {(
            [
              ["Reporter", f.reporter?.displayName],
              ["Labels", (f.labels ?? []).join(", ")],
              ["Components", (f.components ?? []).map((c) => c.name).join(", ")],
              ["Fix versions", (f.fixVersions ?? []).map((v) => v.name).join(", ")],
              ["Parent", f.parent ? `${f.parent.key}  ${f.parent.fields?.summary ?? ""}` : ""],
              ["Due", f.duedate ?? ""],
              ["Created", day(f.created)],
              ["Updated", day(f.updated)],
            ] as Array<[string, string | undefined]>
          )
            .filter(([, v]) => v)
            .map(([label, value]) => (
              <box key={label} style={{ height: 1, flexDirection: "row" }}>
                <text fg={theme.dim} content={label.padEnd(14)} style={{ flexShrink: 0 }} />
                <text fg={theme.fg} content={value!} wrapMode="none" />
              </box>
            ))}
          <text content="" />
          <markdown content={detail.value.description || "_No description._"} syntaxStyle={syntax} conceal />
        </box>
      ) : null}
      {detail?.status === "ok" && tab === "comments" ? (
        <box style={{ flexDirection: "column" }}>
          {comments.length === 0 ? <text fg={theme.dim} content="No comments. c writes one." /> : null}
          {comments.map((c) => (
            <box key={c.id} style={{ flexDirection: "column", marginBottom: 1 }}>
              <text fg={theme.accent} content={`${c.author?.displayName ?? "?"} · ${day(c.created)}`} />
              <markdown content={readable(adfToMarkdown(c.body, { baseUrl: ctx.opts.siteUrl })).trim() || "_(empty)_"} syntaxStyle={syntax} conceal />
            </box>
          ))}
        </box>
      ) : null}
      {detail?.status === "ok" && tab === "links" ? (
        <box style={{ flexDirection: "column" }}>
          {f.parent ? <LinkLine verb="parent" issueKey={f.parent.key} status={f.parent.fields?.status?.name} summary={f.parent.fields?.summary} /> : null}
          {subtasks.map((st) => (
            <LinkLine key={st.key} verb="subtask" issueKey={st.key} status={st.fields?.status?.name} summary={st.fields?.summary} />
          ))}
          {links.map((link) => {
            const other = link.outwardIssue ?? link.inwardIssue;
            return (
              <LinkLine
                key={link.id}
                verb={link.outwardIssue ? link.type.outward : link.type.inward}
                issueKey={other?.key ?? "?"}
                status={other?.fields?.status?.name}
                summary={other?.fields?.summary}
              />
            );
          })}
          {links.length + subtasks.length === 0 && !f.parent ? <text fg={theme.dim} content="No links." /> : <text fg={theme.dim} content="enter lists them" />}
        </box>
      ) : null}
      {detail?.status === "ok" && tab === "history" ? (
        <box style={{ flexDirection: "column" }}>
          {changelogRows(full.changelog?.histories ?? []).map((row, i) => (
            <text key={i} fg={theme.fg} content={`${day(row.created)}  ${row.author ?? "?"}  ${row.field}: ${row.from ?? ""} → ${row.to ?? ""}`} wrapMode="word" />
          ))}
          {(full.changelog?.histories ?? []).length === 0 ? <text fg={theme.dim} content="No history." /> : null}
        </box>
      ) : null}
    </DetailFrame>
  );
}

function LinkLine({ verb, issueKey, status, summary }: { verb: string; issueKey: string; status?: string; summary?: string }) {
  const { theme } = useEnv();
  return (
    <box style={{ height: 1, flexDirection: "row" }}>
      <text fg={theme.dim} content={clip(verb, 18).padEnd(19)} style={{ flexShrink: 0 }} />
      <text fg={theme.key} content={issueKey.padEnd(12)} style={{ flexShrink: 0 }} />
      <text fg={theme.status} content={clip(status ?? "", 12).padEnd(13)} style={{ flexShrink: 0 }} />
      <text fg={theme.fg} content={summary ?? ""} wrapMode="none" />
    </box>
  );
}
