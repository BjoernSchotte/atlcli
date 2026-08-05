import { createCodeInterpreterMiddleware } from "@langchain/quickjs";
import { createMiddleware, providerStrategy, toolStrategy } from "langchain";
import type { AIMessage } from "@langchain/core/messages";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { type ResearchPtcDiagnosticV1 } from "../agent-tools.js";
import {
  ResearchCapabilityBroker,
  type ResearchReadProviders,
} from "../broker.js";
import { ResearchRunBudget } from "../budget.js";
import type {
  ResearchOneShotEventV1,
  ResearchProgressV1,
  ResearchRequestV1,
  ResearchRunUsageV1,
} from "../contracts.js";
import {
  CAPABILITY_FREE_QUALITY_ADAPTER_V1,
  chatQualityPolicyV1,
  normalizeChatQualityPolicyV1,
  type ChatQualityPolicyV1,
} from "../quality-policy.js";
import type { ResearchWorkspace } from "../workspace.js";
import { finalizeChatAnswerV1 } from "./answer.js";
import {
  CHAT_AGENT_DRAFT_SCHEMA_V1,
  CHAT_SESSION_STATE_PATH_V1,
  CHAT_SESSION_STATE_SCHEMA_V1,
  ChatContractError,
  createChatSessionStateV1,
  normalizeChatTurnRequestV1,
  providerCompatibleChatAnswerSchemaV1,
  type ChatAnswerV1,
  type ChatSessionStateV1,
  type ChatTurnRequestV1,
} from "./contracts.js";
import { buildChatSystemPromptV1, buildChatTurnPromptV1 } from "./prompts.js";
import { createChatPtcToolsV1 } from "./retrieval.js";
import type { ChatModelBindingV1, ChatModelFactoryV1 } from "./model.js";

export function chatRecursionLimitV1(maxPtcCalls: number): number {
  const boundedCalls = Math.max(1, Math.min(24, Math.trunc(maxPtcCalls)));
  // A ReAct capability round consumes at least one model node and one tool
  // node. Keep room for the initial decision and terminal structured answer,
  // while retaining a hard graph ceiling independent of provider behavior.
  return Math.min(64, Math.max(24, boundedCalls * 2 + 8));
}

export type ChatAgentDiagnosticV1 =
  | { kind: "model-step"; toolNames: string[]; stopReason?: string }
  | {
      kind: "eval-step";
      status: "started" | "success" | "error";
      resultChars?: number;
      errorKind?: "SyntaxError" | "ReferenceError" | "TypeError" | "Error" | "unknown";
      errorCode?: "tools-unavailable" | "capability-unavailable" | "undefined-symbol" | "syntax" | "other";
      codeChars?: number;
      capabilityNames?: string[];
      usesToolsNamespace?: boolean;
      searchInputShapes?: string[];
    };

function diagnosticMessage(value: unknown): {
  toolNames: string[];
  stopReason?: string;
} {
  const record = value && typeof value === "object"
    ? value as Record<string, unknown>
    : {};
  const messages = Array.isArray(record.messages) ? record.messages : [];
  const last = messages.at(-1);
  const message = last && typeof last === "object"
    ? last as Record<string, unknown>
    : record;
  const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  const metadata = message.response_metadata && typeof message.response_metadata === "object"
    ? message.response_metadata as Record<string, unknown>
    : {};
  const stopReason = typeof metadata.stop_reason === "string"
    ? metadata.stop_reason
    : typeof metadata.stopReason === "string"
      ? metadata.stopReason
      : undefined;
  return {
    toolNames: toolCalls.flatMap((call): string[] =>
      call && typeof call === "object" && typeof (call as { name?: unknown }).name === "string"
        ? [(call as { name: string }).name]
        : []),
    ...(stopReason ? { stopReason } : {}),
  };
}

