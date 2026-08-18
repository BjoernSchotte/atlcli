import { describe, expect, it } from "bun:test";
import { IMPORT_DOCUMENT_SCHEMA_V2, type ImportDocumentV2 } from "@atlcli/import-core";
import { applyPdfImportOverrides, parsePdfImportOverrides } from "./overrides.js";
import { isPdfImportError } from "./issues.js";

const digest = "a".repeat(64);
const document: ImportDocumentV2 = {
  schema: IMPORT_DOCUMENT_SCHEMA_V2,
  sourceKind: "pdf",
  blocks: [
    { id: "pdf:p0:heading", type: "heading", level: 2, runs: [{ kind: "text", text: "Selected title" }], sourceRefs: ["pdf:p0:h"] },
    { id: "pdf:p0:image", type: "image", assetId: "asset", sourceRefs: ["pdf:p0:figure"] },
    { id: "pdf:p0:paragraph", type: "paragraph", runs: [{ kind: "text", text: "Body" }], sourceRefs: ["pdf:p0:p"] },
  ],
  assets: [{ id: "asset", fileName: "figure.png", mediaType: "image/png", bytes: new Uint8Array([1]) }],
  issues: [],
};

async function expectInvalid(text: string): Promise<void> {
  try {
    await parsePdfImportOverrides(text, digest);
    throw new Error("expected invalid override");
  } catch (error) {
    expect(isPdfImportError(error)).toBe(true);
    if (isPdfImportError(error)) expect(error.code).toBe("pdf/override-invalid");
  }
}

describe("PDF import overrides", () => {
  it("applies only digest-bound semantic decisions and remains deterministic", async () => {
    const text = `schema: atlcli.pdf-import-overrides/1
sourceSha256: ${digest}
operations:
  - kind: set-heading-level
    sourceId: pdf:p0:h
    level: 1
  - kind: set-figure-alt
    sourceId: pdf:p0:figure
    alt: A neutral diagram
  - kind: set-title-from
    sourceId: pdf:p0:h
  - kind: move-before
    sourceId: pdf:p0:p
    beforeSourceId: pdf:p0:figure
`;
    const parsed = await parsePdfImportOverrides(text, digest);
    const first = await applyPdfImportOverrides(document, parsed);
    const second = await applyPdfImportOverrides(document, parsed);
    expect(first.digest).toBe(second.digest);
    expect(first.titleCandidate).toBe("Selected title");
    expect(first.document.blocks.map((block) => block.id)).toEqual([
      "pdf:p0:heading",
      "pdf:p0:paragraph",
      "pdf:p0:image",
    ]);
    expect(first.document.blocks[0]).toMatchObject({ type: "heading", level: 1 });
    expect(first.document.blocks[2]).toMatchObject({ type: "image", alt: "A neutral diagram" });
  });

  it("rejects stale digests, unknown fields, duplicate keys, aliases, unsafe text, and stale ids", async () => {
    await expectInvalid(`schema: atlcli.pdf-import-overrides/1\nsourceSha256: ${"b".repeat(64)}\noperations: []\n`);
    await expectInvalid(`schema: atlcli.pdf-import-overrides/1\nsourceSha256: ${digest}\nhtml: x\noperations: []\n`);
    await expectInvalid(`schema: atlcli.pdf-import-overrides/1\nsourceSha256: ${digest}\nsourceSha256: ${digest}\noperations: []\n`);
    await expectInvalid(`schema: atlcli.pdf-import-overrides/1\nsourceSha256: ${digest}\noperations: &ops []\ncopy: *ops\n`);
    await expectInvalid(`schema: atlcli.pdf-import-overrides/1\nsourceSha256: ${digest}\noperations:\n  - kind: set-figure-alt\n    sourceId: pdf:p0:figure\n    alt: "bad\\u0000text"\n`);
    const parsed = await parsePdfImportOverrides(
      `schema: atlcli.pdf-import-overrides/1\nsourceSha256: ${digest}\noperations:\n  - kind: set-title-from\n    sourceId: pdf:p9:missing\n`,
      digest,
    );
    await expect(applyPdfImportOverrides(document, parsed)).rejects.toThrow("stale or unknown");
  });
});
