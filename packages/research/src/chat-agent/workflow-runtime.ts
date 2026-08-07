import { createCodeInterpreterMiddleware, toCamelCase } from "@langchain/quickjs";
import { CallbackManager } from "@langchain/core/callbacks/manager";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { ChatModelStreamEvent } from "@langchain/core/language_models/event";
import { ToolMessage } from "@langchain/core/messages";
import type { RunnableConfig } from "@langchain/core/runnables";
import { tool, type DynamicStructuredTool } from "@langchain/core/tools";
import { createMiddleware, toolStrategy, type AgentMiddleware } from "langchain";
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
  chatFinalGapCodeForQualityDefectV1,
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

export interface ChatWorkflowAdvanceResponseV1 {
  schema: "atlcli.chat-workflow-advance/v1";
  status:
    | "strategy-review-required"
    | "quality-review-required"
    | "complete";
  completedTaskIds: string[];
  remainingTaskIds: string[];
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

export interface ChatSubagentModelStreamEventV1 {
  taskId: string;
  profileId: ChatSubagentProfileIdV1;
  runId: string;
  event: ChatModelStreamEvent;
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

function isBoundedSearchAcquisitionErrorV1(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /(?:search page budget was exhausted|search query is not an admitted retrieval-plan variant|search exceeds its admitted page or terminal boundary|search cursor is not part of the admitted retrieval plan|exceeded its bounded eval step limit)/iu
    .test(message);
}

function exhaustedSearchGapPacketV1(product: ResearchProduct): ChatEvidencePacketV1 {
  const label = product === "confluence" ? "Confluence" : "Jira";
  return {
    schema: "atlcli.chat-evidence-packet/v1",
    sourceIds: [],
    claims: [],
    relationships: [],
    gaps: [
      `${label} discovery exhausted every host-admitted query variant without detail evidence; no broader query or scope was attempted.`,
    ],
  };
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
      return aliases.get(candidate) ??
        broker.canonicalDetailSourceIdForRef(candidate) ??
        candidate;
    }
    if (Array.isArray(candidate)) {
      if (key === "sourceIds" || key === "citationSourceIds") {
        return candidate.map((item) =>
          typeof item === "string"
            ? aliases.get(item) ?? broker.canonicalDetailSourceIdForRef(item) ?? item
            : item
        );
      }
      return candidate.map((item) => normalize(item));
    }
    if (!candidate || typeof candidate !== "object") return candidate;
    return Object.fromEntries(Object.entries(candidate as Record<string, unknown>)
      .map(([childKey, child]) => [childKey, normalize(child, childKey)]));
  };
  const normalized = normalize(structuredClone(value)) as ChatSubagentResultV1;
  if ("sourceIds" in normalized) {
    // Models occasionally omit a source from the packet-level inventory while
    // using the same canonical source in a typed claim or relationship. Close
    // that inventory deterministically; the following host check still rejects
    // every unknown or unread reference.
    normalized.sourceIds = [...new Set(sourceIdsFromResult(normalized))];
  }
  return normalized;
}

