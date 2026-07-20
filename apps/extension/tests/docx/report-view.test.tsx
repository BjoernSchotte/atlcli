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
    riskyFieldInstructions: [],
};

function makeReport(notes: ExportReport["notes"]): ExportReport {
  return {
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
    expect(html).toContain("report-notes-warning");
    expect(html).toContain("Could not load space");
    expect(html).toContain("Warnings (1)");
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
    expect(html).toContain("report-notes-warning");
    expect(html).toContain("report-notes-info");
    expect(html).toContain("user gone");
    expect(html).toContain("image X skipped");
  });

  it("omits the notes sections when there are no notes", () => {
    const html = renderToStaticMarkup(<ReportView report={makeReport([])} />);
    expect(html).not.toContain("report-notes-warning");
    expect(html).not.toContain("report-notes-info");
  });
});
