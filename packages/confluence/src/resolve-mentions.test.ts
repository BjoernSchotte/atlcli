import { describe, expect, it } from "bun:test";
import type { ExportBlock } from "./export-blocks.js";
import { resolveExportMentions } from "./resolve-mentions.js";

const nestedBlocks: ExportBlock[] = [{
  type: "table",
  rows: [{ cells: [{
    header: false,
    colspan: 1,
    rowspan: 1,
    content: [{
      type: "list",
      ordered: false,
      items: [{ content: [{
        type: "callout",
        kind: "info",
        content: [{
          type: "paragraph",
          content: [
            { type: "mention", accountId: "a" },
            { type: "link", target: { kind: "external", href: "https://example.invalid" }, content: [
              { type: "mention", accountId: "a" },
              { type: "mention", accountId: "b", displayName: "Existing" },
              { type: "mention", accountId: "c" },
            ] },
          ],
        }],
      }] }],
    }],
  }] }],
}];

describe("resolveExportMentions", () => {
  it("resolves unique missing names throughout nested blocks without mutating input", async () => {
    const before = structuredClone(nestedBlocks);
    let requested: string[] = [];
    const result = await resolveExportMentions(nestedBlocks, async (accountIds) => {
      requested = accountIds;
      return new Map([["a", "Ada"], ["c", null]]);
    });

    expect(requested).toEqual(["a", "c"]);
    expect(result.unresolved).toBe(1);
    expect(JSON.stringify(result.blocks)).toContain('"displayName":"Ada"');
    expect(JSON.stringify(result.blocks)).toContain('"displayName":"Existing"');
    expect(nestedBlocks).toEqual(before);
  });

  it("does not call the lookup when no name is missing", async () => {
    let calls = 0;
    const blocks: ExportBlock[] = [{
      type: "paragraph",
      content: [{ type: "mention", accountId: "a", displayName: "Ada" }],
    }];
    const result = await resolveExportMentions(blocks, async () => {
      calls += 1;
      return new Map();
    });
    expect(calls).toBe(0);
    expect(result).toEqual({ blocks, unresolved: 0 });
  });

  it("treats blank lookup values as unresolved and retains identifiers", async () => {
    const blocks: ExportBlock[] = [{
      type: "paragraph",
      content: [
        { type: "mention", accountId: "a" },
        { type: "mention", accountId: "b" },
      ],
    }];
    const result = await resolveExportMentions(blocks, async () => new Map([["a", "   "]]));
    expect(result.unresolved).toBe(2);
    expect(result.blocks).toEqual(blocks);
  });

  it("propagates lookup failures", async () => {
    const blocks: ExportBlock[] = [{
      type: "paragraph",
      content: [{ type: "mention", accountId: "a" }],
    }];
    await expect(resolveExportMentions(blocks, async () => {
      throw new Error("lookup unavailable");
    })).rejects.toThrow("lookup unavailable");
  });

  it("resolves a mention nested inside an orientation region", async () => {
    const blocks: ExportBlock[] = [{
      type: "orientation",
      landscape: true,
      content: [{ type: "paragraph", content: [{ type: "mention", accountId: "a" }] }],
    }];
    let requested: string[] = [];
    const result = await resolveExportMentions(blocks, async (ids) => {
      requested = ids;
      return new Map([["a", "Ada"]]);
    });
    expect(requested).toEqual(["a"]);
    expect(result.unresolved).toBe(0);
    expect(JSON.stringify(result.blocks)).toContain('"displayName":"Ada"');
  });

  it("resolves a mention nested inside a page-layout column", async () => {
    const blocks: ExportBlock[] = [{
      type: "layout",
      columns: [{
        width: 100,
        content: [{ type: "paragraph", content: [{ type: "mention", accountId: "a" }] }],
      }],
    }];
    const result = await resolveExportMentions(
      blocks,
      async () => new Map([["a", "Ada"]]),
    );
    expect(result.unresolved).toBe(0);
    expect(result.blocks).toMatchObject([{
      type: "layout",
      columns: [{
        content: [{
          content: [{ type: "mention", accountId: "a", displayName: "Ada" }],
        }],
      }],
    }]);
  });

  it("resolves a mention inside a caption on codeBlock, image and table", async () => {
    const caption = (accountId: string) => ({
      kind: "figure" as const,
      content: [{ type: "mention" as const, accountId }],
    });
    const blocks: ExportBlock[] = [
      { type: "codeBlock", code: "x=1", caption: { ...caption("a"), kind: "code" } },
      { type: "image", source: { kind: "external", url: "https://x.test/i.png" }, caption: caption("b") },
      { type: "table", rows: [], caption: { ...caption("c"), kind: "table" } },
    ];
    let requested: string[] = [];
    const result = await resolveExportMentions(blocks, async (ids) => {
      requested = ids;
      return new Map([["a", "Ada"], ["b", "Bo"], ["c", "Cy"]]);
    });
    expect(requested.sort()).toEqual(["a", "b", "c"]);
    expect(result.unresolved).toBe(0);
    const json = JSON.stringify(result.blocks);
    expect(json).toContain('"displayName":"Ada"');
    expect(json).toContain('"displayName":"Bo"');
    expect(json).toContain('"displayName":"Cy"');
  });

  it("traverses unknown.body — spec 004 renders it, so mentions must resolve", async () => {
    const blocks: ExportBlock[] = [{
      type: "unknown",
      macroName: "drawio",
      body: [{ type: "paragraph", content: [{ type: "mention", accountId: "a" }] }],
    }];
    let calls = 0;
    const result = await resolveExportMentions(blocks, async () => {
      calls += 1;
      return new Map([["a", "Ada"]]);
    });
    // The mention buried in unknown.body IS collected and resolved now that the
    // placeholder floor makes the body visible.
    expect(calls).toBe(1);
    expect(result.unresolved).toBe(0);
    expect(JSON.stringify(result.blocks)).toContain('"displayName":"Ada"');
  });

  it("leaves a bare unknown block (no body) untouched", async () => {
    const blocks: ExportBlock[] = [{ type: "unknown", macroName: "drawio" }];
    const result = await resolveExportMentions(blocks, async () => new Map());
    expect(result).toEqual({ blocks, unresolved: 0 });
  });
});