function profilePromptV1(input: {
  profile: (typeof CHAT_SUBAGENT_PROFILES_V1)[number];
  allowedToolNames: readonly string[];
  limits: ResearchLimitsV1;
  locale?: string;
  queryVariantMode?: boolean;
  detailLimit?: number;
}): string {
  const searchBudget = Math.max(1, input.limits.maxSearchPagesPerProduct);
  const detailBudget = Math.max(1, input.detailLimit ?? input.limits.maxDetailItemsPerProduct);
  return [
    input.profile.systemPrompt,
    input.locale?.toLowerCase().startsWith("de")
      ? "Write every user-visible answer fragment and provider-visible reasoning summary in German. Keep source titles, Jira keys, and URLs unchanged."
      : "Write every user-visible answer fragment and provider-visible reasoning summary in English unless the task explicitly requests another language.",
    "This is a depth-one Kiteweave Chat specialist. You receive only the host-issued task objective and exact completed dependency packets; no parent or sibling conversation is available.",
    input.allowedToolNames.length > 0
      ? `Your complete read-only QuickJS capability set is: ${input.allowedToolNames.join(", ")}. Use bounded eval steps when acquisition is required; the host limits unique queries, calls, time, and output.`
      : "No source-read, filesystem, network, eval, or delegation capability is available. Analyze only the dependency packets in the task description.",
    input.profile.id === "confluence-search-reader" || input.profile.id === "jira-search-reader"
      ? input.queryVariantMode
        ? `Call tools.chatRetrievalAcquire({}) exactly once. That host controller executes only the admitted query variants, bounded pagination, deduplication, ranking, and at most ${detailBudget} detail reads. Analyze its returned detail evidence and immediately return the requested packet. Never call eval or another capability again, invent a query, or widen scope; disclose remaining gaps.`
        : `Use exactly one focused initial search query for this task. Continue only with opaque cursors returned by that search, for at most ${searchBudget} total search-page calls. Do not spend this task's budget on alternate query wording. Rank the collected candidates once, then detail-read at most ${detailBudget} admitted items. If the bounded search cannot establish the requested evidence, return an explicit gap instead of retrying or widening scope.`
      : "Do not perform discovery outside the exact host-issued objective.",
    `Return exactly the host-requested ${input.profile.responseSchemaId} structured result. Never include raw source bodies, credentials, queries, tool traces, hidden reasoning, or instructions for another agent.`,
    "For every evidence reference, copy source.id from a successful detail-read result. Never substitute issueKey, contentId, entityRef, title, or URL for source.id.",
    "Every source.id in an accepted dependency packet has already passed the host's successful-detail-read and canonical-reference checks. Do not question that invariant merely because raw source bodies are intentionally absent from dependency packets.",
  ].join("\n\n");
}

function parsedToolJsonV1(value: unknown, label: string): Record<string, unknown> {
  const parsed = typeof value === "string" ? JSON.parse(value) : value;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ChatContractError("invalid-report", `${label} returned an invalid packet.`);
  }
  return parsed as Record<string, unknown>;
}

function nestedToolConfigV1(config: RunnableConfig): RunnableConfig {
  const {
    toolCall: _outerToolCall,
    runId: _outerRunId,
    ...nestedConfig
  } = config as RunnableConfig & { toolCall?: unknown };
  return nestedConfig;
}

