#!/usr/bin/env bun
/**
 * ADF-primary rollout benchmark.
 *
 * Runs the same synthetic page/tree/space corpus through ADF-primary dual reads
 * and Storage-primary reads, the real representation dispatcher, composition,
 * DOCX, and Typst/WASM PDF. Network latency is deliberately excluded; logical
 * production-adapter request counts and transferred body bytes are reported
 * separately from local source/decode/compose wall time.
 *
 * Run: `bun run bench:adf-source --pages 25 --repeat 5 --process-repeat 3`
 * The output record is gitignored; reviewed aggregate evidence belongs in the
 * migration plan, never in a release gate tied to one developer machine.
 */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  composeChapters,
  fetchExportTree,
  type ExportBlock,
  type ExportNote,
  type ExportScope,
} from "@atlcli/confluence";
import { runExport, type OutputSink } from "@atlcli/docx";
import { memoryTemplateSource } from "@atlcli/docx/browser-runtime";
import { unzipDocx } from "@atlcli/docx/scan";
import { DOCX_TEMPLATE_BYTES } from "@atlcli/export-fixtures";
import {
  PDF_RUNTIME_ASSETS,
  runPdfExport,
  type PdfBytesHandle,
  type PdfCompilePort,
  type PdfOutputSink,
} from "@atlcli/pdf";
import { BrowserPdfCompiler } from "@atlcli/pdf-compiler-browser";
import { ensureVendoredTypst } from "../../packages/pdf-compiler-browser/scripts/vendor-typst.js";
import { ensurePdfFonts } from "../../packages/pdf/scripts/ensure-fonts.js";
import {
  collectEnvironment,
  emitPhaseResult,
  gitCommit,
  median,
  parsePhaseResult,
  runMeasured,
  type BenchEnvironment,
  type RssMethod,
} from "./bench-env.js";
import {
  countingAdfSourceTree,
  loadAdfSourceBenchFixture,
  type BenchSourceRepresentation,
  type SourceRequestSnapshot,
} from "./generate-adf-source-fixture.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SELF = fileURLToPath(import.meta.url);
const OUT = resolve(HERE, "out", "adf-source-bench.json");
const CHILD_TIMEOUT_MS = 10 * 60_000;
const SOURCE_WALL_RATIO_BUDGET = 2;
const SOURCE_WALL_JITTER_BUDGET_MS = 1;
const PEAK_RSS_ADDED_BUDGET_BYTES = 32 * 1024 * 1024;

export const ADF_SOURCE_BENCH_SCOPES = ["page", "tree", "space"] as const;
export type AdfSourceBenchScope = (typeof ADF_SOURCE_BENCH_SCOPES)[number];

interface ArtifactMeasurement {
  bytes: number;
  sha256: string;
  hashMethod: "normalized-docx-parts-sha256" | "raw-sha256";
  ms: number;
}

export interface AdfSourceScenarioResult {
  scope: AdfSourceBenchScope;
  representation: BenchSourceRepresentation;
  pages: number;
  repeat: number;
  processRepeat: number;
  sourceSamplesMs: number[];
  sourceMedianMs: number;
  requests: SourceRequestSnapshot & {
    requestsPerPage: number;
    bodyRequestsPerPage: number;
  };
  rawBlockCount: number;
  composedBlockCount: number;
  noteCount: number;
  complete: boolean;
  docx: ArtifactMeasurement;
  pdf: ArtifactMeasurement;
}

export interface AdfSourceScenarioRecord extends AdfSourceScenarioResult {
  processMs: number;
  peakRssBytes: number | null;
  rssMethod: RssMethod;
}

export interface AdfSourceParityGate {
  scope: AdfSourceBenchScope;
  pages: number;
  addedRequestsPerPage: number;
  docxArtifactIdentical: boolean;
  pdfByteIdentical: boolean;
  blocksIdentical: boolean;
  adfNoteCount: number;
  storageNoteCount: number;
  addedBodyBytesPerPage: number;
  sourceMedianRatio: number;
  sourceWallBudgetMs: number;
  sourceWallWithinBudget: boolean;
  peakRssAddedBytes: number | null;
  peakRssBudgetBytes: number;
  peakRssWithinBudget: boolean | null;
}

