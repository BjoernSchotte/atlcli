import type { AgenticTaskAdmissionV1 } from "./dispatch-adapter.js";

export const AGENTIC_WORKFLOW_SCHEMA_V1 =
  "atlcli.agentic-workflow/v1" as const;

export const AGENTIC_COMPLETION_OBJECTIVES_V1 = [
  "conversation-answer",
  "research-report",
] as const;

export type AgenticCompletionObjectiveV1 =
  (typeof AGENTIC_COMPLETION_OBJECTIVES_V1)[number];

export const AGENTIC_WORKFLOW_PHASES_V1 = [
  "acquisition",
  "analysis",
  "reconciliation",
  "synthesis",
] as const;

export type AgenticWorkflowPhaseV1 =
  (typeof AGENTIC_WORKFLOW_PHASES_V1)[number];

export interface AgenticWorkflowProfileV1 {
  /** Exact declarative type accepted by the repository-owned task bridge. */
  subagentType: string;
  /** Host-owned specialization identifier; never model-generated. */
  roleId: string;
  phase: AgenticWorkflowPhaseV1;
  dependsOnSubagentTypes: readonly string[];
}

export interface AgenticWorkflowDefinitionV1 {
  schema: typeof AGENTIC_WORKFLOW_SCHEMA_V1;
  id: string;
  completionObjective: AgenticCompletionObjectiveV1;
  profiles: readonly AgenticWorkflowProfileV1[];
  maxTasks: number;
  maxConcurrency: number;
}

export interface CompiledAgenticWorkflowV1 {
  readonly schema: typeof AGENTIC_WORKFLOW_SCHEMA_V1;
  readonly id: string;
  readonly completionObjective: AgenticCompletionObjectiveV1;
  readonly profiles: readonly Readonly<AgenticWorkflowProfileV1>[];
  readonly maxTasks: number;
  readonly maxConcurrency: number;
  /**
   * Reuse stays disabled until a host proves trajectory equivalence, isolation,
   * and a material latency benefit. Compilation itself never captures a run.
   */
  readonly reuseEligible: false;
  readonly compatibilityFingerprint: string;
}

export interface AgenticWorkflowRunIdentityV1 {
  userId: string;
  threadId: string;
  turnId: string;
  revision: number;
  scopeFingerprint: string;
  providerCacheIdentity: string;
}

export interface BoundAgenticWorkflowRunV1 {
  readonly compiled: CompiledAgenticWorkflowV1;
  readonly identity: Readonly<AgenticWorkflowRunIdentityV1>;
  readonly signal?: AbortSignal;
}

export interface AgenticDispatchControlGateV1 {
  authorize(input: {
    taskId: string;
    admission: AgenticTaskAdmissionV1;
  }): void | Promise<void>;
  requireHumanApproval?(input: {
    taskId: string;
    admission: AgenticTaskAdmissionV1;
  }): void | Promise<void>;
  reserveBudget(input: {
    taskId: string;
    admission: AgenticTaskAdmissionV1;
  }): void | Promise<void>;
  journalStart(input: {
    taskId: string;
    admission: AgenticTaskAdmissionV1;
  }): void | Promise<void>;
}

