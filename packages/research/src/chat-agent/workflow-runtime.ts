import { createCodeInterpreterMiddleware, toCamelCase } from "@langchain/quickjs";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { tool, type DynamicStructuredTool } from "@langchain/core/tools";
import { createMiddleware, providerStrategy, toolStrategy, type AgentMiddleware } from "langchain";
import { z } from "zod/v4";
import type { SubAgent } from "deepagents/browser";
import type { ResearchPtcDiagnosticV1 } from "../agent-tools.js";
import type { ResearchCapabilityBroker } from "../broker.js";
import type {
  ResearchModelBudgetStateV1,
  ResearchModelRunBudget,
  ResearchRunBudget,
} from "../budget.js";
import {
  RESEARCH_LANGCHAIN_TOOL_NAMES,
} from "../capability-contracts.js";
import type { ResearchLimitsV1, ResearchProduct } from "../contracts.js";
import type { ProviderReasoningPreferenceV1 } from "../quality-policy.js";
import {
  createAgenticDispatchInterceptionAdapter,
  type AgenticDispatchInterceptionAdapter,
  type AgenticTaskToolInputV1,
  type ResearchDispatchDiagnosticV1,
} from "../dispatch-adapter.js";
import type { ResearchWorkspace } from "../workspace.js";
import { createResearchModelBudgetMiddlewareV1 } from "../model-budget-middleware.js";
import {
  CHAT_AGENT_DRAFT_SCHEMA_V1,
  ChatContractError,
  type ChatAgentDraftV1,
} from "./contracts.js";
import { createChatPtcToolsV1 } from "./retrieval.js";
import type { ChatCandidateLedgerControllerV1 } from "./retrieval-plan.js";
import type { ChatStrategyDecisionV1 } from "./strategy.js";
import {
  CHAT_SUBAGENT_PROFILES_V1,
  chatSubagentProfileByIdV1,
  createChatWorkflowDispatchV1,
  createChatWorkflowProposalControllerV1,
  parseChatSubagentResultV1,
  type AcceptedChatWorkflowV1,
  type ChatAnalysisPacketV1,
  type ChatCritiquePacketV1,
  type ChatEvidencePacketV1,
  type ChatSubagentProfileIdV1,
  type ChatSubagentResultV1,
  type ChatWorkflowAdmissionResponseV1,
  type ChatWorkflowDispatchV1,
  type ChatWorkflowProposalV1,
  type ChatWorkflowTaskProposalV1,
} from "./workflow.js";
import {
  assessChatGroundednessBeforeCriticV1,
  createChatQualityDispositionV1,
  persistChatQualityArtifactsV1,
  type ChatGroundednessAssessmentV1,
  type ChatQualityDispositionV1,
} from "./quality.js";

export const CHAT_WORKFLOW_STATE_PATH_V1 =
  "/.atlcli/chat/v1/workflow.json" as const;

export type ChatWorkflowTaskStatusV1 =
  | "admitted"
  | "started"
  | "completed"
  | "outcome_unknown"
  | "quarantined";

export interface ChatWorkflowStateV1 {
  schema: "atlcli.chat-workflow-state/v1";
  conversationId: string;
  turnId: string;
  strategy: ChatStrategyDecisionV1;
  accepted?: ChatWorkflowAdmissionResponseV1;
  taskStatuses: Record<string, ChatWorkflowTaskStatusV1>;
  acceptedResults: Record<string, ChatSubagentResultV1>;
}

export interface ChatQualityReviewResponseV1 {
  schema: "atlcli.chat-quality-review/v1";
  repairRequired: boolean;
  repairAdmitted: boolean;
  synthesizerTaskId: string;
  requiredGapCodes: string[];
  rejectedSourceIds: string[];
  dispatches: readonly Readonly<ChatWorkflowDispatchV1>[];
}

export interface ChatRepairAdmissionDecisionV1 {
  admit: boolean;
  reason?: "deadline-reserve" | "model-budget-reserve";
}

export interface ChatWorkflowRuntimeBindingsV1 {
  createSubAgentMiddleware:
    typeof import("deepagents/browser").createSubAgentMiddleware;
}

export interface ChatSubagentEvalDiagnosticV1 {
  profileId: ChatSubagentProfileIdV1;
  status: "started" | "success" | "error";
  attempt: number;
  codeChars?: number;
  usesToolsNamespace?: boolean;
  capabilityNames?: string[];
  searchInputShapes?: string[];
  argumentKeys?: string[];
  errorKind?: string;
  errorCode?:
    | "eval-attempt-exceeded"
    | "tool-error"
    | "undefined-symbol"
    | "invalid-input"
    | "timeout"
    | "other";
}

export interface ChatSubagentResultDiagnosticV1 {
  profileId: ChatSubagentProfileIdV1;
  status: "accepted" | "error";
  phase: "schema" | "evidence-reference";
  valueKind: "string" | "array" | "object" | "other";
  objectKeys?: string[];
  referenceKinds?: string[];
  unknownReferenceKinds?: string[];
}

function resultShapeV1(value: unknown): Pick<
  ChatSubagentResultDiagnosticV1,
  "valueKind" | "objectKeys"
> {
  if (typeof value === "string") return { valueKind: "string" };
  if (Array.isArray(value)) return { valueKind: "array" };
  if (value && typeof value === "object") {
    return {
      valueKind: "object",
      objectKeys: Object.keys(value as Record<string, unknown>).sort().slice(0, 20),
    };
  }
  return { valueKind: "other" };
}

