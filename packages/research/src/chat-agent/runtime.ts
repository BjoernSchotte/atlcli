import { createCodeInterpreterMiddleware } from "@langchain/quickjs";
import { createMiddleware, providerStrategy, toolStrategy } from "langchain";
import { AIMessage, HumanMessage } from "@langchain/core/messages";
import { Command } from "@langchain/langgraph";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { type ResearchPtcDiagnosticV1 } from "../agent-tools.js";
import {
  ResearchCapabilityBroker,
  type ResearchReadProviders,
} from "../broker.js";
import {
  WorkspaceResearchEvidenceStoreV1,
  type ResearchEvidenceRecordV1,
} from "../evidence-store.js";
import {
  ResearchModelRunBudget,
  ResearchRunBudget,
  type ResearchModelBudgetStateV1,
} from "../budget.js";
import { createResearchModelBudgetMiddlewareV1 } from "../model-budget-middleware.js";
import {
  DEFAULT_RESEARCH_LIMITS_V1,
  type ChatPresentationStreamEventV1,
  type ResearchActivityCodeV1,
  type ResearchOneShotEventV1,
  type ResearchProgressV1,
  type ResearchRequestV1,
  type ResearchRunUsageV1,
} from "../contracts.js";
import {
  CAPABILITY_FREE_QUALITY_ADAPTER_V1,
  chatQualityPolicyV1,
  normalizeChatQualityPolicyV1,
  type ChatQualityPolicyV1,
} from "../quality-policy.js";
import type { ResearchWorkspace } from "../workspace.js";
import { classifyResearchError, redactResearchSecrets } from "../redaction.js";
import { ChatTurnWorkspaceCheckpointerV1 } from "../workspace-checkpointer.js";
import type { ResearchDispatchDiagnosticV1 } from "../dispatch-adapter.js";
import { finalizeChatAnswerV1 } from "./answer.js";
import { WorkspaceChatActivityJournalV1 } from "./activity.js";
import { deriveChatAuxiliaryReadNeedsV1 } from "./auxiliary.js";
import {
  CHAT_AGENT_DRAFT_SCHEMA_V1,
  CHAT_AGENT_DRAFT_TOOL_NAME_V1,
  CHAT_SESSION_STATE_PATH_V1,
  CHAT_SESSION_STATE_SCHEMA_V1,
  ChatContractError,
  normalizeChatTurnRequestV1,
  providerCompatibleChatAnswerSchemaV1,
  type ChatAnswerV1,
  type ChatSessionStateV1,
  type ChatTurnRequestV1,
} from "./contracts.js";
import { buildChatSystemPromptV1, buildChatTurnPromptV1 } from "./prompts.js";
import { createChatPromptCacheMiddlewareV1 } from "./prompt-cache.js";
import {
  CHAT_SESSION_PATH_V1,
  CHAT_SESSION_SCHEMA_V1,
  advanceChatControlFenceV1,
  assertChatSessionBindingV1,
  beginChatTurnV1,
  buildChatTurnContextV1,
  chatScopeFingerprintV1,
  completeChatTurnV1,
  createChatSessionV1,
  interruptChatTurnV1,
  normalizeChatHostIdentityV1,
  pauseChatTurnV1,
  parseChatSessionV1,
  renderChatTurnContextV1,
  resumeChatTurnV1,
  type ChatHostIdentityV1,
  type ChatSessionV1,
} from "./session.js";
import {
  ChatUserQuestionRequiredError,
  WorkspaceChatInteractionControllerV1,
  acknowledgeChatStopV1,
  completeChatStreamInterruptionV1,
  completeChatSteeringV1,
  recordChatStreamInterruptionV1,
  requestChatStopV1,
  type ChatResumeEnvelopeV1,
  type ChatUserQuestionAnswerV1,
} from "./interaction.js";
import {
  createChatAskUserQuestionToolV1,
} from "./hitl.js";
import { createChatDurableSummarizationMiddlewareV1 } from "./summarization.js";
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
  deriveChatAcquisitionProductsV1,
  deriveChatStrategyDecisionV1,
  type ChatStrategyDecisionV1,
  type ChatStrategyRecordV1,
  type ChatStrategyReviewRecordV1,
} from "./strategy.js";
import {
  createChatAgenticWorkflowRuntimeV1,
  type ChatSubagentModelStreamEventV1,
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
      /** Redacted host-only failure detail; never projected into durable activity. */
      errorCode?: import("../contracts.js").ResearchErrorCode;
      errorMessage?: string;
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

/**
 * Keep recoverable child eval mechanics in the host diagnostic channel. The
 * child task and its actual capabilities already have semantic user-facing
 * activities; projecting an internal retry as a failed workflow is misleading.
 */
export function projectChatAgentDiagnosticActivityV1(
  diagnostic: ChatAgentDiagnosticV1,
): {
  code: ResearchActivityCodeV1;
  status: "started" | "completed" | "failed";
} | undefined {
  if (diagnostic.kind === "eval-step" && diagnostic.profileId) return undefined;
  if (diagnostic.kind === "model-step") {
    return {
      code: diagnostic.purpose === "answer-drafting"
        ? "synthesis"
        : "model-assessing",
      status: diagnostic.status,
    };
  }
  return diagnostic.status === "started"
    ? { code: "bounded-workflow-running", status: "started" }
    : diagnostic.status === "success"
      ? { code: "bounded-workflow-complete", status: "completed" }
      : { code: "bounded-workflow-failed", status: "failed" };
}

export interface ChatReasoningSummaryProjectionStateV1 {
  accumulated: string;
  emittedCodes: Set<string>;
}

const CHAT_REASONING_SUMMARY_MILESTONES_V1 = [
  {
    code: "intent",
    pattern: /\b(user|question|request|context|scope|anchor|frage|kontext)\b/iu,
    en: "The question and selected context are being interpreted.",
    de: "Die Frage und der ausgewählte Kontext werden eingeordnet.",
  },
  {
    code: "planning",
    pattern: /(strategy|workflow|plan|decid|approach|vorgehen|schritt)\w*/iu,
    en: "Kiteweave is choosing the necessary reading and validation steps.",
    de: "Kiteweave legt die nötigen Lese- und Prüfschritte fest.",
  },
  {
    code: "sources",
    pattern: /\b(read|source|page|issue|search|retriev|quelle|seite|lesen|suche)\w*/iu,
    en: "The required sources and direct reads are being identified.",
    de: "Die benötigten Quellen und direkten Lesezugriffe werden bestimmt.",
  },
  {
    code: "comparison",
    pattern: /\b(compare|comparison|analy|difference|similar|vergleich|unterschied|gemeinsam)\w*/iu,
    en: "The comparison criteria are being derived from the question.",
    de: "Die Vergleichskriterien werden aus der Frage abgeleitet.",
  },
  {
    code: "evidence",
    pattern: /\b(evidence|support|citation|ground|claim|beleg|aussage|quelle)\w*/iu,
    en: "Claims are being matched to the available evidence.",
    de: "Aussagen werden den verfügbaren Belegen zugeordnet.",
  },
  {
    code: "quality",
    pattern: /\b(critic|gap|valid|check|review|widerspruch|lücke|prüf)\w*/iu,
    en: "Remaining evidence gaps and possible contradictions are being checked.",
    de: "Offene Beleglücken und mögliche Widersprüche werden geprüft.",
  },
  {
    code: "synthesis",
    pattern: /\b(answer|synth|formulat|draft|antwort|entwurf)\w*/iu,
    en: "The evidence-backed answer is being structured.",
    de: "Die belegte Antwort wird strukturiert.",
  },
] as const;

/**
 * Project provider-approved summarized reasoning into bounded semantic progress.
 * Raw summary text, provider terminology, tool names, and opaque references do
 * not cross the presentation boundary.
 */
export function projectChatReasoningSummaryDeltaV1(
  state: ChatReasoningSummaryProjectionStateV1,
  rawDelta: string,
  locale?: string,
): string {
  if (!rawDelta) return "";
  state.accumulated = `${state.accumulated}${rawDelta}`.slice(-12_000);
  const localized = locale?.toLowerCase().startsWith("de") ? "de" : "en";
  const messages: string[] = [];
  for (const milestone of CHAT_REASONING_SUMMARY_MILESTONES_V1) {
    if (
      !state.emittedCodes.has(milestone.code) &&
      milestone.pattern.test(state.accumulated)
    ) {
      state.emittedCodes.add(milestone.code);
      messages.push(milestone[localized]);
    }
  }
  if (messages.length === 0 && state.emittedCodes.size === 0) {
    state.emittedCodes.add("progress");
    messages.push(localized === "de"
      ? "Kiteweave prüft den nächsten sinnvollen Schritt."
      : "Kiteweave is checking the next useful step.");
  }
  return messages.length > 0 ? `${messages.join("\n")}\n` : "";
}

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
          // Direct Chat deliberately exposes only the host-audited QuickJS bridge
          // and its durable HITL control. Atlassian reads remain available only
          // behind eval/PTC; structured-output tools are bound by LangChain after
          // this middleware.
          tools: request.tools.filter((candidate) =>
            candidate.name === "eval" || candidate.name === "ask_user_question"
          ),
        });
        onDiagnostic?.({
          kind: "model-step",
          status: "completed",
          purpose,
          ...diagnosticMessage(response),
        });
        return response;
      } catch (error) {
        const classified = classifyResearchError(error);
        onDiagnostic?.({
          kind: "model-step",
          status: "failed",
          purpose,
          errorCode: classified.code,
          errorMessage: redactResearchSecrets(error),
        });
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
  if ((taskBridgeTool || options.agentic) && upstreamWrapModelCall) {
    middleware.wrapModelCall = (request, handler) => {
      const bridgeTool = taskBridgeTool as (typeof request.tools)[number] | undefined;
      const toolsForInterpreter = taskBridgeTool
        ? request.tools.some((candidate) => candidate.name === "task")
          ? request.tools
          : [...request.tools, bridgeTool!]
        : request.tools.filter((candidate) => candidate.name !== "task");
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
      "Then call chatWorkflowAdvance. The host executes every ready specialist wave from the accepted dynamic graph.",
      "When advance requests chatStrategyReview or chatQualityReview, call that exact checkpoint once and then call chatWorkflowAdvance again.",
      "Never construct, copy, or invoke a task dispatch yourself.",
    ].join(" ");
  }
  return middleware;
}