function evalResultDiagnostic(value: unknown): {
  resultChars: number;
  errorKind?: "SyntaxError" | "ReferenceError" | "TypeError" | "Error";
  errorCode?: "tools-unavailable" | "capability-unavailable" | "undefined-symbol" | "syntax" | "other";
} {
  const content = value && typeof value === "object" && "content" in value
    ? (value as { content?: unknown }).content
    : value;
  const rendered = typeof content === "string" ? content : "";
  const match = /^(SyntaxError|ReferenceError|TypeError|Error):/u.exec(rendered.trimStart());
  const errorCode = !match
    ? undefined
    : /\btools\b[^\n]*(?:not defined|unavailable)/iu.test(rendered)
      ? "tools-unavailable"
      : /\b(?:atlassianBoundRead|jiraIssueSearch|jiraIssueGet|wikiSearch|wikiPageGet|researchCandidateRank)\b[^\n]*(?:not a function|not defined|unavailable)/iu.test(rendered)
        ? "capability-unavailable"
        : /not defined/iu.test(rendered)
          ? "undefined-symbol"
          : match[1] === "SyntaxError"
            ? "syntax"
            : "other";
  return {
    resultChars: rendered.length,
    ...(match
      ? { errorKind: match[1] as "SyntaxError" | "ReferenceError" | "TypeError" | "Error" }
      : {}),
    ...(errorCode ? { errorCode } : {}),
  };
}

export function createChatDirectToolSurfaceMiddlewareV1(
  onDiagnostic?: (diagnostic: ChatAgentDiagnosticV1) => void,
) {
  return createMiddleware({
    name: "ChatDirectToolSurfaceMiddleware",
    async wrapModelCall(request, handler) {
      const response = await handler({
        ...request,
        // createDeepAgent always assembles filesystem and task scaffolding.
        // Direct Chat deliberately exposes only the host-audited QuickJS bridge;
        // structured-output tools are bound by LangChain after this middleware.
        tools: request.tools.filter((candidate) => candidate.name === "eval"),
      });
      onDiagnostic?.({ kind: "model-step", ...diagnosticMessage(response) });
      return response;
    },
    async wrapToolCall(request, handler) {
      if (request.toolCall.name !== "eval") return handler(request);
      const code = request.toolCall.args && typeof request.toolCall.args === "object" &&
        "code" in request.toolCall.args && typeof request.toolCall.args.code === "string"
        ? request.toolCall.args.code
        : "";
      const capabilityNames = [
        "jiraIssueSearch",
        "jiraIssueGet",
        "wikiSearch",
        "wikiPageGet",
        "researchCandidateRank",
        "atlassianBoundRead",
      ].filter((name) => new RegExp(`\\b${name}\\b`, "u").test(code));
      const searchInputShapes = [
        ["jiraIssueSearch", "jira"],
        ["wikiSearch", "wiki"],
      ].flatMap(([functionName, label]): string[] => {
        if (!new RegExp(`\\b${functionName}\\s*\\(`, "u").test(code)) return [];
        if (!new RegExp(`\\b${functionName}\\s*\\(\\s*\\{\\s*query\\s*:`, "u").test(code)) {
          return [`${label}:flat`];
        }
        if (!new RegExp(`\\b${functionName}\\s*\\(\\s*\\{\\s*query\\s*:\\s*\\{`, "u").test(code)) {
          return [`${label}:query-scalar`];
        }
        return [new RegExp(`\\b${functionName}\\s*\\(\\s*\\{\\s*query\\s*:\\s*\\{[^}]*\\btext\\s*:`, "u").test(code)
          ? `${label}:query-text`
          : `${label}:query-other`];
      });
      onDiagnostic?.({
        kind: "eval-step",
        status: "started",
        codeChars: code.length,
        capabilityNames,
        usesToolsNamespace: /\btools\s*\./u.test(code),
        searchInputShapes,
      });
      try {
        const response = await handler(request);
        onDiagnostic?.({
          kind: "eval-step",
          status: "success",
          ...evalResultDiagnostic(response),
        });
        return response;
      } catch (error) {
        const name = error instanceof Error ? error.name : "unknown";
        const allowed = new Set(["SyntaxError", "ReferenceError", "TypeError", "Error"]);
        onDiagnostic?.({
          kind: "eval-step",
          status: "error",
          errorKind: allowed.has(name)
            ? name as "SyntaxError" | "ReferenceError" | "TypeError" | "Error"
            : "unknown",
          errorCode: "other",
        });
        throw error;
      }
    },
  });
}


