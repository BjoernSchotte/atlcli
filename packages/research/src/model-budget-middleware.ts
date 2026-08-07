import { createMiddleware, type AgentMiddleware } from "langchain";
import {
  ResearchModelRunBudget,
  type ResearchModelBudgetCapacityV1,
  type ResearchModelBudgetStateV1,
} from "./budget.js";
import { ResearchContractError } from "./contracts.js";

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
  },
): AgentMiddleware {
  return createMiddleware({
    name: options.name,
    wrapModelCall: async (request, handler) => {
      const retained = typeof options.retain === "function"
        ? options.retain()
        : options.retain;
      const reservation = budget.reserve(request, options.maxOutputTokens, retained);
      await options.onSnapshot(budget.snapshot(), budget.state());
      let settled = false;
      try {
        const response = await handler(request);
        const snapshot = budget.settle(reservation, response);
        await options.onSnapshot(snapshot, budget.state());
        settled = true;
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
        }
        throw error;
      }
    },
  });
}
