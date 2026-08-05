import { describe, expect, test } from "bun:test";
import {
  DEFAULT_RESEARCH_LIMITS_V1,
  RESEARCH_REQUEST_SCHEMA_V1,
  type ResearchRequestV1,
} from "./contracts.js";
import {
  createResearchEntityScopeSeedV1,
  createResearchKeyScopeSeedV1,
} from "./scope-discovery.js";
import {
  directChatProductsV1,
  prepareDirectChatRequestV1,
} from "./direct-chat.js";

const origin = "https://example.atlassian.net";

function request(question = "What is this wiki page about?"): ResearchRequestV1 {
  return {
    schema: RESEARCH_REQUEST_SCHEMA_V1,
    question,
    scope: {
      siteOrigin: origin,
      jiraProjectKeys: [],
      confluenceSpaceKeys: ["KB"],
    },
    scopeSeeds: [
      createResearchKeyScopeSeedV1({
        tenantOrigin: origin,
        product: "confluence",
        key: "KB",
        source: "current_context",
        authority: "approved",
      }),
      createResearchEntityScopeSeedV1({
        tenantOrigin: origin,
        product: "confluence",
        entityKind: "page",
        key: "12345",
        name: "Customer retention analysis",
        source: "current_context",
        authority: "approved",
      }),
    ],
    limits: { ...DEFAULT_RESEARCH_LIMITS_V1 },
    wikiProvider: "rest",
  };
}

describe("direct chat scope projection", () => {
  test("uses a bound page as the only Confluence candidate instead of searching its whole space", () => {
    const projected = prepareDirectChatRequestV1(request());

    expect(projected.scope.confluenceSpaceKeys).toEqual(["KB"]);
    expect(projected.scopeSeeds?.map((seed) => seed.binding.entityKind)).toEqual(["space", "page"]);
    expect(projected.exactContextProducts).toEqual(["confluence"]);
    expect(projected.limits.maxBodyCharsPerItem).toBe(8_000);
    expect(directChatProductsV1(projected)).toEqual(["confluence"]);
  });

  test("uses an exact page URL as direct CLI chat context", () => {
    const input = request();
    input.scope.confluenceSpaceKeys = [];
    input.scopeSeeds = [
      createResearchEntityScopeSeedV1({
        tenantOrigin: origin,
        product: "confluence",
        entityKind: "page",
        key: "12345",
        name: "Exact linked page",
        source: "exact_link",
        authority: "locked",
      }),
    ];

    expect(prepareDirectChatRequestV1(input).exactContextProducts).toEqual([
      "confluence",
    ]);
  });

  test("keeps an explicitly added space alongside the bound page", () => {
    const input = request();
    input.scope.confluenceSpaceKeys = ["DOCS"];
    input.scopeSeeds = [
      createResearchKeyScopeSeedV1({
        tenantOrigin: origin,
        product: "confluence",
        key: "DOCS",
        source: "ui_added",
        authority: "locked",
      }),
      ...input.scopeSeeds!,
    ];

    const projected = prepareDirectChatRequestV1(input);

    expect(projected.scope.confluenceSpaceKeys).toEqual(["DOCS"]);
    expect(projected.scopeSeeds?.some((seed) => seed.binding.entityKind === "page")).toBe(true);
    expect(projected.exactContextProducts).toBeUndefined();
  });

  test("retains the current space when the question explicitly requests a space-wide search", () => {
    const projected = prepareDirectChatRequestV1(
      request("Search the current space for related guidance."),
    );

    expect(projected.scope.confluenceSpaceKeys).toEqual(["KB"]);
    expect(projected.exactContextProducts).toBeUndefined();
  });

  test("leaves a current-space request unchanged when no exact page chip is bound", () => {
    const input = request();
    input.scopeSeeds = input.scopeSeeds?.filter((seed) => seed.binding.entityKind !== "page");

    expect(prepareDirectChatRequestV1(input)).toBe(input);
    expect(directChatProductsV1(input)).toEqual(["confluence"]);
  });
});