export interface AdfSourceBenchRecord {
  tier: "adf-source-rollout";
  commit: string;
  date: string;
  pages: number;
  repeat: number;
  processRepeat: number;
  environment: BenchEnvironment;
  scenarios: AdfSourceScenarioRecord[];
  gates: AdfSourceParityGate[];
}

class MemorySink implements OutputSink {
  bytes: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
  async emit(_name: string, bytes: Uint8Array): Promise<void> {
    this.bytes = bytes;
  }
}

class PdfMemorySink implements PdfOutputSink {
  bytes: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
  async emit(_name: string, bytes: PdfBytesHandle): Promise<void> {
    this.bytes = await bytes.asUint8Array();
  }
}

function sha256(bytes: Uint8Array<ArrayBufferLike>): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function normalizedDocxHash(bytes: Uint8Array<ArrayBufferLike>): string {
  const zip = unzipDocx(new Uint8Array(bytes));
  const hash = createHash("sha256");
  for (const name of Object.keys(zip.files).sort()) {
    const entry = zip.files[name]!;
    if (entry.dir) continue;
    hash.update(name);
    hash.update("\0");
    hash.update(entry.asUint8Array());
    hash.update("\0");
  }
  return hash.digest("hex");
}

async function packageBytes(specifier: string): Promise<Uint8Array> {
  const path = fileURLToPath(import.meta.resolve(specifier));
  return new Uint8Array(await Bun.file(path).arrayBuffer());
}

async function buildCompiler(): Promise<PdfCompilePort> {
  await Promise.all([ensurePdfFonts({ logger: () => {} }), ensureVendoredTypst()]);
  const [wasm, ...fonts] = await Promise.all([
    packageBytes("@atlcli/pdf-compiler-browser/wasm"),
    ...PDF_RUNTIME_ASSETS.fonts.map((font) => packageBytes(`@atlcli/pdf/fonts/${font.fileName}`)),
  ]);
  return new BrowserPdfCompiler({
    wasm: wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength) as ArrayBuffer,
    fonts,
  });
}

function deterministicClock(): () => number {
  let tick = 0;
  return () => tick++;
}

async function renderDocx(blocks: ExportBlock[], notes: ExportNote[]): Promise<ArtifactMeasurement> {
  const output = new MemorySink();
  const started = performance.now();
  await runExport({
    details: {
      id: "source-bench-page-1",
      title: "Source Benchmark",
      url: "https://example.invalid/source-benchmark",
      version: 1,
      spaceKey: "BENCH",
      storage: "",
      created: "2026-07-22T08:00:00.000Z",
      modified: "2026-07-22T08:00:00.000Z",
      createdBy: { displayName: "Benchmark" },
      modifiedBy: { displayName: "Benchmark" },
      labels: [],
    },
    blocks,
    sourceNotes: notes,
    template: { name: "source-benchmark.docx", modificationDate: new Date("2026-07-22T08:00:00.000Z") },
    exportDate: new Date("2026-07-22T08:00:00.000Z"),
  }, { templates: memoryTemplateSource(DOCX_TEMPLATE_BYTES), output });
  return {
    bytes: output.bytes.byteLength,
    sha256: normalizedDocxHash(output.bytes),
    hashMethod: "normalized-docx-parts-sha256",
    ms: performance.now() - started,
  };
}

async function renderPdf(
  compiler: PdfCompilePort,
  blocks: ExportBlock[],
  notes: ExportNote[],
): Promise<ArtifactMeasurement> {
  const output = new PdfMemorySink();
  const started = performance.now();
  await runPdfExport({
    blocks,
    metadata: {
      title: "Source Benchmark",
      space: "BENCH",
      version: 1,
      author: "Benchmark",
      exporter: "atlcli ADF source benchmark",
      language: "en",
      region: "GB",
      exportedAt: new Date("2026-07-22T08:00:00.000Z"),
    },
    profile: "tagged",
    filename: "Source Benchmark.pdf",
    sourceNotes: notes,
  }, {
    assets: { async resolve() { throw new Error("ADF source benchmark fixture has no external assets."); } },
    compiler,
    output,
    now: deterministicClock(),
  });
  return {
    bytes: output.bytes.byteLength,
    sha256: sha256(output.bytes),
    hashMethod: "raw-sha256",
    ms: performance.now() - started,
  };
}

