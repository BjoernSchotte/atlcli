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
import type { ScanResult } from "@atlcli/docx/scan";

function makeScan(hasContentPlaceholder: boolean): ScanResult {
  return {
    supported: [],
    unsupported: [],
    never: [],
    parts: ["word/document.xml"],
    hasContentPlaceholder,
    stylerefStyleNames: [],
    riskyFieldInstructions: [],
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

describe("ScanView — per-placeholder reasons (E2E finding)", () => {
  // The panel used to print one static "will be empty" per row and drop the
  // per-hit `reason` the scan already carries. That flattened causes which are
  // in fact unrelated: a Cloud-impossible DC username vs. an unfetched content
  // property. Each row must state its OWN reason.
  const scan: ScanResult = {
    supported: [{ base: "$scroll.title", status: "supported", count: 2, raw: ["$scroll.title"] }],
    unsupported: [
      {
        base: "$scroll.creator.name",
        status: "unsupported",
        count: 1,
        raw: ["$scroll.creator.name"],
        reason: "Confluence Cloud has no usernames — Data Center only (Gap G2)",
      },
      {
        base: "$scroll.jsoncontentproperty",
        status: "unsupported",
        count: 1,
        raw: ["$scroll.jsoncontentproperty.(key)"],
        reason: "content properties are not fetched (Gap G5)",
      },
    ],
    never: [
      {
        base: "$adhocState",
        status: "never",
        count: 1,
        raw: ["$adhocState"],
        reason: "needs the Comala Workflows app — third-party",
      },
    ],
    parts: ["word/document.xml"],
    hasContentPlaceholder: true,
    stylerefStyleNames: [],
    riskyFieldInstructions: [],
  };

  it("renders each unsupported row's own reason, not one shared note", () => {
    const html = renderToStaticMarkup(<ScanView scan={scan} />);
    expect(html).toContain("Data Center only");
    expect(html).toContain("content properties are not fetched");
    // The two causes are distinct — the old static note made them identical.
    expect(html).not.toContain("— will be empty");
  });

  it("renders a reason for never rows too (previously none at all)", () => {
    const html = renderToStaticMarkup(<ScanView scan={scan} />);
    expect(html).toContain("Comala Workflows");
  });

  it("keeps the outcome in the group header and leaves supported rows bare", () => {
    const html = renderToStaticMarkup(<ScanView scan={scan} />);
    expect(html).toContain("Will be empty (2)");
    expect(html).toContain("Not supported (1)");
    // A supported hit carries no reason, so it renders no trailing dash.
    expect(html).toContain("$scroll.title");
  });
});
