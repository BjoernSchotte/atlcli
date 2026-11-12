/**
 * The Wiki area: navigator (recent, my pages, spaces → page tree), page lists
 * from CQL or a page's children, and the page as markdown. Edits go through
 * the same conversion as `docs push`, show a diff and check the version.
 */
import { markdownToStorage, storageToMarkdown, type ConfluenceClient, type PageComments } from "@atlcli/confluence";
import { parseStorageLinks } from "@atlcli/confluence/internal";
import { parseConfluencePageRef, type ConfluencePageRef } from "@atlcli/core";
import type { AreaModule } from "./commands.js";
import { expandNode, updateNav } from "./commands.js";
import type { Command, Ctx } from "./keymap.js";
import { logged, record, type Argv } from "./log.js";
import { VIEWS_GROUP, viewNodes, viewsGroup } from "./saved-views.js";
import { pushOverlay, setChildren, withItems, type AppState, type Overlay, type PageDetail, type PageLink, type PickerItem, type TreeNode, type WikiComment, type WikiPageRow, type WikiTab, type WikiThread } from "./state.js";

const MAX = 100;

/** Content `docs push` could not write back: a preserved macro whose raw XML was not available. */
const LOST_MACRO = /^\*\[([^\]]+) macro - no content\]\*$/m;

/** Why a page cannot be edited as markdown, if it cannot. */
export function editBlockReason(markdown: string): string | undefined {
  const lost = LOST_MACRO.exec(markdown);
  return lost ? `The "${lost[1]}" macro has no content atlcli can keep; edit this page in Confluence.` : undefined;
}