function scopeFor(kind: AdfSourceBenchScope, rootId: string): ExportScope {
  switch (kind) {
    case "page": return { kind: "page", pageId: rootId };
    case "tree": return { kind: "tree", rootPageId: rootId };
    case "space": return { kind: "space", spaceKey: "BENCH" };
  }
}

async function runScenario(
  scopeKind: AdfSourceBenchScope,
  representation: BenchSourceRepresentation,
  configuredPages: number,
  repeat: number,
): Promise<AdfSourceScenarioResult> {
  const pages = scopeKind === "page" ? 1 : configuredPages;
  const fixture = await loadAdfSourceBenchFixture(pages);
  const sourceSamplesMs: number[] = [];
  let latest: Awaited<ReturnType<typeof fetchExportTree>> | undefined;
  let latestBlocks: ExportBlock[] | undefined;
  let latestNotes: ExportNote[] | undefined;
  let latestRequests: SourceRequestSnapshot | undefined;

  for (let iteration = 0; iteration < repeat; iteration += 1) {
    const source = countingAdfSourceTree(fixture, representation);
    const started = performance.now();
    const fetched = await fetchExportTree(source, scopeFor(scopeKind, fixture.rootId), {
      maxPages: pages + 1,
      concurrency: 4,
    });
    const composed = await composeChapters(fetched.nodes);
    sourceSamplesMs.push(performance.now() - started);
    latest = fetched;
    latestBlocks = composed.blocks;
    latestNotes = [
      ...fetched.notes,
      ...fetched.nodes.flatMap((node) => node.kind === "page" ? node.notes : []),
      ...composed.notes,
    ];
    latestRequests = source.snapshot();
  }
  if (!latest || !latestBlocks || !latestNotes || !latestRequests) {
    throw new Error("ADF source benchmark requires at least one repeat.");
  }

  const compiler = await buildCompiler();
  const [docx, pdf] = await Promise.all([
    renderDocx(latestBlocks, latestNotes),
    renderPdf(compiler, latestBlocks, latestNotes),
  ]);
  const bodyRequests = latestRequests.adfBodyRequests + latestRequests.storageBodyRequests;
  return {
    scope: scopeKind,
    representation,
    pages,
    repeat,
    processRepeat: 1,
    sourceSamplesMs,
    sourceMedianMs: median(sourceSamplesMs),
    requests: {
      ...latestRequests,
      requestsPerPage: latestRequests.totalRequests / pages,
      bodyRequestsPerPage: bodyRequests / pages,
    },
    rawBlockCount: latest.nodes.reduce((sum, node) => sum + (node.kind === "page" ? node.blocks.length : 0), 0),
    composedBlockCount: latestBlocks.length,
    noteCount: latestNotes.length,
    complete: latest.complete,
    docx,
    pdf,
  };
}

