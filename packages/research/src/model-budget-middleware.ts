import { createMiddleware, type AgentMiddleware } from "langchain";
import {
  ResearchModelRunBudget,
  observedResearchModelUsageV1,
  parseResearchModelObservedUsageV1,
  researchModelRequestBytesV1,
  type ResearchModelBudgetCapacityV1,
  type ResearchModelBudgetStateV1,
  type ResearchModelObservedUsageV1,
  type ResearchModelRequestBytesV1,
} from "./budget.js";
import { ResearchContractError } from "./contracts.js";

export type ResearchModelCallRoleV1 =
  | "root"
  | "subagent"
  | "recovery"
  | "summarization"
  | "research";

export interface ResearchModelCallObservationV1 {
  schema: "atlcli.research-model-call-observation/v1";
  sequence: number;
  role: ResearchModelCallRoleV1;
  status: "completed" | "failed";
  durationMs: number;
  middlewareName: string;
  modelName: string;
  modelId?: string;
  profileId?: string;
  phase?: string;
  wave?: number;
  attempt?: number;
  recoveryReason?: string;
  preference?: "fast" | "balanced" | "thorough";
  requestBytes: ResearchModelRequestBytesV1;
  reservation: {
    inputTokens: number;
    outputTokens: number;
  };
  observedUsage?: ResearchModelObservedUsageV1;
}

export interface ResearchModelCallObservationContextV1 {
  role: ResearchModelCallRoleV1;
  modelId?: string;
  profileId?: string;
  phase?: string;
  wave?: number;
  attempt?: number;
  recoveryReason?: string;
  preference?: "fast" | "balanced" | "thorough";
}

function safeDiagnosticLabel(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const normalized = value.trim();
  return /^[A-Za-z0-9._:-]{1,120}$/u.test(normalized) ? normalized : fallback;
}

function observationInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new ResearchContractError("invalid-request", `${label} is invalid.`);
  }
  return value as number;
}

export function parseResearchModelCallObservationV1(
  value: unknown,
): ResearchModelCallObservationV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ResearchContractError("invalid-request", "Research model call observation is invalid.");
  }
  const record = value as Record<string, unknown>;
  const allowed = new Set([
    "schema", "sequence", "role", "status", "durationMs", "middlewareName", "modelName",
    "modelId", "profileId", "phase", "wave", "attempt", "recoveryReason", "preference",
    "requestBytes", "reservation", "observedUsage",
  ]);
  const required = [
    "schema", "sequence", "role", "status", "durationMs", "middlewareName", "modelName",
    "requestBytes", "reservation",
  ];
  if (Object.keys(record).some((key) => !allowed.has(key)) ||
      required.some((key) => !(key in record)) ||
      record.schema !== "atlcli.research-model-call-observation/v1" ||
      !["root", "subagent", "recovery", "summarization", "research"].includes(String(record.role)) ||
      !["completed", "failed"].includes(String(record.status)) ||
      !isSafeObservationLabel(record.middlewareName) || !isSafeObservationLabel(record.modelName)) {
    throw new ResearchContractError("invalid-request", "Research model call observation is invalid.");
  }
  const optionalLabels = ["modelId", "profileId", "phase", "recoveryReason"] as const;
  for (const key of optionalLabels) {
    if (record[key] !== undefined && !isSafeObservationLabel(record[key])) {
      throw new ResearchContractError("invalid-request", "Research model call observation is invalid.");
    }
  }
  if (record.preference !== undefined &&
      !["fast", "balanced", "thorough"].includes(String(record.preference))) {
    throw new ResearchContractError("invalid-request", "Research model call observation is invalid.");
  }
  const requestBytes = record.requestBytes as Record<string, unknown>;
  const reservation = record.reservation as Record<string, unknown>;
  if (!requestBytes || typeof requestBytes !== "object" || Array.isArray(requestBytes) ||
      Object.keys(requestBytes).sort().join(",") !==
        "messageBytes,responseFormatBytes,systemBytes,toolBytes,totalBytes" ||
      !reservation || typeof reservation !== "object" || Array.isArray(reservation) ||
      Object.keys(reservation).sort().join(",") !== "inputTokens,outputTokens") {
    throw new ResearchContractError("invalid-request", "Research model call observation is invalid.");
  }
  return {
    schema: "atlcli.research-model-call-observation/v1",
    sequence: observationInteger(record.sequence, "Observation sequence"),
    role: record.role as ResearchModelCallRoleV1,
    status: record.status as ResearchModelCallObservationV1["status"],
    durationMs: observationInteger(record.durationMs, "Observation duration"),
    middlewareName: record.middlewareName as string,
    modelName: record.modelName as string,
    ...(record.modelId === undefined ? {} : { modelId: record.modelId as string }),
    ...(record.profileId === undefined ? {} : { profileId: record.profileId as string }),
    ...(record.phase === undefined ? {} : { phase: record.phase as string }),
    ...(record.wave === undefined ? {} : { wave: observationInteger(record.wave, "Observation wave") }),
    ...(record.attempt === undefined ? {} : { attempt: observationInteger(record.attempt, "Observation attempt") }),
    ...(record.recoveryReason === undefined ? {} : { recoveryReason: record.recoveryReason as string }),
    ...(record.preference === undefined
      ? {}
      : { preference: record.preference as ResearchModelCallObservationV1["preference"] }),
    requestBytes: {
      systemBytes: observationInteger(requestBytes.systemBytes, "Observation system bytes"),
      messageBytes: observationInteger(requestBytes.messageBytes, "Observation message bytes"),
      toolBytes: observationInteger(requestBytes.toolBytes, "Observation tool bytes"),
      responseFormatBytes: observationInteger(requestBytes.responseFormatBytes, "Observation response-format bytes"),
      totalBytes: observationInteger(requestBytes.totalBytes, "Observation total bytes"),
    },
    reservation: {
      inputTokens: observationInteger(reservation.inputTokens, "Observation reservation input tokens"),
      outputTokens: observationInteger(reservation.outputTokens, "Observation reservation output tokens"),
    },
    ...(record.observedUsage === undefined
      ? {}
      : { observedUsage: parseResearchModelObservedUsageV1(record.observedUsage) }),
  };
}

