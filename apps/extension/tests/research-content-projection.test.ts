import { describe, expect, it } from "bun:test";
import {
  projectConfluenceStorage,
  projectJiraDescription,
  type ContentProjectionLimits,
} from "../utils/research/content-projection.js";

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
});
