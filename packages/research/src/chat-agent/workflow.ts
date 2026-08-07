import { tool, type DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod/v4";
import {
  AGENTIC_WORKFLOW_SCHEMA_V1,
  compileAgenticWorkflowV1,
  type AgenticWorkflowPhaseV1,
  type CompiledAgenticWorkflowV1,
} from "../agentic-workflow-core.js";
import type { ResearchRunBudget } from "../budget.js";
import {
  BOUND_ENTITY_READ_CAPABILITY_ID_V1,
  BOUND_ENTITY_SECTION_READ_CAPABILITY_ID_V1,
} from "../capability-contracts.js";
import {
  encodeAgenticTaskDescriptionV1,
  type AgenticTaskAdmissionV1,
} from "../dispatch-adapter.js";
import {
  CHAT_AGENT_DRAFT_JSON_SCHEMA_V2,
  CHAT_AGENT_DRAFT_SCHEMA_V1,
  CHAT_AGENT_DRAFT_SCHEMA_V2,
  ChatContractError,
  normalizeChatAgentDraftV2,
  type ChatAgentDraft,
} from "./contracts.js";
import {
  CHAT_RETRIEVAL_PLAN_PROPOSAL_SCHEMA_V1,
  type ChatRetrievalPlanProposalV1,
} from "./retrieval-plan.js";
import type { ChatStrategyDecisionV1 } from "./strategy.js";
import {
  CHAT_QUALITY_DEFECT_CODES_V1,
  type ChatQualityDefectV1,
} from "./quality.js";

export const CHAT_WORKFLOW_PROPOSAL_SCHEMA_V1 =
  "atlcli.chat-workflow-proposal/v1" as const;

const MAX_EXACT_ANCHORS_PER_CHAT_READER_V1 = 3;

export const CHAT_SUBAGENT_PROFILE_IDS_V1 = [
  "exact-context-reader",
  "confluence-search-reader",
  "jira-search-reader",
  "relationship-tracer",
  "comparison-analyst",
  "contradiction-checker",
  "answer-drafter",
  "answer-critic",
  "answer-repairer",
  "chat-synthesizer",
] as const;

export type ChatSubagentProfileIdV1 =
  (typeof CHAT_SUBAGENT_PROFILE_IDS_V1)[number];

export type ChatSubagentCapabilityIdV1 =
  | typeof BOUND_ENTITY_READ_CAPABILITY_ID_V1
  | typeof BOUND_ENTITY_SECTION_READ_CAPABILITY_ID_V1
  | "jira.issue.search"
  | "jira.issue.get"
  | "wiki.search"
  | "wiki.page.get"
  | "research.candidate.rank";

export type ChatSubagentPacketSchemaV1 =
  | "atlcli.chat-evidence-packet/v1"
  | "atlcli.chat-analysis-packet/v1"
  | "atlcli.chat-critique-packet/v1"
  | "atlcli.chat-answer-draft/v1";

export interface ChatSubagentProfileV1 {
  id: ChatSubagentProfileIdV1;
  subagentType: string;
  roleId: string;
  phase: AgenticWorkflowPhaseV1;
  description: string;
  systemPrompt: string;
  grantedCapabilityIds: readonly ChatSubagentCapabilityIdV1[];
  responseSchemaId: ChatSubagentPacketSchemaV1;
  responseSchema: Readonly<Record<string, unknown>>;
  modelPreference: "fast" | "balanced" | "thorough";
  maxInputChars: number;
  maxResultBytes: number;
  maxDurationMs: number;
}

const STRING_ARRAY = Object.freeze({
  type: "array",
  maxItems: 100,
  items: { type: "string", minLength: 1, maxLength: 256 },
});

const CHAT_EVIDENCE_PACKET_SCHEMA_V1 = Object.freeze({
  title: "ChatEvidencePacketV1",
  type: "object",
  additionalProperties: false,
  required: ["schema", "sourceIds", "claims", "relationships", "gaps"],
  properties: {
    schema: { type: "string", const: "atlcli.chat-evidence-packet/v1" },
    sourceIds: STRING_ARRAY,
    claims: {
      type: "array",
      maxItems: 24,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["text", "sourceIds", "sourceRefs"],
        properties: {
          text: { type: "string", minLength: 1, maxLength: 1_000 },
          sourceIds: STRING_ARRAY,
          sourceRefs: {
            ...STRING_ARRAY,
            description:
              "Exact SOURCE_ID or SOURCE_ID#SECTION_ID references that support this claim.",
          },
        },
      },
    },
    relationships: {
      type: "array",
      maxItems: 24,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["fromSourceId", "toSourceId", "kind", "support"],
        properties: {
          fromSourceId: { type: "string", minLength: 1, maxLength: 256 },
          toSourceId: { type: "string", minLength: 1, maxLength: 256 },
          kind: { type: "string", minLength: 1, maxLength: 120 },
          support: { type: "string", minLength: 1, maxLength: 600 },
        },
      },
    },
    gaps: {
      type: "array",
      maxItems: 16,
      items: { type: "string", minLength: 1, maxLength: 600 },
    },
  },
});

const CHAT_ANALYSIS_PACKET_SCHEMA_V1 = Object.freeze({
  title: "ChatAnalysisPacketV1",
  type: "object",
  additionalProperties: false,
  required: ["schema", "claimRefs", "relationshipRefs", "contradictions", "gaps"],
  properties: {
    schema: { type: "string", const: "atlcli.chat-analysis-packet/v1" },
    claimRefs: STRING_ARRAY,
    relationshipRefs: STRING_ARRAY,
    contradictions: {
      type: "array",
      maxItems: 40,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["summary", "sourceIds"],
        properties: {
          summary: { type: "string", minLength: 1, maxLength: 800 },
          sourceIds: STRING_ARRAY,
        },
      },
    },
    gaps: {
      type: "array",
      maxItems: 40,
      items: { type: "string", minLength: 1, maxLength: 600 },
    },
  },
});

