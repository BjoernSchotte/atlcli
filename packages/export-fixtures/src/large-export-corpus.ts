/**
 * Deterministic large-export baseline shared by Node and browser hosts.
 *
 * This module is deliberately IO-free and browser-safe. It produces the whole
 * corpus from `(pages, seed)`, including real in-memory image bytes and
 * resolved diagram preview assets; no network, filesystem, canvas, or host
 * globals are needed to construct it.
 */
import type {
  ExportBlock,
  ExportNote,
  ExportPageNode,
  ImageSource,
  TableRow,
} from "@atlcli/confluence/browser";

export const LARGE_EXPORT_CORPUS_SCHEMA = "atlcli.large-export-corpus/1" as const;
export const LARGE_EXPORT_CORPUS_DEFAULT_SEED = 0x9e37_79b9;

export type LargeExportCorpusPageCount = 50 | 500;
export type LargeExportAssetRole = "image" | "diagram";

export interface LargeExportAsset {
  ref: string;
  pageId: string;
  filename: string;
  role: LargeExportAssetRole;
  mediaType: "image/png" | "image/svg+xml";
  bytes: Uint8Array;
}

export interface LargeExportCorpusCounts {
  pages: number;
  blocks: number;
  tables: number;
  tableRows: number;
  resolvedMacros: number;
  imageAssets: number;
  diagramAssets: number;
  assetBytes: number;
  labelledPages: number;
  maxDepth: number;
}

export interface LargeExportCorpus {
  schema: typeof LARGE_EXPORT_CORPUS_SCHEMA;
  seed: number;
  pages: LargeExportCorpusPageCount;
  nodes: ExportPageNode[];
  assets: LargeExportAsset[];
  counts: LargeExportCorpusCounts;
}

export interface GenerateLargeExportCorpusOptions {
  pages: LargeExportCorpusPageCount;
  seed?: number;
}

interface RandomSource {
  next(): number;
  int(maxExclusive: number): number;
}

const WORDS = [
  "anchor",
  "browser",
  "chapter",
  "confluence",
  "diagram",
  "document",
  "export",
  "fixture",
  "hierarchy",
  "image",
  "macro",
  "queue",
  "render",
  "section",
  "spool",
  "table",
  "template",
  "typst",
  "wasm",
  "worker",
] as const;

function randomSource(seed: number): RandomSource {
  let state = seed >>> 0;
  return {
    next(): number {
      state = (state + 0x6d2b_79f5) >>> 0;
      let value = state;
      value = Math.imul(value ^ (value >>> 15), value | 1);
      value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
      return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
    },
    int(maxExclusive: number): number {
      return Math.floor(this.next() * maxExclusive);
    },
  };
}

function words(random: RandomSource, count: number): string {
  const out: string[] = [];
  for (let index = 0; index < count; index += 1) {
    out.push(WORDS[random.int(WORDS.length)]!);
  }
  return out.join(" ");
}

function text(value: string): { type: "text"; text: string }[] {
  return [{ type: "text", text: value }];
}

function paragraph(value: string): ExportBlock {
  return { type: "paragraph", content: text(value) };
}

function tableRows(random: RandomSource, rows: number, prefix: string): TableRow[] {
  const result: TableRow[] = [
    {
      cells: ["Item", "Owner", "State"].map((value) => ({
        header: true,
        colspan: 1,
        rowspan: 1,
        content: [paragraph(value)],
      })),
    },
  ];
  for (let row = 1; row < rows; row += 1) {
    result.push({
      cells: [
        `${prefix}-${row}`,
        words(random, 2),
        ["Ready", "Running", "Waiting"][random.int(3)]!,
      ].map((value) => ({
        header: false,
        colspan: 1,
        rowspan: 1,
        content: [paragraph(value)],
      })),
    });
  }
  return result;
}

function macroNote(pageId: string, macroName: string, message: string): ExportNote {
  return {
    level: "info",
    code: "macro-rendered-via",
    message,
    macroName,
    source: { pageId },
  };
}

function writeUint32(target: Uint8Array, offset: number, value: number): void {
  target[offset] = (value >>> 24) & 0xff;
  target[offset + 1] = (value >>> 16) & 0xff;
  target[offset + 2] = (value >>> 8) & 0xff;
  target[offset + 3] = value & 0xff;
}

function crc32(parts: readonly Uint8Array[]): number {
  let crc = 0xffff_ffff;
  for (const part of parts) {
    for (const byte of part) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit += 1) {
        crc = (crc >>> 1) ^ (0xedb8_8320 & -(crc & 1));
      }
    }
  }
  return (crc ^ 0xffff_ffff) >>> 0;
}

function adler32(bytes: Uint8Array): number {
  let a = 1;
  let b = 0;
  for (const byte of bytes) {
    a = (a + byte) % 65_521;
    b = (b + a) % 65_521;
  }
  return ((b << 16) | a) >>> 0;
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const output = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = new TextEncoder().encode(type);
  const chunk = new Uint8Array(12 + data.byteLength);
  writeUint32(chunk, 0, data.byteLength);
  chunk.set(typeBytes, 4);
  chunk.set(data, 8);
  writeUint32(chunk, 8 + data.byteLength, crc32([typeBytes, data]));
  return chunk;
}

