import { describe, expect, test } from "bun:test";
import {
  DEFAULT_RESEARCH_LIMITS_V1,
  RESEARCH_REQUEST_SCHEMA_V1,
  RESEARCH_TOOL_IDS,
  normalizeResearchRequestV1,
} from "@atlcli/research";
import {
  normalizeResearchScopeMentionText,
  resolveResearchScopeMentionV1,
} from "@atlcli/research/scope-discovery";

describe("@atlcli/research host-neutral boundary", () => {
  test("exports the host-neutral contract without browser or node adapters", () => {
    expect(RESEARCH_REQUEST_SCHEMA_V1).toBe("atlcli.research-request/v1");
    expect(RESEARCH_TOOL_IDS).toEqual([
      "jira.issue.search",
      "jira.issue.get",
      "wiki.search",
      "wiki.page.get",
    ]);
    expect(DEFAULT_RESEARCH_LIMITS_V1.maxPtcCalls).toBe(32);
  });

  test("normalizes through the package entrypoint", () => {
    const request = normalizeResearchRequestV1({
      schema: RESEARCH_REQUEST_SCHEMA_V1,
      question: "Which pages relate to ATLCLI issues?",
      scope: {
        siteOrigin: "https://tenant-a.atlassian.net",
        jiraProjectKeys: ["ATLCLI"],
        confluenceSpaceKeys: ["DOCSY"],
      },
      limits: DEFAULT_RESEARCH_LIMITS_V1,
      wikiProvider: "rest",
    });
    expect(request.scope.siteOrigin).toBe("https://tenant-a.atlassian.net");
    expect(request.scope.jiraProjectKeys).toEqual(["ATLCLI"]);
  });

  test("keeps scope discovery on the same browser-safe package", () => {
    const result = resolveResearchScopeMentionV1({
      mention: {
        id: "mention:package",
        source: "natural_language",
        text: "DOCSY",
        normalizedText: normalizeResearchScopeMentionText("DOCSY"),
        productHint: "confluence",
        entityKindHint: "space",
      },
      candidates: [{
        id: "candidate:package",
        tenantOrigin: "https://tenant-a.atlassian.net",
        product: "confluence",
        entityKind: "space",
        entityRef: "research-entity:docsy",
        key: "DOCSY",
        name: "Documentation",
        accessible: true,
        providerFreshnessAt: "2026-07-31T10:00:00.000Z",
      }],
      catalogComplete: false,
      expectedTenantOrigin: "https://tenant-a.atlassian.net",
    });
    expect(result.state).toBe("resolved");
    expect(result.uniquenessProof).toBe("exact_key_lookup");
  });
});
