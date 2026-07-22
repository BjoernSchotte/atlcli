/**
 * Reproducible PRE-QUEUE baseline for the current TypeScript DOCX and
 * Typst/WASM PDF paths. Each repetition runs in an isolated Bun process.
 *
 * Run:
 *   bun --conditions=development scripts/bench/run-export-baseline.ts \
 *     --pages 50,500 --formats docx,pdf --repeat 3 --seed 2654435769
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { cpus, hostname, platform, release, totalmem } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { composeChapters, type ExportBlock } from "@atlcli/confluence";
import { runExport, type AssetFetcher, type OutputSink } from "@atlcli/docx";
import { memoryTemplateSource } from "@atlcli/docx/browser-runtime";
import {
  DOCX_TEMPLATE_BYTES,
  digestLargeExportCorpus,
  generateLargeExportCorpus,
  type LargeExportCorpus,
} from "@atlcli/export-fixtures";
import {
  PDF_RUNTIME_ASSETS,
  runPdfExport,
  type PdfAssetResolver,
  type PdfBytesHandle,
  type PdfCompilePort,
  type PdfOutputSink,
} from "@atlcli/pdf";
import { BrowserPdfCompiler } from "@atlcli/pdf-compiler-browser";
import { ensurePdfFonts } from "../../packages/pdf/scripts/ensure-fonts.js";
import {
  EXPORT_BASELINE_SCHEMA,
  logicalCorpusBytes,
  parseExportBaselineArgs,
  type ExportBaselineFormat,
  type ExportBaselinePages,
} from "./export-baseline-contract.js";

const SELF = fileURLToPath(import.meta.url);
const DEFAULT_OUT = resolve(
  dirname(SELF),
  "../../specs/export-expansion/013-isomorphic-export-jobs/baselines/node-pre-queue.json",
);
const CHILD_MARKER = "ATLCLI_EXPORT_BASELINE_CHILD=";

interface HeapBuckets {
  heapUsedBytes: number;
  heapTotalBytes: number;
  externalBytes: number;
  arrayBuffersBytes: number;
  rssBytes: number;
  /** Bun exposes checkpoint RSS, not a reliable process peak. */
  rssPeakBytes: null;
}

interface ChildResult {
  pages: ExportBaselinePages;
  format: ExportBaselineFormat;
  repetition: number;
  seed: number;
  corpusDigest: string;
  counts: LargeExportCorpus["counts"];
  logicalInputBytes: number;
  /** The current CLI path has no durable job/input record before export. */
  persistedInputBytes: null;
  artifactBytes: number;
  artifactSha256: string;
  reportSummary: Record<string, unknown>;
  reportSha256: string;
  setupMs: number;
  corpusAndComposeMs: number;
  corpusFingerprintMs: number;
  exportMs: number;
  hashingMs: number;
  totalMs: number;
  heap: {
    processStart: HeapBuckets;
    engineReady: HeapBuckets;
    corpusPrepared: HeapBuckets;
    artifactHeld: HeapBuckets;
  };
  compilerVersion: string | null;
  noteCodes: string[];
}

class DocxSink implements OutputSink {
  bytes: Uint8Array = new Uint8Array();
  async emit(_name: string, bytes: Uint8Array): Promise<void> {
    this.bytes = bytes;
  }
}

class PdfSink implements PdfOutputSink {
  bytes: Uint8Array = new Uint8Array();
  async emit(_name: string, handle: PdfBytesHandle): Promise<void> {
    this.bytes = await handle.asUint8Array();
  }
}

function noteSummary(notes: readonly { code: string; level: string }[]): Array<{ code: string; level: string; count: number }> {
  const counts = new Map<string, { code: string; level: string; count: number }>();
  for (const note of notes) {
    const key = `${note.level}\u0000${note.code}`;
    const current = counts.get(key) ?? { code: note.code, level: note.level, count: 0 };
    current.count += 1;
    counts.set(key, current);
  }
  return [...counts.values()].sort(
    (left, right) => left.level.localeCompare(right.level) || left.code.localeCompare(right.code),
  );
}

