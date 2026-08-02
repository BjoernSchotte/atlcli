import { describe, expect, it } from "bun:test";
import {
  DEFAULT_RESEARCH_ONE_SHOT_POLICY_V1,
  DEFAULT_RESEARCH_LIMITS_V1,
  RESEARCH_ONE_SHOT_POLICY_SCHEMA_V1,
  RESEARCH_REQUEST_SCHEMA_V1,
  ResearchContractError,
  normalizeResearchLimitsV1,
  normalizeResearchOneShotPolicyV1,
  normalizeResearchRequestV1,
} from "../utils/research/contracts.js";
import { ResearchCursorVault } from "@atlcli/research";
import { createResearchKeyScopeSeedV1 } from "@atlcli/research/scope-discovery";

describe("issue-138 research request contract", () => {
  it("normalizes one closed host-neutral run policy", () => {
    expect(normalizeResearchOneShotPolicyV1(undefined)).toEqual(
      DEFAULT_RESEARCH_ONE_SHOT_POLICY_V1,
    );
    expect(normalizeResearchOneShotPolicyV1({
      schema: RESEARCH_ONE_SHOT_POLICY_SCHEMA_V1,
      requestedEffort: "deep",
      requestedPlanApproval: "automatic",
      scopeExpansionMode: "exact-linked",
      requestedReconciliation: "required",
    })).toEqual({
      schema: RESEARCH_ONE_SHOT_POLICY_SCHEMA_V1,
      requestedEffort: "deep",
      requestedPlanApproval: "automatic",
      scopeExpansionMode: "exact-linked",
      requestedReconciliation: "required",
    });
    expect(() => normalizeResearchOneShotPolicyV1({
      ...DEFAULT_RESEARCH_ONE_SHOT_POLICY_V1,
      hiddenOverride: true,
    })).toThrow("unknown fields");
    expect(() => normalizeResearchOneShotPolicyV1({
      ...DEFAULT_RESEARCH_ONE_SHOT_POLICY_V1,
      requestedEffort: "unbounded",
    })).toThrow("effort policy");
  });

  it("normalizes one bounded Jira + Confluence request", () => {
    expect(
      normalizeResearchRequestV1({
        question: "  Which implementation pages relate to open issues?  ",
        scope: {
          siteOrigin: "https://example.atlassian.net",
          jiraProjectKeys: ["DEMO", "DEMO"],
          confluenceSpaceKeys: ["KB"],
          timeWindow: { from: "2026-01-01", to: "2026-07-30" },
        },
        limits: { pageSize: 500, maxItemsPerProduct: 10 },
        wikiProvider: "rest",
      })
    ).toEqual({
      schema: RESEARCH_REQUEST_SCHEMA_V1,
      question: "Which implementation pages relate to open issues?",
      scope: {
        siteOrigin: "https://example.atlassian.net",
        jiraProjectKeys: ["DEMO"],
        confluenceSpaceKeys: ["KB"],
        timeWindow: { from: "2026-01-01", to: "2026-07-30" },
      },
      limits: {
        ...DEFAULT_RESEARCH_LIMITS_V1,
        pageSize: 50,
        maxItemsPerProduct: 10,
        maxDetailItemsPerProduct: 10,
      },
      wikiProvider: "rest",
    });
  });

  it("rejects foreign origins and invalid dates while admitting a provisional scope", () => {
    const base = {
      question: "Find the relevant work",
      limits: {},
      wikiProvider: "rest" as const,
    };
    expect(() =>
      normalizeResearchRequestV1({
        ...base,
        scope: {
          siteOrigin: "https://example.invalid",
          jiraProjectKeys: ["DEMO"],
          confluenceSpaceKeys: ["KB"],
        },
      })
    ).toThrow(ResearchContractError);
    expect(normalizeResearchRequestV1({
      ...base,
      scope: {
        siteOrigin: "https://example.atlassian.net",
        jiraProjectKeys: [],
        confluenceSpaceKeys: ["KB"],
      },
    }).scope).toMatchObject({ jiraProjectKeys: [], confluenceSpaceKeys: ["KB"] });
    expect(() =>
      normalizeResearchRequestV1({
        ...base,
        scope: {
          siteOrigin: "https://example.atlassian.net",
          jiraProjectKeys: ["DEMO"],
          confluenceSpaceKeys: ["KB"],
          timeWindow: { from: "2026-07-30", to: "2026-01-01" },
        },
      })
    ).toThrow("start date");
  });

  it("preserves ordered scope provenance and rejects a projection mismatch", () => {
    const origin = "https://example.atlassian.net";
    const seeds = [
      createResearchKeyScopeSeedV1({
        tenantOrigin: origin,
        product: "jira",
        key: "DEMO",
        source: "cli_flag",
        authority: "locked",
      }),
      createResearchKeyScopeSeedV1({
        tenantOrigin: origin,
        product: "jira",
        key: "OLD",
        source: "profile_default",
        authority: "approved",
      }),
      createResearchKeyScopeSeedV1({
        tenantOrigin: origin,
        product: "confluence",
        key: "KB",
        source: "current_context",
        authority: "approved",
      }),
    ];
    const input = {
      question: "Find the relevant work",
      scope: {
        siteOrigin: origin,
        jiraProjectKeys: ["DEMO"],
        confluenceSpaceKeys: ["KB"],
      },
      scopeSeeds: seeds,
      limits: {},
      wikiProvider: "rest",
    };
    expect(normalizeResearchRequestV1(input).scopeSeeds).toEqual(seeds);
    expect(() => normalizeResearchRequestV1({
      ...input,
      scope: { ...input.scope, jiraProjectKeys: ["OLD"] },
    })).toThrow("highest-precedence scope seeds");
    expect(() => normalizeResearchRequestV1({
      ...input,
      scopeSeeds: [{ ...seeds[0], precedence: 1 }, ...seeds.slice(1)],
    })).toThrow("precedence");
  });

  it("clamps every public resource budget", () => {
    expect(
      normalizeResearchLimitsV1({
        pageSize: 0,
        maxSearchPagesPerProduct: 99,
        maxItemsPerProduct: 999,
        maxDetailItemsPerProduct: 999,
        maxBodyCharsPerItem: 1,
        maxPtcCalls: 1,
        maxHttpCalls: 999,
        maxConcurrentCalls: 99,
        maxPtcInputBytes: 1,
        maxPtcOutputBytes: 9_999_999,
        maxTotalResponseBytes: 1,
        maxInterpreterMemoryBytes: 1,
        maxInterpreterMs: 999_999,
        maxModelCalls: 0,
        maxTotalModelInputTokens: 1,
        maxTotalModelOutputTokens: 999_999,
        maxModelCostMicros: 1,
        maxModelInputTokens: 1,
        maxModelOutputTokens: 999_999,
        maxReportChars: 1,
        maxRunMs: Number.MAX_SAFE_INTEGER,
      })
    ).toEqual({
      pageSize: 1,
      maxSearchPagesPerProduct: 10,
      maxItemsPerProduct: 250,
      maxDetailItemsPerProduct: 50,
      maxBodyCharsPerItem: 256,
      maxPtcCalls: 4,
      maxHttpCalls: 256,
      maxConcurrentCalls: 8,
      maxPtcInputBytes: 1_000,
      maxPtcOutputBytes: 1_000_000,
      maxTotalResponseBytes: 100_000,
      maxInterpreterMemoryBytes: 8_000_000,
      maxInterpreterMs: 60_000,
      maxModelCalls: 1,
      maxTotalModelInputTokens: 1_000,
      maxTotalModelOutputTokens: 128_000,
      maxModelCostMicros: 10_000,
      maxModelInputTokens: 1_000,
      maxModelOutputTokens: 32_000,
      maxReportChars: 1_000,
      maxRunMs: 600_000,
    });
  });

  it("decodes hostile runtime input without leaking native type errors", () => {
    expect(() => normalizeResearchRequestV1(null)).toThrow("request is missing");
    expect(() =>
      normalizeResearchRequestV1({
        question: { trim: true },
        scope: {},
        wikiProvider: "rest",
      })
    ).toThrow("question is missing");
    expect(() =>
      normalizeResearchRequestV1({
        question: "Find relevant work",
        scope: {
          siteOrigin: "https://example.atlassian.net",
          jiraProjectKeys: "DEMO",
          confluenceSpaceKeys: ["KB"],
        },
        wikiProvider: "rest",
      })
    ).toThrow("scope must be a list");
  });
});

