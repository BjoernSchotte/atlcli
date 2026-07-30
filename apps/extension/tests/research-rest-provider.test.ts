import { afterEach, describe, expect, it } from "bun:test";
import type { Profile } from "@atlcli/core";
import {
  RESEARCH_CAPABILITY_SCHEMAS,
  type ResearchGetOutputV1,
  type ResearchSearchOutputV1,
} from "../utils/research/capability-contracts.js";
import { normalizeResearchRequestV1 } from "../utils/research/contracts.js";
import { createRestResearchBroker } from "../utils/research/rest-provider.js";

const profile: Profile = {
  name: "research-session",
  baseUrl: "https://example.atlassian.net",
  auth: { type: "session" },
};

const originalFetch = globalThis.fetch;

function request() {
  return normalizeResearchRequestV1({
    question:
      "Jira-Projektkey DEMO, Confluence-Spacekey KB: explain the implementation",
    scope: {
      siteOrigin: "https://example.atlassian.net",
      jiraProjectKeys: ["DEMO"],
      confluenceSpaceKeys: ["KB"],
    },
    limits: {},
    wikiProvider: "rest",
  });
}

describe("REST research provider", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("binds session clients, host queries, paging and bounded details end to end", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = (async (
      url: string | URL | Request,
      init?: RequestInit
    ) => {
      const textUrl = String(url);
      requests.push({ url: textUrl, init });
      if (textUrl.includes("/rest/api/3/search/jql")) {
        return new Response(
          JSON.stringify({
            issues: [
              {
                id: "1",
                key: "DEMO-1",
                fields: {
                  summary: "Research issue",
                  project: { id: "1", key: "DEMO" },
                  status: { id: "1", name: "Open" },
                  updated: "2026-07-01T10:00:00.000Z",
                },
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      if (textUrl.includes("/rest/api/3/issue/DEMO-1")) {
        return new Response(
          JSON.stringify({
            id: "1",
            key: "DEMO-1",
            fields: {
              summary: "Research issue",
              project: { id: "1", key: "DEMO" },
              status: { id: "1", name: "Open" },
              description: {
                type: "doc",
                version: 1,
                content: [
                  {
                    type: "paragraph",
                    content: [
                      {
                        type: "text",
                        text: "See the page",
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
                    ],
                  },
                ],
              },
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      if (textUrl.includes("/wiki/rest/api/content/search")) {
        return new Response(
          JSON.stringify({
            results: [
              {
                id: "1001",
                title: "Implementation page",
                space: { key: "KB" },
                _links: {
                  base: "https://example.atlassian.net/wiki",
                  webui: "/spaces/KB/pages/1001",
                },
              },
            ],
            _links: {},
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      if (textUrl.includes("/wiki/rest/api/content/1001")) {
        return new Response(
          JSON.stringify({
            id: "1001",
            title: "Implementation page",
            space: { key: "KB" },
            body: {
              storage: {
                value:
                  '<p>Implements <a href="/browse/DEMO-1">DEMO-1</a>.</p>',
              },
            },
            _links: {
              base: "https://example.atlassian.net/wiki",
              webui: "/spaces/KB/pages/1001",
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;

    const broker = createRestResearchBroker(profile, request());
    const jira = (await broker.invoke("jira.issue.search", {
      schema: RESEARCH_CAPABILITY_SCHEMAS["jira.issue.search"].input,
      query: { text: "implementation" },
    })) as ResearchSearchOutputV1;
    const wiki = (await broker.invoke("wiki.search", {
      schema: RESEARCH_CAPABILITY_SCHEMAS["wiki.search"].input,
      query: { text: "implementation" },
    })) as ResearchSearchOutputV1;
    const jiraDetail = (await broker.invoke("jira.issue.get", {
      schema: RESEARCH_CAPABILITY_SCHEMAS["jira.issue.get"].input,
      entityRef: jira.items[0]!.entityRef,
    })) as ResearchGetOutputV1;
    const wikiDetail = (await broker.invoke("wiki.page.get", {
      schema: RESEARCH_CAPABILITY_SCHEMAS["wiki.page.get"].input,
      entityRef: wiki.items[0]!.entityRef,
    })) as ResearchGetOutputV1;

    const jiraSearchBody = JSON.parse(String(requests[0]?.init?.body));
    expect(jiraSearchBody.jql).toContain('project in ("DEMO")');
    expect(jiraSearchBody.jql).not.toContain("OTHER");
    expect(requests.every(({ init }) => init?.credentials === "include")).toBe(true);
    expect(jiraDetail.content.linkTargets).toEqual([
      "https://example.atlassian.net/wiki/spaces/KB/pages/1001",
    ]);
    expect(wikiDetail.content.text).toContain("DEMO-1");
    expect(wikiDetail.content.linkTargets).toEqual([
      "https://example.atlassian.net/browse/DEMO-1",
    ]);
    expect(jiraDetail.budget.httpAttemptsRemaining).toBeLessThan(
      request().limits.maxHttpCalls
    );
  });

  it("rejects a caller-supplied tenant or non-session profile", () => {
    expect(() =>
      createRestResearchBroker(
        { ...profile, baseUrl: "https://foreign.atlassian.net" },
        request()
      )
    ).toThrow("does not match");
    expect(() =>
      createRestResearchBroker(
        {
          ...profile,
          auth: {
            type: "apiToken",
            email: "test@example.invalid",
            token: "not-a-real-token",
          },
        },
        request()
      )
    ).toThrow("does not match");
  });
});
