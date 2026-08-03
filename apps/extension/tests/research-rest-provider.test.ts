import { afterEach, describe, expect, it, mock } from "bun:test";
import type { Profile } from "@atlcli/core";
import {
  DEFAULT_RESEARCH_LIMITS_V1,
  RESEARCH_REQUEST_SCHEMA_V1,
  normalizeResearchRequestV1,
} from "../utils/research/contracts.js";
import { ResearchRunBudget } from "@atlcli/research";
import { createRestResearchProviders } from "@atlcli/research/browser";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const request = normalizeResearchRequestV1({
  schema: RESEARCH_REQUEST_SCHEMA_V1,
  question: "Read the bounded project and space.",
  scope: {
    siteOrigin: "https://example.atlassian.net",
    jiraProjectKeys: ["DEMO"],
    confluenceSpaceKeys: ["KB"],
  },
  limits: DEFAULT_RESEARCH_LIMITS_V1,
  wikiProvider: "rest",
});

describe("REST research provider authentication boundary", () => {
  const profile: Profile = {
    name: "test-profile",
    baseUrl: request.scope.siteOrigin,
    deploymentType: "cloud",
    auth: { type: "apiToken", email: "test@example.invalid", token: "test" },
  };

  it("rejects profile credentials in the browser-default path", () => {
    expect(() =>
      createRestResearchProviders(
        profile,
        request,
        new ResearchRunBudget(request.limits)
      )
    ).toThrow("active Atlassian session");
  });

  it("allows the explicit Node live-test path without broadening scope", () => {
    expect(() =>
      createRestResearchProviders(
        profile,
        request,
        new ResearchRunBudget(request.limits),
        { allowProfileAuth: true }
      )
    ).not.toThrow();
  });

  it("projects bounded labels and same-tenant Jira/Confluence relations from one detail read", async () => {
    const calls: string[] = [];
    globalThis.fetch = mock((input: string | URL | Request) => {
      const url = String(input);
      calls.push(url);
      if (url.includes("/rest/api/3/issue/DEMO-1")) {
        return Promise.resolve(new Response(JSON.stringify({
          id: "1",
          key: "DEMO-1",
          self: "https://example.atlassian.net/rest/api/3/issue/1",
          fields: {
            summary: "Bounded issue",
            description: { type: "doc", version: 1, content: [] },
            project: { id: "1", key: "DEMO" },
            status: { id: "1", name: "In Progress" },
            labels: ["release", "agentic-ai"],
            parent: { id: "9", key: "DEMO-9" },
            subtasks: [{ id: "2", key: "DEMO-2" }],
            issuelinks: [{
              id: "3",
              type: { id: "1", name: "Blocks", inward: "is blocked by", outward: "blocks" },
              outwardIssue: { id: "3", key: "DEMO-3" },
            }],
            comment: {
              total: 2,
              comments: [
                {
                  id: "comment-1",
                  author: { accountId: "account-1", displayName: "Synthetic" },
                  created: "2026-08-01T12:00:00.000Z",
                  updated: "2026-08-01T12:00:00.000Z",
                  body: {
                    type: "doc",
                    version: 1,
                    content: [{
                      type: "paragraph",
                      content: [{
                        type: "text",
                        text: "Comment links the knowledge page.",
                        marks: [{
                          type: "link",
                          attrs: { href: "/wiki/spaces/KB/pages/1001" },
                        }],
                      }],
                    }],
                  },
                },
              ],
            },
          },
        }), { status: 200, headers: { "content-type": "application/json" } }));
      }
      if (url.includes("/api/v2/pages/1001/inline-comments")) {
        return Promise.resolve(new Response(JSON.stringify({
          results: [{
            id: "inline-comment-1",
            version: { authorId: "account-1", createdAt: "2026-08-01T12:00:00.000Z" },
            body: {
              storage: {
                value: "<p>Inline comment links the <a href=\"/wiki/spaces/KB/pages/1002\">related page</a>.</p>",
              },
            },
            resolutionStatus: "open",
          }],
          _links: {},
        }), { status: 200, headers: { "content-type": "application/json" } }));
      }
      if (url.includes("/api/v2/inline-comments/inline-comment-1/children")) {
        return Promise.resolve(new Response(JSON.stringify({
          results: [],
          _links: {},
        }), { status: 200, headers: { "content-type": "application/json" } }));
      }
      if (url.includes("/wiki/rest/api/content/1001")) {
        return Promise.resolve(new Response(JSON.stringify({
          id: "1001",
          title: "Bounded page",
          body: { storage: { value: "<p>Page body.</p>" } },
          version: { number: 1 },
          space: { key: "KB" },
          ancestors: [{ id: "1000", title: "Parent" }],
          metadata: { labels: { results: [{ name: "release" }] } },
        }), { status: 200, headers: { "content-type": "application/json" } }));
      }
      return Promise.resolve(new Response("Not found", { status: 404 }));
    }) as unknown as typeof fetch;
    const sessionProfile: Profile = {
      ...profile,
      auth: { type: "session" },
    };
    const providers = createRestResearchProviders(
      sessionProfile,
      request,
      new ResearchRunBudget(request.limits),
    );
    const signal = new AbortController().signal;

    const issue = await providers.jira.getIssue({ issueKey: "DEMO-1", signal });
    const page = await providers.wiki.getPage({ contentId: "1001", includeComments: true, signal });

    expect(issue.content.text).toContain("Labels: agentic-ai, release");
    expect(issue.content.text).toContain("Related issue keys: DEMO-2, DEMO-3, DEMO-9");
    expect(issue.content.text).toContain("Comments: 1 of 2 captured");
    expect(issue.content.text).toContain("Comment 1:");
    expect(issue.content.text).toContain("Comment links the knowledge page.");
    expect(issue.content.truncated).toBe(true);
    expect(issue.content.linkTargets).toEqual([
      "https://example.atlassian.net/browse/DEMO-2",
      "https://example.atlassian.net/browse/DEMO-3",
      "https://example.atlassian.net/browse/DEMO-9",
      "https://example.atlassian.net/wiki/spaces/KB/pages/1001",
    ]);
    expect(page.content.text).toContain("Labels: release");
    expect(page.content.text).toContain("Ancestor page IDs: 1000");
    expect(page.content.text).toContain("Inline comments: 1 captured");
    expect(page.content.text).toContain("Inline comment 1 (open):");
    expect(page.content.text).toContain("Inline comment links the related page.");
    expect(page.content.linkTargets).toEqual([
      "https://example.atlassian.net/wiki/spaces/KB/pages/1000",
      "https://example.atlassian.net/wiki/spaces/KB/pages/1002",
    ]);
    expect(calls.find((url) => url.includes("/rest/api/3/issue/DEMO-1"))).toContain("issuelinks");
    expect(calls.find((url) => url.includes("/rest/api/3/issue/DEMO-1"))).toContain("comment");
    expect(calls.find((url) => url.includes("/wiki/rest/api/content/1001"))).toContain("ancestors");
    expect(calls).toContainEqual(expect.stringContaining("/api/v2/pages/1001/inline-comments"));
  });
});
