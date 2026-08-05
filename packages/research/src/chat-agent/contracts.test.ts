import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { DEFAULT_RESEARCH_LIMITS_V1, type ResearchRequestV1 } from "../contracts.js";
import { chatQualityPolicyV1 } from "../quality-policy.js";
import { createMemoryResearchWorkspace } from "../workspace.js";
import { finalizeChatAnswerV1 } from "./answer.js";
import {
  CHAT_SESSION_STATE_PATH_V1,
  ChatContractError,
  providerCompatibleChatAnswerSchemaV1,
  type ChatTurnRequestV1,
} from "./contracts.js";
import {
  chatRecursionLimitV1,
  createChatDirectToolSurfaceMiddlewareV1,
  createKiteweaveChatAgent,
  type ChatAgentRuntimeBindings,
} from "./runtime.js";
import { createKiteweaveResearchAgent } from "../agent-runtime-core.js";

const turn: ChatTurnRequestV1 = {
  schema: "atlcli.chat-turn-request/v1",
  conversationId: "chat-conversation:synthetic",
  turnId: "chat-turn:synthetic",
  question: "What does the attached page establish?",
  scope: {
    siteOrigin: "https://tenant-a.atlassian.net",
    jiraProjectKeys: [],
    confluenceSpaceKeys: ["SPACE"],
  },
  limits: { ...DEFAULT_RESEARCH_LIMITS_V1, maxRunMs: 30_000 },
  wikiProvider: "rest",
};

const brokerRequest: ResearchRequestV1 = {
  schema: "atlcli.research-request/v1",
  question: turn.question,
  scope: turn.scope,
  limits: turn.limits,
  wikiProvider: "rest",
};

const run = {
  model: "synthetic-model",
  startedAt: "2026-08-05T08:00:00.000Z",
  completedAt: "2026-08-05T08:00:01.000Z",
  durationMs: 1_000,
  counts: { ptcCalls: 1, httpCalls: 1, jiraItems: 0, confluenceItems: 1 },
};

