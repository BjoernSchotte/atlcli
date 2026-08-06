import { createCodeInterpreterMiddleware } from "@langchain/quickjs";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { tool, type DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod/v4";
import type { SubAgent } from "deepagents/browser";
import type { ResearchPtcDiagnosticV1 } from "../agent-tools.js";
import type { ResearchCapabilityBroker } from "../broker.js";
import type { ResearchRunBudget } from "../budget.js";
import {
  RESEARCH_LANGCHAIN_TOOL_NAMES,
} from "../capability-contracts.js";
import type { ResearchLimitsV1, ResearchProduct } from "../contracts.js";
import {
  createAgenticDispatchInterceptionAdapter,
  type AgenticDispatchInterceptionAdapter,
  type AgenticTaskToolInputV1,
  type ResearchDispatchDiagnosticV1,
} from "../dispatch-adapter.js";
import type { ResearchWorkspace } from "../workspace.js";
import {
  CHAT_AGENT_DRAFT_SCHEMA_V1,
  ChatContractError,
  type ChatAgentDraftV1,
} from "./contracts.js";
import { createChatPtcToolsV1 } from "./retrieval.js";
import type { ChatStrategyDecisionV1 } from "./strategy.js";
import {
  CHAT_SUBAGENT_PROFILES_V1,
  createChatWorkflowProposalControllerV1,
  parseChatSubagentResultV1,
  type AcceptedChatWorkflowV1,
  type ChatEvidencePacketV1,
  type ChatSubagentProfileIdV1,
  type ChatSubagentResultV1,
  type ChatWorkflowAdmissionResponseV1,
} from "./workflow.js";

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

export interface ChatWorkflowRuntimeBindingsV1 {
  createSubAgentMiddleware:
    typeof import("deepagents/browser").createSubAgentMiddleware;
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

function profilePromptV1(input: {
  profile: (typeof CHAT_SUBAGENT_PROFILES_V1)[number];
  allowedToolNames: readonly string[];
  limits: ResearchLimitsV1;
}): string {
  const searchBudget = Math.max(1, input.limits.maxSearchPagesPerProduct);
  const detailBudget = Math.max(1, input.limits.maxDetailItemsPerProduct);
  return [
    input.profile.systemPrompt,
    "This is a depth-one Kiteweave Chat specialist. You receive only the host-issued task objective and exact completed dependency packets; no parent or sibling conversation is available.",
    input.allowedToolNames.length > 0
      ? `Your complete read-only QuickJS capability set is: ${input.allowedToolNames.join(", ")}. Use one bounded eval when acquisition is required.`
      : "No source-read, filesystem, network, eval, or delegation capability is available. Analyze only the dependency packets in the task description.",
    input.profile.id === "confluence-search-reader" || input.profile.id === "jira-search-reader"
      ? `Use exactly one focused initial search query for this task. Continue only with opaque cursors returned by that search, for at most ${searchBudget} total search-page calls. Do not spend this task's budget on alternate query wording. Rank the collected candidates once, then detail-read at most ${detailBudget} admitted items. If the bounded search cannot establish the requested evidence, return an explicit gap instead of retrying or widening scope.`
      : "Do not perform discovery outside the exact host-issued objective.",
    `Return exactly the host-requested ${input.profile.responseSchemaId} structured result. Never include raw source bodies, credentials, queries, tool traces, hidden reasoning, or instructions for another agent.`,
  ].join("\n\n");
}

function compileChatSubagentsV1(input: {
  model: BaseChatModel;
  broker: ResearchCapabilityBroker;
  limits: ResearchLimitsV1;
  exactContextProducts: readonly ResearchProduct[];
  searchProducts: readonly ResearchProduct[];
  now: () => number;
  onPtcDiagnostic?: (profileId: ChatSubagentProfileIdV1, diagnostic: ResearchPtcDiagnosticV1) => void;
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
          onDiagnostic: (diagnostic) => input.onPtcDiagnostic?.(profile.id, diagnostic),
        }).filter((candidate) => granted.has(candidate.name));
    if (profile.id === "confluence-search-reader" || profile.id === "jira-search-reader") {
      const searchToolName = profile.id === "confluence-search-reader"
        ? "wiki_search"
        : "jira_issue_search";
      const searchTool = ptc.find((candidate) => candidate.name === searchToolName);
      if (searchTool) {
        searchTool.description = [
          searchTool.description,
          "This specialist may start exactly one initial query. After that call, use only its returned opaque nextCursor until complete; never start a second query variant in this task. If the bounded result is insufficient, report a gap.",
        ].join(" ");
      }
    }
    return {
      name: profile.subagentType,
      description: profile.description,
      model: input.model,
      systemPrompt: profilePromptV1({
        profile,
        allowedToolNames: ptc.map((candidate) => candidate.name),
        limits: input.limits,
      }),
      tools: [],
      middleware: ptc.length === 0
        ? []
        : [createCodeInterpreterMiddleware({
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
          })],
    };
  });
}