const CHAT_CRITIQUE_PACKET_SCHEMA_V1 = Object.freeze({
  title: "ChatCritiquePacketV1",
  type: "object",
  additionalProperties: false,
  required: ["schema", "defects", "readyForSynthesis"],
  properties: {
    schema: { type: "string", const: "atlcli.chat-critique-packet/v1" },
    defects: {
      type: "array",
      maxItems: 40,
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "defectId",
          "code",
          "severity",
          "message",
          "sourceIds",
          "repairAction",
        ],
        properties: {
          defectId: { type: "string", pattern: "^chat-defect:[A-Za-z0-9._:-]{1,160}$" },
          code: { enum: CHAT_QUALITY_DEFECT_CODES_V1 },
          severity: { enum: ["blocking", "material", "advisory"] },
          message: { type: "string", minLength: 1, maxLength: 800 },
          sourceIds: STRING_ARRAY,
          repairAction: {
            enum: ["resynthesize", "disclose-gap", "reject-evidence", "ask-user"],
          },
        },
      },
    },
    readyForSynthesis: { type: "boolean" },
  },
});

const chatEvidencePacketSchemaV1 = z.object({
  schema: z.literal("atlcli.chat-evidence-packet/v1"),
  sourceIds: z.array(z.string().min(1).max(256)).max(100),
  claims: z.array(z.object({
    text: z.string().min(1).max(1_000),
    sourceIds: z.array(z.string().min(1).max(256)).max(100),
    sourceRefs: z.array(z.string().min(1).max(256)).max(100),
  }).strict()).max(80),
  relationships: z.array(z.object({
    fromSourceId: z.string().min(1).max(256),
    toSourceId: z.string().min(1).max(256),
    kind: z.string().min(1).max(120),
    support: z.string().min(1).max(600),
  }).strict()).max(80),
  gaps: z.array(z.string().min(1).max(600)).max(40),
}).strict();

const chatAnalysisPacketSchemaV1 = z.object({
  schema: z.literal("atlcli.chat-analysis-packet/v1"),
  claimRefs: z.array(z.string().min(1).max(256)).max(100),
  relationshipRefs: z.array(z.string().min(1).max(256)).max(100),
  contradictions: z.array(z.object({
    summary: z.string().min(1).max(800),
    sourceIds: z.array(z.string().min(1).max(256)).max(100),
  }).strict()).max(40),
  gaps: z.array(z.string().min(1).max(600)).max(40),
}).strict();

const chatCritiquePacketSchemaV1 = z.object({
  schema: z.literal("atlcli.chat-critique-packet/v1"),
  defects: z.array(z.object({
    defectId: z.string().regex(/^chat-defect:[A-Za-z0-9._:-]{1,160}$/u),
    code: z.enum(CHAT_QUALITY_DEFECT_CODES_V1),
    severity: z.enum(["blocking", "material", "advisory"]),
    message: z.string().min(1).max(800),
    sourceIds: z.array(z.string().min(1).max(256)).max(100),
    repairAction: z.enum([
      "resynthesize",
      "disclose-gap",
      "reject-evidence",
      "ask-user",
    ]),
  }).strict()).max(40),
  readyForSynthesis: z.boolean(),
}).strict();

export type ChatEvidencePacketV1 = z.infer<typeof chatEvidencePacketSchemaV1>;
export type ChatAnalysisPacketV1 = z.infer<typeof chatAnalysisPacketSchemaV1>;
export type ChatCritiquePacketV1 = z.infer<typeof chatCritiquePacketSchemaV1>;
type CriticDefectShapeCompatibilityV1 =
  ChatCritiquePacketV1["defects"][number] extends ChatQualityDefectV1
    ? true
    : never;
const criticDefectShapeCompatibilityV1: CriticDefectShapeCompatibilityV1 = true;
void criticDefectShapeCompatibilityV1;
export type ChatSubagentResultV1 =
  | ChatEvidencePacketV1
  | ChatAnalysisPacketV1
  | ChatCritiquePacketV1
  | ChatAgentDraft;

