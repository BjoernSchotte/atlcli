import { describe, expect, test } from "bun:test";
import { handleKey } from "./app.js";
import { expandNode } from "./commands.js";
import { topOverlay } from "./state.js";
import { commands, setup, type TestSetup } from "./testing.js";
import { commentThreads, editBlockReason, loadPage, loadSearch, openPage, pageLinks, parentSearchCql, readablePage, searchCql, selectionContext, wiki } from "./wiki.js";

const press = (t: TestSetup, ...keys: string[]) => {
  for (const key of keys) {
    const named = ["return", "escape", "tab", "space", "up", "down", "backspace"].includes(key);
    handleKey({ ctx: t.ctx, commands: commands(), keymap: {} }, named ? { name: key } : { name: key.toLowerCase(), sequence: key, shift: key !== key.toLowerCase() });
  }
};

describe("helpers", () => {
  test("a macro without content blocks editing; preserved macros do not", () => {
    expect(editBlockReason(":::confluence jira\n*[jira macro - no content]*\n:::")).toContain(`"jira" macro`);
    expect(editBlockReason(":::confluence jira\n<!--raw\n<x/>\n-->\n*[jira macro]*\n:::")).toBeUndefined();
  });

  test("readablePage shows preserved macros as their label and drops converter escapes", () => {
    expect(readablePage(":::confluence jira\n<!--raw\n<x/>\n-->\n*[jira macro]*\n:::\n\n1\\. Intro")).toBe("*[jira macro]*\n\n1. Intro");
  });

  test("readablePage shows a page link as its text, not its page: target", () => {
    expect(readablePage("See [the \\[old\\] spec](page:DOCS/API%20Spec) and [site](https://example.com).")).toBe("See the [old] spec ↗ and [site](https://example.com).");
  });

  test("words search the default space, CQL passes through", () => {
    expect(searchCql("release notes", "DOC")).toBe(`type = page AND space = "DOC" AND text ~ "release notes" ORDER BY lastmodified DESC`);
    expect(searchCql(`label = "howto"`, "DOC")).toBe(`label = "howto"`);
    expect(parentSearchCql("DOC", `x"y`)).toBe(`type = page AND space = "DOC" AND title ~ "xy*" ORDER BY lastmodified DESC`);
  });
});

const page = (id: string, version: number, body: string) => ({ id, title: `Page ${id}`, spaceKey: "DOC", version, storage: body });

function wikiSetup(extra: Record<string, (...args: never[]) => unknown> = {}, editText?: (text: string) => Promise<string>) {
  let version = 3;
  const t = setup({}, { area: "wiki", space: "DOC", ...(editText ? { editText } : {}) }, {
    getInstanceUrl: () => "https://example.atlassian.net/wiki",
    searchPages: () => [{ id: "10", title: "Page 10", spaceKey: "DOC", version: 3 }],
    getPage: (id: string) => page(id, version, "<p>Hello <strong>world</strong></p>"),
    getPageDetails: (id: string) => ({ ...page(id, version, "<p>Hello <strong>world</strong></p>"), modified: "2026-10-20T09:30:00.000Z", modifiedBy: { displayName: "Ann Lee" } }),
    mentionNames: () => new Map(),
    getLabels: () => [{ name: "a", prefix: "global" }],
    updatePage: (p: { version: number }) => {
      version = p.version;
      return { id: "10", title: "Page 10" };
    },
    ...extra,
  });
  return { t, bump: () => version++ };
}