describe("per-run opaque research cursors", () => {
  it("never exposes a provider next URL and resolves only for the issuing tool", () => {
    let id = 0;
    const vault = new ResearchCursorVault({ createId: () => `id-${++id}` });
    const token = vault.issue(
      "wiki.search",
      "query:implementation",
      "https://example.atlassian.net/wiki/rest/api/content/search?cursor=secret"
    );

    expect(token).toBe("research-cursor:id-1");
    expect(token).not.toContain("atlassian.net");
    expect(vault.resolve("wiki.search", token)).toEqual({
      queryFingerprint: "query:implementation",
      providerCursor:
        "https://example.atlassian.net/wiki/rest/api/content/search?cursor=secret",
    });
    expect(() => vault.resolve("wiki.search", token)).toThrow("unknown");

    const wrongToolToken = vault.issue(
      "wiki.search",
      "query:implementation",
      "next-tool"
    );
    expect(() =>
      vault.resolve("jira.issue.search", wrongToolToken)
    ).toThrow("capability query");
    expect(() =>
      vault.resolve("wiki.search", "research-cursor:other")
    ).toThrow(
      "unknown"
    );

    vault.clear();
  });

  it("fails closed when the cursor budget is exhausted", () => {
    const vault = new ResearchCursorVault({
      maxEntries: 1,
      createId: () => "fixed",
    });
    expect(vault.issue("wiki.search", "query:first", "first")).toBe(
      "research-cursor:fixed"
    );
    expect(() => vault.issue("wiki.search", "query:second", "second")).toThrow(
      "budget"
    );
  });

  it("rejects provider loops and expired cursors", () => {
    let now = 1_000;
    let id = 0;
    const vault = new ResearchCursorVault({
      createId: () => `id-${++id}`,
      now: () => now,
      ttlMs: 100,
    });
    const token = vault.issue("jira.issue.search", "query:open", "next-1");
    expect(() => vault.issue("jira.issue.search", "query:open", "next-1")).toThrow(
      "repeated"
    );
    now = 1_101;
    expect(() => vault.resolve("jira.issue.search", token)).toThrow("unknown");
  });
});