/** A valid 64x64 RGBA PNG using deterministic noise and an uncompressed DEFLATE block. */
function pngBytes(seed: number): Uint8Array {
  const width = 64;
  const height = 64;
  const random = randomSource(seed);
  const raw = new Uint8Array(height * (1 + width * 4));
  let offset = 0;
  for (let y = 0; y < height; y += 1) {
    raw[offset++] = 0;
    for (let x = 0; x < width; x += 1) {
      raw[offset++] = random.int(256);
      raw[offset++] = random.int(256);
      raw[offset++] = random.int(256);
      raw[offset++] = 0xff;
    }
  }

  const deflate = new Uint8Array(2 + 5 + raw.byteLength + 4);
  deflate[0] = 0x78;
  deflate[1] = 0x01;
  deflate[2] = 0x01;
  deflate[3] = raw.byteLength & 0xff;
  deflate[4] = (raw.byteLength >>> 8) & 0xff;
  const complement = (~raw.byteLength) & 0xffff;
  deflate[5] = complement & 0xff;
  deflate[6] = (complement >>> 8) & 0xff;
  deflate.set(raw, 7);
  writeUint32(deflate, 7 + raw.byteLength, adler32(raw));

  const header = new Uint8Array(13);
  writeUint32(header, 0, width);
  writeUint32(header, 4, height);
  header.set([8, 6, 0, 0, 0], 8);
  return concat([
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflate),
    pngChunk("IEND", new Uint8Array()),
  ]);
}

function diagramBytes(pageNumber: number, seed: number): Uint8Array {
  const hue = ((seed >>> 0) + pageNumber * 47) % 360;
  return new TextEncoder().encode(
    `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="240" viewBox="0 0 640 240">` +
      `<rect width="640" height="240" rx="16" fill="hsl(${hue} 45% 94%)"/>` +
      `<g fill="hsl(${hue} 65% 42%)" stroke="hsl(${hue} 70% 25%)" stroke-width="3">` +
      `<rect x="48" y="76" width="144" height="88" rx="12"/>` +
      `<rect x="248" y="76" width="144" height="88" rx="12"/>` +
      `<rect x="448" y="76" width="144" height="88" rx="12"/></g>` +
      `<g stroke="#172B4D" stroke-width="5" fill="none"><path d="M192 120h56"/>` +
      `<path d="M392 120h56"/></g><g fill="#fff" font-family="sans-serif" font-size="18" ` +
      `text-anchor="middle"><text x="120" y="126">Source ${pageNumber}</text>` +
      `<text x="320" y="126">Queue</text><text x="520" y="126">Export</text></g></svg>`,
  );
}

function assetRef(pageId: string, filename: string): string {
  return `${pageId}/${filename}`;
}

function imageBlock(pageId: string, filename: string, alt: string): ExportBlock {
  return {
    type: "image",
    source: { kind: "attachment", pageId, filename },
    alt,
    width: 640,
  };
}

function countBlocks(blocks: readonly ExportBlock[]): number {
  let count = 0;
  const visit = (block: ExportBlock): void => {
    count += 1;
    if (block.type === "callout" || block.type === "orientation") {
      block.content.forEach(visit);
    } else if (block.type === "list") {
      block.items.forEach((item) => item.content.forEach(visit));
    } else if (block.type === "table") {
      block.rows.forEach((row) =>
        row.cells.forEach((cell) => cell.content.forEach(visit)),
      );
    } else if (block.type === "layout") {
      block.columns.forEach((column) => column.content.forEach(visit));
    }
  };
  blocks.forEach(visit);
  return count;
}

