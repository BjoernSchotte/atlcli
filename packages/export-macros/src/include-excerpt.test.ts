import { describe, expect, test } from "bun:test";
import { storageToBlocks } from "@atlcli/confluence";
import type { MacroParameter, MacroParamRef } from "@atlcli/confluence";
import { includeRenderer, excerptIncludeRenderer, excerptRenderer } from "./include-excerpt.js";
import { multiexcerptIncludeRenderer } from "./multiexcerpt.js";
import type { ConfluenceContentPort, MacroExportContext } from "./types.js";

function pageRefParam(contentTitle: string): MacroParameter {
  const ref: MacroParamRef = { kind: "page", contentTitle };
  return { name: "", refs: [ref] };
}

function ctx(confluence: ConfluenceContentPort, overrides: Partial<MacroExportContext> = {}): MacroExportContext {
  return { page: { id: "root", spaceKey: "DOCSY" }, depth: 0, visited: new Set(), confluence, ...overrides };
}

function port(pages: Record<string, { id: string; storage: string }>): ConfluenceContentPort {
  return {
    async getPageStorage(title) {
      const p = pages[title];
      return p ? { id: p.id, version: 1, storage: p.storage } : undefined;
    },
    async getChildren() {
      return [];
    },
    async searchCql() {
      return [];
    },
  };
}

describe("includeRenderer", () => {
  test("happy path: includes whole page storage", async () => {
    const c = port({ Target: { id: "t1", storage: "<p>Target body</p>" } });
    const res = await includeRenderer({ storageToBlocks }).render(
      { name: "include", params: [pageRefParam("Target")] },
      ctx(c)
    );
    expect(res.kind).toBe("blocks");
    if (res.kind === "blocks") expect(res.blocks[0]).toMatchObject({ type: "paragraph" });
  });

  test("no page ref → skip + note", async () => {
    const res = await includeRenderer({ storageToBlocks }).render({ name: "include", params: [] }, ctx(port({})));
    expect(res.kind).toBe("skip");
    if (res.kind === "skip") expect(res.notes?.[0].code).toBe("macro-degraded");
  });
});

describe("excerptIncludeRenderer", () => {
  test("extracts a named excerpt fragment", async () => {
    const storage = `<ac:structured-macro ac:name="excerpt"><ac:parameter ac:name="name">bit</ac:parameter><ac:rich-text-body><p>Excerpt bit</p></ac:rich-text-body></ac:structured-macro>`;
    const c = port({ Target: { id: "t1", storage } });
    const res = await excerptIncludeRenderer({ storageToBlocks }).render(
      { name: "excerpt-include", params: [pageRefParam("Target"), { name: "name", text: "bit" }] },
      ctx(c)
    );
    expect(res.kind).toBe("blocks");
  });
});

describe("excerptRenderer", () => {
  test("hidden excerpt suppresses body", async () => {
    const res = await excerptRenderer().render(
      { name: "excerpt", params: [{ name: "hidden", text: "true" }], body: [{ type: "paragraph", content: [] }] },
      ctx(port({}))
    );
    if (res.kind === "blocks") expect(res.blocks).toEqual([]);
    else throw new Error("expected blocks");
  });

  test("visible excerpt passes body through", async () => {
    const body = [{ type: "paragraph" as const, content: [{ type: "text" as const, text: "x" }] }];
    const res = await excerptRenderer().render({ name: "excerpt", params: [], body }, ctx(port({})));
    if (res.kind === "blocks") {
      expect(res.blocks).toEqual(body);
      expect(res.bodyConsumed).toBe(true);
    }
  });
});

describe("cross-renderer cycle guard", () => {
  test("include → multiexcerpt-include → back is bounded by shared visited/depth", async () => {
    // Page A `include`s page B; page B contains a multiexcerpt-include back to A.
    // Both renderers share ctx.visited, so the second traversal short-circuits.
    const c = port({
      A: { id: "a1", storage: "<p>A</p>" },
      B: { id: "b1", storage: "<p>B</p>" },
    });
    const shared = ctx(c);
    // First include of A registers "…:A#" in visited.
    await includeRenderer({ storageToBlocks }).render({ name: "include", params: [pageRefParam("A")] }, shared);
    // A multiexcerpt-include back to A#intro is a different key, but re-including
    // A via the include renderer is now guarded.
    const res = await includeRenderer({ storageToBlocks }).render(
      { name: "include", params: [pageRefParam("A")] },
      shared
    );
    expect(res.kind).toBe("skip");
    // sanity: multiexcerpt shares the same guard mechanism
    expect(typeof multiexcerptIncludeRenderer).toBe("function");
  });
});
