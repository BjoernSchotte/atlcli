import type { WikiPageRow, WikiTab, WikiThread } from "./state.js";
import { clip, DetailFrame, useApp, useEnv, type RowProps } from "./views.js";
import { readablePage, selectionContext, showTab, WIKI_TABS } from "./wiki.js";

export function WikiRow({ item, width }: RowProps<WikiPageRow>) {
  const { theme } = useEnv();
  const meta = [item.spaceKey, item.version ? `v${item.version}` : undefined, item.updated?.slice(0, 10)].filter(Boolean).join(" · ");
  return (
    <>
      <text fg={theme.fg} content={clip(item.title, Math.max(10, width - meta.length - 3))} wrapMode="none" style={{ flexGrow: 1, flexShrink: 1 }} />
      <text fg={theme.dim} content={` ${meta}`} wrapMode="none" style={{ flexShrink: 0 }} />
    </>
  );
}

/** One thread: what it is about, then its comments; the comment a link pointed at is marked. */
function Thread({ thread, markdown, focus }: { thread: WikiThread; markdown: string; focus?: string }) {
  const { theme } = useEnv();
  const context = selectionContext(markdown, thread.selection);
  return (
    <box style={{ flexDirection: "column", marginBottom: 1 }}>
      {thread.kind === "inline" ? (
        <text fg={theme.status} content={`On: ${thread.selection ? `"${thread.selection}"` : "(text no longer on the page)"}${thread.resolved ? "  [resolved]" : ""}`} wrapMode="word" />
      ) : null}
      {context ? <text fg={theme.dim} content={`│ ${context}`} wrapMode="word" /> : null}
      {thread.comments.map((c) => {
        const focused = c.id === focus;
        return (
          <box key={c.id} style={{ flexDirection: "column", paddingLeft: c.depth * 2, backgroundColor: focused ? theme.selectedBg : undefined }}>
            <text fg={focused ? theme.status : theme.accent} content={`${focused ? "▶ " : ""}${c.author} · ${c.created.slice(0, 10)}`} wrapMode="none" />
            <text fg={theme.fg} content={c.text || "(empty)"} wrapMode="word" />
          </box>
        );
      })}
    </box>
  );
}

export function WikiDetail() {
  const { theme, syntax, ctx } = useEnv();
  const row = useApp((s) => s.wiki.list.items[s.wiki.list.selected]);
  const detail = useApp((s) => (row ? s.wiki.details[row.id] : undefined));
  const tab = useApp((s) => s.wiki.tab);
  const comments = useApp((s) => (row ? s.wiki.comments[row.id] : undefined));
  const focus = useApp((s) => (row && s.wiki.focusedComment?.pageId === row.id ? s.wiki.focusedComment.commentId : undefined));
  const threads = comments?.status === "ok" ? comments.value : [];
  // The thread a link pointed at comes first.
  const linked = focus ? threads.find((t) => t.comments.some((c) => c.id === focus)) : undefined;
  const tabLabel = (t: WikiTab) => (t === "comments" && comments?.status === "ok" ? `comments ${threads.length}` : t);
  if (!row) return <DetailFrame title="Page"><text fg={theme.dim} content="No page selected." /></DetailFrame>;
  const page = detail?.status === "ok" ? detail.value : undefined;
  return (
    <DetailFrame
      title={clip(page?.title ?? row.title, 60)}
      tabs={WIKI_TABS.map(tabLabel)}
      active={tabLabel(tab)}
      onTab={(label) => showTab(ctx, WIKI_TABS.find((t) => tabLabel(t) === label) ?? "page")}
    >
      {detail?.status === "error" ? <text fg={theme.error} content={detail.error} /> : null}
      {!detail || detail.status === "loading" ? <text fg={theme.dim} content="Loading…" /> : null}
      {page && page.editBlocked ? <text fg={theme.status} content={`Read only here: ${page.editBlocked}`} /> : null}
      {page && tab === "page" ? <markdown content={readablePage(page.markdown) || "_Empty page._"} syntaxStyle={syntax} conceal /> : null}
      {tab === "comments" ? (
        <box style={{ flexDirection: "column" }}>
          {comments?.status === "error" ? <text fg={theme.error} content={comments.error} wrapMode="word" /> : null}
          {!comments || comments.status === "loading" ? <text fg={theme.dim} content="Loading comments…" /> : null}
          {comments?.status === "ok" && focus && !linked ? (
            <text fg={theme.error} content={`Comment ${focus} is not on this page (deleted, or not visible to you).${threads.length ? " The page's comments:" : ""}`} wrapMode="word" style={{ marginBottom: 1 }} />
          ) : null}
          {comments?.status === "ok" && threads.length === 0 ? <text fg={theme.dim} content="No comments." /> : null}
          {linked ? <Thread thread={linked} markdown={page?.markdown ?? ""} focus={focus} /> : null}
          {linked && threads.length > 1 ? <text fg={theme.dim} content="Other comments on this page:" style={{ marginBottom: 1 }} /> : null}
          {threads.filter((t) => t !== linked).map((t) => (
            <Thread key={t.id} thread={t} markdown={page?.markdown ?? ""} />
          ))}
        </box>
      ) : null}
      {page && tab === "info" ? (
        <box style={{ flexDirection: "column" }}>
          {(
            [
              ["Title", page.title],
              ["Space", page.spaceKey ?? ""],
              ["Id", page.id],
              ["Version", `v${page.version}`],
              ["Updated", [page.updated?.slice(0, 16).replace("T", " "), page.author].filter(Boolean).join(" by ")],
              ["Labels", page.labels.join(", ") || "–"],
              ["Editable", page.editBlocked ? `no: ${page.editBlocked}` : "yes (e)"],
            ] as Array<[string, string]>
          ).map(([label, value]) => (
            <box key={label} style={{ flexDirection: "row" }}>
              <text fg={theme.dim} content={label.padEnd(10)} style={{ flexShrink: 0 }} />
              <text fg={theme.fg} content={value} wrapMode="word" />
            </box>
          ))}
        </box>
      ) : null}
    </DetailFrame>
  );
}
