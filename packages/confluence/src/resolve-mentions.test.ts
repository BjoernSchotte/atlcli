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
});