function jsonCandidateV1(value: unknown): unknown | undefined {
  if (typeof value !== "string") return value === undefined ? undefined : value;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

/**
 * DeepAgents may return a JSON string directly or a command carrying the
 * subagent's structured tool call. Select only a schema-shaped candidate;
 * never treat the child's trailing prose as an accepted packet.
 */
export function extractChatSubagentCandidateV1(value: unknown): unknown {
  const direct = jsonCandidateV1(value);
  if (direct !== undefined && direct !== value) return direct;
  if (!value || typeof value !== "object" || !("update" in value)) return value;
  const update = (value as { update?: unknown }).update;
  if (!update || typeof update !== "object" ||
      !("messages" in update) || !Array.isArray(update.messages)) {
    return value;
  }
  const messages = update.messages as unknown[];
  for (const message of [...messages].reverse()) {
    if (!message || typeof message !== "object" ||
        !("tool_calls" in message) || !Array.isArray(message.tool_calls)) continue;
    for (const call of [...message.tool_calls].reverse()) {
      if (!call || typeof call !== "object" || !("args" in call)) continue;
      const candidate = jsonCandidateV1(call.args);
      if (candidate !== undefined) return candidate;
    }
  }
  for (const message of [...messages].reverse()) {
    if (!message || typeof message !== "object" || !("content" in message)) continue;
    const candidate = jsonCandidateV1(message.content);
    if (candidate !== undefined) return candidate;
  }
  return value;
}

export function parseChatSubagentResultV1(
  profileId: ChatSubagentProfileIdV1,
  value: unknown,
): ChatSubagentResultV1 {
  const candidate = extractChatSubagentCandidateV1(value);
  const answerProfile = profileId === "chat-synthesizer" ||
      profileId === "answer-drafter" ||
      profileId === "answer-repairer";
  const schema = profileId === "answer-critic"
      ? chatCritiquePacketSchemaV1
      : profileId === "exact-context-reader" ||
          profileId === "confluence-search-reader" ||
          profileId === "jira-search-reader"
        ? chatEvidencePacketSchemaV1
        : chatAnalysisPacketSchemaV1;
  if (answerProfile) {
    const current = CHAT_AGENT_DRAFT_SCHEMA_V2.safeParse(candidate);
    if (current.success) {
      return structuredClone(normalizeChatAgentDraftV2(current.data));
    }
    const legacy = CHAT_AGENT_DRAFT_SCHEMA_V1.safeParse(candidate);
    if (!legacy.success) {
      throw new ChatContractError(
        "invalid-report",
        `Chat subagent ${profileId} returned an invalid structured packet.`,
      );
    }
    return structuredClone(legacy.data);
  }
  const parsed = schema.safeParse(candidate);
  if (!parsed.success) {
    throw new ChatContractError(
      "invalid-report",
      `Chat subagent ${profileId} returned an invalid structured packet.`,
    );
  }
  return structuredClone(parsed.data) as ChatSubagentResultV1;
}

function profile(input: ChatSubagentProfileV1): Readonly<ChatSubagentProfileV1> {
  return Object.freeze({
    ...input,
    grantedCapabilityIds: Object.freeze([...input.grantedCapabilityIds]),
    responseSchema: Object.freeze(structuredClone(input.responseSchema)),
  });
}

export const CHAT_SUBAGENT_PROFILES_V1 = Object.freeze([
  profile({
    id: "exact-context-reader",
    subagentType: "chat-exact-context-reader-v1",
    roleId: "exact-context-reader",
    phase: "acquisition",
    description: "Read only host-attached Jira or Confluence entities and the smallest relevant page sections.",
    systemPrompt: "Read only opaque host-attached entities. Return compact, central, question-relevant claims plus relationships and material gaps. Every claim must name its canonical sourceIds and exact sourceRefs. For a claim supported by an identifiable read Confluence section, use SOURCE_ID#SECTION_ID from the returned outline; use a page-level SOURCE_ID only for a claim supported by the whole read page. Never expose opaque sectionRef capability tokens. Once the required anchors are read, immediately return the aggregate packet. Never return source bodies or delegate.",
    grantedCapabilityIds: [
      BOUND_ENTITY_READ_CAPABILITY_ID_V1,
      BOUND_ENTITY_SECTION_READ_CAPABILITY_ID_V1,
    ],
    responseSchemaId: "atlcli.chat-evidence-packet/v1",
    responseSchema: CHAT_EVIDENCE_PACKET_SCHEMA_V1,
    modelPreference: "fast",
    maxInputChars: 12_000,
    maxResultBytes: 32_000,
    maxDurationMs: 240_000,
  }),
  profile({
    id: "confluence-search-reader",
    subagentType: "chat-confluence-search-reader-v1",
    roleId: "confluence-search-reader",
    phase: "acquisition",
    description: "Discover, rank, and detail-read only admitted Confluence candidates.",
    systemPrompt: "Use only Confluence discovery, ranking, and detail capabilities. Return at most two central, question-relevant claims per detailed source, deduplicate equivalent claims, and keep relationships and gaps concise. Every claim must name its canonical sourceIds and exact sourceRefs; use SOURCE_ID#SECTION_ID for an identifiable read section and page-level SOURCE_ID only for whole-page support. Never expose opaque sectionRef capability tokens, bodies, credentials, queries, or delegation.",
    grantedCapabilityIds: ["wiki.search", "research.candidate.rank", "wiki.page.get"],
    responseSchemaId: "atlcli.chat-evidence-packet/v1",
    responseSchema: CHAT_EVIDENCE_PACKET_SCHEMA_V1,
    modelPreference: "fast",
    maxInputChars: 10_000,
    maxResultBytes: 40_000,
    // The bound covers the complete admitted acquisition: several indexed
    // queries, ranking, sequential detail reads, and one evidence packet. A
    // real four-page traversal exceeded three minutes even though every HTTP
    // read succeeded, so keep this below the ten-minute turn deadline without
    // failing a healthy reader during its final packet generation.
    maxDurationMs: 240_000,
  }),
  profile({
    id: "jira-search-reader",
    subagentType: "chat-jira-search-reader-v1",
    roleId: "jira-search-reader",
    phase: "acquisition",
    description: "Discover, rank, and detail-read only admitted Jira candidates.",
    systemPrompt: "Use only Jira discovery, ranking, and detail capabilities. Return at most two central, question-relevant claims per detailed source, deduplicate equivalent claims, and keep relationships and gaps concise. Every claim must name its canonical sourceIds and sourceRefs. Never return bodies, credentials, queries, or delegation.",
    grantedCapabilityIds: ["jira.issue.search", "research.candidate.rank", "jira.issue.get"],
    responseSchemaId: "atlcli.chat-evidence-packet/v1",
    responseSchema: CHAT_EVIDENCE_PACKET_SCHEMA_V1,
    modelPreference: "fast",
    maxInputChars: 10_000,
    maxResultBytes: 40_000,
    maxDurationMs: 240_000,
  }),
  profile({
    id: "relationship-tracer",
    subagentType: "chat-relationship-tracer-v1",
    roleId: "relationship-tracer",
    phase: "analysis",
    description: "Trace only explicit relationships in accepted evidence packets.",
    systemPrompt: "Relate only host-accepted source and claim references supplied as data. Do not retrieve, delegate, infer missing links, or return source bodies.",
    grantedCapabilityIds: [],
    responseSchemaId: "atlcli.chat-analysis-packet/v1",
    responseSchema: CHAT_ANALYSIS_PACKET_SCHEMA_V1,
    modelPreference: "balanced",
    maxInputChars: 20_000,
    maxResultBytes: 24_000,
    maxDurationMs: 75_000,
  }),
  profile({
    id: "comparison-analyst",
    subagentType: "chat-comparison-analyst-v1",
    roleId: "comparison-analyst",
    phase: "analysis",
    description: "Compare accepted claims without acquiring or widening scope.",
    systemPrompt: "Compare only accepted claim and source references. Preserve disagreement and missing coverage. Do not retrieve, delegate, or synthesize the final answer.",
    grantedCapabilityIds: [],
    responseSchemaId: "atlcli.chat-analysis-packet/v1",
    responseSchema: CHAT_ANALYSIS_PACKET_SCHEMA_V1,
    modelPreference: "balanced",
    maxInputChars: 20_000,
    maxResultBytes: 24_000,
    maxDurationMs: 75_000,
  }),
  profile({
    id: "contradiction-checker",
    subagentType: "chat-contradiction-checker-v1",
    roleId: "contradiction-checker",
    phase: "reconciliation",
    description: "Check accepted claims for contradictions and unresolved version differences.",
    systemPrompt: "Identify only evidence-backed contradictions and unresolved differences. Do not retrieve, delegate, or author the final answer.",
    grantedCapabilityIds: [],
    responseSchemaId: "atlcli.chat-analysis-packet/v1",
    responseSchema: CHAT_ANALYSIS_PACKET_SCHEMA_V1,
    modelPreference: "balanced",
    maxInputChars: 20_000,
    maxResultBytes: 20_000,
    maxDurationMs: 75_000,
  }),
  profile({
    id: "answer-drafter",
    subagentType: "chat-answer-drafter-v1",
    roleId: "answer-drafter",
    phase: "drafting",
    description: "Create one provisional conversational answer for independent critique.",
    systemPrompt: "Draft one provisional answer below 600 words from accepted evidence and analysis packets. Return ordered semantic blocks: exactly one factual paragraph, list item, or table row per block. Copy exact canonical source references into sourceRefs. Mark evidence-backed positive statements as assertion=positive and scope=none. Mark every negative or absence finding as assertion=absence and choose the narrowest truthful scope: source, selected-sources, or bound-scope. Headings and non-factual transitions use assertion=none, scope=none, and no sourceRefs. Never turn incomplete candidate coverage into whole-space, whole-project, or tenant-wide absence. Preserve explicit gaps. This draft is not user-visible and is not the final answer. Do not retrieve, delegate, or produce a Deep Research report.",
    grantedCapabilityIds: [],
    responseSchemaId: "atlcli.chat-answer-draft/v1",
    responseSchema: Object.freeze({
      ...CHAT_AGENT_DRAFT_JSON_SCHEMA_V2,
      title: "ChatProvisionalAnswerDraftV1",
    }),
    modelPreference: "balanced",
    maxInputChars: 28_000,
    maxResultBytes: 28_000,
    maxDurationMs: 120_000,
  }),
  profile({
    id: "answer-critic",
    subagentType: "chat-answer-critic-v1",
    roleId: "answer-critic",
    phase: "critique",
    description: "Critique answer coverage, grounding, citations, and unresolved gaps.",
    systemPrompt: "Independently critique the provisional answer against the versioned host groundedness rubric and accepted evidence packets. Return at most four prioritized typed defects. Check question coverage, claim support, exact citation identity, source authority/freshness, contradiction handling, wrong-source risk, uncovered candidates, false completeness, and instruction isolation exactly once. Treat any whole-space, whole-project, or tenant-wide absence claim as false completeness unless every admitted candidate was detail-read and the host retrieval assessment is complete. Use only the closed defect, severity, and repair-action enums. Treat unresolved interpretation as a gap. Do not retrieve, delegate, repair, or author the final answer.",
    grantedCapabilityIds: [],
    responseSchemaId: "atlcli.chat-critique-packet/v1",
    responseSchema: CHAT_CRITIQUE_PACKET_SCHEMA_V1,
    modelPreference: "balanced",
    maxInputChars: 24_000,
    maxResultBytes: 20_000,
    maxDurationMs: 120_000,
  }),
  profile({
    id: "answer-repairer",
    subagentType: "chat-answer-repairer-v1",
    roleId: "answer-repairer",
    phase: "repair",
    description: "Repair only the host-selected defects in one provisional answer.",
    systemPrompt: "Repair exactly the typed defects selected by the host. Preserve supported semantic blocks and their exact sourceRefs, remove rejected evidence, and disclose required gaps. Keep one factual paragraph, list item, or table row per block and preserve truthful assertion/scope values. Return one corrected provisional answer. Do not retrieve, delegate, widen scope, or write the final user answer.",
    grantedCapabilityIds: [],
    responseSchemaId: "atlcli.chat-answer-draft/v1",
    responseSchema: Object.freeze({
      ...CHAT_AGENT_DRAFT_JSON_SCHEMA_V2,
      title: "ChatRepairedAnswerDraftV1",
    }),
    modelPreference: "balanced",
    maxInputChars: 28_000,
    maxResultBytes: 28_000,
    maxDurationMs: 180_000,
  }),
  profile({
    id: "chat-synthesizer",
    subagentType: "chat-synthesizer-v1",
    roleId: "synthesizer",
    phase: "synthesis",
    description: "Write one concise conversational answer from accepted evidence and analysis packets.",
    systemPrompt: "Finalize the already analyzed and independently checked answer; do not re-run the analysis. Write the single final conversational answer only from accepted evidence, the provisional draft, deterministic quality state, critic defects, the optional bounded repair packet, and explicit gaps. Correct or omit every defect before writing. Return ordered semantic blocks with exactly one factual paragraph, list item, or table row per block. Every factual block must answer the user's question and copy its exact canonical evidence references into sourceRefs. Use assertion=positive, scope=none for positive facts. Use assertion=absence with the narrowest truthful scope for negative findings; bound-scope is forbidden unless the supplied host retrieval assessment is complete. Headings and short non-factual transitions use assertion=none, scope=none, and no sourceRefs. Omit provenance, side facts, and technically true details that do not help answer the question. Include only material gaps that could change the answer; do not invent auxiliary gaps merely because an unrequested linked page or external reference was not read. The host quality disposition contains requiredGapMappings; include at least one gaps entry with each listed finalGapCode. Keep the complete answer below 700 words; this is normal Chat, not a research report. Never use Markdown links or a separate source list. If a factual block cannot name exact accepted sourceRefs, omit it or express the missing evidence as a typed gap. Never retrieve, delegate, invent URLs, or produce a Deep Research report.",
    grantedCapabilityIds: [],
    responseSchemaId: "atlcli.chat-answer-draft/v1",
    responseSchema: Object.freeze({
      ...CHAT_AGENT_DRAFT_JSON_SCHEMA_V2,
      title: "ChatAnswerDraftV2",
    }),
    // Final synthesis needs enough output room for adaptive-thinking tokens
    // plus the bounded conversational Markdown. Other balanced specialists
    // remain smaller; only this terminal packet uses the thorough binding.
    modelPreference: "thorough",
    maxInputChars: 32_000,
    maxResultBytes: 32_000,
    maxDurationMs: 180_000,
  }),
] as const);

const PROFILE_BY_ID = new Map(
  CHAT_SUBAGENT_PROFILES_V1.map((entry) => [entry.id, entry]),
);

export function chatSubagentProfileByIdV1(
  profileId: ChatSubagentProfileIdV1,
): Readonly<ChatSubagentProfileV1> {
  const selected = PROFILE_BY_ID.get(profileId);
  if (!selected) {
    throw new ChatContractError("invalid-request", "The Chat subagent profile is unknown.");
  }
  return selected;
}

export interface ChatWorkflowTaskProposalV1 {
  taskId: string;
  profileId: ChatSubagentProfileIdV1;
  objective: string;
  dependencyTaskIds: string[];
}

export interface ChatWorkflowProposalV1 {
  schema: typeof CHAT_WORKFLOW_PROPOSAL_SCHEMA_V1;
  tasks: ChatWorkflowTaskProposalV1[];
  maxConcurrency: number;
  retrievalPlan?: ChatRetrievalPlanProposalV1;
}

export interface AcceptedChatWorkflowV1 {
  compiled: CompiledAgenticWorkflowV1;
  tasks: readonly Readonly<ChatWorkflowTaskProposalV1>[];
  admissions: readonly Readonly<AgenticTaskAdmissionV1>[];
  profileByTaskId: ReadonlyMap<string, Readonly<ChatSubagentProfileV1>>;
  synthesizerTaskId: string;
}

export interface ChatWorkflowDispatchV1 {
  taskId: string;
  subagentType: string;
  objective: string;
  dependencyTaskIds: readonly string[];
  description: string;
  responseSchema: Readonly<Record<string, unknown>>;
}

export interface ChatWorkflowAdmissionResponseV1 {
  schema: "atlcli.chat-workflow-admission/v1";
  completionObjective: "conversation-answer";
  maxConcurrency: number;
  synthesizerTaskId: string;
  qualityReviewRequired: true;
  dispatches: readonly Readonly<ChatWorkflowDispatchV1>[];
}

export function createChatWorkflowDispatchV1(input: {
  task: Readonly<ChatWorkflowTaskProposalV1>;
  profile: Readonly<ChatSubagentProfileV1>;
}): Readonly<ChatWorkflowDispatchV1> {
  return Object.freeze({
    taskId: input.task.taskId,
    subagentType: input.profile.subagentType,
    objective: input.task.objective,
    dependencyTaskIds: Object.freeze([...input.task.dependencyTaskIds]),
    description: encodeAgenticTaskDescriptionV1({
      taskId: input.task.taskId,
      objective: input.task.objective,
    }),
    responseSchema: input.profile.responseSchema,
  });
}

function invalid(message: string): never {
  throw new ChatContractError("invalid-request", message);
}

function boundedText(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string") invalid(`${label} is invalid.`);
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum || normalized.includes("\u0000")) {
    invalid(`${label} is invalid.`);
  }
  return normalized;
}

