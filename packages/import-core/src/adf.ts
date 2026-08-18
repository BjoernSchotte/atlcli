import type {
  ImportBlock,
  ImportImageBlock,
  ImportListBlock,
  ImportProjectionInput,
  ImportRun,
} from "./model.js";
import { resolveImportReference } from "./model.js";

export interface AdfMediaResolution {
  fileId: string;
  collection: string;
}

export interface AdfEncodeOptions {
  media?: ReadonlyMap<string, AdfMediaResolution>;
  references?: ReadonlyMap<string, string>;
}

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

function encodeRuns(runs: ImportRun[], options: AdfEncodeOptions): AdfNode[] {
  const nodes: AdfNode[] = [];
  for (const run of runs) {
    if (run.kind === "hard-break") {
      nodes.push({ type: "hardBreak" });
      continue;
    }
    if (run.text.length === 0) continue;
    const marks: NonNullable<AdfNode["marks"]> = [];
    if (run.marks?.bold) marks.push({ type: "strong" });
    if (run.marks?.italic) marks.push({ type: "em" });
    if (run.marks?.code) marks.push({ type: "code" });
    if (run.marks?.link) marks.push({ type: "link", attrs: { href: run.marks.link.href } });
    else if (run.marks?.reference) {
      const href = resolveImportReference(run.marks.reference, options.references);
      if (href) marks.push({ type: "link", attrs: { href } });
    }
    nodes.push({ type: "text", text: run.text, ...(marks.length > 0 ? { marks } : {}) });
  }
  return nodes;
}

function encodeList(list: ImportListBlock, options: AdfEncodeOptions): AdfNode {
  return {
    type: list.ordered ? "orderedList" : "bulletList",
    content: list.items.map((item) => {
      const content = encodeBlocks(item.blocks, options);
      if (content.length === 0) content.push({ type: "paragraph", content: [] });
      if (item.child) content.push(encodeList(item.child, options));
      return { type: "listItem", content };
    }),
  };
}

function encodeImage(block: ImportImageBlock, options: AdfEncodeOptions): AdfNode {
  const resolved = options.media?.get(block.assetId);
  return {
    type: "mediaSingle",
    attrs: { layout: "center" },
    content: [{
      type: "media",
      attrs: {
        type: "file",
        id: resolved?.fileId ?? `asset:${block.assetId}`,
        collection: resolved?.collection ?? "",
        ...(block.width ? { width: block.width } : {}),
        ...(block.height ? { height: block.height } : {}),
        ...(block.alt ? { alt: block.alt } : {}),
      },
    }],
  };
}

function encodeBlock(block: ImportBlock, options: AdfEncodeOptions): AdfNode | null {
  switch (block.type) {
    case "heading": {
      const content = encodeRuns(block.runs, options);
      if (block.label) content.unshift({ type: "text", text: `${block.label} ` });
      return { type: "heading", attrs: { level: block.level }, content };
    }
    case "paragraph":
      return { type: "paragraph", content: encodeRuns(block.runs, options) };
    case "list":
      return encodeList(block, options);
    case "table":
      return {
        type: "table",
        attrs: { layout: "default" },
        content: block.rows.map((row) => ({
          type: "tableRow",
          content: row.cells.map((cell) => {
            const content = encodeBlocks(cell.blocks, options);
            if (content.length === 0) content.push({ type: "paragraph", content: [] });
            return {
              type: cell.header ? "tableHeader" : "tableCell",
              attrs: {
                ...(cell.rowspan && cell.rowspan > 1 ? { rowspan: cell.rowspan } : {}),
                ...(cell.colspan && cell.colspan > 1 ? { colspan: cell.colspan } : {}),
              },
              content,
            };
          }),
        })),
      };
    case "image":
      return encodeImage(block, options);
    case "blockquote": {
      const content = encodeBlocks(block.blocks, options);
      return { type: "blockquote", content: content.length > 0 ? content : [{ type: "paragraph", content: [] }] };
    }
    case "disclosure": {
      const content = encodeBlocks(block.blocks, options);
      return {
        type: "expand",
        attrs: { title: block.title },
        content: content.length > 0 ? content : [{ type: "paragraph", content: [] }],
      };
    }
    case "code":
      return { type: "codeBlock", attrs: {}, content: block.text ? [{ type: "text", text: block.text }] : [] };
    case "page-break":
      return null;
  }
}

function encodeBlocks(blocks: ImportBlock[], options: AdfEncodeOptions): AdfNode[] {
  return blocks.flatMap((block) => {
    const encoded = encodeBlock(block, options);
    return encoded ? [encoded] : [];
  });
}

export function documentToAdf(
  document: Pick<ImportProjectionInput, "blocks">,
  options: AdfEncodeOptions = {},
): AdfDocument {
  return { version: 1, type: "doc", content: encodeBlocks(document.blocks, options) };
}
