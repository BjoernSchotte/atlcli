import { describe, expect, test } from "bun:test";
import { storageToBlocks, extractMacroBody } from "@atlcli/confluence";
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
    const res = await excerptIncludeRenderer({ storageToBlocks, extractMacroBody }).render(
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

describe("ac:link-wrapped page ref end-to-end (e2e-observed storage shape)", () => {
  test("excerpt-include whose ref sits inside <ac:link> resolves through the walker + renderer", async () => {
    // Walk the REAL Cloud storage shape (page ref wrapped in ac:link under the
    // unnamed parameter) so the renderer sees exactly what production sees.
    const pageStorage = `<ac:structured-macro ac:name="excerpt-include" ac:macro-id="x1">
      <ac:parameter ac:name=""><ac:link><ri:page ri:content-title="Source" ri:space-key="DOCSY"/></ac:link></ac:parameter>
    </ac:structured-macro>`;
    const walked = storageToBlocks(pageStorage);
    const unknown = walked.blocks.find((b) => b.type === "unknown");
    if (unknown?.type !== "unknown") throw new Error("expected unknown block");

    const sourceStorage = `<ac:structured-macro ac:name="excerpt"><ac:rich-text-body><p>Shared excerpt text</p></ac:rich-text-body></ac:structured-macro>`;
    const c = port({ Source: { id: "s1", storage: sourceStorage } });

    const res = await excerptIncludeRenderer({ storageToBlocks, extractMacroBody }).render(
      { name: "excerpt-include", params: unknown.params ?? [] },
      ctx(c)
    );
    expect(res.kind).toBe("blocks");
    if (res.kind === "blocks") {
      expect(JSON.stringify(res.blocks)).toContain("Shared excerpt text");
    }
  });
});

describe("recursion guard", () => {
  test("the same page included twice in one export is expanded both times", async () => {
    const c = port({ A: { id: "a1", storage: "<p>A</p>" } });
    const shared = ctx(c);
    const include = includeRenderer({ storageToBlocks });
    const macro = { name: "include", params: [pageRefParam("A")] };
    expect((await include.render(macro, shared)).kind).toBe("blocks");
    expect((await include.render(macro, shared)).kind).toBe("blocks");

    const excerpts = port({
      Source: {
        id: "s1",
        storage:
          '<ac:structured-macro ac:name="multiexcerpt-macro"><ac:parameter ac:name="MultiExcerptName">intro</ac:parameter><ac:rich-text-body><p>Shared</p></ac:rich-text-body></ac:structured-macro>',
      },
    });
    const sharedExcerpts = ctx(excerpts);
    const multi = multiexcerptIncludeRenderer({ storageToBlocks, extractMacroBody });
    const multiMacro = {
      name: "multiexcerpt-include-macro",
      params: [
        { name: "PageWithExcerpt", text: "Source" },
        { name: "MultiExcerptName", text: "intro" },
      ],
    };
    expect((await multi.render(multiMacro, sharedExcerpts)).kind).toBe("blocks");
    expect((await multi.render(multiMacro, sharedExcerpts)).kind).toBe("blocks");
  });

  test("a page already on the include chain (host-supplied visited) is not expanded", async () => {
    const c = port({ A: { id: "a1", storage: "<p>A</p>" } });
    const res = await includeRenderer({ storageToBlocks }).render(
      { name: "include", params: [pageRefParam("A")] },
      ctx(c, { visited: new Set([":A#"]) })
    );
    expect(res.kind).toBe("skip");
  });
});
