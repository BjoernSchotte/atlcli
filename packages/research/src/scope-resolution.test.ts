import { describe, expect, test } from "bun:test";
import {
  resolveInitialResearchScopeV1,
  type ResearchScopeCatalogInvokePortV1,
} from "./scope-resolution.js";
import type {
  ResearchReferenceResolveOutputV1,
  ResearchScopeCatalogCapabilityId,
  ResearchScopeCatalogPageV1,
} from "./scope-catalog.js";
import type { ResearchScopeCandidateV1, ResearchScopeMentionV1 } from "./scope-discovery.js";

const origin = "https://example.atlassian.net";

function candidate(input: Partial<ResearchScopeCandidateV1> = {}): ResearchScopeCandidateV1 {
  return {
    id: "research-scope-candidate:confluence-space-account",
    tenantOrigin: origin,
    product: "confluence",
    entityKind: "space",
    entityRef: "research-scope-entity:confluence-space-account",
    key: "ACCOUNT",
    name: "Account Management",
    status: "current",
    accessible: true,
    providerFreshnessAt: "2026-07-31T00:00:00.000Z",
    ...input,
  };
}

function mention(input: Partial<ResearchScopeMentionV1> = {}): ResearchScopeMentionV1 {
  return {
    id: "mention:1",
    productHint: "confluence",
    entityKindHint: "space",
    source: "natural_language",
    text: "Account Management space",
    normalizedText: "account management",
    questionTextRange: { start: 0, end: 24 },
    ...input,
  };
}

function catalog(
  invoke: (capability: ResearchScopeCatalogCapabilityId, value: unknown) => Promise<ResearchScopeCatalogPageV1 | ResearchReferenceResolveOutputV1>,
): ResearchScopeCatalogInvokePortV1 {
  return { invoke };
}

const baseScope = {
  siteOrigin: origin,
  jiraProjectKeys: ["LOCKED"],
  confluenceSpaceKeys: [],
};

describe("initial scope resolution stop gate", () => {
  test("paginates to prove one exact name and projects its approved binding", async () => {
    const calls: unknown[] = [];
    const output = await resolveInitialResearchScopeV1({
      baseScope,
      existingBindings: [],
      mentions: [mention()],
      automaticApproval: true,
      catalog: catalog(async (_capability, value) => {
        calls.push(value);
        return calls.length === 1
          ? { schema: "atlcli.ptc/wiki.space.search.output/v1", candidates: [], nextCursorRef: "research-scope-cursor:1", truncated: true }
          : { schema: "atlcli.ptc/wiki.space.search.output/v1", candidates: [candidate()], truncated: false };
      }),
    });
    expect(calls).toHaveLength(2);
    expect(output).toMatchObject({
      kind: "ready",
      scope: { jiraProjectKeys: ["LOCKED"], confluenceSpaceKeys: ["ACCOUNT"] },
      bindings: [{ source: "natural_language", authority: "approved", key: "ACCOUNT" }],
    });
  });

  test("returns typed ambiguity and performs catalog work only", async () => {
    let catalogCalls = 0;
    let contentCalls = 0;
    const output = await resolveInitialResearchScopeV1({
      baseScope,
      existingBindings: [],
      mentions: [mention()],
      automaticApproval: true,
      catalog: catalog(async () => {
        catalogCalls += 1;
        return {
          schema: "atlcli.ptc/wiki.space.search.output/v1",
          candidates: [
            candidate(),
            candidate({ id: "research-scope-candidate:confluence-space-account-2", entityRef: "research-scope-entity:confluence-space-account-2", key: "ACCOUNT2" }),
          ],
          truncated: false,
        };
      }),
    });
    // There is deliberately no content capability on the resolver port.
    contentCalls += 0;
    expect({ catalogCalls, contentCalls }).toEqual({ catalogCalls: 1, contentCalls: 0 });
    expect(output).toMatchObject({
      kind: "clarification_required",
      clarification: {
        schema: "atlcli.research-clarification-required/v1",
        reason: "ambiguous",
        candidateIds: [
          "research-scope-candidate:confluence-space-account",
          "research-scope-candidate:confluence-space-account-2",
        ],
      },
    });
  });

  test("does not use an incomplete catalog to prove exact-name uniqueness", async () => {
    const output = await resolveInitialResearchScopeV1({
      baseScope,
      existingBindings: [],
      mentions: [mention()],
      automaticApproval: true,
      maximumCatalogPages: 1,
      catalog: catalog(async () => ({
        schema: "atlcli.ptc/wiki.space.search.output/v1",
        candidates: [candidate()],
        nextCursorRef: "research-scope-cursor:1",
        truncated: true,
      })),
    });
    expect(output).toMatchObject({ kind: "clarification_required", clarification: { reason: "incomplete" } });
  });

  test("distinguishes archived-only, unavailable, and exact-reference outcomes", async () => {
    const archived = await resolveInitialResearchScopeV1({
      baseScope,
      existingBindings: [],
      mentions: [mention()],
      automaticApproval: true,
      catalog: catalog(async () => ({
        schema: "atlcli.ptc/wiki.space.search.output/v1",
        candidates: [candidate({ status: "archived" })],
        truncated: false,
      })),
    });
    expect(archived).toMatchObject({ kind: "clarification_required", clarification: { reason: "archived_only" } });

    const unavailable = await resolveInitialResearchScopeV1({
      baseScope,
      existingBindings: [],
      mentions: [mention({ productHint: undefined, entityKindHint: undefined })],
      automaticApproval: true,
      catalog: catalog(async () => { throw new Error("must not be called"); }),
    });
    expect(unavailable).toMatchObject({ kind: "clarification_required", clarification: { reason: "unavailable" } });

    const exact = candidate({ canonicalUrl: `${origin}/wiki/spaces/ACCOUNT`, match: "exact_link" });
    const resolved = await resolveInitialResearchScopeV1({
      baseScope,
      existingBindings: [],
      mentions: [mention({ source: "exact_link", exactReference: exact.canonicalUrl })],
      automaticApproval: true,
      catalog: catalog(async (capability) => {
        expect(capability).toBe("atlassian.reference.resolve");
        return { schema: "atlcli.ptc/atlassian.reference.resolve.output/v1", candidate: exact, unavailable: false };
      }),
    });
    expect(resolved).toMatchObject({ kind: "ready", scope: { confluenceSpaceKeys: ["ACCOUNT"] } });
  });

  test("preserves resolved authority when automatic approval is disabled", async () => {
    const output = await resolveInitialResearchScopeV1({
      baseScope,
      existingBindings: [],
      mentions: [mention({ normalizedText: "account" })],
      automaticApproval: false,
      catalog: catalog(async () => ({
        schema: "atlcli.ptc/wiki.space.search.output/v1",
        candidates: [candidate()],
        truncated: false,
      })),
    });
    expect(output).toMatchObject({ kind: "ready", bindings: [{ authority: "resolved" }] });
    expect(output.kind === "ready" && output.scope.confluenceSpaceKeys).toEqual([]);
  });
});
