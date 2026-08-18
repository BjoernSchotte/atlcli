import { sha256Hex } from "@atlcli/core";
import type { ImportBlock, ImportDocumentV2, ImportRun } from "./model.js";
import { documentToAdf } from "./adf.js";
import { assessEditability, type EditabilityAssessment } from "./assess.js";

export interface ImportTarget {
  spaceKey: string;
  title: string;
  parentId?: string;
}

export interface ImportPreviewAsset {
  fileName: string;
  mediaType: string;
  byteLength: number;
  sha256: string;
}

export interface ImportPreview {
  target: ImportTarget;
  counts: Record<string, number>;
  outline: { level: number; text: string }[];
  assets: ImportPreviewAsset[];
  editability: EditabilityAssessment;
  issues: ImportDocumentV2["issues"];
  adfDigest: string;
}

function runsText(runs: ImportRun[]): string {
  return runs.map((run) => run.kind === "text" ? run.text : " ").join("").trim();
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
      for (const row of block.rows) for (const cell of row.cells) countBlocks(cell.blocks, counts);
    } else if (block.type === "blockquote") countBlocks(block.blocks, counts);
  }
}

export async function buildImportPreview(document: ImportDocumentV2, target: ImportTarget): Promise<ImportPreview> {
  const counts: Record<string, number> = {};
  countBlocks(document.blocks, counts);
  const outline = document.blocks
    .filter((block): block is Extract<ImportBlock, { type: "heading" }> => block.type === "heading")
    .map((heading) => ({
      level: heading.level,
      text: heading.label ? `${heading.label} ${runsText(heading.runs)}` : runsText(heading.runs),
    }));
  const assets = await Promise.all(document.assets.map(async (asset) => ({
    fileName: asset.fileName,
    mediaType: asset.mediaType,
    byteLength: asset.bytes.byteLength,
    sha256: await sha256Hex(asset.bytes),
  })));
  const adfDigest = await sha256Hex(new TextEncoder().encode(JSON.stringify(documentToAdf(document))));
  return {
    target,
    counts,
    outline,
    assets,
    editability: assessEditability(document.blocks),
    issues: document.issues,
    adfDigest,
  };
}

export function renderImportPreview(preview: ImportPreview): string {
  const lines = [
    "Import preview",
    `  Title:  ${preview.target.title}`,
    `  Space:  ${preview.target.spaceKey}`,
    ...(preview.target.parentId ? [`  Parent: ${preview.target.parentId}`] : []),
    `  Digest: sha256:${preview.adfDigest.slice(0, 16)}…`,
    "",
  ];
  const countLine = Object.entries(preview.counts)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([kind, count]) => `${count} ${kind}${count === 1 ? "" : "s"}`)
    .join(", ");
  lines.push(`Content: ${countLine || "empty document"}`);
  const editability = preview.editability;
  if (editability.level !== "ok") {
    lines.push("", `Editability: ${editability.level.toUpperCase()} — ${Math.round(editability.adfBytes / 1024)} KiB payload, ${editability.nodeCount} nodes${editability.tableCells ? `, ${editability.tableCells} table cells` : ""}`);
    if (editability.recommendation) lines.push(`  ${editability.recommendation}`);
  }
  if (preview.outline.length > 0) {
    lines.push("", "Outline:");
    for (const heading of preview.outline) lines.push(`${"  ".repeat(heading.level)}H${heading.level} ${heading.text}`);
  }
  if (preview.assets.length > 0) {
    lines.push("", `Attachments (${preview.assets.length}):`);
    for (const asset of preview.assets) lines.push(`  ${asset.fileName} (${asset.mediaType}, ${asset.byteLength} bytes, sha256:${asset.sha256.slice(0, 12)}…)`);
  }
  if (preview.issues.length > 0) {
    lines.push("", `Issues (${preview.issues.length}):`);
    for (const issue of preview.issues) {
      const occurrences = issue.context?.occurrences ? ` (×${issue.context.occurrences})` : "";
      lines.push(`  [${issue.severity}] ${issue.code}: ${issue.message}${occurrences}`);
    }
  }
  return lines.join("\n");
}
