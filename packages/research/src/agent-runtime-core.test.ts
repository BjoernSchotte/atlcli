import { describe, expect, test } from "bun:test";
import { AIMessage, ToolMessage } from "@langchain/core/messages";
import { tool } from "@langchain/core/tools";
import { z } from "zod/v4";
import {
  buildLegacyResearchSystemPromptV1,
  createOneShotSupervisorEvalMiddleware,
  createResearchGraphProposalPtcTool,
  hostSearchCoverageLimitationsV1,
} from "./agent-runtime-core.js";
import { createResearchBriefV1 } from "./brief.js";
import { composeResearchGraphV1 } from "./graph.js";

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

describe("legacy bounded acquisition prompt", () => {
  test("uses the host-approved detail budget instead of a hidden three-item cap", () => {
    const prompt = buildLegacyResearchSystemPromptV1(8);
    expect(prompt).toContain("jira.items.slice(0, 8)");
    expect(prompt).toContain("wiki.items.slice(0, 8)");
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
