import { describe, expect, it } from "bun:test";
import {
  CHAT_SESSION_PATH_V1,
  DEFAULT_RESEARCH_LIMITS_V1,
  chatQualityPolicyV1,
  createMemoryResearchWorkspace,
  type ChatPresentationStreamEventV1,
  type ChatSessionV1,
  type ResearchRequestV1,
} from "@atlcli/research";
import { runChatAgent } from "@atlcli/research/browser/agent";
import { createLocalGemmaChatModelBindingV1 } from "../utils/local-model/langchain-proxy.js";
import {
  LOCAL_MODEL_PROTOCOL_SCHEMA_V1,
  type LocalModelPortRequestV1,
} from "../utils/local-model/protocol.js";

const providers = {
  jira: {
    async searchPage() { return { items: [] }; },
    async getIssue() { throw new Error("unexpected Jira detail read"); },
  },
  wiki: {
    async searchPage() { return { items: [] }; },
    async getPage() { throw new Error("unexpected Confluence detail read"); },
  },
};

function request(): {
  turn: {
    schema: "atlcli.chat-turn-request/v1";
    conversationId: string;
    turnId: string;
    question: string;
    scope: ResearchRequestV1["scope"];
    limits: ResearchRequestV1["limits"];
    wikiProvider: "rest";
  };
  brokerRequest: ResearchRequestV1;
} {
  const scope = {
    siteOrigin: "https://synthetic.atlassian.net",
    jiraProjectKeys: [] as string[],
    confluenceSpaceKeys: [] as string[],
  };
  const limits = {
    ...DEFAULT_RESEARCH_LIMITS_V1,
    maxRunMs: 30_000,
    maxTotalModelInputTokens: 1_000_000,
    maxTotalModelOutputTokens: 128_000,
    maxModelCostMicros: 100_000_000,
  };
  const question = "Give the bounded synthetic local answer.";
  return {
    turn: {
      schema: "atlcli.chat-turn-request/v1",
      conversationId: "chat-conversation:local-model-integration",
      turnId: "chat-turn:local-model-integration",
      question,
      scope,
      limits,
      wikiProvider: "rest",
    },
    brokerRequest: {
      schema: "atlcli.research-request/v1",
      question,
      scope,
      limits,
      wikiProvider: "rest",
    },
  };
}

describe("local Gemma shared Chat-agent path", () => {
  it("round-trips eval and a structured answer through the real browser runChatAgent", async () => {
    const channel = new MessageChannel();
    const requests: Extract<LocalModelPortRequestV1, { kind: "generate" }>[] = [];
    channel.port2.onmessage = (event: MessageEvent<LocalModelPortRequestV1>) => {
      const message = event.data;
      if (message.kind !== "generate") return;
      requests.push(message);
      const toolCalls = requests.length === 1
        ? [{
            id: "local-eval-1",
            name: "eval",
            arguments: { code: "JSON.stringify({ localBridge: true })" },
          }]
        : [{
            id: "local-answer-1",
            name: "ChatAnswerDraftV2",
            arguments: {
              blocks: [{
                id: "answer-block:local-integration",
                markdown: "A bounded synthetic local Chat answer.",
                sourceRefs: [],
                assertion: "none",
                scope: "none",
              }],
              gaps: [],
            },
          }];
      channel.port2.postMessage({
        schema: LOCAL_MODEL_PROTOCOL_SCHEMA_V1,
        kind: "complete",
        requestId: message.requestId,
        text: "",
        toolCalls,
        inputTokens: 32,
        outputTokens: 16,
      });
    };
    channel.port2.start();
    const workspace = createMemoryResearchWorkspace();
    const presentation: ChatPresentationStreamEventV1[] = [];
    const diagnostics: Array<{ kind: string; status: string; errorMessage?: string }> = [];
    try {
      let answer;
      try {
        answer = await runChatAgent({
          ...request(),
          modelBinding: createLocalGemmaChatModelBindingV1({
            port: channel.port1,
            modelId: "fixture/local-gemma",
            maxOutputTokens: 512,
          }),
          providers,
          workspace,
          hostIdentity: {
            userId: "principal:local-model-integration",
            providerCacheIdentity: "provider-cache:local-model-integration",
          },
          qualityPolicy: chatQualityPolicyV1("quick"),
          onChatPresentation: (event) => presentation.push(event),
          onAgentDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
        });
      } catch (error) {
        throw new Error(JSON.stringify({
          cause: error instanceof Error ? error.message : String(error),
          requestCount: requests.length,
          diagnostics,
        }));
      }

      expect(requests).toHaveLength(2);
      expect(requests[0]!.tools.map((tool) => tool.function.name))
        .toContain("eval");
      expect(requests[0]!.tools.map((tool) => tool.function.name))
        .toContain("ChatAnswerDraftV2");
      expect(requests[1]!.messages).toEqual(expect.arrayContaining([
        expect.objectContaining({
          role: "tool",
          name: "eval",
          tool_call_id: "local-eval-1",
        }),
      ]));
      expect(answer).toMatchObject({
        schema: "atlcli.chat-answer/v1",
        messageMarkdown: "A bounded synthetic local Chat answer.",
        strategy: { qualityMode: "quick", path: "direct", delegated: false },
      });
      expect(presentation).toEqual(expect.arrayContaining([
        expect.objectContaining({
          channel: "answer-markdown",
          status: "delta",
          delta: "A bounded synthetic local Chat answer.",
        }),
        expect.objectContaining({
          channel: "answer-markdown",
          status: "completed",
        }),
      ]));
      const session = JSON.parse(
        (await workspace.readFile(CHAT_SESSION_PATH_V1))!,
      ) as ChatSessionV1;
      expect(session.binding.providerCacheIdentity)
        .toBe("provider-cache:local-model-integration");
      expect(session.conversation.recentTurns.at(-1)).toMatchObject({
        status: "complete",
        finalAnswer: {
          schema: "atlcli.chat-answer/v1",
          messageMarkdown: "A bounded synthetic local Chat answer.",
        },
      });
    } finally {
      channel.port1.close();
      channel.port2.close();
    }
  }, 30_000);
});
