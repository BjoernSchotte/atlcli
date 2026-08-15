import type { ResearchSessionTurnV1, ResearchSessionV1 } from "./session.js";

/**
 * T0 inventory of the persisted research aggregate. T6 replaces this baseline
 * with the generalized Chat/Research lifetime registry and merge policy.
 */
export type ResearchStateLifetimeV1 =
  | "durable-model-visible"
  | "durable-ui-restore"
  | "durable-orchestration"
  | "client-per-turn"
  | "transient-progress"
  | "observability";

export type ResearchStateResumeOwnerV1 =
  | "session-store"
  | "workspace-checkpointer"
  | "dispatch-journal"
  | "authenticated-client"
  | "active-run"
  | "runtime-observability";

export interface ResearchStateLifetimeEntryV1 {
  lifetime: ResearchStateLifetimeV1;
  resumeOwner: ResearchStateResumeOwnerV1;
  modelVisible: boolean;
}

const orchestration = {
  lifetime: "durable-orchestration",
  resumeOwner: "session-store",
  modelVisible: false,
} as const satisfies ResearchStateLifetimeEntryV1;
const modelVisible = {
  lifetime: "durable-model-visible",
  resumeOwner: "session-store",
  modelVisible: true,
} as const satisfies ResearchStateLifetimeEntryV1;
const uiRestore = {
  lifetime: "durable-ui-restore",
  resumeOwner: "session-store",
  modelVisible: false,
} as const satisfies ResearchStateLifetimeEntryV1;

export const RESEARCH_SESSION_FIELD_LIFETIMES_T0 = {
  schema: orchestration,
  sessionId: orchestration,
  revision: orchestration,
  status: uiRestore,
  lease: orchestration,
  retention: orchestration,
  scopeClarification: uiRestore,
  modelBudgetState: orchestration,
  activeTurnId: orchestration,
  turns: orchestration,
  createdAt: uiRestore,
  updatedAt: uiRestore,
} as const satisfies Record<keyof ResearchSessionV1, ResearchStateLifetimeEntryV1>;

export const RESEARCH_SESSION_TURN_FIELD_LIFETIMES_T0 = {
  id: orchestration,
  revision: orchestration,
  createdAt: uiRestore,
  brief: modelVisible,
  graph: orchestration,
  approvedGraphCatalog: orchestration,
  graphSelectionCommittedAt: orchestration,
  latentRepairNode: orchestration,
  repairAuthorization: orchestration,
  scopeCandidates: orchestration,
  scopeDiscoveries: orchestration,
  scopeDiscoveryDispositions: orchestration,
  scopeBindings: modelVisible,
  scopeResolutions: orchestration,
  scopeExpansionProposals: orchestration,
  clarifications: modelVisible,
  assumptionDecisions: modelVisible,
  planRevisions: orchestration,
  scopeRevisions: orchestration,
  steering: modelVisible,
  tasks: orchestration,
  acceptedPackets: modelVisible,
  reconciliationDispositions: orchestration,
  budgetState: orchestration,
  reconciliationCommittedAt: orchestration,
  graphRevisions: orchestration,
  retrievalAssessments: orchestration,
  checkpoints: orchestration,
  pauseRequestedAt: uiRestore,
  pausedAt: uiRestore,
  completedAt: uiRestore,
  cancelledAt: uiRestore,
  failureReason: uiRestore,
} as const satisfies Record<
  keyof ResearchSessionTurnV1,
  ResearchStateLifetimeEntryV1
>;

export const RESEARCH_NON_SESSION_STATE_LIFETIMES_T0 = {
  langGraphCheckpoint: {
    lifetime: "durable-orchestration",
    resumeOwner: "workspace-checkpointer",
    modelVisible: false,
  },
  dispatchAttempt: {
    lifetime: "durable-orchestration",
    resumeOwner: "dispatch-journal",
    modelVisible: false,
  },
  currentPageContext: {
    lifetime: "client-per-turn",
    resumeOwner: "authenticated-client",
    modelVisible: true,
  },
  activityAnimation: {
    lifetime: "transient-progress",
    resumeOwner: "active-run",
    modelVisible: false,
  },
  traceCorrelation: {
    lifetime: "observability",
    resumeOwner: "runtime-observability",
    modelVisible: false,
  },
} as const satisfies Record<string, ResearchStateLifetimeEntryV1>;