describe("reading", () => {
  test("a search lists pages and loads the first as markdown with its labels", async () => {
    const { t } = wikiSetup();
    await loadSearch(t.ctx, "Recent", "type = page");
    await t.settle();
    const d = t.ctx.store.get().wiki.details["10"];
    expect(d?.status === "ok" && d.value).toMatchObject({ markdown: "Hello **world**", labels: ["a"], version: 3, author: "Ann Lee", updated: "2026-10-20T09:30:00.000Z" });
  });

  test("init: default space first and expanded", async () => {
    const { t } = wikiSetup({
      listSpaces: () => [
        { id: "1", key: "ABC", name: "Alpha", type: "global" },
        { id: "2", key: "DOC", name: "Docs", type: "global" },
        { id: "3", key: "~me", name: "Mine", type: "personal" },
      ],
      getSpaceRootPages: () => [{ id: "10", title: "Home" }],
    });
    await wiki.init(t.ctx);
    await t.settle();
    const nav = t.ctx.store.get().wiki.nav;
    expect(nav.nodes["g:spaces"]!.children).toEqual(["sp:DOC", "sp:ABC"]);
    expect(nav.expanded).toContain("sp:DOC");
    expect(nav.nodes["sp:DOC"]!.children).toEqual(["p:10"]);
  });

  test("Data Center: child pages come from the v1 API (no v2, no folders)", async () => {
    const { t } = wikiSetup({
      deploymentType: () => "data-center",
      listSpaces: () => [{ id: "2", key: "DOC", name: "Docs", type: "global" }],
      getSpaceRootPages: () => [{ id: "10", title: "Home" }],
      getChildrenWithPosition: () => [{ id: "11", title: "Child", position: 0 }],
    });
    await wiki.init(t.ctx);
    await t.settle();
    await expandNode(t.ctx, wiki, t.ctx.store.get().wiki.nav.nodes["p:10"]!);
    expect(t.ctx.store.get().wiki.nav.nodes["p:10"]!.children).toEqual(["p:11"]);
    // Opening the page lists its children too (live: this list hit the v2 API and failed with 404).
    await wiki.open(t.ctx, t.ctx.store.get().wiki.nav.nodes["p:10"]!);
    expect(t.ctx.store.get().wiki.list.items.map((r) => r.id)).toEqual(["10", "11"]);
    expect(t.calls.map((c) => c.method)).not.toContain("getPageDirectChildren");
  });

  test("a newer list load cancels the request of the older one", async () => {
    const signals: AbortSignal[] = [];
    const { t } = wikiSetup({ searchPages: (_cql: string, _max: number, o: { signal: AbortSignal }) => (signals.push(o.signal), []) });
    await loadSearch(t.ctx, "A", "a");
    await loadSearch(t.ctx, "B", "b");
    expect(signals.map((s) => s.aborted)).toEqual([true, false]);
  });

  test("a failed page load shows its error", async () => {
    const { t } = wikiSetup({ getPageDetails: () => Promise.reject(new Error("403 Forbidden")) });
    await loadPage(t.ctx, "10");
    const d = t.ctx.store.get().wiki.details["10"];
    expect(d).toEqual({ status: "error", error: "403 Forbidden" });
  });
});

