/**
 * ENGINE-TIER benchmark runner (spec 011, Benchmarks).
 *
 * ## What this tier measures
 *
 * The seeded 500-page fixture from `generate-fixture.ts` starts life as
 * already-parsed `ExportBlock[]`. From there this runner times, as separate
 * phases:
 *
 *   - `compose` — `ExportPageNode[]` → `composeChapters` (spec 002),
 *   - `docx`    — DOCX serialize + zip through the real `runExport`,
 *   - `pdf`     — PDF serialize + compile through the REAL Typst WASM compiler.
 *
 * ## What this tier does NOT measure
 *
 * Storage-XHTML parsing, macro resolution, tree fetch/transfer, or any network
 * asset path. Those are the end-to-end tier (`run-e2e-bench.ts`). Reporting an
 * engine-tier number as "atlcli exports a 500-page tree in X" would be a
 * category error — see `src/content/docs/reference/export-performance.md`.
 *
 * ## Process model (this is the RSS methodology)
 *
 * Invoked with no `--phase`, this script is the PARENT: it re-invokes itself
 * once per phase as a child under `/usr/bin/time`, so each phase's
 * `peakRssBytes` is the whole-process peak of a process that ran only that
 * phase. It then runs one more child with `--phase all`, whose peak becomes the
 * run-level `wholeProcessPeakRssBytes`. A `baseline` phase (build the fixture,
 * load wasm + fonts + template, do no work) is always measured so a reader can
 * subtract the runtime/asset floor instead of guessing at it. No number here
 * comes from in-process heap sampling. See `bench-env.ts` for the full rationale.
 *
 * Run: `bun scripts/bench/run-bench.ts [--pages 500] [--seed S] [--repeat 3]`
 * Emits `scripts/bench/out/bench-engine.json` (gitignored).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  composeChapters,
  type ExportBlock,
  type ExportPageNode,
} from "@atlcli/confluence";
import { runExport, type OutputSink } from "@atlcli/docx";
import { memoryTemplateSource } from "@atlcli/docx/browser-runtime";
import { DOCX_TEMPLATE_BYTES } from "@atlcli/export-fixtures";
import {
  PDF_RUNTIME_ASSETS,
  runPdfExport,
  type PdfCompilePort,
  type PdfExportMetadata,
} from "@atlcli/pdf";
import { BrowserPdfCompiler } from "@atlcli/pdf-compiler-browser";
import { ensurePdfFonts } from "../../packages/pdf/scripts/ensure-fonts.js";
import { benchDocxAssets, benchPdfAssets } from "./bench-assets.js";
import {
  collectEnvironment,
  datasetDigest,
  emitPhaseResult,
  gitCommit,
  maxOrNull,
  median,
  parsePhaseResult,
  runMeasured,
  type BenchEnvironment,
  type RssMethod,
} from "./bench-env.js";
import { generateBenchTree, type BenchChapter } from "./generate-fixture.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(HERE, "out", "bench-engine.json");
const SELF = fileURLToPath(import.meta.url);
/** A phase child that outlives this is a hang, not a slow machine. */
const PHASE_TIMEOUT_MS = 30 * 60_000;

export const ENGINE_PHASES = ["baseline", "compose", "docx", "pdf"] as const;
export type EnginePhase = (typeof ENGINE_PHASES)[number];

const BENCH_METADATA: PdfExportMetadata = {
  title: "Engine Tier Benchmark",
  space: "BENCH",
  version: 1,
  author: "Bench Author",
  exporter: "atlcli engine benchmark",
  language: "en",
  region: "GB",
  exportedAt: new Date("2026-07-17T08:00:00.000Z"),
};

function deterministicClock(): () => number {
  let tick = 0;
  return () => tick++;
}

class MemorySink implements OutputSink {
  bytes: Uint8Array = new Uint8Array(0);
  async emit(_name: string, bytes: Uint8Array): Promise<void> {
    this.bytes = bytes;
  }
}

/** Lift the bench fixture's chapters into the `ExportPageNode[]` compose input. */
export function benchChaptersToNodes(chapters: readonly BenchChapter[]): ExportPageNode[] {
  return chapters.map((chapter, index) => ({
    kind: "page" as const,
    pageId: chapter.pageId,
    title: chapter.title,
    depth: index === 0 ? 0 : 1,
    effectiveDepth: index === 0 ? 0 : 1,
    parentId: index === 0 ? null : chapters[0]!.pageId,
    position: index,
    blocks: chapter.blocks,
    notes: [],
    meta: { labels: [], spaceKey: "BENCH" },
  }));
}

