import { describe, expect, test } from "bun:test";
import { fakeModel } from "@langchain/core/testing";
import { ToolMessage } from "@langchain/core/messages";
import { tool } from "@langchain/core/tools";
import { z } from "zod/v4";
import { createResearchBriefV1 } from "./brief.js";
import { ResearchCapabilityBroker } from "./broker.js";
import { DEFAULT_RESEARCH_LIMITS_V1 } from "./contracts.js";
import { RESEARCH_REQUEST_SCHEMA_V1 } from "./contracts.js";
import { BOUND_ENTITY_READ_INPUT_SCHEMA_V1 } from "./capability-contracts.js";
import {
  RESEARCH_SUBAGENT_MODEL_MAX_OUTPUT_TOKENS_V1,
  boundResearchNodePtcToolsV1,
  buildResearchAcquisitionProgram,
  buildResearchBoundAcquisitionProgramV1,
  compileDynamicResearchSubagents,
  completeResearchNodeStructuredCandidateV1,
  normalizeResearchReconciliationCandidateV1,
  optionalAnalysisFallbackForStructuredOutputFailureV1,
  responseSchemaForResearchNodeV1,
} from "./dynamic-subagents.js";
import { composeResearchGraphV1 } from "./graph.js";
import { RESEARCH_EXACT_BOUND_PACKET_MODEL_BODY_JSON_SCHEMA_V2 } from "./response-schemas.js";
import {
  parseReconciliationBodyV1,
  RESEARCH_PACKET_BODY_SCHEMA_V2,
  RESEARCH_RECONCILIATION_BODY_SCHEMA_V1,
} from "./workflow-contracts.js";

test("uses the deterministic host outline after nested optional planner schema failures", () => {
  const providerError = new Error(
    "Failed to parse structured output for tool 'ResearchPacketReferenceModelBodyV2'.",
  );
  const wrapped = new Error("Subagent invocation failed.", { cause: providerError });
  const nested = new Error("Deep agent task failed.", { cause: wrapped });

  expect(optionalAnalysisFallbackForStructuredOutputFailureV1(
    "outline-planner",
    nested,
  )).toEqual({
    schema: "atlcli.research-packet-reference-model/v2",
    claimIds: [],
    contradictions: [],
    outlineProposals: [],
    gaps: [],
    proposedFollowUps: [],
    coverageLimits: [],
  });
  expect(optionalAnalysisFallbackForStructuredOutputFailureV1(
    "synthesizer",
    nested,
  )).toBeUndefined();
  expect(optionalAnalysisFallbackForStructuredOutputFailureV1(
    "outline-planner",
    new Error("Provider connection closed."),
  )).toBeUndefined();
  expect(optionalAnalysisFallbackForStructuredOutputFailureV1(
    "coverage-moderator",
    nested,
  )).toEqual({
    schema: "atlcli.research-packet-reference-model/v2",
    claimIds: [],
    contradictions: [],
    outlineProposals: [],
    gaps: [],
    proposedFollowUps: [],
    coverageLimits: [
      "The independent coverage projection could not be validated; the host and final critic retain all admitted evidence and must disclose unresolved coverage.",
    ],
  });
});

