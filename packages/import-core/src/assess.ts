import type { ImportBlock } from "./model.js";
import { documentToAdf, type AdfNode } from "./adf.js";

export type EditabilityLevel = "ok" | "caution" | "risk";

export interface EditabilityAssessment {
  adfBytes: number;
  nodeCount: number;
  tableCells: number;
  images: number;
  level: EditabilityLevel;
  recommendation?: string;
}

export const EDITABILITY_BUDGETS = {
  caution: { adfBytes: 512 * 1024, nodeCount: 5_000, tableCells: 2_500 },
  risk: { adfBytes: 2 * 1024 * 1024, nodeCount: 20_000, tableCells: 10_000 },
} as const;

function countNodes(nodes: AdfNode[]): number {
  return nodes.reduce((count, node) => count + 1 + (node.content ? countNodes(node.content) : 0), 0);
}

function countByType(nodes: AdfNode[], types: readonly string[]): number {
  return nodes.reduce(
    (count, node) => count + (types.includes(node.type) ? 1 : 0) + (node.content ? countByType(node.content, types) : 0),
    0,
  );
}

export function assessEditability(blocks: ImportBlock[]): EditabilityAssessment {
  const adf = documentToAdf({ blocks });
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
    recommendation = "This page is likely to freeze or time out in the Confluence editor. Split it into a page tree (--split 1 or --split 2) before publishing.";
  } else if (over(EDITABILITY_BUDGETS.caution)) {
    level = "caution";
    recommendation = "This page may be sluggish to edit in Confluence. Consider splitting it into a page tree (--split 1 or --split 2).";
  }
  return { adfBytes, nodeCount, tableCells, images, level, recommendation };
}
