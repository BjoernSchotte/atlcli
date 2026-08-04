import { describe, expect, test } from "bun:test";
import { fakeModel } from "@langchain/core/testing";
import {
  CompositeBackend,
  StateBackend,
  createDeepAgent,
  createFilesystemMiddleware,
  createSubAgentMiddleware,
  createSummarizationMiddleware,
} from "deepagents/node";
import {
  createResearchAgentRuntime,
  type ResearchAgentRuntimeBindings,
} from "./agent-runtime-core.js";
import {
  DEFAULT_RESEARCH_LIMITS_V1,
  type ResearchRequestV1,
} from "./contracts.js";

describe("research root architecture invariants", () => {
  test("constructs one logical Quick Chat root with no delegated task surface", async () => {
    let constructions = 0;
    let captured: Parameters<typeof createDeepAgent>[0] | undefined;
    const createDeepAgentSpy = ((params: Parameters<typeof createDeepAgent>[0]) => {
      constructions += 1;
      captured = params;
      return createDeepAgent(params);
    }) as typeof createDeepAgent;
    const runtime = createResearchAgentRuntime({
      CompositeBackend,
      StateBackend,
      createDeepAgent: createDeepAgentSpy,
      createFilesystemMiddleware,
      createSubAgentMiddleware,
      createSummarizationMiddleware,
      // The profile decision is separately pinned; avoid mutating the process
      // registry in this construction-count test.
      registerHarnessProfile() {},
    } as ResearchAgentRuntimeBindings);
    const model = fakeModel().respondWithTools([
      {
        name: "AtlcliResearchAgentDraftV1",
        args: {
          title: "Synthetic direct answer",
          executiveSummary: "No detail source was admitted.",
          findings: [],
          relationships: [],
          limitations: ["Synthetic invariant run."],
        },
      },
    ]);
    const request: ResearchRequestV1 = {
      schema: "atlcli.research-request/v1",
      question: "Answer one synthetic direct question.",
      scope: {
        siteOrigin: "https://synthetic.atlassian.net",
        jiraProjectKeys: [],
        confluenceSpaceKeys: ["KB"],
      },
      limits: { ...DEFAULT_RESEARCH_LIMITS_V1 },
      wikiProvider: "rest",
    };

    await runtime.runResearchAgent({
      model,
      request,
      providers: {
        jira: {
          async searchPage() { return { items: [] }; },
          async getIssue() { throw new Error("not reached"); },
        },
        wiki: {
          async searchPage() { return { items: [] }; },
          async getPage() { throw new Error("not reached"); },
        },
      },
      options: { mode: "chat" },
    });

    expect(constructions).toBe(1);
    expect(captured?.subagents).toEqual([]);
    const middleware = captured?.middleware ?? [];
    expect(middleware.map((entry) => entry.name)).toEqual([
      "SummarizationMiddleware",
      "patchToolCallsMiddleware",
      "FilesystemMiddleware",
      "subAgentMiddleware",
      "CodeInterpreterMiddleware",
    ]);
    expect(
      middleware.flatMap((entry) => entry.tools ?? [])
        .filter((candidate) => candidate.name === "task"),
    ).toHaveLength(0);
  });
});
