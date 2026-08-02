import { describe, expect, test } from "bun:test";
import { createResearchBriefV1 } from "./brief.js";
import {
  composeResearchGraphV1,
  type ResearchGraphProposalV1,
} from "./graph.js";
import {
  approveResearchScopeExpansionV1,
  appendResearchSessionTurnV1,
  continueResearchSessionScopeClarificationV1,
  continueResearchSessionClarificationPlanningV1,
  initializeResearchSessionScopeClarificationWaitV1,
  initializeResearchSessionClarificationWaitV1,
  initializeResearchSessionTurnV1,
  proposeResearchGraphForReadyBriefV1,
  projectResearchResumableSessionV1,
  recoverResearchSessionForResumeV1,
  resolveResearchSessionScopeClarificationV1,
  resolveResearchSessionClarificationsV1,
} from "./session-runtime.js";
import { InMemoryResearchSessionStoreV1 } from "./session-store.js";
import { createResearchSessionV1 } from "./session.js";
import {
  createResearchKeyScopeSeedV1,
  createResearchScopeExpansionProposalV1,
} from "./scope-discovery.js";
import { RESEARCH_PACKET_BODY_SCHEMA_V2 } from "./workflow-contracts.js";
import {
  DEFAULT_RESEARCH_LIMITS_V1,
  DEFAULT_RESEARCH_ONE_SHOT_POLICY_V1,
} from "./contracts.js";

function scopeClarificationRequest() {
  return {
    schema: "atlcli.research-request/v1" as const,
    question: "Research the Account Management space.",
    scope: {
      siteOrigin: "https://example.atlassian.net",
      jiraProjectKeys: [],
      confluenceSpaceKeys: [],
    },
    limits: DEFAULT_RESEARCH_LIMITS_V1,
    wikiProvider: "rest" as const,
  };
}

function scopeCandidate() {
  return {
    schema: "atlcli.research-scope-candidate/v1" as const,
    id: "research-scope-candidate:account-management",
    tenantOrigin: "https://example.atlassian.net",
    product: "confluence" as const,
    entityKind: "space" as const,
    entityRef: "space:account-management",
    key: "DOCS",
    name: "Account Management",
    accessible: true as const,
    providerFreshnessAt: "2026-08-01T15:00:00.000Z",
  };
}

function scopeClarification() {
  return {
    schema: "atlcli.research-clarification-required/v1" as const,
    reason: "ambiguous" as const,
    mentionId: "mention:scope-1",
    candidateIds: [scopeCandidate().id],
    rerunGuidance: ["Pass an exact Confluence space with --space <KEY>."],
  };
}

function resolvedScopeRequest() {
  return {
    ...scopeClarificationRequest(),
    scope: {
      siteOrigin: "https://example.atlassian.net",
      jiraProjectKeys: [],
      confluenceSpaceKeys: ["DOCS"],
    },
  };
}

function brief(approval: "automatic" | "required", turnId = "research-turn:runtime-test") {
  return createResearchBriefV1({
    sessionId: "research-session:runtime-test",
    turnId,
    objective: "Find the related Jira work item.",
    scope: { siteOrigin: "https://example.atlassian.net", jiraProjectKeys: ["DEMO"], confluenceSpaceKeys: ["DOCS"] },
    asOf: "2026-08-01T15:00:00.000Z",
    timezone: "UTC",
    requestedPlanApproval: approval,
  });
}

function session() {
  return createResearchSessionV1({
    sessionId: "research-session:runtime-test",
    ownerId: "owner:runtime",
    createdAt: "2026-08-01T15:00:00.000Z",
    leaseExpiresAt: "2026-08-01T15:10:00.000Z",
  });
}

