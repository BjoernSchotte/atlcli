/**
 * Optional table-structure proposals for untagged PDFs.
 *
 * A proposer (for example a local Table Transformer) sees only a rendered
 * image of a candidate area the deterministic pass could not resolve and
 * returns rows, columns, column headers and spanning cells. AtlCLI accepts a
 * proposal only when the PDF's own characters fit it (`verifyTableProposalV2`);
 * it never adds or changes text. This package carries no model or runtime.
 */
import type { ImportIssue } from "@atlcli/import-core";
import type {
  PdfFactsAdapterV2,
  PdfFactsV2,
  PdfMaterializedAssetV1,
  PdfNormalizedRect,
} from "./contracts.js";
import {
  untaggedTableCandidateRegionsV2,
  verifyTableProposalV2,
  type PdfGeometryGridV2,
  type PdfTableStructureProposalV1,
} from "./geometry-tables.js";
import { analyzeGeometryReadingOrderV2 } from "./reading-order.js";
import { analyzeUntaggedTableV2 } from "./tables.js";

/** Boxes relative to the proposal image: 0..1 from its left and top edge. */
export type PdfTableImageProposalV1 = PdfTableStructureProposalV1;

export interface PdfTableProposalRequestV1 {
  pageIndex: number;
  /** Page-normalized area shown in `image`. */
  bbox: PdfNormalizedRect;
  image: PdfMaterializedAssetV1;
}

export interface PdfTableStructureProposerV1 {
  /** Model and revision, recorded in evidence (for example `table-transformer@<sha>`). */
  readonly id: string;
  propose(request: PdfTableProposalRequestV1): Promise<PdfTableImageProposalV1 | null>;
}

export const PDF_TABLE_PROPOSAL_RENDER_DPI = 150;

function toPage(region: PdfNormalizedRect, box: PdfNormalizedRect): PdfNormalizedRect {
  return {
    x: region.x + box.x * region.width,
    y: region.y + box.y * region.height,
    width: box.width * region.width,
    height: box.height * region.height,
  };
}

export interface PdfTableProposalOutcomeV1 {
  grids: PdfGeometryGridV2[];
  issues: ImportIssue[];
  candidates: number;
}

/** Renders every candidate area, asks the proposer and keeps the verified grids. */
export async function proposeUntaggedTablesV2(
  sourceBytes: Uint8Array,
  adapter: PdfFactsAdapterV2,
  facts: PdfFactsV2,
  proposer: PdfTableStructureProposerV1,
): Promise<PdfTableProposalOutcomeV1> {
  const work = facts.pages.flatMap((page) => {
    if (page.kind !== "digital" && page.kind !== "mixed") return [];
    const analysis = analyzeGeometryReadingOrderV2(page);
    const legacy = analyzeUntaggedTableV2(page, analysis);
    const aligned = legacy.mode === "linearized-render-required" ? legacy.bbox ?? null : null;
    return untaggedTableCandidateRegionsV2(page, analysis, aligned)
      .map((bbox, index) => ({ page, analysis, bbox, id: `pdf:p${page.index}:table-proposal:${index}` }));
  });
  if (work.length === 0) return { grids: [], issues: [], candidates: 0 };
  const images = await adapter.materialize(sourceBytes, work.map((item) => ({
    id: item.id,
    pageIndex: item.page.index,
    kind: "rendered-region" as const,
    bbox: item.bbox,
    dpi: PDF_TABLE_PROPOSAL_RENDER_DPI,
  })));
  const grids: PdfGeometryGridV2[] = [];
  const issues: ImportIssue[] = [];
  for (const item of work) {
    const image = images.find((asset) => asset.requestId === item.id);
    const proposal = image ? await proposer.propose({ pageIndex: item.page.index, bbox: item.bbox, image }) : null;
    const grid = proposal ? verifyTableProposalV2(item.page, item.analysis, item.bbox, {
      rows: proposal.rows.map((box) => toPage(item.bbox, box)),
      columns: proposal.columns.map((box) => toPage(item.bbox, box)),
      columnHeaders: proposal.columnHeaders.map((box) => toPage(item.bbox, box)),
      spanningCells: proposal.spanningCells.map((box) => toPage(item.bbox, box)),
    }) : null;
    if (grid) grids.push(grid);
    issues.push({
      code: grid ? "pdf-import/table-model-proposal-accepted" : "pdf-import/table-model-proposal-rejected",
      severity: "info",
      outcome: grid ? "native" : "reported",
      message: grid
        ? "A table-structure model proposed this table and every character fits it."
        : "A table-structure proposal did not fit the page's characters and was not used.",
      sourceRefs: [item.id],
      context: { pageIndex: item.page.index, proposer: proposer.id, ...(grid ? { rows: grid.rowCount, columns: grid.columnCount } : {}) },
    });
  }
  return { grids, issues, candidates: work.length };
}