export interface ChatAgentRuntimeBindings {
  StateBackend: typeof import("deepagents/browser").StateBackend;
  createDeepAgent: typeof import("deepagents/browser").createDeepAgent;
  registerHarnessProfile: typeof import("deepagents/browser").registerHarnessProfile;
}

export interface RunChatAgentInput {
  apiKey?: string;
  model?: BaseChatModel;
  modelBinding?: ChatModelBindingV1;
  turn: ChatTurnRequestV1;
  /** Temporary host adapter until the capability broker accepts ChatTurnRequestV1 directly. */
  brokerRequest: ResearchRequestV1;
  providers: ResearchReadProviders;
  budget?: ResearchRunBudget;
  workspace: ResearchWorkspace;
  qualityPolicy?: ChatQualityPolicyV1;
  signal?: AbortSignal;
  now?: () => number;
  onProgress?: (progress: ResearchProgressV1) => void;
  onEvent?: (event: ResearchOneShotEventV1) => void;
  onPtcDiagnostic?: (diagnostic: ResearchPtcDiagnosticV1) => void;
  onAgentDiagnostic?: (diagnostic: ChatAgentDiagnosticV1) => void;
}

function collectUsage(messages: unknown): ResearchRunUsageV1 | undefined {
  if (!Array.isArray(messages)) return undefined;
  let inputTokens = 0;
  let outputTokens = 0;
  let found = false;
  for (const message of messages as AIMessage[]) {
    if (!message.usage_metadata) continue;
    found = true;
    inputTokens += message.usage_metadata.input_tokens ?? 0;
    outputTokens += message.usage_metadata.output_tokens ?? 0;
  }
  return found ? { inputTokens, outputTokens } : undefined;
}

function normalizeStoredChatSessionStateV1(
  value: unknown,
  expectedConversationId: string,
): ChatSessionStateV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ChatContractError("invalid-request", "Stored Chat state is incompatible with this runtime.");
  }
  const state = value as Partial<ChatSessionStateV1>;
  if (
    state.schema !== CHAT_SESSION_STATE_SCHEMA_V1 ||
    state.conversationId !== expectedConversationId ||
    !state.qualityPolicy
  ) {
    throw new ChatContractError("invalid-request", "Stored Chat state is incompatible with this runtime.");
  }
  return {
    schema: CHAT_SESSION_STATE_SCHEMA_V1,
    conversationId: expectedConversationId,
    qualityPolicy: normalizeChatQualityPolicyV1(state.qualityPolicy),
  };
}

async function bindChatSessionStateV1(input: {
  workspace: ResearchWorkspace;
  conversationId: string;
  qualityPolicy: ChatQualityPolicyV1;
}): Promise<void> {
  const stored = await input.workspace.readFile(CHAT_SESSION_STATE_PATH_V1);
  if (stored !== undefined) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(stored);
    } catch {
      throw new ChatContractError("invalid-request", "Stored Chat state is incompatible with this runtime.");
    }
    normalizeStoredChatSessionStateV1(parsed, input.conversationId);
  }
  await input.workspace.writeFile(
    CHAT_SESSION_STATE_PATH_V1,
    JSON.stringify(createChatSessionStateV1(input)),
  );
}