async function sha256(value: Uint8Array | string): Promise<string> {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  const digest = await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function heap(): HeapBuckets {
  const value = process.memoryUsage();
  return {
    heapUsedBytes: value.heapUsed,
    heapTotalBytes: value.heapTotal,
    externalBytes: value.external,
    arrayBuffersBytes: value.arrayBuffers,
    rssBytes: value.rss,
    rssPeakBytes: null,
  };
}

function clock(): () => number {
  let value = 0;
  return () => value++;
}

function assetFor(corpus: LargeExportCorpus, pageId: string | undefined, filename: string): LargeExportCorpus["assets"][number] {
  const exact = corpus.assets.find(
    (asset) => asset.pageId === pageId && asset.filename === filename,
  );
  const unique = corpus.assets.filter((asset) => asset.filename === filename);
  const result = exact ?? (unique.length === 1 ? unique[0] : undefined);
  if (!result) throw new Error(`Baseline asset not found: ${pageId ?? "?"}/${filename}`);
  return result;
}

function docxAssets(corpus: LargeExportCorpus): AssetFetcher {
  return {
    async fetch(ref) {
      if (!ref.filename) throw new Error("DOCX baseline received an asset without filename.");
      return assetFor(corpus, ref.pageId, ref.filename).bytes.slice();
    },
  };
}

function pdfAssets(corpus: LargeExportCorpus): PdfAssetResolver {
  return {
    async resolve(ref) {
      if (!ref.filename) throw new Error("PDF baseline received an asset without filename.");
      const asset = assetFor(corpus, ref.pageId, ref.filename);
      return { bytes: asset.bytes.slice(), mediaType: asset.mediaType, filename: asset.filename };
    },
  };
}

async function packageBytes(specifier: string): Promise<Uint8Array> {
  const path = fileURLToPath(import.meta.resolve(specifier));
  return new Uint8Array(await Bun.file(path).arrayBuffer());
}

async function buildCompiler(): Promise<BrowserPdfCompiler> {
  await ensurePdfFonts({ logger: () => {} });
  const [wasm, ...fonts] = await Promise.all([
    packageBytes("@atlcli/pdf-compiler-browser/wasm"),
    ...PDF_RUNTIME_ASSETS.fonts.map((font) => packageBytes(`@atlcli/pdf/fonts/${font.fileName}`)),
  ]);
  return new BrowserPdfCompiler({
    wasm: wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength) as ArrayBuffer,
    fonts,
  });
}

async function exportDocx(corpus: LargeExportCorpus, blocks: ExportBlock[]): Promise<{ bytes: Uint8Array; noteCodes: string[]; reportSummary: Record<string, unknown> }> {
  const output = new DocxSink();
  const report = await runExport(
    {
      details: {
        id: "large-page-1",
        title: `Large export baseline (${corpus.pages} pages)`,
        url: "https://example.invalid/wiki/spaces/BENCH/pages/large-page-1",
        version: 1,
        spaceKey: "BENCH",
        storage: "",
        created: "2026-07-22T00:00:00.000Z",
        modified: "2026-07-22T00:00:00.000Z",
        createdBy: { displayName: "Baseline" },
        modifiedBy: { displayName: "Baseline" },
        labels: [],
      },
      blocks,
      template: {
        name: "pre-queue-baseline.docx",
        modificationDate: new Date("2026-07-22T00:00:00.000Z"),
      },
      exportDate: new Date("2026-07-22T00:00:00.000Z"),
      assets: docxAssets(corpus),
    },
    { templates: memoryTemplateSource(DOCX_TEMPLATE_BYTES), output },
  );
  return {
    bytes: output.bytes,
    noteCodes: [...new Set(report.notes.map((note) => note.code))].sort(),
    reportSummary: {
      filename: report.filename,
      resolvedCount: report.resolvedCount,
      unsupportedNames: [...report.unsupportedNames].sort(),
      skippedImages: report.skippedImages,
      embeddedImages: report.embeddedImages,
      renderedDiagrams: report.renderedDiagrams,
      complete: report.complete,
      notes: noteSummary(report.notes),
    },
  };
}

async function exportPdf(
  compiler: PdfCompilePort,
  corpus: LargeExportCorpus,
  blocks: ExportBlock[],
): Promise<{ bytes: Uint8Array; noteCodes: string[]; compilerVersion: string; reportSummary: Record<string, unknown> }> {
  const output = new PdfSink();
  const report = await runPdfExport(
    {
      blocks,
      metadata: {
        title: `Large export baseline (${corpus.pages} pages)`,
        space: "BENCH",
        version: 1,
        exporter: "atlcli PRE-QUEUE baseline",
        exportedAt: new Date("2026-07-22T00:00:00.000Z"),
      },
      profile: "tagged",
      filename: `large-export-${corpus.pages}.pdf`,
    },
    { assets: pdfAssets(corpus), compiler, output, now: clock() },
  );
  return {
    bytes: output.bytes,
    noteCodes: [...new Set(report.notes.map((note) => note.code))].sort(),
    compilerVersion: report.compilerVersion,
    reportSummary: {
      filename: report.filename,
      profile: report.profile,
      compilerVersion: report.compilerVersion,
      pageCount: report.pageCount ?? null,
      embeddedImages: report.embeddedImages,
      renderedDiagrams: report.renderedDiagrams,
      skippedAssets: report.skippedAssets,
      complete: report.complete,
      compilerDiagnosticCount: report.compilerDiagnostics?.length ?? 0,
      notes: noteSummary(report.notes),
    },
  };
}

