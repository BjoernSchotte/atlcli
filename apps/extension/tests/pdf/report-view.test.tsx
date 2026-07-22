import { describe, expect, it } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PdfReportView } from "../../entrypoints/sidepanel/PdfSection.js";

describe("PdfReportView", () => {
  it("renders PDF-specific counts and notes", () => {
    const html = renderToStaticMarkup(
      <PdfReportView report={{
        filename: "Guide.pdf",
        profile: "tagged",
        compilerVersion: "test",
        embeddedImages: 2,
        renderedDiagrams: 1,
        skippedAssets: 0,
        notes: [{ level: "warning", code: "pdf-image-alt-fallback", message: "Alt text missing" }],
        complete: true,
        timings: { prepareMs: 1, compileMs: 2, emitMs: 1, totalMs: 4 },
      }} />
    );
    expect(html).toContain("Guide.pdf");
    expect(html).toContain("2 image(s)");
    expect(html).toContain("1 diagram(s)");
    expect(html).toContain("Alt text missing");
    expect(html).toContain("4 ms");
    expect(html).toContain("Prepare 1 ms");
    expect(html).toContain("Compile 2 ms");
    expect(html).toContain("Download 1 ms");
    expect(html).toContain('aria-label="PDF export timing breakdown"');
  });

  it("formats long export phases in readable seconds", () => {
    const html = renderToStaticMarkup(
      <PdfReportView report={{
        filename: "Long.pdf",
        profile: "tagged",
        compilerVersion: "test",
        embeddedImages: 5,
        renderedDiagrams: 0,
        skippedAssets: 0,
        notes: [],
        complete: true,
        timings: { prepareMs: 3650, compileMs: 1042, emitMs: 200, totalMs: 4892 },
      }} />
    );

    expect(html).toContain("4.9 s");
    expect(html).toContain("Prepare 3.6 s");
    expect(html).toContain("Compile 1.0 s");
    expect(html).toContain("Download 200 ms");
  });

  it("surfaces macro outcomes before the collapsed detail notes", () => {
    const html = renderToStaticMarkup(
      <PdfReportView report={{
        filename: "Macros.pdf",
        profile: "tagged",
        compilerVersion: "test",
        embeddedImages: 0,
        renderedDiagrams: 0,
        skippedAssets: 0,
        notes: [
          { level: "info", code: "macro-rendered-via", message: "Rendered A" },
          { level: "info", code: "macro-rendered-via", message: "Rendered B" },
          { level: "warning", code: "macro-degraded", message: "Used a placeholder" },
          { level: "info", code: "macro-skipped-by-config", message: "Live rendering off" },
        ],
        complete: true,
        timings: { prepareMs: 1, compileMs: 2, emitMs: 1, totalMs: 4 },
      }} />
    );

    expect(html).toContain("Live rendered: 2");
    expect(html).toContain("Degraded: 1");
    expect(html).toContain("Skipped by setting: 1");
    expect(html).toContain("Rendered A");
    expect(html).toContain("Used a placeholder");
    expect(html.indexOf("macro-outcome-summary")).toBeLessThan(html.indexOf("<details"));
  });
});
