import {
  StateBackend,
  createDeepAgent,
  createSubAgentMiddleware,
  registerHarnessProfile,
} from "deepagents/node";
import { createResearchAgentRuntime } from "./agent-runtime-core.js";

const nodeRuntime = createResearchAgentRuntime({
  StateBackend,
  createDeepAgent,
  createSubAgentMiddleware,
  registerHarnessProfile,
});

export const runResearchAgent = nodeRuntime.runResearchAgent;
export {
  RESEARCH_MODEL_ID,
  buildDynamicSupervisorPrompt,
  createResearchGraphProposalPtcTool,
  researchRecursionLimitV1,
} from "./agent-runtime-core.js";
export type {
  RunResearchAgentInput,
  ResearchAgentRuntimeBindings,
} from "./agent-runtime-core.js";
