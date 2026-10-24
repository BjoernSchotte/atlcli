import type { WikiPageRow, WikiTab } from "./state.js";
import { clip, DetailFrame, useApp, useEnv, type RowProps } from "./views.js";
import { readablePage } from "./wiki.js";

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

const TABS: WikiTab[] = ["page", "info"];

export function WikiDetail() {
  const { theme, syntax, ctx } = useEnv();
  const row = useApp((s) => s.wiki.list.items[s.wiki.list.selected]);
  const detail = useApp((s) => (row ? s.wiki.details[row.id] : undefined));
  const tab = useApp((s) => s.wiki.tab);
  if (!row) return <DetailFrame title="Page"><text fg={theme.dim} content="No page selected." /></DetailFrame>;
  const page = detail?.status === "ok" ? detail.value : undefined;
  return (
    <DetailFrame
      title={clip(page?.title ?? row.title, 60)}
      tabs={TABS}
      active={tab}
      onTab={(t) => ctx.store.set((s) => ({ ...s, wiki: { ...s.wiki, tab: t as WikiTab } }))}
    >
      {detail?.status === "error" ? <text fg={theme.error} content={detail.error} /> : null}
      {!detail || detail.status === "loading" ? <text fg={theme.dim} content="Loading…" /> : null}
      {page && page.editBlocked ? <text fg={theme.status} content={`Read only here: ${page.editBlocked}`} /> : null}
      {page && tab === "page" ? <markdown content={readablePage(page.markdown) || "_Empty page._"} syntaxStyle={syntax} conceal /> : null}
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
