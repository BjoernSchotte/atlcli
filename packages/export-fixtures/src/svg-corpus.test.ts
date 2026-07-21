/**
 * SVG policy conformance gate (spec 011). Two layers, no mocks:
 *
 *  1. The REAL merged PDF asset pipeline (`preparePdfDocument`) — proves the PDF
 *     engine actually wires the sanitizer: an unsafe SVG is skipped
 *     (`image-embed-failed`, not embedded); the safe baseline embeds.
 *
 *  2. 006's SHARED sanitizer (`assertSafeSvg(decodeSvgSource(bytes))` from
 *     `@atlcli/confluence`) — the exact function BOTH engines delegate to
 *     (`packages/pdf/src/prepare.ts:77` and `packages/docx/src/export.ts:1121`
 *     both call `assertSafeSvg(decodeSvgSource(bytes))`). Asserting the verdict
 *     on the shared function is the "two engines never diverge on a security
 *     verdict for the same input" gate (011 DoD): since both engines call this
 *     identical function on the identically-decoded bytes, one assertion covers
 *     both engines' verdicts. A full second DOCX-export path would only re-prove
 *     the same delegation at far higher fixture cost.
 */
import { describe, expect, it } from "bun:test";
import { assertSafeSvg, decodeSvgSource, SVG_UNSAFE_MESSAGE } from "@atlcli/confluence";
import { preparePdfDocument, type PdfAssetResolver, type ExportBlock } from "@atlcli/pdf";
import { SVG_CORPUS, SVG_SAFE_BASELINE_ID } from "./svg-corpus.js";

function svgResolver(bytes: Uint8Array): PdfAssetResolver {
  return {
    async resolve() {
      return { bytes, mediaType: "image/svg+xml", filename: "figure.svg" };
    },
  };
}

async function prepareOne(caseBytes: Uint8Array): Promise<{ embedded: boolean; skipped: boolean }> {
  const blocks: ExportBlock[] = [
    { type: "image", source: { kind: "attachment", filename: "figure.svg" }, alt: "figure" },
  ];
  const prepared = await preparePdfDocument(blocks, svgResolver(caseBytes));
  const embedded = prepared.assets.some((asset) => asset.mediaType === "image/svg+xml");
  const skipped = prepared.notes.some((note) => note.code === "image-embed-failed");
  return { embedded, skipped };
}

/** The exact bytes a case feeds: explicit `bytes`, else UTF-8 of `svg`. */
function caseBytes(testCase: { svg: string; bytes?: Uint8Array }): Uint8Array {
  return testCase.bytes ?? new TextEncoder().encode(testCase.svg);
}

const unsafeCases = SVG_CORPUS.filter((c) => c.id !== SVG_SAFE_BASELINE_ID && c.category === "must-reject");
const pendingCases = SVG_CORPUS.filter((c) => c.category === "pending-006");

describe("SVG safety corpus — PDF engine pipeline (merged)", () => {
  it("embeds the safe baseline", async () => {
    const safe = SVG_CORPUS.find((c) => c.id === SVG_SAFE_BASELINE_ID)!;
    const { embedded, skipped } = await prepareOne(caseBytes(safe));
    expect(embedded).toBe(true);
    expect(skipped).toBe(false);
  });

  for (const testCase of unsafeCases) {
    it(`rejects ${testCase.id} (${testCase.note})`, async () => {
      const { embedded, skipped } = await prepareOne(caseBytes(testCase));
      expect(embedded, `${testCase.id} must NOT embed`).toBe(false);
      expect(skipped, `${testCase.id} must emit image-embed-failed`).toBe(true);
    });
  }

  // 006 closed every prior gap (css-external-reference + BOM-aware decodeSvgSource),
  // so this list is currently EMPTY. If a future case is added that the shared
  // sanitizer cannot yet close, mark it `pending-006` and this loop pins the gap.
  for (const testCase of pendingCases) {
    it(`documents pending gap: ${testCase.id} (${testCase.note})`, async () => {
      const { embedded } = await prepareOne(caseBytes(testCase));
      expect(embedded, `${testCase.id} is a known pending gap`).toBe(true);
    });
  }
});

describe("SVG safety corpus — shared sanitizer (both engines delegate here)", () => {
  it("accepts the safe baseline", () => {
    const safe = SVG_CORPUS.find((c) => c.id === SVG_SAFE_BASELINE_ID)!;
    expect(() => assertSafeSvg(decodeSvgSource(caseBytes(safe)))).not.toThrow();
  });

  for (const testCase of unsafeCases) {
    it(`both engines reject ${testCase.id} via assertSafeSvg`, () => {
      // Validate the SAME BOM-aware-decoded string both engines embed — a
      // divergent decode is exactly the class of bug decodeSvgSource closes.
      expect(() => assertSafeSvg(decodeSvgSource(caseBytes(testCase)))).toThrow(SVG_UNSAFE_MESSAGE);
    });
  }
});
