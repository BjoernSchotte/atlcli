/**
 * Semantic block diff between the current page body and the new import plan
 * (specs/import-docx/006-inplace-update — the update-preview contract).
 *
 * Compares CANONICALIZED top-level ADF blocks with media identities
 * normalized away, so re-uploaded attachment fileIds never masquerade as
 * content changes. LCS alignment; adjacent remove/add pairs of the same
 * node type collapse into "changed".
 */
import { stripAdfAnnotations } from "./baseline.js";
import { canonicalJson, type AdfNode } from "@atlcli/import-core";

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
  return canonicalJson(stripAdfAnnotations(normalizeNode(node)));
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

/** LCS table ceiling (Uint32 cells): 16M cells = 64 MiB. */
const MAX_LCS_CELLS = 16 * 1024 * 1024;

export function diffAdfBlocks(oldBlocks: AdfNode[], newBlocks: AdfNode[]): SemanticDiffV1 {
  const oldKeys = oldBlocks.map(blockKey);
  const newKeys = newBlocks.map(blockKey);

  const n = oldKeys.length;
  const m = newKeys.length;
  // A re-import changes a few blocks of a long page, so the common head and
  // tail are aligned directly and only the differing core gets an LCS table.
  let head = 0;
  while (head < n && head < m && oldKeys[head] === newKeys[head]) head += 1;
  let tail = 0;
  while (tail < n - head && tail < m - head && oldKeys[n - 1 - tail] === newKeys[m - 1 - tail]) tail += 1;
  const coreN = n - head - tail;
  const coreM = m - head - tail;
  const width = coreM + 1;
  // ponytail: above the cell cap the core is reported as removed-then-added
  // instead of aligned; switch to Myers O((N+M)D) if such diffs matter.
  const aligned = coreN * coreM <= MAX_LCS_CELLS;
  const lcs = new Uint32Array(aligned ? (coreN + 1) * width : 0);
  if (aligned) {
    for (let i = coreN - 1; i >= 0; i--) {
      for (let j = coreM - 1; j >= 0; j--) {
        lcs[i * width + j] =
          oldKeys[head + i] === newKeys[head + j]
            ? lcs[(i + 1) * width + j + 1] + 1
            : Math.max(lcs[(i + 1) * width + j], lcs[i * width + j + 1]);
      }
    }
  }

  const raw: SemanticDiffEntry[] = [];
  const removed = (i: number): void => {
    raw.push({ op: "removed", index: i, type: oldBlocks[i].type, summary: blockText(oldBlocks[i]) });
  };
  const added = (j: number): void => {
    raw.push({ op: "added", index: j, type: newBlocks[j].type, summary: blockText(newBlocks[j]) });
  };
  let unchanged = head + tail;
  let i = 0;
  let j = 0;
  while (aligned && i < coreN && j < coreM) {
    if (oldKeys[head + i] === newKeys[head + j]) {
      unchanged += 1;
      i += 1;
      j += 1;
    } else if (lcs[(i + 1) * width + j] >= lcs[i * width + j + 1]) {
      removed(head + i);
      i += 1;
    } else {
      added(head + j);
      j += 1;
    }
  }
  for (; i < coreN; i++) removed(head + i);
  for (; j < coreM; j++) added(head + j);

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