export function createPlannedSearchAcquisitionToolV1(input: {
  product: ResearchProduct;
  tools: readonly DynamicStructuredTool[];
  retrievalLedger: ChatCandidateLedgerControllerV1;
  maxSearchPages: number;
  maxDetails: number;
}): DynamicStructuredTool {
  const searchName = input.product === "confluence" ? "wiki_search" : "jira_issue_search";
  const detailName = input.product === "confluence" ? "wiki_page_get" : "jira_issue_get";
  const search = input.tools.find((candidate) => candidate.name === searchName);
  const rank = input.tools.find((candidate) => candidate.name === "research_candidate_rank");
  const detail = input.tools.find((candidate) => candidate.name === detailName);
  if (!search || !rank || !detail) {
    throw new ChatContractError(
      "invalid-request",
      "The planned Chat acquisition controller is missing a host capability.",
    );
  }
  let acquisition: Promise<string> | undefined;
  return tool(async (_value, config) => {
    if (acquisition) return acquisition;
    acquisition = (async () => {
      const nestedConfig = nestedToolConfigV1(config);
      let phase = "search";
      try {
        const entityRefs = new Set<string>();
        let pagesRead = 0;
        const planSearch = input.retrievalLedger.plan().searches.find((candidate) =>
          candidate.product === input.product
        );
        const maxPages = planSearch?.maxPages ?? 1;
        for (const query of input.retrievalLedger.allowedInitialQueries(input.product)) {
          if (pagesRead >= input.maxSearchPages) break;
          let page = parsedToolJsonV1(
            await search.invoke({ query }, nestedConfig),
            "Chat search",
          );
          for (let pageNumber = 1; pageNumber <= maxPages; pageNumber += 1) {
            pagesRead += 1;
            const items = Array.isArray(page.items) ? page.items : [];
            for (const candidate of items) {
              if (candidate && typeof candidate === "object" &&
                  typeof (candidate as { entityRef?: unknown }).entityRef === "string") {
                entityRefs.add((candidate as { entityRef: string }).entityRef);
              }
            }
            const pageState = page.page && typeof page.page === "object"
              ? page.page as { nextCursor?: unknown; complete?: unknown }
              : {};
            if (pageState.complete === true || typeof pageState.nextCursor !== "string" ||
                pageNumber >= maxPages || pagesRead >= input.maxSearchPages) break;
            page = parsedToolJsonV1(
              await search.invoke({ cursor: pageState.nextCursor }, nestedConfig),
              "Chat search",
            );
          }
        }
        if (entityRefs.size === 0) {
          return JSON.stringify({
            schema: "atlcli.chat-planned-acquisition/v1",
            product: input.product,
            pagesRead,
            discoveredCandidates: 0,
            details: [],
            gaps: ["The admitted search variants returned no candidates."],
          });
        }
        phase = "candidate-ranking";
        const ranked = parsedToolJsonV1(await rank.invoke({
          product: input.product,
          entityRefs: [...entityRefs],
        }, nestedConfig), "Chat candidate ranking");
        const rankedItems = Array.isArray(ranked.items) ? ranked.items : [];
        const admittedRefs: string[] = [];
        const retainedSourceIds: string[] = [];
        const admittedSourceIds = new Set<string>();
        for (const candidate of rankedItems) {
          if (!candidate || typeof candidate !== "object") continue;
          const entityRef = (candidate as { entityRef?: unknown }).entityRef;
          const sourceId = (candidate as { sourceId?: unknown }).sourceId;
          if (typeof entityRef !== "string" || typeof sourceId !== "string" ||
              admittedSourceIds.has(sourceId)) continue;
          admittedSourceIds.add(sourceId);
          admittedRefs.push(entityRef);
          retainedSourceIds.push(sourceId);
          if (admittedRefs.length >= Math.max(1, input.maxDetails)) break;
        }
        await input.retrievalLedger.retainAdmittedCandidates(
          input.product,
          retainedSourceIds,
          "outside-bounded-detail-selection",
        );
        phase = "detail-read";
        const details: Record<string, unknown>[] = [];
        // A candidate can be returned by several admitted query variants. Read
        // each canonical source once, sequentially, so evidence publication and
        // candidate-state transitions remain deterministic across every host.
        for (const entityRef of admittedRefs) {
          details.push(parsedToolJsonV1(
            await detail.invoke({ entityRef }, nestedConfig),
            "Chat detail read",
          ));
        }
        return JSON.stringify({
          schema: "atlcli.chat-planned-acquisition/v1",
          product: input.product,
          pagesRead,
          discoveredCandidates: entityRefs.size,
          details,
          gaps: details.length === 0
            ? ["Candidates were discovered but none could be read in detail."]
            : [],
        });
      } catch (error) {
        const errorCode = error && typeof error === "object" && "code" in error &&
            typeof error.code === "string"
          ? error.code
          : error instanceof Error
            ? error.name
            : "unknown";
        throw new ChatContractError(
          "invalid-report",
          `Planned Chat ${input.product} acquisition failed during ${phase} (${errorCode}).`,
        );
      }
    })();
    return acquisition;
  }, {
    name: "chat_retrieval_acquire",
    description:
      "Execute the complete host-admitted search, pagination, deduplication, ranking, and bounded detail-read plan exactly once. Return its detailed evidence for analysis.",
    schema: z.object({}).strict(),
  });
}

