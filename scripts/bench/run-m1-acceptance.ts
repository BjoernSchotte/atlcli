/**
 * M1 acceptance runner (spec 011, Benchmarks — the M1 milestone gate).
 *
 * Runs the committed 50-page M1 corpus (tree scope + labels + scroll macros +
 * Jira table + diagram macro) through the REAL production path on the Bun/CLI
 * side: `buildM1Corpus` → `composeChapters` → both engines (node DOCX +
 * BrowserPdfCompiler / real Typst WASM), producing a DOCX and a PDF, and emits
 * a machine-readable `m1-acceptance.json` record.
 *
 * Byte stability: each engine is compiled TWICE and the two runs must be
 * byte-identical (deterministic) — the honest, version-independent form of
 * "byte-stable in goldens". Absolute PDF/DOCX bytes are NOT pinned across the
 * repo because they depend on the pinned Typst wasm + font versions (PLAN
 * Risks); the corpus's structural digest IS pinned (see generate-m1-corpus.test).
 *
 * The browser leg now exists too: conformance case `m1`
 * (`apps/browser-export-harness/src/m1-case.ts`) runs the SAME corpus through
 * the browser engines and publishes its digests to
 * `apps/browser-export-harness/test-results/digests.json`. This runner reads
 * that manifest when present and fills `docx.harness` / `pdf.harness` /
 * `digestsMatch`. When the manifest is absent (the harness has not been run in
 * this checkout) the harness fields stay `null` and `digestsMatch` stays `null`
 * — "not measured" is reported as `null`, never as `true`. The LIVE DOCSY
 * acceptance run remains orchestrator territory. Every compile is wrapped in a
 * wall-clock deadline (`compile-timeout`) so a pathological corpus can never
 * hang CI (spec 011 compiler-execution-budget, CI-script scope).
 *
 * Run: `bun scripts/bench/run-m1-acceptance.ts`
 * Emits `scripts/bench/out/m1-acceptance.json` (gitignored).
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PDF_RUNTIME_ASSETS,
  runPdfExport,
  type ExportBlock,
  type PdfAssetResolver,
  type PdfCompilePort,
  type PdfExportMetadata,
} from "@atlcli/pdf";
import { BrowserPdfCompiler } from "@atlcli/pdf-compiler-browser";
import { runExport, type OutputSink } from "@atlcli/docx";
import { unzipDocx } from "@atlcli/docx/scan";
import { memoryTemplateSource } from "@atlcli/docx/browser-runtime";
import {
  buildM1Corpus,
  composeM1Document,
  corpusBlockCount,
  DOCX_TEMPLATE_BYTES,
  labelledPageCount,
  M1_CORPUS_VERSION,
  type M1Corpus,
} from "@atlcli/export-fixtures";
import { ensurePdfFonts } from "../../packages/pdf/scripts/ensure-fonts.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(HERE, "out", "m1-acceptance.json");
const COMPILE_DEADLINE_MS = 300_000;

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

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

class MemorySink implements OutputSink {
  readonly emissions: Array<{ name: string; bytes: Uint8Array }> = [];
  async emit(name: string, bytes: Uint8Array): Promise<void> {
    this.emissions.push({ name, bytes: bytes.slice() });
  }
  get single(): Uint8Array {
    if (this.emissions.length !== 1) throw new Error(`expected one output, got ${this.emissions.length}`);
    return this.emissions[0]!.bytes;
  }
}

async function packageBytes(specifier: string): Promise<Uint8Array> {
  const path = fileURLToPath(import.meta.resolve(specifier));
  return new Uint8Array(await Bun.file(path).arrayBuffer());
}

function deadlineCompiler(inner: PdfCompilePort): PdfCompilePort {
  return {
    async compile(bundle, context) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          const error = new Error(`compile-timeout after ${COMPILE_DEADLINE_MS}ms`);
          (error as Error & { code?: string }).code = "compile-timeout";
          reject(error);
        }, COMPILE_DEADLINE_MS);
      });
      try {
        return await Promise.race([inner.compile(bundle, context), timeout]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    },
  };
}

async function buildCompiler(): Promise<PdfCompilePort> {
  await ensurePdfFonts({ logger: () => {} });
  const [wasm, ...fonts] = await Promise.all([
    packageBytes("@atlcli/pdf-compiler-browser/wasm"),
    ...PDF_RUNTIME_ASSETS.fonts.map((f) => packageBytes(`@atlcli/pdf/fonts/${f.fileName}`)),
  ]);
  const compiler = new BrowserPdfCompiler({
    wasm: wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength) as ArrayBuffer,
    fonts,
  });
  return deadlineCompiler(compiler);
}

async function exportPdf(compiler: PdfCompilePort, blocks: ExportBlock[]): Promise<{ bytes: Uint8Array; version: string; notes: string[] }> {
  const output = new MemorySink();
  const report = await runPdfExport(
    { blocks, metadata: M1_METADATA, profile: "tagged", filename: "M1 Acceptance Handbook.pdf" },
    { assets: noAssets, compiler, output, now: deterministicClock() },
  );
  return { bytes: output.single, version: report.compilerVersion, notes: report.notes.map((n) => n.code) };
}

async function exportDocx(blocks: ExportBlock[]): Promise<{ bytes: Uint8Array; notes: string[] }> {
  const output = new MemorySink();
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
  return { bytes: output.single, notes: report.notes.map((n) => n.code) };
}

function corpusDigest(corpus: M1Corpus): string {
  return createHash("sha256").update(JSON.stringify(corpus.nodes)).digest("hex");
}

const HARNESS_DIGESTS = resolve(HERE, "../../apps/browser-export-harness/test-results/digests.json");

interface HarnessM1Result {
  compilerVersion?: string;
  digests?: Record<string, string>;
  docx?: { byteLength: number; deterministic: boolean; partDigests?: Record<string, string> };
  pdf?: { byteLength: number; deterministic: boolean };
}

/**
 * sha256 per DECOMPRESSED DOCX part — see `m1-case.ts` for why the zip
 * container bytes are not the cross-host contract (PizZip deflates via
 * `node:zlib` here and via pako in the browser; identical documents, a few
 * different compressed bytes). The decompressed parts are what must match.
 */