function emitPtcEventFactory(input: {
  onEvent?: (event: ResearchOneShotEventV1) => void;
  onDiagnostic?: (diagnostic: ResearchPtcDiagnosticV1) => void;
  now: () => number;
}): (diagnostic: ResearchPtcDiagnosticV1) => void {
  let seq = 0;
  return (diagnostic) => {
    input.onDiagnostic?.(diagnostic);
    input.onEvent?.({
      kind: "capability",
      seq: ++seq,
      at: new Date(input.now()).toISOString(),
      callId: diagnostic.callId,
      toolId: diagnostic.tool,
      inputKind: diagnostic.inputKind,
      status: diagnostic.outcome === "started"
        ? "started"
        : diagnostic.outcome === "success"
          ? "completed"
          : "failed",
      ...(diagnostic.itemCount === undefined ? {} : { itemCount: diagnostic.itemCount }),
      ...(diagnostic.itemLabels ? { itemLabels: diagnostic.itemLabels } : {}),
      ...(diagnostic.complete === undefined ? {} : { complete: diagnostic.complete }),
      ...(diagnostic.termination ? { termination: diagnostic.termination } : {}),
      ...(diagnostic.resultBytes === undefined ? {} : { resultBytes: diagnostic.resultBytes }),
      ...(diagnostic.truncated === undefined ? {} : { truncated: diagnostic.truncated }),
      ...(diagnostic.durationMs === undefined ? {} : { durationMs: diagnostic.durationMs }),
      ...(diagnostic.errorCode ? { errorCode: diagnostic.errorCode } : {}),
      ...(diagnostic.inputKeys ? { inputKeys: diagnostic.inputKeys } : {}),
      ...(diagnostic.queryKeys ? { queryKeys: diagnostic.queryKeys } : {}),
    });
  };
}

