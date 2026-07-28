import wasmUrl from "@atlcli/pdf-compiler-browser/wasm?url";
import sansRegularUrl from "@atlcli/pdf/fonts/SourceSans3-Regular.ttf?url";
import sansItalicUrl from "@atlcli/pdf/fonts/SourceSans3-It.ttf?url";
import sansSemiBoldUrl from "@atlcli/pdf/fonts/SourceSans3-Semibold.ttf?url";
import sansBoldUrl from "@atlcli/pdf/fonts/SourceSans3-Bold.ttf?url";
import serifRegularUrl from "@atlcli/pdf/fonts/SourceSerif4-Regular.ttf?url";
import serifItalicUrl from "@atlcli/pdf/fonts/SourceSerif4-It.ttf?url";
import serifSemiBoldUrl from "@atlcli/pdf/fonts/SourceSerif4-Semibold.ttf?url";
import serifBoldUrl from "@atlcli/pdf/fonts/SourceSerif4-Bold.ttf?url";
import codeRegularUrl from "@atlcli/pdf/fonts/SourceCodePro-Regular.ttf?url";
import codeBoldUrl from "@atlcli/pdf/fonts/SourceCodePro-Bold.ttf?url";
import symbolsRegularUrl from "@atlcli/pdf/fonts/NotoSansSymbols2-Regular.ttf?url";
import emojiRegularUrl from "@atlcli/pdf/fonts/NotoEmoji-wght.ttf?url";
import { composeChapters, type ExportBlock } from "@atlcli/confluence/browser";
import {
  memoryTemplateSource,
  runExport,
  type AssetFetcher,
  type OutputSink,
} from "@atlcli/docx/browser-entry";
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
  type PdfOutputSink,
} from "@atlcli/pdf/browser";
import { BrowserPdfCompiler } from "@atlcli/pdf-compiler-browser";
import type {
  BrowserBaselineExportResult,
  BrowserBaselineFormat,
  BrowserBaselinePrepareResult,
  BrowserExportBaselineApi,
} from "./protocol.js";

const fontUrls = new Map<string, string>([
  ["SourceSans3-Regular.ttf", sansRegularUrl],
  ["SourceSans3-It.ttf", sansItalicUrl],
  ["SourceSans3-Semibold.ttf", sansSemiBoldUrl],
  ["SourceSans3-Bold.ttf", sansBoldUrl],
  ["SourceSerif4-Regular.ttf", serifRegularUrl],
  ["SourceSerif4-It.ttf", serifItalicUrl],
  ["SourceSerif4-Semibold.ttf", serifSemiBoldUrl],
  ["SourceSerif4-Bold.ttf", serifBoldUrl],
  ["SourceCodePro-Regular.ttf", codeRegularUrl],
  ["SourceCodePro-Bold.ttf", codeBoldUrl],
  ["NotoSansSymbols2-Regular.ttf", symbolsRegularUrl],
  ["NotoEmoji-wght.ttf", emojiRegularUrl],
]);

let corpus: LargeExportCorpus | undefined;
let blocks: ExportBlock[] | undefined;
let compilerPromise: Promise<BrowserPdfCompiler> | undefined;
let artifact: Uint8Array | undefined;

class DocxSink implements OutputSink {
  bytes: Uint8Array<ArrayBufferLike> = new Uint8Array();
  async emit(_name: string, bytes: Uint8Array): Promise<void> {
    this.bytes = bytes;
  }
}

