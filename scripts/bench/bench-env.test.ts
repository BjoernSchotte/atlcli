/**
 * Tests for the benchmark measurement plumbing (spec 011, Benchmarks).
 *
 * The RSS parser and the phase-result channel are the two places where a silent
 * bug would produce a plausible-looking but wrong envelope, so both are pinned
 * against REAL captured `/usr/bin/time` output (GNU and BSD) rather than a
 * mocked shape. `runMeasured` is exercised against a real child process.
 */
import { describe, expect, it } from "bun:test";
import {
  benchRunnerLabel,
  detectTimeFlavour,
  emitPhaseResult,
  maxOrNull,
  median,
  parsePeakRss,
  parsePhaseResult,
  PHASE_RESULT_MARKER,
  runMeasured,
} from "./bench-env.js";

/** Verbatim GNU `/usr/bin/time -v` stderr (Linux/CI flavour). */
const GNU_TIME_STDERR = `\tCommand being timed: "bun script.ts"
\tUser time (seconds): 1.20
\tSystem time (seconds): 0.30
\tPercent of CPU this job got: 99%
\tElapsed (wall clock) time (h:mm:ss or m:ss): 0:01.51
\tMaximum resident set size (kbytes): 431256
\tExit status: 0`;

/**
 * Verbatim BSD `/usr/bin/time -l` stderr (macOS flavour, bytes not kbytes).
 * The `peak memory footprint` figure is deliberately REALISTIC — on real macOS
 * output it sits within a few percent of the RSS line, which is exactly what
 * makes confusing the two dangerous: the wrong number looks entirely plausible.
 */
const BSD_TIME_STDERR = `        0.13 real         0.09 user         0.03 sys
           444751872  maximum resident set size
                   0  average shared memory size
           431245312  peak memory footprint`;

describe("parsePeakRss", () => {
  it("reads GNU kbytes and converts to bytes", () => {
    expect(parsePeakRss(GNU_TIME_STDERR, "gnu-time-v")).toBe(431256 * 1024);
  });

  it("reads BSD bytes as-is", () => {
    expect(parsePeakRss(BSD_TIME_STDERR, "bsd-time-l")).toBe(444751872);
  });

  it("does not mistake BSD 'peak memory footprint' for the RSS line", () => {
    // The BSD block carries a SECOND memory figure that is close to the RSS
    // one (~3% apart here, as on real macOS output). Reading it would report a
    // different metric under the peak-RSS name — plausible enough to survive
    // review, and wrong in the direction that hides memory growth.
    expect(parsePeakRss(BSD_TIME_STDERR, "bsd-time-l")).toBe(444751872);
    expect(parsePeakRss(BSD_TIME_STDERR, "bsd-time-l")).not.toBe(431245312);
  });

  it("never cross-parses one flavour with the other's pattern", () => {
    expect(parsePeakRss(GNU_TIME_STDERR, "bsd-time-l")).toBeNull();
    expect(parsePeakRss(BSD_TIME_STDERR, "gnu-time-v")).toBeNull();
  });

  it("returns null rather than a fabricated number when time is unavailable", () => {
    expect(parsePeakRss(GNU_TIME_STDERR, "unavailable")).toBeNull();
    expect(parsePeakRss("", "gnu-time-v")).toBeNull();
  });
});