function phaseRank(phase: AgenticWorkflowPhaseV1): number {
  return [
    "acquisition",
    "analysis",
    "reconciliation",
    "drafting",
    "critique",
    "repair",
    "synthesis",
  ].indexOf(phase);
}

export function admitChatWorkflowProposalV1(input: {
  strategy: ChatStrategyDecisionV1;
  proposal?: ChatWorkflowProposalV1;
  maxTasks?: number;
  maxConcurrency?: number;
}): AcceptedChatWorkflowV1 | undefined {
  if (input.strategy.execution === "direct") {
    if (input.proposal !== undefined) {
      invalid("A direct Chat strategy cannot admit a subagent workflow.");
    }
    return undefined;
  }
  const proposal = input.proposal;
  if (!proposal || proposal.schema !== CHAT_WORKFLOW_PROPOSAL_SCHEMA_V1) {
    invalid("An agentic Chat strategy requires a versioned workflow proposal.");
  }
  const maxTasks = Math.max(2, Math.min(9, Math.trunc(input.maxTasks ?? 9)));
  const maximumConcurrency = Math.max(
    1,
    Math.min(3, Math.trunc(input.maxConcurrency ?? 3)),
  );
  if (!Array.isArray(proposal.tasks) || proposal.tasks.length < 2 || proposal.tasks.length > maxTasks) {
    invalid("The Chat workflow task count is outside the host-owned bounds.");
  }
  if (!Number.isSafeInteger(proposal.maxConcurrency) || proposal.maxConcurrency < 1 ||
      proposal.maxConcurrency > maximumConcurrency || proposal.maxConcurrency > proposal.tasks.length) {
    invalid("The Chat workflow concurrency is outside the host-owned bounds.");
  }
  const ids = new Set<string>();
  const proposedTasks = proposal.tasks.map((candidate) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      invalid("A Chat workflow task is invalid.");
    }
    if (Object.keys(candidate).some((key) =>
      !["taskId", "profileId", "objective", "dependencyTaskIds"].includes(key)
    )) {
      invalid("A Chat workflow task contains fields outside the host contract.");
    }
    const taskId = boundedText(candidate.taskId, "Chat workflow task ID", 200);
    if (!/^[A-Za-z0-9][A-Za-z0-9:._-]*$/u.test(taskId) || ids.has(taskId)) {
      invalid("A Chat workflow task identity is invalid or duplicated.");
    }
    ids.add(taskId);
    if (!CHAT_SUBAGENT_PROFILE_IDS_V1.includes(candidate.profileId)) {
      invalid("A Chat workflow task requested an unknown profile.");
    }
    if (candidate.profileId === "answer-repairer") {
      invalid("The answer repairer is admitted only by the host quality checkpoint.");
    }
    if (!Array.isArray(candidate.dependencyTaskIds) || candidate.dependencyTaskIds.length > 7 ||
        candidate.dependencyTaskIds.some((entry) => typeof entry !== "string") ||
        new Set(candidate.dependencyTaskIds).size !== candidate.dependencyTaskIds.length) {
      invalid("A Chat workflow dependency list is invalid.");
    }
    return Object.freeze({
      taskId,
      profileId: candidate.profileId,
      objective: boundedText(candidate.objective, "Chat workflow objective", 4_000),
      dependencyTaskIds: Object.freeze([...candidate.dependencyTaskIds]) as unknown as string[],
    });
  });
  const preDraftTaskIds = proposedTasks
    .filter((task) => {
      const phase = PROFILE_BY_ID.get(task.profileId)!.phase;
      return phaseRank(phase) < phaseRank("drafting");
    })
    .map((task) => task.taskId);
  const acquisitionTaskIds = proposedTasks
    .filter((task) => PROFILE_BY_ID.get(task.profileId)!.phase === "acquisition")
    .map((task) => task.taskId);
  const analysisTaskIds = proposedTasks
    .filter((task) => PROFILE_BY_ID.get(task.profileId)!.phase === "analysis")
    .map((task) => task.taskId);
  const preCriticTaskIds = proposedTasks
    .filter((task) => {
      const phase = PROFILE_BY_ID.get(task.profileId)!.phase;
      return phaseRank(phase) < phaseRank("critique");
    })
    .map((task) => task.taskId);
  const tasks = proposedTasks.map((task) => {
    const phase = PROFILE_BY_ID.get(task.profileId)!.phase;
    const required = phase === "analysis"
      ? acquisitionTaskIds
      : phase === "reconciliation"
        ? [...acquisitionTaskIds, ...analysisTaskIds]
      : task.profileId === "answer-drafter"
      ? preDraftTaskIds.filter((taskId) => taskId !== task.taskId)
      : task.profileId === "answer-critic"
        ? preCriticTaskIds.filter((taskId) => taskId !== task.taskId)
      : task.profileId === "chat-synthesizer"
        ? proposedTasks
            .filter((candidate) => candidate.taskId !== task.taskId)
            .map((candidate) => candidate.taskId)
        : task.dependencyTaskIds;
    return Object.freeze({
      ...task,
      dependencyTaskIds: Object.freeze([...new Set([
        ...task.dependencyTaskIds,
        ...required,
      ])]) as unknown as string[],
    });
  });
  const taskById = new Map(tasks.map((task) => [task.taskId, task]));
  const profileByTaskId = new Map(tasks.map((task) => [
    task.taskId,
    PROFILE_BY_ID.get(task.profileId)!,
  ]));
  for (const task of tasks) {
    const ownProfile = profileByTaskId.get(task.taskId)!;
    if (task.dependencyTaskIds.includes(task.taskId) ||
        task.dependencyTaskIds.some((taskId) => !taskById.has(taskId))) {
      invalid("A Chat workflow dependency is unknown or self-referential.");
    }
    for (const dependencyTaskId of task.dependencyTaskIds) {
      const dependencyProfile = profileByTaskId.get(dependencyTaskId)!;
      if (phaseRank(dependencyProfile.phase) >= phaseRank(ownProfile.phase)) {
        invalid("A Chat workflow dependency violates the phase order.");
      }
    }
  }
  const synthesizers = tasks.filter((task) => task.profileId === "chat-synthesizer");
  if (synthesizers.length !== 1) {
    invalid("An agentic Chat workflow requires exactly one dedicated synthesizer.");
  }
  const synthesizer = synthesizers[0]!;
  const drafters = tasks.filter((task) => task.profileId === "answer-drafter");
  if (drafters.length !== 1) {
    invalid("An agentic Chat workflow requires exactly one provisional answer drafter.");
  }
  const critics = tasks.filter((task) => task.profileId === "answer-critic");
  if (critics.length !== 1) {
    invalid("An agentic Chat workflow requires exactly one independent answer critic.");
  }
  const ancestors = new Set<string>();
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (taskId: string): void => {
    if (visiting.has(taskId)) invalid("The Chat workflow contains a dependency cycle.");
    if (visited.has(taskId)) return;
    visiting.add(taskId);
    for (const dependency of taskById.get(taskId)!.dependencyTaskIds) {
      ancestors.add(dependency);
      visit(dependency);
    }
    visiting.delete(taskId);
    visited.add(taskId);
  };
  visit(synthesizer.taskId);
  if (tasks.some((task) => task.taskId !== synthesizer.taskId && !ancestors.has(task.taskId))) {
    invalid("Every Chat workflow task must feed the dedicated synthesizer.");
  }
  // The generic workflow compiler models runnable task instances by their
  // unique subagent type. Chat deliberately permits several task instances to
  // share one least-privilege profile (for example, parallel readers for two
  // facets of a question), so compile deterministic instance types while the
  // dispatch admissions retain the registered DeepAgentsJS profile type.
  const compiledTypeByTaskId = new Map(tasks.map((task, index) => [
    task.taskId,
    `${profileByTaskId.get(task.taskId)!.subagentType}:${index + 1}`,
  ]));
  const compiled = compileAgenticWorkflowV1({
    schema: AGENTIC_WORKFLOW_SCHEMA_V1,
    id: `chat:${input.strategy.qualityMode}:${tasks.map((task) => task.profileId).join("+")}`,
    completionObjective: "conversation-answer",
    profiles: tasks.map((task) => ({
      subagentType: compiledTypeByTaskId.get(task.taskId)!,
      roleId: profileByTaskId.get(task.taskId)!.roleId,
      phase: profileByTaskId.get(task.taskId)!.phase,
      dependsOnSubagentTypes: task.dependencyTaskIds.map((dependencyTaskId) =>
        compiledTypeByTaskId.get(dependencyTaskId)!
      ),
    })),
    maxTasks,
    maxConcurrency: proposal.maxConcurrency,
  });
  const admissions = tasks.map((task): Readonly<AgenticTaskAdmissionV1> => {
    const selected = profileByTaskId.get(task.taskId)!;
    return Object.freeze({
      taskId: task.taskId,
      subagentType: selected.subagentType,
      objective: task.objective,
      dependsOnTaskIds: Object.freeze([...task.dependencyTaskIds]),
      grantedCapabilityIds: selected.grantedCapabilityIds,
      responseSchema: selected.responseSchema,
      maxResultBytes: selected.maxResultBytes,
      maxDurationMs: selected.maxDurationMs,
    });
  });
  return Object.freeze({
    compiled,
    tasks: Object.freeze(tasks),
    admissions: Object.freeze(admissions),
    profileByTaskId,
    synthesizerTaskId: synthesizer.taskId,
  });
}

