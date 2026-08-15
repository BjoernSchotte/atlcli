/**
 * Conformance case — the M1 ACCEPTANCE CORPUS, browser leg (spec 011,
 * Benchmarks → "M1 acceptance corpus").
 *
 * Round 2 landed the corpus and the Bun/CLI runner
 * (`scripts/bench/run-m1-acceptance.ts`) but left the browser leg and
 * `digestsMatch` (browser vs CLI) pending. This case closes it: the SAME
 * committed 50-page `ExportPageNode[]` tree — tree scope, labels, `scroll-*`
 * macros, a live-Jira table, a draw.io macro on the placeholder floor — is
 * composed and exported here through the BROWSER engines (real module Worker +
 * Typst WASM, real DOCX zip), and the digests are published so the CLI runner
 * can assert cross-host byte equality.
 *
 * The claim being defended is UMSETZUNGSPLAN's M1 line: the integrated product
 * story runs on CLI **and** harness. A formally green M1 that only ever ran on
 * one host would not be evidence of that.
 *
 * DOCX and PDF digests are emitted separately and `check-parity.ts` compares
 * whichever the CLI side also produces — see `run-m1-acceptance.ts` for how the
 * `digestsMatch` verdict is derived.
 */
import {
  memoryTemplateSource,
  runExport,
  unzipDocx,
} from "@atlcli/docx/browser-entry";
import {
  runPdfExport,
  validatePdfOutput,
  type PdfAssetResolver,
  type PdfExportMetadata,
} from "@atlcli/pdf/browser";
import {
  buildM1Corpus,
  composeM1Document,
  corpusBlockCount,
  DOCX_TEMPLATE_BYTES,
  labelledPageCount,
  M1_CORPUS_VERSION,
} from "./fixture.js";
import { MemoryOutputSink } from "./memory-output.js";
import { HarnessPdfWorkerClient } from "./pdf-worker-client.js";

const compiler = new HarnessPdfWorkerClient();

/** Identical to the CLI runner's metadata — a divergence here would fake a divergence. */
const M1_METADATA: PdfExportMetadata = {
  title: "M1 Acceptance Handbook",
  space: "TEST",
  version: 1,
  author: "Harness Author",
  exporter: "atlcli m1 acceptance",
  language: "en",
  region: "GB",
  exportedAt: new Date("2026-07-17T08:00:00.000Z"),
};

const noAssets: PdfAssetResolver = {
  async resolve(): Promise<never> {
    throw new Error("The M1 corpus has no external assets (the diagram floors offline).");
  },
};

