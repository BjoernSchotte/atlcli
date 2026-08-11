import { describe, expect, test } from "bun:test";
import {
  beginChatTurnV1,
  createChatSessionV1,
  pauseChatTurnV1,
} from "@atlcli/research/browser";
import { recoverUnownedRunningChatTurnV1 } from "../utils/research/chat-recovery.js";

const STARTED_AT = "2026-08-10T18:00:00.000Z";
const RECOVERED_AT = "2026-08-10T18:01:00.000Z";

function runningSession() {
  const initial = createChatSessionV1({
    conversationId: "research-session:local-recovery",
    identity: {
      userId: "browser-principal:00000000-0000-4000-8000-000000000001",
      providerCacheIdentity: "browser-model:local-gemma:principal",
    },
    tenantOrigin: "https://example.atlassian.net",
    createdAt: STARTED_AT,
  });
  return beginChatTurnV1({
    session: initial,
    expectedSessionRevision: initial.revision,
    turnId: "research-turn:orphaned",
    objective: "Summarize the active page.",
    qualityMode: "quick",
    scopeFingerprint: "scope-fingerprint",
    startedAt: STARTED_AT,
  });
}

describe("unowned browser Chat recovery", () => {
  test("terminalizes a running turn so the retained conversation accepts a follow-up", () => {
    const recovered = recoverUnownedRunningChatTurnV1({
      session: runningSession(),
      at: RECOVERED_AT,
    });

    expect(recovered.operations.activeTurnId).toBeUndefined();
    expect(recovered.conversation.recentTurns.at(-1)).toMatchObject({
      id: "research-turn:orphaned",
      status: "failed",
      completedAt: RECOVERED_AT,
    });
    expect(() => beginChatTurnV1({
      session: recovered,
      expectedSessionRevision: recovered.revision,
      turnId: "research-turn:retry",
      objective: "Retry the summary.",
      qualityMode: "quick",
      scopeFingerprint: "scope-fingerprint",
      startedAt: RECOVERED_AT,
    })).not.toThrow();
  });

  test("preserves a durable waiting checkpoint", () => {
    const running = runningSession();
    const waiting = pauseChatTurnV1({
      session: running,
      expectedSessionRevision: running.revision,
      turnId: "research-turn:orphaned",
      reason: "stream-interruption",
      at: RECOVERED_AT,
    });

    expect(recoverUnownedRunningChatTurnV1({
      session: waiting,
      at: RECOVERED_AT,
    })).toBe(waiting);
  });
});
