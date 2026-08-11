import { describe, expect, it } from "bun:test";
import {
  projectLocalGemmaFinalToolResultV1,
  projectLocalGemmaToolResultV1,
} from
  "../utils/local-model/tool-result.js";

describe("local Gemma evidence projection", () => {
  it("removes repeated outline metadata but retains the relevant section handles", () => {
    const content = JSON.stringify({
      schema: "atlcli.ptc/atlassian.bound.read.output/v1",
      source: { id: "wiki:page-1", title: "Synthetic page" },
      content: { text: "Opening projection", linkTargets: [], truncated: true },
      relatedAnchors: [],
      document: {
        snapshot: { sourceId: "wiki:page-1", captureRef: "capture:1" },
        coverageIssues: ["projection_limit"],
        sourceTruncated: false,
        outlineTruncated: false,
        projectionTruncated: true,
        genuinelyEmpty: false,
        totalSections: 80,
        unreadSections: 80,
        sections: Array.from({ length: 80 }, (_, index) => ({
          sectionRef: `research-section:${index}`,
          sectionId: `section-${index}`,
          heading: `Heading ${index}`,
          level: 1,
          order: index,
          contentBytes: 400,
          metadata: {
            macroNames: Array.from({ length: 20 }, () => "large-macro-name"),
            structures: { tables: 0, expands: 0, unsupportedMacros: 0 },
          },
        })),
      },
      budget: { calls: Array.from({ length: 100 }, () => "bookkeeping") },
    });

    const projected = projectLocalGemmaToolResultV1(content, "Heading 79");
    const parsed = JSON.parse(projected) as Record<string, unknown>;
    expect(projected.length).toBeLessThan(content.length / 3);
    expect(projected).not.toContain("metadata");
    expect(projected).not.toContain("bookkeeping");
    expect(projected).toContain("research-section:79");
    expect(projected).toContain("Heading 79");
    expect(projected).not.toContain("Heading 40");
    expect(parsed).not.toHaveProperty("budget");
  });

  it("compacts nested stringified evidence returned by an interpreter wrapper", () => {
    const nested = JSON.stringify({
      result: JSON.stringify({
        schema: "atlcli.ptc/atlassian.bound.read.output/v1",
        source: { id: "wiki:nested" },
        content: { text: "Nested evidence", linkTargets: [], truncated: false },
        relatedAnchors: [],
        document: {
          sections: Array.from({ length: 30 }, (_, index) => ({
            sectionRef: `research-section:nested-${index}`,
            sectionId: `nested-${index}`,
            heading: `Nested heading ${index}`,
            order: index,
            metadata: { repeated: "x".repeat(500) },
          })),
        },
        budget: { repeated: "x".repeat(5_000) },
      }),
    });
    const projected = projectLocalGemmaToolResultV1(nested, "Nested heading 29");

    expect(projected).toContain("research-section:nested-29");
    expect(projected).not.toContain("metadata");
    expect(projected).not.toContain("budget");
    expect(projected.length).toBeLessThan(4_000);
  });

  it("keeps section evidence and marks locally clipped text as truncated", () => {
    const projected = projectLocalGemmaToolResultV1(JSON.stringify({
      schema: "atlcli.ptc/atlassian.bound.section.read.output/v1",
      source: { id: "wiki:page-1" },
      section: { sectionId: "decision", heading: "Decision" },
      content: {
        text: "x".repeat(9_000),
        linkTargets: Array.from({ length: 30 }, (_, index) => `link-${index}`),
        truncated: false,
      },
      support: { sectionId: "decision", start: 0, end: 9_000 },
      coverage: { completeDocumentRead: false },
      relatedAnchors: [],
      budget: { calls: 1 },
    }));
    const parsed = JSON.parse(projected) as {
      content: { text: string; linkTargets: string[]; truncated: boolean };
    };

    expect(parsed.content.text).toHaveLength(1_800);
    expect(parsed.content.linkTargets).toHaveLength(8);
    expect(parsed.content.truncated).toBe(true);
    expect(projected).not.toContain("budget");
  });

  it("leaves non-JSON interpreter errors unchanged", () => {
    expect(projectLocalGemmaToolResultV1("TypeError: unavailable")).toBe(
      "TypeError: unavailable",
    );
  });

  it("uses a smaller evidence projection after the terminal tool is selected", () => {
    const content = JSON.stringify({
      schema: "atlcli.ptc/atlassian.bound.read.output/v1",
      source: { id: "wiki:page-1", title: "Budget indication" },
      content: {
        text: `Budget 2026: 60,000-85,000 EUR. From 2027: 30,000 EUR. ${"x".repeat(4_000)}`,
        linkTargets: Array.from({ length: 20 }, (_, index) => `link-${index}`),
      },
      relatedAnchors: Array.from({ length: 20 }, (_, index) => ({
        anchorRef: `anchor-${index}`,
        name: `Related ${index}`,
      })),
      document: {
        totalSections: 40,
        unreadSections: 0,
        sections: Array.from({ length: 40 }, (_, index) => ({
          sectionRef: `section-ref-${index}`,
          sectionId: `section-${index}`,
          heading: index === 39 ? "Budget 2026 and 2027" : `Heading ${index}`,
          order: index,
          contentBytes: 500,
        })),
      },
    });

    const projected = projectLocalGemmaFinalToolResultV1(content, "Budget 2026 2027");
    expect(projected).toContain("60,000-85,000 EUR");
    expect(projected).toContain("30,000 EUR");
    expect(projected).not.toContain("section-ref-39");
    expect(projected).not.toContain("anchor-0");
    expect(projected).not.toContain("link-1");
    expect(projected).toContain("wiki:page-1");
    expect(projected.length).toBeLessThan(1_200);
  });
});
