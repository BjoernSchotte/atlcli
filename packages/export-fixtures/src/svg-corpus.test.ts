/**
 * SVG policy conformance gate (spec 011). Runs every corpus case through the
 * REAL merged PDF asset pipeline (`preparePdfDocument` → the internal
 * `findSvgSafetyViolation` sanitizer) — no mocks. An unsafe SVG must be skipped
 * (`pdf-image-skipped`, not embedded); the safe baseline must embed.
 *
 * The DOCX side of this gate (006's shared `assertSafeSvg` via
 * `packages/docx/src/image.ts`) is intentionally NOT asserted here: package 006
 * (word-quality) runs in parallel and owns that module. When it lands, extend
 * this test to run every case through the DOCX path too and assert both engines
 * reach the identical verdict (011 DoD).
 */
import { describe, expect, it } from "bun:test";
import { preparePdfDocument, type PdfAssetResolver, type ExportBlock } from "@atlcli/pdf";
import { SVG_CORPUS, SVG_SAFE_BASELINE_ID } from "./svg-corpus.js";

function svgResolver(svg: string): PdfAssetResolver {
  return {
    async resolve() {
      return { bytes: new TextEncoder().encode(svg), mediaType: "image/svg+xml", filename: "figure.svg" };
    },
  };
}

async function prepareOne(svg: string): Promise<{ embedded: boolean; skipped: boolean }> {
  const blocks: ExportBlock[] = [
    { type: "image", source: { kind: "attachment", filename: "figure.svg" }, alt: "figure" },
  ];
  const prepared = await preparePdfDocument(blocks, svgResolver(svg));
  const embedded = prepared.assets.some((asset) => asset.mediaType === "image/svg+xml");
  const skipped = prepared.notes.some((note) => note.code === "pdf-image-skipped");
  return { embedded, skipped };
}

describe("SVG safety corpus — PDF engine (merged)", () => {
  it("embeds the safe baseline", async () => {
    const safe = SVG_CORPUS.find((c) => c.id === SVG_SAFE_BASELINE_ID)!;
    const { embedded, skipped } = await prepareOne(safe.svg);
    expect(embedded).toBe(true);
    expect(skipped).toBe(false);
  });

  for (const testCase of SVG_CORPUS.filter((c) => c.id !== SVG_SAFE_BASELINE_ID && c.category === "must-reject")) {
    it(`rejects ${testCase.id} (${testCase.note})`, async () => {
      const { embedded, skipped } = await prepareOne(testCase.svg);
      expect(embedded, `${testCase.id} must NOT embed`).toBe(false);
      expect(skipped, `${testCase.id} must emit pdf-image-skipped`).toBe(true);
    });
  }

  // Documented regex gaps — the forcing function for 006. Asserting the CURRENT
  // (accepted) verdict keeps the gate honest and green; when 006 closes a gap,
  // move the case to `must-reject` in svg-corpus.ts and this block shrinks.
  const pending = SVG_CORPUS.filter((c) => c.category === "pending-006");
  for (const testCase of pending) {
    it(`documents pending gap: ${testCase.id} (${testCase.note})`, async () => {
      const { embedded } = await prepareOne(testCase.svg);
      // Today's regex sanitizer accepts these. This assertion PINS the gap so a
      // silent regression (or an accidental fix) is visible in review.
      expect(embedded, `${testCase.id} is a known pending-006 gap`).toBe(true);
    });
  }
});
