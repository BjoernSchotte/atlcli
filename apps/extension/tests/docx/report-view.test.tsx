/**
 * Renders the real {@link ReportView} React component (via react-dom's static
 * renderer — actual React output, not a stub) and asserts the export report's
 * notes reach the panel. Notes are the export trust surface (PLAN §2.5): before
 * this, fetch failures / image skips / warnings were computed but never shown.
 */
import { describe, expect, it } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ReportView } from "../../entrypoints/sidepanel/TemplateSection.js";
import type { ExportReport } from "@atlcli/docx/browser";

const emptyScan: ExportReport["scan"] = {
  supported: [],
  unsupported: [],
  never: [],
  parts: ["word/document.xml"],
  hasContentPlaceholder: true,
    stylerefStyleNames: [],
};

function makeReport(notes: ExportReport["notes"]): ExportReport {
  return {
    codeTheme: "github-light",
    resolvedCount: 3,
    unsupportedNames: [],
    skippedImages: 0,
    embeddedImages: 0,
    renderedDiagrams: 0,
    durationMs: 42,
    filename: "page.docx",
    notes,
    complete: true,
    scan: emptyScan,
    timings: {
      resolveMs: 0,
      bodyMs: 0,
      logoFetchMs: 0,
      includeFetchMs: 0,
      renderMs: 0,
      imageFetchMs: 0,
      imageFetches: 0,
      diagramRenderMs: 0,
      diagramRasterMs: 0,
    },
  };
}

describe("ReportView — notes rendering (#15)", () => {
  it("shows the exact Shiki theme used by the export", () => {
    const html = renderToStaticMarkup(
      <ReportView report={{ ...makeReport([]), codeTheme: "dracula" }} />
    );
    expect(html).toContain('data-testid="report-code-theme"');
    expect(html).toContain("Code theme: dracula");
  });

  it("renders a space-fetch-failed warning note in the panel", () => {
    const html = renderToStaticMarkup(
      <ReportView
        report={makeReport([
          {
            level: "warning",
            code: "space-fetch-failed",
            message: 'Could not load space "ENG"; space placeholders will be empty.',
          },
        ])}
      />
    );
    expect(html).toContain("report-category-dynamic");
    expect(html).toContain("Could not load space");
    expect(html).toContain("Warnings: 1");
  });

  it("groups info and warning notes separately", () => {
    const html = renderToStaticMarkup(
      <ReportView
        report={makeReport([
          { level: "warning", code: "user-fetch-failed", message: "user gone" },
          { level: "info", code: "image-skipped", message: "image X skipped" },
        ])}
      />
    );
    expect(html).toContain("report-category-dynamic");
    expect(html).toContain("report-category-content");
    expect(html).toContain("user gone");
    expect(html).toContain("image X skipped");
  });

  it("omits the notes sections when there are no notes", () => {
    const html = renderToStaticMarkup(<ReportView report={makeReport([])} />);
    expect(html).not.toContain("report-category-");
    expect(html).not.toContain("Export report");
  });

  it("shows the same macro outcome summary while retaining level groups", () => {
    const html = renderToStaticMarkup(
      <ReportView
        report={makeReport([
          { level: "info", code: "macro-rendered-via", message: "Rendered A" },
          { level: "info", code: "macro-rendered-via", message: "Rendered B" },
          { level: "warning", code: "macro-degraded", message: "Fallback used" },
          { level: "info", code: "macro-skipped-by-config", message: "Live rendering off" },
        ])}
      />
    );

    expect(html).toContain("Live rendered: 2");
    expect(html).toContain("Degraded: 1");
    expect(html).toContain("Skipped by setting: 1");
    expect(html).toContain("report-category-dynamic");
    expect(html).toContain("Fallback used");
    expect(html).toContain("Rendered A");
    expect(html).toContain("Dynamic content rendered");
    expect(html).toContain("×2");
  });
});
