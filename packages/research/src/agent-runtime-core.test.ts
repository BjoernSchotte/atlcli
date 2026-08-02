import { describe, expect, test } from "bun:test";
import { AIMessage, ToolMessage } from "@langchain/core/messages";
import { tool } from "@langchain/core/tools";
import { z } from "zod/v4";
import {
  buildLegacyResearchSystemPromptV1,
  createOneShotSupervisorEvalMiddleware,
  createResearchGraphProposalPtcTool,
  createResearchGraphRevisionPtcTool,
  createResearchRetrievalContinuationPtcTool,
  createResearchRetrievalCheckpointPtcTool,
  createResearchReadyFrontierPtcTool,
  hostSearchCoverageLimitationsV1,
} from "./agent-runtime-core.js";
import { createResearchBriefV1 } from "./brief.js";
import { acceptResearchGraphProposalV1, composeResearchGraphV1 } from "./graph.js";
import {
  researchSubagentTypeForNodeV1,
  researchTaskIdForNodeV1,
} from "./dynamic-subagents.js";
import { assessResearchRetrievalV1 } from "./retrieval-assessment.js";
import {
  RESEARCH_SESSION_RETRIEVAL_ASSESSMENT_SCHEMA_V1,
  RESEARCH_SESSION_RETRIEVAL_CONTINUATION_SCHEMA_V1,
} from "./session.js";

const evalTool = tool(async () => "unused", {
  name: "eval",
  description: "Synthetic one-shot eval.",
  schema: z.object({ code: z.string() }),
});
const draftTool = tool(async () => "unused", {
  name: "AtlcliResearchAgentDraftV1",
  description: "Synthetic structured response.",
  schema: z.object({ title: z.string() }),
});

const validWorkflowCode = `
  const accepted = JSON.parse(await tools.researchGraphPropose({}));
  const finalDraft = await task({
    description: "synthetic",
    subagentType: "synthesizer",
    responseSchema: {}
  });
  finalDraft;
`;

const continuationWorkflowCode = `
  const continuation = JSON.parse(await tools.researchRetrievalContinue({
    graphRevision: 1,
    wave: 1,
    continuationId: "research-continuation:1.1"
  }));
  const finalDraft = await task({
    description: "synthetic continuation",
    subagentType: "synthesizer",
    responseSchema: {}
  });
  finalDraft;
`;

const checkpointWorkflowCode = `
  const accepted = JSON.parse(await tools.researchGraphPropose({}));
  const checkpoint = JSON.parse(await tools.researchRetrievalCheckpoint({
    graphRevision: accepted.graphRevision
  }));
  checkpoint;
`;

async function observeOfferedTools(
  middleware: ReturnType<typeof createOneShotSupervisorEvalMiddleware>,
): Promise<string[]> {
  let offered: string[] = [];
  await middleware.wrapModelCall!(
    { tools: [evalTool, draftTool] } as never,
    async (request) => {
      offered = request.tools.map((candidate) => String(candidate.name));
      return new AIMessage("done");
    },
  );
  return offered;
}

async function completeEval(
  middleware: ReturnType<typeof createOneShotSupervisorEvalMiddleware>,
  content: string,
  code = validWorkflowCode,
): Promise<void> {
  await middleware.wrapToolCall!(
    {
      toolCall: { id: "tool-call:eval", name: "eval", args: { code } },
      tool: evalTool,
    } as never,
    async () => new ToolMessage({
      content,
      tool_call_id: "tool-call:eval",
      name: "eval",
    }),
  );
}