function deterministicClock(): () => number {
  let tick = 0;
  return () => tick++;
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Digest every part of a DOCX package by its DECOMPRESSED bytes.
 *
 * The zip CONTAINER bytes are not comparable across hosts: PizZip deflates
 * through `node:zlib` under Bun and through pako in the browser, so the two
 * archives can be the same length and semantically identical yet differ in a
 * handful of compressed bytes. The decompressed parts are the real contract —
 * if those match, the two hosts produced the same document. This is the DOCX
 * analogue of the raster-content strategy the media parity check uses: compare
 * the thing that carries meaning, not the encoding around it.
 *
 * SCOPE: the part-name SET and each part's decompressed bytes. Names are
 * sorted, so part ORDER within the archive and per-entry zip metadata
 * (timestamps, compression flags, external attributes) are deliberately outside
 * the contract. Nothing is excluded from the digest itself — every key in
 * `zip.files` is digested, so a missing or extra part still diverges.
 */
async function docxPartDigests(bytes: Uint8Array): Promise<Record<string, string>> {
  const zip = unzipDocx(bytes);
  const out: Record<string, string> = {};
  for (const name of Object.keys(zip.files).sort()) {
    const file = zip.file(name);
    if (!file) continue;
    const content = file.asUint8Array();
    out[name] = await sha256Hex(content);
  }
  return out;
}

export interface M1CaseResult {
  compilerVersion: string;
  corpusVersion: number;
  pages: number;
  blockCount: number;
  labelledPages: number;
  composedBlocks: number;
  docx: {
    digest: string;
    byteLength: number;
    deterministic: boolean;
    /** sha256 per DECOMPRESSED zip part — the cross-host comparable surface. */
    partDigests: Record<string, string>;
  };
  pdf: {
    digest: string;
    byteLength: number;
    deterministic: boolean;
    pageCount: number;
    tagged: boolean;
  };
  macroNoteCodes: string[];
  reportNotes: Array<{ code: string; severity: string }>;
  digests: Record<string, string>;
}

async function exportDocx(blocks: Awaited<ReturnType<typeof composeM1Document>>["blocks"]) {
  const output = new MemoryOutputSink();
  const report = await runExport(
    {
      details: {
        id: "m1-root",
        title: "M1 Acceptance Handbook",
        url: "https://example.invalid/wiki/spaces/TEST/pages/m1-root",
        version: 1,
        spaceKey: "TEST",
        storage: "",
        created: "2026-07-17T08:00:00.000Z",
        modified: "2026-07-17T08:00:00.000Z",
        createdBy: { displayName: "Harness Author" },
        modifiedBy: { displayName: "Harness Author" },
        labels: [],
      },
      blocks,
      template: { name: "m1-template.docx", modificationDate: new Date("2026-07-17T08:00:00.000Z") },
      exportDate: new Date("2026-07-17T08:00:00.000Z"),
    },
    { templates: memoryTemplateSource(DOCX_TEMPLATE_BYTES), output },
  );
  return { bytes: output.single.bytes, report };
}

async function exportPdf(blocks: Awaited<ReturnType<typeof composeM1Document>>["blocks"]) {
  const output = new MemoryOutputSink();
  const report = await runPdfExport(
    { blocks, metadata: M1_METADATA, profile: "tagged", filename: "M1 Acceptance Handbook.pdf" },
    { assets: noAssets, compiler, output, now: deterministicClock() },
  );
  return { bytes: output.single.bytes, report };
}

export async function runM1Case(): Promise<M1CaseResult> {
  const corpus = await buildM1Corpus();
  const composed = composeM1Document(corpus);
  const blocks = composed.blocks;

  const docx1 = await exportDocx(blocks);
  const docx2 = await exportDocx(blocks);
  const docxDeterministic = equalBytes(docx1.bytes, docx2.bytes);
  if (!docxDeterministic) throw new Error("The M1 DOCX export was not byte-identical on warm repeat.");

  const pdf1 = await exportPdf(blocks);
  const pdf2 = await exportPdf(blocks);
  const pdfDeterministic = equalBytes(pdf1.bytes, pdf2.bytes);
  if (!pdfDeterministic) throw new Error("The M1 PDF export was not byte-identical on warm repeat.");

  const inspection = validatePdfOutput(pdf1.bytes);
  if (!inspection.tagged) throw new Error("The M1 PDF is not tagged.");

  // The corpus must actually carry the integrated story, not a degenerate tree.
  if (corpus.nodes.length !== 50) throw new Error(`Expected a 50-page M1 corpus, got ${corpus.nodes.length}.`);
  if (labelledPageCount(corpus) === 0) throw new Error("The M1 corpus carries no labelled pages.");

  const digests: Record<string, string> = {
    "m1.docx": await sha256Hex(docx1.bytes),
    "m1.pdf": await sha256Hex(pdf1.bytes),
  };

  return {
    compilerVersion: pdf1.report.compilerVersion,
    corpusVersion: M1_CORPUS_VERSION,
    pages: corpus.nodes.length,
    blockCount: corpusBlockCount(corpus),
    labelledPages: labelledPageCount(corpus),
    composedBlocks: blocks.length,
    docx: {
      digest: digests["m1.docx"]!,
      byteLength: docx1.bytes.byteLength,
      deterministic: docxDeterministic,
      partDigests: await docxPartDigests(docx1.bytes),
    },
    pdf: {
      digest: digests["m1.pdf"]!,
      byteLength: pdf1.bytes.byteLength,
      deterministic: pdfDeterministic,
      pageCount: inspection.pageCount,
      tagged: inspection.tagged,
    },
    macroNoteCodes: [...new Set(corpus.macroNotes.map((n) => n.code))].sort(),
    reportNotes: pdf1.report.notes.map((note) => ({ code: note.code, severity: note.level })),
    digests,
  };
}