describe("benchRunnerLabel", () => {
  const host = () => "dev-laptop.local";

  it("uses the hostname locally — a dev machine is its own class", () => {
    expect(benchRunnerLabel({}, host)).toBe("dev-laptop.local");
  });

  it("IGNORES the instance-specific RUNNER_NAME in CI", () => {
    // THE regression this whole function exists for. GitHub-hosted runners set
    // RUNNER_NAME to a per-instance value that changes between runs, and it is
    // ALWAYS set. Keying the trend on it made every nightly non-comparable with
    // every other one — so the workflow silently never warned, invisibly,
    // behind `continue-on-error: true`.
    const runOne = benchRunnerLabel(
      { CI: "true", RUNNER_NAME: "GitHub Actions 2", RUNNER_ENVIRONMENT: "github-hosted", RUNNER_OS: "Linux", RUNNER_ARCH: "X64" },
      host,
    );
    const runTwo = benchRunnerLabel(
      { CI: "true", RUNNER_NAME: "GitHub Actions 14", RUNNER_ENVIRONMENT: "github-hosted", RUNNER_OS: "Linux", RUNNER_ARCH: "X64" },
      host,
    );
    expect(runOne).toBe(runTwo);
    expect(runOne).not.toContain("GitHub Actions");
  });

  it("separates genuinely different runner classes", () => {
    const linux = benchRunnerLabel({ CI: "true", RUNNER_ENVIRONMENT: "github-hosted", RUNNER_OS: "Linux", RUNNER_ARCH: "X64" }, host);
    const macos = benchRunnerLabel({ CI: "true", RUNNER_ENVIRONMENT: "github-hosted", RUNNER_OS: "macOS", RUNNER_ARCH: "ARM64" }, host);
    const selfHosted = benchRunnerLabel({ CI: "true", RUNNER_ENVIRONMENT: "self-hosted", RUNNER_OS: "Linux", RUNNER_ARCH: "X64" }, host);
    expect(new Set([linux, macos, selfHosted]).size).toBe(3);
  });

  it("does not use the hostname in CI (CI hostnames are per-instance too)", () => {
    expect(benchRunnerLabel({ CI: "true", RUNNER_OS: "Linux" }, host)).not.toContain("dev-laptop");
  });

  it("lets an explicit override win, for a self-hosted fleet declaring its class", () => {
    expect(benchRunnerLabel({ CI: "true", RUNNER_OS: "Linux", ATLCLI_BENCH_RUNNER: "bench-rig-a" }, host)).toBe("bench-rig-a");
    expect(benchRunnerLabel({ ATLCLI_BENCH_RUNNER: "  " }, host)).toBe("dev-laptop.local");
  });
});

describe("median", () => {
  it("takes the middle of an odd sample", () => {
    expect(median([30, 10, 20])).toBe(20);
  });

  it("averages the middle pair of an even sample", () => {
    expect(median([10, 20, 30, 40])).toBe(25);
  });

  it("throws on an empty sample instead of returning NaN", () => {
    expect(() => median([])).toThrow();
  });
});

describe("maxOrNull", () => {
  it("ignores nulls", () => {
    expect(maxOrNull([100, null, 300])).toBe(300);
  });

  it("is null when every sample is null", () => {
    expect(maxOrNull([null, null])).toBeNull();
  });
});

describe("phase-result channel", () => {
  it("round-trips a result through the marker line", () => {
    const payload = [{ phase: "pdf", ms: 12.5, outputBytes: 4096 }];
    const stdout = `noise before\n${PHASE_RESULT_MARKER}${JSON.stringify(payload)}\nnoise after\n`;
    expect(parsePhaseResult<typeof payload>(stdout)).toEqual(payload);
  });

  it("returns null when the child emitted no result line", () => {
    expect(parsePhaseResult("just some logging\n")).toBeNull();
  });

  it("ignores incidental output that merely mentions the marker mid-line", () => {
    expect(parsePhaseResult(`about to write ${PHASE_RESULT_MARKER}soon\n`)).toBeNull();
  });

  it("emitPhaseResult writes a line parsePhaseResult can read back", () => {
    const written: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    // Capture the one line the emitter writes; restored immediately after.
    (process.stdout as { write: unknown }).write = (chunk: string) => {
      written.push(chunk);
      return true;
    };
    try {
      emitPhaseResult({ phase: "compose", ms: 1 });
    } finally {
      (process.stdout as { write: unknown }).write = original;
    }
    expect(parsePhaseResult<{ phase: string; ms: number }>(written.join(""))).toEqual({
      phase: "compose",
      ms: 1,
    });
  });
});

describe("runMeasured", () => {
  it("measures a real child process and reports its exit code and stdout", () => {
    const measured = runMeasured("echo", ["bench-ok"]);
    expect(measured.exitCode).toBe(0);
    expect(measured.stdout.trim()).toBe("bench-ok");
    expect(measured.ms).toBeGreaterThan(0);
  });

  it("surfaces a non-zero exit code rather than swallowing it", () => {
    const measured = runMeasured("false", []);
    expect(measured.exitCode).not.toBe(0);
  });

  it("reports a peak RSS whenever a /usr/bin/time flavour exists here", () => {
    const measured = runMeasured("echo", ["rss"]);
    expect(measured.rssMethod).toBe(detectTimeFlavour());
    if (measured.rssMethod === "unavailable") {
      // Honest degradation: no number invented when the tool is missing.
      expect(measured.peakRssBytes).toBeNull();
    } else {
      expect(measured.peakRssBytes).toBeGreaterThan(0);
    }
  });
});