function docxPartDigests(bytes: Uint8Array): Record<string, string> {
  const zip = unzipDocx(bytes);
  const out: Record<string, string> = {};
  for (const name of Object.keys(zip.files).sort()) {
    const file = zip.file(name);
    if (!file) continue;
    out[name] = sha256Hex(file.asUint8Array());
  }
  return out;
}

/** First differing part name (or a missing/extra part), else `null`. */
export function firstPartDivergence(
  left: Record<string, string>,
  right: Record<string, string>,
): string | null {
  const names = [...new Set([...Object.keys(left), ...Object.keys(right)])].sort();
  for (const name of names) {
    if (left[name] === undefined) return `${name} (missing on the CLI side)`;
    if (right[name] === undefined) return `${name} (missing on the harness side)`;
    if (left[name] !== right[name]) return name;
  }
  return null;
}

/**
 * Read the browser harness's published `m1` case result, if it ran in this
 * checkout. Absent → `null`; the caller reports "not measured" rather than
 * asserting cross-host equality it never checked.
 */
function loadHarnessM1(): HarnessM1Result | null {
  try {
    const manifest = JSON.parse(readFileSync(HARNESS_DIGESTS, "utf8")) as Record<string, HarnessM1Result>;
    return manifest.m1 ?? null;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const corpus = await buildM1Corpus();
  const composed = composeM1Document(corpus);
  const blocks = composed.blocks;

  const docx1 = await exportDocx(blocks);
  const docx2 = await exportDocx(blocks);
  const docxDeterministic = sha256Hex(docx1.bytes) === sha256Hex(docx2.bytes);

  const compiler = await buildCompiler();
  const pdf1 = await exportPdf(compiler, blocks);
  const pdf2 = await exportPdf(compiler, blocks);
  const pdfDeterministic = sha256Hex(pdf1.bytes) === sha256Hex(pdf2.bytes);

  const harness = loadHarnessM1();
  const docxDigest = sha256Hex(docx1.bytes);
  const pdfDigest = sha256Hex(pdf1.bytes);
  const cliParts = docxPartDigests(docx1.bytes);
  // Compare only when the harness ran AND compiled with the same compiler —
  // diffing bytes across compiler versions would report a false divergence.
  const comparable = harness !== null && harness.compilerVersion === pdf1.version;
  // PDF is compared as whole bytes (the Typst compiler is byte-deterministic
  // across hosts). DOCX is compared PART BY PART on decompressed content: the
  // zip container is not byte-comparable across hosts because PizZip's deflate
  // backend differs (node:zlib vs pako), which is an encoding difference, not a
  // document difference. Comparing containers here would report a permanent,
  // meaningless failure; comparing parts catches every real divergence.
  const harnessParts = harness?.docx?.partDigests;
  const docxPartDivergence = comparable && harnessParts ? firstPartDivergence(cliParts, harnessParts) : null;
  const pdfMatches = comparable ? harness!.digests?.["m1.pdf"] === pdfDigest : null;
  const docxPartsMatch = comparable && harnessParts ? docxPartDivergence === null : null;
  const digestsMatch = pdfMatches === null || docxPartsMatch === null ? null : pdfMatches && docxPartsMatch;
  const docxContainerBytesMatch = comparable ? harness!.digests?.["m1.docx"] === docxDigest : null;

  const record = {
    version: M1_CORPUS_VERSION,
    corpusDigest: corpusDigest(corpus),
    pages: corpus.nodes.length,
    blockCount: corpusBlockCount(corpus),
    labelledPages: labelledPageCount(corpus),
    composedBlocks: blocks.length,
    docx: {
      cli: {
        digest: docxDigest,
        byteLength: docx1.bytes.byteLength,
        deterministic: docxDeterministic,
      },
      harness: harness
        ? {
            digest: harness.digests?.["m1.docx"] ?? null,
            byteLength: harness.docx?.byteLength ?? null,
            deterministic: harness.docx?.deterministic ?? null,
          }
        : null,
      /**
       * DOCX cross-host verdict. `partsMatch` is the contract (decompressed
       * parts); `containerBytesMatch` is recorded for transparency and is
       * EXPECTED to be false — PizZip's deflate backend differs by host.
       */
      partsMatch: docxPartsMatch,
      containerBytesMatch: docxContainerBytesMatch,
      firstDivergentPart: docxPartDivergence,
      partCount: Object.keys(cliParts).length,
    },
    pdf: {
      cli: {
        digest: pdfDigest,
        byteLength: pdf1.bytes.byteLength,
        deterministic: pdfDeterministic,
        compilerVersion: pdf1.version,
      },
      harness: harness
        ? {
            digest: harness.digests?.["m1.pdf"] ?? null,
            byteLength: harness.pdf?.byteLength ?? null,
            deterministic: harness.pdf?.deterministic ?? null,
            compilerVersion: harness.compilerVersion ?? null,
          }
        : null,
    },
    /**
     * Cross-host (browser vs CLI) equality: PDF whole-byte AND DOCX
     * decompressed-part equality. `null` = not measured in this checkout (no
     * harness digest manifest, or a compiler-version mismatch that makes a byte
     * diff meaningless) — never silently `true`.
     */
    digestsMatch,
    notes: {
      macro: corpus.macroNotes.map((n) => n.code),
      compose: composed.notes.map((n) => n.code),
      pdf: pdf1.notes,
      docx: docx1.notes,
    },
  };

  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(record, null, 2));

  // A measured cross-host MISMATCH is a hard failure; "not measured" is not.
  const ok = docxDeterministic && pdfDeterministic && digestsMatch !== false;
  const crossHost =
    digestsMatch === null
      ? "cross-host not measured (no harness digests)"
      : `cross-host digestsMatch ${digestsMatch} (pdf bytes ${pdfMatches}, docx parts ${docxPartsMatch}` +
        `${docxPartDivergence ? `, first divergent part ${docxPartDivergence}` : ""})`;
  process.stdout.write(
    `run-m1-acceptance: ${ok ? "OK" : "FAILED"} — ${record.pages} pages, ${record.composedBlocks} composed blocks; ` +
      `DOCX ${record.docx.cli.byteLength}B (det ${docxDeterministic}), PDF ${record.pdf.cli.byteLength}B (det ${pdfDeterministic}, ${pdf1.version}); ` +
      `${crossHost} → ${OUT}\n`,
  );
  if (!ok) process.exit(1);
}

await main();
