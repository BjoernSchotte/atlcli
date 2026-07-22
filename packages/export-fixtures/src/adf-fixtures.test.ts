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
      "callout",
      "table",
      "paragraph",
      "callout",
      "unknown",
      "paragraph",
      "paragraph",
    ]);
    expect(pdf.notes.map((note) => note.code)).toContain("adf-media-unresolved");
  });
});