export function assertAdfSourceParity(scenarios: readonly AdfSourceScenarioRecord[]): AdfSourceParityGate[] {
  const gates: AdfSourceParityGate[] = [];
  for (const scope of ADF_SOURCE_BENCH_SCOPES) {
    const adf = scenarios.find((entry) => entry.scope === scope && entry.representation === "adf-primary");
    const storage = scenarios.find((entry) => entry.scope === scope && entry.representation === "storage-primary");
    if (!adf || !storage) throw new Error(`ADF source benchmark is missing the ${scope} comparison pair.`);
    if (!adf.complete || !storage.complete) throw new Error(`ADF source benchmark ${scope} scope was incomplete.`);
    const addedRequests = adf.requests.totalRequests - storage.requests.totalRequests;
    if (addedRequests !== adf.pages) {
      throw new Error(`ADF source benchmark ${scope} scope did not add exactly one request per page.`);
    }
    const blocksIdentical =
      adf.rawBlockCount === storage.rawBlockCount &&
      adf.composedBlockCount === storage.composedBlockCount;
    const docxArtifactIdentical = adf.docx.sha256 === storage.docx.sha256;
    const pdfByteIdentical = adf.pdf.sha256 === storage.pdf.sha256;
    const notesExpected = adf.noteCount === adf.pages && storage.noteCount === 0;
    const sourceWallBudgetMs = storage.sourceMedianMs * SOURCE_WALL_RATIO_BUDGET + SOURCE_WALL_JITTER_BUDGET_MS;
    const sourceWallWithinBudget = adf.sourceMedianMs <= sourceWallBudgetMs;
    const peakRssAddedBytes =
      adf.peakRssBytes === null || storage.peakRssBytes === null
        ? null
        : adf.peakRssBytes - storage.peakRssBytes;
    const peakRssWithinBudget = peakRssAddedBytes === null
      ? null
      : peakRssAddedBytes <= PEAK_RSS_ADDED_BUDGET_BYTES;
    if (
      !blocksIdentical ||
      !docxArtifactIdentical ||
      !pdfByteIdentical ||
      !notesExpected ||
      !sourceWallWithinBudget ||
      peakRssWithinBudget === false
    ) {
      throw new Error(`ADF source benchmark ${scope} scope failed parity or rollout budgets.`);
    }
    gates.push({
      scope,
      pages: adf.pages,
      addedRequestsPerPage: addedRequests / adf.pages,
      docxArtifactIdentical,
      pdfByteIdentical,
      blocksIdentical,
      adfNoteCount: adf.noteCount,
      storageNoteCount: storage.noteCount,
      addedBodyBytesPerPage: (adf.requests.totalBodyBytes - storage.requests.totalBodyBytes) / adf.pages,
      sourceMedianRatio: storage.sourceMedianMs === 0 ? 0 : adf.sourceMedianMs / storage.sourceMedianMs,
      sourceWallBudgetMs,
      sourceWallWithinBudget,
      peakRssAddedBytes,
      peakRssBudgetBytes: PEAK_RSS_ADDED_BUDGET_BYTES,
      peakRssWithinBudget,
    });
  }
  return gates;
}

function spawnScenario(
  scope: AdfSourceBenchScope,
  representation: BenchSourceRepresentation,
  pages: number,
  repeat: number,
  processRepeat: number,
): AdfSourceScenarioRecord {
  const samples: Array<{ result: AdfSourceScenarioResult; processMs: number; peakRssBytes: number | null; rssMethod: RssMethod }> = [];
  for (let sample = 0; sample < processRepeat; sample += 1) {
    const measured = runMeasured(process.execPath, [
      "--conditions=development",
      SELF,
      "--child",
      "--scope", scope,
      "--representation", representation,
      "--pages", String(pages),
      "--repeat", String(repeat),
    ], { timeoutMs: CHILD_TIMEOUT_MS });
    if (measured.exitCode !== 0) {
      process.stderr.write(measured.stderr);
      throw new Error(`ADF source benchmark ${scope}/${representation} failed with exit code ${measured.exitCode}.`);
    }
    const result = parsePhaseResult<AdfSourceScenarioResult>(measured.stdout);
    if (!result) throw new Error(`ADF source benchmark ${scope}/${representation} emitted no result.`);
    samples.push({ result, processMs: measured.ms, peakRssBytes: measured.peakRssBytes, rssMethod: measured.rssMethod });
  }
  const first = samples[0]!;
  for (const sample of samples.slice(1)) {
    if (
      sample.result.requests.totalRequests !== first.result.requests.totalRequests ||
      sample.result.rawBlockCount !== first.result.rawBlockCount ||
      sample.result.composedBlockCount !== first.result.composedBlockCount ||
      sample.result.noteCount !== first.result.noteCount ||
      sample.result.docx.sha256 !== first.result.docx.sha256 ||
      sample.result.pdf.sha256 !== first.result.pdf.sha256
    ) {
      throw new Error(`ADF source benchmark ${scope}/${representation} was not stable across process samples.`);
    }
  }
  const rssSamples = samples.flatMap((sample) => sample.peakRssBytes === null ? [] : [sample.peakRssBytes]);
  return {
    ...first.result,
    processRepeat,
    sourceSamplesMs: samples.map((sample) => sample.result.sourceMedianMs),
    sourceMedianMs: median(samples.map((sample) => sample.result.sourceMedianMs)),
    docx: { ...first.result.docx, ms: median(samples.map((sample) => sample.result.docx.ms)) },
    pdf: { ...first.result.pdf, ms: median(samples.map((sample) => sample.result.pdf.ms)) },
    processMs: median(samples.map((sample) => sample.processMs)),
    peakRssBytes: rssSamples.length === 0 ? null : median(rssSamples),
    rssMethod: first.rssMethod,
  };
}

