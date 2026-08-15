/**
 * Neutral IR → Cloud ADF (atlas_doc_format) encoder for the vertical slice.
 *
 * Deterministic: identical input documents encode to identical ADF JSON, so
 * the preview digest is stable across runs and runtimes.
 */
import type {
  ImportBlock,
  ImportImageBlock,
  ImportListBlock,
  ImportRun,
  ImportedDocument,
} from "./model.js";

/** Uploaded-attachment identity an image block resolves to at publish time. */
export interface AdfMediaResolution {
  /** Attachment `extensions.fileId` / v2 `fileId` — the ADF `media.attrs.id`. */
  fileId: string;
  /** `contentId-<pageId>` collection from the upload response. */
  collection: string;
}

export interface AdfEncodeOptions {
  /**
   * assetId → uploaded identity. Unresolved image blocks encode with the
   * deterministic placeholder id `asset:<assetId>` and an empty collection —
   * valid for previews/digests, never for publication.
   */
  media?: ReadonlyMap<string, AdfMediaResolution>;
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

function encodeList(list: ImportListBlock, options: AdfEncodeOptions): AdfNode {
  return {
    type: list.ordered ? "orderedList" : "bulletList",
    content: list.items.map((item) => {
      const content: AdfNode[] = item.blocks.map((b) => encodeBlock(b, options));
      // ADF list items require at least one block child.
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
    content: [
      {
        type: "media",
        attrs: {
          type: "file",
          id: resolved?.fileId ?? `asset:${block.assetId}`,
          collection: resolved?.collection ?? "",
          ...(block.width ? { width: block.width } : {}),
          ...(block.height ? { height: block.height } : {}),
          ...(block.alt ? { alt: block.alt } : {}),
        },
      },
    ],
  };
}

function encodeBlock(block: ImportBlock, options: AdfEncodeOptions): AdfNode {
  switch (block.type) {
    case "heading":
      return { type: "heading", attrs: { level: block.level }, content: encodeRuns(block.runs) };
    case "paragraph":
      return encodeParagraph(block.runs);
    case "list":
      return encodeList(block, options);
    case "table":
      return {
        type: "table",
        attrs: { layout: "default" },
        content: block.rows.map((row) => ({
          type: "tableRow",
          content: row.cells.map((cell) => {
            const content: AdfNode[] = cell.blocks.map((b) => encodeBlock(b, options));
            if (content.length === 0) content.push({ type: "paragraph", content: [] });
            return { type: cell.header ? "tableHeader" : "tableCell", attrs: {}, content };
          }),
        })),
      };
    case "image":
      return encodeImage(block, options);
  }
}

export function documentToAdf(doc: ImportedDocument, options: AdfEncodeOptions = {}): AdfDocument {
  return { version: 1, type: "doc", content: doc.blocks.map((b) => encodeBlock(b, options)) };
}
