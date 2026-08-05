import { describe, expect, test } from "bun:test";
import {
  DEFAULT_RESEARCH_LIMITS_V1,
  DEFAULT_RESEARCH_ONE_SHOT_POLICY_V1,
  type ResearchRequestV1,
} from "../contracts.js";
import { createResearchSessionV1 } from "../session.js";
import { initializeResearchSessionScopeClarificationWaitV1 } from "../session-runtime.js";
import { InMemoryResearchSessionStoreV1 } from "../session-store.js";
import {
  projectChatScopeClarificationReviewV1,
  resolveChatScopeClarificationV1,
} from "./scope-clarification.js";

const AT = "2026-08-05T10:00:00.000Z";
const request: ResearchRequestV1 = {
  schema: "atlcli.research-request/v1",
  question: "Summarize the account space.",
  scope: { siteOrigin: "https://tenant-a.atlassian.net", jiraProjectKeys: [], confluenceSpaceKeys: [] },
  limits: DEFAULT_RESEARCH_LIMITS_V1,
  wikiProvider: "rest",
};
const candidate = {
  schema: "atlcli.research-scope-candidate/v1" as const,
  id: "research-scope-candidate:space-1",
  tenantOrigin: request.scope.siteOrigin,
  product: "confluence" as const,
  entityKind: "space" as const,
  entityRef: "research-scope-entity:space-1",
  key: "SPACE",
  name: "Account space",
  accessible: true as const,
  providerFreshnessAt: AT,
};

describe("durable Chat scope clarification", () => {
  test("can be cancelled before a candidate is selected", async () => {
    const store = new InMemoryResearchSessionStoreV1();
    const waiting = await initializeResearchSessionScopeClarificationWaitV1({
      store,
      session: createResearchSessionV1({
        sessionId: "research-session:chat-clarification-cancel",
        ownerId: "owner:chat-clarification-cancel",
        createdAt: AT,
        leaseExpiresAt: "2026-08-05T10:10:00.000Z",
      }),
      request,
      policy: DEFAULT_RESEARCH_ONE_SHOT_POLICY_V1,
      purpose: "chat",
      clarification: {
        schema: "atlcli.research-clarification-required/v1",
        mentionId: "mention:space",
        reason: "not_found",
        candidateIds: [],
        rerunGuidance: ["Pass an exact space key."],
      },
      candidateChoices: [],
      at: AT,
    });
    const cancelled = (await store.commit(waiting.sessionId, {
      kind: "cancel",
      expectedRevision: waiting.revision,
      expectedLeaseEpoch: waiting.lease.epoch,
      at: "2026-08-05T10:00:01.000Z",
    })).session;
    expect(cancelled).toMatchObject({
      status: "cancelled",
      turns: [],
      scopeClarification: { purpose: "chat", state: "waiting_choice" },
    });
    const deletionRequested = (await store.commit(cancelled.sessionId, {
      kind: "request_deletion",
      expectedRevision: cancelled.revision,
      expectedLeaseEpoch: cancelled.lease.epoch,
      at: "2026-08-05T10:00:02.000Z",
    })).session;
    const deleted = (await store.commit(deletionRequested.sessionId, {
      kind: "delete",
      expectedRevision: deletionRequested.revision,
      expectedLeaseEpoch: deletionRequested.lease.epoch,
      at: "2026-08-05T10:00:03.000Z",
    })).session;
    expect(deleted).toMatchObject({
      status: "deleted",
      retention: { state: "deleted" },
      turns: [],
      scopeClarification: { purpose: "chat", state: "waiting_choice" },
    });
    expect(await store.eraseDeleted(deleted.sessionId)).toBe(true);
    expect(await store.read(deleted.sessionId)).toBeUndefined();
  });

  test("is revision fenced and resolves without creating a Research turn or graph", async () => {
    const store = new InMemoryResearchSessionStoreV1();
    const waiting = await initializeResearchSessionScopeClarificationWaitV1({
      store,
      session: createResearchSessionV1({
        sessionId: "research-session:chat-clarification",
        ownerId: "owner:chat-clarification",
        createdAt: AT,
        leaseExpiresAt: "2026-08-05T10:10:00.000Z",
      }),
      request,
      policy: DEFAULT_RESEARCH_ONE_SHOT_POLICY_V1,
      purpose: "chat",
      clarification: {
        schema: "atlcli.research-clarification-required/v1",
        mentionId: "mention:space",
        reason: "ambiguous",
        candidateIds: [candidate.id],
        rerunGuidance: ["Choose the intended space."],
      },
      candidateChoices: [candidate],
      at: AT,
    });
    expect(projectChatScopeClarificationReviewV1(waiting, request.scope.siteOrigin))
      .toMatchObject({ revision: waiting.revision, clarification: { candidates: [{ key: "SPACE" }] } });
    const selection = {
      schema: "atlcli.research-scope-candidate-selection/v1" as const,
      mentionId: "mention:space",
      candidateId: candidate.id,
    };
    await expect(resolveChatScopeClarificationV1({
      store,
      sessionId: waiting.sessionId,
      expectedRevision: waiting.revision - 1,
      expectedLeaseEpoch: waiting.lease.epoch,
      selection,
      resolvedRequest: request,
      at: AT,
    })).rejects.toThrow("stale");
    const resolved = await resolveChatScopeClarificationV1({
      store,
      sessionId: waiting.sessionId,
      expectedRevision: waiting.revision,
      expectedLeaseEpoch: waiting.lease.epoch,
      selection,
      resolvedRequest: {
        ...request,
        scope: { ...request.scope, confluenceSpaceKeys: ["SPACE"] },
      },
      at: AT,
    });
    expect(resolved.conversationSession.status).toBe("idle");
    expect(resolved.conversationSession.turns).toEqual([]);
    expect(resolved.conversationSession.scopeClarification?.resolvedRequest?.scope.confluenceSpaceKeys)
      .toEqual(["SPACE"]);
    const cancelled = (await store.commit(resolved.conversationSession.sessionId, {
      kind: "cancel",
      expectedRevision: resolved.conversationSession.revision,
      expectedLeaseEpoch: resolved.conversationSession.lease.epoch,
      at: "2026-08-05T10:00:01.000Z",
    })).session;
    const deletionRequested = (await store.commit(cancelled.sessionId, {
      kind: "request_deletion",
      expectedRevision: cancelled.revision,
      expectedLeaseEpoch: cancelled.lease.epoch,
      at: "2026-08-05T10:00:02.000Z",
    })).session;
    const deleted = (await store.commit(deletionRequested.sessionId, {
      kind: "delete",
      expectedRevision: deletionRequested.revision,
      expectedLeaseEpoch: deletionRequested.lease.epoch,
      at: "2026-08-05T10:00:03.000Z",
    })).session;
    expect(deleted).toMatchObject({
      status: "deleted",
      scopeClarification: { state: "choice_resolved" },
    });
  });
});
