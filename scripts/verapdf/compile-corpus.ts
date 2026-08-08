/**
 * veraPDF corpus compiler (spec 011, PDF/UA). Compiles a small conformance
 * corpus — a minimal known-good CANARY plus representative fixtures — to REAL
 * tagged PDFs with the same pinned Typst WASM + fonts the CLI uses, writing them
 * to `scripts/verapdf/out/` (gitignored). The self-skipping veraPDF ratchet
 * (`verapdf.ratchet.test.ts`) runs the official veraPDF CLI over these when the
 * tool is present; this compile step itself needs no veraPDF and runs offline.
 *
 * Every compile is wrapped in a wall-clock deadline (`compile-timeout`) so a
 * pathological fixture can never hang CI (spec 011 compiler-execution-budget).
 *
 * Run: `bun scripts/verapdf/compile-corpus.ts`
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PDF_OUTPUT_STANDARDS_V1,
  PDF_RUNTIME_ASSETS,
  runPdfExport,
  type ExportBlock,
  type PdfAssetResolver,
  type PdfCompilePort,
  type PdfExportMetadata,
  type PdfBytesHandle,
  type PdfOutputStandardV1,
} from "@atlcli/pdf";
import { BrowserPdfCompiler } from "@atlcli/pdf-compiler-browser";
import {
  BLOCKS_ALL_FIELDS,
  BLOCKS_METADATA,
  PDF_SETTINGS_A,
  PDF_SETTINGS_BLOCKS,
  PDF_SETTINGS_METADATA,
} from "@atlcli/export-fixtures";
import { ensurePdfFonts } from "../../packages/pdf/scripts/ensure-fonts.js";

const HERE = dirname(fileURLToPath(import.meta.url));
export const VERAPDF_OUT_DIR = resolve(HERE, "out");
const COMPILE_DEADLINE_MS = 180_000;

/** A minimal, known-good fixture — the canary that catches a broken veraPDF pin. */
const CANARY_BLOCKS: ExportBlock[] = [
  { type: "heading", level: 1, content: [{ type: "text", text: "Canary" }] },
  { type: "paragraph", content: [{ type: "text", text: "A minimal tagged PDF for the veraPDF self-check." }] },
];
const CANARY_METADATA: PdfExportMetadata = {
  title: "veraPDF Canary",
  space: "TEST",
  version: 1,
  author: "atlcli",
  exporter: "atlcli verapdf corpus",
  language: "en",
  region: "GB",
  exportedAt: new Date("2026-07-17T08:00:00.000Z"),
};

/** The corpus: id → {blocks, metadata, settings?}. Small so veraPDF stays fast. */
export const VERAPDF_CORPUS: ReadonlyArray<{
  id: string;
  blocks: ExportBlock[];
  metadata: PdfExportMetadata;
  settings?: typeof PDF_SETTINGS_A;
}> = [
  { id: "canary", blocks: CANARY_BLOCKS, metadata: CANARY_METADATA },
  { id: "blocks", blocks: BLOCKS_ALL_FIELDS, metadata: BLOCKS_METADATA },
  { id: "pdf-settings-a", blocks: PDF_SETTINGS_BLOCKS, metadata: PDF_SETTINGS_METADATA, settings: PDF_SETTINGS_A },
];

export const VERAPDF_FLAVOUR_BY_STANDARD: Readonly<
  Record<PdfOutputStandardV1, string>
> = {
  "a-1b": "1b",
  "a-1a": "1a",
  "a-2b": "2b",
  "a-2u": "2u",
  "a-2a": "2a",
  "a-3b": "3b",
  "a-3u": "3u",
  "a-3a": "3a",
  "a-4": "4",
  "a-4f": "4f",
  "a-4e": "4e",
  "ua-1": "ua1",
};

export interface VeraPdfStandardFixture {
  id: string;
  path: string;
  standard: PdfOutputStandardV1;
  flavour: string;
  expectedCompliant: boolean;
  compilerVersion: string;
}

const noAssets: PdfAssetResolver = {
  async resolve(): Promise<never> {
    throw new Error("The veraPDF corpus has no external assets.");
  },
};

