/**
 * Runtime candidate-lane child (issue #118 Phase 2): run ONE candidate Typst
 * runtime over the materialized image-heavy corpus in an isolated process.
 *
 *   bun --conditions=development scripts/bench/runtime-lane-child.ts forward-port <corpusDir>
 *
 * The pipeline is IDENTICAL for every candidate (prepare original →
 * serialize → compile); only the runtime differs, so differences are
 * attributable to the runtime alone (PLAN.md: no pipeline changes in a
 * runtime lane). Reports WASM linear-memory high-water via the same
 * register hook the Chrome harness uses, plus per-phase wall times.
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { composeChapters } from "@atlcli/confluence";
import type { ExportBlock } from "@atlcli/confluence/browser";
import {
  findLargeExportAsset,
  generateLargeExportCorpus,
  generateMixedExportCorpus,
  resolveMixedExportAsset,
} from "@atlcli/export-fixtures";
import {
  PDF_RUNTIME_ASSETS,
  preparePdfDocument,
  type PdfAssetResolver,
} from "@atlcli/pdf/browser";
import { serializePdfDocument } from "@atlcli/pdf/internal";
import { BrowserPdfCompiler } from "@atlcli/pdf-compiler-browser";

const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));

const candidate = process.argv[2];
const corpusArg = process.argv[3];
if (candidate !== "forward-port" || !corpusArg) {
  throw new Error(
    "Usage: runtime-lane-child.ts forward-port <corpusDir|text-heavy|mixed>",
  );
}

// Benchmark-only budget seam (the ≥100 MiB corpus exceeds product caps by
// design; identical hook the Chrome harness installs).
(globalThis as typeof globalThis & Record<symbol, unknown>)[
  Symbol.for("atlcli.pdf.benchmark-asset-budget")
] = { maxAssetBytes: 32 * 1024 * 1024, maxTotalBytes: 512 * 1024 * 1024 };

let wasmMemory: WebAssembly.Memory | undefined;
(globalThis as typeof globalThis & Record<symbol, unknown>)[
  Symbol.for("atlcli.pdf-compiler-browser.memory-probe.register-wasm-memory")
] = (memory: WebAssembly.Memory) => {
  wasmMemory = memory;
};

interface CorpusManifest {
  scale: number;
  manifestSha256: string;
  manifest: Array<{ filename: string; mediaType: string }>;
}

let blocks: ExportBlock[];
let resolver: PdfAssetResolver;
let corpusLabel: string;
let corpusIdentity: string;
if (corpusArg === "mixed") {
  const corpus = generateMixedExportCorpus();
  blocks = corpus.blocks;
  resolver = {
    async resolve(ref) {
      if (ref.kind !== "attachment" || !ref.filename) {
        throw new Error("mixed corpus resolves named attachments only");
      }
      const asset = resolveMixedExportAsset(corpus, {
        filename: ref.filename,
        ...(ref.pageId ? { pageId: ref.pageId } : {}),
      });
      return {
        bytes: asset.bytes,
        mediaType: asset.mediaType,
        filename: asset.filename,
      };
    },
  };
  corpusLabel = "mixed-default";
  corpusIdentity = corpus.identity;
} else if (corpusArg === "text-heavy") {
  // Text-heavy recipe (plan corpus table): the deterministic 500-page tree —
  // headings, tables, code, links, outlines, only occasional tiny images —
  // isolating layout/Typst high-water from raster decode pressure.
  const corpus = generateLargeExportCorpus({ pages: 500 });
  blocks = composeChapters(corpus.nodes).blocks;
  resolver = {
    async resolve(ref) {
      if (ref.kind !== "attachment" || !ref.filename) {
        throw new Error("text-heavy corpus resolves named attachments only");
      }
      const asset = findLargeExportAsset(corpus, {
        kind: "attachment",
        filename: ref.filename,
        ...(ref.pageId ? { pageId: ref.pageId } : {}),
      });
      if (!asset) throw new Error(`Missing text-heavy asset ${ref.filename}`);
      return {
        bytes: asset.bytes,
        mediaType: asset.mediaType,
        filename: asset.filename,
      };
    },
  };
  corpusLabel = "text-heavy-500";
  corpusIdentity = `${corpus.schema}:${corpus.pages}:${corpus.seed}`;
} else {
  const manifest = JSON.parse(
    readFileSync(join(corpusArg, "manifest.json"), "utf8"),
  ) as CorpusManifest;
  blocks = JSON.parse(
    readFileSync(join(corpusArg, "blocks.json"), "utf8"),
  ) as ExportBlock[];
  const assets = new Map<string, { bytes: Uint8Array; mediaType: string }>(
    manifest.manifest.map((entry) => [
      entry.filename,
      {
        bytes: new Uint8Array(readFileSync(join(corpusArg, entry.filename))),
        mediaType: entry.mediaType,
      },
    ]),
  );
  resolver = {
    async resolve(ref) {
      const asset = assets.get(ref.filename ?? "");
      if (!asset) throw new Error(`Missing corpus asset ${ref.filename}`);
      return {
        bytes: asset.bytes,
        mediaType: asset.mediaType,
        filename: ref.filename,
      };
    },
  };
  corpusLabel = `image-heavy@${manifest.scale}`;
  corpusIdentity = manifest.manifestSha256;
}

const fonts = PDF_RUNTIME_ASSETS.fonts.map(
  (font) =>
    new Uint8Array(
      readFileSync(join(ROOT, "packages/pdf/.fonts", font.fileName)),
    ),
);

const prepareStarted = performance.now();
const prepared = await preparePdfDocument(blocks, resolver);
const bundle = serializePdfDocument(prepared, {
  metadata: {
    title: "Runtime lane corpus",
    space: "DOCSY",
    version: 1,
    exporter: "atlcli runtime lane",
    exportedAt: new Date("2026-07-27T00:00:00.000Z"),
  },
  settings: { cover: false, outline: true },
});
const prepareMs = performance.now() - prepareStarted;

let pdfBytes = 0;
let compileMs = 0;
let compilerVersion = "";
{
  const wasm = readFileSync(
    join(
      ROOT,
      "packages/pdf-compiler-browser/vendor/typst-ts-web-compiler/pkg/typst_ts_web_compiler_bg.wasm",
    ),
  );
  const compiler = new BrowserPdfCompiler({
    wasm: wasm.buffer as ArrayBuffer,
    fonts,
  });
  const started = performance.now();
  const result = await compiler.compile(bundle);
  compileMs = performance.now() - started;
  if (!result.pdf)
    throw new Error(
      `baseline compile failed: ${JSON.stringify(result.diagnostics)}`,
    );
  pdfBytes = result.pdf.byteLength;
  compilerVersion = result.compilerVersion;
}

console.log(
  `ATLCLI_RUNTIME_LANE_CHILD ${JSON.stringify({
    candidate,
    compilerVersion,
    corpus: corpusLabel,
    corpusIdentity,
    bundleAssetBytes: bundle.assets.reduce(
      (total, asset) => total + asset.bytes.byteLength,
      0,
    ),
    pdfBytes,
    prepareMs: Math.round(prepareMs),
    compileMs: Math.round(compileMs),
    wasmHighWaterMiB: wasmMemory
      ? Number((wasmMemory.buffer.byteLength / 1048576).toFixed(2))
      : null,
  })}`,
);