describe("reconciliation candidate normalization", () => {
  test("drops only follow-ups that bind defects without add_follow_up", () => {
    const candidate = {
      schema: RESEARCH_RECONCILIATION_BODY_SCHEMA_V1,
      defects: [{
        id: "defect:needs-more-evidence",
        severity: "important" as const,
        target: { kind: "coverage" as const, id: "coverage:primary" },
        code: "missing_coverage" as const,
        references: [],
        explanation: "A second source is required.",
        suggestedAction: "add_follow_up" as const,
      }, {
        id: "defect:wording",
        severity: "minor" as const,
        target: { kind: "section" as const, id: "section:summary" },
        code: "overstated" as const,
        references: [],
        explanation: "The wording should be narrowed.",
        suggestedAction: "revise" as const,
      }],
      proposedFollowUps: [{
        id: "follow-up:evidence",
        defectId: "defect:needs-more-evidence",
        objective: "Read one additional admitted source.",
        reasonCode: "coverage_gap" as const,
        sourceIds: [],
      }, {
        id: "follow-up:orphan",
        defectId: "defect:wording",
        objective: "Rewrite the accepted wording.",
        reasonCode: "coverage_gap" as const,
        sourceIds: [],
      }],
    };

    const normalized = normalizeResearchReconciliationCandidateV1(candidate);

    expect(parseReconciliationBodyV1(normalized)).toEqual({
      ...candidate,
      proposedFollowUps: [candidate.proposedFollowUps[0]],
    });
    expect(candidate.proposedFollowUps).toHaveLength(2);
  });

  test("leaves malformed and duplicate bindings for strict validation", () => {
    const malformed = {
      schema: RESEARCH_RECONCILIATION_BODY_SCHEMA_V1,
      defects: [{ id: "defect:1", suggestedAction: "add_follow_up" }],
      proposedFollowUps: [{ id: "follow-up:1", defectId: 42 }],
    };
    expect(normalizeResearchReconciliationCandidateV1(malformed)).toBe(malformed);

    const duplicate = {
      schema: RESEARCH_RECONCILIATION_BODY_SCHEMA_V1,
      defects: [{
        id: "defect:1",
        severity: "important" as const,
        target: { kind: "coverage" as const, id: "coverage:primary" },
        code: "missing_coverage" as const,
        references: [],
        explanation: "More evidence is needed.",
        suggestedAction: "add_follow_up" as const,
      }],
      proposedFollowUps: [{
        id: "follow-up:1",
        defectId: "defect:1",
        objective: "Read another source.",
        reasonCode: "coverage_gap" as const,
        sourceIds: [],
      }, {
        id: "follow-up:2",
        defectId: "defect:1",
        objective: "Read another source again.",
        reasonCode: "coverage_gap" as const,
        sourceIds: [],
      }],
    };
    expect(() => parseReconciliationBodyV1(
      normalizeResearchReconciliationCandidateV1(duplicate),
    )).toThrow("defect bindings must be unique");
  });

  test("folds distinct material coverage proposals into the single repair slot", () => {
    const candidate = {
      schema: RESEARCH_RECONCILIATION_BODY_SCHEMA_V1,
      defects: ["commercial", "next-steps"].map((suffix) => ({
        id: `defect:${suffix}`,
        severity: "important" as const,
        target: { kind: "coverage" as const, id: "coverage:primary" },
        code: "missing_coverage" as const,
        references: [],
        explanation: `The ${suffix} facet is missing.`,
        suggestedAction: "add_follow_up" as const,
      })),
      proposedFollowUps: ["commercial", "next-steps"].map((suffix) => ({
        id: `follow-up:${suffix}`,
        defectId: `defect:${suffix}`,
        objective: `Recover the ${suffix} facet from approved exact evidence.`,
        reasonCode: "coverage_gap" as const,
        sourceIds: [],
      })),
    };

    const normalized = parseReconciliationBodyV1(
      normalizeResearchReconciliationCandidateV1(candidate),
    );

    expect(normalized.defects).toHaveLength(2);
    expect(normalized.proposedFollowUps).toEqual([{
      ...candidate.proposedFollowUps[0],
      objective: "Recover the commercial facet from approved exact evidence.; Recover the next-steps facet from approved exact evidence.",
    }]);
  });
});

