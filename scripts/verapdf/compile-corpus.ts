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
  PDF_RUNTIME_ASSETS,
  runPdfExport,
  type ExportBlock,
  type PdfAssetResolver,
  type PdfCompilePort,
  type PdfExportMetadata,
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
  async emit(_name: string, bytes: Uint8Array): Promise<void> {
    this.bytes = bytes.slice();
  }
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
