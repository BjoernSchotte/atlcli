import type { RunnableConfig } from "@langchain/core/runnables";

export const RESEARCH_TASK_DISPATCH_SCHEMA_V1 =
  "atlcli.research-task-dispatch/v1" as const;
export const RESEARCH_TASK_ID_CONFIG_KEY = "__atlcli_research_task_id";
export const RESEARCH_TASK_GRANTS_CONFIG_KEY =
  "__atlcli_research_task_granted_capability_ids";
export const DEEPAGENTS_RESPONSE_FORMAT_CONFIG_KEY =
  "__deepagents_subagent_response_format";

export interface ResearchTaskDescriptionV1 {
  schema: typeof RESEARCH_TASK_DISPATCH_SCHEMA_V1;
  taskId: string;
  objective: string;
  dependencyResults?: ResearchTaskDependencyResultV1[];
}

export interface ResearchTaskDependencyResultV1 {
  taskId: string;
  result: unknown;
}

export interface ResearchTaskAdmissionV1 {
  taskId: string;
  subagentType: string;
  objective?: string;
  dependsOnTaskIds?: readonly string[];
  grantedCapabilityIds: readonly string[];
  responseSchema: Record<string, unknown>;
  maxResultBytes: number;
  maxDurationMs: number;
}

export interface ResearchTaskToolInputV1 {
  description: string;
  subagent_type: string;
}

export type ResearchDispatchErrorCodeV1 =
  | "invalid-task-description"
  | "unknown-task"
  | "subagent-type-mismatch"
  | "response-schema-mismatch"
  | "task-budget-exceeded"
  | "task-already-dispatched"
  | "dependency-not-ready"
  | "dependency-result-mismatch"
  | "graph-proposal-required"
  | "repair-not-authorized"
  | "concurrency-exceeded"
  | "capability-denied"
  | "result-too-large"
  | "structured-output-invalid"
  | "subagent-provider-error"
  | "durable-journal-failed"
  | "aborted"
  | "timeout"
  | "late-result"
  | "admissions-locked";

export type ResearchDispatchStatusV1 =
  | "started"
  | "completed"
  | "failed"
  | "cancelled"
  | "quarantined"
  | "rejected";

export interface ResearchDispatchDiagnosticV1 {
  taskId?: string;
  status: ResearchDispatchStatusV1;
  code?: ResearchDispatchErrorCodeV1;
  resultBytes?: number;
}

export interface ResearchDispatchSnapshotV1 {
  dispatchedTasks: number;
  activeInvocations: number;
  taskStatuses: Readonly<Record<string, ResearchDispatchStatusV1>>;
}

export type ResearchUncommittedOutcomeReasonV1 =
  | "aborted"
  | "upstream-error"
  | "result-too-large"
  | "result-commit-failed";

export interface ResearchUncommittedDispatchOutcomeV1 {
  taskId: string;
  admission: ResearchTaskAdmissionV1;
  reason: ResearchUncommittedOutcomeReasonV1;
  error?: unknown;
  resultBytes?: number;
}

export class ResearchDispatchError extends Error {
  readonly code: ResearchDispatchErrorCodeV1;

  constructor(code: ResearchDispatchErrorCodeV1, message: string) {
    super(message);
    this.name = "ResearchDispatchError";
    this.code = code;
  }
}

export function encodeResearchTaskDescriptionV1(
  value: Omit<ResearchTaskDescriptionV1, "schema">,
): string {
  return JSON.stringify({
    schema: RESEARCH_TASK_DISPATCH_SCHEMA_V1,
    taskId: value.taskId,
    objective: value.objective,
    ...(value.dependencyResults?.length
      ? { dependencyResults: value.dependencyResults }
      : {}),
  } satisfies ResearchTaskDescriptionV1);
}