class PdfSink implements PdfOutputSink {
  bytes: Uint8Array<ArrayBufferLike> = new Uint8Array();
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

function output(message: string): void {
  const element = document.querySelector<HTMLOutputElement>("[data-testid=baseline-state]");
  if (element) element.textContent = message;
}

function logicalInputBytes(value: LargeExportCorpus): number {
  return (
    new TextEncoder().encode(JSON.stringify(value.nodes)).byteLength +
    value.assets.reduce((sum, asset) => sum + asset.bytes.byteLength, 0)
  );
}

function assetFor(pageId: string | undefined, filename: string): LargeExportCorpus["assets"][number] {
  if (!corpus) throw new Error("Prepare the corpus before resolving assets.");
  const exact = corpus.assets.find(
    (asset) => asset.pageId === pageId && asset.filename === filename,
  );
  const unique = corpus.assets.filter((asset) => asset.filename === filename);
  const result = exact ?? (unique.length === 1 ? unique[0] : undefined);
  if (!result) throw new Error(`Baseline asset not found: ${pageId ?? "?"}/${filename}`);
  return result;
}

const docxAssets: AssetFetcher = {
  async fetch(ref) {
    if (!ref.filename) throw new Error("DOCX baseline received an asset without filename.");
    return assetFor(ref.pageId, ref.filename).bytes.slice();
  },
};

const pdfAssets: PdfAssetResolver = {
  async resolve(ref) {
    if (!ref.filename) throw new Error("PDF baseline received an asset without filename.");
    const asset = assetFor(ref.pageId, ref.filename);
    return { bytes: asset.bytes.slice(), mediaType: asset.mediaType, filename: asset.filename };
  },
};

async function fetchBytes(url: string): Promise<Uint8Array<ArrayBuffer>> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Baseline runtime asset failed to load (${response.status}).`);
  return new Uint8Array(await response.arrayBuffer());
}

function compiler(): Promise<BrowserPdfCompiler> {
  compilerPromise ??= Promise.all([
    fetchBytes(wasmUrl),
    ...PDF_RUNTIME_ASSETS.fonts.map((asset) => fetchBytes(fontUrls.get(asset.fileName)!)),
  ]).then(([wasm, ...fonts]) => new BrowserPdfCompiler({ wasm: wasm.buffer, fonts }));
  return compilerPromise;
}

async function setup(format: BrowserBaselineFormat): Promise<{ setupMs: number }> {
  const started = performance.now();
  if (format === "pdf") await compiler();
  return { setupMs: performance.now() - started };
}

function clock(): () => number {
  let value = 0;
  return () => value++;
}

async function prepare(options: { pages: 50 | 500; seed: number }): Promise<BrowserBaselinePrepareResult> {
  const corpusStarted = performance.now();
  corpus = generateLargeExportCorpus(options);
  const composed = composeChapters(corpus.nodes);
  blocks = composed.blocks;
  const corpusAndComposeMs = performance.now() - corpusStarted;
  const fingerprintStarted = performance.now();
  const bytes = logicalInputBytes(corpus);
  const corpusDigest = await digestLargeExportCorpus(corpus);
  const corpusFingerprintMs = performance.now() - fingerprintStarted;
  output(`prepared:${options.pages}`);
  return {
    pages: options.pages,
    seed: options.seed,
    corpusDigest,
    counts: corpus.counts,
    composedBlocks: blocks.length,
    logicalInputBytes: bytes,
    persistedInputBytes: null,
    corpusAndComposeMs,
    corpusFingerprintMs,
  };
}

interface RawExportResult {
  bytes: Uint8Array;
  compilerVersion: string | null;
  noteCodes: string[];
  reportSummary: Record<string, unknown>;
}

async function exportDocx(): Promise<RawExportResult> {
  if (!corpus || !blocks) throw new Error("Prepare the corpus before exporting.");
  const sink = new DocxSink();
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
      assets: docxAssets,
    },
    { templates: memoryTemplateSource(DOCX_TEMPLATE_BYTES), output: sink },
  );
  const reportSummary = {
    filename: report.filename,
    resolvedCount: report.resolvedCount,
    unsupportedNames: [...report.unsupportedNames].sort(),
    skippedImages: report.skippedImages,
    embeddedImages: report.embeddedImages,
    renderedDiagrams: report.renderedDiagrams,
    complete: report.complete,
    notes: noteSummary(report.notes),
  };
  return {
    bytes: sink.bytes,
    compilerVersion: null,
    noteCodes: [...new Set(report.notes.map((note) => note.code))].sort(),
    reportSummary,
  };
}

async function exportPdf(): Promise<RawExportResult> {
  if (!corpus || !blocks) throw new Error("Prepare the corpus before exporting.");
  const sink = new PdfSink();
  const report = await runPdfExport(
    {
      blocks,
      metadata: {
        title: `Large export baseline (${corpus.pages} pages)`,
        space: "BENCH",
        version: 1,
        exporter: "atlcli Chrome PRE-QUEUE baseline",
        exportedAt: new Date("2026-07-22T00:00:00.000Z"),
      },
      profile: "tagged",
      filename: `large-export-${corpus.pages}.pdf`,
    },
    { assets: pdfAssets, compiler: await compiler(), output: sink, now: clock() },
  );
  const reportSummary = {
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
  };
  return {
    bytes: sink.bytes,
    compilerVersion: report.compilerVersion,
    noteCodes: [...new Set(report.notes.map((note) => note.code))].sort(),
    reportSummary,
  };
}

async function run(format: BrowserBaselineFormat): Promise<BrowserBaselineExportResult> {
  const started = performance.now();
  const raw = format === "docx" ? await exportDocx() : await exportPdf();
  const exportMs = performance.now() - started;
  // Keep the exact emitted bytes strongly reachable until the CDP
  // artifactHeld checkpoint and explicit cleanup.
  artifact = raw.bytes;
  const hashingStarted = performance.now();
  const artifactSha256 = await sha256(artifact);
  const reportSha256 = await sha256(JSON.stringify(raw.reportSummary));
  const hashingMs = performance.now() - hashingStarted;
  const value = {
    format,
    exportMs,
    artifactBytes: artifact.byteLength,
    artifactSha256,
    persistedArtifactBytes: null,
    compilerVersion: raw.compilerVersion,
    noteCodes: raw.noteCodes,
    reportSummary: raw.reportSummary,
    reportSha256,
    hashingMs,
  } satisfies BrowserBaselineExportResult;
  output(`complete:${format}:${value.artifactBytes}`);
  return value;
}

async function cleanup(): Promise<void> {
  corpus = undefined;
  blocks = undefined;
  artifact = undefined;
}

window.atlcliExportBaseline = {
  setup,
  prepare,
  run,
  heldArtifactBytes: () => artifact?.byteLength ?? 0,
  cleanup,
} satisfies BrowserExportBaselineApi;
output("ready");