describe("one-shot supervisor eval capability lifecycle", () => {
  test("revokes eval after one successful workflow but preserves structured publication", async () => {
    const middleware = createOneShotSupervisorEvalMiddleware();
    expect(await observeOfferedTools(middleware)).toEqual([
      "eval",
      "AtlcliResearchAgentDraftV1",
    ]);

    await completeEval(middleware, JSON.stringify({ title: "Accepted draft" }));

    expect(await observeOfferedTools(middleware)).toEqual([
      "AtlcliResearchAgentDraftV1",
    ]);
  });

  test("keeps eval available for the one pre-dispatch repair after a failed workflow", async () => {
    const middleware = createOneShotSupervisorEvalMiddleware({
      canRetryAfterFailure: () => true,
    });
    await completeEval(middleware, "Error: synthetic compile failure");
    expect(await observeOfferedTools(middleware)).toEqual([
      "eval",
      "AtlcliResearchAgentDraftV1",
    ]);
  });

  test("permits exactly one checkpoint-authorized continuation without a second graph proposal", async () => {
    let tickets = 1;
    let continuationEvalStarts = 0;
    const middleware = createOneShotSupervisorEvalMiddleware({
      canContinueAfterCheckpoint: () => tickets > 0,
      onContinuationEvalStarted: () => { continuationEvalStarts += 1; },
    });
    await completeEval(middleware, JSON.stringify({
      schema: "atlcli.research-retrieval-checkpoint/v1",
      graphRevision: 1,
      wave: 1,
      action: "stop",
      reason: "no_ranked_candidates",
      continuationId: "research-continuation:1.1",
    }), checkpointWorkflowCode);
    expect(await observeOfferedTools(middleware)).toEqual([
      "eval",
      "AtlcliResearchAgentDraftV1",
    ]);
    await completeEval(middleware, JSON.stringify({ title: "Final" }), continuationWorkflowCode);
    expect(tickets).toBe(1);
    expect(continuationEvalStarts).toBe(1);
    // The real continuation PTC, not the eval middleware, atomically consumes
    // this ticket before it dispatches any later frontier.
    tickets = 0;
    expect(await observeOfferedTools(middleware)).toEqual([
      "AtlcliResearchAgentDraftV1",
    ]);
  });

  test("rejects a detached async workflow before dispatch and permits one direct repair", async () => {
    const diagnostics: Array<{ attempt: number; status: string; errorCode?: string }> = [];
    const persistedWorkflows: string[] = [];
    const middleware = createOneShotSupervisorEvalMiddleware({
      canRetryAfterFailure: () => true,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
      onWorkflowCode: async (_attempt, code) => { persistedWorkflows.push(code); },
    });
    const detachedWorkflow = `
      (async () => {
        const accepted = JSON.parse(await tools.researchGraphPropose({}));
        const finalDraft = await task({ description: "synthetic" });
        return finalDraft;
      })();
      finalDraft;
    `;
    let evaluatorCalls = 0;
    const result = await middleware.wrapToolCall!(
      {
        toolCall: { id: "tool-call:eval", name: "eval", args: { code: detachedWorkflow } },
        tool: evalTool,
      } as never,
      async () => {
        evaluatorCalls += 1;
        return new ToolMessage({
          content: "unexpected",
          tool_call_id: "tool-call:eval",
          name: "eval",
        });
      },
    );

    expect(evaluatorCalls).toBe(0);
    expect(result).toBeInstanceOf(ToolMessage);
    expect((result as ToolMessage).content).toContain("Do not wrap the workflow in an async IIFE");
    expect(persistedWorkflows).toEqual([]);
    expect(diagnostics).toContainEqual(expect.objectContaining({
      attempt: 1,
      status: "failed",
      errorCode: "invalid-workflow-control-flow",
    }));
    expect(await observeOfferedTools(middleware)).toEqual([
      "eval",
      "AtlcliResearchAgentDraftV1",
    ]);

    await completeEval(middleware, JSON.stringify({ title: "Repaired" }));
    expect(persistedWorkflows).toEqual([validWorkflowCode]);
    expect(await observeOfferedTools(middleware)).toEqual([
      "AtlcliResearchAgentDraftV1",
    ]);
  });

  test("permits documented task result mapping and rejects generic defect-code repair maps", async () => {
    const middleware = createOneShotSupervisorEvalMiddleware({
      canRetryAfterFailure: () => true,
    });
    const mappedTaskContinuation = validWorkflowCode.replace(
      "finalDraft;",
      "const mapped = await Promise.all([task({ description: \"extra\" }).then(() => undefined)]);\n      finalDraft;",
    );
    let evaluatorCalls = 0;
    const accepted = await middleware.wrapToolCall!(
      {
        toolCall: { id: "tool-call:eval", name: "eval", args: { code: mappedTaskContinuation } },
        tool: evalTool,
      } as never,
      async () => {
        evaluatorCalls += 1;
        return new ToolMessage({ content: "accepted", tool_call_id: "tool-call:eval", name: "eval" });
      },
    );
    expect(evaluatorCalls).toBe(1);
    expect((accepted as ToolMessage).content).toBe("accepted");

    const repairMiddleware = createOneShotSupervisorEvalMiddleware({
      canRetryAfterFailure: () => true,
    });
    const repairMap = validWorkflowCode.replace(
      "finalDraft;",
      "const codeToReasonCode = {};\n      finalDraft;",
    );
    const rejectedRepair = await repairMiddleware.wrapToolCall!(
      {
        toolCall: { id: "tool-call:eval:repair", name: "eval", args: { code: repairMap } },
        tool: evalTool,
      } as never,
      async () => {
        evaluatorCalls += 1;
        return new ToolMessage({ content: "unexpected", tool_call_id: "tool-call:eval:repair", name: "eval" });
      },
    );
    expect(evaluatorCalls).toBe(1);
    expect((rejectedRepair as ToolMessage).content).toContain("Do not derive repairFollowUpId");
  });
});