describe("Jira focused-researcher acquisition", () => {
  test("reads approved exact context directly without search or ranking", async () => {
    const brief = createResearchBriefV1({
      sessionId: "research-session:bound-acquisition",
      turnId: "research-turn:bound-acquisition",
      objective: "Summarize the attached Confluence page.",
      scope: {
        siteOrigin: "https://example.atlassian.net",
        jiraProjectKeys: [],
        confluenceSpaceKeys: [],
      },
      scopeBindings: [{
        schema: "atlcli.research-scope-binding/v1",
        id: "scope-binding:bound-acquisition:12345",
        tenantOrigin: "https://example.atlassian.net",
        product: "confluence",
        entityKind: "page",
        entityRef: "page:12345",
        key: "12345",
        name: "Customer retention analysis",
        source: "exact_link",
        authority: "approved",
      }],
      asOf: "2026-08-03T00:00:00.000Z",
      timezone: "UTC",
      requestedEffort: "deep",
      requestedPlanApproval: "automatic",
      requestedReconciliation: "off",
    });
    const graph = composeResearchGraphV1(brief, {
      packetOutputSchema: RESEARCH_PACKET_BODY_SCHEMA_V2,
    });
    const anchors = [{
      anchorRef: "research-anchor:opaque-12345",
      product: "confluence" as const,
      entityKind: "page" as const,
      name: "Customer retention analysis",
    }];
    const wiki = compileDynamicResearchSubagents(graph, {
      model: fakeModel(),
      broker: { exactAnchors: () => anchors } as ResearchCapabilityBroker,
      question: brief.objective,
      maxInterpreterMs: DEFAULT_RESEARCH_LIMITS_V1.maxInterpreterMs,
      maxInterpreterMemoryBytes: DEFAULT_RESEARCH_LIMITS_V1.maxInterpreterMemoryBytes,
      maxPtcCalls: DEFAULT_RESEARCH_LIMITS_V1.maxPtcCalls,
      maxSearchPagesPerProduct: DEFAULT_RESEARCH_LIMITS_V1.maxSearchPagesPerProduct,
      maxDetailItemsPerProduct: DEFAULT_RESEARCH_LIMITS_V1.maxDetailItemsPerProduct,
      maxPacketChars: DEFAULT_RESEARCH_LIMITS_V1.maxPtcOutputBytes,
    }).find((subagent) => subagent.name.includes("wiki-research"));
    const wikiNode = graph.nodes.find((node) => node.id === "research-node:wiki-research");
    if (!wikiNode?.roleId) throw new Error("Expected exact Confluence research node.");

    expect(wiki?.systemPrompt).toContain("exact context");
    expect(wiki?.systemPrompt).toContain("Select at most 12 claimCandidates");
    expect(wiki?.systemPrompt).toContain("Keep each summary to one concise sentence");
    expect(RESEARCH_SUBAGENT_MODEL_MAX_OUTPUT_TOKENS_V1["focused-researcher"])
      .toBe(6_000);
    expect(wiki?.systemPrompt).toContain("tools.atlassianBoundRead");
    expect(wiki?.systemPrompt).not.toContain("tools.wikiSearch");
    expect(wiki?.systemPrompt).not.toContain("tools.researchCandidateRank");
    expect(responseSchemaForResearchNodeV1(wikiNode)).toBe(
      RESEARCH_EXACT_BOUND_PACKET_MODEL_BODY_JSON_SCHEMA_V2,
    );
    const completed = completeResearchNodeStructuredCandidateV1(wikiNode, {
      schema: RESEARCH_PACKET_BODY_SCHEMA_V2,
      claimCandidates: [],
      gaps: [],
      coverageLimits: [],
    });
    expect(completed).toEqual({
      schema: RESEARCH_PACKET_BODY_SCHEMA_V2,
      claimCandidates: [],
      contradictionCandidates: [],
      outlineProposals: [],
      gaps: [],
      proposedFollowUps: [],
      coverageLimits: [],
    });

    const program = buildResearchBoundAcquisitionProgramV1(anchors, 1)
      .replace("\n({ acquisition:", "\nreturn ({ acquisition:");
    const invoked: string[] = [];
    const projection = await (new Function(
      "tools",
      `return (async () => {${program}})();`,
    ) as (tools: unknown) => Promise<unknown>)({
      async atlassianBoundRead({ anchorRef }: { anchorRef: string }) {
        invoked.push(anchorRef);
        return JSON.stringify({
          source: {
            sourceId: "wiki:12345",
            product: "confluence",
            title: "Customer retention analysis",
            url: "https://example.atlassian.net/wiki/pages/12345",
            contentId: "12345",
          },
          content: {
            text: "The page contains one directly supported conclusion.",
            linkTargets: [],
            truncated: false,
          },
        });
      },
    }) as { acquisition: { kind: string; requestedCount: number; availableCount: number }; details: unknown[] };

    expect(invoked).toEqual(["research-anchor:opaque-12345"]);
    expect(projection.acquisition).toEqual({
      kind: "exact-bound-context",
      requestedCount: 1,
      availableCount: 1,
    });
    expect(projection.details).toHaveLength(1);
  });

  test("treats a fully read exact anchor as complete without inventing search warnings", async () => {
    const binding = {
      schema: "atlcli.research-scope-binding/v1" as const,
      id: "scope-binding:bound-completion:12345",
      tenantOrigin: "https://example.atlassian.net",
      product: "confluence" as const,
      entityKind: "page" as const,
      entityRef: "research-scope-entity:page-12345",
      key: "12345",
      name: "Customer retention analysis",
      source: "exact_link" as const,
      authority: "approved" as const,
    };
    const broker = new ResearchCapabilityBroker({
      schema: RESEARCH_REQUEST_SCHEMA_V1,
      question: "Summarize the exact page.",
      scope: {
        siteOrigin: "https://example.atlassian.net",
        jiraProjectKeys: [],
        confluenceSpaceKeys: [],
      },
      limits: DEFAULT_RESEARCH_LIMITS_V1,
      wikiProvider: "rest",
    }, {
      jira: {
        async searchPage() { throw new Error("jira search must not run"); },
        async getIssue() { throw new Error("jira detail must not run"); },
      },
      wiki: {
        async searchPage() { throw new Error("wiki search must not run"); },
        async getPage({ contentId }) {
          return {
            contentId,
            spaceKey: "DOCS",
            title: "Customer retention analysis",
            content: {
              text: "The exact page contains supported content.",
              linkTargets: [],
              truncated: false,
              inputBytes: 42,
            },
          };
        },
      },
    }, {
      scopeBindings: [binding],
      createAnchorId: () => "opaque-12345",
    });
    expect(broker.completionStatus(["confluence"]).complete).toBe(false);
    const [anchor] = broker.exactAnchors();
    await broker.readExactAnchor({
      schema: BOUND_ENTITY_READ_INPUT_SCHEMA_V1,
      anchorRef: anchor!.anchorRef,
    });
    expect(broker.completionStatus(["confluence"])).toEqual({
      complete: true,
      warnings: [],
    });
  });

  test("uses one host-generated program with one candidate-ranking stage", () => {
    const brief = createResearchBriefV1({
      sessionId: "research-session:jira-acquisition",
      turnId: "research-turn:jira-acquisition",
      objective: "Which Jira work items explicitly link to the selected Confluence page?",
      scope: {
        siteOrigin: "https://example.atlassian.net",
        jiraProjectKeys: ["DEMO"],
        confluenceSpaceKeys: [],
      },
      asOf: "2026-08-03T00:00:00.000Z",
      timezone: "UTC",
      requestedEffort: "lookup",
      requestedPlanApproval: "automatic",
      requestedReconciliation: "off",
    });
    const graph = composeResearchGraphV1(brief, {
      packetOutputSchema: RESEARCH_PACKET_BODY_SCHEMA_V2,
    });
    const jira = compileDynamicResearchSubagents(graph, {
      model: fakeModel(),
      broker: {} as ResearchCapabilityBroker,
      question: brief.objective,
      maxInterpreterMs: DEFAULT_RESEARCH_LIMITS_V1.maxInterpreterMs,
      maxInterpreterMemoryBytes: DEFAULT_RESEARCH_LIMITS_V1.maxInterpreterMemoryBytes,
      maxPtcCalls: DEFAULT_RESEARCH_LIMITS_V1.maxPtcCalls,
      maxSearchPagesPerProduct: DEFAULT_RESEARCH_LIMITS_V1.maxSearchPagesPerProduct,
      maxDetailItemsPerProduct: DEFAULT_RESEARCH_LIMITS_V1.maxDetailItemsPerProduct,
      maxPacketChars: DEFAULT_RESEARCH_LIMITS_V1.maxPtcOutputBytes,
    }).find((subagent) => subagent.name.includes("jira-lookup"));

    expect(jira?.systemPrompt).toContain("single host-generated bounded program");
    expect(jira?.systemPrompt).toContain("Do not call eval a second time");
    expect(jira?.systemPrompt).toContain("Select at most 6 claimCandidates");
    expect(jira?.systemPrompt).toContain("exact detail quotes of at most 280 characters");
    expect(jira?.systemPrompt).not.toContain("exactly two bounded stages");
    expect(jira?.systemPrompt).not.toContain("Stage 2 — read evidence");
    expect(jira?.middleware?.slice(0, 2).map((entry) => entry.name)).toEqual([
      "PromptCachingMiddleware",
      "CacheBreakpointMiddleware",
    ]);
    expect(
      new Set(jira?.middleware?.slice(0, 2).map((entry) => entry.name)).size,
    ).toBe(2);

    const program = buildResearchAcquisitionProgram(
      (graph.nodes.find((node) => node.id === "research-node:jira-lookup"))!,
      brief.objective,
      8,
      4,
    );
    expect(program).toContain("const result = await collect(search)");
    expect(program).toContain("const ranked = entityRefs.length === 0");
    expect(program).toContain("ranked.items.slice(0, 8)");
    expect(program).toContain("for (const item of detailItems) rawDetails.push(await readDetail");
    expect(program).not.toContain("Promise.all(detailItems.map");
    expect(program).toContain("const details = rawDetails.map(projectDetailForModel)");
    expect(jira?.systemPrompt).toContain("bounded host projection for every full detail read");
    expect(jira?.systemPrompt).toContain("content.truncated and content.projectionTruncated are both false");
    expect(program.match(/tools\.researchCandidateRank/g)).toHaveLength(1);
  });

  test("fairly splits the shared acquisition ceiling across Jira and Confluence branches", () => {
    const brief = createResearchBriefV1({
      sessionId: "research-session:fair-acquisition",
      turnId: "research-turn:fair-acquisition",
      objective: "Relate the current Jira work to Confluence documentation.",
      scope: {
        siteOrigin: "https://example.atlassian.net",
        jiraProjectKeys: ["DEMO"],
        confluenceSpaceKeys: ["DOCS"],
      },
      asOf: "2026-08-03T00:00:00.000Z",
      timezone: "UTC",
      requestedEffort: "deep",
      requestedPlanApproval: "automatic",
      requestedReconciliation: "off",
      limits: { ...DEFAULT_RESEARCH_LIMITS_V1, maxPtcCalls: 80 },
    });
    const graph = composeResearchGraphV1(brief, {
      packetOutputSchema: RESEARCH_PACKET_BODY_SCHEMA_V2,
    });
    const subagents = compileDynamicResearchSubagents(graph, {
      model: fakeModel(),
      broker: {} as ResearchCapabilityBroker,
      question: brief.objective,
      maxInterpreterMs: DEFAULT_RESEARCH_LIMITS_V1.maxInterpreterMs,
      maxInterpreterMemoryBytes: DEFAULT_RESEARCH_LIMITS_V1.maxInterpreterMemoryBytes,
      maxPtcCalls: 80,
      maxSearchPagesPerProduct: 10,
      maxDetailItemsPerProduct: 50,
      maxPacketChars: DEFAULT_RESEARCH_LIMITS_V1.maxPtcOutputBytes,
    });
    const jira = subagents.find((subagent) => subagent.name.includes("jira-research"));
    const wiki = subagents.find((subagent) => subagent.name.includes("wiki-research"));

    // The 80-call run ceiling is divided across the two workers before their
    // host-generated programs reserve ranking and serial detail reads.
    expect(jira?.systemPrompt).toContain("searchCalls < 4");
    expect(jira?.systemPrompt).toContain("ranked.items.slice(0, 35)");
    expect(wiki?.systemPrompt).toContain("searchCalls < 10");
    expect(wiki?.systemPrompt).toContain("ranked.items.slice(0, 29)");
  });

  test("reads every ranked detail serially while returning a bounded projection to the model", async () => {
    const brief = createResearchBriefV1({
      sessionId: "research-session:projection",
      turnId: "research-turn:projection",
      objective: "Which Jira work items cite the ‘Delivery Plan’ for DEMO-42?",
      scope: {
        siteOrigin: "https://example.atlassian.net",
        jiraProjectKeys: ["DEMO"],
        confluenceSpaceKeys: [],
      },
      asOf: "2026-08-03T00:00:00.000Z",
      timezone: "UTC",
      requestedEffort: "lookup",
      requestedPlanApproval: "automatic",
      requestedReconciliation: "off",
    });
    const graph = composeResearchGraphV1(brief, {
      packetOutputSchema: RESEARCH_PACKET_BODY_SCHEMA_V2,
    });
    const program = buildResearchAcquisitionProgram(
      graph.nodes.find((node) => node.id === "research-node:jira-lookup")!,
      brief.objective,
      2,
      1,
    ).replace("\n({ search:", "\nreturn ({ search:");
    const detailOrder: string[] = [];
    const tools = {
      async jiraIssueSearch() {
        return JSON.stringify({
          items: ["DEMO-42", "DEMO-43"].map((issueKey) => ({
            entityRef: `opaque:${issueKey}`,
            sourceId: `jira:${issueKey}`,
            product: "jira",
            title: `Issue ${issueKey}`,
            url: `https://example.atlassian.net/browse/${issueKey}`,
            issueKey,
            projectKey: "DEMO",
          })),
          page: { complete: true },
        });
      },
      async researchCandidateRank() {
        return JSON.stringify({
          items: ["DEMO-42", "DEMO-43"].map((issueKey) => ({
            entityRef: `opaque:${issueKey}`,
          })),
        });
      },
      async jiraIssueGet({ entityRef }: { entityRef: string }) {
        const issueKey = entityRef.slice("opaque:".length);
        detailOrder.push(issueKey);
        return JSON.stringify({
          source: {
            sourceId: `jira:${issueKey}`,
            product: "jira",
            title: `Issue ${issueKey}`,
            url: `https://example.atlassian.net/browse/${issueKey}`,
            issueKey,
            projectKey: "DEMO",
          },
          content: {
            text: `${"filler\n".repeat(250)}Delivery Plan directly names ${issueKey}.`,
            linkTargets: Array.from({ length: 6 }, (_, index) => `https://example.atlassian.net/wiki/pages/${index}`),
            truncated: false,
          },
        });
      },
    };
    const invoke = new Function("tools", `return (async () => {${program}})();`) as (
      tools: unknown,
    ) => Promise<unknown>;
    const projection = await invoke(tools) as {
      candidates: Array<Record<string, unknown>>;
      details: Array<{
        status: string;
        source: { sourceId: string };
        content: { text: string; linkTargets: string[]; linkTargetsTruncated: boolean };
      }>;
    };

    expect(detailOrder).toEqual(["DEMO-42", "DEMO-43"]);
    expect(projection.candidates).toHaveLength(2);
    expect(projection.candidates[0]).not.toHaveProperty("entityRef");
    expect(projection.details).toHaveLength(2);
    expect(projection.details[0]).toMatchObject({
      status: "available",
      source: { sourceId: "jira:DEMO-42" },
      content: { linkTargetsTruncated: true },
    });
    expect(projection.details[0]!.content.linkTargets).toHaveLength(4);
    expect(projection.details[0]!.content.text).toContain("Delivery Plan directly names DEMO-42.");
    expect(projection.details[0]!.content.text).toContain("filler\nfiller");
    expect(projection.details[0]!.content.text.length).toBeLessThanOrEqual(1_200);
  });

  test("projects one complete bounded detail body instead of only its opening excerpt", async () => {
    const brief = createResearchBriefV1({
      sessionId: "research-session:single-detail-projection",
      turnId: "research-turn:single-detail-projection",
      objective: "Summarize the attached Confluence page.",
      scope: {
        siteOrigin: "https://example.atlassian.net",
        jiraProjectKeys: [],
        confluenceSpaceKeys: ["DOCSY"],
      },
      asOf: "2026-08-03T00:00:00.000Z",
      timezone: "UTC",
      requestedEffort: "lookup",
      requestedPlanApproval: "automatic",
      requestedReconciliation: "off",
    });
    const graph = composeResearchGraphV1(brief, {
      packetOutputSchema: RESEARCH_PACKET_BODY_SCHEMA_V2,
    });
    const program = buildResearchAcquisitionProgram(
      graph.nodes.find((node) => node.id === "research-node:wiki-lookup")!,
      brief.objective,
      1,
      1,
    ).replace("\n({ search:", "\nreturn ({ search:");
    const completeBody = `${"Introductory context.\n".repeat(180)}The final section contains the decisive supported conclusion.`;
    const invoke = new Function("tools", `return (async () => {${program}})();`) as (
      tools: unknown,
    ) => Promise<unknown>;
    const projection = await invoke({
      async wikiSearch() {
        return JSON.stringify({
          items: [{
            entityRef: "opaque:12345",
            sourceId: "wiki:12345",
            product: "confluence",
            title: "Customer retention analysis",
            url: "https://example.atlassian.net/wiki/spaces/DOCSY/pages/12345",
            contentId: "12345",
            spaceKey: "DOCSY",
          }],
          page: { complete: true },
        });
      },
      async researchCandidateRank() {
        return JSON.stringify({ items: [{ entityRef: "opaque:12345" }] });
      },
      async wikiPageGet() {
        return JSON.stringify({
          source: {
            sourceId: "wiki:12345",
            product: "confluence",
            title: "Customer retention analysis",
            url: "https://example.atlassian.net/wiki/spaces/DOCSY/pages/12345",
            contentId: "12345",
            spaceKey: "DOCSY",
          },
          content: { text: completeBody, linkTargets: [], truncated: false },
        });
      },
    }) as {
      details: Array<{
        content: {
          text: string;
          linkTargets: string[];
          linkTargetsTruncated: boolean;
          truncated: boolean;
          projectionTruncated: boolean;
        };
      }>;
    };

    expect(projection.details[0]!.content).toEqual({
      text: completeBody,
      linkTargets: [],
      linkTargetsTruncated: false,
      truncated: false,
      projectionTruncated: false,
    });
    expect(projection.details[0]!.content.text.length).toBeGreaterThan(1_200);
    expect(projection.details[0]!.content.text).toContain("decisive supported conclusion");
  });

  test("caps concurrent PTC calls at the host-admitted node budget", async () => {
    let invoked = 0;
    const source = tool(async () => {
      invoked += 1;
      return "ok";
    }, {
      name: "read",
      description: "Synthetic read.",
      schema: z.object({}),
    });
    const [bounded] = boundResearchNodePtcToolsV1([source], 2, "research-node:bounded");
    const outcomes = await Promise.allSettled([
      bounded!.invoke({}),
      bounded!.invoke({}),
      bounded!.invoke({}),
    ]);

    expect(invoked).toBe(2);
    expect(outcomes.map((outcome) => outcome.status)).toEqual([
      "fulfilled",
      "fulfilled",
      "rejected",
    ]);
  });

  test("removes eval after the one permitted acquisition result", async () => {
    const brief = createResearchBriefV1({
      sessionId: "research-session:single-eval",
      turnId: "research-turn:single-eval",
      objective: "Which Jira work items explicitly link to the selected Confluence page?",
      scope: {
        siteOrigin: "https://example.atlassian.net",
        jiraProjectKeys: ["DEMO"],
        confluenceSpaceKeys: [],
      },
      asOf: "2026-08-03T00:00:00.000Z",
      timezone: "UTC",
      requestedEffort: "lookup",
      requestedPlanApproval: "automatic",
      requestedReconciliation: "off",
    });
    const graph = composeResearchGraphV1(brief, {
      packetOutputSchema: RESEARCH_PACKET_BODY_SCHEMA_V2,
    });
    const worker = compileDynamicResearchSubagents(graph, {
      model: fakeModel(),
      broker: {} as ResearchCapabilityBroker,
      question: brief.objective,
      maxInterpreterMs: DEFAULT_RESEARCH_LIMITS_V1.maxInterpreterMs,
      maxInterpreterMemoryBytes: DEFAULT_RESEARCH_LIMITS_V1.maxInterpreterMemoryBytes,
      maxPtcCalls: DEFAULT_RESEARCH_LIMITS_V1.maxPtcCalls,
      maxSearchPagesPerProduct: DEFAULT_RESEARCH_LIMITS_V1.maxSearchPagesPerProduct,
      maxDetailItemsPerProduct: DEFAULT_RESEARCH_LIMITS_V1.maxDetailItemsPerProduct,
      maxPacketChars: DEFAULT_RESEARCH_LIMITS_V1.maxPtcOutputBytes,
    }).find((subagent) => subagent.name.includes("jira-lookup"));
    const middleware = worker?.middleware?.find((candidate) =>
      candidate.name === "ResearchCompletedEvalNoPtcMiddleware"
    );
    expect(middleware?.wrapModelCall).toBeDefined();
    let observed: unknown;
    await middleware!.wrapModelCall!({
      messages: [new ToolMessage({ content: "acquired", tool_call_id: "eval:1", name: "eval" })],
      tools: [{ name: "eval" }, { name: "ResearchPacketBodyV2" }],
      systemMessage: { concat: (value: string) => value },
    } as never, async (request) => {
      observed = request;
      return {} as never;
    });

    expect(observed).toMatchObject({
      tools: [{ name: "ResearchPacketBodyV2" }],
      systemMessage: "The one permitted acquisition eval has completed. Source reads are now unavailable. Do not write prose or call eval. Call exactly one remaining host response tool (ResearchPacketBodyV2) with the schema-valid result derived solely from the completed acquisition.",
    });
  });
});
