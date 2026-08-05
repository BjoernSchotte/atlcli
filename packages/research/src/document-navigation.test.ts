import { describe, expect, test } from "bun:test";
import { navigateConfluenceStorageV1 } from "./document-navigation.js";

const ORIGIN = "https://tenant-a.atlassian.net";
const LIMITS = {
  maxTextChars: 2_000,
  maxTextBytes: 8_000,
  maxLinks: 20,
  maxNodes: 20_000,
  maxDepth: 64,
};

describe("bounded Confluence document navigation", () => {
  test("builds an ordered body-free outline with macro and link metadata", () => {
    const document = navigateConfluenceStorageV1({
      storage: [
        "<p>Opening context.</p>",
        "<h2>Delivery status</h2>",
        `<p>Tracked by <a href="${ORIGIN}/browse/DEMO-42">DEMO-42</a>.</p>`,
        '<ac:structured-macro ac:name="jira"><ac:parameter ac:name="key">DEMO-42</ac:parameter></ac:structured-macro>',
        "<h2>Next steps</h2><p>Continue with the verified plan.</p>",
      ].join(""),
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
      siteOrigin: ORIGIN,
      projectionLimits: LIMITS,
    })!;
    expect(overflow).toMatchObject({
      sourceTruncated: true,
      outlineTruncated: true,
      genuinelyEmpty: false,
      totalSections: 0,
    });
  });

  test("marks outline overflow instead of silently claiming full coverage", () => {
    const storage = Array.from(
      { length: 140 },
      (_, index) => `<h2>Section ${index + 1}</h2><p>Evidence ${index + 1}</p>`,
    ).join("");
    const document = navigateConfluenceStorageV1({
      storage,
      siteOrigin: ORIGIN,
      projectionLimits: LIMITS,
    })!;
    expect(document.totalSections).toBe(140);
    expect(document.sections).toHaveLength(128);
    expect(document.outlineTruncated).toBe(true);
    expect(document.genuinelyEmpty).toBe(false);
  });
});