function sourceReferenceKindV1(value: string): string {
  if (/^jira:/u.test(value)) return "canonical-jira-id";
  if (/^wiki:/u.test(value)) return "canonical-wiki-id";
  if (/^[A-Z][A-Z0-9_]*-\d+$/u.test(value)) return "issue-key";
  if (/^\d+$/u.test(value)) return "numeric-content-id";
  if (/^https?:\/\//u.test(value)) return "url";
  if (/^(?:research|chat)[-_:]/u.test(value)) return "opaque-ref";
  return "other";
}

function sourceReferenceDiagnosticV1(
  broker: ResearchCapabilityBroker,
  value: ChatSubagentResultV1,
): Pick<ChatSubagentResultDiagnosticV1, "referenceKinds" | "unknownReferenceKinds"> {
  const known = new Set(broker.detailEvidenceLedger().map((entry) => entry.source.id));
  const references = [...new Set(sourceIdsFromResult(value))];
  return {
    referenceKinds: [...new Set(references.map(sourceReferenceKindV1))].sort(),
    unknownReferenceKinds: [...new Set(references
      .filter((reference) => !known.has(reference))
      .map(sourceReferenceKindV1))].sort(),
  };
}

function classifyChildEvalErrorV1(error: unknown): Pick<
  ChatSubagentEvalDiagnosticV1,
  "errorKind" | "errorCode"
> {
  const name = error instanceof Error ? error.name : "unknown";
  const message = error instanceof Error ? error.message : String(error ?? "");
  const errorCode = /(?:not defined|not a function|undefined symbol)/iu.test(message)
    ? "undefined-symbol"
    : /(?:schema|validation|invalid (?:tool )?input|arguments?)/iu.test(message)
      ? "invalid-input"
      : /(?:timed? ?out|timeout)/iu.test(message)
        ? "timeout"
        : "other";
  return { errorKind: name.slice(0, 80), errorCode };
}

function classifyChildEvalToolResultV1(content: string): Pick<
  ChatSubagentEvalDiagnosticV1,
  "errorKind" | "errorCode"
> {
  const match = /^(SyntaxError|ReferenceError|TypeError|Error):/u.exec(
    content.trimStart(),
  );
  if (!match) return {};
  const errorCode = /(?:not defined|not a function|undefined symbol)/iu.test(content)
    ? "undefined-symbol"
    : /(?:schema|validation|invalid (?:tool )?input|arguments?)/iu.test(content)
      ? "invalid-input"
      : /(?:timed? ?out|timeout)/iu.test(content)
        ? "timeout"
        : "tool-error";
  return { errorKind: match[1], errorCode };
}

const taskInputSchema = z.object({
  description: z.string().min(1).max(16_000),
  subagent_type: z.string().min(1).max(240),
}).strict();

const directToolNameByCapability = {
  "atlassian.bound.read": "atlassian_bound_read",
  "atlassian.bound.section.read": "atlassian_bound_section_read",
} as const;

function toolNameForCapability(capabilityId: string): string | undefined {
  if (capabilityId in directToolNameByCapability) {
    return directToolNameByCapability[
      capabilityId as keyof typeof directToolNameByCapability
    ];
  }
  return RESEARCH_LANGCHAIN_TOOL_NAMES[
    capabilityId as keyof typeof RESEARCH_LANGCHAIN_TOOL_NAMES
  ];
}

function sourceIdsFromResult(value: ChatSubagentResultV1): string[] {
  if ("sourceIds" in value) {
    return [
      ...value.sourceIds,
      ...value.claims.flatMap((claim) => claim.sourceIds),
      ...value.relationships.flatMap((relationship) => [
        relationship.fromSourceId,
        relationship.toSourceId,
      ]),
    ];
  }
  if ("contradictions" in value) {
    return value.contradictions.flatMap((entry) => entry.sourceIds);
  }
  if ("defects" in value) {
    return value.defects.flatMap((entry) => entry.sourceIds);
  }
  return [
    ...value.citationSourceIds,
    ...value.gaps.flatMap((gap) => gap.sourceIds),
  ];
}

function assertKnownSourceReferencesV1(
  broker: ResearchCapabilityBroker,
  profileId: ChatSubagentProfileIdV1,
  value: ChatSubagentResultV1,
): void {
  const known = new Set(
    broker.detailEvidenceLedger().map((entry) => entry.source.id),
  );
  const unknown = [...new Set(sourceIdsFromResult(value))]
    .filter((sourceId) => !known.has(sourceId));
  if (unknown.length > 0) {
    throw new ChatContractError(
      "invalid-report",
      `Chat subagent ${profileId} referenced evidence that was not read in detail.`,
    );
  }
  if ("sourceIds" in value) {
    const packetSources = new Set(value.sourceIds);
    const escaped = sourceIdsFromResult(value)
      .filter((sourceId) => !packetSources.has(sourceId));
    if (escaped.length > 0) {
      throw new ChatContractError(
        "invalid-report",
        `Chat subagent ${profileId} returned claims outside its declared source packet.`,
      );
    }
  }
}

export function normalizeKnownSourceReferencesV1(
  broker: ResearchCapabilityBroker,
  value: ChatSubagentResultV1,
): ChatSubagentResultV1 {
  const aliases = new Map<string, string>();
  for (const entry of broker.detailEvidenceLedger()) {
    aliases.set(entry.source.id, entry.source.id);
    if (entry.source.issueKey) aliases.set(entry.source.issueKey, entry.source.id);
    if (entry.source.contentId) aliases.set(entry.source.contentId, entry.source.id);
    aliases.set(entry.source.url, entry.source.id);
  }
  const normalize = (candidate: unknown, key?: string): unknown => {
    if (typeof candidate === "string" && [
      "sourceId",
      "fromSourceId",
      "toSourceId",
    ].includes(key ?? "")) {
      return aliases.get(candidate) ?? candidate;
    }
    if (Array.isArray(candidate)) {
      if (key === "sourceIds" || key === "citationSourceIds") {
        return candidate.map((item) =>
          typeof item === "string" ? aliases.get(item) ?? item : item
        );
      }
      return candidate.map((item) => normalize(item));
    }
    if (!candidate || typeof candidate !== "object") return candidate;
    return Object.fromEntries(Object.entries(candidate as Record<string, unknown>)
      .map(([childKey, child]) => [childKey, normalize(child, childKey)]));
  };
  return normalize(structuredClone(value)) as ChatSubagentResultV1;
}

function profilePromptV1(input: {
  profile: (typeof CHAT_SUBAGENT_PROFILES_V1)[number];
  allowedToolNames: readonly string[];
  limits: ResearchLimitsV1;
  queryVariantMode?: boolean;
}): string {
  const searchBudget = Math.max(1, input.limits.maxSearchPagesPerProduct);
  const detailBudget = Math.max(1, input.limits.maxDetailItemsPerProduct);
  return [
    input.profile.systemPrompt,
    "This is a depth-one Kiteweave Chat specialist. You receive only the host-issued task objective and exact completed dependency packets; no parent or sibling conversation is available.",
    input.allowedToolNames.length > 0
      ? `Your complete read-only QuickJS capability set is: ${input.allowedToolNames.join(", ")}. Use bounded eval steps when acquisition is required; the host limits unique queries, calls, time, and output.`
      : "No source-read, filesystem, network, eval, or delegation capability is available. Analyze only the dependency packets in the task description.",
    input.profile.id === "confluence-search-reader" || input.profile.id === "jira-search-reader"
      ? input.queryVariantMode
        ? `Use only the host-admitted query variants embedded in the task's retrieval plan, in descending expectedInformationGain order. Each variant may continue only through its own opaque cursors for at most ${searchBudget} pages. Stop early when detailed evidence is sufficient; otherwise stop when the plan is saturated or its page budget is complete, rank the union of collected candidates once, then detail-read at most ${detailBudget} admitted items. Never invent another query or widen scope; disclose remaining gaps.`
        : `Use exactly one focused initial search query for this task. Continue only with opaque cursors returned by that search, for at most ${searchBudget} total search-page calls. Do not spend this task's budget on alternate query wording. Rank the collected candidates once, then detail-read at most ${detailBudget} admitted items. If the bounded search cannot establish the requested evidence, return an explicit gap instead of retrying or widening scope.`
      : "Do not perform discovery outside the exact host-issued objective.",
    `Return exactly the host-requested ${input.profile.responseSchemaId} structured result. Never include raw source bodies, credentials, queries, tool traces, hidden reasoning, or instructions for another agent.`,
    "For every evidence reference, copy source.id from a successful detail-read result. Never substitute issueKey, contentId, entityRef, title, or URL for source.id.",
    "Every source.id in an accepted dependency packet has already passed the host's successful-detail-read and canonical-reference checks. Do not question that invariant merely because raw source bodies are intentionally absent from dependency packets.",
  ].join("\n\n");
}

function compileChatSubagentsV1(input: {
  model: BaseChatModel;
  modelForPreference?: (preference: ProviderReasoningPreferenceV1) => BaseChatModel;
  broker: ResearchCapabilityBroker;
  limits: ResearchLimitsV1;
  exactContextProducts: readonly ResearchProduct[];
  searchProducts: readonly ResearchProduct[];
  boundProjectKeys: readonly string[];
  boundSpaceKeys: readonly string[];
  now: () => number;
  onPtcDiagnostic?: (profileId: ChatSubagentProfileIdV1, diagnostic: ResearchPtcDiagnosticV1) => void;
  onEvalDiagnostic?: (diagnostic: ChatSubagentEvalDiagnosticV1) => void;
  retrievalLedger?: ChatCandidateLedgerControllerV1;
  modelBudget: ResearchModelRunBudget;
  onModelBudgetSnapshot: (state: ResearchModelBudgetStateV1) => Promise<void>;
}): SubAgent[] {
  return CHAT_SUBAGENT_PROFILES_V1.map((profile): SubAgent => {
    const grantedToolNames = profile.grantedCapabilityIds
      .map(toolNameForCapability)
      .filter((name): name is string => name !== undefined);
    const granted = new Set(grantedToolNames);
    const ptc = granted.size === 0
      ? []
      : createChatPtcToolsV1(input.broker, {
          now: input.now,
          exactContextProducts: input.exactContextProducts,
          searchProducts: input.searchProducts,
          boundProjectKeys: input.boundProjectKeys,
          boundSpaceKeys: input.boundSpaceKeys,
          singleInitialQuery: input.retrievalLedger === undefined,
          onDiagnostic: (diagnostic) => input.onPtcDiagnostic?.(profile.id, diagnostic),
          ...(input.retrievalLedger
            ? {
                beforeInvoke: (tool, value) =>
                  input.retrievalLedger!.assertToolInput(tool, value),
                onResult: (tool, result, callId, value) =>
                  input.retrievalLedger!.observe(tool, result, callId, value),
              }
            : {}),
        }).filter((candidate) => granted.has(candidate.name));
    if (profile.id === "confluence-search-reader" || profile.id === "jira-search-reader") {
      const searchToolName = profile.id === "confluence-search-reader"
        ? "wiki_search"
        : "jira_issue_search";
      const searchTool = ptc.find((candidate) => candidate.name === searchToolName);
      if (searchTool) {
        searchTool.description = [
          searchTool.description,
          input.retrievalLedger
            ? "Use only query variants in the host-issued retrieval plan. The host rejects invented queries, excess pages, foreign cursors, and scope changes before HTTP."
            : "This specialist may start exactly one initial query. After that call, use only its returned opaque nextCursor until complete; never start a second query variant in this task. If the bounded result is insufficient, report a gap.",
        ].join(" ");
      }
    }
    let evalAttempts = 0;
    const maxEvalAttempts = profile.id === "confluence-search-reader" ||
        profile.id === "jira-search-reader"
      ? 8
      : 4;
    const evalGuard = createMiddleware({
      name: `ChatSubagentEvalGuard:${profile.id}`,
      async wrapToolCall(request, handler) {
        if (request.toolCall.name !== "eval") return handler(request);
        evalAttempts += 1;
        const code = request.toolCall.args && typeof request.toolCall.args === "object" &&
          "code" in request.toolCall.args && typeof request.toolCall.args.code === "string"
          ? request.toolCall.args.code
          : "";
        const capabilityNames = [
          "atlassianBoundRead",
          "atlassianBoundSectionRead",
          "jiraIssueSearch",
          "jiraIssueGet",
          "wikiSearch",
          "wikiPageGet",
          "researchCandidateRank",
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
          return [new RegExp(
            `\\b${functionName}\\s*\\(\\s*\\{\\s*query\\s*:\\s*\\{[^}]*\\btext\\s*:`,
            "u",
          ).test(code) ? `${label}:query-text` : `${label}:query-other`];
        });
        const argumentKeys = [...new Set(
          [...code.matchAll(/\b([A-Za-z_$][A-Za-z0-9_$]*)\s*:/gu)]
            .map((match) => match[1]!)
            .filter((key) => key.length <= 80),
        )].sort();
        input.onEvalDiagnostic?.({
          profileId: profile.id,
          status: "started",
          attempt: evalAttempts,
          codeChars: code.length,
          usesToolsNamespace: /\btools\s*\./u.test(code),
          capabilityNames,
          searchInputShapes,
          argumentKeys,
        });
        if (evalAttempts > maxEvalAttempts) {
          input.onEvalDiagnostic?.({
            profileId: profile.id,
            status: "error",
            attempt: evalAttempts,
            errorCode: "eval-attempt-exceeded",
          });
          throw new ChatContractError(
            "limit-exceeded",
            `Chat specialist ${profile.id} exceeded its bounded eval step limit.`,
          );
        }
        try {
          const response = await handler(request);
          const content = response && typeof response === "object" && "content" in response
            ? String((response as { content?: unknown }).content ?? "")
            : String(response ?? "");
          const failure = classifyChildEvalToolResultV1(content);
          const failed = failure.errorCode !== undefined;
          input.onEvalDiagnostic?.({
            profileId: profile.id,
            status: failed ? "error" : "success",
            attempt: evalAttempts,
            ...failure,
          });
          return response;
        } catch (error) {
          input.onEvalDiagnostic?.({
            profileId: profile.id,
            status: "error",
            attempt: evalAttempts,
            ...classifyChildEvalErrorV1(error),
          });
          throw error;
        }
      },
    });
    const maxModelOutputTokens = Math.min(
      input.limits.maxModelOutputTokens,
      profile.modelPreference === "fast" ? 2_048 : profile.modelPreference === "balanced" ? 4_096 : 5_000,
    );
    const modelBudgetMiddleware: AgentMiddleware = createResearchModelBudgetMiddlewareV1(
      input.modelBudget,
      {
        name: `ChatModelBudgetMiddleware:${profile.id}`,
        maxOutputTokens: maxModelOutputTokens,
        ...(profile.id === "chat-synthesizer"
          ? {}
          : { retain: { calls: 1, inputTokens: 4_096, outputTokens: 5_000 } }),
        onSnapshot: async (_snapshot, state) => input.onModelBudgetSnapshot(state),
      },
    );
    return {
      name: profile.subagentType,
      description: profile.description,
      model: input.modelForPreference?.(profile.modelPreference) ?? input.model,
      systemPrompt: profilePromptV1({
        profile,
        // @langchain/quickjs exposes registered LangChain tools through the
        // generated camelCase tools.* namespace. Repeating the underlying
        // snake_case registry name here makes an otherwise correct model call
        // fail before the host capability is reached.
        allowedToolNames: ptc.map((candidate) => toCamelCase(candidate.name)),
        limits: input.limits,
        queryVariantMode: input.retrievalLedger !== undefined,
      }),
      tools: [],
      middleware: [modelBudgetMiddleware, ...(ptc.length === 0
        ? []
        : [evalGuard, createCodeInterpreterMiddleware({
            ptc,
            subagents: false,
            toolName: "eval",
            systemPrompt: "Use the documented tools.* functions only. Top-level await is available. Return the useful value as the final expression; console and delegation are unavailable.",
            memoryLimitBytes: input.limits.maxInterpreterMemoryBytes,
            maxStackSizeBytes: 320 * 1024,
            executionTimeoutMs: Math.min(
              profile.maxDurationMs,
              input.limits.maxInterpreterMs,
            ),
            maxPtcCalls: Math.max(
              1,
              Math.min(input.limits.maxPtcCalls, profile.grantedCapabilityIds.length * 3),
            ),
            maxResultChars: Math.min(
              input.limits.maxPtcOutputBytes,
              profile.maxResultBytes,
            ),
            captureConsole: false,
          })])],
    };
  });
}

