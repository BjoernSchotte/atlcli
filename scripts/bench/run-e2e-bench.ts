/**
 * END-TO-END-TIER benchmark runner (spec 011, Benchmarks).
 *
 * ## Why a second tier exists
 *
 * The engine tier (`run-bench.ts`) starts from already-parsed `ExportBlock[]`.
 * That is a legitimate measurement of compose/serialize/compile, and a
 * misleading answer to "how long does exporting a 500-page tree take", because
 * it skips the traversal, the storage-XHTML parse, and the macro resolver pass
 * entirely. This runner closes that gap: it drives the REAL pipeline
 *
 *   TreeSource (in-memory storage fixture)
 *     → fetchExportTree      (traversal + per-page storageToBlocks)
 *     → MacroRendererRegistry resolver pass  (real Jira + draw.io renderers)
 *     → composeChapters
 *     → asset preparation + engine (DOCX zip · real Typst WASM PDF)
 *
 * The only thing removed is the network: the `TreeSource` is a real port
 * implementation backed by generated storage bytes, so the benchmark measures
 * our code instead of a tenant's latency. Everything else — parser, registry,
 * renderers, engines, compiler, fonts — is the production path.
 *
 * ## What this tier still does NOT exercise
 *
 * Real HTTP (auth, pagination, rate limits, retry), real attachment downloads,
 * and a browser host (heap limits, module-worker transfer cost). The Chromium
 * variant is explicitly out of scope here (PLAN, open question) — it needs
 * Playwright wiring the bench folder otherwise does not require.
 *
 * ## Process + RSS model
 *
 * Identical to the engine tier: one child process per phase under
 * `/usr/bin/time`, so `peakRssBytes` is the whole-process peak of a process
 * that ran only that phase (plus its unmeasured setup); one `--phase all`
 * child supplies the run-level `wholeProcessPeakRssBytes`. Each phase child
 * additionally runs its work TWICE and reports `msCold` / `msWarm`, and the
 * parent takes the median over `--repeat` children. See `bench-env.ts`.
 *
 * Run: `bun scripts/bench/run-e2e-bench.ts [--pages 500] [--seed S] [--repeat 3]`
 * Emits `scripts/bench/out/bench-e2e.json` (gitignored).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  composeChapters,
  fetchExportTree,
  storageToBlocks,
  htmlToExportBlocks,
  parsePageProperties,
  extractMacroBody,
  type ExportBlock,
  type ExportNode,
  type ExportPageNode,
} from "@atlcli/confluence";
import {
  defaultRegistry,
  resolveMacroBlocks,
  type MacroExportContext,
  type MacroRendererRegistry,
} from "@atlcli/export-macros";
import { runExport, type OutputSink } from "@atlcli/docx";
import { memoryTemplateSource } from "@atlcli/docx/browser-runtime";
import {
  DOCX_TEMPLATE_BYTES,
  macroAttachmentsPort,
  macroJiraPort,
} from "@atlcli/export-fixtures";
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
import { generateStorageFixture, storageFixtureTreeSource } from "./generate-storage-fixture.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(HERE, "out", "bench-e2e.json");
const SELF = fileURLToPath(import.meta.url);
const PHASE_TIMEOUT_MS = 45 * 60_000;

export const E2E_PHASES = ["baseline", "fetch", "resolve", "compose", "docx", "pdf"] as const;
export type E2EPhase = (typeof E2E_PHASES)[number];

const E2E_METADATA: PdfExportMetadata = {
  title: "End-to-End Benchmark",
  space: "BENCH",
  version: 1,
  author: "Bench Author",
  exporter: "atlcli e2e benchmark",
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

async function packageBytes(specifier: string): Promise<Uint8Array> {
  const path = fileURLToPath(import.meta.resolve(specifier));
  return new Uint8Array(await Bun.file(path).arrayBuffer());
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

/** The real macro registry, wired to the real renderer dependencies. */
function benchRegistry(): MacroRendererRegistry {
  return defaultRegistry({
    storageToBlocks,
    htmlToExportBlocks,
    parsePageProperties,
    extractMacroBody,
  });
}

