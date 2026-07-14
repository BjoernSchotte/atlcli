import { describe, expect, test } from "bun:test";
import {
  extractEntityFromUrl,
  DEFAULT_PATTERN_REGISTRY,
  type AtlassianEntity,
  type PatternRegistry,
} from "./entity-url.js";

/**
 * Fixture table (spec 001 task 7 AC): ≥1 positive and ≥1 negative per registry
 * row, plus Cloud/DC context-path variants and query-param forms.
 */
type Fixture = {
  /** Registry row / pattern id this fixture exercises. */
  row: string;
  url: string;
  expected: AtlassianEntity | null;
};

const fixtures: Fixture[] = [
  // --- Confluence page (Cloud) ---
  {
    row: "confluence-page-cloud",
    url: "https://acme.atlassian.net/wiki/spaces/DOCSY/pages/123456/My+Page",
    expected: { product: "confluence", type: "page", pageId: "123456", spaceKey: "DOCSY" },
  },
  {
    row: "confluence-page-cloud (no slug)",
    url: "https://acme.atlassian.net/wiki/spaces/~712020abc/pages/999",
    expected: { product: "confluence", type: "page", pageId: "999", spaceKey: "~712020abc" },
  },
  {
    row: "confluence-page-cloud (negative: no pageId)",
    url: "https://acme.atlassian.net/wiki/spaces/DOCSY/pages/",
    expected: null,
  },

  // --- Confluence page (legacy: ?pageId=) ---
  {
    row: "confluence-page-pageid-query (legacy cloud)",
    url: "https://acme.atlassian.net/wiki/pages/viewpage.action?pageId=555",
    expected: { product: "confluence", type: "page", pageId: "555" },
  },
  {
    row: "confluence-page-pageid-query (negative)",
    url: "https://acme.atlassian.net/wiki/pages/viewpage.action?spaceKey=DOCSY",
    expected: null,
  },

  // --- Confluence page (DC display, with context path) ---
  {
    row: "confluence-page-display (DC context path)",
    url: "https://wiki.acme.com/confluence/display/DOCSY/Welcome+Home",
    expected: { product: "confluence", type: "space", spaceKey: "DOCSY" },
  },
  {
    row: "confluence-page-display (legacy /wiki/display)",
    url: "https://acme.atlassian.net/wiki/display/ENG/Runbook",
    expected: { product: "confluence", type: "space", spaceKey: "ENG" },
  },
  // --- Confluence page (DC viewpage.action with context path) ---
  {
    row: "confluence-page-pageid-query (DC viewpage.action, context path)",
    url: "https://wiki.acme.com/confluence/pages/viewpage.action?pageId=42",
    expected: { product: "confluence", type: "page", pageId: "42" },
  },

  // --- Confluence blogpost ---
  {
    row: "confluence-blogpost-cloud",
    url: "https://acme.atlassian.net/wiki/spaces/NEWS/blog/2026/07/14/7788/Launch",
    expected: { product: "confluence", type: "blogpost", contentId: "7788", spaceKey: "NEWS" },
  },
  {
    row: "confluence-blogpost-cloud (negative: not a blog date path)",
    url: "https://acme.atlassian.net/wiki/spaces/NEWS/blog",
    expected: null,
  },

  // --- Confluence space overview ---
  {
    row: "confluence-space-overview",
    url: "https://acme.atlassian.net/wiki/spaces/DOCSY",
    expected: { product: "confluence", type: "space", spaceKey: "DOCSY" },
  },
  {
    row: "confluence-space-overview (/overview suffix)",
    url: "https://acme.atlassian.net/wiki/spaces/DOCSY/overview",
    expected: { product: "confluence", type: "space", spaceKey: "DOCSY" },
  },

  // --- Collision pins (spec 001 review) ---
  // A stray ?pageId= on a Jira URL must never win over the Jira entity.
  {
    row: "collision: /browse/ with stray ?pageId= stays a Jira issue",
    url: "https://acme.atlassian.net/browse/ABC-1?pageId=999",
    expected: { product: "jira", type: "issue", issueKey: "ABC-1", projectKey: "ABC" },
  },
  {
    row: "collision: board URL with stray ?pageId= stays a Jira board",
    url: "https://acme.atlassian.net/jira/software/projects/PX/boards/9?pageId=42",
    expected: { product: "jira", type: "board", projectKey: "PX", boardId: "9" },
  },
  // Ordering pin: a Cloud page whose slug contains a "display" segment must
  // extract as the cloud page, not fall through to the display/space pattern.
  {
    row: "ordering pin: cloud page with 'display' in the slug stays a page",
    url: "https://acme.atlassian.net/wiki/spaces/DOC/pages/123/How+to/display/Content",
    expected: { product: "confluence", type: "page", pageId: "123", spaceKey: "DOC" },
  },

  // --- Jira issue (/browse/) ---
  {
    row: "jira-issue-browse",
    url: "https://acme.atlassian.net/browse/ATLCLI-1234",
    expected: { product: "jira", type: "issue", issueKey: "ATLCLI-1234", projectKey: "ATLCLI" },
  },
  {
    row: "jira-issue-browse (DC context path)",
    url: "https://jira.acme.com/jira/browse/OPS-7",
    expected: { product: "jira", type: "issue", issueKey: "OPS-7", projectKey: "OPS" },
  },
  {
    row: "jira-issue-browse (negative: lowercase key)",
    url: "https://acme.atlassian.net/browse/atlcli-1",
    expected: null,
  },

  // --- Jira issue (?selectedIssue=) ---
  {
    row: "jira-issue-selected",
    url: "https://acme.atlassian.net/jira/software/projects/PX/boards/9?selectedIssue=PX-42",
    // board pattern is more specific and comes first -> board wins for board URLs
    expected: { product: "jira", type: "board", projectKey: "PX", boardId: "9" },
  },
  {
    row: "jira-issue-selected (non-board page)",
    url: "https://acme.atlassian.net/issues/?jql=x&selectedIssue=PX-42",
    expected: { product: "jira", type: "issue", issueKey: "PX-42", projectKey: "PX" },
  },
  {
    row: "jira-issue-selected (negative)",
    url: "https://acme.atlassian.net/issues/?jql=project=PX",
    expected: null,
  },

  // --- Jira board/backlog ---
  {
    row: "jira-board",
    url: "https://acme.atlassian.net/jira/software/projects/PX/boards/9",
    expected: { product: "jira", type: "board", projectKey: "PX", boardId: "9" },
  },
  {
    row: "jira-board (next-gen /c/ variant)",
    url: "https://acme.atlassian.net/jira/software/c/projects/TEAM/boards/3/backlog",
    expected: { product: "jira", type: "board", projectKey: "TEAM", boardId: "3" },
  },
  {
    row: "jira-board (negative: no boardId)",
    url: "https://acme.atlassian.net/jira/software/projects/PX/boards",
    expected: null,
  },

  // --- Non-entity / marketing URLs on atlassian.net ---
  {
    row: "non-entity marketing (root)",
    url: "https://www.atlassian.com/software/confluence",
    expected: null,
  },
  {
    row: "non-entity (bare host)",
    url: "https://acme.atlassian.net/",
    expected: null,
  },
  {
    row: "non-entity (wiki root only)",
    url: "https://acme.atlassian.net/wiki/",
    expected: null,
  },
];

