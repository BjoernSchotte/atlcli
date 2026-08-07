import { describe, expect, test } from "bun:test";
import {
  prepareResearchScopePreflightV1,
  proposeResearchScopeMentionsV1,
} from "./scope-preflight.js";
import {
  createResearchEntityScopeSeedV1,
  createResearchKeyScopeSeedV1,
} from "./scope-discovery.js";
import type {
  ResearchReferenceResolveOutputV1,
  ResearchScopeCatalogCapabilityId,
  ResearchScopeCatalogPageV1,
} from "./scope-catalog.js";
import type { ResearchScopeCatalogInvokePortV1 } from "./scope-resolution.js";
import type { ResearchRequestV1 } from "./contracts.js";

const origin = "https://example.atlassian.net";

function request(input: Partial<ResearchRequestV1> = {}): ResearchRequestV1 {
  const project = createResearchKeyScopeSeedV1({
    tenantOrigin: origin,
    product: "jira",
    key: "DEFAULT",
    source: "profile_default",
    authority: "approved",
  });
  const space = createResearchKeyScopeSeedV1({
    tenantOrigin: origin,
    product: "confluence",
    key: "DOCS",
    source: "profile_default",
    authority: "approved",
  });
  return {
    schema: "atlcli.research-request/v1",
    question: "Research the Account Management space and the Delivery Jira project.",
    scope: {
      siteOrigin: origin,
      jiraProjectKeys: ["DEFAULT"],
      confluenceSpaceKeys: ["DOCS"],
    },
    scopeSeeds: [project, space],
    limits: {
      pageSize: 10,
      maxSearchPagesPerProduct: 4,
      maxItemsPerProduct: 30,
      maxDetailItemsPerProduct: 8,
      maxBodyCharsPerItem: 50_000,
      maxPtcCalls: 32,
      maxHttpCalls: 40,
      maxConcurrentCalls: 3,
      maxPtcInputBytes: 64_000,
      maxPtcOutputBytes: 512_000,
      maxTotalResponseBytes: 2_000_000,
      maxInterpreterMemoryBytes: 64_000_000,
      maxInterpreterMs: 15_000,
      maxModelCalls: 12,
      maxTotalModelInputTokens: 160_000,
      maxTotalModelOutputTokens: 36_000,
      maxModelCostMicros: 2_000_000,
      maxModelInputTokens: 160_000,
      maxModelOutputTokens: 4_096,
      maxReportChars: 50_000,
      maxEvidenceAgeMs: 15 * 60_000,
      maxRunMs: 600_000,
    },
    wikiProvider: "rest",
    ...input,
  };
}

function catalog(
  invoke: (
    capability: ResearchScopeCatalogCapabilityId,
    value: unknown,
  ) => Promise<ResearchScopeCatalogPageV1 | ResearchReferenceResolveOutputV1>,
): ResearchScopeCatalogInvokePortV1 {
  return { invoke };
}