function safeEnvironment(environment: BenchEnvironment): BenchEnvironment {
  if (environment.ci) return environment;
  return { ...environment, runner: `local:${environment.os}:${environment.arch}` };
}

async function runParent(pages: number, repeat: number, processRepeat: number): Promise<AdfSourceBenchRecord> {
  const scenarios: AdfSourceScenarioRecord[] = [];
  for (const scope of ADF_SOURCE_BENCH_SCOPES) {
    for (const representation of ["storage-primary", "adf-primary"] as const) {
      process.stderr.write(`  ${scope}/${representation}\n`);
      scenarios.push(spawnScenario(scope, representation, pages, repeat, processRepeat));
    }
  }
  return {
    tier: "adf-source-rollout",
    commit: gitCommit(),
    date: new Date().toISOString(),
    pages,
    repeat,
    processRepeat,
    environment: safeEnvironment(await collectEnvironment()),
    scenarios,
    gates: assertAdfSourceParity(scenarios),
  };
}

function flag(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function mb(bytes: number | null): string {
  return bytes === null ? "n/a" : `${(bytes / 1024 / 1024).toFixed(0)}MB`;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const pages = Number(flag(args, "--pages") ?? 25);
  const repeat = Number(flag(args, "--repeat") ?? 3);
  const processRepeat = Number(flag(args, "--process-repeat") ?? 3);
  if (!Number.isInteger(pages) || pages < 1) throw new Error("--pages must be a positive integer.");
  if (!Number.isInteger(repeat) || repeat < 1) throw new Error("--repeat must be a positive integer.");
  if (!Number.isInteger(processRepeat) || processRepeat < 1) {
    throw new Error("--process-repeat must be a positive integer.");
  }

  if (args.includes("--child")) {
    const scope = flag(args, "--scope") as AdfSourceBenchScope | undefined;
    const representation = flag(args, "--representation") as BenchSourceRepresentation | undefined;
    if (!scope || !ADF_SOURCE_BENCH_SCOPES.includes(scope)) throw new Error("Invalid child --scope.");
    if (representation !== "adf-primary" && representation !== "storage-primary") {
      throw new Error("Invalid child --representation.");
    }
    emitPhaseResult(await runScenario(scope, representation, pages, repeat));
    return;
  }

  const record = await runParent(pages, repeat, processRepeat);
  const outPath = flag(args, "--out") ?? OUT;
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(record, null, 2)}\n`);
  for (const scenario of record.scenarios) {
    process.stdout.write(
      `${scenario.scope.padEnd(5)} ${scenario.representation.padEnd(15)} ` +
      `${scenario.requests.requestsPerPage.toFixed(2)} req/page · ` +
      `${scenario.sourceMedianMs.toFixed(1)}ms source · ` +
      `${mb(scenario.peakRssBytes)} peak · ${scenario.rawBlockCount} blocks · ` +
      `${scenario.noteCount} notes\n`,
    );
  }
  process.stdout.write(`ADF source parity passed for page/tree/space → ${outPath}\n`);
}

if (import.meta.main) await main();
