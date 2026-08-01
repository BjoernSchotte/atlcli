import { describe, expect, test } from "bun:test";
import { AIMessage, ToolMessage } from "@langchain/core/messages";
import { tool } from "@langchain/core/tools";
import { z } from "zod/v4";
import { createOneShotSupervisorEvalMiddleware } from "./agent-runtime-core.js";

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
