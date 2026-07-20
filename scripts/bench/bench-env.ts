/**
 * Shared benchmark plumbing (spec 011, Benchmarks): the RSS methodology, the
 * dataset/environment fingerprint, and small statistics helpers.
 *
 * ## RSS methodology (read this before trusting any number here)
 *
 * `/usr/bin/time` reports the **peak resident set size of one whole process**.
 * There is no way to ask it for "the peak RSS of phase 2 of that process", and
 * an in-process `process.memoryUsage()` sample is not a substitute: it measures
 * the heap at an instant, contaminated by the previous phase's uncollected
 * garbage, and misses the wasm linear memory the Typst compiler owns.
 *
 * So this module offers exactly one primitive — {@link runMeasured}, which runs
 * a child command under `/usr/bin/time` and returns its wall-clock ms plus its
 * whole-process peak RSS — and the runners use it two ways:
 *
 *   - one child that runs **all** phases → its peak becomes the run-level
 *     `wholeProcessPeakRssBytes`;
 *   - one child **per phase** → each phase's `peakRssBytes` is the whole-process
 *     peak of a process that did only that phase.
 *
 * A per-phase number is therefore still a whole-process number; it is
 * phase-scoped only because the process was. It includes the Bun runtime
 * baseline, the fixture load, and (for the PDF phase) the wasm + font bytes.
 * The runners always also record a `baseline` phase (load everything, do no
 * work) so a reader can subtract instead of guessing. Nothing here reports a
 * per-phase RSS derived from in-process sampling.
 *
 * `/usr/bin/time` comes in two incompatible flavours: GNU (`-v`, kbytes) on
 * Linux/CI and BSD (`-l`, bytes) on macOS. Both are parsed, and the flavour
 * used is recorded on every measurement as `rssMethod` so a number measured on
 * a dev Mac is never silently compared against a CI number.
 */
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { platform, release, arch, cpus, totalmem, hostname } from "node:os";
import { fileURLToPath } from "node:url";

/** How the peak RSS for a measurement was obtained. */
export type RssMethod = "gnu-time-v" | "bsd-time-l" | "unavailable";

