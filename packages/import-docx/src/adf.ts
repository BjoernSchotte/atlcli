/**
 * Neutral IR → Cloud ADF (atlas_doc_format) encoder for the vertical slice.
 *
 * Deterministic: identical input documents encode to identical ADF JSON, so
 * the preview digest is stable across runs and runtimes.
 */
import type {
  ImportBlock,
  ImportListBlock,
  ImportRun,
  ImportedDocument,
} from "./model.js";

export interface AdfNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: AdfNode[];
  marks?: { type: string; attrs?: Record<string, unknown> }[];
  text?: string;
}

export interface AdfDocument {
  version: 1;
  type: "doc";
  content: AdfNode[];
}

function encodeRuns(runs: ImportRun[]): AdfNode[] {
  const nodes: AdfNode[] = [];
  for (const run of runs) {
    if (run.kind === "hard-break") {
      nodes.push({ type: "hardBreak" });
      continue;
    }
    if (run.text.length === 0) continue;
    const marks: AdfNode["marks"] = [];
    if (run.marks?.bold) marks.push({ type: "strong" });
    if (run.marks?.italic) marks.push({ type: "em" });
    if (run.marks?.code) marks.push({ type: "code" });
    if (run.marks?.link) marks.push({ type: "link", attrs: { href: run.marks.link.href } });
    nodes.push({ type: "text", text: run.text, ...(marks.length > 0 ? { marks } : {}) });
  }
  return nodes;
}

function encodeParagraph(runs: ImportRun[]): AdfNode {
  return { type: "paragraph", content: encodeRuns(runs) };
}

function encodeList(list: ImportListBlock): AdfNode {
  return {
    type: list.ordered ? "orderedList" : "bulletList",
    content: list.items.map((item) => {
      const content: AdfNode[] = item.blocks.map(encodeBlock);
      // ADF list items require at least one block child.
      if (content.length === 0) content.push({ type: "paragraph", content: [] });
      if (item.child) content.push(encodeList(item.child));
      return { type: "listItem", content };
    }),
  };
}

function encodeBlock(block: ImportBlock): AdfNode {
  switch (block.type) {
    case "heading":
      return { type: "heading", attrs: { level: block.level }, content: encodeRuns(block.runs) };
    case "paragraph":
      return encodeParagraph(block.runs);
    case "list":
      return encodeList(block);
    case "table":
      return {
        type: "table",
        attrs: { layout: "default" },
        content: block.rows.map((row) => ({
          type: "tableRow",
          content: row.cells.map((cell) => {
            const content: AdfNode[] = cell.blocks.map(encodeBlock);
            if (content.length === 0) content.push({ type: "paragraph", content: [] });
            return { type: cell.header ? "tableHeader" : "tableCell", attrs: {}, content };
          }),
        })),
      };
  }
}

export function documentToAdf(doc: ImportedDocument): AdfDocument {
  return { version: 1, type: "doc", content: doc.blocks.map(encodeBlock) };
}
