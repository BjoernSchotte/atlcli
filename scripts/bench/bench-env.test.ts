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

/** Verbatim BSD `/usr/bin/time -l` stderr (macOS flavour, bytes not kbytes). */
const BSD_TIME_STDERR = `        0.13 real         0.09 user         0.03 sys
           444751872  maximum resident set size
                   0  average shared memory size
              123456  peak memory footprint`;

describe("parsePeakRss", () => {
  it("reads GNU kbytes and converts to bytes", () => {
    expect(parsePeakRss(GNU_TIME_STDERR, "gnu-time-v")).toBe(431256 * 1024);
  });

  it("reads BSD bytes as-is", () => {
    expect(parsePeakRss(BSD_TIME_STDERR, "bsd-time-l")).toBe(444751872);
  });

  it("does not mistake BSD 'peak memory footprint' for the RSS line", () => {
    // The BSD block contains a second, different memory figure. Reading it
    // would silently understate peak RSS by ~3500x on macOS.
    expect(parsePeakRss(BSD_TIME_STDERR, "bsd-time-l")).not.toBe(123456);
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