describe("editing", () => {
  test("edit shows the diff and saves as version + 1", async () => {
    const { t } = wikiSetup({}, async (text) => `${text}\nMore.`);
    await loadSearch(t.ctx, "Recent", "q");
    await t.settle();
    press(t, "e");
    await t.settle();
    const diff = topOverlay(t.ctx.store.get());
    expect(diff?.kind === "diff" && [diff.before, diff.after]).toEqual(["Hello **world**", "Hello **world**\n\nMore."]);
    press(t, "y");
    await t.settle();
    const saves = t.calls.filter((c) => c.method === "updatePage").map((c) => c.args[0]);
    expect(saves).toEqual([{ id: "10", title: "Page 10", storage: expect.stringContaining("<strong>world</strong>"), version: 4 }]);
  });

  test("a version saved meanwhile is not overwritten: the conflict choices come up", async () => {
    const { t, bump } = wikiSetup({}, async (text) => `${text}\nMine.`);
    await loadSearch(t.ctx, "Recent", "q");
    await t.settle();
    press(t, "e");
    await t.settle();
    bump();
    press(t, "y");
    await t.settle();
    expect(t.calls.some((c) => c.method === "updatePage")).toBe(false);
    const choice = topOverlay(t.ctx.store.get());
    expect(choice?.kind === "picker" && choice.title).toContain("changed in Confluence (v3 → v4); not saved");
  });

  test("a page with a macro atlcli cannot keep is not edited", async () => {
    const { t } = wikiSetup({
      getPage: (id: string) => page(id, 3, '<div data-macro="confluence" data-macro-name="jira">x</div>'),
      getPageDetails: (id: string) => page(id, 3, '<div data-macro="confluence" data-macro-name="jira">x</div>'),
    });
    const { storageToMarkdown } = await import("@atlcli/confluence");
    // Precondition: the converter really produces the no-content marker for such a page.
    expect(storageToMarkdown('<div data-macro="confluence" data-macro-name="jira">x</div>')).toContain("macro - no content");
    await loadSearch(t.ctx, "Recent", "q");
    await t.settle();
    press(t, "e");
    await t.settle();
    expect(t.toasts().at(-1)?.text).toContain("edit this page in Confluence");
    expect(topOverlay(t.ctx.store.get())).toBeUndefined();
  });

  test("labels: only the difference is written", async () => {
    const added: unknown[] = [];
    const removed: unknown[] = [];
    const { t } = wikiSetup({ addLabels: (id: string, l: string[]) => void added.push([id, l]), removeLabel: (id: string, l: string) => void removed.push([id, l]) });
    await loadSearch(t.ctx, "Recent", "q");
    await t.settle();
    press(t, "L", "tab");
    t.ctx.store.set((s) => ({ ...s, overlays: [{ ...(topOverlay(s) as Extract<typeof s.overlays[number], { kind: "picker" }>), query: "b" }] }));
    press(t, "return", "y");
    await t.settle();
    expect(added).toEqual([["10", ["b"]]]);
    expect(removed).toEqual([["10", "a"]]);
  });
});

const BASE = "https://example.atlassian.net/wiki";

const comment = (id: string, body: string, replies: unknown[] = [], extra: Record<string, unknown> = {}) => ({
  id,
  author: { displayName: "Ann Lee", accountId: "a1" },
  created: "2026-11-12T10:00:00.000Z",
  body: `<p>${body}</p>`,
  status: "open",
  replies,
  ...extra,
});

const pageComments = () => ({
  pageId: "10",
  lastSynced: "",
  footerComments: [comment("20001", "Looks <strong>good</strong>", [comment("20002", "Thanks")])],
  inlineComments: [comment("30001", "Please clarify", [], { textSelection: "important phrase", status: "resolved" })],
});

