import { describe, expect, test } from "bun:test";
import { storageToBlocks, extractMacroBody } from "@atlcli/confluence";
import type { MacroParameter } from "@atlcli/confluence";
import { multiexcerptIncludeRenderer } from "./multiexcerpt.js";
import { scrollTableLayoutRenderer } from "./table-layout.js";
import { portError } from "./types.js";
import type { ConfluenceContentPort, MacroExportContext } from "./types.js";

function param(name: string, text: string): MacroParameter {
  return { name, text };
}

function ctx(confluence: ConfluenceContentPort, overrides: Partial<MacroExportContext> = {}): MacroExportContext {
  return {
    page: { id: "root", spaceKey: "DOCSY" },
    depth: 0,
    visited: new Set(),
    confluence,
    ...overrides,
  };
}

/** In-memory content port backed by a title→storage map. */
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

const excerptStorage = `<ac:structured-macro ac:name="multiexcerpt-macro">
  <ac:parameter ac:name="MultiExcerptName">intro</ac:parameter>
  <ac:rich-text-body><p>Reusable intro text</p></ac:rich-text-body>
</ac:structured-macro>`;

describe("multiexcerptIncludeRenderer", () => {
  test("happy path (PageWithExcerpt / MultiExcerptName spelling)", async () => {
    const c = port({ Glossary: { id: "g1", storage: excerptStorage } });
    const res = await multiexcerptIncludeRenderer({ storageToBlocks, extractMacroBody }).render(
      { name: "multiexcerpt-include", params: [param("PageWithExcerpt", "Glossary"), param("MultiExcerptName", "intro")] },
      ctx(c)
    );
    expect(res.kind).toBe("blocks");
    if (res.kind === "blocks") {
      expect(res.blocks[0]).toMatchObject({ type: "paragraph" });
    }
  });

  test("accepts the legacy page / name spelling too", async () => {
    const c = port({ Glossary: { id: "g1", storage: excerptStorage } });
    const res = await multiexcerptIncludeRenderer({ storageToBlocks, extractMacroBody }).render(
      { name: "multiexcerpt-include", params: [param("page", "Glossary"), param("name", "intro")] },
      ctx(c)
    );
    expect(res.kind).toBe("blocks");
  });

  test("missing page → skip + note", async () => {
    const c = port({});
    const res = await multiexcerptIncludeRenderer({ storageToBlocks, extractMacroBody }).render(
      { name: "multiexcerpt-include", params: [param("page", "Nope"), param("name", "intro")] },
      ctx(c)
    );
    expect(res.kind).toBe("skip");
    if (res.kind === "skip") expect(res.notes?.[0].code).toBe("macro-degraded");
  });

  test("cycle guard fires with a note and terminates", async () => {
    const c = port({ Glossary: { id: "g1", storage: excerptStorage } });
    const visited = new Set<string>(["Glossary#intro"]);
    const res = await multiexcerptIncludeRenderer({ storageToBlocks, extractMacroBody }).render(
      { name: "multiexcerpt-include", params: [param("page", "Glossary"), param("name", "intro")] },
      ctx(c, { visited })
    );
    expect(res.kind).toBe("skip");
  });

  test("permission error → skip + note (not abort)", async () => {
    const c: ConfluenceContentPort = {
      async getPageStorage() {
        throw portError("permission", "forbidden", { service: "confluence" });
      },
      async getChildren() {
        return [];
      },
      async searchCql() {
        return [];
      },
    };
    const res = await multiexcerptIncludeRenderer({ storageToBlocks, extractMacroBody }).render(
      { name: "multiexcerpt-include", params: [param("page", "Glossary"), param("name", "intro")] },
      ctx(c)
    );
    expect(res.kind).toBe("skip");
    if (res.kind === "skip") expect(res.notes?.[0].code).toBe("macro-degraded");
  });
});

describe("scrollTableLayoutRenderer", () => {
  const tableBody = storageToBlocks(
    `<table><tbody><tr><td>a</td><td>b</td></tr></tbody></table>`
  ).blocks;

  test("width parsing applies columnWidths to top-level tables", async () => {
    const res = await scrollTableLayoutRenderer().render(
      { name: "scroll-tablelayout", params: [param("widths", "100,200")], body: tableBody },
      ctx(port({}))
    );
    if (res.kind === "blocks") {
      const table = res.blocks.find((b) => b.type === "table") as { columnWidths?: number[] };
      expect(table.columnWidths).toEqual([100, 200]);
    } else {
      throw new Error("expected blocks");
    }
  });

  test("non-table content passed through unchanged", async () => {
    const body = storageToBlocks(`<p>hi</p>`).blocks;
    const res = await scrollTableLayoutRenderer().render(
      { name: "scroll-tablelayout", params: [], body },
      ctx(port({}))
    );
    if (res.kind === "blocks") expect(res.blocks).toEqual(body);
  });

  test("missing body → skip", async () => {
    const res = await scrollTableLayoutRenderer().render(
      { name: "scroll-tablelayout", params: [] },
      ctx(port({}))
    );
    expect(res.kind).toBe("skip");
  });
});