describe("durable retrieval checkpoint PTC", () => {
  test("derives and persists a body-free continuation lease without model-selected control flow", async () => {
    const brief = createResearchBriefV1({
      sessionId: "research-session:checkpoint-tool",
      turnId: "research-turn:checkpoint-tool",
      objective: "Research a bounded Jira question.",
      scope: {
        siteOrigin: "https://example.atlassian.net",
        jiraProjectKeys: ["DEMO"],
        confluenceSpaceKeys: [],
      },
      asOf: "2026-08-01T10:00:00.000Z",
      timezone: "UTC",
      requestedPlanApproval: "automatic",
      requestedReconciliation: "off",
    });
    const graph = composeResearchGraphV1(brief);
    const assessment = assessResearchRetrievalV1({
      products: [{
        product: "jira",
        rankedSourceIds: ["jira:DEMO-1", "jira:DEMO-2"],
        detailedSourceIds: ["jira:DEMO-1"],
        searchAttempted: true,
        searchComplete: true,
        canSearchMore: false,
        canReadMoreDetails: true,
      }],
      ptcCallsRemaining: 2,
      httpAttemptsRemaining: 2,
    });
    let recordedInput: unknown;
    const checkpointTool = createResearchRetrievalCheckpointPtcTool({
      activeGraph: () => graph,
      canCheckpoint: () => true,
      assess: () => assessment,
      record: async (input) => {
        recordedInput = input;
        return {
          schema: RESEARCH_SESSION_RETRIEVAL_ASSESSMENT_SCHEMA_V1,
          graphRevision: graph.revision,
          wave: 1,
          assessment,
          continuation: {
            schema: RESEARCH_SESSION_RETRIEVAL_CONTINUATION_SCHEMA_V1,
            id: `research-continuation:${graph.revision}.1`,
            status: "issued",
            issuedAt: "2026-08-01T10:00:01.000Z",
          },
          recordedAt: "2026-08-01T10:00:01.000Z",
          graph,
        };
      },
    });

    const projected = JSON.parse(await checkpointTool.invoke({ graphRevision: graph.revision }));
    expect(recordedInput).toEqual({
      graphRevision: graph.revision,
      assessment,
      issueContinuation: true,
    });
    expect(projected).toEqual({
      schema: "atlcli.research-retrieval-checkpoint/v1",
      graphRevision: graph.revision,
      wave: 1,
      action: "continue",
      reason: "unread_ranked_candidates",
      continuationId: `research-continuation:${graph.revision}.1`,
    });
    expect(JSON.stringify(projected)).not.toContain("DEMO-1");
  });

  test("rejects premature checkpoints and issues a finalization lease for stop", async () => {
    const brief = createResearchBriefV1({
      sessionId: "research-session:checkpoint-stop",
      turnId: "research-turn:checkpoint-stop",
      objective: "Research a bounded Jira question.",
      scope: {
        siteOrigin: "https://example.atlassian.net",
        jiraProjectKeys: ["DEMO"],
        confluenceSpaceKeys: [],
      },
      asOf: "2026-08-01T10:00:00.000Z",
      timezone: "UTC",
      requestedPlanApproval: "automatic",
      requestedReconciliation: "off",
    });
    const graph = composeResearchGraphV1(brief);
    const assessment = assessResearchRetrievalV1({
      products: [{
        product: "jira",
        rankedSourceIds: [],
        detailedSourceIds: [],
        searchAttempted: true,
        searchComplete: true,
        canSearchMore: false,
        canReadMoreDetails: false,
      }],
      ptcCallsRemaining: 0,
      httpAttemptsRemaining: 0,
    });
    const premature = createResearchRetrievalCheckpointPtcTool({
      activeGraph: () => graph,
      canCheckpoint: () => false,
      assess: () => assessment,
      record: async () => { throw new Error("must not persist"); },
    });
    await expect(premature.invoke({ graphRevision: graph.revision })).rejects.toThrow("checkpoint boundary");

    let input: { issueContinuation: boolean } | undefined;
    const terminal = createResearchRetrievalCheckpointPtcTool({
      activeGraph: () => graph,
      canCheckpoint: () => true,
      assess: () => assessment,
      record: async (record) => {
        input = record;
        return {
          schema: RESEARCH_SESSION_RETRIEVAL_ASSESSMENT_SCHEMA_V1,
          graphRevision: graph.revision,
          wave: 1,
          assessment,
          continuation: {
            schema: RESEARCH_SESSION_RETRIEVAL_CONTINUATION_SCHEMA_V1,
            id: `research-continuation:${graph.revision}.1`,
            status: "issued",
            issuedAt: "2026-08-01T10:00:01.000Z",
          },
          recordedAt: "2026-08-01T10:00:01.000Z",
          graph,
        };
      },
    });
    expect(JSON.parse(await terminal.invoke({ graphRevision: graph.revision }))).toMatchObject({
      action: "stop",
      reason: "no_ranked_candidates",
      continuationId: `research-continuation:${graph.revision}.1`,
    });
    expect(input).toEqual(expect.objectContaining({ issueContinuation: true }));
  });

  test("consumes one host-issued continuation and exposes only its decision", async () => {
    const brief = createResearchBriefV1({
      sessionId: "research-session:continuation-tool",
      turnId: "research-turn:continuation-tool",
      objective: "Research a bounded Jira question.",
      scope: {
        siteOrigin: "https://example.atlassian.net",
        jiraProjectKeys: ["DEMO"],
        confluenceSpaceKeys: [],
      },
      asOf: "2026-08-01T10:00:00.000Z",
      timezone: "UTC",
      requestedPlanApproval: "automatic",
      requestedReconciliation: "off",
    });
    const graph = composeResearchGraphV1(brief);
    const assessment = assessResearchRetrievalV1({
      products: [{
        product: "jira",
        rankedSourceIds: [],
        detailedSourceIds: [],
        searchAttempted: true,
        searchComplete: true,
        canSearchMore: false,
        canReadMoreDetails: false,
      }],
      ptcCallsRemaining: 0,
      httpAttemptsRemaining: 0,
    });
    let consumeCalls = 0;
    const continuation = createResearchRetrievalContinuationPtcTool({
      activeGraph: () => graph,
      consume: async () => {
        consumeCalls += 1;
        return {
          schema: RESEARCH_SESSION_RETRIEVAL_CONTINUATION_SCHEMA_V1,
          id: `research-continuation:${graph.revision}.1`,
          status: "consumed",
          issuedAt: "2026-08-01T10:00:01.000Z",
          consumedAt: "2026-08-01T10:00:02.000Z",
          graph,
          assessment,
        };
      },
    });

    const projected = JSON.parse(await continuation.invoke({
      graphRevision: graph.revision,
      wave: 1,
      continuationId: `research-continuation:${graph.revision}.1`,
    }));
    expect(projected).toEqual({
      schema: "atlcli.research-retrieval-continuation/v1",
      graphRevision: graph.revision,
      wave: 1,
      action: "stop",
      reason: "no_ranked_candidates",
    });
    expect(consumeCalls).toBe(1);
    expect(JSON.stringify(projected)).not.toContain("DEMO");
  });
});

