import { describe, expect, it } from "bun:test";
import type { Profile } from "@atlcli/core";
import {
  DEFAULT_RESEARCH_LIMITS_V1,
  RESEARCH_REQUEST_SCHEMA_V1,
  normalizeResearchRequestV1,
} from "../utils/research/contracts.js";
import { ResearchRunBudget } from "../utils/research/budget.js";
import { createRestResearchProviders } from "../utils/research/rest-provider.js";

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
});