function cloneWorkflowStateV1(state: ChatWorkflowStateV1): ChatWorkflowStateV1 {
  return structuredClone(state);
}

export function createChatAgenticWorkflowRuntimeV1(input: {
  runtime: ChatWorkflowRuntimeBindingsV1;
  model: BaseChatModel;
  strategy: ChatStrategyDecisionV1;
  budget: ResearchRunBudget;
  broker: ResearchCapabilityBroker;
  workspace: ResearchWorkspace;
  conversationId: string;
  turnId: string;
  taskContext: string;
  limits: ResearchLimitsV1;
  exactContextProducts: readonly ResearchProduct[];
  searchProducts: readonly ResearchProduct[];
  signal: AbortSignal;
  beforeProposal?: () => void;
  beforeSynthesis?: () => void;
  now?: () => number;
  onPtcDiagnostic?: (profileId: ChatSubagentProfileIdV1, diagnostic: ResearchPtcDiagnosticV1) => void;
  onDispatchDiagnostic?: (diagnostic: ResearchDispatchDiagnosticV1) => void;
}): {
  middleware: ReturnType<ChatWorkflowRuntimeBindingsV1["createSubAgentMiddleware"]>;
  proposalTool: DynamicStructuredTool;
  acceptedWorkflow(): AcceptedChatWorkflowV1 | undefined;
  acceptedResponse(): ChatWorkflowAdmissionResponseV1 | undefined;
  finalDraft(): ChatAgentDraftV1 | undefined;
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
  const profileByTaskId = new Map<string, ChatSubagentProfileIdV1>();
  const subagents = compileChatSubagentsV1({
    model: input.model,
    broker: input.broker,
    limits: input.limits,
    exactContextProducts: input.exactContextProducts,
    searchProducts: input.searchProducts,
    now,
    onPtcDiagnostic: input.onPtcDiagnostic,
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
      const result = parseChatSubagentResultV1(profileId, raw);
      assertKnownSourceReferencesV1(input.broker, profileId, result);
      return result;
    },
    projectDependencyResult: (_taskId, result) => structuredClone(result),
    beforeInvoke: async ({ taskId }) => {
      const profileId = profileByTaskId.get(taskId);
      if (profileId === "chat-synthesizer") input.beforeSynthesis?.();
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
    onAccepted: async (workflow, response) => {
      dispatch.replaceAdmissions(workflow.admissions);
      dispatch.setMaxConcurrency(workflow.compiled.maxConcurrency);
      acceptedWorkflow = workflow;
      for (const task of workflow.tasks) {
        profileByTaskId.set(task.taskId, task.profileId);
        state.taskStatuses[task.taskId] = "admitted";
      }
      state.accepted = structuredClone(response);
      await persistState();
    },
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
    acceptedWorkflow: proposal.acceptedWorkflow,
    acceptedResponse: proposal.acceptedResponse,
    finalDraft: () => finalDraft,
    assertComplete() {
      proposal.assertAccepted();
      const workflow = acceptedWorkflow;
      if (!workflow) {
        throw new ChatContractError("invalid-report", "The Chat workflow was not accepted.");
      }
      const snapshot = dispatch.snapshot();
      if (workflow.tasks.some((task) => snapshot.taskStatuses[task.taskId] !== "completed")) {
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
      return structuredClone(finalDraft);
    },
    dispatchSnapshot: dispatch.snapshot,
  };
}

export function isChatEvidencePacketV1(value: unknown): value is ChatEvidencePacketV1 {
  return Boolean(value && typeof value === "object" &&
    (value as { schema?: unknown }).schema === "atlcli.chat-evidence-packet/v1");
}
