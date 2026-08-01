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
  | "concurrency-exceeded"
  | "capability-denied"
  | "result-too-large"
  | "structured-output-invalid"
  | "subagent-provider-error"
  | "aborted"
  | "late-result";

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

type InvocationOutcome =
  | { kind: "result"; value: unknown }
  | { kind: "error"; error: unknown };

export interface ResearchDispatchInterceptionAdapter {
  invoke(input: ResearchTaskToolInputV1, config?: RunnableConfig): Promise<unknown>;
  assertCapability(taskId: string, capabilityId: string): void;
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
  projectResult?: (value: unknown) => unknown;
  acceptResult?: (taskId: string, result: unknown, rawResult: unknown) => void;
  onDiagnostic?: (diagnostic: ResearchDispatchDiagnosticV1) => void;
}): ResearchDispatchInterceptionAdapter {
  if (options.maxTasks < 1) throw new Error("maxTasks must be at least 1.");
  if (options.maxConcurrency < 1) {
    throw new Error("maxConcurrency must be at least 1.");
  }

  const admissions = new Map<string, ResearchTaskAdmissionV1>();
  for (const admission of options.admissions) {
    if (admissions.has(admission.taskId)) {
      throw new Error(`Duplicate research task admission: ${admission.taskId}`);
    }
    admissions.set(admission.taskId, admission);
  }
  for (const admission of options.admissions) {
    if (admission.objective !== undefined && (!admission.objective.trim() || admission.objective.length > 4_000)) {
      throw new Error(`Invalid research task objective: ${admission.taskId}`);
    }
    const dependencies = admission.dependsOnTaskIds ?? [];
    if (new Set(dependencies).size !== dependencies.length ||
      dependencies.includes(admission.taskId) ||
      dependencies.some((taskId) => !admissions.has(taskId))) {
      throw new Error(`Invalid research task dependencies: ${admission.taskId}`);
    }
  }

  const taskStatuses = new Map<string, ResearchDispatchStatusV1>();
  const completedResults = new Map<string, unknown>();
  let dispatchedTasks = 0;
  let activeInvocations = 0;

  const emit = (diagnostic: ResearchDispatchDiagnosticV1): void => {
    if (diagnostic.taskId) {
      const current = taskStatuses.get(diagnostic.taskId);
      // A rejected duplicate or invalid transition is an observation, not a
      // state transition of the already accepted attempt. Preserve terminal
      // truth so dependency admission cannot be rolled back by a later call.
      if (diagnostic.status !== "rejected" || current === undefined) {
        taskStatuses.set(diagnostic.taskId, diagnostic.status);
      }
    }
    options.onDiagnostic?.(diagnostic);
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
    if (dispatchedTasks >= options.maxTasks) {
      reject(
        "task-budget-exceeded",
        `Research task budget exceeded (max=${options.maxTasks}).`,
        taskId,
      );
    }
    if (activeInvocations >= options.maxConcurrency) {
      reject(
        "concurrency-exceeded",
        `Research task concurrency exceeded (max=${options.maxConcurrency}).`,
        taskId,
      );
    }
    if (options.signal?.aborted || config.signal?.aborted) {
      reject("aborted", "Research task dispatch was aborted before admission.", taskId);
    }

    dispatchedTasks += 1;
    activeInvocations += 1;
    emit({ taskId, status: "started" });

    const controller = new AbortController();
    const abort = (): void => controller.abort(abortError());
    options.signal?.addEventListener("abort", abort, { once: true });
    config.signal?.addEventListener("abort", abort, { once: true });
    const timeout = setTimeout(abort, admission.maxDurationMs);
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
      emit({ taskId, status: "cancelled", code: "aborted" });
      void upstreamOutcome.then((late) => {
        emit({
          taskId,
          status: "quarantined",
          code: "late-result",
          ...(late.kind === "result"
            ? { resultBytes: serializedBytes(late.value) }
            : {}),
        });
      });
      throw abortError();
    }
    if (first.kind === "error") {
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
      emit({ taskId, status: "failed", code: "result-too-large", resultBytes });
      throw new ResearchDispatchError(
        "result-too-large",
        `Research task result exceeds ${admission.maxResultBytes} bytes (${resultBytes}).`,
      );
    }
    const projectedResult = options.projectResult ? options.projectResult(first.value) : first.value;
    try {
      options.acceptResult?.(taskId, projectedResult, first.value);
    } catch (error) {
      emit({ taskId, status: "failed" });
      throw error;
    }
    completedResults.set(taskId, structuredClone(projectedResult));
    emit({ taskId, status: "completed", resultBytes });
    return first.value;
  };

  return {
    invoke,
    assertCapability,
    snapshot: () => ({
      dispatchedTasks,
      activeInvocations,
      taskStatuses: Object.fromEntries(taskStatuses),
    }),
  };
}
