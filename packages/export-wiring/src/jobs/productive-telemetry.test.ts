import { describe, expect, it } from "bun:test";
import { buildProductiveExportTelemetryV1 } from "./productive-telemetry.js";

describe("buildProductiveExportTelemetryV1", () => {
  it("projects renderer facts into truthful cross-format statistics and redacted issues", () => {
    const telemetry = buildProductiveExportTelemetryV1(
      {
        pageCount: 7,
        preparedBytes: 4_096,
        outputBytes: 2_048,
        renderAttempts: 2,
        embeddedAssets: 3,
        skippedAssets: 1,
        renderedDiagrams: 2,
        reportSummary: {
          issues: { info: 1, warning: 4, error: 1 },
          topCodes: [],
          completeness: "partial",
        },
        notes: [
          {
            level: "info",
            code: "macro-rendered-via",
            message: "sensitive detail is report-only",
            source: { pageId: "42", pageTitle: "Guide", blockPath: "blocks[1]" },
          },
          {
            level: "warning",
            code: "macro-not-rendered",
            message: "sensitive detail is report-only",
          },
          {
            level: "warning",
            code: "unknown-macro",
            message: "sensitive detail is report-only",
          },
          {
            level: "warning",
            code: "diagram-render-failed",
            message: "sensitive detail is report-only",
          },
        ],
        compilerIssues: [{ severity: "error", code: "pdf-compiler-error" }],
        durationsMs: { fetch: 10, compose: 20, render: 30 },
      },
      100,
    );

    expect(telemetry.stats).toMatchObject({
      pages: { discovered: 7, fetched: 7, composed: 7, skipped: 0 },
      assets: { discovered: 4, fetched: 3, embedded: 3, skipped: 1 },
      diagrams: { discovered: 3, rendered: 2, rasterized: 2, failed: 1 },
      macros: { discovered: 3, rendered: 1, approximated: 1, unresolved: 1 },
      retries: { total: 1, worker: 1 },
      storage: { spoolBytes: 4_096, spoolPeakBytes: null, outputBytes: 2_048 },
      durationsMs: { fetch: 10, compose: 20, render: 30 },
      warnings: 4,
      errors: 1,
      metricSupport: {
        "storage.spoolPeakBytes": "unavailable",
        "memory.heapPeakBytes": "unavailable",
        "memory.rendererPeakBytes": "unavailable",
      },
    });
    expect(telemetry.issues).toEqual([
      {
        kind: "issue",
        at: 100,
        level: "info",
        code: "macro-rendered-via",
        source: { pageId: "42", pageTitle: "Guide", blockId: "blocks[1]" },
      },
      { kind: "issue", at: 100, level: "warning", code: "macro-not-rendered" },
      { kind: "issue", at: 100, level: "warning", code: "unknown-macro" },
      { kind: "issue", at: 100, level: "warning", code: "diagram-render-failed" },
      { kind: "issue", at: 100, level: "error", code: "pdf-compiler-error" },
    ]);
  });

  it("rejects invalid host counters before they reach persisted snapshots", () => {
    expect(() =>
      buildProductiveExportTelemetryV1(
        {
          pageCount: -1,
          preparedBytes: 0,
          outputBytes: 0,
          renderAttempts: 0,
          embeddedAssets: 0,
          skippedAssets: 0,
          renderedDiagrams: 0,
          reportSummary: {
            issues: { info: 0, warning: 0, error: 0 },
            topCodes: [],
            completeness: "unknown",
          },
          notes: [],
          durationsMs: {},
        },
        0,
      ),
    ).toThrow("telemetry.pageCount");
  });
});

