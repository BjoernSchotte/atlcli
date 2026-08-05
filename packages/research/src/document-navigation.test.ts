import { describe, expect, test } from "bun:test";
import {
  navigateConfluenceDocumentV1,
  navigateConfluenceStorageV1,
} from "./document-navigation.js";

const ORIGIN = "https://tenant-a.atlassian.net";
const LIMITS = {
  maxTextChars: 2_000,
  maxTextBytes: 8_000,
  maxLinks: 20,
  maxNodes: 20_000,
  maxDepth: 64,
};

describe("bounded Confluence document navigation", () => {
  test("normalizes Storage through the representation-neutral document port", () => {
    const document = navigateConfluenceDocumentV1({
      representation: "storage",
      value: "<h1>Decision</h1><p>Approved synthetic evidence.</p>",
      sourceVersion: 3,
      siteOrigin: ORIGIN,
      projectionLimits: LIMITS,
    });
    expect(document?.snapshot).toEqual({ representation: "storage", sourceVersion: 3 });
    expect(document?.sections[0]?.content.text).toContain("Approved synthetic evidence");
  });
  test("builds an ordered body-free outline with macro and link metadata", () => {
    const document = navigateConfluenceStorageV1({
      storage: [
        "<p>Opening context.</p>",
        "<h2>Delivery status</h2>",
        `<p>Tracked by <a href="${ORIGIN}/browse/DEMO-42">DEMO-42</a>.</p>`,
        '<ac:structured-macro ac:name="jira"><ac:parameter ac:name="key">DEMO-42</ac:parameter></ac:structured-macro>',
        "<h2>Next steps</h2><p>Continue with the verified plan.</p>",
      ].join(""),
      sourceVersion: 7,
      siteOrigin: ORIGIN,
      projectionLimits: LIMITS,
    })!;

    expect(document).toMatchObject({
      sourceTruncated: false,
      outlineTruncated: false,
      genuinelyEmpty: false,
      totalSections: 3,
    });
    expect(document.sections.map(({ heading, level, order }) => ({ heading, level, order })))
      .toEqual([
        { heading: "Introduction", level: 0, order: 0 },
        { heading: "Delivery status", level: 2, order: 1 },
        { heading: "Next steps", level: 2, order: 2 },
      ]);
    const delivery = document.sections[1]!;
    expect(delivery.metadata.jiraIssueKeys).toEqual(["DEMO-42"]);
    expect(delivery.metadata.linkCount).toBe(1);
    expect(delivery.metadata.macroNames).toContain("jira");
    expect(delivery).toHaveProperty("content.text");
  });

  test("distinguishes genuinely empty content from a bounded source overflow", () => {
    const empty = navigateConfluenceStorageV1({
      storage: "",
      sourceVersion: 7,
      siteOrigin: ORIGIN,
      projectionLimits: LIMITS,
    })!;
    expect(empty).toMatchObject({
      sourceTruncated: false,
      outlineTruncated: false,
      genuinelyEmpty: true,
      totalSections: 0,
    });

    const overflow = navigateConfluenceStorageV1({
      storage: `<p>${"x".repeat(4_000_100)}</p>`,
      sourceVersion: 7,
      siteOrigin: ORIGIN,
      projectionLimits: LIMITS,
    })!;
    expect(overflow).toMatchObject({
      sourceTruncated: true,
      outlineTruncated: true,
      genuinelyEmpty: false,
      coverageIssues: ["source_limit", "outline_limit"],
      totalSections: 0,
    });
  });

  test("reports parser-budget exhaustion as partial rather than empty content", () => {
    const nested = `${"<div>".repeat(70)}Visible but over-nested evidence.${"</div>".repeat(70)}`;
    const document = navigateConfluenceStorageV1({
      storage: nested,
      sourceVersion: 5,
      siteOrigin: ORIGIN,
      projectionLimits: LIMITS,
    });
    expect(document).toMatchObject({
      sourceTruncated: false,
      outlineTruncated: true,
      genuinelyEmpty: false,
      coverageIssues: ["parse_budget"],
      totalSections: 0,
      sections: [],
    });
  });

  test("marks outline overflow instead of silently claiming full coverage", () => {
    const storage = Array.from(
      { length: 140 },
      (_, index) => `<h2>Section ${index + 1}</h2><p>Evidence ${index + 1}</p>`,
    ).join("");
    const document = navigateConfluenceStorageV1({
      storage,
      sourceVersion: 7,
      siteOrigin: ORIGIN,
      projectionLimits: LIMITS,
    })!;
    expect(document.totalSections).toBe(140);
    expect(document.sections).toHaveLength(128);
    expect(document.outlineTruncated).toBe(true);
    expect(document.genuinelyEmpty).toBe(false);
  });

  test("preserves structured Storage evidence and marks unresolved includes", () => {
    const document = navigateConfluenceStorageV1({
      storage: [
        "<h2>Structured decision</h2>",
        "<table><tbody><tr><th>Owner</th><th>Status</th></tr><tr><td>Ada</td><td>Approved</td></tr></tbody></table>",
        '<ac:structured-macro ac:name="expand" ac:macro-id="expand-1">',
        '<ac:parameter ac:name="title">Details</ac:parameter>',
        "<ac:rich-text-body><p>Expanded evidence is visible.</p></ac:rich-text-body>",
        "</ac:structured-macro>",
        '<ac:structured-macro ac:name="jira" ac:macro-id="jira-1">',
        '<ac:parameter ac:name="key">DEMO-42</ac:parameter>',
        "</ac:structured-macro>",
        `<p><a href="${ORIGIN}/wiki/spaces/DEMO/pages/1002" data-card-appearance="inline">Related decision</a></p>`,
        '<ac:structured-macro ac:name="excerpt" ac:macro-id="excerpt-1">',
        "<ac:rich-text-body><p>Reusable excerpt evidence.</p></ac:rich-text-body>",
        "</ac:structured-macro>",
        '<ac:structured-macro ac:name="include" ac:macro-id="include-1">',
        '<ac:parameter ac:name="page"><ri:page ri:content-id="1003" ri:content-title="Included source" ri:space-key="DEMO"/></ac:parameter>',
        "</ac:structured-macro>",
      ].join(""),
      sourceVersion: 11,
      siteOrigin: ORIGIN,
      projectionLimits: LIMITS,
    })!;

    expect(document.snapshot).toEqual({ representation: "storage", sourceVersion: 11 });
    expect(document.coverageIssues).toEqual(["unresolved_include"]);
    const section = document.sections[0]!;
    expect(section.metadata.structures).toEqual({
      tables: 1,
      expands: 1,
      jiraMacros: 1,
      smartLinks: 1,
      excerpts: 1,
      includes: 1,
      unresolvedIncludes: 1,
      unsupportedMacros: 0,
    });
    expect(section.metadata.jiraIssueKeys).toEqual(["DEMO-42"]);
    expect(section.content.text).toContain("Owner");
    expect(section.content.text).toContain("Expanded evidence is visible.");
    expect(section.content.text).toContain("Jira macro issue key: DEMO-42");
    expect(section.content.text).toContain("Related decision");
    expect(section.content.text).toContain("Reusable excerpt evidence.");
    expect(section.content.text).not.toContain("Included source");
  });
});
