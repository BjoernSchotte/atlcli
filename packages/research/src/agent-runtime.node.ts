import {
  CompositeBackend,
  StateBackend,
  createDeepAgent,
  createFilesystemMiddleware,
  createSubAgentMiddleware,
  createSummarizationMiddleware,
  registerHarnessProfile,
} from "deepagents/node";
import { createResearchAgentRuntime } from "./agent-runtime-core.js";

const nodeRuntime = createResearchAgentRuntime({
  CompositeBackend,
  StateBackend,
  createDeepAgent,
  createFilesystemMiddleware,
  createSubAgentMiddleware,
  createSummarizationMiddleware,
  registerHarnessProfile,
});

export const runResearchAgent = nodeRuntime.runResearchAgent;
export {
  RESEARCH_MODEL_ID,
  ResearchCheckpointReadyError,
  buildDynamicSupervisorPrompt,
  createResearchGraphProposalPtcTool,
  createResearchReconciliationDispositionPtcTool,
  researchRecursionLimitV1,
} from "./agent-runtime-core.js";
export type {
  RunResearchAgentInput,
  ResearchAgentRuntimeBindings,
} from "./agent-runtime-core.js";
