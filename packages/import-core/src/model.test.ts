import { describe, expect, it } from "bun:test";
import {
  IMPORT_DOCUMENT_SCHEMA_V2,
  buildImportPreview,
  canonicalJson,
  documentToAdf,
  documentToStorage,
  importReferenceKey,
  storageTagSequence,
  type ImportDocumentV2,
} from "./index.js";

function fixture(): ImportDocumentV2 {
  return {
    schema: IMPORT_DOCUMENT_SCHEMA_V2,
    sourceKind: "pdf",
    blocks: [
      {
        id: "block:heading",
        sourceRefs: ["source:heading"],
        type: "heading",
        level: 1,
        runs: [{ kind: "text", text: "Neutral report" }],
      },
      {
        id: "block:table",
        type: "table",
        rows: [{
          cells: [{
            id: "cell:1",
            sourceRefs: ["source:cell"],
            header: true,
            rowspan: 2,
            colspan: 3,
            blocks: [{
              id: "block:cell-text",
              type: "paragraph",
              runs: [{ kind: "text", text: "Spanning header" }],
            }],
          }],
        }],
      },
      {
        id: "block:break",
        type: "page-break",
        sourcePageIndex: 1,
        pageBoundaryBefore: true,
      },
      {
        id: "block:figure",
        type: "image",
        assetId: "asset:figure",
        presentation: "region-fallback",
        captionBlockId: "block:caption",
        alt: "Neutral green square",
      },
      {
        id: "block:disclosure",
        type: "disclosure",
        title: "Original view",
        blocks: [{
          id: "block:caption",
          type: "paragraph",
          runs: [{
            kind: "text",
            text: "Reference",
            marks: { reference: { namespace: "fixture", target: "section-1" } },
          }],
        }],
      },
    ],
    assets: [{
      id: "asset:figure",
      sourceRefs: ["source:figure"],
      fileName: "neutral.png",
      mediaType: "image/png",
      bytes: new Uint8Array([1, 2, 3]),
    }],
    issues: [{
      code: "fixture/attached",
      severity: "warning",
      outcome: "attached",
      message: "A neutral region uses an image fallback.",
      sourceRefs: ["source:figure"],
    }],
  };
}

describe("ImportDocumentV2 target projections", () => {
  it("maps spans and media, ignores page hints, and keeps evidence out of ADF", () => {
    const document = fixture();
    const references = new Map([[
      importReferenceKey({ namespace: "fixture", target: "section-1" }),
      "https://example.com/neutral#section-1",
    ]]);
    const adf = documentToAdf(document, { references });
    expect(adf.content.map((node) => node.type)).toEqual(["heading", "table", "mediaSingle", "expand"]);
    expect(adf.content[1]?.content?.[0]?.content?.[0]?.attrs).toEqual({ rowspan: 2, colspan: 3 });
    expect(JSON.stringify(adf)).not.toContain("source:figure");
    expect(JSON.stringify(adf)).toContain("https://example.com/neutral#section-1");
    expect(adf.content[3]).toMatchObject({ type: "expand", attrs: { title: "Original view" } });
  });

  it("maps spans and exact asset filenames to independent Storage output", () => {
    const storage = documentToStorage(fixture());
    expect(storage).toContain('<th rowspan="2" colspan="3"><p>Spanning header</p></th>');
    expect(storage).toContain('ri:filename="neutral.png"');
    expect(storage).toContain('<ac:structured-macro ac:name="expand"><ac:parameter ac:name="title">Original view</ac:parameter>');
    expect(storage).not.toContain("source:figure");
    expect(storageTagSequence(storage)).toEqual(["h1", "table", "p", "ac:image", "ac:structured-macro", "p"]);
  });

  it("previews deterministically without serializing source evidence", async () => {
    const first = await buildImportPreview(fixture(), { spaceKey: "DOCSY", title: "Neutral" });
    const second = await buildImportPreview(fixture(), { spaceKey: "DOCSY", title: "Neutral" });
    expect(first.adfDigest).toBe(second.adfDigest);
    expect(first.counts["page-break"]).toBe(1);
    expect(first.issues[0]?.outcome).toBe("attached");
  });

  it("canonicalizes nested keys independently of insertion order", () => {
    expect(canonicalJson({ z: 1, a: { z: 2, a: 3 } })).toBe('{"a":{"a":3,"z":2},"z":1}');
  });
});