function compileChatSubagentsV1(input: {
  model: BaseChatModel;
  modelForPreference?: (preference: ProviderReasoningPreferenceV1) => BaseChatModel;
  broker: ResearchCapabilityBroker;
  limits: ResearchLimitsV1;
  locale?: string;
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
    const searchProduct = profile.id === "confluence-search-reader"
      ? "confluence" as const
      : profile.id === "jira-search-reader"
        ? "jira" as const
        : undefined;
    const grantedToolNames = profile.grantedCapabilityIds
      .map(toolNameForCapability)
      .filter((name): name is string => name !== undefined);
    const granted = new Set(grantedToolNames);
    const rawPtc = granted.size === 0
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
    const plannedSearchAvailable = searchProduct !== undefined &&
      input.retrievalLedger !== undefined &&
      input.searchProducts.includes(searchProduct);
    const plannedDetailLimit = searchProduct === undefined || input.retrievalLedger === undefined
      ? input.limits.maxDetailItemsPerProduct
      : input.retrievalLedger.plan().budgetReservations?.detailCallsByProduct?.[searchProduct] ??
        input.limits.maxDetailItemsPerProduct;
    const boundedAcquisitionResultAvailable = plannedSearchAvailable ||
      profile.id === "exact-context-reader";
    const ptc = plannedSearchAvailable
      ? [createPlannedSearchAcquisitionToolV1({
          product: searchProduct!,
          tools: rawPtc,
          retrievalLedger: input.retrievalLedger!,
          maxSearchPages: input.limits.maxSearchPagesPerProduct,
          maxDetails: plannedDetailLimit,
        })]
      : rawPtc;
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
      ? plannedSearchAvailable ? 2 : 8
      : 4;
    const evalGuard = createMiddleware({
      name: `ChatSubagentEvalGuard:${profile.id}`,
      async wrapToolCall(request, handler) {
        if (request.toolCall.name !== "eval") return handler(request);
        evalAttempts += 1;
        if (
          searchProduct &&
          input.retrievalLedger?.isSearchExhaustedWithoutCandidates(searchProduct)
        ) {
          input.onEvalDiagnostic?.({
            profileId: profile.id,
            status: "success",
            attempt: evalAttempts,
          });
          return new ToolMessage({
            tool_call_id: request.toolCall.id ?? `eval:${profile.id}:${evalAttempts}`,
            name: "eval",
            content: [
              "SEARCH_PLAN_COMPLETE_WITHOUT_CANDIDATES.",
              "Do not call eval again and do not invent or widen a query.",
              "Return the requested evidence packet now with empty sourceIds, claims, and relationships, plus one explicit retrieval gap.",
            ].join(" "),
          });
        }
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
        const searchCapabilityName = searchProduct === "confluence"
          ? "wikiSearch"
          : searchProduct === "jira"
            ? "jiraIssueSearch"
            : undefined;
        if (
          searchProduct &&
          searchCapabilityName &&
          capabilityNames.includes(searchCapabilityName) &&
          input.retrievalLedger?.isSearchPlanSaturated(searchProduct)
        ) {
          input.onEvalDiagnostic?.({
            profileId: profile.id,
            status: "success",
            attempt: evalAttempts,
            codeChars: code.length,
            usesToolsNamespace: /\\btools\\s*\\./u.test(code),
            capabilityNames,
          });
          return new ToolMessage({
            tool_call_id: request.toolCall.id ?? `eval:${profile.id}:${evalAttempts}`,
            name: "eval",
            content: [
              "SEARCH_PLAN_SATURATED.",
              "Do not call search again and do not invent a query.",
              "Rank and detail-read already discovered candidates if needed; otherwise return the requested evidence packet with an explicit gap.",
            ].join(" "),
          });
        }
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
          return new ToolMessage({
            tool_call_id: request.toolCall.id ?? `eval:${profile.id}:${evalAttempts}`,
            name: "eval",
            content: [
              "EVAL_LIMIT_REACHED.",
              "Do not call eval again.",
              "Return the requested structured packet now and disclose any incomplete work as a gap.",
            ].join(" "),
          });
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
          const boundaryError = searchProduct && isBoundedSearchAcquisitionErrorV1(error);
          input.onEvalDiagnostic?.({
            profileId: profile.id,
            status: "error",
            attempt: evalAttempts,
            ...classifyChildEvalErrorV1(error),
          });
          if (boundaryError) {
            return new ToolMessage({
              tool_call_id: request.toolCall.id ?? `eval:${profile.id}:${evalAttempts}`,
              name: "eval",
              content: [
                "SEARCH_REQUEST_REJECTED_AT_HOST_BOUNDARY.",
                "Do not repeat that request or invent another query.",
                "Use only a still-untried exact query variant from the host context; otherwise return the requested evidence packet with an explicit retrieval gap.",
              ].join(" "),
            });
          }
          throw error;
        }
      },
    });
    const answerOutputTokens = profile.id === "answer-critic"
      ? 2_048
      : profile.id === "answer-drafter" || profile.id === "answer-repairer" ||
          profile.id === "chat-synthesizer"
        ? 3_072
        : undefined;
    const maxModelOutputTokens = Math.min(
      input.limits.maxModelOutputTokens,
      answerOutputTokens ?? (profile.modelPreference === "fast"
        ? 2_048
        : profile.modelPreference === "balanced" ? 4_096 : 8_000),
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
        detailLimit: plannedDetailLimit,
        ...(input.locale ? { locale: input.locale } : {}),
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
              boundedAcquisitionResultAvailable
                ? input.limits.maxPtcOutputBytes
                : profile.maxResultBytes,
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
  locale?: string;
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
  onModelStreamEvent?: (event: ChatSubagentModelStreamEventV1) => void;
  retrievalLedger?: ChatCandidateLedgerControllerV1;
  strategyReviewCurrent?: () => boolean;
}): {
  middleware: ReturnType<ChatWorkflowRuntimeBindingsV1["createSubAgentMiddleware"]>;
  proposalTool: DynamicStructuredTool;
  advanceTool: DynamicStructuredTool;
  qualityReviewTool: DynamicStructuredTool;
  allowedProfileIds: readonly ChatSubagentProfileIdV1[];
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
  let advancing = false;
  const profileByTaskId = new Map<string, ChatSubagentProfileIdV1>();
  const taskById = new Map<string, ChatWorkflowTaskProposalV1>();
  const modelStreamErrorByTaskId = new Map<string, { code?: string; message: string }>();

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
    ...(input.locale ? { locale: input.locale } : {}),
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
  const allowedProfileIds = CHAT_SUBAGENT_PROFILES_V1
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
    .map((profile) => profile.id);

  const dispatch = createAgenticDispatchInterceptionAdapter({
    admissions: [],
    maxTasks: CHAT_SUBAGENT_PROFILES_V1.length,
    maxConcurrency: 3,
    allowHostDependencyHydration: true,
    allowHostResponseSchemaHydration: true,
    signal: input.signal,
    invokeUpstream: async (taskInput, config) => {
      const taskId = JSON.parse(taskInput.description) as { taskId?: string };
      const profileId = taskId.taskId
        ? profileByTaskId.get(taskId.taskId)
        : undefined;
      const streamCallback = profileId && taskId.taskId && input.onModelStreamEvent
        ? {
            name: `ChatSubagentModelStream:${taskId.taskId}`,
            handleChatModelStreamEvent: (
              event: ChatModelStreamEvent,
              runId: string,
            ) => input.onModelStreamEvent?.({
              taskId: taskId.taskId!,
              profileId,
              runId,
              event,
            }),
          }
        : undefined;
      const diagnosticStreamCallback = streamCallback
        ? {
            ...streamCallback,
            handleChatModelStreamEvent: (event: ChatModelStreamEvent, runId: string) => {
              if (event.event === "error") {
                modelStreamErrorByTaskId.set(taskId.taskId!, {
                  ...(event.code ? { code: event.code } : {}),
                  message: event.message,
                });
              }
              streamCallback.handleChatModelStreamEvent(event, runId);
            },
          }
        : undefined;
      const callbacks = diagnosticStreamCallback
        ? Array.isArray(config.callbacks)
          ? [...config.callbacks, diagnosticStreamCallback]
          : config.callbacks instanceof CallbackManager
            ? config.callbacks.copy([
                CallbackManager.fromHandlers(diagnosticStreamCallback).handlers[0]!,
              ], true)
            : [diagnosticStreamCallback]
        : config.callbacks;
      try {
        return await upstreamTask.invoke(taskInput, {
          ...config,
          ...(callbacks ? { callbacks } : {}),
        });
      } catch (error) {
        const product = taskInput.subagent_type === "chat-confluence-search-reader-v1"
          ? "confluence" as const
          : taskInput.subagent_type === "chat-jira-search-reader-v1"
            ? "jira" as const
            : undefined;
        if (product && isBoundedSearchAcquisitionErrorV1(error)) {
          return exhaustedSearchGapPacketV1(product);
        }
        const streamError = taskId.taskId
          ? modelStreamErrorByTaskId.get(taskId.taskId)
          : undefined;
        if (streamError) {
          throw new ChatContractError(
            streamError.code === "rate_limit_error" ? "rate-limited" : "provider-error",
            `Chat specialist ${taskId.taskId} failed during model streaming: ${streamError.message}`,
          );
        }
        throw error;
      }
    },
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
      ? (schema) => toolStrategy(schema as {
          type: "object";
          properties?: Record<string, unknown>;
          required?: string[];
          additionalProperties?: boolean;
          [key: string]: unknown;
        })
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
        const synthesized = CHAT_AGENT_DRAFT_SCHEMA_V1.parse(accepted);
        const hasEvidenceParagraph = /\[\[source:[^\]]+\]\]/u.test(
          synthesized.messageMarkdown,
        );
        const fallbackProfile = qualityDisposition?.repairAdmitted
          ? "answer-repairer"
          : qualityDisposition?.repairRequired
            ? undefined
            : "answer-drafter";
        const fallbackTaskId = fallbackProfile
          ? [...profileByTaskId.entries()].find(([, candidateProfile]) =>
              candidateProfile === fallbackProfile
            )?.[0]
          : undefined;
        const fallback = fallbackTaskId
          ? CHAT_AGENT_DRAFT_SCHEMA_V1.safeParse(state.acceptedResults[fallbackTaskId])
          : undefined;
        const synthesizedSubstance = synthesized.messageMarkdown
          .replace(/^#+\s.*$/gmu, "")
          .replace(/^\s*---+\s*$/gmu, "")
          .trim().length;
        const fallbackHasEvidence = fallback?.success &&
          /\[\[source:[^\]]+\]\]/u.test(fallback.data.messageMarkdown);
        const fallbackHasSubstance = fallback?.success &&
          fallback.data.messageMarkdown.replace(/^#+\s.*$/gmu, "").trim().length >= 20;
        if (
          fallback?.success &&
          ((!hasEvidenceParagraph && fallbackHasEvidence) ||
            (synthesizedSubstance < 20 && fallbackHasSubstance))
        ) {
          const gapKeys = new Set<string>();
          const gaps = [...fallback.data.gaps, ...synthesized.gaps].filter((gap) => {
            const key = JSON.stringify(gap);
            if (gapKeys.has(key)) return false;
            gapKeys.add(key);
            return true;
          });
          finalDraft = { ...fallback.data, gaps };
        } else {
          finalDraft = synthesized;
        }
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
    allowedProfileIds,
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
        taskById.set(task.taskId, task);
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
          requiredGapMappings: qualityDisposition.requiredGapCodes.map((defectCode) => ({
            defectCode,
            finalGapCode: chatFinalGapCodeForQualityDefectV1(defectCode),
          })),
          rejectedSourceIds: qualityDisposition.rejectedSourceIds,
          repairAdmitted: qualityDisposition.repairAdmitted,
          repairSkippedReason: qualityDisposition.repairSkippedReason,
        }),
      ].join("\n\n"),
      dependencyTaskIds: qualityDisposition.repairAdmitted
        ? appendedTasks.map((task) => task.taskId)
        : preSynthesisTasks
          .filter((task) =>
            task.profileId === "answer-drafter" || task.profileId === "answer-critic"
          )
          .map((task) => task.taskId),
    };
    appendedTasks.push(synthTask);
    const admissions = appendedTasks.map((task) => {
      const selected = chatSubagentProfileByIdV1(task.profileId);
      profileByTaskId.set(task.taskId, task.profileId);
      taskById.set(task.taskId, task);
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

  const phaseOrder = [
    "acquisition",
    "analysis",
    "reconciliation",
    "drafting",
    "critique",
    "repair",
    "synthesis",
  ] as const;
  const phaseRank = (task: ChatWorkflowTaskProposalV1): number =>
    phaseOrder.indexOf(chatSubagentProfileByIdV1(task.profileId).phase);
  const advanceResponse = (
    status: ChatWorkflowAdvanceResponseV1["status"],
    completedTaskIds: readonly string[],
  ): ChatWorkflowAdvanceResponseV1 => ({
    schema: "atlcli.chat-workflow-advance/v1",
    status,
    completedTaskIds: [...completedTaskIds],
    remainingTaskIds: [...taskById.values()]
      .filter((task) => state.taskStatuses[task.taskId] !== "completed")
      .map((task) => task.taskId)
      .sort((left, right) => left.localeCompare(right, "en-US")),
  });
  const advanceTool = tool(async (_value, config) => {
    if (advancing) {
      throw new ChatContractError(
        "invalid-request",
        "The Chat workflow is already advancing.",
      );
    }
    const workflow = acceptedWorkflow;
    if (!workflow) {
      throw new ChatContractError(
        "invalid-request",
        "The Chat workflow must be accepted before it can advance.",
      );
    }
    advancing = true;
    const completedTaskIds: string[] = [];
    try {
      while (true) {
        if (finalDraft && qualityDisposition) {
          return JSON.stringify(advanceResponse("complete", completedTaskIds));
        }
        const initialTaskIds = workflow.tasks
          .filter((task) => task.taskId !== workflow.synthesizerTaskId)
          .map((task) => task.taskId);
        if (
          !qualityDisposition &&
          initialTaskIds.every((taskId) => state.taskStatuses[taskId] === "completed")
        ) {
          return JSON.stringify(advanceResponse("quality-review-required", completedTaskIds));
        }
        const ready = [...taskById.values()]
          .filter((task) => state.taskStatuses[task.taskId] === "admitted")
          .filter((task) => task.dependencyTaskIds.every(
            (taskId) => state.taskStatuses[taskId] === "completed",
          ));
        if (ready.length === 0) {
          throw new ChatContractError(
            "invalid-report",
            "The accepted Chat workflow has no executable task frontier.",
          );
        }
        const nextRank = Math.min(...ready.map(phaseRank));
        const wave = ready.filter((task) => phaseRank(task) === nextRank);
        if (
          wave.some((task) => ["drafting", "critique"].includes(
            chatSubagentProfileByIdV1(task.profileId).phase,
          )) &&
          !input.strategyReviewCurrent?.()
        ) {
          return JSON.stringify(advanceResponse("strategy-review-required", completedTaskIds));
        }
        await Promise.all(wave.map(async (task) => {
          const selected = chatSubagentProfileByIdV1(task.profileId);
          const dispatchInput = createChatWorkflowDispatchV1({ task, profile: selected });
          await dispatch.invoke({
            description: dispatchInput.description,
            subagent_type: dispatchInput.subagentType,
          }, { ...config, signal: input.signal });
          completedTaskIds.push(task.taskId);
        }));
      }
    } finally {
      advancing = false;
    }
  }, {
    name: "chat_workflow_advance",
    description:
      "Execute every currently admissible Chat specialist wave from the accepted dynamic graph. The host binds task descriptions, profiles, schemas, dependencies, concurrency, and results. Call again only after the returned strategy or quality checkpoint has completed.",
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
    advanceTool,
    qualityReviewTool,
    allowedProfileIds: Object.freeze([...allowedProfileIds]),
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