describe("ready frontier PTC", () => {
  test("returns only one bounded task group with accepted compact dependencies", async () => {
    const brief = createResearchBriefV1({
      sessionId: "research-session:frontier-tool",
      turnId: "research-turn:frontier-tool",
      objective: "Research a bounded Jira question.",
      scope: {
        siteOrigin: "https://example.atlassian.net",
        jiraProjectKeys: ["DEMO"],
        confluenceSpaceKeys: [],
      },
      asOf: "2026-08-01T10:00:00.000Z",
      timezone: "UTC",
      requestedPlanApproval: "automatic",
      requestedReconciliation: "off",
    });
    const graph = composeResearchGraphV1(brief);
    const node = graph.nodes.find((candidate) =>
      candidate.status === "ready" && candidate.roleId === "focused-researcher"
    )!;
    const frontier = createResearchReadyFrontierPtcTool({
      activeGraph: () => graph,
      canRead: () => true,
      frontier: () => [{
        taskId: researchTaskIdForNodeV1(graph, node),
        nodeId: node.id,
        roleId: "focused-researcher",
        subagentType: researchSubagentTypeForNodeV1(node),
        outputSchema: node.outputSchema,
        objective: node.objective,
        dependencyResults: [],
      }],
    });

    const projected = JSON.parse(await frontier.invoke({ graphRevision: graph.revision }));
    expect(projected).toEqual({
      schema: "atlcli.research-ready-frontier/v1",
      graphRevision: graph.revision,
      tasks: [expect.objectContaining({
        taskId: researchTaskIdForNodeV1(graph, node),
        dependencyResults: [],
      })],
    });
    await expect(createResearchReadyFrontierPtcTool({
      activeGraph: () => graph,
      canRead: () => false,
      frontier: () => [],
    }).invoke({ graphRevision: graph.revision })).rejects.toThrow("not available");
  });
});