describe("research scope preflight", () => {
  test("creates a safe binding ID for a personal Confluence space", () => {
    const seed = createResearchKeyScopeSeedV1({
      tenantOrigin: origin,
      product: "confluence",
      key: "~account-123",
      source: "current_context",
      authority: "approved",
    });

    expect(seed.binding).toMatchObject({
      id: "scope-binding:current_context:confluence:~account-123",
      key: "~account-123",
      entityRef: "scope-key:confluence:~account-123",
    });
  });

  test("extracts exact question ranges for natural whole-scope names", () => {
    const question = "Research the Account Management space and the Delivery Jira project.";
    const mentions = proposeResearchScopeMentionsV1({
      question,
      expectedTenantOrigin: origin,
    });
    expect(mentions.map((mention) => [
      mention.text,
      mention.productHint,
      mention.entityKindHint,
      question.slice(mention.questionTextRange!.start, mention.questionTextRange!.end),
    ])).toEqual([
      ["Account Management", "confluence", "space", "Account Management"],
      ["Delivery", "jira", "project", "Delivery"],
    ]);
  });

  test("recognizes ordinary English and German Chat summary phrasing", () => {
    const english = "Summarize the Account Management space.";
    const german = "Fasse den Bereich Account Management zusammen.";
    expect(proposeResearchScopeMentionsV1({
      question: english,
      expectedTenantOrigin: origin,
    })).toMatchObject([{
      text: "Account Management",
      productHint: "confluence",
      entityKindHint: "space",
    }]);
    expect(proposeResearchScopeMentionsV1({
      question: german,
      expectedTenantOrigin: origin,
    })).toMatchObject([{
      text: "Account Management",
      productHint: "confluence",
      entityKindHint: "space",
    }]);
  });

  test("does not mistake the Jira product qualifier for a project name", () => {
    const question = "Research Jira project DEMO.";
    const mentions = proposeResearchScopeMentionsV1({
      question,
      expectedTenantOrigin: origin,
    });

    expect(mentions.map((mention) => [
      mention.text,
      mention.productHint,
      mention.entityKindHint,
      question.slice(mention.questionTextRange!.start, mention.questionTextRange!.end),
    ])).toEqual([
      ["DEMO", "jira", "project", "DEMO"],
    ]);
  });

  test("accepts a same-tenant Jira project link as an exact scope mention", () => {
    const link = `${origin}/projects/DELIVERY/summary`;
    const mentions = proposeResearchScopeMentionsV1({
      question: `Research ${link}.`,
      expectedTenantOrigin: origin,
    });

    expect(mentions).toMatchObject([{
      productHint: "jira",
      entityKindHint: "project",
      source: "exact_link",
      text: link,
      exactReference: link,
    }]);
  });

  test("recognizes current-tenant Jira issue and Confluence page links as exact entity mentions", () => {
    const issue = `${origin}/browse/ATLCLI-42`;
    const page = `${origin}/wiki/spaces/DOCS/pages/1001/Architecture`;
    const mentions = proposeResearchScopeMentionsV1({
      question: `Compare ${issue} with ${page}.`,
      expectedTenantOrigin: origin,
    });

    expect(mentions).toMatchObject([
      { productHint: "jira", entityKindHint: "issue", source: "exact_link", exactReference: issue },
      { productHint: "confluence", entityKindHint: "page", source: "exact_link", exactReference: page },
    ]);
  });

  test("keeps approved exact links as entity-only bindings without widening to a project or space", async () => {
    const issue = `${origin}/browse/ATLCLI-42`;
    const page = `${origin}/wiki/spaces/DOCS/pages/1001/Architecture`;
    const calls: ResearchScopeCatalogCapabilityId[] = [];
    const outcome = await prepareResearchScopePreflightV1({
      request: request({
        question: `Compare ${issue} with ${page}.`,
        scope: { siteOrigin: origin, jiraProjectKeys: [], confluenceSpaceKeys: [] },
        scopeSeeds: [],
      }),
      catalog: catalog(async (capability, value) => {
        calls.push(capability);
        const reference = (value as { reference: string }).reference;
        return {
          schema: "atlcli.ptc/atlassian.reference.resolve.output/v1",
          candidate: reference === issue
            ? {
                schema: "atlcli.research-scope-candidate/v1",
                id: "research-scope-candidate:jira-issue-atlcli-42",
                tenantOrigin: origin,
                product: "jira",
                entityKind: "issue",
                entityRef: "research-scope-entity:jira-issue-atlcli-42",
                key: "ATLCLI-42",
                name: "Exact Jira issue",
                canonicalUrl: issue,
                match: "exact_link",
                accessible: true,
                providerFreshnessAt: "2026-08-02T00:00:00.000Z",
              }
            : {
                schema: "atlcli.research-scope-candidate/v1",
                id: "research-scope-candidate:confluence-page-1001",
                tenantOrigin: origin,
                product: "confluence",
                entityKind: "page",
                entityRef: "research-scope-entity:confluence-page-1001",
                key: "1001",
                name: "Exact Confluence page",
                canonicalUrl: page,
                match: "exact_link",
                accessible: true,
                providerFreshnessAt: "2026-08-02T00:00:00.000Z",
              },
          unavailable: false,
        };
      }),
    });

    expect(calls).toEqual(["atlassian.reference.resolve", "atlassian.reference.resolve"]);
    if (outcome.kind !== "ready") throw new Error("expected exact-link scope to be ready");
    expect(outcome.request.scope).toMatchObject({ jiraProjectKeys: [], confluenceSpaceKeys: [] });
    expect(outcome.request.scopeSeeds).toEqual(expect.arrayContaining([
      expect.objectContaining({ binding: expect.objectContaining({ entityKind: "issue", key: "ATLCLI-42", authority: "approved" }) }),
      expect.objectContaining({ binding: expect.objectContaining({ entityKind: "page", key: "1001", authority: "approved" }) }),
    ]));
  });

  test("retains an exact entity binding for a follow-up without repeating its URL", async () => {
    const seed = createResearchEntityScopeSeedV1({
      tenantOrigin: origin,
      product: "confluence",
      entityKind: "page",
      key: "1001",
      name: "Exact Confluence page",
      source: "exact_link",
      authority: "approved",
    });
    let catalogCalls = 0;
    const outcome = await prepareResearchScopePreflightV1({
      request: request({
        question: "Which part matters most?",
        scope: {
          siteOrigin: origin,
          jiraProjectKeys: [],
          confluenceSpaceKeys: [],
        },
        scopeSeeds: [seed],
      }),
      catalog: catalog(async () => {
        catalogCalls += 1;
        throw new Error("must not resolve a retained exact binding again");
      }),
    });

    expect(catalogCalls).toBe(0);
    expect(outcome).toMatchObject({
      kind: "ready",
      request: {
        scopeSeeds: [
          { binding: { entityKind: "page", key: "1001" } },
        ],
      },
    });
  });

  test("resolves natural names and replaces lower-precedence profile defaults", async () => {
    const capabilities: string[] = [];
    const outcome = await prepareResearchScopePreflightV1({
      request: request(),
      catalog: catalog(async (capability) => {
        capabilities.push(capability);
        const jira = capability === "jira.project.search";
        return {
          schema: jira
            ? "atlcli.ptc/jira.project.search.output/v1"
            : "atlcli.ptc/wiki.space.search.output/v1",
          candidates: [{
            schema: "atlcli.research-scope-candidate/v1",
            id: jira
              ? "research-scope-candidate:jira-project-delivery"
              : "research-scope-candidate:confluence-space-account",
            tenantOrigin: origin,
            product: jira ? "jira" : "confluence",
            entityKind: jira ? "project" : "space",
            entityRef: jira
              ? "research-scope-entity:jira-project-delivery"
              : "research-scope-entity:confluence-space-account",
            key: jira ? "DELIVERY" : "ACCOUNT",
            name: jira ? "Delivery" : "Account Management",
            status: "current",
            accessible: true,
            providerFreshnessAt: "2026-08-01T00:00:00.000Z",
          }],
          truncated: false,
        };
      }),
    });
    expect(capabilities).toEqual(["wiki.space.search", "jira.project.search"]);
    expect(outcome).toMatchObject({
      schema: "atlcli.research-scope-preflight-outcome/v1",
      kind: "ready",
      request: {
        scope: {
          jiraProjectKeys: ["DELIVERY"],
          confluenceSpaceKeys: ["ACCOUNT"],
        },
      },
    });
    expect(outcome.kind === "ready" && outcome.request.scopeSeeds?.map((seed) => [
      seed.binding.key,
      seed.binding.source,
    ])).toEqual([
      ["ACCOUNT", "natural_language"],
      ["DELIVERY", "natural_language"],
    ]);
  });

  test("keeps explicit locked scope and performs no conflicting catalog lookup", async () => {
    const locked = createResearchKeyScopeSeedV1({
      tenantOrigin: origin,
      product: "jira",
      key: "LOCKED",
      source: "cli_flag",
      authority: "locked",
    });
    let calls = 0;
    const outcome = await prepareResearchScopePreflightV1({
      request: request({
        question: "Research the Delivery Jira project.",
        scope: { siteOrigin: origin, jiraProjectKeys: ["LOCKED"], confluenceSpaceKeys: ["DOCS"] },
        scopeSeeds: [locked, request().scopeSeeds![1]!],
      }),
      catalog: catalog(async () => {
        calls += 1;
        throw new Error("must not be called");
      }),
    });
    expect(calls).toBe(0);
    expect(outcome).toMatchObject({
      kind: "ready",
      mentions: [],
      request: { scope: { jiraProjectKeys: ["LOCKED"] } },
    });
  });

  test("returns a typed clarification without exposing a content-read port", async () => {
    const outcome = await prepareResearchScopePreflightV1({
      request: request({
        question: "Research the Account Management space.",
        scope: { siteOrigin: origin, jiraProjectKeys: ["DEFAULT"], confluenceSpaceKeys: ["DOCS"] },
        scopeSeeds: request().scopeSeeds,
      }),
      catalog: catalog(async () => ({
        schema: "atlcli.ptc/wiki.space.search.output/v1",
        candidates: [
          {
            schema: "atlcli.research-scope-candidate/v1",
            id: "research-scope-candidate:confluence-space-account-1",
            tenantOrigin: origin,
            product: "confluence",
            entityKind: "space",
            entityRef: "research-scope-entity:confluence-space-account-1",
            key: "ACCOUNT1",
            name: "Account Management",
            accessible: true,
            providerFreshnessAt: "2026-08-01T00:00:00.000Z",
          },
          {
            schema: "atlcli.research-scope-candidate/v1",
            id: "research-scope-candidate:confluence-space-account-2",
            tenantOrigin: origin,
            product: "confluence",
            entityKind: "space",
            entityRef: "research-scope-entity:confluence-space-account-2",
            key: "ACCOUNT2",
            name: "Account Management",
            accessible: true,
            providerFreshnessAt: "2026-08-01T00:00:00.000Z",
          },
        ],
        truncated: false,
      })),
    });
    expect(outcome).toMatchObject({
      kind: "clarification_required",
      clarification: {
        schema: "atlcli.research-clarification-required/v1",
        reason: "ambiguous",
        candidateIds: [
          "research-scope-candidate:confluence-space-account-1",
          "research-scope-candidate:confluence-space-account-2",
        ],
      },
      candidateChoices: [
        { key: "ACCOUNT1", name: "Account Management" },
        { key: "ACCOUNT2", name: "Account Management" },
      ],
    });

    if (outcome.kind !== "clarification_required") throw new Error("expected clarification");
    const selected = await prepareResearchScopePreflightV1({
      request: request({
        question: "Research the Account Management space.",
        scope: { siteOrigin: origin, jiraProjectKeys: ["DEFAULT"], confluenceSpaceKeys: ["DOCS"] },
        scopeSeeds: request().scopeSeeds,
      }),
      candidateSelections: [{
        schema: "atlcli.research-scope-candidate-selection/v1",
        mentionId: outcome.clarification.mentionId,
        candidateId: outcome.candidateChoices[1]!.id,
      }],
      catalog: catalog(async () => ({
        schema: "atlcli.ptc/wiki.space.search.output/v1",
        candidates: outcome.candidateChoices,
        truncated: false,
      })),
    });
    expect(selected).toMatchObject({
      kind: "ready",
      request: { scope: { confluenceSpaceKeys: ["ACCOUNT2"] } },
    });
  });

  test("stops a scope-free request before graph or content work", async () => {
    let catalogCalls = 0;
    const outcome = await prepareResearchScopePreflightV1({
      request: request({
        question: "Summarize the relevant work.",
        scope: { siteOrigin: origin, jiraProjectKeys: [], confluenceSpaceKeys: [] },
        scopeSeeds: [],
      }),
      catalog: catalog(async () => {
        catalogCalls += 1;
        throw new Error("must not be called");
      }),
    });
    expect(catalogCalls).toBe(0);
    expect(outcome).toMatchObject({
      kind: "clarification_required",
      clarification: {
        reason: "not_found",
        mentionId: "mention:scope-required",
      },
    });
  });
});