export interface Measured {
  /** Wall-clock milliseconds for the whole child process. */
  ms: number;
  /** Whole-process peak RSS in bytes, or `null` when no `time` flavour worked. */
  peakRssBytes: number | null;
  rssMethod: RssMethod;
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** Probe which `/usr/bin/time` flavour this machine has. Cached per process. */
let cachedFlavour: RssMethod | undefined;
export function detectTimeFlavour(): RssMethod {
  if (cachedFlavour) return cachedFlavour;
  const gnu = spawnSync("/usr/bin/time", ["-v", "true"], { encoding: "utf8" });
  if (gnu.status === 0 && /Maximum resident set size/i.test(gnu.stderr ?? "")) {
    cachedFlavour = "gnu-time-v";
    return cachedFlavour;
  }
  const bsd = spawnSync("/usr/bin/time", ["-l", "true"], { encoding: "utf8" });
  if (bsd.status === 0 && /maximum resident set size/i.test(bsd.stderr ?? "")) {
    cachedFlavour = "bsd-time-l";
    return cachedFlavour;
  }
  cachedFlavour = "unavailable";
  return cachedFlavour;
}

/**
 * Parse peak RSS out of a `/usr/bin/time` stderr block.
 * GNU reports kbytes ("Maximum resident set size (kbytes): 123456");
 * BSD reports bytes ("     123456  maximum resident set size").
 * Pure — unit-tested directly against captured `time` output.
 */
export function parsePeakRss(stderr: string, flavour: RssMethod): number | null {
  if (flavour === "gnu-time-v") {
    const m = /Maximum resident set size \(kbytes\):\s*(\d+)/i.exec(stderr);
    return m ? Number(m[1]) * 1024 : null;
  }
  if (flavour === "bsd-time-l") {
    const m = /^\s*(\d+)\s+maximum resident set size/im.exec(stderr);
    return m ? Number(m[1]) : null;
  }
  return null;
}

/**
 * Run a command as a child process and measure its wall-clock ms and
 * whole-process peak RSS. Falls back to timing-only (`peakRssBytes: null`,
 * `rssMethod: "unavailable"`) when neither `time` flavour is present, rather
 * than fabricating a number.
 */
export function runMeasured(
  command: string,
  args: string[],
  options: { cwd?: string; env?: Record<string, string | undefined>; timeoutMs?: number } = {},
): Measured {
  const flavour = detectTimeFlavour();
  const started = performance.now();
  const spawnOptions = {
    cwd: options.cwd,
    env: { ...process.env, ...options.env } as Record<string, string>,
    encoding: "utf8" as const,
    timeout: options.timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
  };
  const result =
    flavour === "unavailable"
      ? spawnSync(command, args, spawnOptions)
      : spawnSync("/usr/bin/time", [flavour === "gnu-time-v" ? "-v" : "-l", command, ...args], spawnOptions);
  const ms = performance.now() - started;
  const stderr = result.stderr ?? "";
  return {
    ms,
    peakRssBytes: parsePeakRss(stderr, flavour),
    rssMethod: flavour,
    exitCode: result.status ?? -1,
    stdout: result.stdout ?? "",
    stderr,
  };
}

// ---------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------

/** Median of a non-empty numeric sample (mean of the middle pair when even). */
export function median(values: readonly number[]): number {
  if (values.length === 0) throw new Error("median() of an empty sample");
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** Max of a sample, ignoring nulls; `null` when every entry is null. */
export function maxOrNull(values: readonly (number | null)[]): number | null {
  const present = values.filter((v): v is number => v !== null);
  return present.length === 0 ? null : Math.max(...present);
}

// ---------------------------------------------------------------------------
// Dataset + environment fingerprint
// ---------------------------------------------------------------------------

export interface BenchEnvironment {
  /** `bun` — the runtime the benchmark ran under, with its exact version. */
  runtime: string;
  runtimeVersion: string;
  os: string;
  osRelease: string;
  arch: string;
  cpuModel: string;
  cpuCount: number;
  totalMemBytes: number;
  /** Runner CLASS label (see {@link benchRunnerLabel}) — never an instance name. */
  runner: string;
  ci: boolean;
  /** sha256 of the pinned Typst wasm — a compiler bump must invalidate a trend. */
  compilerWasmDigest: string;
  /** sha256 over every pinned font file, in a stable order. */
  fontSetDigest: string;
  /** Which `/usr/bin/time` flavour produced the RSS numbers in this record. */
  rssMethod: RssMethod;
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/**
 * The runner label used as part of the trend COMPARABILITY key.
 *
 * This must identify a runner *class*, never a runner *instance*. GitHub-hosted
 * runners set `RUNNER_NAME` to an instance-specific value ("GitHub Actions 2",
 * "GitHub Actions 14", …) that changes between runs — and it is always set, so
 * a naive `RUNNER_NAME ?? RUNNER_OS` never reaches the stable variable. Keying
 * on it would make every nightly non-comparable with every other nightly: the
 * trend would report "no comparable history yet" forever and never warn, which
 * behind `continue-on-error: true` is a silent, permanent failure.
 *
 * So in CI the label is built from the runner class — environment
 * (github-hosted vs self-hosted, a real performance difference), OS, and arch.
 * Locally the hostname is right: a dev machine IS its own class.
 * `ATLCLI_BENCH_RUNNER` overrides both, for a self-hosted fleet that wants to
 * declare its own stable class label.
 */
export function benchRunnerLabel(
  env: Record<string, string | undefined>,
  hostnameFn: () => string,
): string {
  const override = env.ATLCLI_BENCH_RUNNER?.trim();
  if (override) return override;
  if (env.CI === "true") {
    const environment = env.RUNNER_ENVIRONMENT ?? "unknown";
    const os = env.RUNNER_OS ?? "unknown";
    const architecture = env.RUNNER_ARCH ?? "unknown";
    return `ci:${environment}:${os}:${architecture}`;
  }
  return hostnameFn();
}

function safeDigest(fn: () => string): string {
  try {
    return fn();
  } catch {
    return "unavailable";
  }
}

/** Short git commit for the record; `"unknown"` outside a git checkout. */
export function gitCommit(): string {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

/**
 * Fingerprint the machine + the pinned binary inputs. Recorded on every bench
 * record so a regression localizes to a phase AND an environment: a Typst wasm
 * bump, a font re-pin, a different runner size, or a different `time` flavour
 * each change a field here rather than silently moving the numbers.
 */
export async function collectEnvironment(): Promise<BenchEnvironment> {
  const wasmDigest = safeDigest(() => sha256File(fileURLToPath(import.meta.resolve("@atlcli/pdf-compiler-browser/wasm"))));
  const { PDF_RUNTIME_ASSETS } = await import("@atlcli/pdf");
  const fontDigest = safeDigest(() => {
    const hash = createHash("sha256");
    for (const font of [...PDF_RUNTIME_ASSETS.fonts].sort((a, b) => a.fileName.localeCompare(b.fileName))) {
      hash.update(font.fileName);
      hash.update(readFileSync(fileURLToPath(import.meta.resolve(`@atlcli/pdf/fonts/${font.fileName}`))));
    }
    return hash.digest("hex");
  });
  return {
    runtime: "bun",
    runtimeVersion: Bun.version,
    os: platform(),
    osRelease: release(),
    arch: arch(),
    cpuModel: cpus()[0]?.model ?? "unknown",
    cpuCount: cpus().length,
    totalMemBytes: totalmem(),
    runner: benchRunnerLabel(process.env, hostname),
    ci: process.env.CI === "true",
    compilerWasmDigest: wasmDigest,
    fontSetDigest: fontDigest,
    rssMethod: detectTimeFlavour(),
  };
}

/** sha256 over an arbitrary JSON-serializable dataset (the fixture fingerprint). */
export function datasetDigest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

// ---------------------------------------------------------------------------
// Phase-child protocol
// ---------------------------------------------------------------------------

/**
 * Phase children print exactly one line prefixed with this marker, carrying the
 * phase's own JSON result. The parent scrapes it out of the child's stdout —
 * keeping the channel explicit means incidental logging can never be mistaken
 * for a measurement.
 */
export const PHASE_RESULT_MARKER = "__BENCH_PHASE_RESULT__ ";

export function emitPhaseResult(value: unknown): void {
  process.stdout.write(`${PHASE_RESULT_MARKER}${JSON.stringify(value)}\n`);
}

/** Extract the phase result a child emitted; `null` when it emitted none. */
export function parsePhaseResult<T>(stdout: string): T | null {
  for (const line of stdout.split("\n")) {
    if (line.startsWith(PHASE_RESULT_MARKER)) {
      return JSON.parse(line.slice(PHASE_RESULT_MARKER.length)) as T;
    }
  }
  return null;
}
