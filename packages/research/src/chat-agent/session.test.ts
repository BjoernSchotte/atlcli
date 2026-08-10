import { describe, expect, test } from "bun:test";
import {
  createResearchEvidenceRecordV1,
  type ResearchEvidenceRecordV1,
} from "../evidence-store.js";
import type { ResearchScopeBindingV1, ResearchScopeV1 } from "../contracts.js";
import { chatQualityPolicyV1 } from "../quality-policy.js";
import type { ChatAnswerV1, ChatStrategyV1 } from "./contracts.js";
import {
  assertChatSessionBindingV1,
  advanceChatControlFenceV1,
  beginChatTurnV1,
  buildChatTurnContextV1,
  chatScopeFingerprintV1,
  completeChatTurnV1,
  createChatSessionV1,
  parseChatSessionV1,
  pauseChatTurnV1,
  renderChatTurnContextV1,
  resumeChatTurnV1,
} from "./session.js";

const TENANT = "https://example.atlassian.net";
const IDENTITY = {
  userId: "principal:test-user",
  providerCacheIdentity: "provider-cache:test-user:anthropic",
} as const;

const STRATEGY: ChatStrategyV1 = {
  qualityMode: "auto",
  path: "direct",
  delegated: false,
  reasonCode: "auto-direct",
  reasonCodes: ["single-exact-context"],
  ambiguityDisposition: "none",
  requiredCapabilities: ["exact-read"],
  expectedComplexity: "simple",
  qualityRisks: [],
};

function answer(input: {
  message?: string;
  sourceId?: string;
  evidence?: boolean;
} = {}): ChatAnswerV1 {
  const sourceId = input.sourceId ?? "wiki:1001";
  const evidence = input.evidence === true;
  return {
    schema: "atlcli.chat-answer/v1",
    messageMarkdown: input.message ?? "A bounded conversational answer.",
    citations: evidence
      ? [{
          sourceId,
          title: "Synthetic page",
          url: `${TENANT}/wiki/spaces/DEMO/pages/1001`,
          product: "confluence",
        }]
      : [],
    evidenceRefs: evidence ? [sourceId] : [],
    gaps: [],
    strategy: STRATEGY,
    run: {
      model: "synthetic-model",
      startedAt: "2026-08-06T08:00:00.000Z",
      completedAt: "2026-08-06T08:00:01.000Z",
      durationMs: 1_000,
      counts: {
        ptcCalls: 0,
        httpCalls: 0,
        jiraItems: 0,
        confluenceItems: 0,
      },
    },
  };
}

function session() {
  return createChatSessionV1({
    conversationId: "research-session:chat-memory",
    identity: IDENTITY,
    tenantOrigin: TENANT,
    createdAt: "2026-08-06T08:00:00.000Z",
  });
}

function scope(spaceKey: string): ResearchScopeV1 {
  return {
    siteOrigin: TENANT,
    jiraProjectKeys: [],
    confluenceSpaceKeys: [spaceKey],
  };
}

function binding(spaceKey: string): ResearchScopeBindingV1 {
  return {
    schema: "atlcli.research-scope-binding/v1",
    id: `scope-binding:space-${spaceKey}`,
    tenantOrigin: TENANT,
    product: "confluence",
    entityKind: "space",
    entityRef: `research-scope-entity:space-${spaceKey}`,
    key: spaceKey,
    name: `${spaceKey} space`,
    source: "cli_flag",
    authority: "locked",
  };
}

async function evidenceRecord(
  spaceKey = "DEMO",
  text = "Only synthetic evidence is retained.",
  capturedAt = "2026-08-06T08:00:00.000Z",
  updatedAt = "2026-08-06T07:00:00.000Z",
): Promise<ResearchEvidenceRecordV1> {
  return (await createResearchEvidenceRecordV1({
    source: {
      id: "wiki:1001",
      product: "confluence",
      title: "Synthetic page",
      url: `${TENANT}/wiki/spaces/${spaceKey}/pages/1001`,
      contentId: "1001",
      spaceKey,
      updatedAt,
    },
    content: {
      text,
      linkTargets: [],
      truncated: false,
      inputBytes: new TextEncoder().encode(text).byteLength,
    },
    scope: scope(spaceKey),
    scopeBindings: [binding(spaceKey)],
    capturedAt,
    retrieval: {
      sourceId: "wiki:1001",
      reason: "exact_anchor",
      rank: 1,
    },
  })).record;
}

