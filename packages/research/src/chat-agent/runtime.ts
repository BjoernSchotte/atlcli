import { createCodeInterpreterMiddleware } from "@langchain/quickjs";
import { createMiddleware, providerStrategy, toolStrategy } from "langchain";
import { AIMessage } from "@langchain/core/messages";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { type ResearchPtcDiagnosticV1 } from "../agent-tools.js";
import {
  ResearchCapabilityBroker,
  type ResearchReadProviders,
} from "../broker.js";
import { ResearchRunBudget } from "../budget.js";
import type {
  ChatPresentationStreamEventV1,
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
import type { ResearchDispatchDiagnosticV1 } from "../dispatch-adapter.js";
import { finalizeChatAnswerV1 } from "./answer.js";
import { deriveChatAuxiliaryReadNeedsV1 } from "./auxiliary.js";
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
import {
  ChatCandidateLedgerControllerV1,
  createChatRetrievalPlanV1,
  type ChatRetrievalPlanProposalV1,
} from "./retrieval-plan.js";
import type { ChatModelBindingV1, ChatModelFactoryV1 } from "./model.js";
import {
  CHAT_STRATEGY_RECORD_SCHEMA_V1,
  CHAT_STRATEGY_REVIEW_RECORD_SCHEMA_V1,
  CHAT_STRATEGY_REVIEW_STATE_PATH_V1,
  CHAT_STRATEGY_STATE_PATH_V1,
  createChatStrategyDecisionControllerV1,
  createChatStrategyReviewControllerV1,
  deriveChatStrategyDecisionV1,
  type ChatStrategyDecisionV1,
  type ChatStrategyRecordV1,
  type ChatStrategyReviewRecordV1,
} from "./strategy.js";
import {
  createChatAgenticWorkflowRuntimeV1,
  type ChatSubagentResultDiagnosticV1,
} from "./workflow-runtime.js";

export function chatRecursionLimitV1(maxPtcCalls: number): number {
  const boundedCalls = Math.max(1, Math.min(24, Math.trunc(maxPtcCalls)));
  // A ReAct capability round consumes at least one model node and one tool
  // node. Keep room for the initial decision and terminal structured answer,
  // while retaining a hard graph ceiling independent of provider behavior.
  return Math.min(64, Math.max(24, boundedCalls * 2 + 8));
}

/**
 * Agentic Chat must retain one host-tool slot for its mandatory final evidence
 * review. Acquisition is allowed to consume the rest of the bounded envelope,
 * but cannot make the final quality gate unreachable.
 */
export function assertChatFinalReviewReserveV1(input: {
  strategy?: ChatStrategyDecisionV1;
  budget: ResearchRunBudget;
  maxPtcCalls: number;
}): void {
  if (input.strategy?.execution !== "agentic") return;
  if (input.budget.counts().ptcCalls >= input.maxPtcCalls - 1) {
    throw new ChatContractError(
      "limit-exceeded",
      "The Chat acquisition budget is complete; the reserved final evidence review must run next.",
    );
  }
}

export type ChatAgentDiagnosticV1 =
  | {
      kind: "model-step";
      status: "started" | "completed" | "failed";
      purpose: "planning" | "evidence-assessment" | "answer-drafting";
      toolNames?: string[];
      stopReason?: string;
    }
  | {
      kind: "eval-step";
      status: "started" | "success" | "error";
      /** Present only for a depth-one specialist eval; absent means the root supervisor. */
      profileId?: string;
      attempt?: number;
      subagentErrorCode?: string;
      resultChars?: number;
      errorKind?: "SyntaxError" | "ReferenceError" | "TypeError" | "Error" | "unknown";
      errorCode?: "tools-unavailable" | "capability-unavailable" | "undefined-symbol" | "syntax" | "other";
      codeChars?: number;
      capabilityNames?: string[];
      usesToolsNamespace?: boolean;
      searchInputShapes?: string[];
      argumentKeys?: string[];
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
      : /\b(?:chatStrategyDecide|chatStrategyReview|atlassianBoundRead|atlassianBoundSectionRead|jiraIssueSearch|jiraIssueGet|wikiSearch|wikiPageGet|researchCandidateRank)\b[^\n]*(?:not a function|not defined|unavailable)/iu.test(rendered)
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
  options: { agenticWorkflowComplete?: () => boolean } = {},
) {
  let completedEvidenceStep = false;
  let completedFinalReview = false;
  const modelPurpose = (): Extract<ChatAgentDiagnosticV1, { kind: "model-step" }>['purpose'] =>
    completedFinalReview || completedEvidenceStep
      ? "answer-drafting"
      : "planning";
  return createMiddleware({
    name: "ChatDirectToolSurfaceMiddleware",
    async wrapModelCall(request, handler) {
      const purpose = modelPurpose();
      onDiagnostic?.({ kind: "model-step", status: "started", purpose });
      if (options.agenticWorkflowComplete?.()) {
        // The dedicated synthesizer is authoritative. Close the root graph
        // without paying for (or exposing) a second supervisor rewrite after
        // the final task result returns to the persistent QuickJS session.
        const response = new AIMessage({ content: "Agentic Chat synthesis accepted." });
        onDiagnostic?.({
          kind: "model-step",
          status: "completed",
          purpose,
          ...diagnosticMessage(response),
        });
        return response;
      }
      try {
        const response = await handler({
          ...request,
          // createDeepAgent always assembles filesystem and task scaffolding.
          // Direct Chat deliberately exposes only the host-audited QuickJS bridge;
          // structured-output tools are bound by LangChain after this middleware.
          tools: request.tools.filter((candidate) => candidate.name === "eval"),
        });
        onDiagnostic?.({
          kind: "model-step",
          status: "completed",
          purpose,
          ...diagnosticMessage(response),
        });
        return response;
      } catch (error) {
        onDiagnostic?.({ kind: "model-step", status: "failed", purpose });
        throw error;
      }
    },
    async wrapToolCall(request, handler) {
      if (request.toolCall.name !== "eval") return handler(request);
      const code = request.toolCall.args && typeof request.toolCall.args === "object" &&
        "code" in request.toolCall.args && typeof request.toolCall.args.code === "string"
        ? request.toolCall.args.code
        : "";
      const capabilityNames = [
        "chatStrategyDecide",
        "chatWorkflowPropose",
        "chatStrategyReview",
        "jiraIssueSearch",
        "jiraIssueGet",
        "wikiSearch",
        "wikiPageGet",
        "researchCandidateRank",
        "atlassianBoundRead",
        "atlassianBoundSectionRead",
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
        completedEvidenceStep ||= capabilityNames.some((name) => [
          "jiraIssueSearch",
          "jiraIssueGet",
          "wikiSearch",
          "wikiPageGet",
          "researchCandidateRank",
          "atlassianBoundRead",
          "atlassianBoundSectionRead",
        ].includes(name));
        completedFinalReview ||= capabilityNames.includes("chatStrategyReview");
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

/** Replace DeepAgentsJS's built-in task registry until C5 installs audited Chat profiles. */
export function createChatNoSubagentMiddlewareV1() {
  return createMiddleware({ name: "subAgentMiddleware" });
}

function createChatCodeInterpreterMiddlewareV1(
  options: Parameters<typeof createCodeInterpreterMiddleware>[0] & {
    agentic?: boolean;
    /** Host-audited task tool that QuickJS may bridge but the provider may not see. */
    taskBridgeTool?: unknown;
  },
) {
  const { taskBridgeTool, ...interpreterOptions } = options;
  const middleware = createCodeInterpreterMiddleware(interpreterOptions);
  const upstreamWrapModelCall = middleware.wrapModelCall;
  if (taskBridgeTool && upstreamWrapModelCall) {
    middleware.wrapModelCall = (request, handler) => {
      const bridgeTool = taskBridgeTool as (typeof request.tools)[number];
      const toolsForInterpreter = request.tools.some((candidate) => candidate.name === "task")
        ? request.tools
        : [...request.tools, bridgeTool];
      return upstreamWrapModelCall(
        { ...request, tools: toolsForInterpreter },
        (providerRequest) => handler({
          ...providerRequest,
          tools: providerRequest.tools.filter((candidate) => candidate.name !== "task"),
        }),
      );
    };
  }
  const evaluator = middleware.tools?.find(
    (candidate) => candidate.name === (options.toolName ?? "eval"),
  );
  if (!evaluator) {
    throw new ChatContractError(
      "invalid-request",
      "QuickJS did not provide the Chat eval tool.",
    );
  }
  if (options.agentic) {
    evaluator.description = [
      "Advance the host-bounded agentic Chat workflow in a persistent QuickJS session.",
      "First acknowledge chatStrategyDecide, then call chatWorkflowPropose exactly once. The calls may be separate eval steps; the host keeps their accepted state.",
      "Execute only returned task dispatches in dependency order and run ready siblings with awaited Promise.all.",
      "After every non-synthesizer task completes, call chatStrategyReview. Then execute the sole returned synthesizer dispatch.",
      "Copy every task description, subagentType, and responseSchema exactly from the host response. Never invent a task, schema, dependency, or second synthesizer.",
    ].join(" ");
  }
  return middleware;
}


export interface ChatAgentRuntimeBindings {
  StateBackend: typeof import("deepagents/browser").StateBackend;
  createDeepAgent: typeof import("deepagents/browser").createDeepAgent;
  createSubAgentMiddleware:
    typeof import("deepagents/browser").createSubAgentMiddleware;
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
  onChatPresentation?: (event: ChatPresentationStreamEventV1) => void;
  onPtcDiagnostic?: (diagnostic: ResearchPtcDiagnosticV1) => void;
  onAgentDiagnostic?: (diagnostic: ChatAgentDiagnosticV1) => void;
  onDispatchDiagnostic?: (diagnostic: ResearchDispatchDiagnosticV1) => void;
  onSubagentResultDiagnostic?: (diagnostic: ChatSubagentResultDiagnosticV1) => void;
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

/**
 * Project one JSON string field from a streamed native structured-output
 * envelope. It never exposes the envelope, neighbouring fields, or an
 * incomplete escape sequence to presentation consumers.
 */
export function streamedJsonStringFieldV1(
  input: string,
  fieldName: string,
): string | undefined {
  const marker = JSON.stringify(fieldName);
  const markerIndex = input.indexOf(marker);
  if (markerIndex < 0) return undefined;
  let cursor = markerIndex + marker.length;
  while (/\s/u.test(input[cursor] ?? "")) cursor += 1;
  if (input[cursor] !== ":") return undefined;
  cursor += 1;
  while (/\s/u.test(input[cursor] ?? "")) cursor += 1;
  if (input[cursor] !== '"') return undefined;
  cursor += 1;

  let value = "";
  while (cursor < input.length) {
    const character = input[cursor]!;
    if (character === '"') return value;
    if (character !== "\\") {
      value += character;
      cursor += 1;
      continue;
    }
    if (cursor + 1 >= input.length) return value;
    const escaped = input[cursor + 1]!;
    const simpleEscapes: Record<string, string> = {
      '"': '"',
      "\\": "\\",
      "/": "/",
      b: "\b",
      f: "\f",
      n: "\n",
      r: "\r",
      t: "\t",
    };
    if (escaped in simpleEscapes) {
      value += simpleEscapes[escaped];
      cursor += 2;
      continue;
    }
    if (escaped !== "u" || cursor + 6 > input.length) return value;
    const unit = input.slice(cursor + 2, cursor + 6);
    if (!/^[0-9a-f]{4}$/iu.test(unit)) return value;
    value += String.fromCharCode(Number.parseInt(unit, 16));
    cursor += 6;
  }
  return value;
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
  nextSequence: () => number;
}): (diagnostic: ResearchPtcDiagnosticV1) => void {
  return (diagnostic) => {
    input.onDiagnostic?.(diagnostic);
    input.onEvent?.({
      kind: "capability",
      seq: input.nextSequence(),
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
      let eventSequence = 0;
      const nextEventSequence = (): number => ++eventSequence;
      const emitPhase = (phase: string): void => {
        input.onEvent?.({
          kind: "phase",
          seq: nextEventSequence(),
          at: new Date(now()).toISOString(),
          phase,
        });
      };
      const emitAgentDiagnostic = (diagnostic: ChatAgentDiagnosticV1): void => {
        input.onAgentDiagnostic?.(diagnostic);
        const activity = diagnostic.kind === "model-step"
          ? diagnostic.status === "started"
            ? diagnostic.purpose === "answer-drafting"
              ? { code: "answer-drafting" as const, status: "started" as const }
              : { code: "model-assessing" as const, status: "started" as const }
            : diagnostic.status === "failed"
              ? { code: "model-assessing" as const, status: "failed" as const }
              : diagnostic.toolNames?.includes("eval")
                ? { code: "next-step-ready" as const, status: "completed" as const }
                : { code: "answer-draft-ready" as const, status: "completed" as const }
          : diagnostic.status === "started"
            ? { code: "bounded-workflow-running" as const, status: "started" as const }
            : diagnostic.status === "success"
              ? { code: "bounded-workflow-complete" as const, status: "completed" as const }
              : { code: "bounded-workflow-failed" as const, status: "failed" as const };
        input.onEvent?.({
          kind: "activity",
          seq: nextEventSequence(),
          at: new Date(now()).toISOString(),
          ...activity,
        });
      };
      let assertStrategyAccepted: (() => void) | undefined;
      let retrievalLedger: ChatCandidateLedgerControllerV1 | undefined;
      let strategyForFinalReviewReserve: ChatStrategyDecisionV1 | undefined;
      const broker = new ResearchCapabilityBroker(
        input.brokerRequest,
        input.providers,
        {
          budget,
          scopeBindings: input.brokerRequest.scopeSeeds?.map((seed) => seed.binding),
          exactAuxiliaryNeeds: deriveChatAuxiliaryReadNeedsV1(turn.question),
          beforeContentOperation: () => {
            assertStrategyAccepted?.();
            if (!retrievalLedger) {
              throw new ChatContractError(
                "invalid-request",
                "The Chat retrieval plan must be persisted before content access.",
              );
            }
            assertChatFinalReviewReserveV1({
              strategy: strategyForFinalReviewReserve,
              budget,
              maxPtcCalls: turn.limits.maxPtcCalls,
            });
          },
          onRelatedScopeCandidate: (candidate) => {
            if (!retrievalLedger) {
              throw new ChatContractError(
                "invalid-request",
                "The Chat retrieval ledger must exist before related scope is observed.",
              );
            }
            return retrievalLedger.observeRelatedScopeCandidate(candidate);
          },
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
        emitPhase("preparing");
        const anchors = broker.exactAnchors();
        const strategyDecision = deriveChatStrategyDecisionV1({
          qualityPolicy,
          question: turn.question,
          scope: turn.scope,
          anchors,
        });
        strategyForFinalReviewReserve = strategyDecision;
        let acceptedStrategy: ChatStrategyDecisionV1 | undefined;
        const persistAcceptedStrategy = async (
          decision: ChatStrategyDecisionV1,
        ): Promise<void> => {
          if (acceptedStrategy) {
            throw new ChatContractError(
              "invalid-request",
              "The Chat strategy decision was already recorded.",
            );
          }
          acceptedStrategy = structuredClone(decision);
          const acceptedAt = new Date(now()).toISOString();
          const record: ChatStrategyRecordV1 = {
            schema: CHAT_STRATEGY_RECORD_SCHEMA_V1,
            conversationId: turn.conversationId,
            turnId: turn.turnId,
            acceptedAt,
            decision: structuredClone(decision),
          };
          await input.workspace.writeFile(
            CHAT_STRATEGY_STATE_PATH_V1,
            JSON.stringify(record),
          );
          input.onEvent?.({
            kind: "decision",
            seq: nextEventSequence(),
            at: acceptedAt,
            decisionId: `chat-strategy:${turn.turnId.slice(0, 180)}`,
            status: "completed",
            reasonCode: decision.execution === "agentic"
              ? "chat-agentic-required"
              : `chat-${decision.qualityMode}-direct`,
          });
        };
        const strategyController = qualityPolicy.mode === "quick"
          ? undefined
          : createChatStrategyDecisionControllerV1({
              decision: strategyDecision,
              budget,
            });
        await persistAcceptedStrategy(strategyDecision);
        assertStrategyAccepted = strategyController?.assertAcknowledged;
        const strategyReviewController = strategyDecision.execution === "agentic"
          ? createChatStrategyReviewControllerV1({
              decision: strategyDecision,
              budget,
              beforeReview: strategyController?.assertAcknowledged,
              detailEvidence: () => broker.detailEvidenceLedger(),
              onReviewed: async (review) => {
                const record: ChatStrategyReviewRecordV1 = {
                  schema: CHAT_STRATEGY_REVIEW_RECORD_SCHEMA_V1,
                  conversationId: turn.conversationId,
                  turnId: turn.turnId,
                  reviewedAt: new Date(now()).toISOString(),
                  review,
                };
                await input.workspace.writeFile(
                  CHAT_STRATEGY_REVIEW_STATE_PATH_V1,
                  JSON.stringify(record),
                );
              },
            })
          : undefined;
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
        const searchProducts = [
          ...(turn.scope.jiraProjectKeys.length > 0 ? ["jira" as const] : []),
          ...(turn.scope.confluenceSpaceKeys.length > 0 ? ["confluence" as const] : []),
        ];
        const buildRetrievalPlan = (
          proposal?: ChatRetrievalPlanProposalV1,
        ) => createChatRetrievalPlanV1({
          conversationId: turn.conversationId,
          turnId: turn.turnId,
          question: turn.question,
          anchors,
          scopeBindings: input.brokerRequest.scopeSeeds?.map((seed) => seed.binding) ?? [],
          boundProjectKeys: turn.scope.jiraProjectKeys,
          boundSpaceKeys: turn.scope.confluenceSpaceKeys,
          searchProducts,
          exactContextProducts: turn.exactContextProducts ?? [],
          limits: turn.limits,
          agentic: strategyDecision.execution === "agentic",
          ...(proposal ? { proposal } : {}),
          now,
        });
        const retrievalPlan = buildRetrievalPlan();
        retrievalLedger = new ChatCandidateLedgerControllerV1({
          plan: retrievalPlan,
          workspace: input.workspace,
          siteOrigin: turn.scope.siteOrigin,
          now,
        });
        await retrievalLedger.initialize();
        const emitPtcDiagnostic = emitPtcEventFactory({
          onEvent: (event) => {
            input.onEvent?.(event);
            if (
              event.kind === "capability" &&
              event.status === "completed" &&
              ["detail", "reference"].includes(event.inputKind)
            ) {
              emitPhase("analyzing");
            }
          },
          onDiagnostic: input.onPtcDiagnostic,
          now,
          nextSequence: nextEventSequence,
        });
        const agenticWorkflow = strategyDecision.execution === "agentic"
          ? createChatAgenticWorkflowRuntimeV1({
              runtime,
              model,
              ...(modelBinding.modelForPreference
                ? { modelForPreference: modelBinding.modelForPreference }
                : {}),
              structuredOutput: modelBinding.structuredOutput,
              ...(modelBinding.projectResponseSchema
                ? { projectResponseSchema: modelBinding.projectResponseSchema }
                : {}),
              strategy: strategyDecision,
              budget,
              broker,
              workspace: input.workspace,
              conversationId: turn.conversationId,
              turnId: turn.turnId,
              taskContext: () => {
                const currentRetrievalPlan = retrievalLedger!.plan();
                return JSON.stringify({
                  question: turn.question,
                  scope: turn.scope,
                  anchors,
                  retrieval: {
                    searches: currentRetrievalPlan.searches.map((search) => ({
                      searchId: search.searchId,
                      product: search.product,
                      variants: search.variants,
                      maxPages: search.maxPages,
                    })),
                    relationshipTraversals: currentRetrievalPlan.relationshipTraversals,
                    completionSignals: currentRetrievalPlan.completionSignals,
                    unresolvedTerms: currentRetrievalPlan.unresolvedTerms,
                  },
                });
              },
              limits: turn.limits,
              exactContextProducts: turn.exactContextProducts ?? [],
              searchProducts,
              boundProjectKeys: turn.scope.jiraProjectKeys,
              boundSpaceKeys: turn.scope.confluenceSpaceKeys,
              signal: controller.signal,
              beforeProposal: strategyController?.assertAcknowledged,
              beforeWorkflowAdmission: async (proposal) => {
                if (!proposal.retrievalPlan) return;
                await retrievalLedger!.replacePlan(buildRetrievalPlan(proposal.retrievalPlan));
              },
              beforeSynthesis: async () => {
                strategyReviewController?.assertCurrent();
                await retrievalLedger!.finalize();
              },
              retrievalLedger,
              now,
              onPtcDiagnostic: (profileId, diagnostic) => emitPtcDiagnostic({
                ...diagnostic,
                callId: `${profileId}:${diagnostic.callId}`,
              }),
              onEvalDiagnostic: (diagnostic) => emitAgentDiagnostic({
                kind: "eval-step",
                status: diagnostic.status,
                profileId: diagnostic.profileId,
                attempt: diagnostic.attempt,
                ...(diagnostic.errorKind && [
                  "SyntaxError",
                  "ReferenceError",
                  "TypeError",
                  "Error",
                ].includes(diagnostic.errorKind)
                  ? {
                      errorKind: diagnostic.errorKind as
                        | "SyntaxError"
                        | "ReferenceError"
                        | "TypeError"
                        | "Error",
                    }
                  : {}),
                ...(diagnostic.errorCode
                  ? { subagentErrorCode: diagnostic.errorCode }
                  : {}),
                ...(diagnostic.codeChars === undefined
                  ? {}
                  : { codeChars: diagnostic.codeChars }),
                ...(diagnostic.usesToolsNamespace === undefined
                  ? {}
                  : { usesToolsNamespace: diagnostic.usesToolsNamespace }),
                ...(diagnostic.capabilityNames === undefined
                  ? {}
                  : { capabilityNames: diagnostic.capabilityNames }),
                ...(diagnostic.searchInputShapes === undefined
                  ? {}
                  : { searchInputShapes: diagnostic.searchInputShapes }),
                ...(diagnostic.argumentKeys === undefined
                  ? {}
                  : { argumentKeys: diagnostic.argumentKeys }),
                ...(diagnostic.errorCode ? { errorCode: "other" as const } : {}),
              }),
              onResultDiagnostic: input.onSubagentResultDiagnostic,
              onDispatchDiagnostic: (diagnostic) => {
                input.onDispatchDiagnostic?.(diagnostic);
                if (!diagnostic.taskId) return;
                input.onEvent?.({
                  kind: "task",
                  seq: nextEventSequence(),
                  at: new Date(now()).toISOString(),
                  taskId: diagnostic.taskId,
                  status: diagnostic.status,
                  ...(diagnostic.resultBytes === undefined
                    ? {}
                    : { resultBytes: diagnostic.resultBytes }),
                });
                if (
                  (diagnostic.status === "failed" || diagnostic.status === "cancelled") &&
                  !controller.signal.aborted
                ) {
                  controller.abort(new ChatContractError(
                    diagnostic.code === "timeout" ? "limit-exceeded" : "invalid-report",
                    "A bounded Chat specialist did not complete; the turn stopped before synthesis.",
                  ));
                }
              },
            })
          : undefined;
        const ptcTools = strategyDecision.execution === "agentic"
          ? [
              ...(strategyController ? [strategyController.tool] : []),
              agenticWorkflow!.proposalTool,
              ...(strategyReviewController ? [strategyReviewController.tool] : []),
            ]
          : [
              ...(strategyController ? [strategyController.tool] : []),
              ...createChatPtcToolsV1(broker, {
                now,
                exactContextProducts: turn.exactContextProducts,
                searchProducts,
                boundProjectKeys: turn.scope.jiraProjectKeys,
                boundSpaceKeys: turn.scope.confluenceSpaceKeys,
                onDiagnostic: emitPtcDiagnostic,
                beforeInvoke: (tool, value) =>
                  retrievalLedger!.assertToolInput(tool, value),
                onResult: (tool, result, callId, value) =>
                  retrievalLedger!.observe(tool, result, callId, value),
              }),
            ];
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
            strategyDecisionRequired: strategyController !== undefined,
            agenticWorkflowRequired: strategyDecision.execution === "agentic",
          }),
          middleware: [
            agenticWorkflow?.middleware ?? createChatNoSubagentMiddlewareV1(),
            createChatCodeInterpreterMiddlewareV1({
              ptc: ptcTools,
              subagents: strategyDecision.execution === "agentic",
              ...(agenticWorkflow?.middleware.tools?.find((candidate) => candidate.name === "task")
                ? {
                    taskBridgeTool: agenticWorkflow.middleware.tools.find(
                      (candidate) => candidate.name === "task",
                    ),
                  }
                : {}),
              toolName: "eval",
              systemPrompt: strategyDecision.execution === "agentic"
                ? "The eval tool advances an agentic Chat workflow in a persistent QuickJS REPL. Top-level await and the depth-one task() bridge are available. Strategy, proposal, task waves, review, and synthesis may use separate eval calls; accepted host state persists. Use only host-returned dispatch fields and documented tools.* controls. Console is unavailable."
                : "The eval tool runs JavaScript in a persistent QuickJS REPL. Top-level await is available. Return the useful value as the final expression; console is intentionally unavailable. External reads are possible only through the documented tools.* functions. When chatStrategyDecide is present, call it exactly once before any Atlassian content capability.",
              memoryLimitBytes: turn.limits.maxInterpreterMemoryBytes,
              maxStackSizeBytes: 320 * 1024,
              executionTimeoutMs: strategyDecision.execution === "agentic"
                ? turn.limits.maxRunMs
                : turn.limits.maxInterpreterMs,
              maxPtcCalls: turn.limits.maxPtcCalls,
              maxResultChars: Math.min(
                turn.limits.maxPtcOutputBytes,
                Math.max(24_000, turn.limits.maxReportChars),
              ),
              captureConsole: false,
              agentic: strategyDecision.execution === "agentic",
            }),
            createChatDirectToolSurfaceMiddlewareV1(emitAgentDiagnostic, {
              ...(agenticWorkflow
                ? {
                    agenticWorkflowComplete: () => {
                      try {
                        agenticWorkflow.assertComplete();
                        return true;
                      } catch {
                        return false;
                      }
                    },
                  }
                : {}),
            }),
          ],
          ...(strategyDecision.execution === "agentic"
            ? {}
            : {
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
              }),
        });
        input.onProgress?.({
          phase: "researching",
          message: "Reading only the Atlassian context needed for this answer.",
          completedCalls: 0,
          maxCalls: turn.limits.maxPtcCalls,
        });
        const run = await agent.streamEvents(
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
            version: "v3",
            configurable: { thread_id: `chat-turn:${turn.turnId}` },
            recursionLimit: chatRecursionLimitV1(turn.limits.maxPtcCalls),
            signal: controller.signal,
          },
        );
        const streamPresentation = (async (): Promise<void> => {
          let emittedReasoningChars = 0;
          let emittedAnswerChars = 0;
          let nativeStructuredText = "";
          const maximumReasoningChars = 12_000;
          const maximumAnswerChars = turn.limits.maxReportChars;
          const consumeReasoning = async (source: AsyncIterable<string>): Promise<void> => {
            if (modelBinding.reasoningPresentation !== "summary") {
              for await (const _unused of source) {
                // Drain the projection. Unapproved reasoning never crosses the
                // host presentation boundary.
              }
              return;
            }
            let started = false;
            for await (const rawDelta of source) {
              if (emittedReasoningChars >= maximumReasoningChars) continue;
              const delta = rawDelta.slice(
                0,
                Math.min(1_024, maximumReasoningChars - emittedReasoningChars),
              );
              if (!delta) continue;
              if (!started) {
                started = true;
                input.onChatPresentation?.({
                  kind: "chat-presentation",
                  seq: nextEventSequence(),
                  at: new Date(now()).toISOString(),
                  channel: "reasoning-summary",
                  status: "started",
                });
              }
              emittedReasoningChars += delta.length;
              input.onChatPresentation?.({
                kind: "chat-presentation",
                seq: nextEventSequence(),
                at: new Date(now()).toISOString(),
                channel: "reasoning-summary",
                status: "delta",
                delta,
              });
            }
            if (started) {
              input.onChatPresentation?.({
                kind: "chat-presentation",
                seq: nextEventSequence(),
                at: new Date(now()).toISOString(),
                channel: "reasoning-summary",
                status: "completed",
              });
            }
          };
          const consumeAnswer = async (
            source: AsyncIterable<string>,
            allowed: boolean,
          ): Promise<void> => {
            if (!allowed || modelBinding.structuredOutput !== "native") {
              for await (const _unused of source) {
                // Tool-structured and unstructured text is not a safe
                // provisional Chat answer.
              }
              return;
            }
            let started = false;
            for await (const rawDelta of source) {
              nativeStructuredText += rawDelta;
              if (nativeStructuredText.length > maximumAnswerChars * 4) continue;
              const projected = streamedJsonStringFieldV1(
                nativeStructuredText,
                "messageMarkdown",
              ) ?? "";
              const bounded = projected.slice(0, maximumAnswerChars);
              if (bounded.length <= emittedAnswerChars) continue;
              const delta = bounded.slice(emittedAnswerChars);
              if (!started) {
                started = true;
                input.onChatPresentation?.({
                  kind: "chat-presentation",
                  seq: nextEventSequence(),
                  at: new Date(now()).toISOString(),
                  channel: "answer-markdown",
                  status: "started",
                });
              }
              emittedAnswerChars = bounded.length;
              for (let offset = 0; offset < delta.length; offset += 1_024) {
                input.onChatPresentation?.({
                  kind: "chat-presentation",
                  seq: nextEventSequence(),
                  at: new Date(now()).toISOString(),
                  channel: "answer-markdown",
                  status: "delta",
                  delta: delta.slice(offset, offset + 1_024),
                });
              }
            }
            if (started) {
              input.onChatPresentation?.({
                kind: "chat-presentation",
                seq: nextEventSequence(),
                at: new Date(now()).toISOString(),
                channel: "answer-markdown",
                status: "completed",
              });
            }
          };
          await Promise.all([
            (async () => {
              for await (const message of run.messages) {
                await Promise.all([
                  consumeReasoning(message.reasoning),
                  consumeAnswer(
                    message.text,
                    strategyDecision.execution !== "agentic",
                  ),
                ]);
              }
            })(),
            (async () => {
              if (strategyDecision.execution !== "agentic") return;
              const subagentStreams = (run as unknown as {
                subagents: AsyncIterable<{
                  name: string;
                  messages: AsyncIterable<{
                    reasoning: AsyncIterable<string>;
                    text: AsyncIterable<string>;
                  }>;
                }>;
              }).subagents;
              for await (const subagent of subagentStreams) {
                for await (const message of subagent.messages) {
                  await Promise.all([
                    consumeReasoning(message.reasoning),
                    consumeAnswer(
                      message.text,
                      subagent.name === "chat-synthesizer-v1",
                    ),
                  ]);
                }
              }
            })(),
          ]);
        })();
        const [result] = await Promise.all([run.output, streamPresentation]);
        controller.signal.throwIfAborted();
        emitPhase("checking");
        if (strategyController && !strategyController.acknowledgedDecision()) {
          throw new ChatContractError(
            "invalid-report",
            "The Chat answer was produced without acknowledging its accepted strategy decision.",
          );
        }
        strategyReviewController?.assertCurrent();
        const finalStrategy = acceptedStrategy;
        if (!finalStrategy) {
          throw new ChatContractError(
            "invalid-report",
            "The Chat answer was produced without an accepted strategy decision.",
          );
        }
        const finalDraft = agenticWorkflow
          ? agenticWorkflow.assertComplete()
          : result.structuredResponse;
        if (!agenticWorkflow) await retrievalLedger.finalize();
        const retrievalAssessment = retrievalLedger.assessment();
        emitPhase("rendering");
        const completedAtMs = now();
        const answer = finalizeChatAnswerV1({
          draft: finalDraft,
          sources: broker.sourceLedger(),
          detailEvidence: broker.detailEvidenceLedger(),
          readSectionReferences: broker.readSectionReferenceLedger(),
          qualityPolicy,
          strategyDecision: finalStrategy,
          strategyReview: strategyReviewController?.latestReview(),
          delegated: strategyDecision.execution === "agentic",
          ...(turn.locale ? { locale: turn.locale } : {}),
          run: {
            model: modelBinding.modelId,
            startedAt: new Date(startedAtMs).toISOString(),
            completedAt: new Date(completedAtMs).toISOString(),
            durationMs: Math.max(0, completedAtMs - startedAtMs),
            counts: broker.budget.counts(),
            retrieval: retrievalAssessment.metrics,
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
        if (!controller.signal.aborted) controller.abort(error);
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