/** Markdown for reading: preserved macros (`:::confluence name … :::`) show as their label. */
export function readablePage(markdown: string): string {
  return (
    markdown
      .replace(/^:::confluence ([^\n]+)\n(?:<!--raw\n[\s\S]*?\n-->\n)?\*\[([^\]]*)\]\*\n:::$/gm, (_m, _name, label) => `*[${label}]*`)
      // The converter escapes punctuation that would otherwise start markdown ("1\. Title"); the viewer shows it literally.
      .replace(/\\([.\-+#!()[\]_*`>|~])/g, "$1")
  );
}

/** The search bar: CQL as is, plain words as a text search (in the default space, if any). */
export function searchCql(query: string, space?: string): string {
  const q = query.trim();
  if (/[=~]|\b(AND|OR|ORDER BY)\b/.test(q)) return q;
  return `type = page${space ? ` AND space = ${JSON.stringify(space)}` : ""} AND text ~ ${JSON.stringify(q.replace(/"/g, ""))} ORDER BY lastmodified DESC`;
}

/** A page's links to other Confluence pages: page references, and plain links to page URLs of this site. */
export function pageLinks(storage: string, confluenceBaseUrl: string): PageLink[] {
  const links: PageLink[] = [];
  const seen = new Set<string>();
  for (const link of parseStorageLinks(storage)) {
    let found: PageLink | undefined;
    if (link.type === "internal") {
      found = {
        label: link.linkText || link.targetPageTitle || `Page ${link.targetPageId}`,
        pageId: link.targetPageId ?? undefined,
        title: link.targetPageTitle ?? undefined,
        spaceKey: link.targetSpaceKey ?? undefined,
      };
    } else if (link.type === "external" && link.externalUrl) {
      const ref = parseConfluencePageRef(confluenceBaseUrl, link.externalUrl.replace(/&amp;/g, "&"));
      if (!("error" in ref)) found = { label: link.linkText || link.externalUrl, ...ref };
    }
    if (!found) continue;
    const key = [found.pageId, found.spaceKey, found.title, found.commentId].join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    links.push(found);
  }
  return links;
}

/** The page's comments as threads for reading: footer comments first, then inline ones, replies in order. */
export function commentThreads(all: PageComments, toMarkdown: (storage: string) => string): WikiThread[] {
  type Node = PageComments["footerComments"][number];
  const flat = (comment: Node, depth: number): WikiComment[] => [
    { id: comment.id, author: comment.author.displayName, created: comment.created, text: toMarkdown(comment.body), depth },
    ...comment.replies.flatMap((reply) => flat(reply, depth + 1)),
  ];
  return [
    ...all.footerComments.map((c): WikiThread => ({ id: c.id, kind: "footer", resolved: c.status === "resolved", comments: flat(c, 0) })),
    ...all.inlineComments.map((c): WikiThread => ({
      id: c.id,
      kind: "inline",
      resolved: c.status === "resolved",
      selection: c.textSelection || c.inlineOriginalSelection || undefined,
      comments: flat(c, 0),
    })),
  ];
}

/** The line of the page an inline comment's text stands in, when the page still has it and it says more than the text. */
export function selectionContext(markdown: string, selection: string | undefined): string | undefined {
  if (!selection) return undefined;
  const line = markdown.split("\n").find((l) => l.includes(selection))?.trim();
  return line && line !== selection ? line : undefined;
}

const pageUrl = (ctx: Ctx, row: { id: string; spaceKey?: string }) =>
  row.spaceKey ? `${ctx.opts.confluence.getInstanceUrl()}/spaces/${row.spaceKey}/pages/${row.id}` : `${ctx.opts.confluence.getInstanceUrl()}/pages/viewpage.action?pageId=${row.id}`;

function setWiki(ctx: Ctx, patch: (w: AppState["wiki"]) => Partial<AppState["wiki"]>): void {
  ctx.store.set((s) => ({ ...s, wiki: { ...s.wiki, ...patch(s.wiki) } }));
}

let listSeq = 0;
let listAbort: AbortController | undefined;

/** Shows rows in the list; a newer load cancels an older one still in flight. */
async function loadRows(ctx: Ctx, title: string, query: string, rows: (signal: AbortSignal) => Promise<WikiPageRow[]>): Promise<void> {
  const seq = ++listSeq;
  listAbort?.abort();
  const { signal } = (listAbort = new AbortController());
  // A reload of the same list keeps the selection; another list starts at the top.
  const same = ctx.store.get().wiki.list.query === query;
  setWiki(ctx, (w) => ({ list: { ...w.list, title, query, loading: true, error: undefined } }));
  try {
    const items = await rows(signal);
    if (seq !== listSeq) return;
    setWiki(ctx, (w) => ({ list: withItems(same ? w.list : { ...w.list, items: [], selected: 0, marked: [] }, items, (p) => p.id, items.length >= MAX) }));
    wiki.select(ctx);
  } catch (err) {
    if (seq !== listSeq) return;
    setWiki(ctx, (w) => ({ list: { ...w.list, loading: false, error: err instanceof Error ? err.message : String(err), items: [] } }));
  }
}

export function loadSearch(ctx: Ctx, title: string, cql: string): Promise<void> {
  return loadRows(ctx, title, cql, async (signal) =>
    (await ctx.opts.confluence.searchPages(cql, MAX, { signal })).map((r) => ({ id: r.id, title: r.title, spaceKey: r.spaceKey, version: r.version, updated: r.lastModified }))
  );
}

/** Current child pages and folders of a page or folder. Data Center has no v2 API and no folders: v1 child pages there. */
async function directChildren(client: ConfluenceClient, parentId: string, signal?: AbortSignal): Promise<{ id: string; title: string; type: "page" | "folder" }[]> {
  if (client.deploymentType !== "cloud") {
    return (await client.getChildrenWithPosition(parentId, { signal })).map((p) => ({ id: p.id, title: p.title, type: "page" }));
  }
  const children = await client.getPageDirectChildren(parentId, { signal });
  return children
    .filter((c) => (c.status ?? "current") === "current" && (c.type === "page" || c.type === "folder"))
    .map((c) => ({ id: c.id, title: c.title, type: c.type as "page" | "folder" }));
}

/** A page's children as rows, the page itself first (so its detail shows). */
async function childRows(client: ConfluenceClient, page: { id: string; title: string; spaceKey?: string } | undefined, parentId: string, signal?: AbortSignal): Promise<WikiPageRow[]> {
  const rows = (await directChildren(client, parentId, signal)).filter((c) => c.type === "page").map((c) => ({ id: c.id, title: c.title, spaceKey: page?.spaceKey }));
  return page ? [{ id: page.id, title: page.title, spaceKey: page.spaceKey }, ...rows] : rows;
}

const details = new Map<string, Promise<void>>();

/** Loads (or reloads) a page: markdown with mention names, labels, and whether it can be edited. */
export function loadPage(ctx: Ctx, id: string, force = false): Promise<void> {
  const known = ctx.store.get().wiki.details[id];
  if (!force && known && known.status !== "error") return details.get(id) ?? Promise.resolve();
  if (!known) setWiki(ctx, (w) => ({ details: { ...w.details, [id]: { status: "loading" } } }));
  const client = ctx.opts.confluence;
  const request = (async () => {
    const page = await client.getPageDetails(id);
    const [names, labels] = await Promise.all([client.mentionNames([page.storage]).catch(() => new Map<string, string>()), client.getLabels(id).catch(() => [])]);
    const markdown = storageToMarkdown(page.storage, { baseUrl: client.getInstanceUrl(), mentionNames: names }).trim();
    const value: PageDetail = {
      id,
      title: page.title,
      spaceKey: page.spaceKey,
      version: page.version ?? 1,
      markdown,
      labels: labels.map((l) => l.name),
      links: pageLinks(page.storage, client.getInstanceUrl()),
      author: page.modifiedBy?.displayName || undefined,
      updated: page.modified ?? page.lastModified,
      editBlocked: editBlockReason(markdown),
    };
    setWiki(ctx, (w) => ({
      details: { ...w.details, [id]: { status: "ok", value } },
      list: { ...w.list, items: w.list.items.map((r) => (r.id === id ? { ...r, title: page.title, spaceKey: page.spaceKey ?? r.spaceKey, version: value.version } : r)) },
    }));
  })()
    .catch((err) => setWiki(ctx, (w) => ({ details: { ...w.details, [id]: { status: "error", error: err instanceof Error ? err.message : String(err) } } })))
    .finally(() => details.delete(id));
  details.set(id, request);
  return request;
}

const threads = new Map<string, Promise<void>>();

/** Loads (or reloads) a page's comments with their authors' names. */
export function loadComments(ctx: Ctx, id: string, force = false): Promise<void> {
  const known = ctx.store.get().wiki.comments[id];
  if (!force && known && known.status !== "error") return threads.get(id) ?? Promise.resolve();
  if (!known) setWiki(ctx, (w) => ({ comments: { ...w.comments, [id]: { status: "loading" } } }));
  const client = ctx.opts.confluence;
  const request = (async () => {
    const all = await client.getAllComments(id, { authorNames: true });
    const value = commentThreads(all, (storage) => readablePage(storageToMarkdown(storage, { baseUrl: client.getInstanceUrl() }).trim()));
    setWiki(ctx, (w) => ({ comments: { ...w.comments, [id]: { status: "ok", value } } }));
  })()
    .catch((err) => setWiki(ctx, (w) => ({ comments: { ...w.comments, [id]: { status: "error", error: err instanceof Error ? err.message : String(err) } } })))
    .finally(() => threads.delete(id));
  threads.set(id, request);
  return request;
}

export const selectedPage = (s: AppState): WikiPageRow | undefined => s.wiki.list.items[s.wiki.list.selected];

export const WIKI_TABS: WikiTab[] = ["page", "comments", "info"];

/** Shows a detail tab; the comments load the first time their tab shows. */
export function showTab(ctx: Ctx, tab: WikiTab): void {
  setWiki(ctx, () => ({ tab }));
  const row = selectedPage(ctx.store.get());
  if (tab === "comments" && row) void loadComments(ctx, row.id);
}

// ============ Open by URL, follow links, back ============

/**
 * Shows a page that is not in the list (opened by URL or id, or reached over
 * a link) as a list of its own; the list left behind is kept for `back`. A
 * link to a comment opens the comments with that thread first.
 */
export async function openPage(ctx: Ctx, ref: ConfluencePageRef, title = `Page ${ref.pageId}`): Promise<void> {
  ctx.store.set((s) => ({
    ...s,
    focus: "detail",
    wiki: {
      ...s.wiki,
      back: [...s.wiki.back, s.wiki.list],
      tab: ref.commentId ? "comments" : "page",
      focusedComment: ref.commentId ? { pageId: ref.pageId, commentId: ref.commentId } : undefined,
    },
  }));
  // A page seen before has its row at hand; otherwise the title is a placeholder until `loadPage` puts the real one in.
  const known = ctx.store.get().wiki.details[ref.pageId];
  const row: WikiPageRow = known?.status === "ok" ? { id: ref.pageId, title: known.value.title, spaceKey: known.value.spaceKey, version: known.value.version } : { id: ref.pageId, title };
  await loadRows(ctx, "Opened page", `page:${ref.pageId}`, async () => [row]);
}

function openByUrl(ctx: Ctx): void {
  open(ctx, {
    kind: "prompt",
    title: "Open a page: URL or id",
    value: "",
    placeholder: "https://…/wiki/spaces/DOCS/pages/10001/…?focusedCommentId=20001",
    onSubmit: (value) => {
      if (!value.trim()) return;
      const ref = parseConfluencePageRef(ctx.opts.confluence.getInstanceUrl(), value);
      if ("error" in ref) return ctx.toast("error", ref.error);
      return openPage(ctx, ref);
    },
  });
}

/** CQL for a page link that names its target by title. */
export function linkTargetCql(title: string, space?: string): string {
  return `type = page${space ? ` AND space = ${JSON.stringify(space)}` : ""} AND title = ${JSON.stringify(title)}`;
}

function followLink(ctx: Ctx): void {
  const row = selectedPage(ctx.store.get());
  const detail = row ? ctx.store.get().wiki.details[row.id] : undefined;
  if (!row || detail?.status !== "ok") return;
  const { links, spaceKey } = detail.value;
  if (links.length === 0) return ctx.toast("info", "This page links to no other Confluence page.");
  open(ctx, {
    kind: "picker",
    title: `Follow a link of "${detail.value.title}"`,
    items: links.map((l, i) => ({ id: String(i), label: l.label, hint: l.title ? [l.spaceKey, l.title].filter(Boolean).join(" · ") : `page ${l.pageId}${l.commentId ? " · comment" : ""}` })),
    query: "",
    selected: 0,
    multi: false,
    marked: [],
    allowFree: false,
    onSubmit: async ([index]) => {
      const link = links[Number(index)]!;
      let pageId = link.pageId;
      if (!pageId && link.title) {
        const space = link.spaceKey ?? spaceKey;
        const found = await ctx.task("Finding the page…", () => ctx.opts.confluence.searchPages(linkTargetCql(link.title!, space), 1));
        if (!found) return;
        pageId = found[0]?.id;
        if (!pageId) return ctx.toast("error", `"${link.title}" was not found${space ? ` in ${space}` : ""} (renamed, deleted, or not visible to you).`);
      }
      if (pageId) await openPage(ctx, { pageId, commentId: link.commentId }, link.title ?? link.label);
    },
  });
}

/** Returns to the list a page was opened from. */
function goBack(ctx: Ctx): void {
  const { back } = ctx.store.get().wiki;
  const origin = back[back.length - 1];
  if (!origin) return;
  // A load still in flight belongs to the list being left.
  listSeq++;
  listAbort?.abort();
  setWiki(ctx, (w) => ({ back: w.back.slice(0, -1), focusedComment: undefined, list: { ...origin, loading: false } }));
  wiki.select(ctx);
}

const open = (ctx: Ctx, overlay: Overlay) => ctx.store.set((s) => pushOverlay(s, overlay));

/** Asks, runs `apply`, logs it with `argvs` (the CLI commands that do the same), reloads `reload`. */
function confirm(ctx: Ctx, title: string, lines: string[], argvs: Argv[], apply: () => Promise<string>, reload: string[]): void {
  open(ctx, {
    kind: "confirm",
    title,
    lines,
    double: false,
    step: 0,
    onConfirm: async () => {
      const done = await ctx.task("Saving…", () => logged(ctx, argvs, apply));
      await Promise.all(reload.map((id) => loadPage(ctx, id, true)));
      if (done) ctx.toast("success", done);
    },
  });
}

// ============ Edit ============

/** Fetches the page fresh, edits it in $EDITOR, shows the diff, and saves only if nobody changed it meanwhile. */
async function edit(ctx: Ctx): Promise<void> {
  const row = selectedPage(ctx.store.get());
  if (!row) return;
  const client = ctx.opts.confluence;
  const fresh = await ctx.task("Loading the page…", async () => {
    const page = await client.getPage(row.id);
    const names = await client.mentionNames([page.storage]).catch(() => new Map<string, string>());
    return { page, markdown: storageToMarkdown(page.storage, { baseUrl: client.getInstanceUrl(), mentionNames: names }).trim() };
  });
  if (!fresh) return;
  const blocked = editBlockReason(fresh.markdown);
  if (blocked) return ctx.toast("error", blocked);
  const before = fresh.markdown;
  const after = (await ctx.suspend(() => ctx.opts.editText(`${before}\n`, `${row.id}.md`))).trim();
  if (after === before) return ctx.toast("info", "No changes.");
  const baseVersion = fresh.page.version ?? 1;
  open(ctx, {
    kind: "diff",
    title: `Save "${fresh.page.title}" (v${baseVersion} → v${baseVersion + 1})?`,
    before,
    after,
    onConfirm: () => save(ctx, row.id, fresh.page.title, baseVersion, before, after),
  });
}

async function save(ctx: Ctx, id: string, title: string, baseVersion: number, before: string, after: string): Promise<void> {
  const client = ctx.opts.confluence;
  const result = await ctx.task("Saving…", async () => {
    const current = await client.getPage(id);
    if ((current.version ?? 1) !== baseVersion) return { conflict: current.version ?? 1 };
    const notes: string[] = [];
    const storage = markdownToStorage(after, { baseUrl: client.getInstanceUrl(), emitWarnings: true, onWarning: (m) => notes.push(m) });
    try {
      await client.updatePage({ id, title, storage, version: baseVersion + 1 });
    } catch (err) {
      // Someone saved between our check and the write: Confluence rejects the stale version.
      if (/\b409\b|conflict|version/i.test(err instanceof Error ? err.message : "")) return { conflict: (await client.getPage(id)).version ?? baseVersion + 1 };
      record(ctx, false, err instanceof Error ? err.message : String(err), [["wiki", "page", "update", "--id", id, "--body", `${id}.md`]]);
      throw err;
    }
    return { saved: baseVersion + 1, notes };
  });
  if (!result) return;
  if ("conflict" in result) {
    conflict(ctx, id, title, baseVersion, result.conflict!, before, after);
    return;
  }
  record(ctx, true, `Saved "${title}" as v${result.saved}`, [["wiki", "page", "update", "--id", id, "--body", `${id}.md`]]);
  await loadPage(ctx, id, true);
  ctx.toast("success", `Saved "${title}" as v${result.saved}${result.notes?.length ? ` (${result.notes.join(" ")})` : ""}`);
}

/** Someone else saved meanwhile: show their change, or open the editor on their version with ours as a draft. */
function conflict(ctx: Ctx, id: string, title: string, baseVersion: number, remoteVersion: number, before: string, after: string): void {
  open(ctx, {
    kind: "picker",
    title: `"${title}" changed in Confluence (v${baseVersion} → v${remoteVersion}); not saved`,
    items: [
      { id: "remote", label: "Show what changed in Confluence", hint: `v${baseVersion} → v${remoteVersion}` },
      { id: "redo", label: "Edit again on the new version (your text as a draft below it)" },
      { id: "cancel", label: "Discard my edit" },
    ],
    query: "",
    selected: 0,
    multi: false,
    marked: [],
    allowFree: false,
    onSubmit: async ([choice]) => {
      const client = ctx.opts.confluence;
      if (choice === "cancel") return;
      const page = await ctx.task("Loading the new version…", () => client.getPage(id));
      if (!page) return;
      const remote = storageToMarkdown(page.storage, { baseUrl: client.getInstanceUrl() }).trim();
      if (choice === "remote") {
        open(ctx, { kind: "diff", title: `Changed in Confluence: v${baseVersion} → v${page.version}`, before, after: remote });
        return;
      }
      const draft = `${remote}\n\n<!-- Your edit of v${baseVersion} (merge it above, then delete this block):\n${after.replace(/-->/g, "--&gt;")}\n-->\n`;
      const merged = (await ctx.suspend(() => ctx.opts.editText(draft, `${id}.md`))).trim();
      if (merged === remote) return ctx.toast("info", "No changes.");
      open(ctx, {
        kind: "diff",
        title: `Save "${page.title}" (v${page.version} → v${(page.version ?? 1) + 1})?`,
        before: remote,
        after: merged,
        onConfirm: () => save(ctx, id, page.title, page.version ?? 1, remote, merged),
      });
    },
  });
}

// ============ New page, labels, move, versions ============

async function newPage(ctx: Ctx): Promise<void> {
  const parent = selectedPage(ctx.store.get());
  const node = ctx.store.get().wiki.nav.selected ? ctx.store.get().wiki.nav.nodes[ctx.store.get().wiki.nav.selected!] : undefined;
  const spaceKey = parent?.spaceKey ?? (node?.kind === "space" ? String(node.data?.key) : ctx.opts.space);
  if (!spaceKey) return ctx.toast("error", "Select a page or a space first.");
  const where = parent ? `under "${parent.title}"` : `at the top of ${spaceKey}`;
  open(ctx, {
    kind: "prompt",
    title: `New page ${where}: title`,
    value: "",
    placeholder: "Page title",
    onSubmit: async (title) => {
      if (!title.trim()) return ctx.toast("error", "The title cannot be empty.");
      const body = (await ctx.suspend(() => ctx.opts.editText(`# ${title.trim()}\n\n`, "new-page.md"))).trim();
      confirm(
        ctx,
        `Create "${title.trim()}" ${where}?`,
        body.split("\n").slice(0, 12),
        [["wiki", "page", "create", "--space", spaceKey, "--title", title.trim(), "--body", "new-page.md", ...(parent ? ["--parent", parent.id] : [])]],
        async () => {
          const client = ctx.opts.confluence;
          const page = await client.createPage({ spaceKey, title: title.trim(), storage: markdownToStorage(body, { baseUrl: client.getInstanceUrl() }), parentId: parent?.id });
          const row: WikiPageRow = { id: page.id, title: page.title, spaceKey };
          setWiki(ctx, (w) => ({ list: { ...withItems(w.list, [...w.list.items, row], (p) => p.id, w.list.hasMore), selected: w.list.items.length } }));
          void loadPage(ctx, page.id, true);
          return `Created "${page.title}"`;
        },
        []
      );
    },
  });
}

function labels(ctx: Ctx): void {
  const row = selectedPage(ctx.store.get());
  const detail = row ? ctx.store.get().wiki.details[row.id] : undefined;
  if (!row || detail?.status !== "ok") return;
  const own = detail.value.labels;
  open(ctx, {
    kind: "picker",
    title: `Labels of "${row.title}" (tab toggles, enter applies)`,
    items: own.map((l) => ({ id: l, label: l })),
    query: "",
    selected: 0,
    multi: true,
    marked: own,
    allowFree: true,
    onSubmit: (ids, free) => {
      const wanted = [...new Set([...ids, ...(free ? free.split(/[\s,]+/).filter(Boolean) : [])])];
      const add = wanted.filter((l) => !own.includes(l));
      const remove = own.filter((l) => !wanted.includes(l));
      if (add.length + remove.length === 0) return ctx.toast("info", "No changes.");
      confirm(ctx, `Change the labels of "${row.title}"?`, [...add.map((l) => `+ ${l}`), ...remove.map((l) => `- ${l}`)], [
        ...(add.length ? [["wiki", "page", "label", "add", ...add, "--id", row.id]] : []),
        ...remove.map((l) => ["wiki", "page", "label", "remove", l, "--id", row.id]),
      ], async () => {
        if (add.length) await ctx.opts.confluence.addLabels(row.id, add);
        for (const l of remove) await ctx.opts.confluence.removeLabel(row.id, l);
        return `Labels of "${row.title}" updated`;
      }, [row.id]);
    },
  });
}

export function parentSearchCql(space: string, query: string): string {
  const q = query.trim().replace(/["\\]/g, "");
  return `type = page AND space = ${JSON.stringify(space)}${q ? ` AND title ~ ${JSON.stringify(`${q}*`)}` : ""} ORDER BY lastmodified DESC`;
}

function move(ctx: Ctx): void {
  const row = selectedPage(ctx.store.get());
  if (!row?.spaceKey) return;
  const titles = new Map<string, string>();
  open(ctx, {
    kind: "picker",
    title: `Move "${row.title}" under…`,
    items: [],
    query: "",
    selected: 0,
    multi: false,
    marked: [],
    allowFree: false,
    search: async (q) => {
      const found = await ctx.opts.confluence.searchPages(parentSearchCql(row.spaceKey!, q), 30);
      return found.filter((p) => p.id !== row.id).map((p) => {
        titles.set(p.id, p.title);
        return { id: p.id, label: p.title, hint: p.spaceKey };
      });
    },
    onSubmit: ([parentId]) =>
      confirm(ctx, `Move "${row.title}" under "${titles.get(parentId!) ?? parentId}"?`, [`${row.title} → ${titles.get(parentId!) ?? parentId}`], [["wiki", "page", "move", "--id", row.id, "--parent", parentId!]], async () => {
        await ctx.opts.confluence.movePage(row.id, parentId!);
        return `Moved "${row.title}"`;
      }, [row.id]),
  });
}

async function versions(ctx: Ctx): Promise<void> {
  const row = selectedPage(ctx.store.get());
  if (!row) return;
  const client = ctx.opts.confluence;
  const history = await ctx.task("Loading versions…", () => client.getPageHistory(row.id, { limit: 50 }));
  if (!history) return;
  const items: PickerItem[] = history.versions.map((v) => ({
    id: String(v.number),
    label: `v${v.number}  ${v.by.displayName}${v.message ? `  ${v.message}` : ""}`,
    hint: v.when.slice(0, 10),
  }));
  open(ctx, {
    kind: "picker",
    title: `Compare a version of "${row.title}" with the current one (v${history.latest})`,
    items,
    query: "",
    selected: Math.min(1, items.length - 1),
    multi: false,
    marked: [],
    allowFree: false,
    onSubmit: async ([version]) => {
      const pages = await ctx.task("Loading both versions…", () => Promise.all([client.getPageAtVersion(row.id, Number(version)), client.getPage(row.id)]));
      if (!pages) return;
      const md = (storage: string) => storageToMarkdown(storage, { baseUrl: client.getInstanceUrl() }).trim();
      open(ctx, { kind: "diff", title: `"${row.title}": v${version} → v${pages[1].version} (current)`, before: md(pages[0].storage), after: md(pages[1].storage) });
    },
  });
}

const onPage = ["list", "detail"] as Command["focus"];

const tabBy = (ctx: Ctx, by: 1 | -1): WikiTab => WIKI_TABS[(WIKI_TABS.indexOf(ctx.store.get().wiki.tab) + by + WIKI_TABS.length) % WIKI_TABS.length]!;

const wikiCommands: Command[] = [
  {
    id: "wiki.search",
    title: "Search pages: words or CQL",
    keys: ["/"],
    area: "wiki",
    bar: "search",
    run: (ctx) =>
      open(ctx, {
        kind: "prompt",
        title: `Search pages${ctx.opts.space ? ` (words search ${ctx.opts.space}; CQL searches all)` : " (words or CQL)"}`,
        value: "",
        placeholder: 'release notes   or   type = page AND label = "howto"',
        onSubmit: (q) => {
          if (!q.trim()) return;
          ctx.store.set((s) => ({ ...s, focus: "list" }));
          return loadSearch(ctx, `Search: ${q.trim()}`, searchCql(q, ctx.opts.space));
        },
      }),
  },
  { id: "wiki.edit", title: "Edit the page ($EDITOR, diff, then save)", keys: ["e"], area: "wiki", focus: onPage, bar: "edit", run: edit },
  { id: "wiki.new", title: "New child page", keys: ["n"], area: "wiki", bar: "new", run: newPage },
  { id: "wiki.labels", title: "Labels", keys: ["L"], area: "wiki", focus: onPage, bar: "labels", run: labels },
  { id: "wiki.move", title: "Move the page under another page", keys: ["m"], area: "wiki", focus: onPage, run: move },
  { id: "wiki.versions", title: "Compare with an earlier version", keys: ["v"], area: "wiki", focus: onPage, bar: "versions", run: versions },
  { id: "wiki.open", title: "Open a page by URL or id", keys: ["o"], area: "wiki", bar: "open url", run: openByUrl },
  { id: "wiki.follow", title: "Follow a link to another page", keys: ["f"], area: "wiki", focus: onPage, bar: "follow", run: followLink },
  {
    id: "wiki.back",
    title: "Back to where the page was opened from",
    keys: ["backspace"],
    area: "wiki",
    bar: "back",
    enabled: (s) => s.wiki.back.length > 0,
    run: goBack,
  },
  { id: "wiki.tab.next", title: "Next detail tab", keys: ["."], area: "wiki", run: (ctx) => showTab(ctx, tabBy(ctx, 1)) },
  { id: "wiki.tab.prev", title: "Previous detail tab", keys: [","], area: "wiki", run: (ctx) => showTab(ctx, tabBy(ctx, -1)) },
];

const query = (id: string, label: string, cql: string): Omit<TreeNode, "depth" | "parent"> => ({ id, label, kind: "query", expandable: false, data: { cql } });

export const wiki: AreaModule = {
  id: "wiki",
  label: "Wiki",
  commands: wikiCommands,

  async init(ctx) {
    const space = ctx.opts.space;
    const inSpace = space ? ` AND space = ${JSON.stringify(space)}` : "";
    const recent = `type = page${inSpace} AND lastmodified > now("-14d") ORDER BY lastmodified DESC`;
    updateNav(ctx, (t) =>
      setChildren(t, undefined, [
        query("q:recent", space ? `Recently updated (${space})` : "Recently updated", recent),
        query("q:mine", "My pages", "type = page AND contributor = currentUser() ORDER BY lastmodified DESC"),
        { id: "g:spaces", label: "Spaces", kind: "group", expandable: true },
        viewsGroup(),
      ])
    );
    const list = loadSearch(ctx, space ? `Recently updated (${space})` : "Recently updated", recent);
    const spaces = ctx.store.get().wiki.nav.nodes["g:spaces"]!;
    await expandNode(ctx, wiki, spaces);
    if (space && ctx.store.get().wiki.nav.nodes[`sp:${space}`]) {
      const node = ctx.store.get().wiki.nav.nodes[`sp:${space}`]!;
      updateNav(ctx, (t) => ({ ...t, selected: node.id }));
      await expandNode(ctx, wiki, node);
    }
    await list;
    // `atlcli tui <page>`: the page, with the first list to go back to.
    if (ctx.opts.open) {
      const ref = parseConfluencePageRef(ctx.opts.confluence.getInstanceUrl(), ctx.opts.open);
      if ("error" in ref) ctx.toast("error", ref.error);
      else await openPage(ctx, ref);
    }
  },

  async expand(ctx, node) {
    updateNav(ctx, (t) => ({ ...t, nodes: { ...t.nodes, [node.id]: { ...node, loading: true } } }));
    const children = await ctx.task(`Loading ${node.label}…`, () => childNodes(ctx, node));
    updateNav(ctx, (t) => setChildren(t, node.id, children ?? []));
  },

  async open(ctx, node) {
    ctx.store.set((s) => ({ ...s, focus: "list" }));
    return showNode(ctx, node);
  },

  select(ctx) {
    const row = selectedPage(ctx.store.get());
    if (!row) return;
    void loadPage(ctx, row.id);
    if (ctx.store.get().wiki.tab === "comments") void loadComments(ctx, row.id);
  },

  async refresh(ctx, quiet = false) {
    const s = ctx.store.get();
    // Quiet (auto-refresh): the detail stays until its new version is there.
    if (!quiet) setWiki(ctx, () => ({ details: {}, comments: {} }));
    // The node the list came from (the navigator may have moved on since).
    const [kind, id] = s.wiki.list.query.split(":", 2) as [string, string | undefined];
    const children = kind === "children" || kind === "space";
    const node = children ? s.wiki.nav.nodes[kind === "space" ? `sp:${id}` : `p:${id}`] : undefined;
    if (children && node) await showNode(ctx, node);
    // A page opened by URL or link is its own list: only the page reloads.
    else if (kind === "page") wiki.select(ctx);
    else if (!children) await loadSearch(ctx, s.wiki.list.title, s.wiki.list.query);
    const row = selectedPage(ctx.store.get());
    if (quiet && row) await Promise.all([loadPage(ctx, row.id, true), ...(s.wiki.tab === "comments" ? [loadComments(ctx, row.id, true)] : [])]);
  },

  itemId: (s, i) => s.wiki.list.items[i]?.id,
  url: (ctx) => {
    const row = selectedPage(ctx.store.get());
    return row ? pageUrl(ctx, row) : undefined;
  },
};

/** Shows what a navigator node stands for in the list: a search, a space's top pages, a page's children. */
async function showNode(ctx: Ctx, node: TreeNode): Promise<void> {
  const client = ctx.opts.confluence;
    if (typeof node.data?.cql === "string") return loadSearch(ctx, node.label, node.data.cql);
    if (node.kind === "space") {
      return loadRows(ctx, `${node.label}: top pages`, `space:${node.data?.key}`, async () =>
        (ctx.store.get().wiki.nav.nodes[node.id]?.children ?? []).map((id) => {
          const child = ctx.store.get().wiki.nav.nodes[id]!;
          return { id: String(child.data?.id), title: child.label, spaceKey: String(node.data?.key) };
        })
      );
    }
    if (node.kind === "page" || node.kind === "folder") {
      const page = node.kind === "page" ? { id: String(node.data?.id), title: node.label, spaceKey: node.data?.spaceKey as string | undefined } : undefined;
      return loadRows(ctx, node.label, `children:${node.data?.id}`, (signal) => childRows(client, page, String(node.data?.id), signal));
    }
}

async function childNodes(ctx: Ctx, node: TreeNode): Promise<Omit<TreeNode, "depth" | "parent">[]> {
  const client = ctx.opts.confluence;
  if (node.id === VIEWS_GROUP) return viewNodes(ctx.store.get().views, "wiki");
  if (node.id === "g:spaces") {
    const spaces = await client.listSpaces(250);
    const def = ctx.opts.space;
    return spaces
      .filter((sp) => sp.type === "global" || sp.key === def)
      .sort((a, b) => (a.key === def ? -1 : b.key === def ? 1 : a.name.localeCompare(b.name)))
      .map((sp) => ({ id: `sp:${sp.key}`, label: `${sp.name} (${sp.key})`, kind: "space", expandable: true, data: { key: sp.key, id: sp.id } }));
  }
  if (node.kind === "space") {
    const pages = await client.getSpaceRootPages({ id: String(node.data?.id), key: String(node.data?.key) });
    return pages.map((p) => ({ id: `p:${p.id}`, label: p.title, kind: "page", expandable: true, data: { id: p.id, spaceKey: node.data?.key } }));
  }
  if (node.kind === "page" || node.kind === "folder") {
    return (await directChildren(client, String(node.data?.id))).map((c) => ({
      id: `p:${c.id}`, label: c.type === "folder" ? `📁 ${c.title}` : c.title, kind: c.type, expandable: true, data: { id: c.id, spaceKey: node.data?.spaceKey },
    }));
  }
  return [];
}
