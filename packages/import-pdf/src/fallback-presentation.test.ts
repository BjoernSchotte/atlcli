import { describe, expect, it } from "bun:test";
import { IMPORT_DOCUMENT_SCHEMA_V2, documentToAdf, documentToStorage, type ImportDocumentV2 } from "@atlcli/import-core";
import { applyPdfFallbackPresentation } from "./fallback-presentation.js";

function fixture(): ImportDocumentV2 {
  return {
    schema: IMPORT_DOCUMENT_SCHEMA_V2,
    sourceKind: "pdf",
    blocks: [
      { id: "body", type: "paragraph", runs: [{ kind: "text", text: "Editable body" }] },
      {
        id: "region",
        type: "image",
        assetId: "asset:region",
        presentation: "region-fallback",
        sourceRefs: ["pdf:p0:region"],
      },
      {
        id: "page",
        type: "image",
        assetId: "asset:page",
        presentation: "page-fallback",
        captionBlockId: "page-caption",
        sourceRefs: ["pdf:p0"],
      },
      {
        id: "page-caption",
        type: "paragraph",
        runs: [{ kind: "text", text: "Original visual view of source page 1." }],
        sourceRefs: ["pdf:p0"],
      },
    ],
    assets: [
      { id: "asset:region", fileName: "region.png", mediaType: "image/png", bytes: new Uint8Array([1]) },
      { id: "asset:page", fileName: "page.png", mediaType: "image/png", bytes: new Uint8Array([2]) },
    ],
    issues: [],
  };
}

describe("PDF fallback presentation", () => {
  it("keeps explicit inline presentation unchanged", () => {
    const input = fixture();
    expect(applyPdfFallbackPresentation(input, "inline")).toBe(input);
  });

  it("collapses only full-page fallbacks and maps them to Cloud and DC expand nodes", () => {
    const result = applyPdfFallbackPresentation(fixture(), "collapsed");
    expect(result.blocks.map((block) => block.type)).toEqual(["paragraph", "image", "disclosure"]);
    expect(result.blocks[1]).toMatchObject({ type: "image", presentation: "region-fallback" });
    expect(result.blocks[2]).toMatchObject({
      type: "disclosure",
      title: "Original visual view — source page 1",
      blocks: [{ type: "image", presentation: "page-fallback" }, { type: "paragraph" }],
    });
    const adf = documentToAdf(result);
    expect(adf.content.at(-1)).toMatchObject({ type: "expand", attrs: { title: "Original visual view — source page 1" } });
    const storage = documentToStorage(result);
    expect(storage).toContain('<ac:structured-macro ac:name="expand">');
    expect(storage).toContain("Original visual view — source page 1");
  });

  it("moves full-page fallbacks into a final appendix while regions stay inline", () => {
    const result = applyPdfFallbackPresentation(fixture(), "appendix");
    expect(result.blocks.map((block) => block.type)).toEqual([
      "paragraph", "image", "heading", "disclosure",
    ]);
    expect(result.blocks[2]).toMatchObject({ type: "heading", level: 2 });
    expect(JSON.stringify(result.blocks[2])).toContain("Original visual views");
  });
});