async function buildCompiler(): Promise<PdfCompilePort> {
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

async function packageBytes(specifier: string): Promise<Uint8Array> {
  const path = fileURLToPath(import.meta.resolve(specifier));
  return new Uint8Array(await Bun.file(path).arrayBuffer());
}

function uniqueCodes(notes: readonly { code: string }[]): string[] {
  return [...new Set(notes.map((n) => n.code))].sort();
}

async function serializeDocx(blocks: ExportBlock[]): Promise<{ bytes: Uint8Array; noteCodes: string[] }> {
  const output = new MemorySink();
  const report = await runExport(
    {
      details: {
        id: "bench-root",
        title: "Engine Tier Benchmark",
        url: "https://example.invalid/wiki/spaces/BENCH/pages/bench-root",
        version: 1,
        spaceKey: "BENCH",
        storage: "",
        created: "2026-07-17T08:00:00.000Z",
        modified: "2026-07-17T08:00:00.000Z",
        createdBy: { displayName: "Bench Author" },
        modifiedBy: { displayName: "Bench Author" },
        labels: [],
      },
      blocks,
      template: { name: "bench-template.docx", modificationDate: new Date("2026-07-17T08:00:00.000Z") },
      exportDate: new Date("2026-07-17T08:00:00.000Z"),
      assets: benchDocxAssets,
    },
    { templates: memoryTemplateSource(DOCX_TEMPLATE_BYTES), output },
  );
  return { bytes: output.bytes, noteCodes: uniqueCodes(report.notes) };
}

async function serializePdf(
  compiler: PdfCompilePort,
  blocks: ExportBlock[],
): Promise<{ bytes: Uint8Array; noteCodes: string[] }> {
  const output = new MemorySink();
  const report = await runPdfExport(
    { blocks, metadata: BENCH_METADATA, profile: "tagged", filename: "Engine Tier Benchmark.pdf" },
    { assets: benchPdfAssets, compiler, output, now: deterministicClock() },
  );
  return { bytes: output.bytes, noteCodes: uniqueCodes(report.notes) };
}

// ---------------------------------------------------------------------------
// Child mode: run one phase (or all of them) in this process
// ---------------------------------------------------------------------------

export interface PhaseResult {
  phase: string;
  /** In-process wall-clock ms for the phase WORK only (setup excluded). */
  ms: number;
  /** Bytes of the artifact this phase produced (0 for setup-only phases). */
  outputBytes: number;
  pages: number;
  blockCount: number;
  /** Report/parse note codes this phase produced, deduplicated — a silently
   *  skipped image would show up here rather than as a quietly faster number. */
  noteCodes: string[];
}

async function runPhaseInProcess(phase: EnginePhase | "all", pages: number, seed: number): Promise<PhaseResult[]> {
  const fixture = generateBenchTree({ pages, seed });
  const nodes = benchChaptersToNodes(fixture.chapters);
  const blockCount = fixture.chapters.reduce((n, c) => n + c.blocks.length, 0);
  const results: PhaseResult[] = [];
  const wants = (p: EnginePhase): boolean => phase === "all" || phase === p;

  // Setup common to the measured phases; deliberately OUTSIDE every `ms`.
  const needsCompiler = wants("pdf") || phase === "baseline";
  const compiler = needsCompiler ? await buildCompiler() : undefined;
  if (phase === "baseline") {
    // Everything is loaded and the tree is built; no export work is performed.
    // This phase's peak RSS is the floor the other phases sit on top of.
    results.push({ phase: "baseline", ms: 0, outputBytes: 0, pages, blockCount, noteCodes: [] });
    return results;
  }

  let composed: ExportBlock[] | undefined;
  if (wants("compose") || wants("docx") || wants("pdf")) {
    const started = performance.now();
    const result = composeChapters(nodes);
    const ms = performance.now() - started;
    composed = result.blocks;
    if (wants("compose")) {
      results.push({
        phase: "compose",
        ms,
        outputBytes: JSON.stringify(result.blocks).length,
        pages,
        blockCount,
        noteCodes: uniqueCodes(result.notes),
      });
    }
  }

  if (wants("docx")) {
    const started = performance.now();
    const docx = await serializeDocx(composed!);
    results.push({
      phase: "docx",
      ms: performance.now() - started,
      outputBytes: docx.bytes.byteLength,
      pages,
      blockCount,
      noteCodes: docx.noteCodes,
    });
  }

  if (wants("pdf")) {
    const started = performance.now();
    const pdf = await serializePdf(compiler!, composed!);
    results.push({
      phase: "pdf",
      ms: performance.now() - started,
      outputBytes: pdf.bytes.byteLength,
      pages,
      blockCount,
      noteCodes: pdf.noteCodes,
    });
  }

  return results;
}

// ---------------------------------------------------------------------------
// Parent mode: one child per phase, measured
// ---------------------------------------------------------------------------

export interface BenchPhaseRecord extends PhaseResult {
  /** Whole-process peak RSS of the child that ran ONLY this phase. */
  peakRssBytes: number | null;
  rssMethod: RssMethod;
  /** Wall-clock ms of that whole child process (setup + phase work). */
  processMs: number;
  /** Per-repeat phase-work samples, before the median. */
  samplesMs: number[];
}

export interface BenchRecord {
  tier: "engine";
  commit: string;
  date: string;
  pages: number;
  seed: number;
  repeat: number;
  datasetDigest: string;
  environment: BenchEnvironment;
  phases: BenchPhaseRecord[];
  wholeRun: {
    /** Sum of the phase-work ms measured inside the single all-phases child. */
    ms: number;
    processMs: number;
    /** THE whole-process number: one process that did every phase. */
    wholeProcessPeakRssBytes: number | null;
    rssMethod: RssMethod;
  };
}

function spawnPhase(phase: string, pages: number, seed: number) {
  // `--conditions=development` is required for in-repo workspace resolution
  // (spec 009): without it the child resolves the packages' `dist` barrels,
  // which may not be built — the phase would fail for the wrong reason.
  const measured = runMeasured(
    "bun",
    ["--conditions=development", SELF, "--phase", phase, "--pages", String(pages), "--seed", String(seed)],
    { timeoutMs: PHASE_TIMEOUT_MS },
  );
  if (measured.exitCode !== 0) {
    process.stderr.write(measured.stderr);
    throw new Error(`bench phase "${phase}" failed with exit code ${measured.exitCode}`);
  }
  const results = parsePhaseResult<PhaseResult[]>(measured.stdout);
  if (!results) throw new Error(`bench phase "${phase}" emitted no result line`);
  return { measured, results };
}

async function runParent(pages: number, seed: number, repeat: number): Promise<BenchRecord> {
  const fixture = generateBenchTree({ pages, seed });
  const environment = await collectEnvironment();

  const phases: BenchPhaseRecord[] = [];
  for (const phase of ENGINE_PHASES) {
    const samples: PhaseResult[][] = [];
    const measurements = [];
    for (let i = 0; i < repeat; i++) {
      const run = spawnPhase(phase, pages, seed);
      samples.push(run.results);
      measurements.push(run.measured);
      process.stderr.write(`  ${phase} run ${i + 1}/${repeat}: ${run.measured.ms.toFixed(0)}ms process\n`);
    }
    // A phase child emits exactly one result (its own phase).
    const last = samples[samples.length - 1]![0]!;
    phases.push({
      ...last,
      samplesMs: samples.map((s) => s[0]!.ms),
      ms: median(samples.map((s) => s[0]!.ms)),
      processMs: median(measurements.map((m) => m.ms)),
      peakRssBytes: maxOrNull(measurements.map((m) => m.peakRssBytes)),
      rssMethod: measurements[0]!.rssMethod,
    });
  }

  process.stderr.write("  all (whole-process RSS run)\n");
  const whole = spawnPhase("all", pages, seed);
  const wholeMs = whole.results.reduce((n, r) => n + r.ms, 0);

  return {
    tier: "engine",
    commit: gitCommit(),
    date: new Date().toISOString(),
    pages,
    seed,
    repeat,
    datasetDigest: datasetDigest(fixture),
    environment,
    phases,
    wholeRun: {
      ms: wholeMs,
      processMs: whole.measured.ms,
      wholeProcessPeakRssBytes: whole.measured.peakRssBytes,
      rssMethod: whole.measured.rssMethod,
    },
  };
}

function mb(bytes: number | null): string {
  return bytes === null ? "n/a" : `${(bytes / 1024 / 1024).toFixed(0)}MB`;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const flag = (name: string): string | undefined => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const pages = Number(flag("--pages") ?? 500);
  const seed = Number(flag("--seed") ?? 0x9e3779b9);
  const repeat = Number(flag("--repeat") ?? 1);
  const phase = flag("--phase");

  if (phase) {
    if (phase !== "all" && !ENGINE_PHASES.includes(phase as EnginePhase)) {
      throw new Error(`unknown phase "${phase}" (expected: ${[...ENGINE_PHASES, "all"].join(", ")})`);
    }
    emitPhaseResult(await runPhaseInProcess(phase as EnginePhase | "all", pages, seed));
    return;
  }

  process.stderr.write(`run-bench (engine tier): ${pages} pages, seed ${seed}, repeat ${repeat}\n`);
  const record = await runParent(pages, seed, repeat);
  const outPath = flag("--out") ?? OUT;
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(record, null, 2));

  for (const p of record.phases) {
    process.stdout.write(
      `run-bench ${p.phase.padEnd(8)} ${p.ms.toFixed(0).padStart(8)}ms work · ` +
        `${p.processMs.toFixed(0).padStart(8)}ms process · peak ${mb(p.peakRssBytes).padStart(7)} · ` +
        `out ${(p.outputBytes / 1024).toFixed(0)}KB\n`,
    );
  }
  process.stdout.write(
    `run-bench whole-run ${record.wholeRun.ms.toFixed(0)}ms work · ${record.wholeRun.processMs.toFixed(0)}ms process · ` +
      `wholeProcessPeakRss ${mb(record.wholeRun.wholeProcessPeakRssBytes)} (${record.wholeRun.rssMethod}) → ${outPath}\n`,
  );
}

if (import.meta.main) await main();