/** Build the committed 50- or 500-page large-export baseline. */
export function generateLargeExportCorpus(
  options: GenerateLargeExportCorpusOptions,
): LargeExportCorpus {
  const pages = options.pages;
  const seed = (options.seed ?? LARGE_EXPORT_CORPUS_DEFAULT_SEED) >>> 0;
  const random = randomSource(seed);
  const nodes: ExportPageNode[] = [];
  const assets: LargeExportAsset[] = [];
  const childPositions = new Map<string, number>();
  let sectionId = "large-page-1";
  let subsectionId = sectionId;
  let tables = 0;
  let tableRowCount = 0;
  let resolvedMacros = 0;

  for (let pageNumber = 1; pageNumber <= pages; pageNumber += 1) {
    const pageId = `large-page-${pageNumber}`;
    let depth = 0;
    let parentId: string | null = null;
    if (pageNumber > 1) {
      const offset = (pageNumber - 2) % 25;
      if (offset === 0) {
        depth = 1;
        parentId = "large-page-1";
        sectionId = pageId;
        subsectionId = pageId;
      } else if (offset % 5 === 1) {
        depth = 2;
        parentId = sectionId;
        subsectionId = pageId;
      } else {
        depth = 3;
        parentId = subsectionId;
      }
    }
    const position = parentId === null ? 0 : childPositions.get(parentId) ?? 0;
    if (parentId !== null) childPositions.set(parentId, position + 1);

    const blocks: ExportBlock[] = [
      {
        type: "heading",
        level: 1,
        content: text(`Baseline chapter ${pageNumber}: ${words(random, 3)}`),
      },
      paragraph(words(random, 32 + random.int(17))),
      {
        type: "list",
        ordered: pageNumber % 2 === 0,
        items: Array.from({ length: 3 + random.int(3) }, () => ({
          content: [paragraph(words(random, 7))],
        })),
      },
    ];
    const notes: ExportNote[] = [];

    if (pageNumber % 7 === 0) {
      const rows = pageNumber % 49 === 0 ? 40 : 6;
      blocks.push({
        type: "table",
        rows: tableRows(random, rows, `page-${pageNumber}`),
        columnWidths: [240, 160, 120],
      });
      tables += 1;
      tableRowCount += rows;
    }

    if (pageNumber % 9 === 0) {
      const rows = tableRows(random, 5, `jira-${pageNumber}`);
      blocks.push({ type: "table", rows, columnWidths: [120, 280, 140] });
      notes.push(
        macroNote(pageId, "jira", `Jira macro on page ${pageNumber} resolved to a table.`),
      );
      tables += 1;
      tableRowCount += rows.length;
      resolvedMacros += 1;
    }

    if (pageNumber % 5 === 0) {
      const filename = `photo-${pageNumber}.png`;
      const bytes = pngBytes(seed ^ Math.imul(pageNumber, 0x45d9_f3b));
      blocks.push(imageBlock(pageId, filename, `Deterministic image ${pageNumber}`));
      assets.push({
        ref: assetRef(pageId, filename),
        pageId,
        filename,
        role: "image",
        mediaType: "image/png",
        bytes,
      });
    }

    if (pageNumber % 10 === 0) {
      const filename = `architecture-${pageNumber}.svg`;
      const bytes = diagramBytes(pageNumber, seed);
      blocks.push(imageBlock(pageId, filename, `Resolved architecture diagram ${pageNumber}`));
      notes.push(
        macroNote(
          pageId,
          "drawio",
          `Draw.io macro on page ${pageNumber} resolved to preview attachment ${filename}.`,
        ),
      );
      assets.push({
        ref: assetRef(pageId, filename),
        pageId,
        filename,
        role: "diagram",
        mediaType: "image/svg+xml",
        bytes,
      });
      resolvedMacros += 1;
    }

    if (pageNumber % 13 === 0) {
      blocks.push({
        type: "codeBlock",
        language: "typescript",
        code: `const page_${pageNumber} = ${random.int(10_000)};\nexport { page_${pageNumber} };`,
      });
    }

    nodes.push({
      kind: "page",
      pageId,
      title: `Baseline chapter ${pageNumber}`,
      depth,
      effectiveDepth: depth,
      parentId,
      position,
      blocks,
      notes,
      meta: {
        version: 1 + (pageNumber % 17),
        observedVersion: 1 + (pageNumber % 17),
        labels: pageNumber % 6 === 0 ? ["large-baseline", `cohort-${pageNumber % 4}`] : [],
        spaceKey: "BENCH",
      },
    });
  }

  return {
    schema: LARGE_EXPORT_CORPUS_SCHEMA,
    seed,
    pages,
    nodes,
    assets,
    counts: {
      pages,
      blocks: nodes.reduce((sum, node) => sum + countBlocks(node.blocks), 0),
      tables,
      tableRows: tableRowCount,
      resolvedMacros,
      imageAssets: assets.filter((asset) => asset.role === "image").length,
      diagramAssets: assets.filter((asset) => asset.role === "diagram").length,
      assetBytes: assets.reduce((sum, asset) => sum + asset.bytes.byteLength, 0),
      labelledPages: nodes.filter((node) => node.meta.labels.length > 0).length,
      maxDepth: Math.max(...nodes.map((node) => node.depth)),
    },
  };
}

/** Resolve exactly the attachment identity carried by a corpus image block. */
export function findLargeExportAsset(
  corpus: LargeExportCorpus,
  source: ImageSource,
): LargeExportAsset | undefined {
  if (source.kind !== "attachment" || source.pageId === undefined) return undefined;
  const ref = assetRef(source.pageId, source.filename);
  return corpus.assets.find((asset) => asset.ref === ref);
}

function digestProjection(corpus: LargeExportCorpus): string {
  return JSON.stringify({
    schema: corpus.schema,
    seed: corpus.seed,
    pages: corpus.pages,
    nodes: corpus.nodes,
    assets: corpus.assets.map((asset) => ({
      ref: asset.ref,
      role: asset.role,
      mediaType: asset.mediaType,
      bytes: Array.from(asset.bytes),
    })),
    counts: corpus.counts,
  });
}

/** Browser-native SHA-256 over every structural field and asset byte. */
export async function digestLargeExportCorpus(corpus: LargeExportCorpus): Promise<string> {
  const input = Uint8Array.from(new TextEncoder().encode(digestProjection(corpus)));
  const digest = await crypto.subtle.digest("SHA-256", input);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