describe("Chat answer contract", () => {
  test("keeps strict host validation while removing provider-unsupported schema keywords", () => {
    const serialized = JSON.stringify(providerCompatibleChatAnswerSchemaV1());
    for (const keyword of ["maxItems", "maxLength", "minLength", "pattern"]) {
      expect(serialized).not.toContain(`\"${keyword}\"`);
    }
    expect(serialized).toContain("citationSourceIds");
    expect(serialized).toContain("additionalProperties");
  });

  test("replaces evidence placeholders only with host-owned canonical links", () => {
    const answer = finalizeChatAnswerV1({
      draft: {
        messageMarkdown: "The page establishes the synthetic claim. [[source:wiki:1001]]",
        citationSourceIds: ["wiki:1001"],
        gaps: [],
      },
      sources: [{
        id: "wiki:1001",
        product: "confluence",
        title: "Synthetic page",
        url: "https://tenant-a.atlassian.net/wiki/spaces/SPACE/pages/1001",
        contentId: "1001",
        spaceKey: "SPACE",
      }],
      detailEvidence: [{
        source: {
          id: "wiki:1001",
          product: "confluence",
          title: "Synthetic page",
          url: "https://tenant-a.atlassian.net/wiki/spaces/SPACE/pages/1001",
          contentId: "1001",
          spaceKey: "SPACE",
        },
        content: {
          text: "Synthetic body",
          inputBytes: 14,
          truncated: false,
          linkTargets: [],
        },
      }],
      qualityPolicy: chatQualityPolicyV1("quick"),
      run,
    });

    expect(answer.schema).toBe("atlcli.chat-answer/v1");
    expect(answer.messageMarkdown).toContain(
      "[Synthetic page](https://tenant-a.atlassian.net/wiki/spaces/SPACE/pages/1001)",
    );
    expect(answer.messageMarkdown).not.toContain("[[source:");
    expect(answer.strategy).toEqual({
      qualityMode: "quick",
      path: "direct",
      delegated: false,
      reasonCode: "quick-direct",
    });
  });

  test("rejects unknown citations, unsupported placeholders, and unknown gap evidence", () => {
    const base = {
      sources: [],
      detailEvidence: [],
      qualityPolicy: chatQualityPolicyV1("auto"),
      run,
    };
    expect(() => finalizeChatAnswerV1({
      ...base,
      draft: {
        messageMarkdown: "Unsupported. [[source:wiki:missing]]",
        citationSourceIds: ["wiki:missing"],
        gaps: [],
      },
    })).toThrow(ChatContractError);
    expect(() => finalizeChatAnswerV1({
      ...base,
      draft: {
        messageMarkdown: "Unsupported. [[source:wiki:missing]]",
        citationSourceIds: [],
        gaps: [],
      },
    })).toThrow("unsupported citation placeholder");
    expect(() => finalizeChatAnswerV1({
      ...base,
      draft: {
        messageMarkdown: "No evidence is available.",
        citationSourceIds: [],
        gaps: [{
          code: "no-detail-evidence",
          message: "No detailed source could be read.",
          sourceIds: ["wiki:missing"],
        }],
      },
    })).toThrow("unknown evidence");
  });

  test("allows a gap to identify a discovered source without treating it as citation evidence", () => {
    const answer = finalizeChatAnswerV1({
      draft: {
        messageMarkdown: "The remaining candidate was not read in detail.",
        citationSourceIds: [],
        gaps: [{
          code: "incomplete-coverage",
          message: "One discovered candidate remains unread.",
          sourceIds: ["wiki:1002"],
        }],
      },
      sources: [{
        id: "wiki:1002",
        product: "confluence",
        title: "Unread synthetic candidate",
        url: "https://tenant-a.atlassian.net/wiki/spaces/SPACE/pages/1002",
        contentId: "1002",
        spaceKey: "SPACE",
      }],
      detailEvidence: [],
      qualityPolicy: chatQualityPolicyV1("quick"),
      run,
    });

    expect(answer.citations).toEqual([]);
    expect(answer.gaps[0]?.sourceIds).toEqual(["wiki:1002"]);
  });

  test("requires a material coverage gap for a cited partial document projection", () => {
    const source = {
      id: "wiki:1001",
      product: "confluence" as const,
      title: "Long synthetic page",
      url: "https://tenant-a.atlassian.net/wiki/spaces/SPACE/pages/1001",
      contentId: "1001",
      spaceKey: "SPACE",
    };
    const base = {
      sources: [source],
      detailEvidence: [{
        source,
        content: {
          text: "A visible excerpt supports the positive statement.",
          inputBytes: 40_000,
          truncated: true,
          linkTargets: [],
        },
        coverage: {
          sourceTruncated: false,
          outlineTruncated: false,
          projectionTruncated: false,
          unreadSections: 3,
          completeDocumentRead: false,
        },
      }],
      qualityPolicy: chatQualityPolicyV1("auto"),
      run,
    };
    const bounded = finalizeChatAnswerV1({
      ...base,
      draft: {
        messageMarkdown: "The complete page contains no other constraint. [[source:wiki:1001]]",
        citationSourceIds: ["wiki:1001"],
        gaps: [],
      },
    });
    expect(bounded.messageMarkdown).toContain("Coverage limit");
    expect(bounded.gaps).toEqual([expect.objectContaining({
      code: "incomplete-coverage",
      sourceIds: ["wiki:1001"],
    })]);

    const answer = finalizeChatAnswerV1({
      ...base,
      draft: {
        messageMarkdown: "The visible section supports the positive statement. [[source:wiki:1001]]",
        citationSourceIds: ["wiki:1001"],
        gaps: [{
          code: "incomplete-coverage",
          message: "Three unrelated sections were not read.",
          sourceIds: ["wiki:1001"],
        }],
      },
    });
    expect(answer.messageMarkdown).toContain("positive statement");
    expect(answer.gaps).toHaveLength(1);
  });
});

