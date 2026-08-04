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
import {
  chatQualityPolicyV1,
  readStoredChatQualityPolicyV1,
} from "./quality-policy.js";
import { createMemoryResearchWorkspace } from "./workspace.js";

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
    const workspace = createMemoryResearchWorkspace();

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
      workspace,
      options: {
        mode: "chat",
        qualityPolicy: chatQualityPolicyV1("deep"),
      },
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
    expect(await readStoredChatQualityPolicyV1(workspace)).toEqual(
      chatQualityPolicyV1("deep"),
    );
  });
});
