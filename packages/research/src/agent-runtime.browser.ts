import {
  StateBackend,
  createDeepAgent,
  createSubAgentMiddleware,
  registerHarnessProfile,
} from "deepagents/browser";
import { createResearchAgentRuntime } from "./agent-runtime-core.js";

const browserRuntime = createResearchAgentRuntime({
  StateBackend,
  createDeepAgent,
  createSubAgentMiddleware,
  registerHarnessProfile,
});

export const runResearchAgent = browserRuntime.runResearchAgent;
export {
  RESEARCH_MODEL_ID,
  buildDynamicSupervisorPrompt,
  researchRecursionLimitV1,
} from "./agent-runtime-core.js";
export type {
  RunResearchAgentInput,
  ResearchAgentRuntimeBindings,
} from "./agent-runtime-core.js";
