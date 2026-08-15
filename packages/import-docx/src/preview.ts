/**
 * Review-first preview for `wiki import` (PLAN.md §2.6/§10.4, slice scope).
 *
 * The preview is a pure projection of the parsed document plus the resolved
 * target; it never talks to the network. The digest binds what the user saw
 * to what `--confirm` publishes.
 */
import { sha256Hex } from "@atlcli/core";
import type { ImportBlock, ImportRun, ImportedDocument } from "./model.js";
import { documentToAdf } from "./adf.js";

export interface ImportTarget {
  spaceKey: string;
  title: string;
  parentId?: string;
}

export interface ImportPreview {
  target: ImportTarget;
  counts: Record<string, number>;
  outline: { level: number; text: string }[];
  issues: ImportedDocument["issues"];
  /** sha256 over the exact ADF payload that --confirm would publish. */
  adfDigest: string;
}

function runsText(runs: ImportRun[]): string {
  return runs
    .map((r) => (r.kind === "text" ? r.text : " "))
    .join("")
    .trim();
}

function countBlocks(blocks: ImportBlock[], counts: Record<string, number>): void {
  for (const block of blocks) {
    counts[block.type] = (counts[block.type] ?? 0) + 1;
    if (block.type === "list") {
      for (const item of block.items) {
        countBlocks(item.blocks, counts);
        if (item.child) countBlocks([item.child], counts);
      }
    } else if (block.type === "table") {
      for (const row of block.rows) {
        for (const cell of row.cells) countBlocks(cell.blocks, counts);
      }
    }
  }
}

export async function buildImportPreview(
  doc: ImportedDocument,
  target: ImportTarget,
): Promise<ImportPreview> {
  const counts: Record<string, number> = {};
  countBlocks(doc.blocks, counts);

  const outline = doc.blocks
    .filter((b): b is Extract<ImportBlock, { type: "heading" }> => b.type === "heading")
    .map((h) => ({ level: h.level, text: runsText(h.runs) }));

  const adfDigest = await sha256Hex(new TextEncoder().encode(JSON.stringify(documentToAdf(doc))));
  return { target, counts, outline, issues: doc.issues, adfDigest };
}

export function renderImportPreview(preview: ImportPreview): string {
  const lines: string[] = [];
  lines.push(`Import preview`);
  lines.push(`  Title:  ${preview.target.title}`);
  lines.push(`  Space:  ${preview.target.spaceKey}`);
  if (preview.target.parentId) lines.push(`  Parent: ${preview.target.parentId}`);
  lines.push(`  Digest: sha256:${preview.adfDigest.slice(0, 16)}…`);
  lines.push("");

  const countLine = Object.entries(preview.counts)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${v} ${k}${v === 1 ? "" : "s"}`)
    .join(", ");
  lines.push(`Content: ${countLine || "empty document"}`);

  if (preview.outline.length > 0) {
    lines.push("");
    lines.push("Outline:");
    for (const h of preview.outline) {
      lines.push(`${"  ".repeat(h.level)}H${h.level} ${h.text}`);
    }
  }

  if (preview.issues.length > 0) {
    lines.push("");
    lines.push(`Issues (${preview.issues.length}):`);
    for (const issue of preview.issues) {
      const extra = issue.context?.occurrences ? ` (×${issue.context.occurrences})` : "";
      lines.push(`  [${issue.severity}] ${issue.code}: ${issue.message}${extra}`);
    }
  }
  return lines.join("\n");
}