describe("durable graph revision PTC", () => {
  test("persists a host-validated catalog revision without exposing causal evidence or gaps", async () => {
    const brief = createResearchBriefV1({
      sessionId: "research-session:revision-tool",
      turnId: "research-turn:revision-tool",
      objective: "Which Confluence pages are related to Jira tickets?",
      scope: {
        siteOrigin: "https://example.atlassian.net",
        jiraProjectKeys: ["DEMO"],
        confluenceSpaceKeys: ["DOCS"],
      },
      asOf: "2026-08-01T10:00:00.000Z",
      timezone: "UTC",
      requestedPlanApproval: "automatic",
      requestedReconciliation: "off",
    });
    const catalog = composeResearchGraphV1(brief);
    const initialIds = new Set([
      "research-node:jira-research",
      "research-node:wiki-research",
      "research-node:synthesizer",
    ]);
    const initial = acceptResearchGraphProposalV1(catalog, {
      schema: "atlcli.research-graph-proposal/v1",
      basedOnBriefRevision: catalog.basedOnBriefRevision,
      basedOnGraphRevision: catalog.revision,
      nodes: catalog.nodes.filter((node) => initialIds.has(node.id)).map((node) => ({
        nodeId: node.id,
        dependencies: node.dependencies.filter((dependency) => initialIds.has(dependency)),
        reasonCodes: node.reasonCodes,
      })),
    });
    const revisedIds = new Set([...initialIds, "research-node:cross-product-join"]);
    const revision = {
      basedOnBriefRevision: initial.basedOnBriefRevision,
      basedOnGraphRevision: initial.revision,
      nodes: catalog.nodes.filter((node) => revisedIds.has(node.id)).map((node) => ({
        nodeId: node.id,
        dependencies: node.dependencies.filter((dependency) => revisedIds.has(dependency)),
        reasonCodes: node.reasonCodes,
        priority: node.id === "research-node:cross-product-join" ? 71 : node.priority,
      })),
      prune: [],
    };
    let persistedInput: unknown;
    const revisionTool = createResearchGraphRevisionPtcTool(catalog, {
      activeGraph: () => initial,
      canRevise: () => true,
      evidenceIds: () => ["evidence:host-coverage-1"],
      gapIds: () => ["gap:host-coverage-1"],
      reason: () => "coverage_gap",
      apply: async (input) => {
        persistedInput = input;
        return input.graph;
      },
    });

    const projected = JSON.parse(await revisionTool.invoke(revision));

    expect(persistedInput).toEqual(expect.objectContaining({
      evidenceIds: ["evidence:host-coverage-1"],
      gapIds: ["gap:host-coverage-1"],
      reason: "coverage_gap",
      graph: expect.objectContaining({ revision: initial.revision + 1 }),
    }));
    expect(projected).toEqual(expect.objectContaining({
      schema: "atlcli.accepted-research-graph-revision/v1",
      graphRevision: initial.revision + 1,
      addedNodeIds: ["research-node:cross-product-join"],
      prunedNodeIds: [],
    }));
    expect(projected.selectedRoleIds).toEqual(expect.arrayContaining([
      "focused-researcher",
      "document-distiller",
      "synthesizer",
    ]));
    expect(JSON.stringify(projected)).not.toContain("evidence:host-coverage-1");
    expect(JSON.stringify(projected)).not.toContain("gap:host-coverage-1");
  });

  test("rejects model-supplied host state and revisions outside a checkpoint", async () => {
    const brief = createResearchBriefV1({
      sessionId: "research-session:revision-reject",
      turnId: "research-turn:revision-reject",
      objective: "Find one Jira ticket.",
      scope: {
        siteOrigin: "https://example.atlassian.net",
        jiraProjectKeys: ["DEMO"],
        confluenceSpaceKeys: [],
      },
      asOf: "2026-08-01T10:00:00.000Z",
      timezone: "UTC",
      requestedPlanApproval: "automatic",
      requestedReconciliation: "off",
    });
    const catalog = composeResearchGraphV1(brief);
    const active = acceptResearchGraphProposalV1(catalog, {
      schema: "atlcli.research-graph-proposal/v1",
      basedOnBriefRevision: catalog.basedOnBriefRevision,
      basedOnGraphRevision: catalog.revision,
      nodes: catalog.nodes.map((node) => ({
        nodeId: node.id,
        dependencies: node.dependencies,
        reasonCodes: node.reasonCodes,
      })),
    });
    const proposal = {
      basedOnBriefRevision: active.basedOnBriefRevision,
      basedOnGraphRevision: active.revision,
      nodes: active.nodes.map((node) => ({
        nodeId: node.id,
        dependencies: node.dependencies,
        reasonCodes: node.reasonCodes,
        priority: node.priority,
      })),
      prune: [],
    };
    const closed = createResearchGraphRevisionPtcTool(catalog, {
      activeGraph: () => active,
      canRevise: () => false,
      evidenceIds: () => [],
      gapIds: () => [],
      reason: () => "no_ranked_candidates",
      apply: async () => { throw new Error("must not persist"); },
    });

    await expect(closed.invoke(proposal)).rejects.toThrow("durable retrieval checkpoint");
    await expect(closed.invoke({ ...proposal, evidenceIds: ["evidence:forged"] }))
      .rejects.toThrow();
  });
});

