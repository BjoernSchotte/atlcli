import {
  createResearchSessionV1,
  type ResearchSessionStoreV1,
  type ResearchWorkspace,
} from "@atlcli/research/browser";

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
      // A second fresh MV3 worker may win the create race for the same chat.
      if (!await input.store.read(input.sessionId)) throw error;
    }
  }
  return input.store.workspace(input.sessionId);
}
