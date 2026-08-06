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
  CHAT_AGENT_DRAFT_JSON_SCHEMA_V1,
  CHAT_AGENT_DRAFT_SCHEMA_V1,
  ChatContractError,
  type ChatAgentDraftV1,
} from "./contracts.js";
import type { ChatStrategyDecisionV1 } from "./strategy.js";

export const CHAT_WORKFLOW_PROPOSAL_SCHEMA_V1 =
  "atlcli.chat-workflow-proposal/v1" as const;

export const CHAT_SUBAGENT_PROFILE_IDS_V1 = [
  "exact-context-reader",
  "confluence-search-reader",
  "jira-search-reader",
  "relationship-tracer",
  "comparison-analyst",
  "contradiction-checker",
  "answer-critic",
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
    schema: { const: "atlcli.chat-evidence-packet/v1" },
    sourceIds: STRING_ARRAY,
    claims: {
      type: "array",
      maxItems: 80,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["text", "sourceIds"],
        properties: {
          text: { type: "string", minLength: 1, maxLength: 1_000 },
          sourceIds: STRING_ARRAY,
        },
      },
    },
    relationships: {
      type: "array",
      maxItems: 80,
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
      maxItems: 40,
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
    schema: { const: "atlcli.chat-analysis-packet/v1" },
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
    schema: { const: "atlcli.chat-critique-packet/v1" },
    defects: {
      type: "array",
      maxItems: 40,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["code", "message", "sourceIds", "repairable"],
        properties: {
          code: { type: "string", minLength: 1, maxLength: 80 },
          message: { type: "string", minLength: 1, maxLength: 800 },
          sourceIds: STRING_ARRAY,
          repairable: { type: "boolean" },
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
    code: z.string().min(1).max(80),
    message: z.string().min(1).max(800),
    sourceIds: z.array(z.string().min(1).max(256)).max(100),
    repairable: z.boolean(),
  }).strict()).max(40),
  readyForSynthesis: z.boolean(),
}).strict();

export type ChatEvidencePacketV1 = z.infer<typeof chatEvidencePacketSchemaV1>;
export type ChatAnalysisPacketV1 = z.infer<typeof chatAnalysisPacketSchemaV1>;
export type ChatCritiquePacketV1 = z.infer<typeof chatCritiquePacketSchemaV1>;
export type ChatSubagentResultV1 =
  | ChatEvidencePacketV1
  | ChatAnalysisPacketV1
  | ChatCritiquePacketV1
  | ChatAgentDraftV1;

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
  const schema = profileId === "chat-synthesizer"
    ? CHAT_AGENT_DRAFT_SCHEMA_V1
    : profileId === "answer-critic"
      ? chatCritiquePacketSchemaV1
      : profileId === "exact-context-reader" ||
          profileId === "confluence-search-reader" ||
          profileId === "jira-search-reader"
        ? chatEvidencePacketSchemaV1
        : chatAnalysisPacketSchemaV1;
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
    systemPrompt: "Read only opaque host-attached entities. Return bounded source references, supported claims, relationships, and gaps. Never return source bodies or delegate.",
    grantedCapabilityIds: [
      BOUND_ENTITY_READ_CAPABILITY_ID_V1,
      BOUND_ENTITY_SECTION_READ_CAPABILITY_ID_V1,
    ],
    responseSchemaId: "atlcli.chat-evidence-packet/v1",
    responseSchema: CHAT_EVIDENCE_PACKET_SCHEMA_V1,
    modelPreference: "fast",
    maxInputChars: 12_000,
    maxResultBytes: 32_000,
    maxDurationMs: 45_000,
  }),
  profile({
    id: "confluence-search-reader",
    subagentType: "chat-confluence-search-reader-v1",
    roleId: "confluence-search-reader",
    phase: "acquisition",
    description: "Discover, rank, and detail-read only admitted Confluence candidates.",
    systemPrompt: "Use only Confluence discovery, ranking, and detail capabilities. Return bounded references and claims, never bodies, credentials, queries, or delegation.",
    grantedCapabilityIds: ["wiki.search", "research.candidate.rank", "wiki.page.get"],
    responseSchemaId: "atlcli.chat-evidence-packet/v1",
    responseSchema: CHAT_EVIDENCE_PACKET_SCHEMA_V1,
    modelPreference: "fast",
    maxInputChars: 10_000,
    maxResultBytes: 40_000,
    maxDurationMs: 120_000,
  }),
  profile({
    id: "jira-search-reader",
    subagentType: "chat-jira-search-reader-v1",
    roleId: "jira-search-reader",
    phase: "acquisition",
    description: "Discover, rank, and detail-read only admitted Jira candidates.",
    systemPrompt: "Use only Jira discovery, ranking, and detail capabilities. Return bounded references and claims, never bodies, credentials, queries, or delegation.",
    grantedCapabilityIds: ["jira.issue.search", "research.candidate.rank", "jira.issue.get"],
    responseSchemaId: "atlcli.chat-evidence-packet/v1",
    responseSchema: CHAT_EVIDENCE_PACKET_SCHEMA_V1,
    modelPreference: "fast",
    maxInputChars: 10_000,
    maxResultBytes: 40_000,
    maxDurationMs: 120_000,
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
    maxDurationMs: 45_000,
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
    maxDurationMs: 45_000,
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
    maxDurationMs: 45_000,
  }),
  profile({
    id: "answer-critic",
    subagentType: "chat-answer-critic-v1",
    roleId: "answer-critic",
    phase: "reconciliation",
    description: "Critique answer coverage, grounding, citations, and unresolved gaps.",
    systemPrompt: "Return typed defects over accepted reference packets. Do not retrieve, delegate, repair, or author the final answer.",
    grantedCapabilityIds: [],
    responseSchemaId: "atlcli.chat-critique-packet/v1",
    responseSchema: CHAT_CRITIQUE_PACKET_SCHEMA_V1,
    modelPreference: "thorough",
    maxInputChars: 24_000,
    maxResultBytes: 20_000,
    maxDurationMs: 45_000,
  }),
  profile({
    id: "chat-synthesizer",
    subagentType: "chat-synthesizer-v1",
    roleId: "synthesizer",
    phase: "synthesis",
    description: "Write one concise conversational answer from accepted evidence and analysis packets.",
    systemPrompt: "Write the final conversational answer only from accepted references, defects, and gaps. Never retrieve, delegate, invent URLs, or produce a Deep Research report.",
    grantedCapabilityIds: [],
    responseSchemaId: "atlcli.chat-answer-draft/v1",
    responseSchema: Object.freeze({
      ...CHAT_AGENT_DRAFT_JSON_SCHEMA_V1,
      title: "ChatAnswerDraftV1",
    }),
    modelPreference: "thorough",
    maxInputChars: 32_000,
    maxResultBytes: 32_000,
    maxDurationMs: 60_000,
  }),
] as const);

