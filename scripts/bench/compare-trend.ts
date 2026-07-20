/**
 * Benchmark TREND comparison (spec 011, Benchmarks — "CI thresholds as
 * non-blocking trend first").
 *
 * Reads a fresh bench record, compares each phase against the rolling median of
 * the previous records for the SAME dataset and the SAME environment, and emits
 * a GitHub `::warning::` when wall-clock time regresses >20% or peak RSS >15%.
 * It never fails the build: for the first ~2 weeks the point is to accumulate a
 * trend line, not to gate merges. Absolute budgets get frozen into
 * `budgets.json` only once there is data to justify them.
 *
 * ## Why comparison is environment-scoped
 *
 * A record carries the fixture digest, the Typst wasm digest, the font-set
 * digest, the OS/arch/runner, and which `/usr/bin/time` flavour measured its
 * RSS. Comparing across any of those is meaningless — a wasm bump or a
 * different runner size moves the numbers for reasons that are not a
 * regression. {@link comparableHistory} filters to records that actually share
 * an environment, so a warning localizes to a phase AND an environment, and a
 * deliberate compiler bump silently resets the baseline instead of firing a
 * spurious alarm.
 *
 * Run: `bun scripts/bench/compare-trend.ts --current <record.json> --history <history.json> [--append]`
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { median } from "./bench-env.js";

/** Regression thresholds from the PLAN. Time is noisier than memory, hence 20/15. */
export const TIME_REGRESSION_RATIO = 1.2;
export const RSS_REGRESSION_RATIO = 1.15;
/** Keep the history bounded so the cache entry cannot grow without limit. */
export const HISTORY_LIMIT = 40;

export interface TrendPhase {
  phase: string;
  /** Wall-clock ms for the phase work. Engine records use `ms`, e2e `msCold`. */
  ms?: number;
  msCold?: number;
  peakRssBytes: number | null;
}

export interface TrendRecord {
  tier: string;
  commit: string;
  date: string;
  pages: number;
  datasetDigest: string;
  environment: {
    os: string;
    arch: string;
    runner: string;
    runtimeVersion: string;
    compilerWasmDigest: string;
    fontSetDigest: string;
    rssMethod: string;
  };
  phases: TrendPhase[];
  wholeRun: { wholeProcessPeakRssBytes: number | null };
}

/** The wall-clock number a phase contributes to the trend, whichever tier it is from. */
export function phaseMs(phase: TrendPhase): number {
  return phase.ms ?? phase.msCold ?? 0;
}

/**
 * The subset of `history` that is legitimately comparable with `current`: same
 * tier, same page count, same fixture, same pinned binaries, same machine class,
 * same RSS measurement method. Anything else is a different experiment.
 */
export function comparableHistory(current: TrendRecord, history: readonly TrendRecord[]): TrendRecord[] {
  return history.filter(
    (record) =>
      record.tier === current.tier &&
      record.pages === current.pages &&
      record.datasetDigest === current.datasetDigest &&
      record.environment.os === current.environment.os &&
      record.environment.arch === current.environment.arch &&
      record.environment.runner === current.environment.runner &&
      record.environment.compilerWasmDigest === current.environment.compilerWasmDigest &&
      record.environment.fontSetDigest === current.environment.fontSetDigest &&
      record.environment.rssMethod === current.environment.rssMethod &&
      record.commit !== current.commit,
  );
}

export interface TrendFinding {
  phase: string;
  metric: "time" | "rss";
  current: number;
  baseline: number;
  ratio: number;
  regressed: boolean;
}

/**
 * Compare every phase of `current` against the rolling median of `history`.
 * Pure — returns findings; the caller decides how to report them. Phases with
 * no comparable history produce no finding (nothing to regress against yet).
 */
export function compareTrend(current: TrendRecord, history: readonly TrendRecord[]): TrendFinding[] {
  const comparable = comparableHistory(current, history);
  if (comparable.length === 0) return [];
  const findings: TrendFinding[] = [];

  for (const phase of current.phases) {
    const pastMs = comparable
      .map((record) => record.phases.find((p) => p.phase === phase.phase))
      .filter((p): p is TrendPhase => p !== undefined)
      .map(phaseMs)
      .filter((ms) => ms > 0);
    const currentMs = phaseMs(phase);
    if (pastMs.length > 0 && currentMs > 0) {
      const baseline = median(pastMs);
      const ratio = currentMs / baseline;
      findings.push({
        phase: phase.phase,
        metric: "time",
        current: currentMs,
        baseline,
        ratio,
        regressed: ratio > TIME_REGRESSION_RATIO,
      });
    }

    const pastRss = comparable
      .map((record) => record.phases.find((p) => p.phase === phase.phase)?.peakRssBytes)
      .filter((rss): rss is number => typeof rss === "number");
    if (pastRss.length > 0 && phase.peakRssBytes !== null) {
      const baseline = median(pastRss);
      const ratio = phase.peakRssBytes / baseline;
      findings.push({
        phase: phase.phase,
        metric: "rss",
        current: phase.peakRssBytes,
        baseline,
        ratio,
        regressed: ratio > RSS_REGRESSION_RATIO,
      });
    }
  }

  // The whole-process peak is the run-level memory number; trend it too.
  const pastWhole = comparable
    .map((record) => record.wholeRun.wholeProcessPeakRssBytes)
    .filter((rss): rss is number => typeof rss === "number");
  if (pastWhole.length > 0 && current.wholeRun.wholeProcessPeakRssBytes !== null) {
    const baseline = median(pastWhole);
    const ratio = current.wholeRun.wholeProcessPeakRssBytes / baseline;
    findings.push({
      phase: "whole-run",
      metric: "rss",
      current: current.wholeRun.wholeProcessPeakRssBytes,
      baseline,
      ratio,
      regressed: ratio > RSS_REGRESSION_RATIO,
    });
  }

  return findings;
}

