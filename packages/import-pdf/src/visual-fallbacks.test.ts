import { describe, expect, it } from "bun:test";
import { sha256Hex } from "@atlcli/core";
import { IMPORT_DOCUMENT_SCHEMA_V2, type ImportDocumentV2 } from "@atlcli/import-core";
import {
  PDF_ASSET_MATERIALIZER_REVISION,
  type PdfDecisionEvidenceV1,
  type PdfDecisionEvidenceV2,
  type PdfFactsAdapter,
  type PdfFactsAdapterV2,
} from "./contracts.js";
import { encodeRgbaPng } from "./fallbacks.js";
import type { PdfPageFallbackAssessmentV1 } from "./fallback-policy.js";
import {
  materializePdfVisualFallbacks,
  materializePdfVisualFallbacksV2,
  pdfVisualFallbackRegions,
} from "./visual-fallbacks.js";

function evidence(sourceId: string, targetNodeId: string, y: number): PdfDecisionEvidenceV1 {
  return {
    sourceId,
    targetNodeId,
    locator: { pageIndex: 0, bbox: { x: 0.1, y, width: 0.5, height: 0.05 } },
    basis: ["text-geometry"],
    confidence: 1,
    decisionCode: "pdf/tagged-paragraph-native",
    outcome: "native",
    analyzerRevision: "atlcli.pdf-tagged-policy/1",
  };
}

async function adapter(): Promise<PdfFactsAdapter> {
  const png = encodeRgbaPng(2, 2, new Uint8Array(16).fill(120));
  const digest = await sha256Hex(png);
  return {
    analyze: () => Promise.reject(new Error("not used")),
    materialize: async (_source, requests) => requests.map((request) => ({
      requestId: request.id,
      pageIndex: request.pageIndex,
      sourceKind: "rendered-region" as const,
      mediaType: "image/png" as const,
      width: 2,
      height: 2,
      bytes: png,
      sha256: digest,
      materializerRevision: PDF_ASSET_MATERIALIZER_REVISION,
    })),
  };
}

async function adapterV2(): Promise<PdfFactsAdapterV2> {
  const png = encodeRgbaPng(2, 2, new Uint8Array(16).fill(120));
  const digest = await sha256Hex(png);
  return {
    analyze: () => Promise.reject(new Error("not used")),
    materialize: async (_source, requests) => requests.map((request) => ({
      requestId: request.id,
      pageIndex: request.pageIndex,
      sourceKind: "rendered-region" as const,
      mediaType: "image/png" as const,
      width: 2,
      height: 2,
      bytes: png,
      sha256: digest,
      materializerRevision: PDF_ASSET_MATERIALIZER_REVISION,
    })),
  };
}

function evidenceV2(sourceId: string, targetNodeId: string, y: number): PdfDecisionEvidenceV2 {
  return {
    ...evidence(sourceId, targetNodeId, y),
    boundaryDecisionIds: [],
    analyzerRevision: "atlcli.pdf-tagged-policy/2",
  };
}

function document(): ImportDocumentV2 {
  return {
    schema: IMPORT_DOCUMENT_SCHEMA_V2,
    sourceKind: "pdf",
    blocks: [
      { id: "block:before", type: "paragraph", runs: [{ kind: "text", text: "Before" }], sourceRefs: ["source:before"] },
      { id: "block:after", type: "paragraph", runs: [{ kind: "text", text: "After" }], sourceRefs: ["source:after"] },
    ],
    assets: [],
    issues: [{
      code: "pdf-import/tagged-node-demoted",
      severity: "warning",
      outcome: "reported",
      message: "Neutral localized gap.",
      sourceRefs: ["source:gap-a"],
      context: { pageIndex: 0 },
    }],
  };
}

function regionAssessment(): PdfPageFallbackAssessmentV1 {
  return {
    pageIndex: 0,
    scope: "region",
    reasonCodes: ["localized-tag-corruption"],
    claimedCharacterCount: 10,
    unclaimedCharacterCount: 0,
    regionLocators: [
      { pageIndex: 0, structurePath: "source:gap-a", bbox: { x: 0.2, y: 0.3, width: 0.2, height: 0.1 } },
      { pageIndex: 0, structurePath: "source:gap-b", bbox: { x: 0.39, y: 0.35, width: 0.2, height: 0.1 } },
    ],
  };
}

describe("PDF visual fallback materialization", () => {
  it("merges touching evidence boxes with a bounded margin", () => {
    const region = pdfVisualFallbackRegions(regionAssessment())[0]!;
    expect(region.x).toBeCloseTo(0.192);
    expect(region.y).toBeCloseTo(0.292);
    expect(region.width).toBeCloseTo(0.406);
    expect(region.height).toBeCloseTo(0.166);
  });

  it("inserts a labeled region image in source order and closes its issue", async () => {
    const baseEvidence = [
      evidence("source:before", "block:before", 0.1),
      evidence("source:after", "block:after", 0.8),
    ];
    const result = await materializePdfVisualFallbacks(
      new Uint8Array([1, 2, 3]),
      await adapter(),
      document(),
      baseEvidence,
      [regionAssessment()],
    );
    expect(result.document.blocks.map((block) => block.type)).toEqual([
      "paragraph", "image", "paragraph", "paragraph",
    ]);
    expect(result.document.blocks[1]).toMatchObject({
      type: "image",
      presentation: "region-fallback",
      alt: "Visual fallback for source page 1, region 1.",
    });
    expect(result.document.blocks[2]).toMatchObject({ type: "paragraph" });
    expect(JSON.stringify(result.document.blocks[2])).toContain("Visual fallback for source page 1, region 1.");
    expect(result.document.issues[0]?.outcome).toBe("attached");
    expect(result.evidence.at(-1)).toMatchObject({
      decisionCode: "pdf/region-image-fallback-attached",
      analyzerRevision: "atlcli.pdf-visual-fallback-policy/1",
    });
  });

  it("attaches fallback evidence without leaving the V2 contract", async () => {
    const result = await materializePdfVisualFallbacksV2(
      new Uint8Array([1, 2, 3]),
      await adapterV2(),
      document(),
      [evidenceV2("source:before", "block:before", 0.1), evidenceV2("source:after", "block:after", 0.8)],
      [regionAssessment()],
    );

    expect(result.evidence.every((entry) => Array.isArray(entry.boundaryDecisionIds))).toBe(true);
    expect(result.evidence.at(-1)).toMatchObject({
      decisionCode: "pdf/region-image-fallback-attached",
      boundaryDecisionIds: [],
      analyzerRevision: "atlcli.pdf-visual-fallback-policy/1",
    });
  });

  it("keeps a full-page visual fallback after editable page content", async () => {
    const assessment: PdfPageFallbackAssessmentV1 = {
      ...regionAssessment(),
      scope: "page",
      reasonCodes: ["unclaimed-visible-text"],
      regionLocators: [],
      unclaimedCharacterCount: 4,
    };
    const result = await materializePdfVisualFallbacks(
      new Uint8Array([1]),
      await adapter(),
      document(),
      [evidence("source:before", "block:before", 0.1), evidence("source:after", "block:after", 0.8)],
      [assessment],
    );
    expect(result.document.blocks.at(-2)).toMatchObject({ type: "image", presentation: "page-fallback" });
    expect(result.document.blocks.at(-1)).toMatchObject({ type: "paragraph" });
  });
});
