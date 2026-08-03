import { describe, expect, it } from "bun:test";
import {
  appendBoundedDetailLinks,
  projectConfluenceStorage,
  projectJiraDescription,
  prependBoundedDetailText,
  type ContentProjectionLimits,
} from "@atlcli/research";

const limits: ContentProjectionLimits = {
  maxTextChars: 1_000,
  maxTextBytes: 4_000,
  maxLinks: 10,
  maxNodes: 100,
  maxDepth: 20,
};

describe("bounded research content projection", () => {
  it("retains Jira ADF text and only canonical same-site links", () => {
    const result = projectJiraDescription(
      {
        type: "doc",
        version: 1,
        content: [
          {
            type: "paragraph",
            content: [
              {
                type: "text",
                text: "Implementation page",
                marks: [
                  {
                    type: "link",
                    attrs: {
                      href:
                        "https://example.atlassian.net/wiki/spaces/KB/pages/1001",
                    },
                  },
                ],
              },
              {
                type: "text",
                text: " foreign",
                marks: [
                  {
                    type: "link",
                    attrs: {
                      href:
                        "https://foreign.atlassian.net/wiki/spaces/KB/pages/9009",
                    },
                  },
                ],
              },
            ],
          },
        ],
      },
      "https://example.atlassian.net",
      limits
    );

    expect(result.text).toBe("Implementation page foreign");
    expect(result.linkTargets).toEqual([
      "https://example.atlassian.net/wiki/spaces/KB/pages/1001",
    ]);
    expect(result.truncated).toBe(false);
  });

  it("projects Confluence storage without a DOM and retains scoped Jira links", () => {
    const result = projectConfluenceStorage(
      '<h2>Delivery</h2><p>See <a href="/browse/DEMO-1">the issue</a>.</p>',
      "https://example.atlassian.net",
      limits
    );

    expect(result.text).toContain("Delivery");
    expect(result.text).toContain("See the issue.");
    expect(result.linkTargets).toEqual([
      "https://example.atlassian.net/browse/DEMO-1",
    ]);
  });

  it("truncates on UTF-8 boundaries and marks the projection incomplete", () => {
    const result = projectJiraDescription(
      "äöü",
      "https://example.atlassian.net",
      { ...limits, maxTextBytes: 5 }
    );

    expect(result.text).toBe("äö");
    expect(new TextEncoder().encode(result.text).byteLength).toBe(4);
    expect(result.truncated).toBe(true);
  });

  it("turns detail-fetched Jira fields into bounded evidence without losing links", () => {
    const description = projectJiraDescription(
      {
        type: "doc",
        version: 1,
        content: [{
          type: "paragraph",
          content: [{
            type: "text",
            text: "Design",
            marks: [{
              type: "link",
              attrs: {
                href: "https://example.atlassian.net/wiki/spaces/KB/pages/1001",
              },
            }],
          }],
        }],
      },
      "https://example.atlassian.net",
      limits,
    );
    const detail = prependBoundedDetailText(
      description,
      "Summary: Implement design\nStatus: In Progress",
      limits,
    );

    expect(detail.text).toContain("Summary: Implement design");
    expect(detail.text).toContain("Status: In Progress");
    expect(detail.text).toContain("Design");
    expect(detail.linkTargets).toEqual(description.linkTargets);
    expect(detail.truncated).toBe(false);
  });

  it("adds only bounded same-tenant relation targets after a detail read", () => {
    const detail = appendBoundedDetailLinks(
      {
        text: "Detail body",
        linkTargets: ["https://example.atlassian.net/browse/DEMO-1"],
        truncated: false,
        inputBytes: 11,
      },
      [
        "https://example.atlassian.net/browse/OPS_TEAM-2",
        "https://example.atlassian.net/wiki/spaces/KB/pages/1001",
        "https://foreign.atlassian.net/browse/OTHER-9",
      ],
      "https://example.atlassian.net",
      { ...limits, maxLinks: 2 },
    );

    expect(detail.linkTargets).toEqual([
      "https://example.atlassian.net/browse/DEMO-1",
      "https://example.atlassian.net/browse/OPS_TEAM-2",
    ]);
    expect(detail.truncated).toBe(true);
  });

  it("keeps an adapter-declared relation cap visible even when link capacity remains", () => {
    const detail = appendBoundedDetailLinks(
      { text: "Detail body", linkTargets: [], truncated: false, inputBytes: 11 },
      ["https://example.atlassian.net/browse/DEMO-1"],
      "https://example.atlassian.net",
      limits,
      true,
    );
    expect(detail.linkTargets).toEqual(["https://example.atlassian.net/browse/DEMO-1"]);
    expect(detail.truncated).toBe(true);
  });

  it("degrades an oversized Confluence page to bounded text instead of losing the detail", () => {
    const result = projectConfluenceStorage(
      `<p>See <a href="/browse/DEMO-1">DEMO-1</a>.</p><p>${"bounded content ".repeat(
        200
      )}</p>`,
      "https://example.atlassian.net",
      { ...limits, maxTextChars: 80, maxTextBytes: 320 }
    );

    expect(result.text).toContain("See DEMO-1.");
    expect(result.linkTargets).toEqual([
      "https://example.atlassian.net/browse/DEMO-1",
    ]);
    expect(result.text.length).toBeLessThanOrEqual(80);
    expect(result.truncated).toBe(true);
  });
});