async function runChild(
  pages: ExportBaselinePages,
  format: ExportBaselineFormat,
  repetition: number,
  seed: number,
): Promise<ChildResult> {
  const totalStarted = performance.now();
  const processStart = heap();
  const setupStarted = performance.now();
  const compiler = format === "pdf" ? await buildCompiler() : null;
  const setupMs = performance.now() - setupStarted;
  const engineReady = heap();

  const corpusStarted = performance.now();
  const corpus = generateLargeExportCorpus({ pages, seed });
  const composed = composeChapters(corpus.nodes);
  const corpusAndComposeMs = performance.now() - corpusStarted;
  const fingerprintStarted = performance.now();
  const logicalInputByteLength = logicalCorpusBytes(corpus);
  const corpusDigest = await digestLargeExportCorpus(corpus);
  const corpusFingerprintMs = performance.now() - fingerprintStarted;
  const corpusPrepared = heap();

  const exportStarted = performance.now();
  const result =
    format === "docx"
      ? await exportDocx(corpus, composed.blocks)
      : await exportPdf(compiler!, corpus, composed.blocks);
  const exportMs = performance.now() - exportStarted;
  const artifactHeld = heap();
  const hashingStarted = performance.now();
  const artifactSha256 = await sha256(result.bytes);
  const reportSha256 = await sha256(JSON.stringify(result.reportSummary));
  const hashingMs = performance.now() - hashingStarted;
  await compiler?.reset();

  return {
    pages,
    format,
    repetition,
    seed,
    corpusDigest,
    counts: corpus.counts,
    logicalInputBytes: logicalInputByteLength,
    persistedInputBytes: null,
    artifactBytes: result.bytes.byteLength,
    artifactSha256,
    reportSummary: result.reportSummary,
    reportSha256,
    setupMs,
    corpusAndComposeMs,
    corpusFingerprintMs,
    exportMs,
    hashingMs,
    totalMs: performance.now() - totalStarted,
    heap: { processStart, engineReady, corpusPrepared, artifactHeld },
    compilerVersion:
      "compilerVersion" in result && typeof result.compilerVersion === "string"
        ? result.compilerVersion
        : null,
    noteCodes: result.noteCodes,
  };
}

function gitCommit(): string | null {
  const result = Bun.spawnSync(["git", "rev-parse", "HEAD"], { stdout: "pipe", stderr: "ignore" });
  return result.exitCode === 0 ? result.stdout.toString().trim() : null;
}

function workingTreeDirty(): boolean | null {
  const result = Bun.spawnSync(["git", "status", "--porcelain"], { stdout: "pipe", stderr: "ignore" });
  return result.exitCode === 0 ? result.stdout.byteLength > 0 : null;
}

async function runParent(): Promise<void> {
  const options = parseExportBaselineArgs(process.argv.slice(2));
  const results: ChildResult[] = [];
  for (const pages of options.pages) {
    for (const format of options.formats) {
      for (let repetition = 1; repetition <= options.repeat; repetition += 1) {
        const child = Bun.spawn(
          [
            process.execPath,
            "--conditions=development",
            SELF,
            "--child",
            "--pages",
            String(pages),
            "--formats",
            format,
            "--repeat",
            String(repetition),
            "--seed",
            String(options.seed),
          ],
          { stdout: "pipe", stderr: "inherit" },
        );
        const stdout = await new Response(child.stdout).text();
        const exitCode = await child.exited;
        if (exitCode !== 0) throw new Error(`Baseline child failed (${pages}/${format}/${repetition}).`);
        const line = stdout.split("\n").find((entry) => entry.startsWith(CHILD_MARKER));
        if (!line) throw new Error(`Baseline child emitted no result (${pages}/${format}/${repetition}).`);
        results.push(JSON.parse(line.slice(CHILD_MARKER.length)) as ChildResult);
      }
    }
  }
  const report = {
    schema: EXPORT_BASELINE_SCHEMA,
    measuredAt: new Date().toISOString(),
    shape: "node-cli",
    state: "pre-queue",
    environment: {
      gitCommit: gitCommit(),
      workingTreeDirty: workingTreeDirty(),
      runtime: `Bun ${Bun.version}`,
      platform: platform(),
      release: release(),
      architecture: process.arch,
      hostname: hostname(),
      cpu: cpus()[0]?.model ?? null,
      logicalCpuCount: cpus().length,
      totalMemoryBytes: totalmem(),
    },
    configuration: options,
    observability: {
      heapBuckets: "process.memoryUsage checkpoints; synchronous in-stage peaks are not observable",
      rssPeakBytes: null,
      persistedInputBytes: null,
      persistedInputReason: "the current CLI export path does not persist a durable background-job input",
      artifactBytes: "exact emitted Uint8Array byteLength",
    },
    results,
  };
  const out = resolve(options.out ?? DEFAULT_OUT);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Wrote ${out}`);
}

if (process.argv.includes("--child")) {
  const options = parseExportBaselineArgs(process.argv.slice(2));
  const repetition = Number(process.argv[process.argv.indexOf("--repeat") + 1]);
  const result = await runChild(options.pages[0]!, options.formats[0]!, repetition, options.seed);
  console.log(`${CHILD_MARKER}${JSON.stringify(result)}`);
} else {
  await runParent();
}
