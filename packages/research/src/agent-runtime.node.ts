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
import { createKiteweaveChatAgent } from "./chat-agent/runtime.js";
import { createAnthropicChatModelBindingV1 } from "./chat-agent/providers/anthropic.js";

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
const nodeChatRuntime = createKiteweaveChatAgent({
  StateBackend,
  createDeepAgent,
  registerHarnessProfile,
}, { defaultModelFactory: createAnthropicChatModelBindingV1 });
export const runChatAgent = nodeChatRuntime.runChatAgent;
export {
  RESEARCH_MODEL_ID,
  ResearchCheckpointReadyError,
  buildDynamicSupervisorPrompt,
  createResearchGraphProposalPtcTool,
  createResearchReconciliationDispositionPtcTool,
  researchRecursionLimitV1,
  createKiteweaveResearchAgent,
} from "./agent-runtime-core.js";
export { createKiteweaveChatAgent } from "./chat-agent/runtime.js";
export type {
  RunResearchAgentInput,
  ResearchAgentRuntimeBindings,
} from "./agent-runtime-core.js";
export type {
  ChatAgentRuntimeBindings,
  RunChatAgentInput,
} from "./chat-agent/runtime.js";
