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
  createResearchPromptCacheMiddlewareV1,
  createResearchAgentRuntime,
  type ResearchAgentRuntimeBindings,
} from "./agent-runtime-core.js";
import {
  DEFAULT_RESEARCH_LIMITS_V1,
  type ResearchRequestV1,
} from "./contracts.js";

describe("research root architecture invariants", () => {
  test("replaces both upstream Anthropic cache slots with audited host middleware", () => {
    const middleware = createResearchPromptCacheMiddlewareV1([
      "private turn segment",
    ]);

    expect(middleware.map((entry) => entry.name)).toEqual([
      "PromptCachingMiddleware",
      "CacheBreakpointMiddleware",
    ]);
    expect(new Set(middleware.map((entry) => entry.name)).size).toBe(2);
  });

  test("rejects legacy Chat-through-Research before constructing any agent", async () => {
    let constructions = 0;
    const createDeepAgentSpy = ((params: Parameters<typeof createDeepAgent>[0]) => {
      constructions += 1;
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
    const model = fakeModel();
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
    await expect(runtime.runResearchAgent({
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
      options: {
        mode: "chat",
      },
    })).rejects.toThrow(
      "Ordinary Chat must use runChatAgent; runResearchAgent accepts only research mode.",
    );

    expect(constructions).toBe(0);
  });
});
