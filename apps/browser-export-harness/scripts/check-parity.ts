/**
 * Shape-parity gate (spec 011, T4.x — the single most important deliverable of
 * this lane; spec 012's start is gated on it landing).
 *
 * The browser harness (Playwright) runs the shared `@atlcli/export-fixtures`
 * through the BROWSER export packages (real module Worker + Typst WASM) and
 * writes a digest manifest to `test-results/digests.json`. This script runs the
 * SAME fixtures through the Bun/CLI export path — the identical
 * `BrowserPdfCompiler` (same pinned wasm + fonts) the CLI uses via
 * `getPdfCompiler` — computes the same digests, and asserts byte-level and
 * report-projection equivalence. A divergence names the case and the first
 * divergent digest or report code.
 *
 * PDF parity covers every emits-digests case: `pdf-settings` (007), the
 * feature-lane cases `blocks` (001), `scope` (002), `content-compat` (003) and
 * `macros` (004), and `manuscript` (012 — the second curated template, compiled
 * under BOTH manifests). Each runs the SAME fixture block-builders from
 * `@atlcli/export-fixtures` on both hosts, so byte-identity is the contract.
 *
 * Everything is real: no mocks, real Typst compile, real fonts. Every compile is
 * wrapped in a wall-clock deadline (`compile-timeout`) so a pathological fixture
 * can never hang CI (spec 011 compiler-execution-budget, CI-script scope).
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PDF_RUNTIME_ASSETS,
  runPdfExport,
  validatePdfOutput,
  type ExportBlock,
  type ExportNote,
  type PdfAssetResolver,
  type PdfCompilePort,
  type PdfExportMetadata,
} from "@atlcli/pdf";
import { MANUSCRIPT_PDF_TEMPLATE_MANIFEST } from "@atlcli/pdf/internal";
import {
  BrowserPdfCompiler,
  type BrowserPdfCompilerFontSourceV1,
} from "@atlcli/pdf-compiler-browser";
import {
  BLOCKS_ALL_FIELDS,
  BLOCKS_METADATA,
  composeScopeDocument,
  contentCompatBlocks,
  CONTENT_COMPAT_METADATA,
  MACRO_METADATA,
  MANUSCRIPT_BLOCKS,
  MANUSCRIPT_FILENAME,
  MANUSCRIPT_METADATA,
  PDF_SETTINGS_A,
  PDF_SETTINGS_B,
  PDF_SETTINGS_BLOCKS,
  PDF_SETTINGS_METADATA,
  resolveMacroFixtureBlocks,
  SCOPE_METADATA,
} from "@atlcli/export-fixtures";
import { ensurePdfFonts } from "../../../packages/pdf/scripts/ensure-fonts.js";
import { MemoryOutputSink } from "../src/memory-output.js";
import { runDocxTemplateIntakeFlow } from "../src/docx-template-intake-flow.js";
import { buildPdfV4RuntimeFixture } from "../src/pdf-v4-runtime-fixture.js";
import {
  compareReportProjection,
  compareStructuredParity,
  projectNotes,
  sha256Hex,
} from "./parity-compare.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const DIGEST_MANIFEST = resolve(HERE, "../test-results/digests.json");
const COMPILE_DEADLINE_MS = 120_000;

const noAssets: PdfAssetResolver = {
  async resolve(): Promise<never> {
    throw new Error("The deterministic parity fixture has no external assets.");
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

/** A compile port with a wall-clock deadline — a hang becomes a `compile-timeout`. */
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

async function buildBunCompiler(): Promise<PdfCompilePort> {
  await ensurePdfFonts({ logger: () => {} });
  const wasm = await packageBytes("@atlcli/pdf-compiler-browser/wasm");
  const fonts = PDF_RUNTIME_ASSETS.fonts.map(
    (font): BrowserPdfCompilerFontSourceV1 => ({
      assetId: font.assetId,
      sha256: font.sha256,
      load: () => packageBytes(`@atlcli/pdf/fonts/${font.fileName}`),
    }),
  );
  const compiler = new BrowserPdfCompiler({
    wasm: wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength) as ArrayBuffer,
    fonts,
  });
  return deadlineCompiler(compiler);
}

interface CliCaseResult {
  compilerVersion: string;
  digests: Record<string, string>;
  notes: Array<{ code: string; level: string }>;
  parity?: Readonly<Record<string, unknown>>;
}

/** The canonical (parity-shared) PDF export request — identical to the harness. */
async function cliCompile(
  compiler: PdfCompilePort,
  blocks: ExportBlock[],
  metadata: PdfExportMetadata,
  filename: string,
  sourceNotes: ExportNote[] = [],
): Promise<{ bytes: Uint8Array; version: string; notes: Array<{ code: string; level: string }> }> {
  const output = new MemoryOutputSink();
  const report = await runPdfExport(
    { blocks, metadata, profile: "tagged", filename, sourceNotes },
    { assets: noAssets, compiler, output, now: deterministicClock() },
  );
  return {
    bytes: output.single.bytes,
    version: report.compilerVersion,
    notes: report.notes.map((n) => ({ code: n.code, level: n.level })),
  };
}

