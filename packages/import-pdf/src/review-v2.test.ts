import { describe, expect, it } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { ImportBlock } from "@atlcli/import-core";
import { createNodePdfiumFactsAdapter, createNodePdfiumFactsAdapterV2 } from "./node.js";
import {
  PDF_IMPORT_REVIEW_SCHEMA_V1,
  PDF_IMPORT_REVIEW_SCHEMA_V2,
  buildPdfImportReview,
  buildPdfImportReviewV2,
  pdfImportReviewReport,
  renderPdfImportReview,
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
      };
    };
    expect(report.quality).toEqual({
      boundaryDecisionCount: 48,
      unresolvedBoundaryCount: 0,
      transformationCount: review.transformations.length,
    });
    expect(renderPdfImportReview(review)).toContain("boundaries 48, unresolved 0");
  });
});
