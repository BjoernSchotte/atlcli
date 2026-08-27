import { describe, expect, it } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { ImportBlock } from "@atlcli/import-core";
import { createNodePdfiumFactsAdapter, createNodePdfiumFactsAdapterV2 } from "./node.js";
import {
  PDF_IMPORT_REVIEW_SCHEMA_V1,
  PDF_IMPORT_REVIEW_SCHEMA_V2,
  PDF_IMPORT_REVIEW_SCHEMA_V3,
  buildPdfImportReview,
  buildPdfImportReviewV2,
  buildPdfImportReviewV3,
  pdfImportReviewReport,
  renderPdfImportReview,
  upgradePdfImportReviewV3,
} from "./review.js";
import { parsePdfSplitPolicy } from "./split.js";

const fixtureRoot = resolve(import.meta.dir, "../../../specs/pdf-import-quality/fixtures");
const mvpFixtureRoot = resolve(import.meta.dir, "../../../specs/import-pdf-mvp/fixtures");

function blockText(block: ImportBlock): string {
  if (block.type === "heading" || block.type === "paragraph") {
    return block.runs.map((run) => run.kind === "text" ? run.text : "\n").join("");
  }
  return block.type;
}

describe("PDF import review V2", () => {
  it("retains the explicit V1 review contract for existing consumers", async () => {
    const sourceBytes = new Uint8Array(await readFile(resolve(mvpFixtureRoot, "simple-untagged.pdf")));
    const review = await buildPdfImportReview(
      sourceBytes,
      await createNodePdfiumFactsAdapter(),
      {
        target: {
          spaceKey: "DOCSY",
          title: "Neutral PDF Review V1",
          deployment: "cloud",
          supportsPageTree: true,
          evidence: "profile",
        },
        splitPolicy: parsePdfSplitPolicy("off"),
      },
    );

    expect(review.schema).toBe(PDF_IMPORT_REVIEW_SCHEMA_V1);
    expect(review.facts.schema).toBe("atlcli.pdf-facts/1");
    expect("boundaries" in review).toBe(false);
    expect(pdfImportReviewReport(review)).not.toHaveProperty("quality");
  });

  it("drives the production review pipeline through the V2 geometry contract", async () => {
    const sourceBytes = new Uint8Array(await readFile(resolve(fixtureRoot, "producer-word.pdf")));
    const review = await buildPdfImportReviewV2(
      sourceBytes,
      await createNodePdfiumFactsAdapterV2(),
      {
        target: {
          spaceKey: "DOCSY",
          title: "Neutral PDF Review V2",
          deployment: "cloud",
          supportsPageTree: true,
          evidence: "profile",
        },
        splitPolicy: parsePdfSplitPolicy("off"),
        scanPolicy: "fail",
      },
    );

    expect(review.schema).toBe(PDF_IMPORT_REVIEW_SCHEMA_V2);
    expect(review.facts.schema).toBe("atlcli.pdf-facts/2");
    expect(review.blockers).toEqual([]);
    expect(review.document.blocks.map((block) => [block.type, blockText(block)])).toEqual([
      ["heading", "Neutral Harbor Field Notes"],
      ["paragraph", "Harbor signals remain clear across styled text runs."],
      ["paragraph", "Seasonal coordination continues safely across a visual line wrap."],
      ["paragraph", "Grüne Flächen, Küstenwege und präzise Übergänge bleiben neutral."],
      ["paragraph", "مرحبا بالميناء"],
      ["paragraph", "港の信号は明確です"],
      ["list", "list"],
      ["table", "table"],
    ]);
    expect(review.boundaries).toHaveLength(48);
    expect(review.boundaries.every((boundary) => boundary.action !== "unresolved")).toBe(true);
    expect(review.pages).toEqual([expect.objectContaining({
      boundaryDecisionCount: 48,
      unresolvedBoundaryCount: 0,
      fallback: "none",
    })]);
    expect(review.evidence.every((entry) => Array.isArray(entry.boundaryDecisionIds))).toBe(true);

    const report = pdfImportReviewReport(review) as {
      quality: {
        boundaryDecisionCount: number;
        unresolvedBoundaryCount: number;
        transformationCount: number;
        visibleCharacterCount: number;
        uniquelyOwnedCharacterCount: number;
        explicitBoundaryCount: number;
        inferredBoundaryCount: number;
        geometryRepairedCharacterCount: number;
        geometryRepairRegionCount: number;
        duplicateOwnershipAttemptCount: number;
        residualReportedCharacterCount: number;
        normalizedFallbackArea: number;
      };
    };
    expect(report.quality).toEqual({
      boundaryDecisionCount: 48,
      unresolvedBoundaryCount: 0,
      transformationCount: review.transformations.length,
      visibleCharacterCount: 314,
      uniquelyOwnedCharacterCount: 314,
      explicitBoundaryCount: 38,
      inferredBoundaryCount: 10,
      geometryRepairedCharacterCount: 0,
      geometryRepairRegionCount: 0,
      duplicateOwnershipAttemptCount: 0,
      residualReportedCharacterCount: 0,
      normalizedFallbackArea: 0,
    });
    expect(renderPdfImportReview(review)).toContain("boundaries 48, unresolved 0");
    expect(renderPdfImportReview(review)).toContain("ownership 314/314, duplicates 0, residual 0");
  });

  it("versions body-free source-fidelity metrics without changing the V2 projection", async () => {
    const sourceBytes = new Uint8Array(await readFile(resolve(fixtureRoot, "independent-fragmented-tagged.pdf")));
    const review = await buildPdfImportReviewV3(
      sourceBytes,
      await createNodePdfiumFactsAdapterV2(),
      {
        target: {
          spaceKey: "DOCSY",
          title: "Neutral PDF Review V3",
          deployment: "cloud",
          supportsPageTree: true,
          evidence: "profile",
        },
        splitPolicy: parsePdfSplitPolicy("off"),
        scanPolicy: "fail",
      },
    );

    expect(review.schema).toBe(PDF_IMPORT_REVIEW_SCHEMA_V3);
    expect(review.pages).toEqual([expect.objectContaining({
      explicitBoundaryCount: 14,
      inferredBoundaryCount: 12,
      dehyphenatedBoundaryCount: 1,
      taggedOwnedCharacterCount: 130,
      geometryOwnedCharacterCount: 28,
      fallbackOwnedCharacterCount: 0,
      unownedCharacterCount: 0,
      geometryRepairRegionCount: 1,
      fallbackScope: "none",
      normalizedFallbackArea: 0,
      fidelityDecisionCodes: ["pdf/source-fidelity-accounted"],
    })]);
    const report = pdfImportReviewReport(review) as {
      quality: Record<string, number>;
    };
    expect(report.quality).toMatchObject({
      dehyphenatedBoundaryCount: 1,
      taggedOwnedCharacterCount: 130,
      geometryOwnedCharacterCount: 28,
      fallbackOwnedCharacterCount: 0,
      unownedCharacterCount: 0,
    });
    const terminal = renderPdfImportReview(review);
    expect(terminal).toContain("Page 1:");
    expect(terminal).toContain("decision pdf/source-fidelity-accounted");
    expect(terminal).toContain("fallback none");
    expect(terminal).not.toContain("Harbor signals remain clear");
  });

  it("blocks unresolved boundaries and ownership failures with body-free decision codes", async () => {
    const sourceBytes = new Uint8Array(await readFile(resolve(fixtureRoot, "producer-word.pdf")));
    const base = await buildPdfImportReviewV2(
      sourceBytes,
      await createNodePdfiumFactsAdapterV2(),
      {
        target: {
          spaceKey: "DOCSY",
          title: "Neutral PDF Review Policy",
          deployment: "cloud",
          supportsPageTree: true,
          evidence: "profile",
        },
        splitPolicy: parsePdfSplitPolicy("off"),
        unsupported: "report",
      },
    );
    const firstBoundary = base.boundaries[0]!;
    const firstOwner = base.ownership[0]!;
    const degraded = {
      ...base,
      options: { ...base.options, unsupported: "fail" as const },
      boundaries: [{ ...firstBoundary, action: "unresolved" as const }, ...base.boundaries.slice(1)],
      ownership: [{
        ...firstOwner,
        ownerSourceId: `pdf:p${firstOwner.pageIndex}:unowned`,
        basis: "reported" as const,
        outcome: "reported" as const,
        targetNodeId: undefined,
      }, ...base.ownership.slice(1)],
      pages: [{
        ...base.pages[0]!,
        unresolvedBoundaryCount: 1,
        duplicateOwnershipAttemptCount: 1,
      }],
      document: {
        ...base.document,
        issues: [...base.document.issues, {
          code: "pdf-import/text-boundary-unresolved",
          severity: "warning" as const,
          outcome: "reported" as const,
          message: "A material text boundary could not be resolved from source evidence.",
          sourceRefs: ["pdf:p0:test-boundary"],
          context: { pageIndex: 0, boundaries: 1 },
        }],
      },
    };
    const review = await upgradePdfImportReviewV3(degraded);

    expect(review.pages[0]).toMatchObject({
      unresolvedBoundaryCount: 1,
      duplicateOwnershipAttemptCount: 1,
      unownedCharacterCount: 1,
      fidelityDecisionCodes: [
        "pdf/text-boundary-unresolved",
        "pdf/character-ownership-failed",
      ],
    });
    expect(review.document.issues.map((issue) => issue.code)).toContain("pdf-import/text-boundary-unresolved");
    expect(review.document.issues).toContainEqual(expect.objectContaining({
      code: "pdf-import/character-ownership-failed",
      context: { pageIndex: 0, unownedCharacters: 1, duplicateOwnershipAttempts: 1 },
    }));
    expect(review.blockers.join("\n")).toContain("pdf/text-boundary-unresolved");
    expect(review.blockers.join("\n")).toContain("pdf/character-ownership-failed");
    expect(renderPdfImportReview(review)).not.toContain("Harbor signals remain clear");
  });
});
