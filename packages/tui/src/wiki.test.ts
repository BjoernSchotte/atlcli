import { describe, expect, test } from "bun:test";
import { handleKey } from "./app.js";
import { topOverlay } from "./state.js";
import { commands, setup, type TestSetup } from "./testing.js";
import { editBlockReason, loadPage, loadSearch, parentSearchCql, readablePage, searchCql, wiki } from "./wiki.js";

const press = (t: TestSetup, ...keys: string[]) => {
  for (const key of keys) {
    const named = ["return", "escape", "tab", "space", "up", "down"].includes(key);
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
    expect(d?.status === "ok" && d.value).toMatchObject({ markdown: "Hello **world**", labels: ["a"], version: 3 });
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

  test("a failed page load shows its error", async () => {
    const { t } = wikiSetup({ getPage: () => Promise.reject(new Error("403 Forbidden")) });
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