describe("durable Chat session state", () => {
  test("keeps conversation, operations, and evidence as separate state classes", async () => {
    const fingerprint = await chatScopeFingerprintV1({
      scope: scope("DEMO"),
      scopeBindings: [binding("DEMO")],
    });
    const initial = session();
    const running = beginChatTurnV1({
      session: initial,
      expectedSessionRevision: initial.revision,
      turnId: "research-turn:first",
      objective: "Summarize the synthetic page.",
      qualityMode: chatQualityPolicyV1("auto").mode,
      scopeFingerprint: fingerprint,
      startedAt: "2026-08-06T08:00:00.000Z",
    });
    const complete = completeChatTurnV1({
      session: running,
      expectedSessionRevision: running.revision,
      turnId: "research-turn:first",
      answer: answer({ evidence: true }),
      acceptedStrategy: STRATEGY,
      activityRefs: ["activity:direct-read", "activity:synthesis"],
      evidenceRecords: [await evidenceRecord()],
      completedAt: "2026-08-06T08:00:01.000Z",
    });
    const restored = parseChatSessionV1(JSON.parse(JSON.stringify(complete)));

    expect(complete.conversation.schema).toBe("atlcli.chat-conversation-memory/v1");
    expect(complete.operations).toMatchObject({
      schema: "atlcli.chat-operational-memory/v1",
      lastCompletedTurnId: "research-turn:first",
    });
    expect(complete.evidence.entries).toHaveLength(1);
    expect(complete.evidence.entries[0]).toMatchObject({
      tenantOrigin: TENANT,
      canonicalId: `${TENANT}|confluence|page|1001`,
      sourceId: "wiki:1001",
      authorityBindingId: "scope-binding:space-DEMO",
      contentHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      supportingClaimRefs: [
        "chat-claim:research-turn:first:000",
        "chat-source:wiki:1001",
      ],
    });
    expect(restored).toEqual(complete);
  });

  test("fails closed across user, thread, tenant, and provider-cache partitions", () => {
    const retained = session();
    expect(() => assertChatSessionBindingV1({
      session: retained,
      conversationId: retained.conversationId,
      identity: { ...IDENTITY, userId: "principal:attacker" },
      tenantOrigin: TENANT,
    })).toThrow("different user, thread, tenant, or provider-cache partition");
    expect(() => assertChatSessionBindingV1({
      session: retained,
      conversationId: retained.conversationId,
      identity: {
        ...IDENTITY,
        providerCacheIdentity: "provider-cache:foreign",
      },
      tenantOrigin: TENANT,
    })).toThrow("different user, thread, tenant, or provider-cache partition");
    expect(() => assertChatSessionBindingV1({
      session: retained,
      conversationId: "research-session:foreign",
      identity: IDENTITY,
      tenantOrigin: TENANT,
    })).toThrow("different user, thread, tenant, or provider-cache partition");
    expect(() => assertChatSessionBindingV1({
      session: retained,
      conversationId: retained.conversationId,
      identity: IDENTITY,
      tenantOrigin: "https://foreign.atlassian.net",
    })).toThrow("different user, thread, tenant, or provider-cache partition");
  });

  test("rejects stale session revisions and late results after abort or steering", async () => {
    const initial = session();
    const fingerprint = await chatScopeFingerprintV1({
      scope: scope("DEMO"),
      scopeBindings: [binding("DEMO")],
    });
    expect(() => beginChatTurnV1({
      session: initial,
      expectedSessionRevision: initial.revision - 1,
      turnId: "research-turn:stale",
      objective: "Use a stale client.",
      qualityMode: "auto",
      scopeFingerprint: fingerprint,
      startedAt: "2026-08-06T08:00:00.000Z",
    })).toThrow("revision is stale");

    const running = beginChatTurnV1({
      session: initial,
      expectedSessionRevision: initial.revision,
      turnId: "research-turn:active",
      objective: "Complete only if the control fence remains current.",
      qualityMode: "auto",
      scopeFingerprint: fingerprint,
      startedAt: "2026-08-06T08:00:00.000Z",
    });
    const steered = advanceChatControlFenceV1({
      session: running,
      expectedSessionRevision: running.revision,
      kind: "steering",
      at: "2026-08-06T08:00:00.500Z",
    });
    expect(() => completeChatTurnV1({
      session: steered,
      expectedSessionRevision: steered.revision,
      turnId: "research-turn:active",
      answer: answer(),
      acceptedStrategy: STRATEGY,
      activityRefs: [],
      evidenceRecords: [],
      completedAt: "2026-08-06T08:00:01.000Z",
    })).toThrow("obsolete abort or steering revision");

    const aborted = advanceChatControlFenceV1({
      session: steered,
      expectedSessionRevision: steered.revision,
      kind: "abort",
      at: "2026-08-06T08:00:00.750Z",
    });
    expect(aborted.operations).toMatchObject({
      abortEpoch: 1,
      steeringRevision: 1,
    });
  });

  test("retains one waiting HITL turn as active and resumes only that checkpoint", async () => {
    const initial = session();
    const fingerprint = await chatScopeFingerprintV1({
      scope: scope("DEMO"),
      scopeBindings: [binding("DEMO")],
    });
    const running = beginChatTurnV1({
      session: initial,
      expectedSessionRevision: initial.revision,
      turnId: "research-turn:hitl",
      objective: "Ask only if a material choice remains.",
      qualityMode: "auto",
      scopeFingerprint: fingerprint,
      startedAt: "2026-08-06T08:00:00.000Z",
    });
    const waiting = pauseChatTurnV1({
      session: running,
      expectedSessionRevision: running.revision,
      turnId: "research-turn:hitl",
      at: "2026-08-06T08:00:01.000Z",
    });
    expect(parseChatSessionV1(JSON.parse(JSON.stringify(waiting)))).toEqual(waiting);
    expect(waiting.operations.activeTurnId).toBe("research-turn:hitl");
    expect(waiting.conversation.recentTurns.at(-1)?.status).toBe("waiting");
    expect(waiting.conversation.recentTurns.at(-1)?.completedAt).toBeUndefined();
    expect(() => beginChatTurnV1({
      session: waiting,
      expectedSessionRevision: waiting.revision,
      turnId: "research-turn:other",
      objective: "Do not overtake the waiting turn.",
      qualityMode: "quick",
      scopeFingerprint: fingerprint,
      startedAt: "2026-08-06T08:00:02.000Z",
    })).toThrow("already has an active turn");

    const resumed = resumeChatTurnV1({
      session: waiting,
      expectedSessionRevision: waiting.revision,
      turnId: "research-turn:hitl",
      objective: "Ask only if a material choice remains.",
      qualityMode: "auto",
      scopeFingerprint: fingerprint,
      at: "2026-08-06T08:00:03.000Z",
    });
    expect(resumed.conversation.recentTurns.at(-1)?.status).toBe("running");
    expect(buildChatTurnContextV1(resumed, "research-turn:hitl").current.turnId)
      .toBe("research-turn:hitl");
  });

  test("fences a steering checkpoint from HITL or generic continuation", async () => {
    const initial = session();
    const fingerprint = await chatScopeFingerprintV1({
      scope: scope("DEMO"),
      scopeBindings: [binding("DEMO")],
    });
    const running = beginChatTurnV1({
      session: initial,
      expectedSessionRevision: initial.revision,
      turnId: "research-turn:steering",
      objective: "Summarize the attached page.",
      qualityMode: "auto",
      scopeFingerprint: fingerprint,
      startedAt: "2026-08-06T08:10:00.000Z",
    });
    const waiting = pauseChatTurnV1({
      session: running,
      expectedSessionRevision: running.revision,
      turnId: "research-turn:steering",
      reason: "steering",
      at: "2026-08-06T08:10:01.000Z",
    });
    expect(waiting.conversation.recentTurns.at(-1)?.waitingReason).toBe("steering");
    expect(() => resumeChatTurnV1({
      session: waiting,
      expectedSessionRevision: waiting.revision,
      turnId: "research-turn:steering",
      objective: "Summarize the attached page.",
      qualityMode: "auto",
      scopeFingerprint: fingerprint,
      reason: "hitl",
      at: "2026-08-06T08:10:02.000Z",
    })).toThrow("reason does not match");
    const resumed = resumeChatTurnV1({
      session: waiting,
      expectedSessionRevision: waiting.revision,
      turnId: "research-turn:steering",
      objective: "Summarize the attached page.",
      qualityMode: "auto",
      scopeFingerprint: fingerprint,
      reason: "steering",
      at: "2026-08-06T08:10:03.000Z",
    });
    expect(resumed.conversation.recentTurns.at(-1)).toMatchObject({
      status: "running",
    });
    expect(resumed.conversation.recentTurns.at(-1)?.waitingReason).toBeUndefined();
  });

  test("does not carry obsolete evidence authority across a scope switch", async () => {
    const firstFingerprint = await chatScopeFingerprintV1({
      scope: scope("DEMO"),
      scopeBindings: [binding("DEMO")],
    });
    const initial = session();
    const first = beginChatTurnV1({
      session: initial,
      expectedSessionRevision: initial.revision,
      turnId: "research-turn:first",
      objective: "Summarize DEMO.",
      qualityMode: "auto",
      scopeFingerprint: firstFingerprint,
      startedAt: "2026-08-06T08:00:00.000Z",
    });
    const completed = completeChatTurnV1({
      session: first,
      expectedSessionRevision: first.revision,
      turnId: "research-turn:first",
      answer: answer({ evidence: true }),
      acceptedStrategy: STRATEGY,
      activityRefs: [],
      evidenceRecords: [await evidenceRecord()],
      completedAt: "2026-08-06T08:00:01.000Z",
    });
    const secondFingerprint = await chatScopeFingerprintV1({
      scope: scope("OTHER"),
      scopeBindings: [binding("OTHER")],
    });
    const switched = beginChatTurnV1({
      session: completed,
      expectedSessionRevision: completed.revision,
      turnId: "research-turn:second",
      objective: "Now summarize OTHER.",
      qualityMode: "auto",
      scopeFingerprint: secondFingerprint,
      startedAt: "2026-08-06T08:01:00.000Z",
    });
    const context = buildChatTurnContextV1(switched, "research-turn:second");

    expect(context.recentMessages).toHaveLength(1);
    expect(context.acceptedEvidence).toEqual([]);
    expect(renderChatTurnContextV1(context)).not.toContain(
      "Only synthetic evidence is retained",
    );
  });

  test("replaces stale canonical evidence and its dependent claim references", async () => {
    const fingerprint = await chatScopeFingerprintV1({
      scope: scope("DEMO"),
      scopeBindings: [binding("DEMO")],
    });
    const initial = session();
    const firstRunning = beginChatTurnV1({
      session: initial,
      expectedSessionRevision: initial.revision,
      turnId: "research-turn:first",
      objective: "Read the first version.",
      qualityMode: "auto",
      scopeFingerprint: fingerprint,
      startedAt: "2026-08-06T08:00:00.000Z",
    });
    const firstRecord = await evidenceRecord();
    const firstComplete = completeChatTurnV1({
      session: firstRunning,
      expectedSessionRevision: firstRunning.revision,
      turnId: "research-turn:first",
      answer: answer({ evidence: true }),
      acceptedStrategy: STRATEGY,
      activityRefs: [],
      evidenceRecords: [firstRecord],
      completedAt: "2026-08-06T08:00:01.000Z",
    });
    const secondRunning = beginChatTurnV1({
      session: firstComplete,
      expectedSessionRevision: firstComplete.revision,
      turnId: "research-turn:second",
      objective: "Read the changed version.",
      qualityMode: "auto",
      scopeFingerprint: fingerprint,
      startedAt: "2026-08-06T09:00:00.000Z",
    });
    const changedRecord = await evidenceRecord(
      "DEMO",
      "A changed synthetic evidence version is retained.",
      "2026-08-06T09:00:00.000Z",
      "2026-08-06T08:59:00.000Z",
    );
    const secondComplete = completeChatTurnV1({
      session: secondRunning,
      expectedSessionRevision: secondRunning.revision,
      turnId: "research-turn:second",
      answer: answer({ evidence: true }),
      acceptedStrategy: STRATEGY,
      activityRefs: [],
      evidenceRecords: [changedRecord],
      completedAt: "2026-08-06T09:00:01.000Z",
    });

    expect(changedRecord.id).not.toBe(firstRecord.id);
    expect(secondComplete.evidence.entries).toEqual([
      expect.objectContaining({
        evidenceId: changedRecord.id,
        acceptedInTurnId: "research-turn:second",
        supportingClaimRefs: [
          "chat-claim:research-turn:second:000",
          "chat-source:wiki:1001",
        ],
      }),
    ]);
    expect(JSON.stringify(secondComplete.evidence)).not.toContain(firstRecord.id);
  });

  test("keeps a 1,000-turn conversation bounded without losing recent semantics", async () => {
    const fingerprint = await chatScopeFingerprintV1({
      scope: scope("DEMO"),
      scopeBindings: [binding("DEMO")],
    });
    let retained = session();
    for (let index = 0; index < 1_000; index += 1) {
      const turnId = `research-turn:${String(index).padStart(4, "0")}`;
      retained = beginChatTurnV1({
        session: retained,
        expectedSessionRevision: retained.revision,
        turnId,
        objective: `Synthetic follow-up ${index}`,
        qualityMode: "auto",
        scopeFingerprint: fingerprint,
        startedAt: new Date(Date.parse("2026-08-06T08:00:00.000Z") + index * 2_000).toISOString(),
      });
      retained = completeChatTurnV1({
        session: retained,
        expectedSessionRevision: retained.revision,
        turnId,
        answer: answer({ message: `Synthetic answer ${index}` }),
        acceptedStrategy: STRATEGY,
        activityRefs: ["activity:complete"],
        evidenceRecords: [],
        completedAt: new Date(Date.parse("2026-08-06T08:00:01.000Z") + index * 2_000).toISOString(),
      });
    }

    expect(retained.conversation.recentTurns).toHaveLength(12);
    expect(retained.conversation.summary.compactedTurnCount).toBe(988);
    expect(retained.conversation.recentTurns.at(-1)).toMatchObject({
      id: "research-turn:0999",
      objective: "Synthetic follow-up 999",
      status: "complete",
    });
    expect(JSON.stringify(retained).length).toBeLessThan(120_000);
    const next = beginChatTurnV1({
      session: retained,
      expectedSessionRevision: retained.revision,
      turnId: "research-turn:1000",
      objective: "Use the recent context.",
      qualityMode: "auto",
      scopeFingerprint: fingerprint,
      startedAt: "2026-08-06T09:00:00.000Z",
    });
    const context = buildChatTurnContextV1(next, "research-turn:1000");
    expect(context.recentMessages).toHaveLength(6);
    expect(context.recentMessages.at(-1)).toEqual({
      turnId: "research-turn:0999",
      user: "Synthetic follow-up 999",
      assistant: "Synthetic answer 999",
    });
  });
});
