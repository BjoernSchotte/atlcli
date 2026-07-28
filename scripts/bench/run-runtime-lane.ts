/**
 * Runtime candidate lanes (issue #118 Phase 2): compare the pinned Typst
 * runtime against separately attributable candidates on the SAME corpus with
 * the SAME pipeline — isolated child processes, `/usr/bin/time` peak RSS,
 * plus the child-reported WASM linear-memory high-water.
 *
 *   bun --conditions=development scripts/bench/run-runtime-lane.ts [--repeat 3] [--candidate name]
 *
 * Candidates: `baseline` (vendored typst.ts 0.7.0 / Typst 0.14.2) and `rc8`
 * (published typst.ts 0.8.0-rc3 / Typst 0.15.0-rc.1, upstream feature set
 * unchanged, devDependency alias — the production vendor pin is untouched).
 * The corpus comes from the materialized cache written by the Chrome
 * memory-harness prebench (`apps/extension/tests/pdf/memory/public/image-heavy`).
 */
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { median, runMeasured } from "./bench-env.js";

const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const CORPUS_DIR = join(ROOT, "apps/extension/tests/pdf/memory/public/image-heavy");
const CANDIDATES = ["baseline", "rc8"] as const;

function argValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

if (!existsSync(join(CORPUS_DIR, "manifest.json"))) {
  throw new Error(
    `Materialized corpus missing at ${CORPUS_DIR} — run ` +
      "`bun --conditions=development apps/extension/tests/pdf/memory/generate-corpus.ts` first.",
  );
}

const repeat = Number(argValue("--repeat") ?? "3");
const only = argValue("--candidate");
const corpus = argValue("--corpus") ?? "image-heavy";
const corpusArg = corpus === "text-heavy" ? "text-heavy" : CORPUS_DIR;

const results: Array<Record<string, unknown>> = [];
for (const candidate of CANDIDATES) {
  if (only && candidate !== only) continue;
  const peaks: number[] = [];
  const compileMs: number[] = [];
  const wasmHighWater: number[] = [];
  let marker: Record<string, unknown> | undefined;
  for (let run = 0; run < repeat; run += 1) {
    const measured = runMeasured(
      "bun",
      ["--conditions=development", join(ROOT, "scripts/bench/runtime-lane-child.ts"), candidate, corpusArg],
      { cwd: ROOT, timeoutMs: 1_800_000 },
    );
    if (measured.exitCode !== 0) {
      throw new Error(`runtime lane ${candidate} failed (${measured.exitCode}):\n${measured.stderr}\n${measured.stdout}`);
    }
    const line = measured.stdout.split("\n").find((entry) => entry.startsWith("ATLCLI_RUNTIME_LANE_CHILD "));
    if (!line) throw new Error(`runtime lane ${candidate} printed no marker`);
    marker = JSON.parse(line.slice("ATLCLI_RUNTIME_LANE_CHILD ".length)) as Record<string, unknown>;
    if (measured.peakRssBytes === null) throw new Error("peak RSS unobservable on this host");
    peaks.push(measured.peakRssBytes);
    compileMs.push(Number(marker.compileMs));
    wasmHighWater.push(Number(marker.wasmHighWaterMiB));
  }
  results.push({
    candidate,
    compilerVersion: marker?.compilerVersion,
    repeat,
    peakRssMiB: Number((median(peaks) / 1048576).toFixed(2)),
    peakRssRunsMiB: peaks.map((value) => Number((value / 1048576).toFixed(2))),
    wasmHighWaterMiB: median(wasmHighWater),
    compileMsMedian: Math.round(median(compileMs)),
    pdfBytes: marker?.pdfBytes,
    corpus: marker?.corpus,
    corpusIdentity: marker?.corpusIdentity,
  });
}

console.log(`ATLCLI_RUNTIME_LANE\n${JSON.stringify({
  schema: "atlcli.runtime-lane/1",
  bunVersion: Bun.version,
  note: "Bun/JSC host lane: WASM linear high-water and relative candidate deltas are the comparable signals; Chrome remains the product-reference host.",
  results,
}, null, 2)}`);
