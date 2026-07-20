/**
 * Tests for the benchmark trend comparison (spec 011, Benchmarks).
 *
 * The comparison is where a benchmark either earns trust or loses it: a false
 * alarm on every wasm bump trains people to ignore the warnings, and a missed
 * regression makes the whole workflow decorative. Both directions are pinned
 * here over pure functions — no CI, no files.
 */
import { describe, expect, it } from "bun:test";
import {
  appendHistory,
  comparableHistory,
  compareTrend,
  HISTORY_LIMIT,
  phaseMs,
  RSS_REGRESSION_RATIO,
  TIME_REGRESSION_RATIO,
  type TrendRecord,
} from "./compare-trend.js";

const ENV = {
  os: "linux",
  arch: "x64",
  runner: "ubuntu-latest",
  runtimeVersion: "1.3.5",
  compilerWasmDigest: "wasm-aaa",
  fontSetDigest: "fonts-aaa",
  rssMethod: "gnu-time-v",
};

function record(overrides: Partial<TrendRecord> = {}): TrendRecord {
  return {
    tier: "engine",
    commit: "commit-0",
    date: "2026-07-17T00:00:00.000Z",
    pages: 500,
    datasetDigest: "dataset-aaa",
    environment: { ...ENV },
    phases: [
      { phase: "compose", ms: 100, peakRssBytes: 100_000_000 },
      { phase: "pdf", ms: 1000, peakRssBytes: 1_000_000_000 },
    ],
    wholeRun: { wholeProcessPeakRssBytes: 1_200_000_000 },
    ...overrides,
  };
}

describe("phaseMs", () => {
  it("reads the engine tier's `ms`", () => {
    expect(phaseMs({ phase: "pdf", ms: 42, peakRssBytes: null })).toBe(42);
  });

  it("reads the e2e tier's `msCold`", () => {
    expect(phaseMs({ phase: "pdf", msCold: 84, peakRssBytes: null })).toBe(84);
  });
});

describe("comparableHistory", () => {
  it("keeps records from the same dataset, binaries, and machine", () => {
    const current = record({ commit: "new" });
    const history = [record({ commit: "old-1" }), record({ commit: "old-2" })];
    expect(comparableHistory(current, history)).toHaveLength(2);
  });

  it("excludes the current commit so a record never compares with itself", () => {
    const current = record({ commit: "same" });
    expect(comparableHistory(current, [record({ commit: "same" })])).toHaveLength(0);
  });

  it("excludes a different Typst wasm — a compiler bump is not a regression", () => {
    const current = record({ commit: "new" });
    const history = [
      record({ commit: "old", environment: { ...ENV, compilerWasmDigest: "wasm-bbb" } }),
    ];
    expect(comparableHistory(current, history)).toHaveLength(0);
  });

  it("excludes a different font set", () => {
    const current = record({ commit: "new" });
    const history = [record({ commit: "old", environment: { ...ENV, fontSetDigest: "fonts-bbb" } })];
    expect(comparableHistory(current, history)).toHaveLength(0);
  });

  it("excludes a different fixture, page count, or tier", () => {
    const current = record({ commit: "new" });
    expect(comparableHistory(current, [record({ commit: "a", datasetDigest: "other" })])).toHaveLength(0);
    expect(comparableHistory(current, [record({ commit: "b", pages: 50 })])).toHaveLength(0);
    expect(comparableHistory(current, [record({ commit: "c", tier: "end-to-end" })])).toHaveLength(0);
  });

  it("excludes a different runner or RSS measurement method", () => {
    const current = record({ commit: "new" });
    expect(
      comparableHistory(current, [record({ commit: "a", environment: { ...ENV, runner: "self-hosted" } })]),
    ).toHaveLength(0);
    expect(
      comparableHistory(current, [record({ commit: "b", environment: { ...ENV, rssMethod: "bsd-time-l" } })]),
    ).toHaveLength(0);
  });
});

