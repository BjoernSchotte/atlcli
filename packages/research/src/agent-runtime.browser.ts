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
import { createKiteweaveChatAgent } from "./chat-agent/runtime.js";
import { createAnthropicChatModelBindingV1 } from "./chat-agent/providers/anthropic.js";

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
const browserChatRuntime = createKiteweaveChatAgent({
  StateBackend,
  createDeepAgent,
  createSubAgentMiddleware,
  createSummarizationMiddleware,
  registerHarnessProfile,
}, { defaultModelFactory: createAnthropicChatModelBindingV1 });
export const runChatAgent = browserChatRuntime.runChatAgent;
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
