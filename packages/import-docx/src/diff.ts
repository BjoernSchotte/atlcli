/**
 * Semantic block diff between the current page body and the new import plan
 * (specs/import-docx/006-inplace-update — the update-preview contract).
 *
 * Compares CANONICALIZED top-level ADF blocks with media identities
 * normalized away, so re-uploaded attachment fileIds never masquerade as
 * content changes. LCS alignment; adjacent remove/add pairs of the same
 * node type collapse into "changed".
 */
import { canonicalJson } from "./baseline.js";
import type { AdfNode } from "./adf.js";

export interface SemanticDiffEntry {
  op: "added" | "removed" | "changed";
  /** Block index in the NEW document (added/changed) or OLD (removed). */
  index: number;
  type: string;
  /** First ~60 chars of the block's text content, sanitized. */
  summary: string;
}

export interface SemanticDiffV1 {
  schema: "atlcli.docx-semantic-diff/1";
  unchanged: number;
  entries: SemanticDiffEntry[];
}

function normalizeNode(node: AdfNode): AdfNode {
  const attrs = { ...node.attrs };
  if (node.type === "media") {
    delete attrs.id;
    delete attrs.collection;
  }
  return {
    type: node.type,
    ...(Object.keys(attrs).length > 0 ? { attrs } : {}),
    ...(node.text !== undefined ? { text: node.text } : {}),
    ...(node.marks ? { marks: node.marks } : {}),
    ...(node.content ? { content: node.content.map(normalizeNode) } : {}),
  };
}

function blockKey(node: AdfNode): string {
  return canonicalJson(normalizeNode(node));
}

function blockText(node: AdfNode): string {
  const parts: string[] = [];
  const walk = (n: AdfNode): void => {
    if (n.text) parts.push(n.text);
    n.content?.forEach(walk);
  };
  walk(node);
  const text = parts.join(" ").replace(/\s+/g, " ").trim();
  return text.length > 60 ? `${text.slice(0, 57)}…` : text;
}

export function diffAdfBlocks(oldBlocks: AdfNode[], newBlocks: AdfNode[]): SemanticDiffV1 {
  const oldKeys = oldBlocks.map(blockKey);
  const newKeys = newBlocks.map(blockKey);

  // LCS table over block keys.
  const n = oldKeys.length;
  const m = newKeys.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] =
        oldKeys[i] === newKeys[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }

  const raw: SemanticDiffEntry[] = [];
  let unchanged = 0;
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (oldKeys[i] === newKeys[j]) {
      unchanged += 1;
      i += 1;
      j += 1;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      raw.push({ op: "removed", index: i, type: oldBlocks[i].type, summary: blockText(oldBlocks[i]) });
      i += 1;
    } else {
      raw.push({ op: "added", index: j, type: newBlocks[j].type, summary: blockText(newBlocks[j]) });
      j += 1;
    }
  }
  for (; i < n; i++) raw.push({ op: "removed", index: i, type: oldBlocks[i].type, summary: blockText(oldBlocks[i]) });
  for (; j < m; j++) raw.push({ op: "added", index: j, type: newBlocks[j].type, summary: blockText(newBlocks[j]) });

  // Collapse adjacent removed+added of the same type into "changed".
  const entries: SemanticDiffEntry[] = [];
  for (let k = 0; k < raw.length; k++) {
    const current = raw[k];
    const next = raw[k + 1];
    if (
      next &&
      current.op === "removed" &&
      next.op === "added" &&
      current.type === next.type
    ) {
      entries.push({ op: "changed", index: next.index, type: next.type, summary: next.summary });
      k += 1;
    } else {
      entries.push(current);
    }
  }
  return { schema: "atlcli.docx-semantic-diff/1", unchanged, entries };
}

export function renderSemanticDiffLines(diff: SemanticDiffV1): string[] {
  const counts = { added: 0, removed: 0, changed: 0 };
  for (const e of diff.entries) counts[e.op] += 1;
  const lines = [
    `${counts.added} added, ${counts.changed} changed, ${counts.removed} removed, ${diff.unchanged} unchanged`,
  ];
  for (const e of diff.entries.slice(0, 20)) {
    const mark = e.op === "added" ? "+" : e.op === "removed" ? "-" : "~";
    lines.push(`  ${mark} [${e.type}] ${e.summary || "(no text)"}`);
  }
  if (diff.entries.length > 20) lines.push(`  … ${diff.entries.length - 20} more`);
  return lines;
}