function benchMacroContext(pageId: string): MacroExportContext {
  return {
    page: { id: pageId, spaceKey: "BENCH" },
    jira: macroJiraPort(),
    attachments: macroAttachmentsPort(),
    depth: 0,
    visited: new Set<string>(),
  };
}

/**
 * The macro resolver pass over a fetched tree: every page's blocks go through
 * the REAL `resolveMacroBlocks` with the real registry, per page, so the Jira
 * macro renders a genuine table and the draw.io macro exercises its lookup port
 * before settling on the placeholder floor. Returns fresh nodes — the fetched
 * tree is not mutated, so a phase child can run this twice (cold + warm).
 */
async function resolvePass(
  nodes: readonly ExportNode[],
  registry: MacroRendererRegistry,
  targetEngine: "docx" | "pdf",
): Promise<ExportNode[]> {
  const out: ExportNode[] = [];
  for (const node of nodes) {
    if (node.kind !== "page") {
      out.push(node);
      continue;
    }
    const resolved = await resolveMacroBlocks(
      { blocks: node.blocks, notes: node.notes },
      registry,
      benchMacroContext(node.pageId),
      { live: true, targetEngine },
    );
    out.push({ ...node, blocks: resolved.blocks, notes: resolved.notes } satisfies ExportPageNode);
  }
  return out;
}