async function runPdfSettingsCli(compiler: PdfCompilePort): Promise<CliCaseResult> {
  // Two settings variants (A/B) — the same pair the browser case emits digests
  // for. Each threads its own `settings` through the shared request shape.
  const compileVariant = async (
    settings: typeof PDF_SETTINGS_A,
    templatePack?: Awaited<ReturnType<typeof buildPdfV4RuntimeFixture>>["runtime"]
  ) => {
    const output = new MemoryOutputSink();
    const report = await runPdfExport(
      {
        blocks: PDF_SETTINGS_BLOCKS,
        metadata: PDF_SETTINGS_METADATA,
        settings,
        profile: "tagged",
        filename: "PDF Settings Conformance.pdf",
        ...(templatePack ? { templatePack } : {}),
      },
      { assets: noAssets, compiler, output, now: deterministicClock() },
    );
    return { bytes: output.single.bytes, report };
  };
  const a = await compileVariant(PDF_SETTINGS_A);
  const b = await compileVariant(PDF_SETTINGS_B);
  const v4 = await buildPdfV4RuntimeFixture();
  const runtimeRender = await compileVariant(PDF_SETTINGS_A, v4.runtime);
  return {
    compilerVersion: a.report.compilerVersion,
    digests: {
      "variant-a.pdf": sha256Hex(a.bytes),
      "variant-b.pdf": sha256Hex(b.bytes),
      "runtime-v4.wiki-pdf-template": sha256Hex(v4.packBytes),
      "runtime-v4.pdf": sha256Hex(runtimeRender.bytes),
    },
    notes: a.report.notes.map((n) => ({ code: n.code, level: n.level })),
    parity: {
      runtimeSnapshot: structuredClone(v4.runtime.runtimeSnapshot),
      runtimeInspection: validatePdfOutput(runtimeRender.bytes),
      runtimeReportNotes: runtimeRender.report.notes.map(({ code, level }) => ({
        code,
        level,
      })),
    },
  };
}

async function runBlocksCli(compiler: PdfCompilePort): Promise<CliCaseResult> {
  const r = await cliCompile(compiler, BLOCKS_ALL_FIELDS, BLOCKS_METADATA, "Block Model Coverage.pdf");
  return { compilerVersion: r.version, digests: { "blocks.pdf": sha256Hex(r.bytes) }, notes: r.notes };
}

async function runScopeCli(compiler: PdfCompilePort): Promise<CliCaseResult> {
  const composed = composeScopeDocument();
  const r = await cliCompile(compiler, composed.blocks, SCOPE_METADATA, "Handbook.pdf");
  return { compilerVersion: r.version, digests: { "scope.pdf": sha256Hex(r.bytes) }, notes: r.notes };
}

async function runContentCli(compiler: PdfCompilePort): Promise<CliCaseResult> {
  const parsed = contentCompatBlocks("pdf");
  const r = await cliCompile(compiler, parsed.blocks, CONTENT_COMPAT_METADATA, "Content Compatibility.pdf");
  return { compilerVersion: r.version, digests: { "content-compat.pdf": sha256Hex(r.bytes) }, notes: r.notes };
}

async function runMacroCli(compiler: PdfCompilePort): Promise<CliCaseResult> {
  const resolved = await resolveMacroFixtureBlocks("pdf");
  const r = await cliCompile(compiler, resolved.blocks, MACRO_METADATA, "Macro Coverage.pdf", resolved.notes);
  return { compilerVersion: r.version, digests: { "macros.pdf": sha256Hex(r.bytes) }, notes: r.notes };
}

/**
 * Spec 012 T6.5 — the Manuscript curated template. Compiles the same fixture
 * under BOTH manifests, exactly as the browser case does, so parity covers the
 * second template's bytes and not just the default one's. A CLI/browser split
 * here would mean the curated-template path diverges by host, which is the one
 * thing a "second template needs zero new engine code" claim cannot survive.
 */
async function runManuscriptCli(compiler: PdfCompilePort): Promise<CliCaseResult> {
  const compileWith = async (templateManifest?: typeof MANUSCRIPT_PDF_TEMPLATE_MANIFEST) => {
    const output = new MemoryOutputSink();
    const report = await runPdfExport(
      {
        blocks: MANUSCRIPT_BLOCKS,
        metadata: MANUSCRIPT_METADATA,
        profile: "tagged",
        filename: MANUSCRIPT_FILENAME,
        ...(templateManifest ? { templateManifest } : {}),
      },
      { assets: noAssets, compiler, output, now: deterministicClock() },
    );
    return { bytes: output.single.bytes, report };
  };
  const manuscript = await compileWith(MANUSCRIPT_PDF_TEMPLATE_MANIFEST);
  const builtin = await compileWith();
  return {
    compilerVersion: manuscript.report.compilerVersion,
    digests: {
      "manuscript.pdf": sha256Hex(manuscript.bytes),
      "manuscript-builtin.pdf": sha256Hex(builtin.bytes),
    },
    notes: manuscript.report.notes.map((n) => ({ code: n.code, level: n.level })),
  };
}

