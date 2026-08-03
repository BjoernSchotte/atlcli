import {
  createResearchSessionV1,
} from "./session.js";
import type { ResearchSessionStoreV1 } from "./session-store.js";
import type { ResearchWorkspace } from "./workspace.js";

/**
 * Open the durable workspace that owns one ordinary chat conversation.
 *
 * Browser workers and CLI processes share this lifecycle contract so a fresh
 * host can restore the DeepAgentsJS checkpointer and summarization state.
 */
export async function openDurableChatConversationWorkspaceV1(input: {
  store: ResearchSessionStoreV1;
  sessionId: string;
  ownerId: string;
  createdAt: string;
  leaseExpiresAt: string;
}): Promise<ResearchWorkspace> {
  if (!await input.store.read(input.sessionId)) {
    try {
      await input.store.create(createResearchSessionV1({
        sessionId: input.sessionId,
        ownerId: input.ownerId,
        createdAt: input.createdAt,
        leaseExpiresAt: input.leaseExpiresAt,
      }));
    } catch (error) {
      // Two fresh hosts may race while restoring the same conversation.
      if (!await input.store.read(input.sessionId)) throw error;
    }
  }
  return input.store.workspace(input.sessionId);
}