async function serializeDocx(blocks: ExportBlock[]): Promise<{ bytes: Uint8Array; noteCodes: string[] }> {
  const output = new MemorySink();
  const report = await runExport(
    {
      details: {
        id: "bench-page-1",
        title: "Benchmark Handbook",
        url: "https://example.invalid/wiki/spaces/BENCH/pages/bench-page-1",
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
    { blocks, metadata: E2E_METADATA, profile: "tagged", filename: "End-to-End Benchmark.pdf" },
    { assets: benchPdfAssets, compiler, output, now: deterministicClock() },
  );
  return { bytes: output.bytes, noteCodes: uniqueCodes(report.notes) };
}

// ---------------------------------------------------------------------------
// Child mode
// ---------------------------------------------------------------------------

export interface E2EPhaseResult {
  phase: string;
  /** First (cold) in-process run of the phase work. */
  msCold: number;
  /** Second (warm) run of the same work in the same process; JIT + caches hot. */
  msWarm: number;
  outputBytes: number;
  pages: number;
  blockCount: number;
  /** Report/parse notes observed in this phase, deduplicated by code. */
  noteCodes: string[];
}

/** Run `work` twice, returning cold/warm ms and the last result. */
async function coldWarm<T>(work: () => Promise<T>): Promise<{ msCold: number; msWarm: number; value: T }> {
  const t0 = performance.now();
  await work();
  const msCold = performance.now() - t0;
  const t1 = performance.now();
  const value = await work();
  return { msCold, msWarm: performance.now() - t1, value };
}

function uniqueCodes(notes: readonly { code: string }[]): string[] {
  return [...new Set(notes.map((n) => n.code))].sort();
}

async function runPhaseInProcess(phase: E2EPhase | "all", pages: number, seed: number): Promise<E2EPhaseResult[]> {
  const fixture = generateStorageFixture({ pages, seed });
  const source = storageFixtureTreeSource(fixture);
  const registry = benchRegistry();
  const results: E2EPhaseResult[] = [];
  const wants = (p: E2EPhase): boolean => phase === "all" || phase === p;
  // Every phase needs the full prefix of the pipeline as SETUP. Setup time is
  // deliberately outside every reported `ms` — the phase-scoped RSS still
  // includes it, which is why `baseline` is measured too.
  const needsCompiler = wants("pdf") || phase === "baseline";
  const compiler = needsCompiler ? await buildCompiler() : undefined;

  const fetchOnce = () =>
    fetchExportTree(source, { kind: "tree", rootPageId: fixture.rootId }, { maxPages: pages + 10, concurrency: 4 });

  if (phase === "baseline") {
    // Fixture built, registry wired, wasm + fonts + template resident. No work.
    void compiler;
    results.push({ phase: "baseline", msCold: 0, msWarm: 0, outputBytes: 0, pages, blockCount: 0, noteCodes: [] });
    return results;
  }

  const fetched = await coldWarm(fetchOnce);
  const tree = fetched.value;
  const blockCount = tree.nodes.reduce((n, node) => n + (node.kind === "page" ? node.blocks.length : 0), 0);
  if (wants("fetch")) {
    results.push({
      phase: "fetch",
      msCold: fetched.msCold,
      msWarm: fetched.msWarm,
      outputBytes: JSON.stringify(tree.nodes).length,
      pages: tree.nodes.length,
      blockCount,
      noteCodes: uniqueCodes(tree.notes),
    });
  }
  if (phase === "fetch") return results;

  // One resolver pass feeds BOTH engine phases, with `targetEngine: "pdf"`.
  // The only renderer that branches on it is the diagram renderer (SVG vs PNG
  // preview), and this fixture's draw.io macro settles on the placeholder floor
  // offline either way — so the DOCX phase measures the same block tree it
  // would get from a "docx" pass. Re-running the pass per engine would double
  // the setup cost without changing a byte.
  const resolved = await coldWarm(() => resolvePass(tree.nodes, registry, "pdf"));
  const resolvedNodes = resolved.value;
  if (wants("resolve")) {
    const notes = resolvedNodes.flatMap((n) => (n.kind === "page" ? n.notes : []));
    results.push({
      phase: "resolve",
      msCold: resolved.msCold,
      msWarm: resolved.msWarm,
      outputBytes: JSON.stringify(resolvedNodes).length,
      pages: resolvedNodes.length,
      blockCount: resolvedNodes.reduce((n, node) => n + (node.kind === "page" ? node.blocks.length : 0), 0),
      noteCodes: uniqueCodes(notes),
    });
  }
  if (phase === "resolve") return results;

  const composed = await coldWarm(async () => composeChapters(resolvedNodes));
  const blocks = composed.value.blocks;
  if (wants("compose")) {
    results.push({
      phase: "compose",
      msCold: composed.msCold,
      msWarm: composed.msWarm,
      outputBytes: JSON.stringify(blocks).length,
      pages: resolvedNodes.length,
      blockCount: blocks.length,
      noteCodes: uniqueCodes(composed.value.notes),
    });
  }
  if (phase === "compose") return results;

  if (wants("docx")) {
    const docx = await coldWarm(() => serializeDocx(blocks));
    results.push({
      phase: "docx",
      msCold: docx.msCold,
      msWarm: docx.msWarm,
      outputBytes: docx.value.bytes.byteLength,
      pages: resolvedNodes.length,
      blockCount: blocks.length,
      noteCodes: docx.value.noteCodes,
    });
  }

  if (wants("pdf")) {
    const pdf = await coldWarm(() => serializePdf(compiler!, blocks));
    results.push({
      phase: "pdf",
      msCold: pdf.msCold,
      msWarm: pdf.msWarm,
      outputBytes: pdf.value.bytes.byteLength,
      pages: resolvedNodes.length,
      blockCount: blocks.length,
      noteCodes: pdf.value.noteCodes,
    });
  }

  return results;
}

// ---------------------------------------------------------------------------
// Parent mode
// ---------------------------------------------------------------------------

export interface E2EPhaseRecord extends E2EPhaseResult {
  peakRssBytes: number | null;
  rssMethod: RssMethod;
  processMs: number;
  samplesColdMs: number[];
}

export interface E2ERecord {
  tier: "end-to-end";
  commit: string;
  date: string;
  pages: number;
  seed: number;
  repeat: number;
  datasetDigest: string;
  environment: BenchEnvironment;
  phases: E2EPhaseRecord[];
  wholeRun: {
    ms: number;
    processMs: number;
    wholeProcessPeakRssBytes: number | null;
    rssMethod: RssMethod;
  };
}

function spawnPhase(phase: string, pages: number, seed: number) {
  const measured = runMeasured(
    "bun",
    ["--conditions=development", SELF, "--phase", phase, "--pages", String(pages), "--seed", String(seed)],
    { timeoutMs: PHASE_TIMEOUT_MS },
  );
  if (measured.exitCode !== 0) {
    process.stderr.write(measured.stderr);
    throw new Error(`e2e bench phase "${phase}" failed with exit code ${measured.exitCode}`);
  }
  const results = parsePhaseResult<E2EPhaseResult[]>(measured.stdout);
  if (!results) throw new Error(`e2e bench phase "${phase}" emitted no result line`);
  return { measured, results };
}

async function runParent(pages: number, seed: number, repeat: number): Promise<E2ERecord> {
  const fixture = generateStorageFixture({ pages, seed });
  const environment = await collectEnvironment();

  const phases: E2EPhaseRecord[] = [];
  for (const phase of E2E_PHASES) {
    const samples: E2EPhaseResult[] = [];
    const measurements = [];
    for (let i = 0; i < repeat; i++) {
      const run = spawnPhase(phase, pages, seed);
      // A phase child returns the prefix it had to run; the LAST entry is the
      // phase that was asked for.
      samples.push(run.results[run.results.length - 1]!);
      measurements.push(run.measured);
      process.stderr.write(`  ${phase} run ${i + 1}/${repeat}: ${run.measured.ms.toFixed(0)}ms process\n`);
    }
    const last = samples[samples.length - 1]!;
    phases.push({
      ...last,
      samplesColdMs: samples.map((s) => s.msCold),
      msCold: median(samples.map((s) => s.msCold)),
      msWarm: median(samples.map((s) => s.msWarm)),
      processMs: median(measurements.map((m) => m.ms)),
      peakRssBytes: maxOrNull(measurements.map((m) => m.peakRssBytes)),
      rssMethod: measurements[0]!.rssMethod,
    });
  }

  process.stderr.write("  all (whole-process RSS run)\n");
  const whole = spawnPhase("all", pages, seed);
  const wholeMs = whole.results.reduce((n, r) => n + r.msCold, 0);

  return {
    tier: "end-to-end",
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
    if (phase !== "all" && !E2E_PHASES.includes(phase as E2EPhase)) {
      throw new Error(`unknown phase "${phase}" (expected: ${[...E2E_PHASES, "all"].join(", ")})`);
    }
    emitPhaseResult(await runPhaseInProcess(phase as E2EPhase | "all", pages, seed));
    return;
  }

  process.stderr.write(`run-e2e-bench (end-to-end tier): ${pages} pages, seed ${seed}, repeat ${repeat}\n`);
  const record = await runParent(pages, seed, repeat);
  const outPath = flag("--out") ?? OUT;
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(record, null, 2));

  for (const p of record.phases) {
    process.stdout.write(
      `run-e2e-bench ${p.phase.padEnd(8)} cold ${p.msCold.toFixed(0).padStart(8)}ms · ` +
        `warm ${p.msWarm.toFixed(0).padStart(8)}ms · ${p.processMs.toFixed(0).padStart(8)}ms process · ` +
        `peak ${mb(p.peakRssBytes).padStart(7)} · out ${(p.outputBytes / 1024).toFixed(0)}KB\n`,
    );
  }
  process.stdout.write(
    `run-e2e-bench whole-run ${record.wholeRun.ms.toFixed(0)}ms work · ${record.wholeRun.processMs.toFixed(0)}ms process · ` +
      `wholeProcessPeakRss ${mb(record.wholeRun.wholeProcessPeakRssBytes)} (${record.wholeRun.rssMethod}) → ${outPath}\n`,
  );
}

if (import.meta.main) await main();