describe("legacy bounded acquisition prompt", () => {
  test("uses the host-approved detail budget instead of a hidden three-item cap", () => {
    const prompt = buildLegacyResearchSystemPromptV1(8);
    expect(prompt).toContain("tools.researchCandidateRank");
    expect(prompt).toContain("ranked.items.slice(0, 8)");
    expect(prompt).not.toContain("slice(0, 3)");
  });
});

describe("host search-coverage limitations", () => {
  test("reports a complete admitted product search with no returned results without claiming absence", () => {
    const brief = createResearchBriefV1({
      sessionId: "research-session:coverage-limit",
      turnId: "research-turn:coverage-limit",
      objective: "Relate one Jira item to one page.",
      scope: {
        siteOrigin: "https://example.atlassian.net",
        jiraProjectKeys: ["DEMO"],
        confluenceSpaceKeys: ["DOCS"],
      },
      asOf: "2026-08-01T10:00:00.000Z",
      timezone: "UTC",
      requestedPlanApproval: "automatic",
      requestedReconciliation: "off",
    });
    const graph = composeResearchGraphV1(brief);
    expect(hostSearchCoverageLimitationsV1(graph, {
      complete: true,
      counts: { ptcCalls: 2, httpCalls: 2, jiraItems: 0, confluenceItems: 1 },
    })).toEqual(["The admitted Jira search returned no items in the approved scope."]);
  });

  test("does not treat a pruned product or incomplete search as an empty result", () => {
    const brief = createResearchBriefV1({
      sessionId: "research-session:coverage-pruned",
      turnId: "research-turn:coverage-pruned",
      objective: "Find one Jira item.",
      scope: {
        siteOrigin: "https://example.atlassian.net",
        jiraProjectKeys: ["DEMO"],
        confluenceSpaceKeys: ["DOCS"],
      },
      asOf: "2026-08-01T10:00:00.000Z",
      timezone: "UTC",
      requestedPlanApproval: "automatic",
      requestedReconciliation: "off",
    });
    const graph = composeResearchGraphV1(brief);
    const prunedWiki = structuredClone(graph);
    const wiki = prunedWiki.nodes.find((node) => node.id === "research-node:wiki-research");
    if (!wiki) throw new Error("Synthetic graph must include the wiki branch.");
    wiki.status = "pruned";
    expect(hostSearchCoverageLimitationsV1(prunedWiki, {
      complete: true,
      counts: { ptcCalls: 1, httpCalls: 1, jiraItems: 1, confluenceItems: 0 },
    })).toEqual([]);
    expect(hostSearchCoverageLimitationsV1(graph, {
      complete: false,
      counts: { ptcCalls: 1, httpCalls: 1, jiraItems: 0, confluenceItems: 0 },
    })).toEqual([]);
  });
});

