import { afterEach, expect, mock, test } from "bun:test";
import type { Profile } from "@atlcli/core";
import { ResearchRunBudget } from "./budget.js";
import {
  DEFAULT_RESEARCH_LIMITS_V1,
  RESEARCH_REQUEST_SCHEMA_V1,
  normalizeResearchRequestV1,
} from "./contracts.js";
import { createRestResearchProviders } from "./rest-provider.js";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const request = normalizeResearchRequestV1({
  schema: RESEARCH_REQUEST_SCHEMA_V1,
  question: "Read the bounded project.",
  scope: {
    siteOrigin: "https://example.atlassian.net",
    jiraProjectKeys: ["DEMO"],
    confluenceSpaceKeys: [],
  },
  limits: DEFAULT_RESEARCH_LIMITS_V1,
  wikiProvider: "rest",
});
const profile: Profile = {
  name: "test-profile",
  baseUrl: request.scope.siteOrigin,
  deploymentType: "cloud",
  auth: { type: "apiToken", email: "test@example.invalid", token: "test" },
};

test("an issue read survives a failing remote-link endpoint and reports links as incomplete", async () => {
  globalThis.fetch = mock((input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("/remotelink")) {
      return Promise.resolve(new Response(JSON.stringify({ errorMessages: ["forbidden"] }), {
        status: 403,
        headers: { "content-type": "application/json" },
      }));
    }
    return Promise.resolve(new Response(JSON.stringify({
      id: "1",
      key: "DEMO-1",
      self: "https://example.atlassian.net/rest/api/3/issue/1",
      fields: {
        summary: "Bounded issue",
        description: { type: "doc", version: 1, content: [] },
        project: { id: "1", key: "DEMO" },
        status: { id: "1", name: "In Progress" },
        subtasks: [{ id: "2", key: "DEMO-2" }],
      },
    }), { status: 200, headers: { "content-type": "application/json" } }));
  }) as unknown as typeof fetch;
  const providers = createRestResearchProviders(
    profile,
    request,
    new ResearchRunBudget(request.limits),
    { allowProfileAuth: true },
  );
  const issue = await providers.jira.getIssue({
    issueKey: "DEMO-1",
    signal: new AbortController().signal,
  });
  expect(issue.title).toBe("Bounded issue");
  expect(issue.content.linkTargets).toEqual(["https://example.atlassian.net/browse/DEMO-2"]);
  expect(issue.content.truncated).toBe(true);
});
