import { describe, expect, test } from "bun:test";
import { AIMessage, ToolMessage } from "@langchain/core/messages";
import { tool } from "@langchain/core/tools";
import { z } from "zod/v4";
import {
  createOneShotSupervisorEvalMiddleware,
  createResearchGraphProposalPtcTool,
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
): Promise<void> {
  await middleware.wrapToolCall!(
    {
      toolCall: { id: "tool-call:eval", name: "eval", args: { code: "({ ok: true })" } },
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