const workflowTaskProposalSchema = z.object({
  taskId: z.string().min(1).max(200),
  profileId: z.enum(CHAT_SUBAGENT_PROFILE_IDS_V1),
  objective: z.string().min(1).max(1_000),
  dependencyTaskIds: z.array(z.string().min(1).max(200)).max(7),
}).strict();

function normalizeModelWorkflowDependenciesV1(
  tasks: readonly ChatWorkflowTaskProposalV1[],
): ChatWorkflowTaskProposalV1[] {
  const taskById = new Map(tasks.map((task) => [task.taskId, task]));
  return tasks.map((task) => {
    const ownProfile = PROFILE_BY_ID.get(task.profileId);
    if (!ownProfile) return { ...task };
    return {
      ...task,
      dependencyTaskIds: task.dependencyTaskIds.filter((dependencyTaskId) => {
        const dependency = taskById.get(dependencyTaskId);
        if (!dependency || dependency.taskId === task.taskId) return true;
        const dependencyProfile = PROFILE_BY_ID.get(dependency.profileId);
        return !dependencyProfile ||
          phaseRank(dependencyProfile.phase) < phaseRank(ownProfile.phase);
      }),
    };
  });
}

function normalizeModelRetrievalPlanV1(
  proposal: ChatRetrievalPlanProposalV1 | undefined,
): ChatRetrievalPlanProposalV1 | undefined {
  if (!proposal) return undefined;
  const gainRank = { high: 0, medium: 1, low: 2 } as const;
  const searchesByProduct = new Map<"jira" | "confluence", NonNullable<ChatRetrievalPlanProposalV1["searches"]>[number]>();
  for (const search of proposal.searches ?? []) {
    const current = searchesByProduct.get(search.product);
    if (!current) {
      searchesByProduct.set(search.product, structuredClone(search));
      continue;
    }
    current.maxPages = Math.max(current.maxPages, search.maxPages);
    current.variants.push(...structuredClone(search.variants));
  }
  const usedSearchIds = new Set<string>();
  const searches = [...searchesByProduct.values()].map((search) => {
    let searchId = search.searchId;
    if (usedSearchIds.has(searchId)) searchId = `search:${search.product}`;
    usedSearchIds.add(searchId);
    const queryFingerprints = new Set<string>();
    const variantIds = new Set<string>();
    const variants = search.variants
      .sort((left, right) =>
        gainRank[left.expectedInformationGain ?? "medium"] -
        gainRank[right.expectedInformationGain ?? "medium"]
      )
      .filter((variant) => {
        const fingerprint = JSON.stringify(variant.query);
        if (queryFingerprints.has(fingerprint)) return false;
        queryFingerprints.add(fingerprint);
        return true;
      })
      // Explicitly named pages/issues are mandatory retrieval anchors. Keep
      // the full five-variant corridor so a fourth or fifth title cannot be
      // silently displaced by a generic product-wide cap.
      .slice(0, 5)
      .map((variant, index) => {
        let variantId = variant.variantId;
        if (variantIds.has(variantId)) {
          variantId = `${variant.variantId.slice(0, 100)}:${index + 1}`;
        }
        variantIds.add(variantId);
        return { ...variant, variantId };
      });
    return { ...search, searchId, variants };
  });
  const traversalKinds = new Set<string>();
  const relationshipTraversals = (proposal.relationshipTraversals ?? []).filter((traversal) => {
    if (traversalKinds.has(traversal.kind)) return false;
    traversalKinds.add(traversal.kind);
    return true;
  });
  return {
    ...(searches.length > 0 ? { searches } : {}),
    ...(relationshipTraversals.length > 0 ? { relationshipTraversals } : {}),
    ...(proposal.unresolvedTerms
      ? { unresolvedTerms: [...new Set(proposal.unresolvedTerms)] }
      : {}),
  };
}