function cloneWorkflowStateV1(state: ChatWorkflowStateV1): ChatWorkflowStateV1 {
  return structuredClone(state);
}

export function createChatAgenticWorkflowRuntimeV1(input: {
  runtime: ChatWorkflowRuntimeBindingsV1;
  model: BaseChatModel;
  modelForPreference?: (preference: ProviderReasoningPreferenceV1) => BaseChatModel;
  structuredOutput: "native" | "tool";
  projectResponseSchema?: (
    schema: Readonly<Record<string, unknown>>,
  ) => Readonly<Record<string, unknown>>;
  strategy: ChatStrategyDecisionV1;
  budget: ResearchRunBudget;
  modelBudget: ResearchModelRunBudget;
  onModelBudgetSnapshot: (state: ResearchModelBudgetStateV1) => Promise<void>;
  broker: ResearchCapabilityBroker;
  workspace: ResearchWorkspace;
  conversationId: string;
  turnId: string;
  question: string;
  siteOrigin: string;
  taskContext: string | (() => string);
  limits: ResearchLimitsV1;
  exactContextProducts: readonly ResearchProduct[];
  searchProducts: readonly ResearchProduct[];
  boundProjectKeys: readonly string[];
  boundSpaceKeys: readonly string[];
  signal: AbortSignal;
  beforeProposal?: () => void;
  beforeWorkflowAdmission?: (proposal: ChatWorkflowProposalV1) => void | Promise<void>;
  beforeCritic?: () => void | Promise<void>;
  beforeSynthesis?: () => void | Promise<void>;
  decideRepairAdmission?: (
    disposition: ChatQualityDispositionV1,
  ) => ChatRepairAdmissionDecisionV1;
  now?: () => number;
  onPtcDiagnostic?: (profileId: ChatSubagentProfileIdV1, diagnostic: ResearchPtcDiagnosticV1) => void;
  onEvalDiagnostic?: (diagnostic: ChatSubagentEvalDiagnosticV1) => void;
  onResultDiagnostic?: (diagnostic: ChatSubagentResultDiagnosticV1) => void;
  onDispatchDiagnostic?: (diagnostic: ResearchDispatchDiagnosticV1) => void;
  retrievalLedger?: ChatCandidateLedgerControllerV1;
}): {
  middleware: ReturnType<ChatWorkflowRuntimeBindingsV1["createSubAgentMiddleware"]>;
  proposalTool: DynamicStructuredTool;
  qualityReviewTool: DynamicStructuredTool;
  acceptedWorkflow(): AcceptedChatWorkflowV1 | undefined;
  acceptedResponse(): ChatWorkflowAdmissionResponseV1 | undefined;
  finalDraft(): ChatAgentDraftV1 | undefined;
  qualityDisposition(): ChatQualityDispositionV1 | undefined;
  assertComplete(): ChatAgentDraftV1;
  dispatchSnapshot(): ReturnType<AgenticDispatchInterceptionAdapter["snapshot"]>;
} {
  if (input.strategy.execution !== "agentic") {
    throw new ChatContractError(
      "invalid-request",
      "A direct Chat strategy cannot construct an agentic workflow runtime.",
    );
  }
  const now = input.now ?? Date.now;
  const state: ChatWorkflowStateV1 = {
    schema: "atlcli.chat-workflow-state/v1",
    conversationId: input.conversationId,
    turnId: input.turnId,
    strategy: structuredClone(input.strategy),
    taskStatuses: {},
    acceptedResults: {},
  };
  let persistence = Promise.resolve();
  const persistState = (): Promise<void> => {
    const snapshot = JSON.stringify(cloneWorkflowStateV1(state));
    persistence = persistence.then(() =>
      input.workspace.writeFile(CHAT_WORKFLOW_STATE_PATH_V1, snapshot)
    );
    return persistence;
  };
  let finalDraft: ChatAgentDraftV1 | undefined;
  let acceptedWorkflow: AcceptedChatWorkflowV1 | undefined;
  let groundednessAssessment: ChatGroundednessAssessmentV1 | undefined;
  let qualityDisposition: ChatQualityDispositionV1 | undefined;
  let qualityReviewStarted = false;
  const profileByTaskId = new Map<string, ChatSubagentProfileIdV1>();

  const referencedSourceIds = (): string[] => [...new Set(
    Object.values(state.acceptedResults).flatMap(sourceIdsFromResult),
  )].sort((left, right) => left.localeCompare(right, "en-US"));

  const ensureGroundednessAssessment = async (): Promise<ChatGroundednessAssessmentV1> => {
    if (groundednessAssessment) return groundednessAssessment;
    await input.beforeCritic?.();
    const retrieval = input.retrievalLedger?.assessment();
    if (!retrieval) {
      throw new ChatContractError(
        "invalid-report",
        "Agentic Chat quality review requires the host retrieval assessment.",
      );
    }
    const contradictionCount = Object.values(state.acceptedResults)
      .filter((result): result is ChatAnalysisPacketV1 => "contradictions" in result)
      .reduce((total, result) => total + result.contradictions.length, 0);
    groundednessAssessment = assessChatGroundednessBeforeCriticV1({
      conversationId: input.conversationId,
      turnId: input.turnId,
      question: input.question,
      siteOrigin: input.siteOrigin,
      evidence: input.broker.detailEvidenceLedger(),
      referencedSourceIds: referencedSourceIds(),
      retrieval,
      contradictionCount,
      now,
    });
    await persistChatQualityArtifactsV1({
      workspace: input.workspace,
      assessment: groundednessAssessment,
    });
    return groundednessAssessment;
  };
  const subagents = compileChatSubagentsV1({
    model: input.model,
    modelForPreference: input.modelForPreference,
    broker: input.broker,
    limits: input.limits,
    exactContextProducts: input.exactContextProducts,
    searchProducts: input.searchProducts,
    boundProjectKeys: input.boundProjectKeys,
    boundSpaceKeys: input.boundSpaceKeys,
    now,
    onPtcDiagnostic: input.onPtcDiagnostic,
    ...(input.onEvalDiagnostic ? { onEvalDiagnostic: input.onEvalDiagnostic } : {}),
    ...(input.retrievalLedger ? { retrievalLedger: input.retrievalLedger } : {}),
    modelBudget: input.modelBudget,
    onModelBudgetSnapshot: input.onModelBudgetSnapshot,
  });
  const upstream = input.runtime.createSubAgentMiddleware({
    defaultModel: input.model,
    defaultTools: [],
    defaultMiddleware: [],
    subagents,
    generalPurposeAgent: false,
    taskDescription:
      "Run only a host-admitted Kiteweave Chat task using the exact description and subagent type returned by chatWorkflowPropose.",
  });
  const upstreamTask = upstream.tools?.find((candidate) => candidate.name === "task");
  if (!upstreamTask) {
    throw new ChatContractError(
      "invalid-request",
      "DeepAgentsJS did not provide the declarative Chat task tool.",
    );
  }

  const dispatch = createAgenticDispatchInterceptionAdapter({
    admissions: [],
    maxTasks: CHAT_SUBAGENT_PROFILES_V1.length,
    maxConcurrency: 3,
    allowHostDependencyHydration: true,
    signal: input.signal,
    invokeUpstream: (taskInput, config) => upstreamTask.invoke(taskInput, config),
    projectResult: (raw, task) => {
      const profileId = profileByTaskId.get(task.taskId);
      if (!profileId) {
        throw new ChatContractError(
          "invalid-report",
          "A Chat task returned without an admitted host profile.",
        );
      }
      let result: ChatSubagentResultV1;
      try {
        result = normalizeKnownSourceReferencesV1(
          input.broker,
          parseChatSubagentResultV1(profileId, raw),
        );
      } catch (error) {
        input.onResultDiagnostic?.({
          profileId,
          status: "error",
          phase: "schema",
          ...resultShapeV1(raw),
        });
        throw error;
      }
      try {
        assertKnownSourceReferencesV1(input.broker, profileId, result);
      } catch (error) {
        input.onResultDiagnostic?.({
          profileId,
          status: "error",
          phase: "evidence-reference",
          ...resultShapeV1(raw),
          ...sourceReferenceDiagnosticV1(input.broker, result),
        });
        throw error;
      }
      input.onResultDiagnostic?.({
        profileId,
        status: "accepted",
        phase: "evidence-reference",
        ...resultShapeV1(raw),
        ...sourceReferenceDiagnosticV1(input.broker, result),
      });
      return result;
    },
    projectDependencyResult: (_taskId, result) => structuredClone(result),
    projectResponseFormat: input.structuredOutput === "native"
      ? (schema, admission) => {
          const selected = CHAT_SUBAGENT_PROFILES_V1.find((profile) =>
            profile.subagentType === admission.subagentType
          );
          if (selected?.id !== "chat-synthesizer") {
            return toolStrategy(schema as {
              type: "object";
              properties?: Record<string, unknown>;
              required?: string[];
              additionalProperties?: boolean;
              [key: string]: unknown;
            });
          }
          return providerStrategy((input.projectResponseSchema?.(schema) ?? schema) as {
            type: "object";
            properties?: Record<string, unknown>;
            required?: string[];
            additionalProperties?: boolean;
            [key: string]: unknown;
          });
        }
      : undefined,
    beforeInvoke: async ({ taskId }) => {
      const profileId = profileByTaskId.get(taskId);
      if (profileId === "answer-critic") await ensureGroundednessAssessment();
      if (profileId === "answer-repairer" && !qualityDisposition?.repairAdmitted) {
        throw new ChatContractError(
          "invalid-request",
          "A Chat answer repair can run only after host quality admission.",
        );
      }
      if (profileId === "chat-synthesizer" && !qualityDisposition?.synthesisAllowed) {
        throw new ChatContractError(
          "invalid-request",
          "Chat synthesis is fenced until the host quality review completes.",
        );
      }
      if (profileId === "chat-synthesizer") await input.beforeSynthesis?.();
      state.taskStatuses[taskId] = "started";
      await persistState();
    },
    acceptResult: async (taskId, result) => {
      const profileId = profileByTaskId.get(taskId);
      if (!profileId) {
        throw new ChatContractError("invalid-report", "Chat task profile is missing.");
      }
      const accepted = result as ChatSubagentResultV1;
      state.acceptedResults[taskId] = structuredClone(accepted);
      state.taskStatuses[taskId] = "completed";
      if (profileId === "chat-synthesizer") {
        finalDraft = CHAT_AGENT_DRAFT_SCHEMA_V1.parse(accepted);
      }
      await persistState();
    },
    onUncommittedOutcome: async ({ taskId }) => {
      state.taskStatuses[taskId] = "outcome_unknown";
      await persistState();
    },
    onLateResult: async ({ taskId }) => {
      state.taskStatuses[taskId] = "quarantined";
      await persistState();
    },
    onDiagnostic: input.onDispatchDiagnostic,
  });

  const proposal = createChatWorkflowProposalControllerV1({
    strategy: input.strategy,
    budget: input.budget,
    taskContext: input.taskContext,
    allowedProfileIds: CHAT_SUBAGENT_PROFILES_V1
      .filter((profile) => {
        if (profile.id === "exact-context-reader") {
          return input.exactContextProducts.length > 0;
        }
        if (profile.id === "jira-search-reader") {
          return input.searchProducts.includes("jira");
        }
        if (profile.id === "confluence-search-reader") {
          return input.searchProducts.includes("confluence");
        }
        return true;
      })
      .map((profile) => profile.id),
    beforeProposal: input.beforeProposal,
    beforeAdmission: input.beforeWorkflowAdmission,
    onAccepted: async (workflow, response) => {
      dispatch.replaceAdmissions(workflow.admissions.filter((admission) =>
        admission.taskId !== workflow.synthesizerTaskId
      ));
      dispatch.setMaxConcurrency(workflow.compiled.maxConcurrency);
      acceptedWorkflow = workflow;
      for (const task of workflow.tasks) {
        profileByTaskId.set(task.taskId, task.profileId);
        if (task.taskId !== workflow.synthesizerTaskId) {
          state.taskStatuses[task.taskId] = "admitted";
        }
      }
      state.accepted = structuredClone(response);
      await persistState();
    },
  });

  const qualityReviewTool = tool(async () => {
    if (qualityReviewStarted || qualityDisposition) {
      throw new ChatContractError(
        "invalid-request",
        "The Chat quality review may run exactly once per agentic turn.",
      );
    }
    qualityReviewStarted = true;
    input.budget.beginPtc({ schema: "atlcli.chat-quality-review-request/v1" });
    const workflow = acceptedWorkflow;
    if (!workflow) {
      throw new ChatContractError(
        "invalid-request",
        "The Chat quality review requires one accepted workflow.",
      );
    }
    const snapshot = dispatch.snapshot();
    const preSynthesisTasks = workflow.tasks.filter((task) =>
      task.taskId !== workflow.synthesizerTaskId
    );
    if (preSynthesisTasks.some((task) => snapshot.taskStatuses[task.taskId] !== "completed")) {
      throw new ChatContractError(
        "invalid-request",
        "The Chat quality review requires every provisional and critic task to be complete.",
      );
    }
    const assessment = await ensureGroundednessAssessment();
    const criticTask = workflow.tasks.find((task) => task.profileId === "answer-critic");
    const critic = criticTask
      ? state.acceptedResults[criticTask.taskId]
      : undefined;
    if (!critic || !("defects" in critic)) {
      throw new ChatContractError(
        "invalid-report",
        "The Chat quality review requires one accepted typed critic packet.",
      );
    }
    const criticPacket = critic as ChatCritiquePacketV1;
    const preliminary = createChatQualityDispositionV1({
      assessment,
      criticDefects: criticPacket.defects,
      repairAdmitted: false,
      now,
    });
    const repairDecision = preliminary.repairRequired
      ? input.decideRepairAdmission?.(preliminary) ?? { admit: true }
      : { admit: false };
    if (!repairDecision.admit && preliminary.repairRequired && !repairDecision.reason) {
      throw new ChatContractError(
        "invalid-request",
        "A skipped Chat repair requires a host reserve reason.",
      );
    }
    qualityDisposition = createChatQualityDispositionV1({
      assessment,
      criticDefects: criticPacket.defects,
      repairAdmitted: repairDecision.admit,
      ...(repairDecision.reason ? { repairSkippedReason: repairDecision.reason } : {}),
      now,
    });
    await persistChatQualityArtifactsV1({
      workspace: input.workspace,
      assessment,
      disposition: qualityDisposition,
    });

    const allInitialDependencyIds = preSynthesisTasks.map((task) => task.taskId);
    const appendedTasks: ChatWorkflowTaskProposalV1[] = [];
    if (qualityDisposition.repairAdmitted) {
      const repairTask: ChatWorkflowTaskProposalV1 = {
        taskId: `task:answer-repair:${input.turnId.replace(/[^A-Za-z0-9._-]/gu, "-").slice(-80)}`,
        profileId: "answer-repairer",
        objective: [
          "Repair the provisional answer only for the host-admitted quality defects.",
          JSON.stringify({
            repairDefectIds: qualityDisposition.repairDefectIds,
            requiredGapCodes: qualityDisposition.requiredGapCodes,
            rejectedSourceIds: qualityDisposition.rejectedSourceIds,
          }),
        ].join("\n"),
        dependencyTaskIds: allInitialDependencyIds,
      };
      appendedTasks.push(repairTask);
    }
    const originalSynth = workflow.tasks.find((task) =>
      task.taskId === workflow.synthesizerTaskId
    );
    if (!originalSynth) {
      throw new ChatContractError("invalid-report", "The Chat synthesizer definition is missing.");
    }
    const synthTask: ChatWorkflowTaskProposalV1 = {
      ...originalSynth,
      objective: [
        originalSynth.objective,
        "Host quality disposition:",
        JSON.stringify({
          requiredGapCodes: qualityDisposition.requiredGapCodes,
          rejectedSourceIds: qualityDisposition.rejectedSourceIds,
          repairAdmitted: qualityDisposition.repairAdmitted,
          repairSkippedReason: qualityDisposition.repairSkippedReason,
        }),
      ].join("\n\n"),
      dependencyTaskIds: [
        ...allInitialDependencyIds,
        ...appendedTasks.map((task) => task.taskId),
      ],
    };
    appendedTasks.push(synthTask);
    const admissions = appendedTasks.map((task) => {
      const selected = chatSubagentProfileByIdV1(task.profileId);
      profileByTaskId.set(task.taskId, task.profileId);
      state.taskStatuses[task.taskId] = "admitted";
      return {
        taskId: task.taskId,
        subagentType: selected.subagentType,
        objective: task.objective,
        dependsOnTaskIds: Object.freeze([...task.dependencyTaskIds]),
        grantedCapabilityIds: selected.grantedCapabilityIds,
        responseSchema: selected.responseSchema,
        maxResultBytes: selected.maxResultBytes,
        maxDurationMs: selected.maxDurationMs,
      };
    });
    dispatch.appendAdmissions(admissions);
    await persistState();
    const response: ChatQualityReviewResponseV1 = {
      schema: "atlcli.chat-quality-review/v1",
      repairRequired: qualityDisposition.repairRequired,
      repairAdmitted: qualityDisposition.repairAdmitted,
      synthesizerTaskId: synthTask.taskId,
      requiredGapCodes: [...qualityDisposition.requiredGapCodes],
      rejectedSourceIds: [...qualityDisposition.rejectedSourceIds],
      dispatches: Object.freeze(appendedTasks.map((task) =>
        createChatWorkflowDispatchV1({
          task,
          profile: chatSubagentProfileByIdV1(task.profileId),
        })
      )),
    };
    input.budget.completePtc(response);
    return JSON.stringify(response);
  }, {
    name: "chat_quality_review",
    description:
      "Run the mandatory host quality checkpoint exactly once after the provisional answer and independent critic complete. The host returns an optional single repair dispatch followed by the sole final synthesizer dispatch.",
    schema: z.object({}).strict(),
  });

  const boundedTask = tool(
    (taskInput: AgenticTaskToolInputV1, config) => dispatch.invoke(taskInput, config),
    {
      name: "task",
      description:
        "Execute one host-admitted depth-one Chat specialist. Copy description, subagent_type, and responseSchema exactly from chatWorkflowPropose; dependencies and limits are host-owned.",
      schema: taskInputSchema,
    },
  );
  const middleware = {
    ...upstream,
    name: "subAgentMiddleware" as const,
    tools: [boundedTask],
  } as ReturnType<ChatWorkflowRuntimeBindingsV1["createSubAgentMiddleware"]>;

  return {
    middleware,
    proposalTool: proposal.tool,
    qualityReviewTool,
    acceptedWorkflow: proposal.acceptedWorkflow,
    acceptedResponse: proposal.acceptedResponse,
    finalDraft: () => finalDraft,
    qualityDisposition: () => qualityDisposition
      ? structuredClone(qualityDisposition)
      : undefined,
    assertComplete() {
      proposal.assertAccepted();
      const workflow = acceptedWorkflow;
      if (!workflow) {
        throw new ChatContractError("invalid-report", "The Chat workflow was not accepted.");
      }
      const snapshot = dispatch.snapshot();
      if (Object.values(state.taskStatuses).some((status) => status !== "completed")) {
        throw new ChatContractError(
          "invalid-report",
          "The Chat workflow returned before every admitted task completed.",
        );
      }
      if (!finalDraft) {
        throw new ChatContractError(
          "invalid-report",
          "The dedicated Chat synthesizer did not return the final answer draft.",
        );
      }
      if (!qualityDisposition) {
        throw new ChatContractError(
          "invalid-report",
          "The agentic Chat workflow completed without its mandatory quality disposition.",
        );
      }
      return structuredClone(finalDraft);
    },
    dispatchSnapshot: dispatch.snapshot,
  };
}

export function isChatEvidencePacketV1(value: unknown): value is ChatEvidencePacketV1 {
  return Boolean(value && typeof value === "object" &&
    (value as { schema?: unknown }).schema === "atlcli.chat-evidence-packet/v1");
}
