import { createMiddleware, type AgentMiddleware } from "langchain";
import {
  ResearchModelRunBudget,
  observedResearchModelUsageV1,
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

export async function deliverResearchModelCallObservationV1(
  observer: ((observation: ResearchModelCallObservationV1) => void | Promise<void>) | undefined,
  observation: ResearchModelCallObservationV1,
): Promise<void> {
  if (!observer) return;
  try {
    await observer(observation);
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