describe("links and comments of a page", () => {
  test("pageLinks: page references and links to this site's pages, not other links", () => {
    const storage =
      '<p><ac:link><ri:page ri:content-title="API Spec" ri:space-key="DOCS"/><ac:plain-text-link-body><![CDATA[the spec]]></ac:plain-text-link-body></ac:link>' +
      `<a href="${BASE}/spaces/DOC/pages/10002/API+Specification?focusedCommentId=20001&amp;x=1">a comment</a>` +
      `<a href="${BASE}/spaces/DOC/pages/10002/API+Specification?focusedCommentId=20001&amp;x=1">again</a>` +
      '<a href="https://example.com">elsewhere</a><a href="https://other.atlassian.net/wiki/spaces/X/pages/5">other site</a></p>';
    expect(pageLinks(storage, BASE)).toEqual([
      { label: "the spec", pageId: undefined, title: "API Spec", spaceKey: "DOCS" },
      { label: "a comment", pageId: "10002", commentId: "20001" },
    ]);
  });

  test("pageLinks: links relative to the site count too", () => {
    const storage = '<p><a href="/wiki/spaces/DOC/pages/10003/Rel?focusedCommentId=7&amp;y=1"><strong>relative</strong></a> <a href="/browse/AB-1">an issue</a></p>';
    expect(pageLinks(storage, BASE)).toEqual([{ label: "relative", pageId: "10003", commentId: "7" }]);
  });

  test("a page that is gone says so in words, other errors stay as they are", async () => {
    const { t } = wikiSetup({ getPageDetails: () => Promise.reject(new Error("Confluence API error (404): [response body omitted: logBody policy]")) });
    await loadPage(t.ctx, "999");
    expect(t.ctx.store.get().wiki.details["999"]).toEqual({ status: "error", error: "Page 999 was not found (deleted, or not visible to you)." });
  });

  test("commentThreads: footer threads first, replies in order, inline with its text", () => {
    const threads = commentThreads(pageComments() as never, (s) => s.replace(/<[^>]+>/g, ""));
    expect(threads).toEqual([
      {
        id: "20001",
        kind: "footer",
        resolved: false,
        comments: [
          { id: "20001", author: "Ann Lee", created: "2026-11-12T10:00:00.000Z", text: "Looks good", depth: 0 },
          { id: "20002", author: "Ann Lee", created: "2026-11-12T10:00:00.000Z", text: "Thanks", depth: 1 },
        ],
      },
      { id: "30001", kind: "inline", resolved: true, selection: "important phrase", comments: [expect.objectContaining({ id: "30001", depth: 0 })] },
    ]);
  });

  test("selectionContext: the line the commented text stands in", () => {
    expect(selectionContext("# Title\n\nThis carries an important phrase here.", "important phrase")).toBe("This carries an important phrase here.");
    expect(selectionContext("important phrase", "important phrase")).toBeUndefined();
    expect(selectionContext("Text", "gone")).toBeUndefined();
  });
});