/**
 * One-shot host admission for a model-proposed Chat topology. The returned
 * dispatch envelopes are the only task descriptions the supervisor may send
 * through QuickJS; profile schemas and types always come from the host catalog.
 */
export function createChatWorkflowProposalControllerV1(input: {
  strategy: ChatStrategyDecisionV1;
  budget: ResearchRunBudget;
  /** Body-free host context selected for each admitted child objective. */
  taskContext?: string | ((
    task: Readonly<ChatWorkflowTaskProposalV1>,
    tasks: readonly Readonly<ChatWorkflowTaskProposalV1>[],
  ) => string);
  /** Profiles whose required read capabilities exist in this bound turn. */
  allowedProfileIds?: readonly ChatSubagentProfileIdV1[];
  beforeProposal?: () => void;
  beforeAdmission?: (proposal: ChatWorkflowProposalV1) => void | Promise<void>;
  onAccepted?: (
    workflow: AcceptedChatWorkflowV1,
    response: ChatWorkflowAdmissionResponseV1,
  ) => void | Promise<void>;
}): {
  tool: DynamicStructuredTool;
  acceptedWorkflow(): AcceptedChatWorkflowV1 | undefined;
  acceptedResponse(): ChatWorkflowAdmissionResponseV1 | undefined;
  assertAccepted(): void;
} {
  if (input.strategy.execution !== "agentic") {
    throw new ChatContractError(
      "invalid-request",
      "A direct Chat strategy cannot construct a workflow proposal controller.",
    );
  }
  let accepted: AcceptedChatWorkflowV1 | undefined;
  let acceptedResponse: ChatWorkflowAdmissionResponseV1 | undefined;
  let accepting = false;
  const taskContext = (
    task: Readonly<ChatWorkflowTaskProposalV1>,
    tasks: readonly Readonly<ChatWorkflowTaskProposalV1>[],
  ): string | undefined => {
    if (input.taskContext === undefined) return undefined;
    return boundedText(
      typeof input.taskContext === "function"
        ? input.taskContext(task, tasks)
        : input.taskContext,
      "Chat workflow task context",
      8_000,
    );
  };
  const allowedProfiles = new Set(
    input.allowedProfileIds ?? CHAT_SUBAGENT_PROFILE_IDS_V1,
  );
  const allowedProfileList = [...allowedProfiles];
  const requiredProfiles = input.allowedProfileIds === undefined
    ? []
    : [
        ["exact-read", "exact-context-reader"],
        ["jira-discovery", "jira-search-reader"],
        ["confluence-discovery", "confluence-search-reader"],
        ["relationship-tracing", "relationship-tracer"],
        ["comparison-analysis", "comparison-analyst"],
        ["contradiction-check", "contradiction-checker"],
      ].flatMap(([capability, profileId]): ChatSubagentProfileIdV1[] =>
        input.strategy.requiredCapabilities.includes(
            capability as ChatStrategyDecisionV1["requiredCapabilities"][number],
          ) && allowedProfiles.has(profileId as ChatSubagentProfileIdV1)
          ? [profileId as ChatSubagentProfileIdV1]
          : []
      );
  const proposalTool = tool(async (proposal) => {
    if (accepted || accepting) {
      throw new ChatContractError(
        "invalid-request",
        "The Chat workflow proposal has already been accepted for this turn.",
      );
    }
    input.beforeProposal?.();
    const unavailableProfiles = [...new Set(proposal.tasks
      .map((task) => task.profileId)
      .filter((profileId) => !allowedProfiles.has(profileId)))];
    if (unavailableProfiles.length > 0) {
      throw new ChatContractError(
        "invalid-request",
        `The Chat workflow requested unavailable profiles (${unavailableProfiles.join(", ")}). ` +
          `Use only: ${allowedProfileList.join(", ")}.`,
      );
    }
    const oversizedExactTasks = proposal.tasks.flatMap((task) => {
      if (task.profileId !== "exact-context-reader") return [];
      const assignedAnchors = new Set(
        [...task.objective.matchAll(/\bresearch-anchor:[A-Za-z0-9-]{1,200}\b/gu)]
          .map((match) => match[0]),
      );
      return assignedAnchors.size > MAX_EXACT_ANCHORS_PER_CHAT_READER_V1
        ? [{ taskId: task.taskId, count: assignedAnchors.size }]
        : [];
    });
    if (oversizedExactTasks.length > 0) {
      throw new ChatContractError(
        "invalid-request",
        `Each exact-context-reader may receive at most ${MAX_EXACT_ANCHORS_PER_CHAT_READER_V1} assigned anchorRefs. Split: ${oversizedExactTasks.map((task) => `${task.taskId} (${task.count})`).join(", ")}.`,
      );
    }
    const proposedProfiles = new Set(proposal.tasks.map((task) => task.profileId));
    const missingRequiredProfiles = requiredProfiles.filter((profileId) =>
      !proposedProfiles.has(profileId)
    );
    if (missingRequiredProfiles.length > 0) {
      throw new ChatContractError(
        "invalid-request",
        `The Chat workflow does not cover the accepted strategy. Add the required profiles: ${missingRequiredProfiles.join(", ")}.`,
      );
    }
    accepting = true;
    try {
      input.budget.beginPtc({ schema: CHAT_WORKFLOW_PROPOSAL_SCHEMA_V1 });
      const normalizedRetrievalPlan = normalizeModelRetrievalPlanV1(
        proposal.retrievalPlan,
      );
      const workflowProposal: ChatWorkflowProposalV1 = {
        schema: CHAT_WORKFLOW_PROPOSAL_SCHEMA_V1,
        maxConcurrency: proposal.maxConcurrency,
        tasks: proposal.tasks.map((task) => ({ ...task })),
        ...(normalizedRetrievalPlan ? { retrievalPlan: normalizedRetrievalPlan } : {}),
      };
      await input.beforeAdmission?.(workflowProposal);
      const normalizedTasks = normalizeModelWorkflowDependenciesV1(
        proposal.tasks.map((task) => ({ ...task })),
      );
      const workflow = admitChatWorkflowProposalV1({
        strategy: input.strategy,
        proposal: {
          schema: CHAT_WORKFLOW_PROPOSAL_SCHEMA_V1,
          maxConcurrency: proposal.maxConcurrency,
          tasks: normalizedTasks.map((task) => {
            const context = taskContext(task, normalizedTasks);
            return {
              ...task,
              objective: context
                ? `${task.objective}\n\nHost-bound turn context:\n${context}`
                : task.objective,
            };
          }),
          ...(normalizedRetrievalPlan ? { retrievalPlan: normalizedRetrievalPlan } : {}),
        },
      });
      if (!workflow) {
        throw new ChatContractError(
          "invalid-request",
          "The agentic Chat workflow proposal was not admitted.",
        );
      }
      const response: ChatWorkflowAdmissionResponseV1 = {
        schema: "atlcli.chat-workflow-admission/v1",
        completionObjective: "conversation-answer",
        maxConcurrency: workflow.compiled.maxConcurrency,
        synthesizerTaskId: workflow.synthesizerTaskId,
        qualityReviewRequired: true,
        dispatches: Object.freeze(workflow.tasks
          .filter((task) => task.taskId !== workflow.synthesizerTaskId)
          .map((task) => createChatWorkflowDispatchV1({
            task,
            profile: workflow.profileByTaskId.get(task.taskId)!,
          }))),
      };
      await input.onAccepted?.(workflow, response);
      input.budget.completePtc(response);
      accepted = workflow;
      acceptedResponse = response;
      return JSON.stringify(response);
    } finally {
      accepting = false;
    }
  }, {
    name: "chat_workflow_propose",
    description:
      `Propose one bounded dependency graph after accepting an agentic strategy. ` +
      `The complete profile set available in this turn is: ${allowedProfileList.join(", ")}. ` +
      `The accepted strategy requires these profiles in this proposal: ${requiredProfiles.join(", ") || "none"}. ` +
      `Assign at most ${MAX_EXACT_ANCHORS_PER_CHAT_READER_V1} explicit opaque anchorRefs to each exact-context-reader task; split larger exact source sets into parallel readers. ` +
      "Dependencies must move strictly from acquisition readers through analysis and optional contradiction reconciliation to one provisional answer drafter and one answer critic. Default to one parallel exact-context reader per bounded anchor so each child context and QuickJS result stays bounded. Group exact anchors only when the host objective establishes that their combined projections fit one task's byte and output limits. Keep admitted search variants for the same product in one search-reader task because its host controller owns the product-wide pagination and detail budget. Split other readers when their products, capability grants, independent facets, or latency benefit materially differ. Include exactly one chat-synthesizer definition, but the host withholds its dispatch until the mandatory quality checkpoint. The answer repairer is host-only and cannot be proposed. The host returns exact task descriptions, types, and response schemas for dispatch.",
    schema: z.object({
      tasks: z.array(workflowTaskProposalSchema).min(4).max(9),
      maxConcurrency: z.number().int().min(1).max(3),
      retrievalPlan: CHAT_RETRIEVAL_PLAN_PROPOSAL_SCHEMA_V1.optional(),
    }).strict(),
  });
  return {
    tool: proposalTool,
    acceptedWorkflow: () => accepted,
    acceptedResponse: () => acceptedResponse,
    assertAccepted() {
      if (!accepted) {
        throw new ChatContractError(
          "invalid-report",
          "An agentic Chat answer requires one accepted dynamic workflow.",
        );
      }
    },
  };
}