export function createKiteweaveChatAgent(
  runtime: ChatAgentRuntimeBindings,
  options: { defaultModelFactory?: ChatModelFactoryV1 } = {},
): {
  runChatAgent(input: RunChatAgentInput): Promise<ChatAnswerV1>;
} {
  return {
    async runChatAgent(input): Promise<ChatAnswerV1> {
      const turn = normalizeChatTurnRequestV1(input.turn);
      const qualityPolicy = normalizeChatQualityPolicyV1(
        input.qualityPolicy ?? chatQualityPolicyV1("auto"),
      );
      const now = input.now ?? Date.now;
      const startedAtMs = now();
      const budget = input.budget ?? new ResearchRunBudget(input.brokerRequest.limits);
      const broker = new ResearchCapabilityBroker(
        input.brokerRequest,
        input.providers,
        {
          budget,
          scopeBindings: input.brokerRequest.scopeSeeds?.map((seed) => seed.binding),
        },
      );
      const controller = new AbortController();
      const forwardAbort = (): void => controller.abort(input.signal?.reason);
      if (input.signal?.aborted) forwardAbort();
      else input.signal?.addEventListener("abort", forwardAbort, { once: true });
      const timeout = globalThis.setTimeout(
        () => controller.abort(new ChatContractError("limit-exceeded", "The Chat turn reached its maximum duration.")),
        turn.limits.maxRunMs,
      );
      const onAbort = (): void => broker.cancel(controller.signal.reason);
      controller.signal.addEventListener("abort", onAbort, { once: true });
      try {
        await bindChatSessionStateV1({
          workspace: input.workspace,
          conversationId: turn.conversationId,
          qualityPolicy,
        });
        input.onProgress?.({
          phase: "preparing",
          message: "Preparing the bounded Chat turn.",
          completedCalls: 0,
          maxCalls: turn.limits.maxPtcCalls,
        });
        const anchors = broker.exactAnchors();
        const ptcTools = createChatPtcToolsV1(broker, {
          now,
          exactContextProducts: turn.exactContextProducts,
          searchProducts: [
            ...(turn.scope.jiraProjectKeys.length > 0 ? ["jira" as const] : []),
            ...(turn.scope.confluenceSpaceKeys.length > 0 ? ["confluence" as const] : []),
          ],
          onDiagnostic: emitPtcEventFactory({
            onEvent: input.onEvent,
            onDiagnostic: input.onPtcDiagnostic,
            now,
          }),
        });
        const modelBinding = input.modelBinding ?? (input.model
          ? {
              model: input.model,
              modelId: input.model.getName?.() || "injected-langchain-model",
              qualityAdapter: CAPABILITY_FREE_QUALITY_ADAPTER_V1,
              structuredOutput: "tool" as const,
            }
          : options.defaultModelFactory?.({
              credential: input.apiKey ?? "",
              maxOutputTokens: turn.limits.maxModelOutputTokens,
              qualityPolicy,
            }));
        if (!modelBinding) {
          throw new ChatContractError(
            "invalid-request",
            "The Chat host did not bind a LangChain chat model.",
          );
        }
        const model = modelBinding.model;
        let structuredRepairAttempts = 0;
        const agent = runtime.createDeepAgent({
          name: "kiteweave-chat-agent",
          model,
          backend: new runtime.StateBackend(),
          tools: [],
          subagents: [],
          systemPrompt: buildChatSystemPromptV1({
            qualityMode: qualityPolicy.mode,
            maxDetailItemsPerProduct: turn.limits.maxDetailItemsPerProduct,
          }),
          middleware: [
            createCodeInterpreterMiddleware({
              ptc: ptcTools,
              subagents: false,
              toolName: "eval",
              systemPrompt: "The eval tool runs JavaScript in a persistent QuickJS REPL. Top-level await is available. Return the useful value as the final expression; console is intentionally unavailable. External reads are possible only through the documented tools.* functions.",
              memoryLimitBytes: turn.limits.maxInterpreterMemoryBytes,
              maxStackSizeBytes: 320 * 1024,
              executionTimeoutMs: turn.limits.maxInterpreterMs,
              maxPtcCalls: turn.limits.maxPtcCalls,
              maxResultChars: Math.min(
                turn.limits.maxPtcOutputBytes,
                Math.max(24_000, turn.limits.maxReportChars),
              ),
              captureConsole: false,
            }),
            createChatDirectToolSurfaceMiddlewareV1(input.onAgentDiagnostic),
          ],
          responseFormat: modelBinding.structuredOutput === "tool"
            ? toolStrategy(CHAT_AGENT_DRAFT_SCHEMA_V1, {
                handleError: (error) => {
                  structuredRepairAttempts += 1;
                  if (structuredRepairAttempts > 1) throw error;
                  return "The Chat answer did not match the required schema. Repair it exactly once without another tool call.";
                },
                toolMessageContent: "Chat answer accepted.",
              })
            : providerStrategy(providerCompatibleChatAnswerSchemaV1()),
        });
        input.onProgress?.({
          phase: "researching",
          message: "Reading only the Atlassian context needed for this answer.",
          completedCalls: 0,
          maxCalls: turn.limits.maxPtcCalls,
        });
        const result = await agent.invoke(
          {
            messages: [{
              role: "user",
              content: buildChatTurnPromptV1({
                question: turn.question,
                jiraProjectKeys: turn.scope.jiraProjectKeys,
                confluenceSpaceKeys: turn.scope.confluenceSpaceKeys,
                anchors,
              }),
            }],
          },
          {
            configurable: { thread_id: `chat-turn:${turn.turnId}` },
            recursionLimit: chatRecursionLimitV1(turn.limits.maxPtcCalls),
            signal: controller.signal,
          },
        );
        controller.signal.throwIfAborted();
        const completedAtMs = now();
        const answer = finalizeChatAnswerV1({
          draft: result.structuredResponse,
          sources: broker.sourceLedger(),
          detailEvidence: broker.detailEvidenceLedger(),
          qualityPolicy,
          run: {
            model: modelBinding.modelId,
            startedAt: new Date(startedAtMs).toISOString(),
            completedAt: new Date(completedAtMs).toISOString(),
            durationMs: Math.max(0, completedAtMs - startedAtMs),
            counts: broker.budget.counts(),
            ...(collectUsage(result.messages) ? { usage: collectUsage(result.messages) } : {}),
          },
        });
        await input.workspace.writeFile("/.atlcli/chat/v1/answer.md", answer.messageMarkdown);
        input.onProgress?.({
          phase: "complete",
          message: "Chat answer complete.",
          completedCalls: answer.run.counts.ptcCalls,
          maxCalls: turn.limits.maxPtcCalls,
        });
        return answer;
      } catch (error) {
        if (controller.signal.aborted) {
          throw controller.signal.reason instanceof Error
            ? controller.signal.reason
            : new ChatContractError("cancelled", "The Chat turn was cancelled.");
        }
        throw error;
      } finally {
        globalThis.clearTimeout(timeout);
        input.signal?.removeEventListener("abort", forwardAbort);
        controller.signal.removeEventListener("abort", onAbort);
        broker.cancel();
      }
    },
  };
}
