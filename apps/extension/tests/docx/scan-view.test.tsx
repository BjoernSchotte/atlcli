/**
 * Renders the real {@link ScanView} (via react-dom's static renderer) and asserts
 * the content-insertion-point line. `$scroll.content` is intentionally excluded
 * from the placeholder list, which led a user to believe the content anchor was
 * missing (spec 004 E2E finding). The scan already carries `hasContentPlaceholder`;
 * this line surfaces it for both the found and absent cases.
 */
import { describe, expect, it } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ScanView } from "../../entrypoints/sidepanel/TemplateSection.js";
import type { ScanResult } from "../../utils/docx/scan.js";

function makeScan(hasContentPlaceholder: boolean): ScanResult {
  return {
    supported: [],
    unsupported: [],
    never: [],
    parts: ["word/document.xml"],
    hasContentPlaceholder,
  };
}

describe("ScanView — content insertion point (spec 004 finding)", () => {
  it("shows the content insertion point as found when hasContentPlaceholder is true", () => {
    const html = renderToStaticMarkup(<ScanView scan={makeScan(true)} />);
    expect(html).toContain("content-insertion-point");
    expect(html).toContain("Content insertion point");
    expect(html).toContain("$scroll.content");
    // Found copy, not the appended-body fallback.
    expect(html).not.toContain("appended before the final");
  });

  it("notes the appended-body fallback when hasContentPlaceholder is false", () => {
    const html = renderToStaticMarkup(<ScanView scan={makeScan(false)} />);
    expect(html).toContain("content-insertion-point");
    expect(html).toContain("$scroll.content");
    expect(html).toContain("appended before the final section break");
  });
});
