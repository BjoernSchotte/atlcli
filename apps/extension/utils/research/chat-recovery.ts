import {
  interruptChatTurnV1,
  type ChatSessionV1,
} from "@atlcli/research/browser";

/**
 * Release a Chat turn whose browser host disappeared before it could publish
 * its normal terminal state. The caller must first prove that no live host
 * owns the conversation; durable waiting checkpoints remain resumable.
 */
export function recoverUnownedRunningChatTurnV1(input: {
  session: ChatSessionV1;
  at: string;
}): ChatSessionV1 {
  const activeTurnId = input.session.operations.activeTurnId;
  if (!activeTurnId) return input.session;
  const activeTurn = input.session.conversation.recentTurns.find(
    (turn) => turn.id === activeTurnId,
  );
  if (activeTurn?.status !== "running") return input.session;
  return interruptChatTurnV1({
    session: input.session,
    expectedSessionRevision: input.session.revision,
    turnId: activeTurnId,
    status: "failed",
    at: input.at,
  });
}