function deterministicClock(): () => number {
  let tick = 0;
  return () => tick++;
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

export async function buildCompiler(): Promise<PdfCompilePort> {
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

class MemorySink {
  bytes: Uint8Array | null = null;
  // `bytes` is a PdfBytesHandle since spec 010 T5.6; this harness wants the array.
  async emit(_name: string, bytes: PdfBytesHandle): Promise<void> {
    this.bytes = (await bytes.asUint8Array()).slice();
  }
}

async function compileFixture(
  compiler: PdfCompilePort,
  filename: string,
  outputPolicy?: {
    schema: "atlcli.pdf-output-policy/1";
    standards: readonly [PdfOutputStandardV1];
  },
): Promise<{ bytes: Uint8Array; compilerVersion: string }> {
  const output = new MemorySink();
  const report = await runPdfExport(
    {
      blocks: CANARY_BLOCKS,
      metadata: CANARY_METADATA,
      filename,
      ...(outputPolicy === undefined ? { profile: "tagged" as const } : { outputPolicy }),
    },
    { assets: noAssets, compiler, output, now: deterministicClock() },
  );
  if (!output.bytes) throw new Error(`corpus fixture "${filename}" produced no PDF`);
  return { bytes: output.bytes, compilerVersion: report.compilerVersion };
}

/**
 * Compile one neutral document for every product-facing Typst standard plus a
 * deliberately non-conforming PDF/A-2b canary. The invalid fixture is compiled
 * without a standard request, so veraPDF must reject it while still producing
 * a healthy, parseable validation report.
 */
export async function compileStandardCorpus(): Promise<VeraPdfStandardFixture[]> {
  const compiler = await buildCompiler();
  mkdirSync(VERAPDF_OUT_DIR, { recursive: true });
  const fixtures: VeraPdfStandardFixture[] = [];

  for (const standard of PDF_OUTPUT_STANDARDS_V1) {
    const id = `standard-${standard}`;
    const filename = `${id}.pdf`;
    const compiled = await compileFixture(compiler, filename, {
      schema: "atlcli.pdf-output-policy/1",
      standards: [standard],
    });
    const path = resolve(VERAPDF_OUT_DIR, filename);
    writeFileSync(path, compiled.bytes);
    fixtures.push({
      id,
      path,
      standard,
      flavour: VERAPDF_FLAVOUR_BY_STANDARD[standard],
      expectedCompliant: true,
      compilerVersion: compiled.compilerVersion,
    });
  }

  const invalidId = "invalid-a-2b";
  const invalid = await compileFixture(compiler, `${invalidId}.pdf`);
  const invalidPath = resolve(VERAPDF_OUT_DIR, `${invalidId}.pdf`);
  writeFileSync(invalidPath, invalid.bytes);
  fixtures.push({
    id: invalidId,
    path: invalidPath,
    standard: "a-2b",
    flavour: VERAPDF_FLAVOUR_BY_STANDARD["a-2b"],
    expectedCompliant: false,
    compilerVersion: invalid.compilerVersion,
  });

  return fixtures;
}

/** Compile the whole corpus to `out/<id>.pdf`; returns the file paths. */
export async function compileCorpus(): Promise<string[]> {
  const compiler = await buildCompiler();
  mkdirSync(VERAPDF_OUT_DIR, { recursive: true });
  const paths: string[] = [];
  for (const item of VERAPDF_CORPUS) {
    const output = new MemorySink();
    await runPdfExport(
      { blocks: item.blocks, metadata: item.metadata, settings: item.settings, profile: "tagged", filename: `${item.id}.pdf` },
      { assets: noAssets, compiler, output, now: deterministicClock() },
    );
    if (!output.bytes) throw new Error(`corpus fixture "${item.id}" produced no PDF`);
    const path = resolve(VERAPDF_OUT_DIR, `${item.id}.pdf`);
    writeFileSync(path, output.bytes);
    paths.push(path);
  }
  return paths;
}

if (import.meta.main) {
  const paths = await compileCorpus();
  process.stdout.write(`compile-corpus: wrote ${paths.length} PDFs to ${VERAPDF_OUT_DIR}\n`);
}