function isSafeObservationLabel(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9._:-]{1,120}$/u.test(value);
}

export async function deliverResearchModelCallObservationV1(
  observer: ((observation: ResearchModelCallObservationV1) => void | Promise<void>) | undefined,
  observation: ResearchModelCallObservationV1,
): Promise<void> {
  if (!observer) return;
  try {
    await observer(parseResearchModelCallObservationV1(observation));
  } catch {
    // Performance receipts are intentionally best-effort. They must never
    // change the authoritative provider result or retry policy.
  }
}

/**
 * One provider-neutral model-spend boundary shared by Chat and Deep Research.
 * Reservations happen before the provider call, so parallel children cannot
 * race past the root budget and an uncertain failed request remains charged.
 */
export function createResearchModelBudgetMiddlewareV1(
  budget: ResearchModelRunBudget,
  options: {
    name: string;
    maxOutputTokens: number;
    retain?: ResearchModelBudgetCapacityV1 | (() => ResearchModelBudgetCapacityV1 | undefined);
    onSnapshot: (
      snapshot: ReturnType<ResearchModelRunBudget["snapshot"]>,
      state: ResearchModelBudgetStateV1,
    ) => Promise<void>;
    observation?: ResearchModelCallObservationContextV1 | (() => ResearchModelCallObservationContextV1);
    onObservation?: (observation: ResearchModelCallObservationV1) => void | Promise<void>;
    now?: () => number;
  },
): AgentMiddleware {
  return createMiddleware({
    name: options.name,
    wrapModelCall: async (request, handler) => {
      const now = options.now ?? (() => performance.now());
      const startedAt = now();
      const requestBytes = researchModelRequestBytesV1(request);
      const retained = typeof options.retain === "function"
        ? options.retain()
        : options.retain;
      const reservation = budget.reserve(request, options.maxOutputTokens, retained);
      const sequence = budget.snapshot().calls;
      await options.onSnapshot(budget.snapshot(), budget.state());
      let settled = false;
      const observe = async (
        status: ResearchModelCallObservationV1["status"],
        response?: unknown,
      ): Promise<void> => {
        if (!options.observation || !options.onObservation) return;
        const modelName = safeDiagnosticLabel(
          request.model && typeof request.model === "object" && "getName" in request.model &&
              typeof request.model.getName === "function"
            ? request.model.getName()
            : undefined,
          "unknown-model",
        );
        const context = typeof options.observation === "function"
          ? options.observation()
          : options.observation;
        const observedUsage = response === undefined
          ? undefined
          : observedResearchModelUsageV1(response);
        const observation: ResearchModelCallObservationV1 = {
          schema: "atlcli.research-model-call-observation/v1",
          sequence,
          role: context.role,
          status,
          durationMs: Math.max(0, Math.round(now() - startedAt)),
          middlewareName: safeDiagnosticLabel(options.name, "model-budget"),
          modelName,
          ...(context.modelId
            ? { modelId: safeDiagnosticLabel(context.modelId, "unknown-model") }
            : {}),
          ...(context.profileId
            ? { profileId: safeDiagnosticLabel(context.profileId, "unknown-profile") }
            : {}),
          ...(context.phase ? { phase: safeDiagnosticLabel(context.phase, "unknown-phase") } : {}),
          ...(context.wave === undefined ? {} : { wave: context.wave }),
          ...(context.attempt === undefined ? {} : { attempt: context.attempt }),
          ...(context.recoveryReason
            ? { recoveryReason: safeDiagnosticLabel(context.recoveryReason, "unspecified") }
            : {}),
          ...(context.preference ? { preference: context.preference } : {}),
          requestBytes,
          reservation: {
            inputTokens: reservation.inputTokens,
            outputTokens: reservation.outputTokens,
          },
          ...(observedUsage
            ? { observedUsage }
            : {}),
        };
        await deliverResearchModelCallObservationV1(options.onObservation, observation);
      };
      try {
        const response = await handler(request);
        const snapshot = budget.settle(reservation, response);
        await options.onSnapshot(snapshot, budget.state());
        settled = true;
        await observe("completed", response);
        if (budget.exceedsLimits()) {
          throw new ResearchContractError(
            "limit-exceeded",
            "The model session budget was exhausted by the provider response.",
          );
        }
        return response;
      } catch (error) {
        // The provider may have received an unsuccessful request. Keeping its
        // reservation consumed prevents an uncertain call from becoming an
        // unbounded retry loop after a worker or network failure.
        if (!settled) {
          await options.onSnapshot(budget.snapshot(), budget.state());
          await observe("failed");
        }
        throw error;
      }
    },
  });
}
