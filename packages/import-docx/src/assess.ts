/**
 * Editability assessment for one planned page
 * (specs/import-docx/003-editability-budgets, slice scope).
 *
 * A page can be created successfully via the API and still be practically
 * uneditable — the Confluence editor degrades long before hard API limits.
 * This module estimates that risk from the encoded payload and gives an
 * actionable recommendation. The thresholds are evidence-calibrated soft
 * budgets (community reports of frozen editors on very large imports), NOT
 * proven hard API limits — the assessment therefore warns and recommends,
 * it never blocks a publication on its own.
 */
import type { ImportBlock, ImportedDocument } from "./model.js";
import { documentToAdf, type AdfNode } from "./adf.js";

export type EditabilityLevel = "ok" | "caution" | "risk";

export interface EditabilityAssessment {
  /** Bytes of the encoded ADF JSON payload (placeholder media form). */
  adfBytes: number;
  /** Total ADF nodes, including nested content. */
  nodeCount: number;
  tableCells: number;
  images: number;
  level: EditabilityLevel;
  /** Human recommendation; present for caution/risk. */
  recommendation?: string;
}

/**
 * Soft budgets. `caution` ≈ noticeably sluggish editor, `risk` ≈ reported
 * freeze/timeout territory (350-page single-page imports, multi-MB bodies).
 */
export const EDITABILITY_BUDGETS = {
  caution: { adfBytes: 512 * 1024, nodeCount: 5_000, tableCells: 2_500 },
  risk: { adfBytes: 2 * 1024 * 1024, nodeCount: 20_000, tableCells: 10_000 },
} as const;

function countNodes(nodes: AdfNode[]): number {
  let count = 0;
  for (const node of nodes) {
    count += 1;
    if (node.content) count += countNodes(node.content);
  }
  return count;
}

function countByType(nodes: AdfNode[], types: readonly string[]): number {
  let count = 0;
  for (const node of nodes) {
    if (types.includes(node.type)) count += 1;
    if (node.content) count += countByType(node.content, types);
  }
  return count;
}

/** Assess the page a given block list would publish as. */
export function assessEditability(blocks: ImportBlock[]): EditabilityAssessment {
  const doc: ImportedDocument = { blocks, assets: [], issues: [] };
  const adf = documentToAdf(doc);
  const adfBytes = new TextEncoder().encode(JSON.stringify(adf)).byteLength;
  const nodeCount = countNodes(adf.content);
  const tableCells = countByType(adf.content, ["tableCell", "tableHeader"]);
  const images = countByType(adf.content, ["media"]);

  const over = (budget: { adfBytes: number; nodeCount: number; tableCells: number }): boolean =>
    adfBytes > budget.adfBytes || nodeCount > budget.nodeCount || tableCells > budget.tableCells;

  let level: EditabilityLevel = "ok";
  let recommendation: string | undefined;
  if (over(EDITABILITY_BUDGETS.risk)) {
    level = "risk";
    recommendation =
      "This page is likely to freeze or time out in the Confluence editor. Split it into a page tree (--split 1 or --split 2) before publishing.";
  } else if (over(EDITABILITY_BUDGETS.caution)) {
    level = "caution";
    recommendation =
      "This page may be sluggish to edit in Confluence. Consider splitting it into a page tree (--split 1 or --split 2).";
  }

  return { adfBytes, nodeCount, tableCells, images, level, recommendation };
}
