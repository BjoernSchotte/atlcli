import { describe, expect, test } from "bun:test";
import {
  createResearchScopeBindingV1,
  normalizeResearchScopeMentionText,
  projectApprovedWholeScopeV1,
  resolveResearchScopeMentionV1,
  selectResearchScopeSeedsV1,
  type ResearchScopeCandidateV1,
  type ResearchScopeMentionV1,
} from "../utils/research/scope-discovery.js";

const candidate = (overrides: Partial<ResearchScopeCandidateV1> = {}): ResearchScopeCandidateV1 => ({
  id: "candidate:1",
  tenantOrigin: "https://mayflower.atlassian.net",
  product: "confluence",
  entityKind: "space",
  entityRef: "research-entity:space-1",
  key: "DOCSY",
  name: "Documentation",
  accessible: true,
  providerFreshnessAt: "2026-07-31T10:00:00.000Z",
  ...overrides,
});

const mention = (overrides: Partial<ResearchScopeMentionV1> = {}): ResearchScopeMentionV1 => ({
  id: "mention:1",
  productHint: "confluence",
  entityKindHint: "space",
  source: "natural_language",
  text: "Documentation",
  normalizedText: normalizeResearchScopeMentionText("Documentation"),
  ...overrides,
});

describe("read-only Atlassian scope discovery", () => {
  test("resolves an exact key even when a catalog page is incomplete", () => {
    const result = resolveResearchScopeMentionV1({
      mention: mention({ text: "DOCSY", normalizedText: "docsy" }),
      candidates: [candidate()],
      catalogComplete: false,
      expectedTenantOrigin: "https://mayflower.atlassian.net",
    });

    expect(result).toEqual({
      mentionId: "mention:1",
      state: "resolved",
      candidateIds: ["candidate:1"],
      resolvedCandidateId: "candidate:1",
      uniquenessProof: "exact_key_lookup",
      catalogComplete: false,
      requiresUserChoice: false,
    });
  });

  test("does not auto-resolve a name from a truncated catalog", () => {
    const result = resolveResearchScopeMentionV1({
      mention: mention(),
      candidates: [candidate()],
      catalogComplete: false,
      expectedTenantOrigin: "https://mayflower.atlassian.net",
    });

    expect(result.state).toBe("incomplete");
    expect(result.requiresUserChoice).toBe(true);
    expect(result.uniquenessProof).toBeUndefined();
  });

  test("returns ambiguity for duplicate exact names", () => {
    const result = resolveResearchScopeMentionV1({
      mention: mention(),
      candidates: [
        candidate({ id: "candidate:1", key: "DOCSY" }),
        candidate({ id: "candidate:2", key: "DOCS2" }),
      ],
      catalogComplete: true,
      expectedTenantOrigin: "https://mayflower.atlassian.net",
    });

    expect(result.state).toBe("ambiguous");
    expect(result.candidateIds).toEqual(["candidate:1", "candidate:2"]);
  });

  test("ignores foreign-tenant and inaccessible candidates", () => {
    const result = resolveResearchScopeMentionV1({
      mention: mention(),
      candidates: [
        candidate({ tenantOrigin: "https://other.atlassian.net" }),
        candidate({ id: "candidate:2", accessible: false as unknown as true }),
      ],
      catalogComplete: true,
      expectedTenantOrigin: "https://mayflower.atlassian.net",
    });

    expect(result.state).toBe("not_found");
    expect(result.candidateIds).toEqual([]);
  });

  test("preserves explicit seed precedence and projects only approved whole scopes", () => {
    const locked = createResearchScopeBindingV1({
      candidate: candidate({ product: "jira", entityKind: "project", key: "ATLCLI", name: "atlcli" }),
      source: "cli_flag",
      authority: "locked",
      bindingId: "binding:locked",
    });
    const defaultBinding = createResearchScopeBindingV1({
      candidate: candidate({ id: "candidate:default", product: "jira", entityKind: "project", key: "OTHER", name: "Other" }),
      source: "profile_default",
      authority: "approved",
      bindingId: "binding:default",
    });
    const selected = selectResearchScopeSeedsV1([
      { binding: defaultBinding, precedence: 200 },
      { binding: locked, precedence: 500 },
    ]);
    expect(selected.map((entry) => entry.key)).toEqual(["ATLCLI"]);

    const projected = projectApprovedWholeScopeV1(selected, {
      siteOrigin: "https://mayflower.atlassian.net",
      jiraProjectKeys: [],
      confluenceSpaceKeys: [],
    });
    expect(projected.jiraProjectKeys).toEqual(["ATLCLI"]);
  });
});
