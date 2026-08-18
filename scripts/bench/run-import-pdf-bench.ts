#!/usr/bin/env bun
/**
 * PDF import release envelope. Each sample runs in a fresh Bun process so
 * `/usr/bin/time` observes whole-process peak RSS, including PDFium WASM.
 * The 25 MiB input is the neutral 100-page fixture plus inert trailing PDF
 * comment bytes; it exercises acquisition/parse size without committing a
 * generated binary. Output contains metrics and digests, never extracted text.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createPdfiumFactsAdapter,
  isPdfImportError,
} from "../../packages/import-pdf/src/index.js";
import { runMeasured } from "./bench-env.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SELF = fileURLToPath(import.meta.url);
const FIXTURE = resolve(ROOT, "specs/import-pdf-mvp/fixtures/heading-poor-100.pdf");
const WASM = resolve(ROOT, "packages/import-pdf/vendor/pdfium.wasm");
const OUTPUT = resolve(ROOT, "scripts/bench/out/import-pdf.json");
const INPUT_BYTES = 25 * 1024 * 1024;
const P95_BUDGET_MS = 30_000;
const FIRST_PROGRESS_BUDGET_MS = 500;
const CANCEL_BUDGET_MS = 1_000;
const PEAK_RSS_BUDGET_BYTES = 750 * 1024 * 1024;
const MARKER = "ATLCLI_IMPORT_PDF_BENCH_CHILD ";

interface ChildResult {
  pageCount: number;
  inputBytes: number;
  inputSha256: string;
  factsDigest: string;
  analysisMs: number;
  firstProgressMs: number;
  cancelLatencyMs: number;
  cancelledAfterPages: number;
  recoveryDigestEqual: boolean;
  wasmMemoryPlateau: boolean;
  wasmFinalBytes: number;
  recoveryWasmFinalBytes: number;
}

function syntheticInput(): Uint8Array {
  const fixture = new Uint8Array(readFileSync(FIXTURE));
  if (fixture.byteLength >= INPUT_BYTES) throw new Error("The neutral fixture unexpectedly exceeds 25 MiB.");
  const bytes = new Uint8Array(INPUT_BYTES);
  bytes.set(fixture);
  bytes.fill(0x20, fixture.byteLength);
  const marker = new TextEncoder().encode("\n% atlcli neutral performance padding\n%");
  bytes.set(marker, fixture.byteLength);
  for (let offset = fixture.byteLength + marker.byteLength; offset < bytes.byteLength; offset += 80) {
    bytes[offset] = 0x25;
  }
  return bytes;
}

async function child(): Promise<void> {
  const bytes = syntheticInput();
  const wasmBinary = new Uint8Array(readFileSync(WASM));
  const adapter = createPdfiumFactsAdapter({ wasmBinary });
  let firstProgressAt: number | undefined;
  const started = performance.now();
  const first = await adapter.analyze(bytes, {
    progress: () => {
      firstProgressAt ??= performance.now();
    },
  });
  const analysisMs = performance.now() - started;

  const controller = new AbortController();
  let cancelledAfterPages = 0;
  let cancelStarted = 0;
  const cancelling = createPdfiumFactsAdapter({ wasmBinary });
  try {
    await cancelling.analyze(bytes, {
      signal: controller.signal,
      progress: (event) => {
        if (event.phase === "page-complete" && event.completedPages === 1) {
          cancelledAfterPages = event.completedPages;
          cancelStarted = performance.now();
          controller.abort();
        }
      },
    });
    throw new Error("The cancellation probe completed unexpectedly.");
  } catch (error) {
    if (!isPdfImportError(error) || error.code !== "pdf/cancelled") throw error;
  }
  const cancelLatencyMs = performance.now() - cancelStarted;
  const recovery = await createPdfiumFactsAdapter({ wasmBinary }).analyze(bytes);
  const result: ChildResult = {
    pageCount: first.facts.pageCount,
    inputBytes: bytes.byteLength,
    inputSha256: createHash("sha256").update(bytes).digest("hex"),
    factsDigest: first.factsDigest,
    analysisMs,
    firstProgressMs: (firstProgressAt ?? performance.now()) - started,
    cancelLatencyMs,
    cancelledAfterPages,
    recoveryDigestEqual: recovery.factsDigest === first.factsDigest,
    // Emscripten linear memory cannot shrink. Hard reclamation is process or
    // Worker termination; within one run we require a bounded repeat plateau.
    wasmMemoryPlateau:
      first.telemetry.wasmFinalBytes === recovery.telemetry.wasmFinalBytes
      && recovery.telemetry.wasmFinalBytes <= 128 * 1024 * 1024,
    wasmFinalBytes: first.telemetry.wasmFinalBytes,
    recoveryWasmFinalBytes: recovery.telemetry.wasmFinalBytes,
  };
  process.stdout.write(`${MARKER}${JSON.stringify(result)}\n`);
}

function percentile(values: readonly number[], quantile: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1)] ?? 0;
}

function repeatCount(argv: readonly string[]): number {
  const index = argv.indexOf("--repeat");
  const value = index >= 0 ? Number(argv[index + 1]) : 5;
  if (!Number.isSafeInteger(value) || value < 3 || value > 20) {
    throw new Error("--repeat must be an integer from 3 through 20.");
  }
  return value;
}

function main(): void {
  const repeat = repeatCount(process.argv.slice(2));
  const samples: Array<ChildResult & { peakRssBytes: number | null; rssMethod: string; processMs: number }> = [];
  for (let index = 0; index < repeat; index += 1) {
    const measured = runMeasured(process.execPath, ["--conditions=development", SELF, "--child"], {
      cwd: ROOT,
      timeoutMs: 60_000,
    });
    if (measured.exitCode !== 0) {
      throw new Error(`PDF import benchmark child failed:\n${measured.stderr}\n${measured.stdout}`);
    }
    const line = measured.stdout.split("\n").find((entry) => entry.startsWith(MARKER));
    if (!line) throw new Error("PDF import benchmark child emitted no result marker.");
    const childResult = JSON.parse(line.slice(MARKER.length)) as ChildResult;
    samples.push({
      ...childResult,
      peakRssBytes: measured.peakRssBytes,
      rssMethod: measured.rssMethod,
      processMs: measured.ms,
    });
  }
  const observableRss = samples.map((sample) => sample.peakRssBytes).filter((value): value is number => value !== null);
  const record = {
    schema: "atlcli.import-pdf-performance/1",
    generatedAt: new Date().toISOString(),
    runtime: `Bun ${Bun.version}`,
    fixture: "neutral-heading-poor-100-plus-inert-padding",
    repeat,
    gates: {
      pageCount: samples.every((sample) => sample.pageCount === 100),
      inputBytes: samples.every((sample) => sample.inputBytes === INPUT_BYTES),
      deterministic: new Set(samples.map((sample) => sample.factsDigest)).size === 1,
      recovery: samples.every((sample) => sample.recoveryDigestEqual && sample.wasmMemoryPlateau),
      p95Ms: percentile(samples.map((sample) => sample.analysisMs), 0.95),
      p95BudgetMs: P95_BUDGET_MS,
      firstProgressP95Ms: percentile(samples.map((sample) => sample.firstProgressMs), 0.95),
      firstProgressBudgetMs: FIRST_PROGRESS_BUDGET_MS,
      cancellationP95Ms: percentile(samples.map((sample) => sample.cancelLatencyMs), 0.95),
      cancellationBudgetMs: CANCEL_BUDGET_MS,
      peakRssBytes: observableRss.length === samples.length ? Math.max(...observableRss) : null,
      peakRssBudgetBytes: PEAK_RSS_BUDGET_BYTES,
      rssObservable: observableRss.length === samples.length,
    },
    samples,
  };
  const gates = record.gates;
  if (
    !gates.pageCount
    || !gates.inputBytes
    || !gates.deterministic
    || !gates.recovery
    || gates.p95Ms > gates.p95BudgetMs
    || gates.firstProgressP95Ms > gates.firstProgressBudgetMs
    || gates.cancellationP95Ms > gates.cancellationBudgetMs
    || !gates.rssObservable
    || gates.peakRssBytes === null
    || gates.peakRssBytes > gates.peakRssBudgetBytes
  ) {
    throw new Error(`PDF import performance gate failed: ${JSON.stringify(gates)}`);
  }
  mkdirSync(dirname(OUTPUT), { recursive: true });
  writeFileSync(OUTPUT, `${JSON.stringify(record, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(record, null, 2)}\n`);
}

if (process.argv.includes("--child")) await child();
else main();
