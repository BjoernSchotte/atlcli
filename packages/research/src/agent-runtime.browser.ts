import {
  CompositeBackend,
  StateBackend,
  createDeepAgent,
  createFilesystemMiddleware,
  createSubAgentMiddleware,
  createSummarizationMiddleware,
  registerHarnessProfile,
} from "deepagents/browser";
import { createResearchAgentRuntime } from "./agent-runtime-core.js";

const browserRuntime = createResearchAgentRuntime({
  CompositeBackend,
  StateBackend,
  createDeepAgent,
  createFilesystemMiddleware,
  createSubAgentMiddleware,
  createSummarizationMiddleware,
  registerHarnessProfile,
});

export const runResearchAgent = browserRuntime.runResearchAgent;
export {
  RESEARCH_MODEL_ID,
  buildDynamicSupervisorPrompt,
  createResearchGraphProposalPtcTool,
  createResearchReconciliationDispositionPtcTool,
  researchRecursionLimitV1,
} from "./agent-runtime-core.js";
export type {
  RunResearchAgentInput,
  ResearchAgentRuntimeBindings,
} from "./agent-runtime-core.js";