const PROFILE_BY_ID = new Map(
  CHAT_SUBAGENT_PROFILES_V1.map((entry) => [entry.id, entry]),
);

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
  dispatches: readonly Readonly<ChatWorkflowDispatchV1>[];
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
  return ["acquisition", "analysis", "reconciliation", "synthesis"].indexOf(phase);
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
  const maxTasks = Math.max(2, Math.min(8, Math.trunc(input.maxTasks ?? 8)));
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
  const profiles = new Set<ChatSubagentProfileIdV1>();
  const tasks = proposal.tasks.map((candidate) => {
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
    if (profiles.has(candidate.profileId)) {
      invalid("A Chat workflow profile may be selected at most once per turn.");
    }
    profiles.add(candidate.profileId);
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
  const compiled = compileAgenticWorkflowV1({
    schema: AGENTIC_WORKFLOW_SCHEMA_V1,
    id: `chat:${input.strategy.qualityMode}:${tasks.map((task) => task.profileId).join("+")}`,
    completionObjective: "conversation-answer",
    profiles: tasks.map((task) => ({
      subagentType: profileByTaskId.get(task.taskId)!.subagentType,
      roleId: profileByTaskId.get(task.taskId)!.roleId,
      phase: profileByTaskId.get(task.taskId)!.phase,
      dependsOnSubagentTypes: task.dependencyTaskIds.map((dependencyTaskId) =>
        profileByTaskId.get(dependencyTaskId)!.subagentType
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

/**
 * One-shot host admission for a model-proposed Chat topology. The returned
 * dispatch envelopes are the only task descriptions the supervisor may send
 * through QuickJS; profile schemas and types always come from the host catalog.
 */
export function createChatWorkflowProposalControllerV1(input: {
  strategy: ChatStrategyDecisionV1;
  budget: ResearchRunBudget;
  /** Body-free host context appended to every admitted child objective. */
  taskContext?: string;
  /** Profiles whose required read capabilities exist in this bound turn. */
  allowedProfileIds?: readonly ChatSubagentProfileIdV1[];
  beforeProposal?: () => void;
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
  const taskContext = input.taskContext === undefined
    ? undefined
    : boundedText(input.taskContext, "Chat workflow task context", 2_800);
  const allowedProfiles = new Set(
    input.allowedProfileIds ?? CHAT_SUBAGENT_PROFILE_IDS_V1,
  );
  const proposalTool = tool(async (proposal) => {
    if (accepted || accepting) {
      throw new ChatContractError(
        "invalid-request",
        "The Chat workflow proposal has already been accepted for this turn.",
      );
    }
    input.beforeProposal?.();
    if (proposal.tasks.some((task) => !allowedProfiles.has(task.profileId))) {
      throw new ChatContractError(
        "invalid-request",
        "The Chat workflow requested a profile whose capabilities are unavailable in this turn.",
      );
    }
    accepting = true;
    try {
      input.budget.beginPtc({ schema: CHAT_WORKFLOW_PROPOSAL_SCHEMA_V1 });
      const workflow = admitChatWorkflowProposalV1({
        strategy: input.strategy,
        proposal: {
          schema: CHAT_WORKFLOW_PROPOSAL_SCHEMA_V1,
          maxConcurrency: proposal.maxConcurrency,
          tasks: proposal.tasks.map((task) => ({
            ...task,
            objective: taskContext
              ? `${task.objective}\n\nHost-bound turn context:\n${taskContext}`
              : task.objective,
          })),
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
        dispatches: Object.freeze(workflow.tasks.map((task) => {
          const profile = workflow.profileByTaskId.get(task.taskId)!;
          return Object.freeze({
            taskId: task.taskId,
            subagentType: profile.subagentType,
            objective: task.objective,
            dependencyTaskIds: Object.freeze([...task.dependencyTaskIds]),
            description: encodeAgenticTaskDescriptionV1({
              taskId: task.taskId,
              objective: task.objective,
            }),
            responseSchema: profile.responseSchema,
          });
        })),
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
      "Propose one bounded dependency graph from the eight documented Chat profiles after accepting an agentic strategy. Dependencies must move strictly from acquisition readers to parallel analysis profiles to answer-critic to chat-synthesizer; profiles in the same phase cannot depend on one another. The host returns exact task descriptions, types, and response schemas for dispatch.",
    schema: z.object({
      tasks: z.array(workflowTaskProposalSchema).min(2).max(8),
      maxConcurrency: z.number().int().min(1).max(3),
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
