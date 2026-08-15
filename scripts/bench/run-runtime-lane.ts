/**
 * Runtime candidate lanes (issue #118 Phase 2): compare the pinned Typst
 * runtime against separately attributable candidates on the SAME corpus with
 * the SAME pipeline — isolated child processes, `/usr/bin/time` peak RSS,
 * plus the child-reported WASM linear-memory high-water.
 *
 *   bun --conditions=development scripts/bench/run-runtime-lane.ts [--repeat 3] [--candidate name]
 *
 * Candidate: `forward-port` (the production-vendored fork artifact with exact
 * Typst 0.15.1). The immutable 0.14.2 aggregates remain in the runtime spec;
 * the old runtime is deliberately no longer installable as a second lane.
 * The corpus comes from the materialized cache written by the Chrome
 * memory-harness prebench (`apps/extension/tests/pdf/memory/public/image-heavy`).
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { brotliCompressSync, gzipSync } from "node:zlib";
import { median, runMeasured } from "./bench-env.js";

const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const CORPUS_DIR = join(
  ROOT,
  "apps/extension/tests/pdf/memory/public/image-heavy",
);
export const RUNTIME_LANE_CANDIDATES = ["forward-port"] as const;
export const RUNTIME_LANE_CORPORA = [
  "image-heavy",
  "text-heavy",
  "mixed",
] as const;
type RuntimeLaneCandidate = (typeof RUNTIME_LANE_CANDIDATES)[number];
type RuntimeLaneCorpus = (typeof RUNTIME_LANE_CORPORA)[number];

export interface RuntimeLaneOptions {
  repeat: number;
  candidates: RuntimeLaneCandidate[];
  corpus: RuntimeLaneCorpus;
}

function argValue(argv: readonly string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  if (index < 0) return undefined;
  const value = argv[index + 1];
  if (!value || value.startsWith("--"))
    throw new Error(`${flag} requires a value`);
  return value;
}

export function parseRuntimeLaneOptions(
  argv: readonly string[],
): RuntimeLaneOptions {
  const repeatRaw = argValue(argv, "--repeat") ?? "3";
  const repeat = Number(repeatRaw);
  if (!Number.isSafeInteger(repeat) || repeat < 1) {
    throw new Error(
      `--repeat must be a positive integer, got ${JSON.stringify(repeatRaw)}`,
    );
  }
  const only = argValue(argv, "--candidate");
  if (only && !RUNTIME_LANE_CANDIDATES.includes(only as RuntimeLaneCandidate)) {
    throw new Error(`unknown --candidate ${JSON.stringify(only)}`);
  }
  const corpus = argValue(argv, "--corpus") ?? "image-heavy";
  if (!RUNTIME_LANE_CORPORA.includes(corpus as RuntimeLaneCorpus)) {
    throw new Error(`unknown --corpus ${JSON.stringify(corpus)}`);
  }
  return {
    repeat,
    candidates: only
      ? [only as RuntimeLaneCandidate]
      : [...RUNTIME_LANE_CANDIDATES],
    corpus: corpus as RuntimeLaneCorpus,
  };
}

function artifactStats(
  candidate: RuntimeLaneCandidate,
): Record<string, unknown> {
  const packageDir = join(
    ROOT,
    "packages/pdf-compiler-browser/vendor/typst-ts-web-compiler/pkg",
  );
  const files = ["typst_ts_web_compiler.mjs", "typst_ts_web_compiler_bg.wasm"];
  return Object.fromEntries(
    files.map((name) => {
      const bytes = readFileSync(join(packageDir, name));
      return [
        name,
        {
          bytes: bytes.byteLength,
          gzipBytes: gzipSync(bytes).byteLength,
          brotliBytes: brotliCompressSync(bytes).byteLength,
          sha256: createHash("sha256").update(bytes).digest("hex"),
        },
      ];
    }),
  );
}

function spreadPercent(values: readonly number[]): number {
  const middle = median(values);
  if (middle === 0) return 0;
  return Number(
    (((Math.max(...values) - Math.min(...values)) / middle) * 100).toFixed(2),
  );
}

export function runRuntimeLane(
  argv: readonly string[] = process.argv.slice(2),
): void {
  const { repeat, candidates, corpus } = parseRuntimeLaneOptions(argv);
  if (
    corpus === "image-heavy" &&
    !existsSync(join(CORPUS_DIR, "manifest.json"))
  ) {
    throw new Error(
      `Materialized corpus missing at ${CORPUS_DIR} — run ` +
        "`bun --conditions=development apps/extension/tests/pdf/memory/generate-corpus.ts` first.",
    );
  }
  const corpusArg = corpus === "image-heavy" ? CORPUS_DIR : corpus;
  const results: Array<Record<string, unknown>> = [];
  for (const candidate of candidates) {
    const peaks: number[] = [];
    const compileMs: number[] = [];
    const wasmHighWater: number[] = [];
    let marker: Record<string, unknown> | undefined;
    for (let run = 0; run < repeat; run += 1) {
      const measured = runMeasured(
        "bun",
        [
          "--conditions=development",
          join(ROOT, "scripts/bench/runtime-lane-child.ts"),
          candidate,
          corpusArg,
        ],
        { cwd: ROOT, timeoutMs: 1_800_000 },
      );
      if (measured.exitCode !== 0) {
        throw new Error(
          `runtime lane ${candidate} failed (${measured.exitCode}):\n${measured.stderr}\n${measured.stdout}`,
        );
      }
      const line = measured.stdout
        .split("\n")
        .find((entry) => entry.startsWith("ATLCLI_RUNTIME_LANE_CHILD "));
      if (!line) throw new Error(`runtime lane ${candidate} printed no marker`);
      marker = JSON.parse(
        line.slice("ATLCLI_RUNTIME_LANE_CHILD ".length),
      ) as Record<string, unknown>;
      if (measured.peakRssBytes === null)
        throw new Error("peak RSS unobservable on this host");
      peaks.push(measured.peakRssBytes);
      compileMs.push(Number(marker.compileMs));
      wasmHighWater.push(Number(marker.wasmHighWaterMiB));
    }
    results.push({
      candidate,
      compilerVersion: marker?.compilerVersion,
      repeat,
      peakRssMiB: Number((median(peaks) / 1048576).toFixed(2)),
      peakRssRunsMiB: peaks.map((value) =>
        Number((value / 1048576).toFixed(2)),
      ),
      peakRssSpreadPercent: spreadPercent(peaks),
      wasmHighWaterMiB: median(wasmHighWater),
      wasmHighWaterRunsMiB: wasmHighWater,
      compileMsMedian: Math.round(median(compileMs)),
      compileMsRuns: compileMs,
      compileMsSpreadPercent: spreadPercent(compileMs),
      pdfBytes: marker?.pdfBytes,
      corpus: marker?.corpus,
      corpusIdentity: marker?.corpusIdentity,
      artifact: artifactStats(candidate),
    });
  }

  console.log(
    `ATLCLI_RUNTIME_LANE\n${JSON.stringify(
      {
        schema: "atlcli.runtime-lane/2",
        bunVersion: Bun.version,
        note: "Bun/JSC host lane: WASM linear high-water and relative candidate deltas are the comparable signals; Chrome remains the product-reference host.",
        results,
      },
      null,
      2,
    )}`,
  );
}

if (import.meta.main) runRuntimeLane();
