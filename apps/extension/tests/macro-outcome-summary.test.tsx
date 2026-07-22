import { describe, expect, it } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  MacroOutcomeSummary,
  summarizeMacroOutcomes,
} from "../components/export/MacroOutcomeSummary.js";

describe("macro outcome summary", () => {
  it("classifies only the three stable terminal outcome codes", () => {
    expect(
      summarizeMacroOutcomes([
        { code: "macro-rendered-via" },
        { code: "macro-rendered-via" },
        { code: "macro-degraded" },
        { code: "macro-skipped-by-config" },
        { code: "macro-body-truncated" },
        { code: "image-skipped" },
      ])
    ).toEqual({ renderedVia: 2, degraded: 1, skippedByConfig: 1 });
  });

  it("renders compact non-zero outcomes and omits empty buckets", () => {
    const html = renderToStaticMarkup(
      <MacroOutcomeSummary
        notes={[
          { code: "macro-rendered-via" },
          { code: "macro-rendered-via" },
          { code: "macro-skipped-by-config" },
        ]}
      />
    );

    expect(html).toContain("macro-outcome-summary");
    expect(html).toContain("Live rendered: 2");
    expect(html).toContain("Skipped by setting: 1");
    expect(html).not.toContain("macro-outcome-degraded");
  });

  it("renders nothing when a report has no terminal macro outcomes", () => {
    const html = renderToStaticMarkup(
      <MacroOutcomeSummary notes={[{ code: "macro-body-truncated" }]} />
    );
    expect(html).toBe("");
  });
});