function parseResearchTaskDescriptionV1(value: string): ResearchTaskDescriptionV1 {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new ResearchDispatchError(
      "invalid-task-description",
      "Research task description is not a valid host-issued envelope.",
    );
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    (parsed as { schema?: unknown }).schema !== RESEARCH_TASK_DISPATCH_SCHEMA_V1 ||
    typeof (parsed as { taskId?: unknown }).taskId !== "string" ||
    !(parsed as { taskId: string }).taskId ||
    typeof (parsed as { objective?: unknown }).objective !== "string" ||
    !(parsed as { objective: string }).objective
  ) {
    throw new ResearchDispatchError(
      "invalid-task-description",
      "Research task description is not a valid host-issued envelope.",
    );
  }
  const record = parsed as Record<string, unknown>;
  if (Object.keys(record).some((key) =>
    !["schema", "taskId", "objective", "dependencyResults"].includes(key)
  )) {
    throw new ResearchDispatchError(
      "invalid-task-description",
      "Research task description contains fields outside the host-issued envelope.",
    );
  }
  if ((record.objective as string).length > 4_000) {
    throw new ResearchDispatchError(
      "invalid-task-description",
      "Research task objective exceeds its host-owned limit.",
    );
  }
  if (record.dependencyResults !== undefined) {
    if (!Array.isArray(record.dependencyResults) || record.dependencyResults.length > 8) {
      throw new ResearchDispatchError(
        "invalid-task-description",
        "Research task dependency results are invalid.",
      );
    }
    const ids = new Set<string>();
    for (const dependency of record.dependencyResults) {
      if (!dependency || typeof dependency !== "object" || Array.isArray(dependency)) {
        throw new ResearchDispatchError("invalid-task-description", "Research task dependency result is invalid.");
      }
      const entry = dependency as Record<string, unknown>;
      if (Object.keys(entry).some((key) => key !== "taskId" && key !== "result") ||
        typeof entry.taskId !== "string" || !entry.taskId || !("result" in entry) || ids.has(entry.taskId)) {
        throw new ResearchDispatchError("invalid-task-description", "Research task dependency result is invalid.");
      }
      ids.add(entry.taskId);
    }
  }
  return parsed as ResearchTaskDescriptionV1;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => `${JSON.stringify(key)}:${canonicalJson(nested)}`)
      .join(",")}}`;
  }
  const serialized = JSON.stringify(value);
  return serialized === undefined ? "null" : serialized;
}

function serializedBytes(value: unknown): number {
  const serialized = JSON.stringify(value);
  return new TextEncoder().encode(serialized === undefined ? "null" : serialized)
    .byteLength;
}

function abortError(): ResearchDispatchError {
  return new ResearchDispatchError("aborted", "Research task dispatch was aborted.");
}

function timeoutError(maxDurationMs: number): ResearchDispatchError {
  return new ResearchDispatchError(
    "timeout",
    `Research task dispatch timed out after ${maxDurationMs} ms.`,
  );
}

type InvocationOutcome =
  | { kind: "result"; value: unknown }
  | { kind: "error"; error: unknown };

export interface ResearchDispatchInterceptionAdapter {
  invoke(input: ResearchTaskToolInputV1, config?: RunnableConfig): Promise<unknown>;
  assertCapability(taskId: string, capabilityId: string): void;
  replaceAdmissions(admissions: readonly ResearchTaskAdmissionV1[]): void;
  /**
   * Restore host-validated terminal dependency projections before a resumed
   * worker may admit a later frontier. This accepts projections only for
   * already admitted tasks and never invokes a provider or emits a new task
   * lifecycle event.
   */
  restoreCompleted(results: readonly ResearchTaskDependencyResultV1[]): void;
  /**
   * Add one future wave at a host-owned checkpoint. Existing admissions and
   * every observed task status stay immutable.
   */
  appendAdmissions(admissions: readonly ResearchTaskAdmissionV1[]): void;
  snapshot(): ResearchDispatchSnapshotV1;
}

/**
 * Host-owned interception boundary around DeepAgentsJS' public `task` tool.
 * The upstream tool still performs declarative subagent compilation with the
 * dynamic response schema; this adapter admits the dispatch before that model
 * call can begin and accepts or quarantines its result afterwards.
 */
export function createResearchDispatchInterceptionAdapter(options: {
  admissions: readonly ResearchTaskAdmissionV1[];
  maxTasks: number;
  maxConcurrency: number;
  signal?: AbortSignal;
  invokeUpstream(
    input: ResearchTaskToolInputV1,
    config: RunnableConfig,
  ): Promise<unknown>;
  /**
   * Host-only reduction between the untrusted provider result and durable
   * acceptance. It may perform asynchronous evidence/claim normalization;
   * the raw value is never published if this reduction fails.
   */
  projectResult?: (value: unknown, input: {
    taskId: string;
    admission: ResearchTaskAdmissionV1;
  }) => unknown | Promise<unknown>;
  /**
   * Host-owned projection returned to QuickJS and dependent tasks after packet
   * acceptance. The authoritative accepted packet may retain more structured
   * data, but child trajectories must never become downstream prompt context.
   */
  projectDependencyResult?: (taskId: string, acceptedResult: unknown) => unknown | undefined;
  /** Runs after static admission but before any upstream provider/model call. */
  beforeInvoke?: (input: {
    taskId: string;
    admission: ResearchTaskAdmissionV1;
  }) => void | Promise<void>;
  /** Durable hosts persist the result before the local dependency projection is published. */
  acceptResult?: (taskId: string, result: unknown, rawResult: unknown) => void | Promise<void>;
  /** Records a started provider invocation whose terminal packet was not committed. */
  onUncommittedOutcome?: (
    outcome: ResearchUncommittedDispatchOutcomeV1,
  ) => void | Promise<void>;
  /** Receives an observed result after a local timeout/abort for quarantine. */
  onLateResult?: (input: {
    taskId: string;
    admission: ResearchTaskAdmissionV1;
    resultBytes?: number;
  }) => void | Promise<void>;
  onDiagnostic?: (diagnostic: ResearchDispatchDiagnosticV1) => void;
}): ResearchDispatchInterceptionAdapter {
  if (options.maxTasks < 1) throw new Error("maxTasks must be at least 1.");
  if (options.maxConcurrency < 1) {
    throw new Error("maxConcurrency must be at least 1.");
  }

  const validatedAdmissions = (
    values: readonly ResearchTaskAdmissionV1[],
  ): Map<string, ResearchTaskAdmissionV1> => {
    const next = new Map<string, ResearchTaskAdmissionV1>();
    for (const admission of values) {
      if (next.has(admission.taskId)) {
        throw new Error(`Duplicate research task admission: ${admission.taskId}`);
      }
      next.set(admission.taskId, admission);
    }
    for (const admission of values) {
      if (admission.objective !== undefined && (!admission.objective.trim() || admission.objective.length > 4_000)) {
        throw new Error(`Invalid research task objective: ${admission.taskId}`);
      }
      const dependencies = admission.dependsOnTaskIds ?? [];
      if (new Set(dependencies).size !== dependencies.length ||
        dependencies.includes(admission.taskId) ||
        dependencies.some((taskId) => !next.has(taskId))) {
        throw new Error(`Invalid research task dependencies: ${admission.taskId}`);
      }
    }
    return next;
  };
  let admissions = validatedAdmissions(options.admissions);

  const taskStatuses = new Map<string, ResearchDispatchStatusV1>();
  const completedResults = new Map<string, unknown>();
  let dispatchedTasks = 0;
  let activeInvocations = 0;
  let pendingAdmissions = 0;
  let observedStatus = false;

  const emit = (diagnostic: ResearchDispatchDiagnosticV1): void => {
    observedStatus = true;
    if (diagnostic.taskId) {
      const current = taskStatuses.get(diagnostic.taskId);
      // A rejected duplicate or invalid transition is an observation, not a
      // state transition of the already accepted attempt. Preserve terminal
      // truth so dependency admission cannot be rolled back by a later call.
      if (diagnostic.status !== "rejected" || current === undefined) {
        taskStatuses.set(diagnostic.taskId, diagnostic.status);
      }
    }
    // Diagnostics are an observer-only stream. In particular, a consumer
    // disconnecting after a durable packet commit must not make the adapter
    // report that packet as an uncommitted provider outcome.
    try {
      options.onDiagnostic?.(diagnostic);
    } catch {
      // The authoritative dispatch state was updated above; recovery reads it
      // from the durable session rather than relying on this best-effort event.
    }
  };

  const replaceAdmissions = (
    nextAdmissions: readonly ResearchTaskAdmissionV1[],
  ): void => {
    if (observedStatus || dispatchedTasks > 0 || activeInvocations > 0 || pendingAdmissions > 0) {
      throw new ResearchDispatchError(
        "admissions-locked",
        "Research task admissions are immutable after dispatch observation begins.",
      );
    }
    admissions = validatedAdmissions(nextAdmissions);
  };

  const appendAdmissions = (
    nextAdmissions: readonly ResearchTaskAdmissionV1[],
  ): void => {
    if (nextAdmissions.length === 0) {
      throw new ResearchDispatchError(
        "admissions-locked",
        "Research task admission append must contain at least one new task.",
      );
    }
    if (activeInvocations > 0 || pendingAdmissions > 0 ||
        [...taskStatuses.values()].some((status) => status === "started")) {
      throw new ResearchDispatchError(
        "admissions-locked",
        "Research task admissions can be appended only at a settled wave checkpoint.",
      );
    }
    if (nextAdmissions.some((admission) => admissions.has(admission.taskId))) {
      throw new ResearchDispatchError(
        "admissions-locked",
        "Research task admission append cannot replace a prior task.",
      );
    }
    admissions = validatedAdmissions([
      ...admissions.values(),
      ...nextAdmissions,
    ]);
  };

  const restoreCompleted = (
    results: readonly ResearchTaskDependencyResultV1[],
  ): void => {
    if (observedStatus || dispatchedTasks > 0 || activeInvocations > 0 || pendingAdmissions > 0) {
      throw new ResearchDispatchError(
        "admissions-locked",
        "Research dependency hydration must precede local dispatch observation.",
      );
    }
    if (results.length === 0) return;
    if (results.length > options.maxTasks) {
      throw new ResearchDispatchError(
        "task-budget-exceeded",
        "Research dependency hydration exceeds the admitted task budget.",
      );
    }
    const restoredTaskIds = new Set<string>();
    for (const result of results) {
      if (!result || typeof result.taskId !== "string" || !result.taskId ||
          !admissions.has(result.taskId) || restoredTaskIds.has(result.taskId)) {
        throw new ResearchDispatchError(
          "unknown-task",
          "Research dependency hydration is not an admitted unique task.",
        );
      }
      restoredTaskIds.add(result.taskId);
    }
    for (const result of results) {
      completedResults.set(result.taskId, structuredClone(result.result));
      taskStatuses.set(result.taskId, "completed");
    }
    dispatchedTasks += results.length;
    // A recovered result is a durable terminal observation. Replacing the
    // admission set afterwards could silently remove a dependency while its
    // projection remains reachable.
    observedStatus = true;
  };

  const reject = (
    code: ResearchDispatchErrorCodeV1,
    message: string,
    taskId?: string,
  ): never => {
    emit({ ...(taskId ? { taskId } : {}), status: "rejected", code });
    throw new ResearchDispatchError(code, message);
  };

  const assertCapability = (taskId: string, capabilityId: string): void => {
    const admission = admissions.get(taskId) ?? reject(
      "unknown-task",
      `Research task is not active: ${taskId}`,
      taskId,
    );
    if (taskStatuses.get(taskId) !== "started") {
      reject("unknown-task", `Research task is not active: ${taskId}`, taskId);
    }
    if (!admission.grantedCapabilityIds.includes(capabilityId)) {
      throw new ResearchDispatchError(
        "capability-denied",
        `Capability ${capabilityId} is not granted to research task ${taskId}.`,
      );
    }
  };

  const invoke = async (
    input: ResearchTaskToolInputV1,
    config: RunnableConfig = {},
  ): Promise<unknown> => {
    let description: ResearchTaskDescriptionV1;
    try {
      description = parseResearchTaskDescriptionV1(input.description);
    } catch (error) {
      if (error instanceof ResearchDispatchError) {
        reject(error.code, error.message);
      }
      throw error;
    }
    const { taskId } = description;
    const admission = admissions.get(taskId) ?? reject(
      "unknown-task",
      `Research task is not admitted: ${taskId}`,
      taskId,
    );
    if (admission.objective !== undefined && description.objective !== admission.objective) {
      reject(
        "invalid-task-description",
        `Research task ${taskId} objective does not match its admitted graph node.`,
        taskId,
      );
    }
    const expectedDependencies = [...(admission.dependsOnTaskIds ?? [])];
    const suppliedDependencies = description.dependencyResults ?? [];
    if (expectedDependencies.some((dependencyTaskId) => taskStatuses.get(dependencyTaskId) !== "completed")) {
      reject(
        "dependency-not-ready",
        `Research task ${taskId} has an incomplete dependency.`,
        taskId,
      );
    }
    if (suppliedDependencies.length !== expectedDependencies.length ||
      suppliedDependencies.some((dependency) => !expectedDependencies.includes(dependency.taskId))) {
      reject(
        "dependency-result-mismatch",
        `Research task ${taskId} did not supply the exact admitted dependency set.`,
        taskId,
      );
    }
    for (const dependency of suppliedDependencies) {
      if (canonicalJson(dependency.result) !== canonicalJson(completedResults.get(dependency.taskId))) {
        reject(
          "dependency-result-mismatch",
          `Research task ${taskId} supplied a modified dependency result.`,
          taskId,
        );
      }
    }
    if (input.subagent_type !== admission.subagentType) {
      reject(
        "subagent-type-mismatch",
        `Research task ${taskId} cannot use subagent ${input.subagent_type}.`,
        taskId,
      );
    }
    const requestedSchema = config.configurable?.[
      DEEPAGENTS_RESPONSE_FORMAT_CONFIG_KEY
    ];
    if (canonicalJson(requestedSchema) !== canonicalJson(admission.responseSchema)) {
      reject(
        "response-schema-mismatch",
        `Research task ${taskId} did not request its admitted response schema.`,
        taskId,
      );
    }
    if (taskStatuses.has(taskId)) {
      reject(
        "task-already-dispatched",
        `Research task was already dispatched: ${taskId}`,
        taskId,
      );
    }
    if (dispatchedTasks + pendingAdmissions >= options.maxTasks) {
      reject(
        "task-budget-exceeded",
        `Research task budget exceeded (max=${options.maxTasks}).`,
        taskId,
      );
    }
    if (activeInvocations + pendingAdmissions >= options.maxConcurrency) {
      reject(
        "concurrency-exceeded",
        `Research task concurrency exceeded (max=${options.maxConcurrency}).`,
        taskId,
      );
    }
    if (options.signal?.aborted || config.signal?.aborted) {
      reject("aborted", "Research task dispatch was aborted before admission.", taskId);
    }

    pendingAdmissions += 1;
    try {
      await options.beforeInvoke?.({ taskId, admission });
    } catch (error) {
      pendingAdmissions -= 1;
      emit({ taskId, status: "failed", code: "durable-journal-failed" });
      throw error;
    }
    pendingAdmissions -= 1;

    dispatchedTasks += 1;
    activeInvocations += 1;
    emit({ taskId, status: "started" });

    const observeUncommitted = async (
      reason: ResearchUncommittedOutcomeReasonV1,
      input: { error?: unknown; resultBytes?: number } = {},
    ): Promise<void> => {
      await options.onUncommittedOutcome?.({
        taskId,
        admission,
        reason,
        ...input,
      });
    };

    const controller = new AbortController();
    let abortCode: "aborted" | "timeout" | undefined;
    const abortWith = (code: "aborted" | "timeout"): void => {
      if (controller.signal.aborted) return;
      abortCode = code;
      controller.abort(
        code === "timeout" ? timeoutError(admission.maxDurationMs) : abortError(),
      );
    };
    const abort = (): void => abortWith("aborted");
    options.signal?.addEventListener("abort", abort, { once: true });
    config.signal?.addEventListener("abort", abort, { once: true });
    const timeout = setTimeout(() => abortWith("timeout"), admission.maxDurationMs);
    const upstreamConfig: RunnableConfig = {
      ...config,
      signal: controller.signal,
      configurable: {
        ...config.configurable,
        [DEEPAGENTS_RESPONSE_FORMAT_CONFIG_KEY]: admission.responseSchema,
        [RESEARCH_TASK_ID_CONFIG_KEY]: taskId,
        [RESEARCH_TASK_GRANTS_CONFIG_KEY]: [...admission.grantedCapabilityIds],
      },
    };

    const upstreamOutcome: Promise<InvocationOutcome> = Promise.resolve()
      .then(() => options.invokeUpstream(input, upstreamConfig))
      .then(
        (value): InvocationOutcome => ({ kind: "result", value }),
        (error): InvocationOutcome => ({ kind: "error", error }),
      )
      .then((outcome) => {
        activeInvocations -= 1;
        return outcome;
      });
    const aborted = new Promise<{ kind: "aborted" }>((resolve) => {
      if (controller.signal.aborted) {
        resolve({ kind: "aborted" });
        return;
      }
      controller.signal.addEventListener(
        "abort",
        () => resolve({ kind: "aborted" }),
        { once: true },
      );
    });

    const first = await Promise.race([upstreamOutcome, aborted]);
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", abort);
    config.signal?.removeEventListener("abort", abort);

    if (first.kind === "aborted") {
      const code = abortCode ?? "aborted";
      await observeUncommitted("aborted");
      emit({ taskId, status: "cancelled", code });
      void upstreamOutcome.then(async (late) => {
        try {
          await options.onLateResult?.({
            taskId,
            admission,
            ...(late.kind === "result" ? { resultBytes: serializedBytes(late.value) } : {}),
          });
        } catch {
          // The authoritative task remains outcome_unknown if the later
          // quarantine cannot be recorded. Never surface this detached
          // callback as an unhandled rejection or publish the late result.
          return;
        }
        emit({
          taskId,
          status: "quarantined",
          code: "late-result",
          ...(late.kind === "result"
            ? { resultBytes: serializedBytes(late.value) }
            : {}),
        });
      });
      throw code === "timeout" ? timeoutError(admission.maxDurationMs) : abortError();
    }
    if (first.kind === "error") {
      await observeUncommitted("upstream-error", { error: first.error });
      emit({
        taskId,
        status: "failed",
        code: first.error instanceof ResearchDispatchError
          ? first.error.code
          : "subagent-provider-error",
      });
      throw first.error;
    }
    const resultBytes = serializedBytes(first.value);
    if (resultBytes > admission.maxResultBytes) {
      await observeUncommitted("result-too-large", { resultBytes });
      emit({ taskId, status: "failed", code: "result-too-large", resultBytes });
      throw new ResearchDispatchError(
        "result-too-large",
        `Research task result exceeds ${admission.maxResultBytes} bytes (${resultBytes}).`,
      );
    }
    try {
      const projectedResult = options.projectResult
        ? await options.projectResult(first.value, { taskId, admission })
        : first.value;
      // Project the only result shape that a later task may receive before the
      // durable packet commit. If this deterministic host projection cannot be
      // produced, the provider result has not yet become authoritative and the
      // uncommitted-outcome path below remains valid. Performing it after the
      // packet commit would incorrectly try to reclassify a completed durable
      // task as an unknown provider outcome on a local projection failure.
      const projectedDependency = options.projectDependencyResult?.(taskId, projectedResult);
      const dependencyResult = projectedDependency === undefined ? first.value : projectedDependency;
      await options.acceptResult?.(taskId, projectedResult, first.value);
      completedResults.set(taskId, structuredClone(dependencyResult));
      emit({ taskId, status: "completed", resultBytes });
      return dependencyResult;
    } catch (error) {
      await observeUncommitted("result-commit-failed", { error });
      emit({ taskId, status: "failed" });
      throw error;
    }
  };

  return {
    invoke,
    assertCapability,
    replaceAdmissions,
    appendAdmissions,
    restoreCompleted,
    snapshot: () => ({
      dispatchedTasks,
      activeInvocations,
      taskStatuses: Object.fromEntries(taskStatuses),
    }),
  };
}
