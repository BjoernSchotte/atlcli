/**
 * Deterministic benchmark fixture generator (spec 011, Benchmarks — engine
 * tier). Produces a seeded 500-page tree as `ExportBlock[]` chapters. Same seed
 * → byte-identical JSON; no network, no tenant.
 *
 * This is the ENGINE tier: it starts from already-parsed `ExportBlock[]` and so
 * measures compose/serialize/compile only. It deliberately does NOT exercise
 * storage-XHTML parsing, macro resolution, or asset fetch — that is the
 * end-to-end tier (`run-e2e-bench.ts`) and the M1 acceptance corpus. Keep the
 * two tiers' scopes distinct when reporting the envelope.
 *
 * Run: `bun scripts/bench/generate-fixture.ts [--pages N] [--seed S]`
 * Emits `scripts/bench/out/fixture-<pages>.json` (gitignored).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExportBlock, InlineNode, TableRow } from "@atlcli/confluence";

/** mulberry32 — a tiny, fully deterministic PRNG (no crypto, reproducible). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const LEXICON = [
  "export", "confluence", "document", "chapter", "section", "render", "engine",
  "typst", "docx", "parity", "fixture", "benchmark", "deterministic", "compose",
  "heading", "paragraph", "table", "diagram", "anchor", "orientation",
];

function words(rand: () => number, count: number): string {
  const out: string[] = [];
  for (let i = 0; i < count; i++) out.push(LEXICON[Math.floor(rand() * LEXICON.length)]);
  return out.join(" ");
}

function text(value: string): InlineNode[] {
  return [{ type: "text", text: value }];
}

function prose(rand: () => number): ExportBlock {
  return { type: "paragraph", content: text(words(rand, 24 + Math.floor(rand() * 16))) };
}

function bulletList(rand: () => number): ExportBlock {
  const items = [];
  const n = 3 + Math.floor(rand() * 4);
  for (let i = 0; i < n; i++) {
    items.push({ content: [{ type: "paragraph", content: text(words(rand, 6)) } as ExportBlock] });
  }
  return { type: "list", ordered: false, items };
}

function bigTable(rand: () => number, rows: number, cols: number): ExportBlock {
  const tableRows: TableRow[] = [];
  for (let r = 0; r < rows; r++) {
    const cells = [];
    for (let c = 0; c < cols; c++) {
      cells.push({
        header: r === 0,
        colspan: 1,
        rowspan: 1,
        content: [{ type: "paragraph", content: text(words(rand, 3)) } as ExportBlock],
      });
    }
    tableRows.push({ cells });
  }
  return { type: "table", rows: tableRows };
}

function codeBlock(rand: () => number): ExportBlock {
  const lines: string[] = [];
  const n = 8 + Math.floor(rand() * 8);
  for (let i = 0; i < n; i++) lines.push(`const value_${i} = ${Math.floor(rand() * 1000)};`);
  return { type: "codeBlock", language: "typescript", code: lines.join("\n") };
}

export interface BenchChapter {
  pageId: string;
  title: string;
  /** Attachment filenames this chapter references (resolved by the bench asset port). */
  attachments: string[];
  blocks: ExportBlock[];
}

export interface GenerateBenchOptions {
  pages?: number;
  seed?: number;
}

/**
 * Generate `pages` chapters. Per page: ~3 headings, prose paragraphs, one list;
 * every 10th page a 200-row table; every 25th page a code block + a small
 * deterministic in-memory PNG attachment (resolved by the bench runner's port).
 */
export function generateBenchTree(options: GenerateBenchOptions = {}): {
  seed: number;
  pages: number;
  chapters: BenchChapter[];
} {
  const pages = options.pages ?? 500;
  const seed = options.seed ?? 0x9e3779b9;
  const rand = mulberry32(seed);
  const chapters: BenchChapter[] = [];

  for (let p = 0; p < pages; p++) {
    const blocks: ExportBlock[] = [];
    const attachments: string[] = [];
    blocks.push({ type: "heading", level: 1, content: text(`Chapter ${p + 1}: ${words(rand, 3)}`) });
    blocks.push(prose(rand));
    blocks.push({ type: "heading", level: 2, content: text(words(rand, 3)) });
    blocks.push(prose(rand));
    blocks.push(bulletList(rand));
    blocks.push({ type: "heading", level: 3, content: text(words(rand, 2)) });
    blocks.push(prose(rand));

    if ((p + 1) % 10 === 0) blocks.push(bigTable(rand, 200, 3));
    if ((p + 1) % 25 === 0) {
      blocks.push(codeBlock(rand));
      const filename = `bench-asset-${p + 1}.png`;
      attachments.push(filename);
      blocks.push({ type: "image", source: { kind: "attachment", filename }, alt: `bench figure ${p + 1}` });
    }

    chapters.push({ pageId: `bench-page-${p + 1}`, title: `Chapter ${p + 1}`, attachments, blocks });
  }

  return { seed, pages, chapters };
}

function main(): void {
  const args = process.argv.slice(2);
  const pagesArg = args.indexOf("--pages");
  const seedArg = args.indexOf("--seed");
  const pages = pagesArg >= 0 ? Number(args[pagesArg + 1]) : 500;
  const seed = seedArg >= 0 ? Number(args[seedArg + 1]) : undefined;

  const fixture = generateBenchTree({ pages, seed });
  const outPath = resolve(dirname(fileURLToPath(import.meta.url)), "out", `fixture-${pages}.json`);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(fixture));
  const blockCount = fixture.chapters.reduce((n, c) => n + c.blocks.length, 0);
  process.stdout.write(`generate-fixture: ${fixture.pages} pages, ${blockCount} blocks → ${outPath}\n`);
}

if (import.meta.main) main();