describe("opening pages by URL and link", () => {
  const linked = '<p>See <ac:link><ri:page ri:content-title="API Spec"/></ac:link></p>';
  const nav = (extra: Record<string, (...args: never[]) => unknown> = {}) =>
    wikiSetup({
      getPageDetails: (id: string) => ({ ...page(id, 3, id === "10" ? linked : "<p>Spec</p>"), title: id === "10" ? "Page 10" : "API Spec" }),
      getAllComments: () => pageComments(),
      ...extra,
    });

  test("o opens a page URL: the page becomes the list, backspace returns to the list before", async () => {
    const { t } = nav();
    await loadSearch(t.ctx, "Recent", "type = page");
    await t.settle();
    press(t, "o");
    t.ctx.store.set((s) => ({ ...s, overlays: [{ ...(topOverlay(s) as Extract<typeof s.overlays[number], { kind: "prompt" }>), value: `${BASE}/spaces/DOC/pages/77/Other` }] }));
    press(t, "return");
    await t.settle();
    const w = t.ctx.store.get().wiki;
    expect(w.list).toMatchObject({ query: "page:77", items: [{ id: "77", title: "API Spec" }] });
    expect(w.details["77"]?.status).toBe("ok");
    expect(t.ctx.store.get().focus).toBe("detail");
    press(t, "backspace");
    expect(t.ctx.store.get().wiki.list).toMatchObject({ title: "Recent", query: "type = page", items: [{ id: "10" }] });
    expect(t.ctx.store.get().wiki.back).toEqual([]);
    // Opened again, the page is already loaded: its row still carries the title (live: it showed "Page 77").
    await openPage(t.ctx, { pageId: "77" });
    expect(t.ctx.store.get().wiki.list.items).toEqual([{ id: "77", title: "API Spec", spaceKey: "DOC", version: 3 }]);
  });

  test("a URL with focusedCommentId opens the comments with that comment focused", async () => {
    const { t } = nav();
    await openPage(t.ctx, { pageId: "10", commentId: "20002" });
    await t.settle();
    const w = t.ctx.store.get().wiki;
    expect(w.tab).toBe("comments");
    expect(w.focusedComment).toEqual({ pageId: "10", commentId: "20002" });
    expect(t.calls.find((c) => c.method === "getAllComments")?.args).toEqual(["10", { authorNames: true }]);
    expect(w.comments["10"]).toMatchObject({ status: "ok", value: [{ id: "20001" }, { id: "30001" }] });
  });

  test("a URL of another site is refused with a message, nothing is opened", async () => {
    const { t } = nav();
    press(t, "o");
    t.ctx.store.set((s) => ({ ...s, overlays: [{ ...(topOverlay(s) as Extract<typeof s.overlays[number], { kind: "prompt" }>), value: "https://other.atlassian.net/wiki/spaces/X/pages/5" }] }));
    press(t, "return");
    await t.settle();
    expect(t.toasts().at(-1)).toMatchObject({ kind: "error", text: expect.stringContaining("Not on this profile's Confluence site") });
    expect(t.ctx.store.get().wiki.back).toEqual([]);
  });

  test("f follows a link by title: the target is looked up in the page's space (not over the search index) and opened", async () => {
    const { t } = nav({ findPagesByTitle: () => [{ id: "42", title: "API Spec", spaceKey: "DOC" }] });
    await loadSearch(t.ctx, "Recent", "type = page");
    await t.settle();
    press(t, "f");
    const picker = topOverlay(t.ctx.store.get());
    expect(picker?.kind === "picker" && picker.items).toEqual([{ id: "0", label: "API Spec", hint: "API Spec" }]);
    const searches = t.calls.filter((c) => c.method === "searchPages").length;
    press(t, "return");
    await t.settle();
    expect(t.calls.find((c) => c.method === "findPagesByTitle")?.args).toEqual(["API Spec", { spaceKey: "DOC", limit: 1 }]);
    expect(t.calls.filter((c) => c.method === "searchPages")).toHaveLength(searches);
    expect(t.ctx.store.get().wiki.list.items).toEqual([expect.objectContaining({ id: "42" })]);
    expect(t.ctx.store.get().wiki.back).toHaveLength(1);
  });

  test("a link whose target is gone says so and stays on the page", async () => {
    const { t } = nav({ findPagesByTitle: () => [] });
    await loadSearch(t.ctx, "Recent", "type = page");
    await t.settle();
    press(t, "f", "return");
    await t.settle();
    expect(t.toasts().at(-1)?.text).toContain(`"API Spec" was not found in DOC`);
    expect(t.ctx.store.get().wiki.list.items[0]?.id).toBe("10");
  });

  test("the comments load when their tab shows, and reloading a page opened by link does not search", async () => {
    const { t } = nav();
    await openPage(t.ctx, { pageId: "10" });
    await t.settle();
    expect(t.calls.some((c) => c.method === "getAllComments")).toBe(false);
    press(t, ".");
    await t.settle();
    expect(t.ctx.store.get().wiki.tab).toBe("comments");
    expect(t.calls.filter((c) => c.method === "getAllComments")).toHaveLength(1);
    const searches = t.calls.filter((c) => c.method === "searchPages").length;
    await wiki.refresh(t.ctx);
    await t.settle();
    expect(t.calls.filter((c) => c.method === "searchPages")).toHaveLength(searches);
    expect(t.ctx.store.get().wiki.details["10"]?.status).toBe("ok");
    expect(t.calls.filter((c) => c.method === "getAllComments")).toHaveLength(2);
  });

  test("atlcli tui <page>: init shows the page, with the first list to go back to", async () => {
    const { t } = nav({ listSpaces: () => [] });
    (t.ctx.opts as { open?: string }).open = `${BASE}/x/LIA7Vw`;
    await wiki.init(t.ctx);
    await t.settle();
    expect(t.ctx.store.get().wiki.list.query).toBe("page:1463517228");
    expect(t.ctx.store.get().wiki.back).toHaveLength(1);
  });
});