describe("durable graph selection callback", () => {
  test("awaits durable selection persistence before publishing the selected graph", async () => {
    const brief = createResearchBriefV1({
      sessionId: "research-session:proposal-callback",
      turnId: "research-turn:proposal-callback",
      objective: "Find the related Jira and Confluence records.",
      scope: {
        siteOrigin: "https://example.atlassian.net",
        jiraProjectKeys: ["DEMO"],
        confluenceSpaceKeys: ["DOCS"],
      },
      asOf: "2026-08-01T10:00:00.000Z",
      timezone: "UTC",
      requestedPlanApproval: "automatic",
      requestedReconciliation: "off",
    });
    const graph = composeResearchGraphV1(brief);
    const lifecycle: string[] = [];
    const proposalTool = createResearchGraphProposalPtcTool(graph, {
      onAcceptedProposal: async () => {
        lifecycle.push("persist-started");
        await Promise.resolve();
        lifecycle.push("persisted");
      },
      onAccepted: () => lifecycle.push("published"),
    });

    await proposalTool.invoke({
      basedOnBriefRevision: graph.basedOnBriefRevision,
      basedOnGraphRevision: graph.revision,
      nodes: graph.nodes.filter((node) => node.kind !== "repair").map((node) => ({
        nodeId: node.id,
        dependencies: node.dependencies,
        reasonCodes: node.reasonCodes,
      })),
    });

    expect(lifecycle).toEqual(["persist-started", "persisted", "published"]);
  });
});