async function runDocxTemplateIntakeCli(
  _compiler: PdfCompilePort
): Promise<CliCaseResult> {
  // The browser case owns a dedicated module Worker. Use an equally fresh Bun
  // compiler here so preview byte parity cannot depend on caches warmed by an
  // unrelated conformance case.
  const { result } = await runDocxTemplateIntakeFlow(
    await buildBunCompiler()
  );
  return {
    compilerVersion: result.compilerVersion,
    digests: result.digests,
    notes: result.reportNotes.map(({ code, severity }) => ({
      code,
      level: severity,
    })),
    parity: result.parity,
  };
}

/**
 * Every PDF parity case: id → CLI-side runner producing the same digests as the
 * browser.
 *
 * The `m1` case also emits digests but is deliberately NOT listed here: its
 * consumer is `scripts/bench/run-m1-acceptance.ts`, which compares the DOCX
 * side part-by-part on DECOMPRESSED content. A whole-container DOCX byte
 * comparison would fail permanently and meaninglessly — PizZip deflates through
 * `node:zlib` under Bun and pako in the browser, so identical documents yield a
 * few different compressed bytes. This gate only ever compares whole bytes, so
 * `m1` belongs to the runner that knows the right strategy.
 */
const PARITY_CASES: Record<string, (compiler: PdfCompilePort) => Promise<CliCaseResult>> = {
  "pdf-settings": runPdfSettingsCli,
  "docx-template-intake": runDocxTemplateIntakeCli,
  blocks: runBlocksCli,
  scope: runScopeCli,
  "content-compat": runContentCli,
  macros: runMacroCli,
  manuscript: runManuscriptCli,
};

interface BrowserCaseResult {
  compilerVersion: string;
  digests: Record<string, string>;
  reportNotes: Array<{ code: string; severity?: string; level?: string }>;
  parity?: Readonly<Record<string, unknown>>;
}

function loadBrowserManifest(): Record<string, BrowserCaseResult> | null {
  try {
    return JSON.parse(readFileSync(DIGEST_MANIFEST, "utf8"));
  } catch {
    return null;
  }
}

function fail(lines: string[]): never {
  for (const line of lines) process.stderr.write(`check-parity: ${line}\n`);
  process.exit(1);
}

function compareCase(id: string, browser: BrowserCaseResult | undefined, cli: CliCaseResult): string[] {
  const failures: string[] = [];
  if (!browser) {
    failures.push(`case ${id}: missing from the browser digest manifest`);
    return failures;
  }
  if (browser.compilerVersion !== cli.compilerVersion) {
    failures.push(
      `case ${id}: compiler version mismatch (browser ${browser.compilerVersion} vs cli ${cli.compilerVersion}) — refusing to diff bytes`,
    );
    return failures;
  }
  const digestKeys = new Set([
    ...Object.keys(browser.digests ?? {}),
    ...Object.keys(cli.digests),
  ]);
  for (const key of [...digestKeys].sort()) {
    const b = browser.digests?.[key];
    const c = cli.digests[key];
    if (b !== c) {
      failures.push(`case ${id}: "${key}" digest differs (browser ${String(b).slice(0, 16)} vs cli ${c.slice(0, 16)})`);
    }
  }
  if (browser.parity !== undefined || cli.parity !== undefined) {
    for (const detail of compareStructuredParity(browser.parity, cli.parity)) {
      failures.push(`case ${id}: contract${detail}`);
    }
  }
  for (const detail of compareReportProjection(
    projectNotes(browser.reportNotes ?? []),
    projectNotes(cli.notes),
  )) {
    failures.push(`case ${id}: ${detail}`);
  }
  return failures;
}

async function main(): Promise<void> {
  const compiler = await buildBunCompiler();
  const cliResults: Record<string, CliCaseResult> = {};
  for (const [id, run] of Object.entries(PARITY_CASES)) cliResults[id] = await run(compiler);

  const manifest = loadBrowserManifest();
  if (!manifest) {
    process.stdout.write(
      "check-parity: browser digest manifest not found at test-results/digests.json.\n" +
        "Run the Playwright harness first (`bun run test:browser-export-harness`).\n" +
        `CLI-side digests: ${JSON.stringify(
          Object.fromEntries(Object.entries(cliResults).map(([id, r]) => [id, r.digests])),
        )}\n`,
    );
    process.exit(1);
  }

  const failures: string[] = [];
  for (const [id, cli] of Object.entries(cliResults)) {
    failures.push(...compareCase(id, manifest[id], cli));
  }

  if (failures.length > 0) fail(failures);
  const ids = Object.keys(cliResults).join(", ");
  process.stdout.write(
    `check-parity: OK — byte + report parity holds for [${ids}] (${cliResults.blocks.compilerVersion})\n`,
  );
}

await main();