export interface ChatAgentRuntimeBindings {
  StateBackend: typeof import("deepagents/browser").StateBackend;
  createDeepAgent: typeof import("deepagents/browser").createDeepAgent;
  createSubAgentMiddleware:
    typeof import("deepagents/browser").createSubAgentMiddleware;
  createSummarizationMiddleware:
    typeof import("deepagents/browser").createSummarizationMiddleware;
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
  /** Opaque host-owned principal/cache fences; never credentials or email addresses. */
  hostIdentity: ChatHostIdentityV1;
  qualityPolicy?: ChatQualityPolicyV1;
  /** Resume exactly this turn's durable askUserQuestion checkpoint. */
  resumeAnswer?: ChatUserQuestionAnswerV1;
  /** Resume the same durable model checkpoint without pretending token replay. */
  resumeCheckpoint?: {
    kind: "stream-interruption" | "steering";
  };
  signal?: AbortSignal;
  now?: () => number;
  onProgress?: (progress: ResearchProgressV1) => void;
  onEvent?: (event: ResearchOneShotEventV1) => void;
  onChatPresentation?: (event: ChatPresentationStreamEventV1) => void;
  onPtcDiagnostic?: (diagnostic: ResearchPtcDiagnosticV1) => void;
  onAgentDiagnostic?: (diagnostic: ChatAgentDiagnosticV1) => void;
  onDispatchDiagnostic?: (diagnostic: ResearchDispatchDiagnosticV1) => void;
  onSubagentResultDiagnostic?: (diagnostic: ChatSubagentResultDiagnosticV1) => void;
  /** Host-internal control binding; never exposed to the model or presenter. */
  onInteractionReady?: (controller: WorkspaceChatInteractionControllerV1) => void;
  /** Host-private checkpoint envelope captured before model execution. */
  onResumeEnvelopeReady?: (resume: ChatResumeEnvelopeV1) => void;
}

export const CHAT_MODEL_BUDGET_STATE_PATH_V1 =
  "/.atlcli/chat/v1/model-budget.json" as const;

const CHAT_SYNTHESIS_MODEL_RESERVE_V1 = {
  // LangChain ToolStrategy uses one call to emit the schema tool and a second
  // call to close the specialist after the tool result is accepted.
  calls: 2,
  inputTokens: 8_192,
  outputTokens: 8_000,
} as const;

const CHAT_REPAIR_AND_SYNTHESIS_MODEL_RESERVE_V1 = {
  calls: 4,
  inputTokens: 16_384,
  outputTokens: 16_000,
} as const;

export function chatModelCallLimitV1(input: {
  configuredMaxModelCalls: number;
  qualityMode: ChatQualityPolicyV1["mode"];
  execution: ChatStrategyDecisionV1["execution"];
}): number {
  if (
    input.execution === "agentic" &&
    input.configuredMaxModelCalls === DEFAULT_RESEARCH_LIMITS_V1.maxModelCalls
  ) {
    // Nine bounded depth-one tasks need at most two ToolStrategy calls each;
    // the central supervisor retains capacity for strategy, workflow
    // checkpoints, and closure. Monetary and token ceilings remain binding.
    return 28;
  }
  return input.configuredMaxModelCalls;
}