describe("compareTrend", () => {
  it("produces no findings without comparable history", () => {
    expect(compareTrend(record(), [])).toEqual([]);
  });

  it("does not flag a phase within the time threshold", () => {
    const history = [record({ commit: "a" }), record({ commit: "b" }), record({ commit: "c" })];
    const current = record({
      commit: "new",
      phases: [
        { phase: "compose", ms: 100, peakRssBytes: 100_000_000 },
        // +19% — under the 20% threshold.
        { phase: "pdf", ms: 1190, peakRssBytes: 1_000_000_000 },
      ],
    });
    const pdfTime = compareTrend(current, history).find((f) => f.phase === "pdf" && f.metric === "time");
    expect(pdfTime?.regressed).toBe(false);
  });

  it("flags a phase whose time regresses past the threshold", () => {
    const history = [record({ commit: "a" }), record({ commit: "b" }), record({ commit: "c" })];
    const current = record({
      commit: "new",
      phases: [
        { phase: "compose", ms: 100, peakRssBytes: 100_000_000 },
        { phase: "pdf", ms: 1400, peakRssBytes: 1_000_000_000 }, // +40%
      ],
    });
    const pdfTime = compareTrend(current, history).find((f) => f.phase === "pdf" && f.metric === "time");
    expect(pdfTime?.regressed).toBe(true);
    expect(pdfTime?.ratio).toBeCloseTo(1.4, 5);
  });

  it("flags peak RSS on the tighter 15% threshold", () => {
    const history = [record({ commit: "a" }), record({ commit: "b" })];
    const current = record({
      commit: "new",
      phases: [
        { phase: "compose", ms: 100, peakRssBytes: 100_000_000 },
        { phase: "pdf", ms: 1000, peakRssBytes: 1_200_000_000 }, // +20% > 15%
      ],
    });
    const pdfRss = compareTrend(current, history).find((f) => f.phase === "pdf" && f.metric === "rss");
    expect(pdfRss?.regressed).toBe(true);
    // The same +20% on TIME would not have been flagged — the thresholds differ.
    expect(1.2 > RSS_REGRESSION_RATIO && 1.2 <= TIME_REGRESSION_RATIO).toBe(true);
  });

  it("uses the MEDIAN, so one slow outlier does not move the baseline", () => {
    const history = [
      record({ commit: "a" }),
      record({ commit: "b" }),
      // A single pathological run (10x) must not raise the baseline.
      record({
        commit: "outlier",
        phases: [
          { phase: "compose", ms: 100, peakRssBytes: 100_000_000 },
          { phase: "pdf", ms: 10_000, peakRssBytes: 1_000_000_000 },
        ],
      }),
    ];
    const current = record({
      commit: "new",
      phases: [
        { phase: "compose", ms: 100, peakRssBytes: 100_000_000 },
        { phase: "pdf", ms: 1400, peakRssBytes: 1_000_000_000 },
      ],
    });
    const pdfTime = compareTrend(current, history).find((f) => f.phase === "pdf" && f.metric === "time");
    expect(pdfTime?.baseline).toBe(1000);
    expect(pdfTime?.regressed).toBe(true);
  });

  it("trends the run-level whole-process peak RSS too", () => {
    const history = [record({ commit: "a" }), record({ commit: "b" })];
    const current = record({ commit: "new", wholeRun: { wholeProcessPeakRssBytes: 1_800_000_000 } });
    const whole = compareTrend(current, history).find((f) => f.phase === "whole-run");
    expect(whole?.metric).toBe("rss");
    expect(whole?.regressed).toBe(true);
  });

  it("skips RSS comparison when the number was never measured", () => {
    const history = [record({ commit: "a", phases: [{ phase: "pdf", ms: 1000, peakRssBytes: null }] })];
    const current = record({ commit: "new", phases: [{ phase: "pdf", ms: 1000, peakRssBytes: null }] });
    expect(compareTrend(current, history).filter((f) => f.metric === "rss" && f.phase === "pdf")).toEqual([]);
  });

  it("compares an e2e record on its cold number", () => {
    const e2e = (commit: string, msCold: number): TrendRecord =>
      record({
        commit,
        tier: "end-to-end",
        phases: [{ phase: "pdf", msCold, peakRssBytes: 1_000_000_000 }],
      });
    const finding = compareTrend(e2e("new", 1500), [e2e("a", 1000), e2e("b", 1000)]).find(
      (f) => f.metric === "time",
    );
    expect(finding?.baseline).toBe(1000);
    expect(finding?.regressed).toBe(true);
  });
});

describe("appendHistory", () => {
  it("appends newest last", () => {
    const history = [record({ commit: "a" })];
    expect(appendHistory(history, record({ commit: "b" })).map((r) => r.commit)).toEqual(["a", "b"]);
  });

  it("trims to the history limit, dropping the oldest", () => {
    const history = Array.from({ length: HISTORY_LIMIT }, (_, i) => record({ commit: `c${i}` }));
    const grown = appendHistory(history, record({ commit: "newest" }));
    expect(grown).toHaveLength(HISTORY_LIMIT);
    expect(grown[grown.length - 1]!.commit).toBe("newest");
    expect(grown[0]!.commit).toBe("c1");
  });
});