describe("durable research session execution gate", () => {
  test("persists an initial scope choice before it creates a brief or graph", async () => {
    const store = new InMemoryResearchSessionStoreV1();
    const waiting = await initializeResearchSessionScopeClarificationWaitV1({
      store,
      session: session(),
      request: scopeClarificationRequest(),
      policy: { ...DEFAULT_RESEARCH_ONE_SHOT_POLICY_V1, requestedPlanApproval: "required" },
      clarification: scopeClarification(),
      candidateChoices: [scopeCandidate()],
      at: "2026-08-01T15:00:01.000Z",
    });
    expect(waiting).toMatchObject({
      status: "waiting_scope_clarification",
      revision: 2,
      lease: { expiresAt: "2026-08-01T15:00:01.000Z" },
      turns: [],
      scopeClarification: {
        state: "waiting_choice",
        clarification: { mentionId: "mention:scope-1" },
      },
    });
    expect((await store.events(waiting.sessionId)).map((event) => event.kind))
      .toEqual(["record_scope_clarification"]);
  });

  test("commits a validated scope selection before it materializes the first brief and plan", async () => {
    const store = new InMemoryResearchSessionStoreV1();
    const waiting = await initializeResearchSessionScopeClarificationWaitV1({
      store,
      session: session(),
      request: scopeClarificationRequest(),
      policy: { ...DEFAULT_RESEARCH_ONE_SHOT_POLICY_V1, requestedPlanApproval: "required" },
      clarification: scopeClarification(),
      candidateChoices: [scopeCandidate()],
      at: "2026-08-01T15:00:01.000Z",
    });
    const result = await resolveResearchSessionScopeClarificationV1({
      store,
      sessionId: waiting.sessionId,
      expectedRevision: waiting.revision,
      expectedLeaseEpoch: waiting.lease.epoch,
      selection: {
        schema: "atlcli.research-scope-candidate-selection/v1",
        mentionId: "mention:scope-1",
        candidateId: scopeCandidate().id,
      },
      resolvedRequest: resolvedScopeRequest(),
      at: "2026-08-01T15:00:02.000Z",
    });
    expect(result).toMatchObject({
      status: "waiting_plan_approval",
      scopeClarification: {
        state: "choice_resolved",
        selection: { candidateId: scopeCandidate().id },
      },
      turns: [{
        brief: { scope: { confluenceSpaceKeys: ["DOCS"] } },
        graph: { status: "proposed" },
      }],
    });
    expect((await store.events(result.sessionId)).map((event) => event.kind)).toEqual([
      "record_scope_clarification",
      "resolve_scope_clarification",
      "initialize_scope_brief",
      "propose_graph",
    ]);
  });

  test("does not let a selected catalog candidate replace an existing scope or time window", async () => {
    const store = new InMemoryResearchSessionStoreV1();
    const request = {
      ...scopeClarificationRequest(),
      scope: {
        siteOrigin: "https://example.atlassian.net",
        jiraProjectKeys: ["LOCKED"],
        confluenceSpaceKeys: [],
        timeWindow: { from: "2026-08-01", to: "2026-08-02" },
      },
    };
    const waiting = await initializeResearchSessionScopeClarificationWaitV1({
      store,
      session: session(),
      request,
      policy: { ...DEFAULT_RESEARCH_ONE_SHOT_POLICY_V1, requestedPlanApproval: "required" },
      clarification: scopeClarification(),
      candidateChoices: [scopeCandidate()],
      at: "2026-08-01T15:00:01.000Z",
    });
    await expect(resolveResearchSessionScopeClarificationV1({
      store,
      sessionId: waiting.sessionId,
      expectedRevision: waiting.revision,
      expectedLeaseEpoch: waiting.lease.epoch,
      selection: {
        schema: "atlcli.research-scope-candidate-selection/v1",
        mentionId: "mention:scope-1",
        candidateId: scopeCandidate().id,
      },
      resolvedRequest: resolvedScopeRequest(),
      at: "2026-08-01T15:00:02.000Z",
    })).rejects.toThrow("Research session scope clarification resolution is invalid.");
    expect((await store.read(waiting.sessionId))?.revision).toBe(waiting.revision);
  });

  test("lets a selected natural scope replace only a lower-precedence profile default", async () => {
    const store = new InMemoryResearchSessionStoreV1();
    const projectDefault = createResearchKeyScopeSeedV1({
      tenantOrigin: "https://example.atlassian.net",
      product: "jira",
      key: "DEFAULT",
      source: "profile_default",
      authority: "approved",
    });
    const spaceDefault = createResearchKeyScopeSeedV1({
      tenantOrigin: "https://example.atlassian.net",
      product: "confluence",
      key: "LEGACY",
      source: "profile_default",
      authority: "approved",
    });
    const request = {
      ...scopeClarificationRequest(),
      scope: {
        siteOrigin: "https://example.atlassian.net",
        jiraProjectKeys: ["DEFAULT"],
        confluenceSpaceKeys: ["LEGACY"],
        timeWindow: { from: "2026-08-01", to: "2026-08-02" },
      },
      scopeSeeds: [projectDefault, spaceDefault],
    };
    const waiting = await initializeResearchSessionScopeClarificationWaitV1({
      store,
      session: session(),
      request,
      policy: { ...DEFAULT_RESEARCH_ONE_SHOT_POLICY_V1, requestedPlanApproval: "required" },
      clarification: scopeClarification(),
      candidateChoices: [scopeCandidate()],
      at: "2026-08-01T15:00:01.000Z",
    });
    const resolved = {
      ...request,
      scope: {
        ...request.scope,
        confluenceSpaceKeys: ["DOCS"],
      },
      scopeSeeds: [
        projectDefault,
        spaceDefault,
        {
          binding: {
            schema: "atlcli.research-scope-binding/v1" as const,
            id: `scope-binding:${scopeCandidate().id}`,
            tenantOrigin: "https://example.atlassian.net",
            product: "confluence" as const,
            entityKind: "space" as const,
            entityRef: scopeCandidate().entityRef,
            key: "DOCS",
            name: scopeCandidate().name,
            source: "natural_language" as const,
            authority: "approved" as const,
            mentionId: "mention:scope-1",
            candidateId: scopeCandidate().id,
          },
          precedence: 400,
        },
      ],
    };
    const result = await resolveResearchSessionScopeClarificationV1({
      store,
      sessionId: waiting.sessionId,
      expectedRevision: waiting.revision,
      expectedLeaseEpoch: waiting.lease.epoch,
      selection: {
        schema: "atlcli.research-scope-candidate-selection/v1",
        mentionId: "mention:scope-1",
        candidateId: scopeCandidate().id,
      },
      resolvedRequest: resolved,
      at: "2026-08-01T15:00:02.000Z",
    });
    expect(result).toMatchObject({
      status: "waiting_plan_approval",
      turns: [{
        brief: {
          scope: {
            jiraProjectKeys: ["DEFAULT"],
            confluenceSpaceKeys: ["DOCS"],
            timeWindow: { from: "2026-08-01", to: "2026-08-02" },
          },
        },
      }],
    });
  });

  test("recovers a committed scope choice without accepting a new scope or policy", async () => {
    const store = new InMemoryResearchSessionStoreV1();
    const waiting = await initializeResearchSessionScopeClarificationWaitV1({
      store,
      session: session(),
      request: scopeClarificationRequest(),
      policy: { ...DEFAULT_RESEARCH_ONE_SHOT_POLICY_V1, requestedPlanApproval: "required" },
      clarification: scopeClarification(),
      candidateChoices: [scopeCandidate()],
      at: "2026-08-01T15:00:01.000Z",
    });
    const choiceCommitted = (await store.commit(waiting.sessionId, {
      kind: "resolve_scope_clarification",
      selection: {
        schema: "atlcli.research-scope-candidate-selection/v1",
        mentionId: "mention:scope-1",
        candidateId: scopeCandidate().id,
      },
      resolvedRequest: resolvedScopeRequest(),
      expectedRevision: waiting.revision,
      expectedLeaseEpoch: waiting.lease.epoch,
      at: "2026-08-01T15:00:02.000Z",
    })).session;
    expect(choiceCommitted).toMatchObject({ status: "idle", turns: [] });
    const recovered = await continueResearchSessionScopeClarificationV1({
      store,
      sessionId: choiceCommitted.sessionId,
      expectedRevision: choiceCommitted.revision,
      expectedLeaseEpoch: choiceCommitted.lease.epoch,
      at: "2026-08-01T15:00:03.000Z",
    });
    expect(recovered).toMatchObject({
      status: "waiting_plan_approval",
      turns: [{ graph: { status: "proposed" } }],
    });
  });

  test("persists a required clarification as a released body-free wait before graph construction", async () => {
    const requiredClarification = createResearchBriefV1({
      ...brief("automatic"),
      clarificationQuestions: [{
        id: "clarification:scope",
        prompt: "Which exact project should be searched?",
        required: true,
      }],
    });
    const store = new InMemoryResearchSessionStoreV1();
    const result = await initializeResearchSessionClarificationWaitV1({
      store,
      session: session(),
      brief: requiredClarification,
      at: "2026-08-01T15:00:01.000Z",
    });
    expect(result).toMatchObject({
      status: "waiting_clarification",
      revision: 3,
      lease: { expiresAt: "2026-08-01T15:00:01.000Z" },
      turns: [{
        brief: { revision: 1, clarificationQuestions: [{ id: "clarification:scope" }] },
      }],
    });
    expect((await store.events(result.sessionId)).map((event) => event.kind))
      .toEqual(["create_turn", "record_brief"]);
  });

  test("proposes a graph only after a committed clarification materializes a ready brief", async () => {
    const pending = createResearchBriefV1({
      ...brief("required"),
      clarificationQuestions: [{
        id: "clarification:window",
        prompt: "Which reporting window should be used?",
        required: true,
      }],
    });
    const store = new InMemoryResearchSessionStoreV1();
    const waiting = await initializeResearchSessionClarificationWaitV1({
      store,
      session: session(),
      brief: pending,
      at: "2026-08-01T15:00:01.000Z",
    });
    const resolved = (await store.commit(waiting.sessionId, {
      kind: "resolve_clarifications",
      briefRevision: pending.revision,
      answers: [{ questionId: "clarification:window", response: "Use the latest week." }],
      assumptionDecisions: [],
      expectedRevision: waiting.revision,
      expectedLeaseEpoch: waiting.lease.epoch,
      at: "2026-08-01T15:00:02.000Z",
    })).session;
    const proposed = await proposeResearchGraphForReadyBriefV1({
      store,
      sessionId: resolved.sessionId,
      expectedRevision: resolved.revision,
      expectedLeaseEpoch: resolved.lease.epoch,
      approveAutomatically: false,
      at: "2026-08-01T15:00:03.000Z",
    });

    expect(proposed).toMatchObject({
      status: "waiting_plan_approval",
      turns: [{
        brief: { revision: 2, clarificationResponses: [{ response: "Use the latest week." }] },
        graph: { basedOnBriefRevision: 2, status: "proposed" },
      }],
    });
    expect((await store.events(proposed.sessionId)).map((event) => event.kind)).toEqual([
      "create_turn",
      "record_brief",
      "resolve_clarifications",
      "propose_graph",
    ]);
  });

  test("recovers a clarification after answers committed but before graph proposal", async () => {
    const pending = createResearchBriefV1({
      ...brief("automatic"),
      clarificationQuestions: [{
        id: "clarification:window",
        prompt: "Which reporting window should be used?",
        required: true,
      }],
    });
    const store = new InMemoryResearchSessionStoreV1();
    const waiting = await initializeResearchSessionClarificationWaitV1({
      store,
      session: session(),
      brief: pending,
      at: "2026-08-01T15:00:01.000Z",
    });
    const answerCommitted = (await store.commit(waiting.sessionId, {
      kind: "resolve_clarifications",
      briefRevision: pending.revision,
      answers: [{ questionId: "clarification:window", response: "Use the latest week." }],
      assumptionDecisions: [],
      expectedRevision: waiting.revision,
      expectedLeaseEpoch: waiting.lease.epoch,
      at: "2026-08-01T15:00:02.000Z",
    })).session;
    const recovered = await continueResearchSessionClarificationPlanningV1({
      store,
      sessionId: answerCommitted.sessionId,
      expectedRevision: answerCommitted.revision,
      expectedLeaseEpoch: answerCommitted.lease.epoch,
      briefRevision: 2,
      approveAutomatically: true,
      releaseApprovedLease: true,
      at: "2026-08-01T15:00:03.000Z",
    });
    expect(recovered).toMatchObject({
      status: "running",
      lease: { expiresAt: "2026-08-01T15:00:03.000Z" },
      turns: [{ graph: { status: "approved", basedOnBriefRevision: 2 } }],
    });
    expect((await store.events(recovered.sessionId)).map((event) => event.kind)).toEqual([
      "create_turn",
      "record_brief",
      "resolve_clarifications",
      "propose_graph",
      "approve_graph",
      "release_lease",
    ]);
  });

  test("resolves questions, then plans only after the answer CAS succeeds", async () => {
    const pending = createResearchBriefV1({
      ...brief("required"),
      clarificationQuestions: [{
        id: "clarification:window",
        prompt: "Which reporting window should be used?",
        required: true,
      }],
    });
    const store = new InMemoryResearchSessionStoreV1();
    const waiting = await initializeResearchSessionClarificationWaitV1({
      store,
      session: session(),
      brief: pending,
      at: "2026-08-01T15:00:01.000Z",
    });
    const proposed = await resolveResearchSessionClarificationsV1({
      store,
      sessionId: waiting.sessionId,
      expectedRevision: waiting.revision,
      expectedLeaseEpoch: waiting.lease.epoch,
      briefRevision: 1,
      answers: [{ questionId: "clarification:window", response: "Use the latest week." }],
      assumptionDecisions: [],
      approveAutomatically: false,
      at: "2026-08-01T15:00:02.000Z",
    });
    expect(proposed).toMatchObject({
      status: "waiting_plan_approval",
      turns: [{ brief: { revision: 2 }, graph: { basedOnBriefRevision: 2 } }],
    });
  });

  test("persists an accepted turn, brief, exact proposed graph, and separate automatic approval before execution", async () => {
    const acceptedBrief = brief("automatic");
    const store = new InMemoryResearchSessionStoreV1();
    const result = await initializeResearchSessionTurnV1({
      store,
      session: session(),
      brief: acceptedBrief,
      graph: composeResearchGraphV1(acceptedBrief),
      approveAutomatically: true,
      at: "2026-08-01T15:00:01.000Z",
    });
    expect(result).toMatchObject({ status: "running", revision: 5 });
    expect(result.turns[0]).toMatchObject({ brief: { objective: "Find the related Jira work item." }, graph: { status: "approved" } });
    expect((await store.events(result.sessionId)).map((event) => event.kind)).toEqual(["create_turn", "record_brief", "propose_graph", "approve_graph"]);
  });

  test("leaves a required plan durably waiting without any approval transition", async () => {
    const requiredBrief = brief("required");
    const store = new InMemoryResearchSessionStoreV1();
    const result = await initializeResearchSessionTurnV1({
      store,
      session: session(),
      brief: requiredBrief,
      graph: composeResearchGraphV1(requiredBrief),
      approveAutomatically: false,
      at: "2026-08-01T15:00:01.000Z",
    });
    expect(result).toMatchObject({
      status: "waiting_plan_approval",
      revision: 4,
      lease: { expiresAt: "2026-08-01T15:00:01.000Z" },
    });
    expect((await store.events(result.sessionId)).map((event) => event.kind)).toEqual(["create_turn", "record_brief", "propose_graph"]);
  });

  test("rebuilds a rejected plan from its committed correction and never auto-approves it", async () => {
    const requiredBrief = brief("required");
    const store = new InMemoryResearchSessionStoreV1();
    const initial = await initializeResearchSessionTurnV1({
      store,
      session: session(),
      brief: requiredBrief,
      graph: composeResearchGraphV1(requiredBrief),
      approveAutomatically: false,
      at: "2026-08-01T15:00:01.000Z",
    });
    const firstGraph = initial.turns[0]!.graph!;
    const rejected = (await store.commit(initial.sessionId, {
      kind: "reject_plan",
      graphRevision: firstGraph.revision,
      reason: "Separate direct evidence from inferred relationships.",
      expectedRevision: initial.revision,
      expectedLeaseEpoch: initial.lease.epoch,
      at: "2026-08-01T15:00:02.000Z",
    })).session;
    const requested = (await store.commit(rejected.sessionId, {
      kind: "request_plan_revision",
      graphRevision: firstGraph.revision,
      instruction: "Separate direct evidence from inferred relationships.",
      expectedRevision: rejected.revision,
      expectedLeaseEpoch: rejected.lease.epoch,
      at: "2026-08-01T15:00:03.000Z",
    })).session;
    const rebuilt = await proposeResearchGraphForReadyBriefV1({
      store,
      sessionId: requested.sessionId,
      expectedRevision: requested.revision,
      expectedLeaseEpoch: requested.lease.epoch,
      approveAutomatically: true,
      at: "2026-08-01T15:00:04.000Z",
    });

    expect(rebuilt).toMatchObject({
      status: "waiting_plan_approval",
      turns: [{
        brief: { revision: 2, planRevisionInstructions: [{ basedOnGraphRevision: 1 }] },
        graph: { revision: 2, basedOnBriefRevision: 2, status: "proposed" },
        planRevisions: [{ state: "proposed", proposedGraphRevision: 2 }],
      }],
    });
    expect((await store.events(rebuilt.sessionId)).map((event) => event.kind)).toEqual([
      "create_turn",
      "record_brief",
      "propose_graph",
      "reject_plan",
      "request_plan_revision",
      "revise_graph",
    ]);
  });

  test("commits whole-scope approval and its replacement plan in one durable event", async () => {
    const candidate = {
      schema: "atlcli.research-scope-candidate/v1" as const,
      id: "research-scope-candidate:confluence-space-related",
      tenantOrigin: "https://example.atlassian.net",
      product: "confluence" as const,
      entityKind: "space" as const,
      entityRef: "research-scope-entity:confluence-space-related",
      key: "RELATED",
      name: "Related documentation",
      status: "current" as const,
      accessible: true as const,
      providerFreshnessAt: "2026-08-01T15:00:00.000Z",
    };
    const initialBrief = createResearchBriefV1({
      ...brief("automatic"),
      scopeCandidates: [candidate],
    });
    const store = new InMemoryResearchSessionStoreV1();
    const proposed = await initializeResearchSessionTurnV1({
      store,
      session: session(),
      brief: initialBrief,
      graph: composeResearchGraphV1(initialBrief, {
        packetOutputSchema: RESEARCH_PACKET_BODY_SCHEMA_V2,
      }),
      approveAutomatically: false,
      at: "2026-08-01T15:00:01.000Z",
    });
    const running = (await store.commit(proposed.sessionId, {
      kind: "approve_graph",
      graphRevision: 1,
      expectedRevision: proposed.revision,
      expectedLeaseEpoch: proposed.lease.epoch,
      at: "2026-08-01T15:00:02.000Z",
    })).session;
    const turn = running.turns[0]!;
    const awaitingScope = (await store.commit(running.sessionId, {
      kind: "propose_scope_expansion",
      proposal: createResearchScopeExpansionProposalV1({
        id: "scope-expansion:related-space",
        sessionId: running.sessionId,
        turnId: turn.id,
        basedOnBriefRevision: turn.brief!.revision,
        basedOnGraphRevision: turn.graph!.revision,
        candidateId: candidate.id,
        expansionKind: "whole_scope",
        reason: "A supported relationship needs space-level follow-up.",
        provenanceRefs: ["source:related-space"],
        status: "proposed",
      }),
      expectedRevision: running.revision,
      expectedLeaseEpoch: running.lease.epoch,
      at: "2026-08-01T15:00:03.000Z",
    })).session;

    const replacement = await approveResearchScopeExpansionV1({
      store,
      sessionId: awaitingScope.sessionId,
      proposalId: "scope-expansion:related-space",
      binding: {
        schema: "atlcli.research-scope-binding/v1",
        id: "scope-binding:research-scope-candidate:confluence-space-related",
        tenantOrigin: candidate.tenantOrigin,
        product: candidate.product,
        entityKind: candidate.entityKind,
        entityRef: candidate.entityRef,
        key: candidate.key,
        name: candidate.name,
        source: "research_discovery",
        authority: "approved",
        candidateId: candidate.id,
        approvedAt: "2026-08-01T15:00:04.000Z",
      },
      expectedRevision: awaitingScope.revision,
      expectedLeaseEpoch: awaitingScope.lease.epoch,
      at: "2026-08-01T15:00:04.000Z",
    });

    expect(replacement).toMatchObject({
      status: "waiting_plan_approval",
      turns: [{
        brief: { revision: 2, scope: { confluenceSpaceKeys: ["DOCS", "RELATED"] } },
        graph: { revision: 2, basedOnBriefRevision: 2, status: "proposed" },
        scopeRevisions: [{ state: "proposed", proposedGraphRevision: 2 }],
      }],
    });
    expect((await store.events(replacement.sessionId)).map((event) => event.kind)).toEqual([
      "create_turn",
      "record_brief",
      "propose_graph",
      "approve_graph",
      "propose_scope_expansion",
      "approve_scope_expansion",
    ]);
    expect(replacement.turns[0]!.graph!.nodes.some((node) =>
      node.outputSchema === RESEARCH_PACKET_BODY_SCHEMA_V2,
    )).toBe(true);
  });

  test("appends an approved follow-up turn without replacing terminal turn history", async () => {
    const firstBrief = brief("automatic");
    const store = new InMemoryResearchSessionStoreV1();
    const initialized = await initializeResearchSessionTurnV1({
      store,
      session: session(),
      brief: firstBrief,
      graph: composeResearchGraphV1(firstBrief),
      approveAutomatically: true,
      at: "2026-08-01T15:00:01.000Z",
    });
    const terminal = await store.commit(initialized.sessionId, {
      kind: "fail",
      reason: "Synthetic terminal first turn.",
      expectedRevision: initialized.revision,
      expectedLeaseEpoch: initialized.lease.epoch,
      at: "2026-08-01T15:00:02.000Z",
    });
    const nextBrief = brief("automatic", "research-turn:runtime-follow-up");
    const appended = await appendResearchSessionTurnV1({
      store,
      sessionId: terminal.session.sessionId,
      brief: nextBrief,
      graph: composeResearchGraphV1(nextBrief),
      approveAutomatically: true,
      at: "2026-08-01T15:00:03.000Z",
    });
    expect(appended).toMatchObject({
      status: "running",
      activeTurnId: "research-turn:runtime-follow-up",
    });
    expect(appended.turns).toHaveLength(2);
    expect(appended.turns[0]).toMatchObject({
      id: "research-turn:runtime-test",
      failureReason: "Synthetic terminal first turn.",
    });
    expect(appended.turns[1]).toMatchObject({
      id: "research-turn:runtime-follow-up",
      graph: { status: "approved" },
    });
  });

  test("commits the supervisor-selected subset with its journal event before task admission", async () => {
    const acceptedBrief = brief("automatic");
    const store = new InMemoryResearchSessionStoreV1();
    const initialized = await initializeResearchSessionTurnV1({
      store,
      session: session(),
      brief: acceptedBrief,
      graph: composeResearchGraphV1(acceptedBrief),
      approveAutomatically: true,
      at: "2026-08-01T15:00:01.000Z",
    });
    const graph = initialized.turns[0]!.graph!;
    const selectedNodeIds = new Set(graph.nodes
      .filter((node) => node.kind !== "repair")
      .map((node) => node.id));
    const proposal: ResearchGraphProposalV1 = {
      schema: "atlcli.research-graph-proposal/v1",
      basedOnBriefRevision: graph.basedOnBriefRevision,
      basedOnGraphRevision: graph.revision,
      nodes: graph.nodes.filter((node) => selectedNodeIds.has(node.id)).map((node) => ({
        nodeId: node.id,
        dependencies: node.dependencies.filter((dependency) => selectedNodeIds.has(dependency)),
        reasonCodes: [...node.reasonCodes],
      })),
    };

    const committed = await store.commit(initialized.sessionId, {
      kind: "commit_graph_selection",
      proposal,
      expectedRevision: initialized.revision,
      expectedLeaseEpoch: initialized.lease.epoch,
      at: "2026-08-01T15:00:02.000Z",
    });

    expect(committed.session.turns[0]).toMatchObject({
      graphSelectionCommittedAt: "2026-08-01T15:00:02.000Z",
      tasks: [],
    });
    expect(committed.session.turns[0]!.graph?.nodes).toHaveLength(proposal.nodes.length);
    expect((await store.events(initialized.sessionId)).at(-1)).toMatchObject({
      kind: "commit_graph_selection",
      sessionRevision: committed.session.revision,
    });
  });

  test("reclaims a released authentication wait with a new lease epoch before resuming", async () => {
    const acceptedBrief = brief("automatic");
    const store = new InMemoryResearchSessionStoreV1();
    const initialized = await initializeResearchSessionTurnV1({
      store,
      session: session(),
      brief: acceptedBrief,
      graph: composeResearchGraphV1(acceptedBrief),
      approveAutomatically: true,
      at: "2026-08-01T15:00:01.000Z",
    });
    const waiting = await store.commit(initialized.sessionId, {
      kind: "wait_authentication",
      expectedRevision: initialized.revision,
      expectedLeaseEpoch: initialized.lease.epoch,
      at: "2026-08-01T15:00:02.000Z",
    });
    const resumed = await recoverResearchSessionForResumeV1({
      store,
      sessionId: initialized.sessionId,
      ownerId: "owner:resumed",
      leaseExpiresAt: "2026-08-01T15:10:00.000Z",
      at: "2026-08-01T15:00:02.001Z",
    });
    expect(waiting.session).toMatchObject({ status: "waiting_authentication", lease: { epoch: 1 } });
    expect(resumed).toMatchObject({ status: "running", lease: { epoch: 2, ownerId: "owner:resumed" } });
    expect((await store.events(initialized.sessionId)).slice(-2).map((event) => event.kind))
      .toEqual(["recover", "resume"]);
  });

  test("projects only expired, tenant-bound durable resumes without source or provider data", async () => {
    const acceptedBrief = brief("automatic");
    const store = new InMemoryResearchSessionStoreV1();
    const initialized = await initializeResearchSessionTurnV1({
      store,
      session: session(),
      brief: acceptedBrief,
      graph: composeResearchGraphV1(acceptedBrief),
      approveAutomatically: true,
      at: "2026-08-01T15:00:01.000Z",
    });
    const waiting = await store.commit(initialized.sessionId, {
      kind: "wait_authentication",
      expectedRevision: initialized.revision,
      expectedLeaseEpoch: initialized.lease.epoch,
      at: "2026-08-01T15:00:02.000Z",
    });

    expect(projectResearchResumableSessionV1(waiting.session, {
      tenantOrigin: "https://example.atlassian.net",
      at: "2026-08-01T15:00:02.001Z",
    })).toEqual({
      schema: "atlcli.research-resumable-session/v1",
      sessionId: initialized.sessionId,
      turnId: "research-turn:runtime-test",
      status: "waiting_authentication",
      updatedAt: "2026-08-01T15:00:02.000Z",
      question: "Find the related Jira work item.",
      scope: {
        jiraProjectKeys: ["DEMO"],
        confluenceSpaceKeys: ["DOCS"],
      },
    });
    expect(projectResearchResumableSessionV1(waiting.session, {
      tenantOrigin: "https://other.atlassian.net",
      at: "2026-08-01T15:00:02.001Z",
    })).toBeUndefined();
    expect(projectResearchResumableSessionV1(initialized, {
      tenantOrigin: "https://example.atlassian.net",
      at: "2026-08-01T15:00:02.001Z",
    })).toBeUndefined();
  });
});
