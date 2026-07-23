import { describe, expect, it } from "bun:test";
import { ADF_CONFORMANCE_SOURCE, adfConformanceBlocks } from "./index.js";

describe("ADF browser conformance fixture", () => {
  it("starts from ADF and decodes identically for both target renderers", () => {
    expect(JSON.parse(ADF_CONFORMANCE_SOURCE)).toMatchObject({ version: 1, type: "doc" });
    const pdf = adfConformanceBlocks("pdf");
    const word = adfConformanceBlocks("word");

    expect(pdf.representation).toBe("atlas_doc_format");
    expect(word.representation).toBe("atlas_doc_format");
    expect(pdf.blocks).toEqual(word.blocks);
    expect(pdf.notes).toEqual(word.notes);
    expect(pdf.blocks.map((block) => block.type)).toEqual([
      "heading",
      "paragraph",
      "paragraph",
      "paragraph",
      "callout",
      "list",
      "table",
      "paragraph",
      "callout",
      "unknown",
      "paragraph",
      "paragraph",
    ]);
    expect(pdf.blocks[5]).toMatchObject({
      type: "list",
      ordered: true,
      start: 3,
      items: [{ content: [
        { type: "paragraph" },
        { type: "list", ordered: true, start: 8 },
      ] }],
    });
    expect(pdf.blocks[2]).toMatchObject({
      type: "paragraph",
      presentation: { alignment: "center", fontSize: "small" },
    });
    expect(pdf.blocks[3]).toMatchObject({
      type: "paragraph",
      presentation: { indentation: 2 },
    });
    expect(pdf.notes.map((note) => note.code)).toContain("adf-media-unresolved");
  });
});