describe("extractEntityFromUrl fixture table", () => {
  for (const { row, url, expected } of fixtures) {
    test(`${row}: ${url}`, () => {
      expect(extractEntityFromUrl(url)).toEqual(expected);
    });
  }
});

describe("extractEntityFromUrl malformed input", () => {
  for (const bad of ["", "not a url", "://nope", "   ", "javascript:alert(1)", "/browse/ABC-1"]) {
    test(`returns null and never throws for ${JSON.stringify(bad)}`, () => {
      expect(() => extractEntityFromUrl(bad)).not.toThrow();
      expect(extractEntityFromUrl(bad)).toBeNull();
    });
  }
});

describe("registry versioning + injection", () => {
  test("default registry is version 1", () => {
    expect(DEFAULT_PATTERN_REGISTRY.version).toBe(1);
  });

  test("an injected registry changes extraction", () => {
    const custom: PatternRegistry = {
      version: 99,
      patterns: [
        {
          id: "custom-page",
          product: "confluence",
          type: "page",
          regex: /\/x\/(?<pageId>\d+)/,
          fields: { pageId: "pageId" },
        },
      ],
    };

    // Default registry does not know the custom form.
    expect(extractEntityFromUrl("https://acme.atlassian.net/x/321")).toBeNull();
    // Injected registry extracts it.
    expect(extractEntityFromUrl("https://acme.atlassian.net/x/321", custom)).toEqual({
      product: "confluence",
      type: "page",
      pageId: "321",
    });
    // Injected registry no longer recognizes the built-in Cloud form.
    expect(
      extractEntityFromUrl("https://acme.atlassian.net/wiki/spaces/D/pages/1", custom)
    ).toBeNull();
  });
});