describe("separate Chat root", () => {
  test("hides DeepAgents filesystem and task tools from the direct Chat model", async () => {
    const middleware = createChatDirectToolSurfaceMiddlewareV1();
    let visibleNames: string[] = [];
    await middleware.wrapModelCall?.(
      {
        tools: [
          { name: "ls" },
          { name: "task" },
          { name: "eval" },
          { name: "write_file" },
        ],
      } as never,
      async (request) => {
        visibleNames = request.tools.map((candidate) => String(candidate.name));
        return {} as never;
      },
    );
    expect(visibleNames).toEqual(["eval"]);
  });

  test("derives a bounded graph ceiling from the admitted PTC budget", () => {
    expect(chatRecursionLimitV1(1)).toBe(24);
    expect(chatRecursionLimitV1(16)).toBe(40);
    expect(chatRecursionLimitV1(10_000)).toBe(56);
  });

  function runtimeHarness() {
    let chatRoots = 0;
    let researchRoots = 0;
    const chatRuntime = {
      StateBackend: class {},
      createDeepAgent: (options: { name?: string }) => {
        chatRoots += 1;
        expect(options.name).toBe("kiteweave-chat-agent");
        return {
          invoke: async () => ({
            messages: [],
            structuredResponse: {
              messageMarkdown: "No detailed Atlassian evidence was needed for this response.",
              citationSourceIds: [],
              gaps: [],
            },
          }),
        };
      },
      registerHarnessProfile: () => undefined,
    } as unknown as ChatAgentRuntimeBindings;
    const researchRuntime = {
      CompositeBackend: class {},
      StateBackend: class {},
      createDeepAgent: () => {
        researchRoots += 1;
        return { invoke: async () => ({ messages: [] }) };
      },
      createFilesystemMiddleware: () => ({}),
      createSubAgentMiddleware: () => ({}),
      createSummarizationMiddleware: () => ({}),
      registerHarnessProfile: () => undefined,
    } as never;
    return { chatRuntime, researchRuntime, counts: () => ({ chatRoots, researchRoots }) };
  }

  test("constructs exactly one Chat root and does not construct the Research root", async () => {
    const harness = runtimeHarness();
    const chat = createKiteweaveChatAgent(harness.chatRuntime);
    createKiteweaveResearchAgent(harness.researchRuntime);
    const workspace = createMemoryResearchWorkspace();
    const answer = await chat.runChatAgent({
      model: {} as BaseChatModel,
      turn,
      brokerRequest,
      providers: {
        jira: {
          searchPage: async () => { throw new Error("unexpected Jira search"); },
          getIssue: async () => { throw new Error("unexpected Jira detail"); },
        },
        wiki: {
          searchPage: async () => { throw new Error("unexpected wiki search"); },
          getPage: async () => { throw new Error("unexpected wiki detail"); },
        },
      },
      workspace,
      qualityPolicy: chatQualityPolicyV1("auto"),
      now: (() => {
        let value = Date.parse("2026-08-05T08:00:00.000Z");
        return () => value++;
      })(),
    });

    expect(answer.schema).toBe("atlcli.chat-answer/v1");
    expect(answer.messageMarkdown).not.toMatch(/executive summary|findings|limitations/iu);
    expect(harness.counts()).toEqual({ chatRoots: 1, researchRoots: 0 });
    expect(JSON.parse((await workspace.readFile(CHAT_SESSION_STATE_PATH_V1))!)).toMatchObject({
      schema: "atlcli.chat-session-state/v1",
      conversationId: turn.conversationId,
    });
  });

  test("rejects an incompatible persisted state before root construction", async () => {
    const harness = runtimeHarness();
    const chat = createKiteweaveChatAgent(harness.chatRuntime);
    const workspace = createMemoryResearchWorkspace();
    await workspace.writeFile(CHAT_SESSION_STATE_PATH_V1, JSON.stringify({
      schema: "atlcli.research-session/v1",
      conversationId: turn.conversationId,
    }));
    await expect(chat.runChatAgent({
      model: {} as BaseChatModel,
      turn,
      brokerRequest,
      providers: {
        jira: { searchPage: async () => ({ items: [] }), getIssue: async () => { throw new Error(); } },
        wiki: { searchPage: async () => ({ items: [] }), getPage: async () => { throw new Error(); } },
      },
      workspace,
    })).rejects.toMatchObject({ code: "invalid-request" });
    expect(harness.counts().chatRoots).toBe(0);
  });

  test("keeps forbidden Research completion modules outside the Chat runtime import boundary", async () => {
    const source = await readFile(new URL("./runtime.ts", import.meta.url), "utf8");
    for (const forbidden of [
      "@langchain/anthropic",
      "../brief.js",
      "../graph.js",
      "../agent-draft.js",
      "../report.js",
      "../report-v2.js",
    ]) {
      expect(source).not.toContain(forbidden);
    }
    expect(source).toContain("./answer.js");
    expect(source).toContain("./prompts.js");
  });
});