/** Append `current`, newest last, trimmed to {@link HISTORY_LIMIT}. */
export function appendHistory(history: readonly TrendRecord[], current: TrendRecord): TrendRecord[] {
  return [...history, current].slice(-HISTORY_LIMIT);
}

/**
 * Structural validity of one history entry.
 *
 * Valid JSON is not enough. A record that parses but lacks `environment` or
 * `phases` throws inside {@link comparableHistory} — and because that throw
 * happens BEFORE `--append` runs, the poisoned entry is never replaced, while
 * `restore-keys` faithfully restores it on every subsequent run. One malformed
 * record would kill the trend permanently and invisibly. Dropping bad entries
 * is the only failure mode that self-heals.
 */
export function isValidTrendRecord(value: unknown): value is TrendRecord {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Partial<TrendRecord>;
  if (typeof record.tier !== "string" || typeof record.commit !== "string") return false;
  if (typeof record.pages !== "number" || typeof record.datasetDigest !== "string") return false;
  if (!Array.isArray(record.phases)) return false;
  const environment = record.environment;
  if (typeof environment !== "object" || environment === null) return false;
  for (const key of ["os", "arch", "runner", "compilerWasmDigest", "fontSetDigest", "rssMethod"] as const) {
    if (typeof environment[key] !== "string") return false;
  }
  const wholeRun = record.wholeRun;
  if (typeof wholeRun !== "object" || wholeRun === null) return false;
  const peak = wholeRun.wholeProcessPeakRssBytes;
  return peak === null || typeof peak === "number";
}

function loadHistory(path: string): TrendRecord[] {
  if (!existsSync(path)) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    // A corrupt cache entry must not fail the job; start a fresh trend instead.
    process.stdout.write(`compare-trend: history at ${path} is unreadable — starting a new trend\n`);
    return [];
  }
  if (!Array.isArray(parsed)) {
    process.stdout.write(`compare-trend: history at ${path} is not an array — starting a new trend\n`);
    return [];
  }
  const valid = parsed.filter(isValidTrendRecord);
  if (valid.length !== parsed.length) {
    process.stdout.write(
      `compare-trend: dropped ${parsed.length - valid.length} malformed history record(s) — ` +
        "they are rewritten out of the cache on --append\n",
    );
  }
  return valid;
}

function fmt(metric: "time" | "rss", value: number): string {
  return metric === "time" ? `${value.toFixed(0)}ms` : `${(value / 1024 / 1024).toFixed(0)}MB`;
}

function main(): void {
  const args = process.argv.slice(2);
  const flag = (name: string): string | undefined => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const currentPath = flag("--current");
  const historyPath = flag("--history");
  if (!currentPath || !historyPath) {
    process.stderr.write("compare-trend: --current <record.json> and --history <history.json> are required\n");
    process.exit(2);
  }

  const current = JSON.parse(readFileSync(currentPath, "utf8")) as TrendRecord;
  const history = loadHistory(historyPath);
  const comparable = comparableHistory(current, history);
  const findings = compareTrend(current, history);

  process.stdout.write(
    `compare-trend [${current.tier}] ${current.pages} pages · commit ${current.commit.slice(0, 8)} · ` +
      `${comparable.length} comparable prior record(s) ` +
      `(${current.environment.os}/${current.environment.arch} · ${current.environment.runner} · ` +
      `wasm ${current.environment.compilerWasmDigest.slice(0, 8)} · rss ${current.environment.rssMethod})\n`,
  );

  if (comparable.length === 0) {
    process.stdout.write("compare-trend: no comparable history yet — recording the first data point.\n");
  }

  for (const finding of findings) {
    const line =
      `${current.tier}/${finding.phase} ${finding.metric}: ${fmt(finding.metric, finding.current)} vs ` +
      `median ${fmt(finding.metric, finding.baseline)} (${((finding.ratio - 1) * 100).toFixed(1)}%)`;
    if (finding.regressed) {
      const limit = finding.metric === "time" ? TIME_REGRESSION_RATIO : RSS_REGRESSION_RATIO;
      process.stdout.write(
        `::warning title=Bench regression (${current.tier} ${finding.phase} ${finding.metric})::` +
          `${line} — over the ${((limit - 1) * 100).toFixed(0)}% threshold ` +
          `[${current.environment.os}/${current.environment.arch}, runner ${current.environment.runner}]\n`,
      );
    } else {
      process.stdout.write(`  ${line}\n`);
    }
  }

  if (args.includes("--append")) {
    mkdirSync(dirname(historyPath), { recursive: true });
    writeFileSync(historyPath, JSON.stringify(appendHistory(history, current), null, 2));
    process.stdout.write(`compare-trend: history updated (${Math.min(history.length + 1, HISTORY_LIMIT)} records)\n`);
  }

  // Never fails: this is a trend signal, not a gate (PLAN — "Never a per-PR gate").
}

if (import.meta.main) main();
