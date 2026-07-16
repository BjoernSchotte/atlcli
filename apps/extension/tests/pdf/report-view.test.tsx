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
        timings: { prepareMs: 1, compileMs: 2, downloadMs: 1, totalMs: 4 },
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
        timings: { prepareMs: 3650, compileMs: 1042, downloadMs: 200, totalMs: 4892 },
      }} />
    );

    expect(html).toContain("4.9 s");
    expect(html).toContain("Prepare 3.6 s");
    expect(html).toContain("Compile 1.0 s");
    expect(html).toContain("Download 200 ms");
  });
});