function boundedIdentifier(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 240) {
    throw new Error(`${name} must be a non-empty string of at most 240 characters.`);
  }
  return value;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive safe integer.`);
  }
  return value;
}

function stableFingerprint(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `fnv1a32:${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

/**
 * Compile only immutable workflow structure. Tenant, auth, scope, provider
 * cache identity, cancellation, steering, and durable stores belong to the
 * per-run binding and can never be retained by this descriptor.
 */
export function compileAgenticWorkflowV1(
  definition: AgenticWorkflowDefinitionV1,
): CompiledAgenticWorkflowV1 {
  if (definition.schema !== AGENTIC_WORKFLOW_SCHEMA_V1) {
    throw new Error("Unsupported agentic workflow schema.");
  }
  if (!AGENTIC_COMPLETION_OBJECTIVES_V1.includes(definition.completionObjective)) {
    throw new Error("Unsupported agentic completion objective.");
  }
  const id = boundedIdentifier(definition.id, "Agentic workflow ID");
  const maxTasks = positiveInteger(definition.maxTasks, "maxTasks");
  const maxConcurrency = positiveInteger(definition.maxConcurrency, "maxConcurrency");
  if (maxConcurrency > maxTasks) {
    throw new Error("maxConcurrency cannot exceed maxTasks.");
  }
  const seenTypes = new Set<string>();
  const profiles = definition.profiles.map((profile) => {
    const subagentType = boundedIdentifier(profile.subagentType, "Subagent type");
    const roleId = boundedIdentifier(profile.roleId, "Role ID");
    if (seenTypes.has(subagentType)) {
      throw new Error(`Duplicate agentic subagent type: ${subagentType}`);
    }
    if (!AGENTIC_WORKFLOW_PHASES_V1.includes(profile.phase)) {
      throw new Error(`Unsupported agentic workflow phase: ${profile.phase}`);
    }
    seenTypes.add(subagentType);
    const dependsOnSubagentTypes = Object.freeze(
      profile.dependsOnSubagentTypes.map((dependency) =>
        boundedIdentifier(dependency, "Dependency subagent type")
      ),
    );
    if (
      new Set(dependsOnSubagentTypes).size !== dependsOnSubagentTypes.length ||
      dependsOnSubagentTypes.includes(subagentType)
    ) {
      throw new Error(`Invalid agentic workflow dependencies: ${subagentType}`);
    }
    return Object.freeze({
      subagentType,
      roleId,
      phase: profile.phase,
      dependsOnSubagentTypes,
    });
  });
  if (profiles.length > maxTasks) {
    throw new Error("Agentic workflow profiles exceed maxTasks.");
  }
  const profileByType = new Map(
    profiles.map((profile) => [profile.subagentType, profile]),
  );
  for (const profile of profiles) {
    if (profile.dependsOnSubagentTypes.some((dependency) => !profileByType.has(dependency))) {
      throw new Error(`Unknown agentic workflow dependency: ${profile.subagentType}`);
    }
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (subagentType: string): void => {
    if (visited.has(subagentType)) return;
    if (visiting.has(subagentType)) {
      throw new Error("Agentic workflow dependencies contain a cycle.");
    }
    visiting.add(subagentType);
    profileByType.get(subagentType)!.dependsOnSubagentTypes.forEach(visit);
    visiting.delete(subagentType);
    visited.add(subagentType);
  };
  profiles.forEach((profile) => visit(profile.subagentType));
  const synthesizers = profiles.filter((profile) => profile.phase === "synthesis");
  if (synthesizers.length !== 1) {
    throw new Error("Agentic workflow requires exactly one synthesis profile.");
  }
  const synthesisAncestors = new Set<string>();
  const collectAncestors = (subagentType: string): void => {
    profileByType.get(subagentType)!.dependsOnSubagentTypes.forEach((dependency) => {
      if (synthesisAncestors.has(dependency)) return;
      synthesisAncestors.add(dependency);
      collectAncestors(dependency);
    });
  };
  collectAncestors(synthesizers[0]!.subagentType);
  if (profiles.some((profile) =>
    profile.phase !== "synthesis" && !synthesisAncestors.has(profile.subagentType)
  )) {
    throw new Error("Every agentic workflow profile must feed the sole synthesizer.");
  }
  const compatibilityFingerprint = stableFingerprint(JSON.stringify({
    schema: definition.schema,
    id,
    completionObjective: definition.completionObjective,
    profiles,
    maxTasks,
    maxConcurrency,
  }));
  return Object.freeze({
    schema: AGENTIC_WORKFLOW_SCHEMA_V1,
    id,
    completionObjective: definition.completionObjective,
    profiles: Object.freeze(profiles),
    maxTasks,
    maxConcurrency,
    reuseEligible: false,
    compatibilityFingerprint,
  });
}

/**
 * Compute one deterministic ready frontier from immutable topology and
 * host-owned terminal state. Dispatch ordering remains a host concern.
 */
export function readyAgenticFrontierV1(
  compiled: CompiledAgenticWorkflowV1,
  state: {
    completedSubagentTypes: ReadonlySet<string>;
    startedSubagentTypes?: ReadonlySet<string>;
  },
): readonly Readonly<AgenticWorkflowProfileV1>[] {
  const started = state.startedSubagentTypes ?? new Set<string>();
  return compiled.profiles.filter((profile) =>
    !state.completedSubagentTypes.has(profile.subagentType) &&
    !started.has(profile.subagentType) &&
    profile.dependsOnSubagentTypes.every((dependency) =>
      state.completedSubagentTypes.has(dependency)
    )
  );
}

/** Bind a fresh, isolated run identity to an immutable compiled descriptor. */
export function bindAgenticWorkflowRunV1(
  compiled: CompiledAgenticWorkflowV1,
  identity: AgenticWorkflowRunIdentityV1,
  signal?: AbortSignal,
): BoundAgenticWorkflowRunV1 {
  const normalized = Object.freeze({
    userId: boundedIdentifier(identity.userId, "User ID"),
    threadId: boundedIdentifier(identity.threadId, "Thread ID"),
    turnId: boundedIdentifier(identity.turnId, "Turn ID"),
    revision: positiveInteger(identity.revision, "Revision"),
    scopeFingerprint: boundedIdentifier(identity.scopeFingerprint, "Scope fingerprint"),
    providerCacheIdentity: boundedIdentifier(
      identity.providerCacheIdentity,
      "Provider cache identity",
    ),
  });
  return Object.freeze({
    compiled,
    identity: normalized,
    ...(signal ? { signal } : {}),
  });
}

/**
 * Compose the mandatory pre-provider control sequence for every bridged task.
 * The adapter invokes this hook only after static admission and before the
 * upstream DeepAgents task tool, so QuickJS cannot bypass any gate.
 */
export function createAgenticDispatchControlHookV1(
  gate: AgenticDispatchControlGateV1,
): (input: {
  taskId: string;
  admission: AgenticTaskAdmissionV1;
}) => Promise<void> {
  return async (input) => {
    await gate.authorize(input);
    await gate.requireHumanApproval?.(input);
    await gate.reserveBudget(input);
    await gate.journalStart(input);
  };
}

export function resolveAgenticCompletionObjectiveV1(input: {
  requested?: AgenticCompletionObjectiveV1;
  hasWorkflowGraph: boolean;
}): AgenticCompletionObjectiveV1 {
  const derived = input.hasWorkflowGraph
    ? "research-report"
    : "conversation-answer";
  if (input.requested && input.requested !== derived) {
    throw new Error(
      `Completion objective ${input.requested} is incompatible with this workflow shape.`,
    );
  }
  return input.requested ?? derived;
}