const CHAT_SYNTHESIS_TIME_RESERVE_MS_V1 = 15_000;
const CHAT_REPAIR_TIME_RESERVE_MS_V1 = 15_000;

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
  turnId: string;
  objective: string;
  tenantOrigin: string;
  scopeBindings: readonly import("../contracts.js").ResearchScopeBindingV1[];
  scope: import("../contracts.js").ResearchScopeV1;
  hostIdentity: ChatHostIdentityV1;
  startedAt: string;
  resumeReason?: "hitl" | "stream-interruption" | "steering";
}): Promise<{ session: ChatSessionV1; context: string }> {
  const stored = await input.workspace.readFile(CHAT_SESSION_STATE_PATH_V1);
  let session: ChatSessionV1;
  if (stored !== undefined) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(stored);
    } catch {
      throw new ChatContractError("invalid-request", "Stored Chat state is incompatible with this runtime.");
    }
    if (
      parsed &&
      typeof parsed === "object" &&
      !Array.isArray(parsed) &&
      (parsed as { schema?: unknown }).schema === CHAT_SESSION_SCHEMA_V1
    ) {
      session = parseChatSessionV1(parsed);
      assertChatSessionBindingV1({
        session,
        conversationId: input.conversationId,
        identity: input.hostIdentity,
        tenantOrigin: input.tenantOrigin,
      });
    } else {
      // A compatible pre-C8 state carried only the conversation ID and quality
      // policy. It contains no evidence or transcript and can be migrated
      // without importing any Research checkpoint semantics.
      if (input.resumeReason) {
        throw new ChatContractError(
          "invalid-request",
          "A legacy Chat state has no resumable HITL checkpoint.",
        );
      }
      normalizeStoredChatSessionStateV1(parsed, input.conversationId);
      session = createChatSessionV1({
        conversationId: input.conversationId,
        identity: input.hostIdentity,
        tenantOrigin: input.tenantOrigin,
        createdAt: input.startedAt,
      });
    }
  } else {
    if (input.resumeReason) {
      throw new ChatContractError("invalid-request", "Chat HITL checkpoint is unavailable.");
    }
    session = createChatSessionV1({
      conversationId: input.conversationId,
      identity: input.hostIdentity,
      tenantOrigin: input.tenantOrigin,
      createdAt: input.startedAt,
    });
  }
  const scopeFingerprint = await chatScopeFingerprintV1({
    scope: input.scope,
    scopeBindings: input.scopeBindings,
  });
  session = input.resumeReason
    ? resumeChatTurnV1({
        session,
        expectedSessionRevision: session.revision,
        turnId: input.turnId,
        objective: input.objective,
        qualityMode: input.qualityPolicy.mode,
        scopeFingerprint,
        reason: input.resumeReason,
        at: input.startedAt,
      })
    : beginChatTurnV1({
        session,
        expectedSessionRevision: session.revision,
        turnId: input.turnId,
        objective: input.objective,
        qualityMode: input.qualityPolicy.mode,
        scopeFingerprint,
        startedAt: input.startedAt,
      });
  await input.workspace.writeFile(
    CHAT_SESSION_PATH_V1,
    JSON.stringify(session),
  );
  return {
    session,
    context: renderChatTurnContextV1(
      buildChatTurnContextV1(session, input.turnId),
    ),
  };
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
      const hostIdentity = normalizeChatHostIdentityV1(input.hostIdentity);
      const now = input.now ?? Date.now;
      const startedAtMs = now();
      const startedAt = new Date(startedAtMs).toISOString();
      const budget = input.budget ?? new ResearchRunBudget(input.brokerRequest.limits);
      const scopeBindings = input.brokerRequest.scopeSeeds?.map((seed) => seed.binding) ?? [];
      const evidenceStore = new WorkspaceResearchEvidenceStoreV1(input.workspace);
      let durableChatSession: ChatSessionV1 | undefined;
      let interactionController: WorkspaceChatInteractionControllerV1 | undefined;
      let activityJournal: WorkspaceChatActivityJournalV1 | undefined;
      let durableContext = "";
      let resumeEnvelope: ChatResumeEnvelopeV1 | undefined;
      let modelCheckpointEntered = false;
      let resumableRootModelFailure = false;
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
      const emitActivity = (
        code: ResearchActivityCodeV1,
        status: "started" | "completed" | "failed",
      ): void => {
        const at = new Date(now()).toISOString();
        activityJournal?.record({ turnId: turn.turnId, at, code, status });
        input.onEvent?.({
          kind: "activity",
          seq: nextEventSequence(),
          at,
          code,
          status,
        });
      };
      const emitAgentDiagnostic = (diagnostic: ChatAgentDiagnosticV1): void => {
        if (diagnostic.kind === "model-step") {
          if (diagnostic.status === "started" || diagnostic.status === "completed") {
            resumableRootModelFailure = false;
          } else {
            resumableRootModelFailure = diagnostic.errorCode === "provider-error" ||
              diagnostic.errorCode === "rate-limited";
          }
        }
        input.onAgentDiagnostic?.(diagnostic);
        const activity = projectChatAgentDiagnosticActivityV1(diagnostic);
        if (activity) emitActivity(activity.code, activity.status);
        if (
          diagnostic.kind === "model-step" &&
          diagnostic.status === "completed" &&
          diagnostic.purpose !== "answer-drafting" &&
          !diagnostic.toolNames?.some((name) => name === "eval" || name === "ask_user_question")
        ) {
          emitActivity("synthesis", "started");
          emitActivity("synthesis", "completed");
        }
      };
      let assertStrategyAccepted: (() => void) | undefined;
      let retrievalLedger: ChatCandidateLedgerControllerV1 | undefined;
      let strategyForFinalReviewReserve: ChatStrategyDecisionV1 | undefined;
      let activeBroker: ResearchCapabilityBroker | undefined;
      const controller = new AbortController();
      const forwardAbort = (): void => controller.abort(input.signal?.reason);
      if (input.signal?.aborted) forwardAbort();
      else input.signal?.addEventListener("abort", forwardAbort, { once: true });
      const timeout = globalThis.setTimeout(
        () => controller.abort(new ChatContractError("limit-exceeded", "The Chat turn reached its maximum duration.")),
        turn.limits.maxRunMs,
      );
      const onAbort = (): void => {
        activeBroker?.cancel(controller.signal.reason);
        const reasonCode = input.signal?.reason &&
          typeof input.signal.reason === "object" &&
          "code" in input.signal.reason
          ? String(input.signal.reason.code)
          : undefined;
        if (input.signal?.aborted && reasonCode !== "paused") {
          emitActivity("stop", "started");
        }
      };
      controller.signal.addEventListener("abort", onAbort, { once: true });
      try {
        const durable = await bindChatSessionStateV1({
          workspace: input.workspace,
          conversationId: turn.conversationId,
          qualityPolicy,
          turnId: turn.turnId,
          objective: turn.question,
          tenantOrigin: turn.scope.siteOrigin,
          scopeBindings,
          scope: turn.scope,
          hostIdentity,
          startedAt,
          ...(input.resumeAnswer
            ? { resumeReason: "hitl" as const }
            : input.resumeCheckpoint
              ? { resumeReason: input.resumeCheckpoint.kind }
              : {}),
        });
        durableChatSession = durable.session;
        durableContext = durable.context;
        interactionController = await WorkspaceChatInteractionControllerV1.bind({
          workspace: input.workspace,
          conversationId: turn.conversationId,
          binding: durableChatSession.binding,
          at: startedAt,
        });
        if (input.resumeAnswer && input.resumeCheckpoint) {
          throw new ChatContractError(
            "invalid-request",
            "A Chat turn cannot resume HITL and a model checkpoint together.",
          );
        }
        const acceptedSteering = input.resumeCheckpoint?.kind === "steering"
          ? interactionController.snapshot().acceptedSteering
          : undefined;
        const streamInterruption = input.resumeCheckpoint?.kind === "stream-interruption"
          ? interactionController.snapshot().streamInterruption
          : undefined;
        const pendingQuestion = input.resumeAnswer
          ? interactionController.snapshot().pendingQuestion
          : undefined;
        if (input.resumeCheckpoint?.kind === "steering") {
          if (!acceptedSteering || acceptedSteering.turnId !== turn.turnId) {
            throw new ChatContractError(
              "invalid-request",
              "The accepted Chat steering checkpoint is unavailable.",
            );
          }
          if (
            JSON.stringify(acceptedSteering.resume.request) !==
              JSON.stringify(input.brokerRequest) ||
            JSON.stringify(acceptedSteering.resume.qualityPolicy) !==
              JSON.stringify(qualityPolicy)
          ) {
            throw new ChatContractError(
              "access-denied",
              "The Chat steering resume envelope was altered.",
            );
          }
        }
        if (input.resumeCheckpoint?.kind === "stream-interruption") {
          if (!streamInterruption || streamInterruption.turnId !== turn.turnId) {
            throw new ChatContractError(
              "invalid-request",
              "The resumable Chat stream checkpoint is unavailable.",
            );
          }
          if (
            JSON.stringify(streamInterruption.resume.request) !==
              JSON.stringify(input.brokerRequest) ||
            JSON.stringify(streamInterruption.resume.qualityPolicy) !==
              JSON.stringify(qualityPolicy)
          ) {
            throw new ChatContractError(
              "access-denied",
              "The Chat stream resume envelope was altered.",
            );
          }
        }
        const broker = new ResearchCapabilityBroker(
          input.brokerRequest,
          input.providers,
          {
            budget,
            scopeBindings,
            ...((acceptedSteering?.resume.exactAnchors ??
                streamInterruption?.resume.exactAnchors ??
                pendingQuestion?.resume.exactAnchors)
              ? {
                  exactAnchorResume: acceptedSteering?.resume.exactAnchors ??
                    streamInterruption?.resume.exactAnchors ??
                    pendingQuestion!.resume.exactAnchors,
                }
              : {}),
            evidence: {
              store: evidenceStore,
              scopeBindings,
              capturedAt: () => new Date(now()).toISOString(),
            },
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
        activeBroker = broker;
        activityJournal = await WorkspaceChatActivityJournalV1.open({
          workspace: input.workspace,
          conversationId: turn.conversationId,
        });
        input.onInteractionReady?.(interactionController);
        if (input.resumeAnswer &&
            interactionController.snapshot().pendingQuestion?.question.id !==
              input.resumeAnswer.questionId) {
          throw new ChatContractError(
            "invalid-request",
            "Chat HITL answer does not match the waiting question.",
          );
        }
        const retainedEvidenceIds = buildChatTurnContextV1(
          durableChatSession,
          turn.turnId,
        ).acceptedEvidence.map((entry) => entry.evidenceId);
        if (retainedEvidenceIds.length > 0) {
          await broker.restoreRetainedEvidence({
            evidenceIds: retainedEvidenceIds,
            checkedAt: new Date(now()).toISOString(),
          });
        }
        input.onProgress?.({
          phase: "preparing",
          message: "Preparing the bounded Chat turn.",
          completedCalls: 0,
          maxCalls: turn.limits.maxPtcCalls,
        });
        emitPhase("preparing");
        const anchors = broker.exactAnchors();
        resumeEnvelope = {
          request: input.brokerRequest,
          qualityPolicy,
          exactAnchors: broker.exactAnchorResume(),
        };
        input.onResumeEnvelopeReady?.(resumeEnvelope);
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
          emitActivity("strategy", "completed");
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
        emitActivity("strategy", "started");
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
        const modelBudget = new ResearchModelRunBudget({
          ...turn.limits,
          maxModelCalls: chatModelCallLimitV1({
            configuredMaxModelCalls: turn.limits.maxModelCalls,
            qualityMode: qualityPolicy.mode,
            execution: strategyDecision.execution,
          }),
        });
        let modelBudgetWrite = Promise.resolve();
        const persistModelBudget = (
          state: ResearchModelBudgetStateV1,
        ): Promise<void> => {
          modelBudgetWrite = modelBudgetWrite.then(() =>
            input.workspace.writeFile(
              CHAT_MODEL_BUDGET_STATE_PATH_V1,
              JSON.stringify(state),
            )
          );
          return modelBudgetWrite;
        };
        await persistModelBudget(modelBudget.state());
        const { searchProducts, exactContextProducts } =
          deriveChatAcquisitionProductsV1({
            decision: strategyDecision,
            scope: turn.scope,
            anchors,
          });
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
          exactContextProducts,
          limits: turn.limits,
          agentic: strategyDecision.execution === "agentic",
          relationshipTracing: strategyDecision.requiredCapabilities.includes(
            "relationship-tracing",
          ),
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
        const subagentStreams = new Map<string, {
          reasoningStarted: boolean;
          reasoningProjection: ChatReasoningSummaryProjectionStateV1;
          answerStarted: boolean;
          structuredText: string;
          emittedAnswerChars: number;
        }>();
        let emittedSubagentReasoningChars = 0;
        const emitProjectedSubagentAnswer = (state: {
          answerStarted: boolean;
          structuredText: string;
          emittedAnswerChars: number;
        }): void => {
          if (state.structuredText.length > turn.limits.maxReportChars * 4) return;
          const projected = (
            streamedJsonStringFieldV1(state.structuredText, "messageMarkdown") ?? ""
          ).slice(0, turn.limits.maxReportChars);
          if (projected.length <= state.emittedAnswerChars) return;
          const delta = projected.slice(state.emittedAnswerChars);
          if (!state.answerStarted) {
            state.answerStarted = true;
            input.onChatPresentation?.({
              kind: "chat-presentation",
              seq: nextEventSequence(),
              at: new Date(now()).toISOString(),
              channel: "answer-markdown",
              status: "started",
            });
          }
          state.emittedAnswerChars = projected.length;
          input.onChatPresentation?.({
            kind: "chat-presentation",
            seq: nextEventSequence(),
            at: new Date(now()).toISOString(),
            channel: "answer-markdown",
            status: "delta",
            delta,
          });
        };
        const emitSubagentModelStream = ({
          profileId,
          runId,
          event,
        }: ChatSubagentModelStreamEventV1): void => {
          const state = subagentStreams.get(runId) ?? {
            reasoningStarted: false,
            reasoningProjection: { accumulated: "", emittedCodes: new Set<string>() },
            answerStarted: false,
            structuredText: "",
            emittedAnswerChars: 0,
          };
          subagentStreams.set(runId, state);
          if (event.event === "content-block-delta") {
            if (
              event.delta.type === "reasoning-delta" &&
              modelBinding.reasoningPresentation === "summary" &&
              emittedSubagentReasoningChars < 12_000
            ) {
              const delta = projectChatReasoningSummaryDeltaV1(
                state.reasoningProjection,
                event.delta.reasoning,
                turn.locale,
              ).slice(0, Math.min(1_024, 12_000 - emittedSubagentReasoningChars));
              if (delta) {
                if (!state.reasoningStarted) {
                  state.reasoningStarted = true;
                  input.onChatPresentation?.({
                    kind: "chat-presentation",
                    seq: nextEventSequence(),
                    at: new Date(now()).toISOString(),
                    channel: "reasoning-summary",
                    status: "started",
                  });
                }
                emittedSubagentReasoningChars += delta.length;
                input.onChatPresentation?.({
                  kind: "chat-presentation",
                  seq: nextEventSequence(),
                  at: new Date(now()).toISOString(),
                  channel: "reasoning-summary",
                  status: "delta",
                  delta,
                });
              }
            }
            if (
              event.delta.type === "text-delta" &&
              profileId === "chat-synthesizer" &&
              modelBinding.structuredOutput === "native"
            ) {
              state.structuredText += event.delta.text;
              emitProjectedSubagentAnswer(state);
            }
            if (
              event.delta.type === "block-delta" &&
              profileId === "chat-synthesizer" &&
              event.delta.fields.type === "tool_call_chunk" &&
              typeof event.delta.fields.args === "string"
            ) {
              // LangChain standardizes tool-call argument deltas as a running
              // JSON snapshot. Replacing instead of appending avoids duplicate
              // prefixes while still projecting complete string units.
              state.structuredText = event.delta.fields.args;
              emitProjectedSubagentAnswer(state);
            }
            return;
          }
          if (event.event !== "message-finish" && event.event !== "error") return;
          if (state.reasoningStarted) {
            input.onChatPresentation?.({
              kind: "chat-presentation",
              seq: nextEventSequence(),
              at: new Date(now()).toISOString(),
              channel: "reasoning-summary",
              status: "completed",
            });
          }
          if (state.answerStarted) {
            input.onChatPresentation?.({
              kind: "chat-presentation",
              seq: nextEventSequence(),
              at: new Date(now()).toISOString(),
              channel: "answer-markdown",
              status: "completed",
            });
          }
          subagentStreams.delete(runId);
        };
        const emitPtcDiagnostic = emitPtcEventFactory({
          onEvent: (event) => {
            input.onEvent?.(event);
            if (event.kind === "capability") {
              const activityCode: ResearchActivityCodeV1 = event.inputKind === "ranking"
                ? "source-selection"
                : event.inputKind === "search" || event.inputKind === "continuation"
                  ? "search"
                  : "direct-read";
              emitActivity(
                activityCode,
                event.status === "started"
                  ? "started"
                  : event.status === "completed"
                    ? "completed"
                    : "failed",
              );
            }
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
              modelBudget,
              onModelBudgetSnapshot: persistModelBudget,
              broker,
              workspace: input.workspace,
              conversationId: turn.conversationId,
              turnId: turn.turnId,
              question: turn.question,
              siteOrigin: turn.scope.siteOrigin,
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
              locale: turn.locale,
              exactContextProducts,
              searchProducts,
              boundProjectKeys: turn.scope.jiraProjectKeys,
              boundSpaceKeys: turn.scope.confluenceSpaceKeys,
              signal: controller.signal,
              beforeProposal: strategyController?.assertAcknowledged,
              beforeWorkflowAdmission: async (proposal) => {
                if (!proposal.retrievalPlan) return;
                await retrievalLedger!.replacePlan(buildRetrievalPlan(proposal.retrievalPlan));
              },
              strategyReviewCurrent: () => {
                try {
                  strategyReviewController?.assertCurrent();
                  return strategyReviewController !== undefined;
                } catch {
                  return false;
                }
              },
              beforeCritic: async () => {
                strategyReviewController?.assertCurrent();
                await retrievalLedger!.finalize();
              },
              beforeSynthesis: async () => {
                strategyReviewController?.assertCurrent();
                await retrievalLedger!.finalize();
              },
              decideRepairAdmission: () => {
                const elapsedMs = Math.max(0, now() - startedAtMs);
                const remainingMs = Math.max(0, turn.limits.maxRunMs - elapsedMs);
                if (
                  remainingMs <
                    CHAT_SYNTHESIS_TIME_RESERVE_MS_V1 + CHAT_REPAIR_TIME_RESERVE_MS_V1
                ) {
                  return { admit: false, reason: "deadline-reserve" };
                }
                if (!modelBudget.canReserveCapacity(
                  CHAT_REPAIR_AND_SYNTHESIS_MODEL_RESERVE_V1,
                )) {
                  return { admit: false, reason: "model-budget-reserve" };
                }
                return { admit: true };
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
              onModelStreamEvent: emitSubagentModelStream,
              onDispatchDiagnostic: (diagnostic) => {
                input.onDispatchDiagnostic?.(diagnostic);
                if (!diagnostic.taskId) return;
                const profileId = agenticWorkflow?.acceptedWorkflow()?.tasks.find(
                  (task) => task.taskId === diagnostic.taskId,
                )?.profileId;
                const activityCode: ResearchActivityCodeV1 = profileId === "answer-critic"
                  ? "critique"
                  : profileId === "answer-repairer"
                    ? "repair"
                    : profileId === "chat-synthesizer"
                      ? "synthesis"
                      : "child-work";
                emitActivity(
                  activityCode,
                  diagnostic.status === "started"
                    ? "started"
                    : diagnostic.status === "completed"
                      ? "completed"
                      : "failed",
                );
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
                    `A bounded Chat specialist did not complete (${diagnostic.taskId ?? "unknown"}, ${diagnostic.code ?? "unknown"}); the turn stopped before synthesis.`,
                  ));
                }
              },
            })
          : undefined;
        const ptcTools = strategyDecision.execution === "agentic"
          ? [
              ...(strategyController ? [strategyController.tool] : []),
              agenticWorkflow!.proposalTool,
              agenticWorkflow!.advanceTool,
              ...(strategyReviewController ? [strategyReviewController.tool] : []),
              agenticWorkflow!.qualityReviewTool,
            ]
          : [
              ...(strategyController ? [strategyController.tool] : []),
              ...createChatPtcToolsV1(broker, {
                now,
                exactContextProducts,
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
        const rootModelOutputTokens = Math.min(
          turn.limits.maxModelOutputTokens,
          qualityPolicy.mode === "quick" ? 2_048 : qualityPolicy.mode === "auto" ? 4_096 : 5_000,
        );
        const rootModelBudgetMiddleware = createResearchModelBudgetMiddlewareV1(
          modelBudget,
          {
            name: "ChatRootModelBudgetMiddleware",
            maxOutputTokens: rootModelOutputTokens,
            ...(strategyDecision.execution === "agentic"
              ? { retain: CHAT_SYNTHESIS_MODEL_RESERVE_V1 }
              : {}),
            onSnapshot: async (_snapshot, state) => persistModelBudget(state),
          },
        );
        const durableSummarizationMiddleware =
          createChatDurableSummarizationMiddlewareV1(runtime, {
            workspace: input.workspace,
            model,
          });
        const checkpoint = new ChatTurnWorkspaceCheckpointerV1({
          conversationId: turn.conversationId,
          turnId: turn.turnId,
          workspace: input.workspace,
        });
        const askUserQuestion = createChatAskUserQuestionToolV1({
          turnId: turn.turnId,
          interactions: interactionController,
          resume: resumeEnvelope!,
          now,
          onQuestion: () => {
            emitPhase("waiting-user");
            emitActivity("hitl", "started");
          },
          onResolved: () => {
            emitPhase("user-answer-accepted");
            emitActivity("hitl", "completed");
          },
        });
        const agent = runtime.createDeepAgent({
          name: "kiteweave-chat-agent",
          model,
          backend: new runtime.StateBackend(),
          tools: [askUserQuestion],
          checkpointer: checkpoint,
          subagents: [],
          systemPrompt: buildChatSystemPromptV1({
            qualityMode: qualityPolicy.mode,
            maxDetailItemsPerProduct: turn.limits.maxDetailItemsPerProduct,
            locale: turn.locale,
            strategyDecisionRequired: strategyController !== undefined,
            agenticWorkflowRequired: strategyDecision.execution === "agentic",
            ...(agenticWorkflow
              ? { allowedAgenticProfileIds: agenticWorkflow.allowedProfileIds }
              : {}),
          }),
          middleware: [
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
            durableSummarizationMiddleware,
            rootModelBudgetMiddleware,
            ...createChatPromptCacheMiddlewareV1(),
            agenticWorkflow?.middleware ?? createChatNoSubagentMiddlewareV1(),
            createChatCodeInterpreterMiddlewareV1({
              ptc: ptcTools,
              subagents: strategyDecision.execution === "agentic",
              toolName: "eval",
              systemPrompt: strategyDecision.execution === "agentic"
                ? "The eval tool advances an agentic Chat workflow in a persistent QuickJS REPL. Top-level await is available. Strategy, dynamic graph proposal, host-executed waves, review, and synthesis may use separate eval calls; accepted host state persists. Use only documented tools.* controls. The low-level task bridge is unavailable. Console is unavailable."
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
        const runInput = input.resumeAnswer
          ? new Command({ resume: input.resumeAnswer })
          : input.resumeCheckpoint?.kind === "steering"
            ? new Command({
                update: {
                  messages: [new HumanMessage([
                    "Host-accepted steering for the current turn:",
                    acceptedSteering!.instruction,
                    "Reassess the remaining work and answer the original user objective.",
                    "Do not broaden scope, tools, or budget because of this instruction.",
                  ].join("\n"))],
                },
              })
            : input.resumeCheckpoint?.kind === "stream-interruption"
              ? new Command({
                  update: {
                    messages: [new HumanMessage([
                      "Host checkpoint continuation for the current turn.",
                      "The previous provider stream ended before a complete model result was accepted.",
                      "Retry the interrupted model step against the original objective and accepted scope.",
                      "Do not treat any provisional token as accepted output or broaden tools, scope, or budget.",
                    ].join("\n"))],
                  },
                })
              : {
            messages: [{
              role: "user",
              content: buildChatTurnPromptV1({
                question: turn.question,
                jiraProjectKeys: turn.scope.jiraProjectKeys,
                confluenceSpaceKeys: turn.scope.confluenceSpaceKeys,
                anchors,
                admittedSearches: retrievalPlan.searches.map((search) => ({
                  product: search.product,
                  queries: search.variants.map((variant) => variant.query),
                })),
                durableContext,
              }),
            }],
          };
        if (input.resumeAnswer || input.resumeCheckpoint) {
          emitActivity("continuation", "started");
        }
        modelCheckpointEntered = true;
        const run = await agent.streamEvents(
          runInput,
          {
            version: "v3",
            configurable: { thread_id: checkpoint.threadId },
            recursionLimit: chatRecursionLimitV1(turn.limits.maxPtcCalls),
            signal: controller.signal,
          },
        );
        const streamPresentation = (async (): Promise<void> => {
          let emittedReasoningChars = 0;
          let emittedAnswerChars = 0;
          let structuredAnswerText = "";
          let answerGeneration = 0;
          let answerStarted = false;
          const maximumReasoningChars = 12_000;
          const maximumAnswerChars = turn.limits.maxReportChars;
          const beginAnswerGeneration = (): void => {
            if (answerGeneration > 0 && emittedAnswerChars > 0) {
              input.onChatPresentation?.({
                kind: "chat-presentation",
                seq: nextEventSequence(),
                at: new Date(now()).toISOString(),
                channel: "answer-markdown",
                status: "reset",
              });
            }
            answerGeneration += 1;
            structuredAnswerText = "";
            emittedAnswerChars = 0;
            answerStarted = false;
          };
          const emitProjectedAnswer = (): void => {
            if (structuredAnswerText.length > maximumAnswerChars * 4) return;
            const projected = (
              streamedJsonStringFieldV1(structuredAnswerText, "messageMarkdown") ?? ""
            ).slice(0, maximumAnswerChars);
            if (projected.length <= emittedAnswerChars) return;
            if (!answerStarted) {
              answerStarted = true;
              input.onChatPresentation?.({
                kind: "chat-presentation",
                seq: nextEventSequence(),
                at: new Date(now()).toISOString(),
                channel: "answer-markdown",
                status: "started",
              });
            }
            const delta = projected.slice(emittedAnswerChars);
            emittedAnswerChars = projected.length;
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
          };
          const completeAnswerGeneration = (): void => {
            if (!answerStarted) return;
            input.onChatPresentation?.({
              kind: "chat-presentation",
              seq: nextEventSequence(),
              at: new Date(now()).toISOString(),
              channel: "answer-markdown",
              status: "completed",
            });
            answerStarted = false;
          };
          const consumeReasoning = async (source: AsyncIterable<string>): Promise<void> => {
            if (modelBinding.reasoningPresentation !== "summary") {
              for await (const _unused of source) {
                // Drain the projection. Unapproved reasoning never crosses the
                // host presentation boundary.
              }
              return;
            }
            let started = false;
            const projection: ChatReasoningSummaryProjectionStateV1 = {
              accumulated: "",
              emittedCodes: new Set<string>(),
            };
            for await (const rawDelta of source) {
              if (emittedReasoningChars >= maximumReasoningChars) continue;
              const delta = projectChatReasoningSummaryDeltaV1(
                projection,
                rawDelta,
                turn.locale,
              ).slice(0, Math.min(1_024, maximumReasoningChars - emittedReasoningChars));
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
          const consumeNativeAnswer = async (
            source: AsyncIterable<string>,
            allowed: boolean,
          ): Promise<void> => {
            if (!allowed || modelBinding.structuredOutput !== "native") {
              for await (const _unused of source) {
                // Unstructured text is not a safe provisional Chat answer.
              }
              return;
            }
            for await (const rawDelta of source) {
              if (answerGeneration === 0) beginAnswerGeneration();
              structuredAnswerText += rawDelta;
              emitProjectedAnswer();
            }
            completeAnswerGeneration();
          };
          const consumeToolAnswer = async (
            source: AsyncIterable<unknown>,
            allowed: boolean,
          ): Promise<void> => {
            if (!allowed || modelBinding.structuredOutput !== "tool") {
              for await (const _unused of source) {
                // Drain the message event stream independently of reasoning.
              }
              return;
            }
            const toolNames = new Map<number, string>();
            const activeAnswerIndexes = new Set<number>();
            for await (const candidate of source) {
              if (!candidate || typeof candidate !== "object") continue;
              const event = candidate as Record<string, unknown>;
              const index = typeof event.index === "number" ? event.index : -1;
              if (event.event === "content-block-start") {
                const content = event.content && typeof event.content === "object"
                  ? event.content as Record<string, unknown>
                  : {};
                const name = typeof content.name === "string" ? content.name : "";
                if (index >= 0 && name) toolNames.set(index, name);
                if (name === CHAT_AGENT_DRAFT_TOOL_NAME_V1) {
                  activeAnswerIndexes.add(index);
                  beginAnswerGeneration();
                  if (typeof content.args === "string") {
                    structuredAnswerText = content.args;
                    emitProjectedAnswer();
                  }
                }
                continue;
              }
              if (event.event === "content-block-delta") {
                const delta = event.delta && typeof event.delta === "object"
                  ? event.delta as Record<string, unknown>
                  : {};
                const fields = delta.fields && typeof delta.fields === "object"
                  ? delta.fields as Record<string, unknown>
                  : {};
                const name = typeof fields.name === "string"
                  ? fields.name
                  : toolNames.get(index);
                if (name !== CHAT_AGENT_DRAFT_TOOL_NAME_V1 ||
                  fields.type !== "tool_call_chunk" ||
                  typeof fields.args !== "string") continue;
                if (!activeAnswerIndexes.has(index)) {
                  activeAnswerIndexes.add(index);
                  beginAnswerGeneration();
                }
                // LangGraph publishes the accumulated JSON argument snapshot.
                structuredAnswerText = fields.args;
                emitProjectedAnswer();
                continue;
              }
              if (event.event !== "content-block-finish") continue;
              const content = event.content && typeof event.content === "object"
                ? event.content as Record<string, unknown>
                : {};
              const name = typeof content.name === "string"
                ? content.name
                : toolNames.get(index);
              if (name !== CHAT_AGENT_DRAFT_TOOL_NAME_V1) continue;
              if (!activeAnswerIndexes.has(index)) beginAnswerGeneration();
              if (content.args && typeof content.args === "object") {
                structuredAnswerText = JSON.stringify(content.args);
                emitProjectedAnswer();
              }
              completeAnswerGeneration();
            }
          };
          await Promise.all([
            (async () => {
              for await (const message of run.messages) {
                await Promise.all([
                  consumeReasoning(message.reasoning),
                  consumeNativeAnswer(
                    message.text,
                    strategyDecision.execution !== "agentic",
                  ),
                  consumeToolAnswer(
                    message,
                    strategyDecision.execution !== "agentic",
                  ),
                ]);
              }
            })(),
          ]);
        })();
        const [result] = await Promise.all([run.output, streamPresentation]);
        await modelBudgetWrite;
        const interrupts = result && typeof result === "object" &&
          "__interrupt__" in result && Array.isArray(result.__interrupt__)
          ? result.__interrupt__
          : [];
        if (interrupts.length > 0) {
          const pending = interactionController.snapshot().pendingQuestion;
          if (!pending || pending.turnId !== turn.turnId) {
            throw new ChatContractError(
              "invalid-request",
              "Chat graph interrupted without a durable user question.",
            );
          }
          durableChatSession = pauseChatTurnV1({
            session: durableChatSession!,
            expectedSessionRevision: durableChatSession!.revision,
            turnId: turn.turnId,
            at: new Date(now()).toISOString(),
          });
          await input.workspace.writeFile(
            CHAT_SESSION_PATH_V1,
            JSON.stringify(durableChatSession),
          );
          await activityJournal.flush();
          throw new ChatUserQuestionRequiredError(pending.question);
        }
        if (input.resumeAnswer || input.resumeCheckpoint) {
          emitActivity("continuation", "completed");
        }
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
          qualityDisposition: agenticWorkflow?.qualityDisposition(),
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
        const acceptedEvidenceIds = new Set(
          broker.detailEvidenceLedger().flatMap((entry) =>
            answer.evidenceRefs.includes(entry.source.id) && entry.evidenceId
              ? [entry.evidenceId]
              : []
          ),
        );
        const evidenceRecords = (await Promise.all(
          [...acceptedEvidenceIds].map((evidenceId) => evidenceStore.get(evidenceId)),
        )).filter((record): record is ResearchEvidenceRecordV1 => record !== undefined);
        if (acceptedSteering) {
          await interactionController.update((state) =>
            completeChatSteeringV1({
              state,
              expectedRevision: state.revision,
              steeringId: acceptedSteering.id,
              expectedSteeringRevision: acceptedSteering.revision,
              at: new Date(now()).toISOString(),
            })
          );
          emitActivity("steering", "completed");
        }
        if (streamInterruption) {
          await interactionController.update((state) =>
            completeChatStreamInterruptionV1({
              state,
              expectedRevision: state.revision,
              turnId: turn.turnId,
              expectedInterruptionRevision: streamInterruption.revision,
              at: new Date(now()).toISOString(),
            })
          );
        }
        if (answer.gaps.length > 0) emitActivity("gap", "completed");
        emitActivity("completion", "completed");
        await activityJournal.flush();
        durableChatSession = completeChatTurnV1({
          session: durableChatSession!,
          expectedSessionRevision: durableChatSession!.revision,
          turnId: turn.turnId,
          answer,
          acceptedStrategy: answer.strategy,
          ...(agenticWorkflow
            ? { acceptedWorkflowRef: `chat-workflow:${turn.turnId}` }
            : {}),
          activityRefs: activityJournal.referencesForTurn(turn.turnId),
          evidenceRecords,
          completedAt: new Date(completedAtMs).toISOString(),
        });
        await input.workspace.writeFile(
          CHAT_SESSION_PATH_V1,
          JSON.stringify(durableChatSession),
        );
        await input.workspace.writeFile("/.atlcli/chat/v1/answer.md", answer.messageMarkdown);
        input.onProgress?.({
          phase: "complete",
          message: "Chat answer complete.",
          completedCalls: answer.run.counts.ptcCalls,
          maxCalls: turn.limits.maxPtcCalls,
        });
        return answer;
      } catch (error) {
        if (error instanceof ChatUserQuestionRequiredError) {
          throw error;
        }
        const classified = classifyResearchError(error);
        const resumableStreamFailure = Boolean(
          modelCheckpointEntered &&
          resumableRootModelFailure &&
          resumeEnvelope &&
          interactionController &&
          durableChatSession &&
          !controller.signal.aborted &&
          (classified.code === "provider-error" || classified.code === "rate-limited"),
        );
        if (resumableStreamFailure) {
          const interruptedAt = new Date(now()).toISOString();
          await interactionController!.update((state) =>
            recordChatStreamInterruptionV1({
              state,
              expectedRevision: state.revision,
              turnId: turn.turnId,
              resume: resumeEnvelope!,
              at: interruptedAt,
            })
          );
          durableChatSession = pauseChatTurnV1({
            session: durableChatSession!,
            expectedSessionRevision: durableChatSession!.revision,
            turnId: turn.turnId,
            reason: "stream-interruption",
            at: interruptedAt,
          });
          await input.workspace.writeFile(
            CHAT_SESSION_PATH_V1,
            JSON.stringify(durableChatSession),
          );
          emitActivity("continuation", "failed");
          throw new ChatContractError(
            "paused",
            "The Chat model stream was interrupted at a durable checkpoint and can be resumed; partial tokens are not replayed.",
          );
        }
        const steeringPause = Boolean(
          controller.signal.aborted &&
          interactionController?.snapshot().pendingSteering &&
          input.signal?.reason &&
          typeof input.signal.reason === "object" &&
          "code" in input.signal.reason &&
          input.signal.reason.code === "paused",
        );
        if (controller.signal.aborted && interactionController && !steeringPause) {
          try {
            let interaction = interactionController.snapshot();
            if (!interaction.stop || interaction.stop.acknowledgedAt) {
              interaction = await interactionController.update((state) =>
                requestChatStopV1({
                  state,
                  expectedRevision: state.revision,
                  at: new Date(now()).toISOString(),
                })
              );
            }
            if (interaction.stop && !interaction.stop.acknowledgedAt) {
              await interactionController.update((state) =>
                acknowledgeChatStopV1({
                  state,
                  expectedRevision: state.revision,
                  expectedStopRevision: interaction.stop!.revision,
                  at: new Date(now()).toISOString(),
                })
              );
            }
            if (input.signal?.aborted) emitActivity("stop", "completed");
          } catch {
            // Cancellation remains authoritative even if its best-effort
            // interaction acknowledgement cannot be published.
          }
        }
        if (durableChatSession) {
          try {
            const interruptedAt = new Date(now()).toISOString();
            if (steeringPause) {
              durableChatSession = advanceChatControlFenceV1({
                session: durableChatSession,
                expectedSessionRevision: durableChatSession.revision,
                kind: "steering",
                at: interruptedAt,
              });
              durableChatSession = pauseChatTurnV1({
                session: durableChatSession,
                expectedSessionRevision: durableChatSession.revision,
                turnId: turn.turnId,
                reason: "steering",
                at: interruptedAt,
              });
              emitActivity("steering", "started");
            } else {
              durableChatSession = interruptChatTurnV1({
                session: durableChatSession,
                expectedSessionRevision: durableChatSession.revision,
                turnId: turn.turnId,
                status: controller.signal.aborted ? "cancelled" : "failed",
                at: interruptedAt,
              });
            }
            await input.workspace.writeFile(
              CHAT_SESSION_PATH_V1,
              JSON.stringify(durableChatSession),
            );
          } catch {
            // Never replace the causal model/provider/runtime failure with a
            // best-effort state-publication failure.
          }
        }
        if (!controller.signal.aborted) controller.abort(error);
        if (controller.signal.aborted) {
          throw controller.signal.reason instanceof Error
            ? controller.signal.reason
            : new ChatContractError("cancelled", "The Chat turn was cancelled.");
        }
        throw error;
      } finally {
        try {
          await activityJournal?.flush();
        } catch {
          // A causal provider/runtime failure remains authoritative. Successful
          // completion awaits the journal before publishing the final turn.
        }
        globalThis.clearTimeout(timeout);
        input.signal?.removeEventListener("abort", forwardAbort);
        controller.signal.removeEventListener("abort", onAbort);
        activeBroker?.cancel();
      }
    },
  };
}
