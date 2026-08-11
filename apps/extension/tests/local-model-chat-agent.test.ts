import { describe, expect, it } from "bun:test";
import {
  CHAT_SESSION_PATH_V1,
  DEFAULT_RESEARCH_LIMITS_V1,
  chatQualityPolicyV1,
  classifyResearchError,
  createMemoryResearchWorkspace,
  createResearchKeyScopeSeedV1,
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
import {
  LOCAL_GEMMA_ROOT_SYSTEM_PROMPT_MAX_CHARS_V1,
} from "../utils/local-model/tool-protocol.js";

const providers = {
  jira: {
    async searchPage() {
      return { items: [] };
    },
    async getIssue() {
      throw new Error("unexpected Jira detail read");
    },
  },
  wiki: {
    async searchPage() {
      return { items: [] };
    },
    async getPage() {
      throw new Error("unexpected Confluence detail read");
    },
  },
};

function request(
  options: {
    suffix?: string;
    question?: string;
    jiraProjectKeys?: string[];
    confluenceSpaceKeys?: string[];
    limits?: Partial<ResearchRequestV1["limits"]>;
  } = {},
): {
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
    jiraProjectKeys: options.jiraProjectKeys ?? [],
    confluenceSpaceKeys: options.confluenceSpaceKeys ?? [],
  };
  const limits = {
    ...DEFAULT_RESEARCH_LIMITS_V1,
    maxRunMs: 30_000,
    maxTotalModelInputTokens: 1_000_000,
    maxTotalModelOutputTokens: 128_000,
    maxModelCostMicros: 100_000_000,
    ...options.limits,
  };
  const question =
    options.question ?? "Give the bounded synthetic local answer.";
  const suffix = options.suffix ?? "integration";
  return {
    turn: {
      schema: "atlcli.chat-turn-request/v1",
      conversationId: `chat-conversation:local-model-${suffix}`,
      turnId: `chat-turn:local-model-${suffix}`,
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
  it("surfaces an actionable local runtime failure instead of a remote-stream checkpoint", async () => {
    const channel = new MessageChannel();
    channel.port2.onmessage = (
      event: MessageEvent<LocalModelPortRequestV1>,
    ) => {
      const message = event.data;
      if (message.kind !== "generate") return;
      channel.port2.postMessage({
        schema: LOCAL_MODEL_PROTOCOL_SCHEMA_V1,
        kind: "error",
        requestId: message.requestId,
        code: "model-error",
        error: "Synthetic WebGPU initialization failed.",
      });
    };
    channel.port2.start();
    try {
      try {
        await runChatAgent({
          ...request({ suffix: "runtime-failure" }),
          modelBinding: createLocalGemmaChatModelBindingV1({
            port: channel.port1,
            modelId: "fixture/local-gemma",
            maxOutputTokens: 512,
          }),
          modelProviderFailureMode: "surface-terminal",
          modelUsageBudget: "local-unmetered",
          providers,
          workspace: createMemoryResearchWorkspace(),
          hostIdentity: {
            userId: "principal:local-runtime-failure",
            providerCacheIdentity: "provider-cache:local-runtime-failure",
          },
          qualityPolicy: chatQualityPolicyV1("quick"),
        });
        throw new Error("Expected local runtime failure.");
      } catch (error) {
        expect(error).toMatchObject({
          message: "Synthetic WebGPU initialization failed.",
        });
        expect(classifyResearchError(error)).toEqual({
          code: "provider-error",
          message: "Synthetic WebGPU initialization failed.",
        });
      }
    } finally {
      channel.port1.close();
      channel.port2.close();
    }
  }, 30_000);

  it("does not apply provider token or cost quotas to local inference", async () => {
    const channel = new MessageChannel();
    channel.port2.onmessage = (
      event: MessageEvent<LocalModelPortRequestV1>,
    ) => {
      const message = event.data;
      if (message.kind !== "generate") return;
      channel.port2.postMessage({
        schema: LOCAL_MODEL_PROTOCOL_SCHEMA_V1,
        kind: "complete",
        requestId: message.requestId,
        text: "",
        toolCalls: [
          {
            id: "local-unmetered-answer",
            name: "ChatAnswerDraftV2",
            arguments: {
              blocks: [
                {
                  id: "answer-block:local-unmetered",
                  markdown: "A local answer without a provider token quota.",
                  sourceRefs: [],
                  assertion: "none",
                  scope: "none",
                },
              ],
              gaps: [],
            },
          },
        ],
        inputTokens: 8_000,
        outputTokens: 4_000,
      });
    };
    channel.port2.start();
    try {
      const answer = await runChatAgent({
        ...request({
          suffix: "unmetered",
          limits: {
            maxTotalModelInputTokens: 1_000,
            maxTotalModelOutputTokens: 1_000,
            maxModelCostMicros: 10_000,
          },
        }),
        modelBinding: createLocalGemmaChatModelBindingV1({
          port: channel.port1,
          modelId: "fixture/local-gemma",
          maxOutputTokens: 512,
        }),
        modelUsageBudget: "local-unmetered",
        providers,
        workspace: createMemoryResearchWorkspace(),
        hostIdentity: {
          userId: "principal:local-unmetered",
          providerCacheIdentity: "provider-cache:local-unmetered",
        },
        qualityPolicy: chatQualityPolicyV1("quick"),
      });

      expect(answer.messageMarkdown).toBe(
        "A local answer without a provider token quota.",
      );
    } finally {
      channel.port1.close();
      channel.port2.close();
    }
  }, 30_000);

  it("round-trips eval and a structured answer through the real browser runChatAgent", async () => {
    const channel = new MessageChannel();
    const requests: Extract<LocalModelPortRequestV1, { kind: "generate" }>[] =
      [];
    channel.port2.onmessage = (
      event: MessageEvent<LocalModelPortRequestV1>,
    ) => {
      const message = event.data;
      if (message.kind !== "generate") return;
      requests.push(message);
      const toolCalls =
        requests.length === 1
          ? [
              {
                id: "local-eval-1",
                name: "eval",
                arguments: { code: "JSON.stringify({ localBridge: true })" },
              },
            ]
          : [
              {
                id: "local-answer-1",
                name: "ChatAnswerDraftV2",
                arguments: {
                  blocks: [
                    {
                      id: "answer-block:local-integration",
                      markdown: "A bounded synthetic local Chat answer.",
                      sourceRefs: [],
                      assertion: "none",
                      scope: "none",
                    },
                  ],
                  gaps: [],
                },
              },
            ];
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
    const diagnostics: Array<{
      kind: string;
      status: string;
      errorMessage?: string;
    }> = [];
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
          modelProviderFailureMode: "surface-terminal",
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
        throw new Error(
          JSON.stringify({
            cause: error instanceof Error ? error.message : String(error),
            requestCount: requests.length,
            diagnostics,
          }),
        );
      }

      expect(requests).toHaveLength(2);
      expect(requests[0]!.tools.map((tool) => tool.function.name)).toContain(
        "eval",
      );
      expect(requests[0]!.tools.map((tool) => tool.function.name)).toContain(
        "ChatAnswerDraftV2",
      );
      expect(requests[0]!.messages[0]!.content.length).toBeLessThanOrEqual(
        LOCAL_GEMMA_ROOT_SYSTEM_PROMPT_MAX_CHARS_V1,
      );
      expect(requests[1]!.messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            role: "tool",
            name: "eval",
            tool_call_id: "local-eval-1",
          }),
        ]),
      );
      expect(answer).toMatchObject({
        schema: "atlcli.chat-answer/v1",
        messageMarkdown: "A bounded synthetic local Chat answer.",
        strategy: { qualityMode: "quick", path: "direct", delegated: false },
      });
      expect(presentation).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            channel: "answer-markdown",
            status: "delta",
            delta: "A bounded synthetic local Chat answer.",
          }),
          expect.objectContaining({
            channel: "answer-markdown",
            status: "completed",
          }),
        ]),
      );
      const session = JSON.parse(
        (await workspace.readFile(CHAT_SESSION_PATH_V1))!,
      ) as ChatSessionV1;
      expect(session.binding.providerCacheIdentity).toBe(
        "provider-cache:local-model-integration",
      );
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

  it("projects matched retrieved evidence into a fresh local terminal context", async () => {
    const channel = new MessageChannel();
    const requests: Extract<LocalModelPortRequestV1, { kind: "generate" }>[] = [];
    const longPage = [
      "Budget 2026: 60,000-85,000 EUR.",
      "x".repeat(13_000),
      "Base fee from 2027: 30,000 EUR.",
    ].join("\n");
    channel.port2.onmessage = (
      event: MessageEvent<LocalModelPortRequestV1>,
    ) => {
      const message = event.data;
      if (message.kind !== "generate") return;
      requests.push(message);
      let toolCalls;
      if (!message.requiredToolName) {
        toolCalls = [{
          id: "local-terminal-eval",
          name: "eval",
          arguments: {
            code: "JSON.parse(await tools.chatConfluenceRetrievalAcquire({}))",
          },
        }];
      } else if (message.requiredToolName === "KiteweaveLocalTerminalEvidenceV1") {
        const content = message.messages.findLast((candidate) => candidate.role === "user")
          ?.content ?? "";
        const claims = [
          ...(content.includes("Budget 2026")
            ? [{
                text: "The 2026 budget is 60,000-85,000 EUR.",
                sourceIds: ["wiki:1001"],
                sourceRefs: ["wiki:1001"],
              }]
            : []),
          ...(content.includes("Base fee from 2027")
            ? [{
                text: "The base fee from 2027 is 30,000 EUR.",
                sourceIds: ["wiki:1001"],
                sourceRefs: ["wiki:1001"],
              }]
            : []),
        ];
        toolCalls = [{
          id: `local-terminal-evidence-${requests.length}`,
          name: message.requiredToolName,
          arguments: {
            schema: "atlcli.chat-evidence-packet/v1",
            sourceIds: ["wiki:1001"],
            claims,
            relationships: [],
            gaps: [],
          },
        }];
      } else if (message.requiredToolName === "ChatAnswerDraftV2") {
        toolCalls = [{
          id: "local-terminal-answer",
          name: "ChatAnswerDraftV2",
          arguments: {
            blocks: [{
              id: "answer-block:local-terminal-context",
              markdown:
                "The 2026 budget is 60,000-85,000 EUR; the base fee from 2027 is 30,000 EUR.",
              sourceRefs: ["wiki:1001"],
              assertion: "positive",
              scope: "none",
            }],
            gaps: [],
          },
        }];
      } else {
        throw new Error(`Unexpected required tool: ${message.requiredToolName}`);
      }
      channel.port2.postMessage({
        schema: LOCAL_MODEL_PROTOCOL_SCHEMA_V1,
        kind: "complete",
        requestId: message.requestId,
        text: "",
        toolCalls,
        inputTokens: 256,
        outputTokens: 64,
      });
    };
    channel.port2.start();
    const input = request({
      suffix: "terminal-context",
      question: "State the 2026 budget and the base fee from 2027.",
      confluenceSpaceKeys: ["KB"],
    });
    input.brokerRequest = {
      ...input.brokerRequest,
      scopeSeeds: [createResearchKeyScopeSeedV1({
        tenantOrigin: input.brokerRequest.scope.siteOrigin,
        product: "confluence",
        key: "KB",
        source: "current_context",
        authority: "approved",
      })],
    };
    const scopedProviders = {
      jira: providers.jira,
      wiki: {
        async searchPage() {
          return {
            items: [{ contentId: "1001", spaceKey: "KB", title: "Budget page" }],
          };
        },
        async getPage() {
          return {
            contentId: "1001",
            spaceKey: "KB",
            title: "Budget page",
            content: {
              text: longPage,
              inputBytes: longPage.length,
              truncated: false,
              linkTargets: [],
            },
          };
        },
      },
    };

    try {
      const answer = await runChatAgent({
        ...input,
        modelBinding: createLocalGemmaChatModelBindingV1({
          port: channel.port1,
          modelId: "fixture/local-gemma",
          maxOutputTokens: 512,
        }),
        modelProviderFailureMode: "surface-terminal",
        modelUsageBudget: "local-unmetered",
        providers: scopedProviders,
        workspace: createMemoryResearchWorkspace(),
        hostIdentity: {
          userId: "principal:local-terminal-context",
          providerCacheIdentity: "provider-cache:local-terminal-context",
        },
        qualityPolicy: chatQualityPolicyV1("quick"),
      });

      const extractionRequests = requests.filter((candidate) =>
        candidate.requiredToolName === "KiteweaveLocalTerminalEvidenceV1"
      );
      expect(extractionRequests).toHaveLength(0);
      const finalRequest = requests.find((candidate) =>
        candidate.requiredToolName === "ChatAnswerDraftV2"
      )!;
      expect(finalRequest.messages.some((message) => message.role === "tool")).toBe(false);
      expect(JSON.stringify(finalRequest.messages)).toContain(
        "atlcli.chat-terminal-context/v1",
      );
      expect(JSON.stringify(finalRequest.messages)).toContain(
        "Budget 2026: 60,000-85,000 EUR.",
      );
      expect(JSON.stringify(finalRequest.messages)).toContain(
        "Base fee from 2027: 30,000 EUR.",
      );
      expect(answer.messageMarkdown).toContain("60,000-85,000 EUR");
      expect(answer.messageMarkdown).toContain("30,000 EUR");
      expect(answer.citations).toEqual([
        expect.objectContaining({ sourceId: "wiki:1001" }),
      ]);
    } finally {
      channel.port1.close();
      channel.port2.close();
    }
  }, 30_000);

  for (const mode of ["auto", "deep"] as const) {
    it(`runs the ${mode} direct strategy through the local binding`, async () => {
      const channel = new MessageChannel();
      const requests: Extract<LocalModelPortRequestV1, { kind: "generate" }>[] =
        [];
      channel.port2.onmessage = (
        event: MessageEvent<LocalModelPortRequestV1>,
      ) => {
        const message = event.data;
        if (message.kind !== "generate") return;
        requests.push(message);
        channel.port2.postMessage({
          schema: LOCAL_MODEL_PROTOCOL_SCHEMA_V1,
          kind: "complete",
          requestId: message.requestId,
          text: "",
          toolCalls: [
            {
              id: `local-${mode}-answer`,
              name: "ChatAnswerDraftV2",
              arguments: {
                blocks: [
                  {
                    id: `answer-block:local-${mode}`,
                    markdown: `A bounded synthetic local ${mode} answer.`,
                    sourceRefs: [],
                    assertion: "none",
                    scope: "none",
                  },
                ],
                gaps: [],
              },
            },
          ],
          inputTokens: 32,
          outputTokens: 16,
        });
      };
      channel.port2.start();
      try {
        const answer = await runChatAgent({
          ...request(),
          modelBinding: createLocalGemmaChatModelBindingV1({
            port: channel.port1,
            modelId: "fixture/local-gemma",
            maxOutputTokens: 512,
          }),
          providers,
          workspace: createMemoryResearchWorkspace(),
          hostIdentity: {
            userId: `principal:local-${mode}-integration`,
            providerCacheIdentity: `provider-cache:local-${mode}-integration`,
          },
          modelProviderFailureMode: "surface-terminal",
          qualityPolicy: chatQualityPolicyV1(mode),
        });

        expect(requests).toHaveLength(1);
        expect(requests[0]!.thinkingMode).toBe(
          mode === "auto" ? "low" : "enabled",
        );
        expect(requests[0]!.messages[0]!.content).toContain("<|think|>");
        expect(requests[0]!.tools.map((tool) => tool.function.name)).toContain(
          "ChatAnswerDraftV2",
        );
        expect(answer).toMatchObject({
          messageMarkdown: `A bounded synthetic local ${mode} answer.`,
          strategy: { qualityMode: mode, path: "direct", delegated: false },
        });
      } finally {
        channel.port1.close();
        channel.port2.close();
      }
    }, 30_000);
  }

  for (const mode of ["auto", "deep"] as const) {
    it(`runs the agentic ${mode} workflow through the local binding`, async () => {
      const channel = new MessageChannel();
      const requests: Extract<LocalModelPortRequestV1, { kind: "generate" }>[] =
        [];
      const workflowCode = `
const acceptedStrategy = JSON.parse(await tools.chatStrategyDecide({}));
globalThis.syntheticWorkflow = JSON.parse(await tools.chatWorkflowPropose({
  tasks: [
    { taskId: "task:compare", profileId: "comparison-analyst", objective: "Compare the bounded synthetic positions.", dependencyTaskIds: [] },
    { taskId: "task:contradiction", profileId: "contradiction-checker", objective: "Check the bounded synthetic positions for contradictions.", dependencyTaskIds: ["task:compare"] },
    { taskId: "task:draft", profileId: "answer-drafter", objective: "Draft the bounded synthetic answer.", dependencyTaskIds: ["task:compare", "task:contradiction"] },
    { taskId: "task:critic", profileId: "answer-critic", objective: "Check the bounded synthetic evidence state.", dependencyTaskIds: ["task:draft"] },
    { taskId: "task:synth", profileId: "chat-synthesizer", objective: "Write the conversational answer.", dependencyTaskIds: ["task:draft", "task:critic"] }
  ],
  maxConcurrency: 1
}));
globalThis.syntheticWorkflowRun = JSON.parse(await tools.chatWorkflowRun({}));
syntheticWorkflowRun;`;
      const scriptedResponses = [
        {
          toolCalls: [
            {
              id: "agentic-root-eval",
              name: "eval",
              arguments: { code: workflowCode },
            },
          ],
        },
        {
          toolCalls: [
            {
              id: "agentic-analysis-1",
              name: "ChatAnalysisPacketV1",
              arguments: {
                schema: "atlcli.chat-analysis-packet/v1",
                claimRefs: [],
                relationshipRefs: [],
                contradictions: [],
                gaps: [],
              },
            },
          ],
        },
        {
          toolCalls: [
            {
              id: "agentic-analysis-2",
              name: "ChatAnalysisPacketV1",
              arguments: {
                schema: "atlcli.chat-analysis-packet/v1",
                claimRefs: [],
                relationshipRefs: [],
                contradictions: [],
                gaps: [],
              },
            },
          ],
        },
        {
          toolCalls: [
            {
              id: "agentic-provisional",
              name: "ChatProvisionalAnswerDraftV1",
              arguments: {
                blocks: [
                  {
                    id: "answer-block:agentic-provisional",
                    markdown: "A bounded provisional synthetic local answer.",
                    sourceRefs: [],
                    assertion: "none",
                    scope: "none",
                  },
                ],
                gaps: [
                  {
                    code: "no-detail-evidence",
                    message:
                      "The synthetic fixture has no detailed source evidence.",
                    sourceIds: [],
                  },
                ],
              },
            },
          ],
        },
        {
          toolCalls: [
            {
              id: "agentic-critique",
              name: "ChatCritiquePacketV1",
              arguments: {
                schema: "atlcli.chat-critique-packet/v1",
                defects: [],
                readyForSynthesis: true,
              },
            },
          ],
        },
        {
          toolCalls: [
            {
              id: "agentic-final",
              name: "ChatAnswerDraftV2",
              arguments: {
                blocks: [
                  {
                    id: "answer-block:agentic-final",
                    markdown: "A bounded synthetic agentic local Chat answer.",
                    sourceRefs: [],
                    assertion: "none",
                    scope: "none",
                  },
                ],
                gaps: [
                  {
                    code: "no-detail-evidence",
                    message:
                      "The synthetic fixture has no detailed source evidence.",
                    sourceIds: [],
                  },
                ],
              },
            },
          ],
        },
      ];
      let scriptedResponseIndex = 0;
      channel.port2.onmessage = (
        event: MessageEvent<LocalModelPortRequestV1>,
      ) => {
        const message = event.data;
        if (message.kind !== "generate") return;
        requests.push(message);
        if (message.tools.length === 0) {
          channel.port2.postMessage({
            schema: LOCAL_MODEL_PROTOCOL_SCHEMA_V1,
            kind: "complete",
            requestId: message.requestId,
            text: "Synthetic compact conversation context.",
            toolCalls: [],
            inputTokens: 48,
            outputTokens: 12,
          });
          return;
        }
        const response = scriptedResponses[scriptedResponseIndex++];
        if (!response) throw new Error("unexpected local agentic model call");
        channel.port2.postMessage({
          schema: LOCAL_MODEL_PROTOCOL_SCHEMA_V1,
          kind: "complete",
          requestId: message.requestId,
          text: "",
          toolCalls: response.toolCalls,
          inputTokens: 48,
          outputTokens: 24,
        });
      };
      channel.port2.start();
      try {
        const answer = await runChatAgent({
          ...request({
            suffix: `agentic-${mode}`,
            question:
              "Compare the two bounded positions and check for contradictions.",
          }),
          modelBinding: createLocalGemmaChatModelBindingV1({
            port: channel.port1,
            modelId: "fixture/local-gemma",
            maxOutputTokens: 1_024,
          }),
          modelProviderFailureMode: "surface-terminal",
          providers,
          workspace: createMemoryResearchWorkspace(),
          hostIdentity: {
            userId: `principal:local-${mode}-agentic`,
            providerCacheIdentity: `provider-cache:local-${mode}-agentic`,
          },
          qualityPolicy: chatQualityPolicyV1(mode),
        });

        expect(scriptedResponseIndex).toBe(scriptedResponses.length);
        expect(requests[0]!.messages[0]!.content.length).toBeLessThanOrEqual(
          LOCAL_GEMMA_ROOT_SYSTEM_PROMPT_MAX_CHARS_V1,
        );
        expect(requests[0]!.messages[0]!.content).toContain(
          "tools.chatWorkflowPropose",
        );
        expect(answer).toMatchObject({
          strategy: { qualityMode: mode, path: "agentic", delegated: true },
        });
        expect(answer.messageMarkdown).toContain(
          "A bounded synthetic agentic local Chat answer.",
        );
        expect(answer.gaps).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ code: "no-detail-evidence" }),
          ]),
        );
      } finally {
        channel.port1.close();
        channel.port2.close();
      }
    }, 30_000);
  }
});
