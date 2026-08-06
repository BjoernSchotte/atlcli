import { describe, expect, it } from "bun:test";
import { routeMessage, type RouterDeps } from "../utils/router.js";
import type { EntityDetection } from "../utils/messages.js";
import type {
  ResearchReportV1,
  ResearchRequestV1,
  ResearchOneShotPolicyV1,
} from "../utils/research/contracts.js";
import type {
  ResearchScopePreflightOutcomeV1,
  ResearchSessionScopeReviewV1,
} from "@atlcli/research";
import {
  CHAT_USER_QUESTION_SCHEMA_V1,
  ChatUserQuestionRequiredError,
} from "@atlcli/research";

const noEntity: EntityDetection = { windowId: 7, url: null, entity: null, seq: 0 };
const preparation = {
  totalMs: 12,
  highlightingMs: 8,
  codeFontMs: 10,
  codeFontBytes: 273_900,
};
const researchReport = {
  schema: "atlcli.research-report/v1",
} as ResearchReportV1;
const planReviewBudget = {
  maxPtcCalls: 32,
  maxHttpCalls: 64,
  maxTotalModelInputTokens: 160_000,
  maxTotalModelOutputTokens: 64_000,
  maxModelCostMicros: 2_000_000,
  maxRunMs: 120_000,
};

const okDeps: RouterDeps = {
  runWasmSmoke: async (a, b) => a + b,
  getCurrentEntity: async () => noEntity,
  runPdfCompile: async () => ({ ok: true }),
  runPdfCancel: async () => true,
  prepareDocxRuntime: async () => preparation,
  runJobsWake: async (jobIds) => jobIds?.[0],
  runResearch: async () => researchReport,
  cancelResearch: async () => true,
};

describe("routeMessage (pure router)", () => {
  it("answers ping with pong", async () => {
    const res = await routeMessage({ kind: "ping" }, okDeps);
    expect(res).toEqual({ kind: "pong" });
  });

  it("answers wasm-smoke with the computed result", async () => {
    const res = await routeMessage({ kind: "wasm-smoke", a: 40, b: 2 }, okDeps);
    expect(res).toEqual({ kind: "wasm-smoke-result", ok: true, result: 42 });
  });

  it("does not invoke runWasmSmoke for ping", async () => {
    let called = false;
    await routeMessage(
      { kind: "ping" },
      {
        runWasmSmoke: async (a, b) => {
          called = true;
          return a + b;
        },
        getCurrentEntity: async () => noEntity,
        runPdfCompile: okDeps.runPdfCompile,
        runPdfCancel: okDeps.runPdfCancel,
      }
    );
    expect(called).toBe(false);
  });

  it("captures a thrown wasm failure as an error response (no hang)", async () => {
    const res = await routeMessage(
      { kind: "wasm-smoke", a: 1, b: 2 },
      {
        runWasmSmoke: async () => {
          throw new Error("instantiate boom");
        },
        getCurrentEntity: async () => noEntity,
        runPdfCompile: okDeps.runPdfCompile,
        runPdfCancel: okDeps.runPdfCancel,
      }
    );
    expect(res).toEqual({
      kind: "wasm-smoke-result",
      ok: false,
      error: "instantiate boom",
    });
  });

  it("stringifies non-Error rejections", async () => {
    const res = await routeMessage(
      { kind: "wasm-smoke", a: 1, b: 2 },
      {
        // eslint-disable-next-line @typescript-eslint/no-throw-literal
        runWasmSmoke: async () => {
          throw "plain string";
        },
        getCurrentEntity: async () => noEntity,
        runPdfCompile: okDeps.runPdfCompile,
        runPdfCancel: okDeps.runPdfCancel,
      }
    );
    expect(res).toEqual({
      kind: "wasm-smoke-result",
      ok: false,
      error: "plain string",
    });
  });

  it("answers get-current-entity with the resolved detection", async () => {
    const detection: EntityDetection = {
      windowId: 7,
      url: "https://x.atlassian.net/wiki/spaces/DOCSY/pages/123/Home",
      entity: { product: "confluence", type: "page", pageId: "123", spaceKey: "DOCSY" },
      seq: 5,
    };
    const requestedWindowIds: number[] = [];
    const res = await routeMessage(
      { kind: "get-current-entity", windowId: detection.windowId },
      {
        ...okDeps,
        getCurrentEntity: async (windowId) => {
          requestedWindowIds.push(windowId);
          return detection;
        },
      }
    );
    expect(res).toEqual({ kind: "current-entity", detection });
    expect(requestedWindowIds).toEqual([detection.windowId]);
  });

  it("routes PDF compile and cancellation by job id", async () => {
    const jobId = "123e4567-e89b-42d3-a456-426614174000";
    expect(await routeMessage({ kind: "pdf:compile", jobId }, okDeps)).toEqual({
      kind: "pdf:compile-result", jobId, ok: true,
    });
    expect(await routeMessage({ kind: "pdf:cancel", jobId }, okDeps)).toEqual({
      kind: "pdf:cancel-result", jobId, cancelled: true,
    });
  });

  it("captures PDF compiler failures", async () => {
    const jobId = "123e4567-e89b-42d3-a456-426614174000";
    const response = await routeMessage(
      { kind: "pdf:compile", jobId },
      { ...okDeps, runPdfCompile: async () => { throw new Error("compiler offline"); } }
    );
    expect(response).toEqual({
      kind: "pdf:compile-result", jobId, ok: false, error: "compiler offline",
    });
  });

  it("routes bounded DOCX runtime preparation and captures failures", async () => {
    expect(await routeMessage({
      kind: "docx:prepare-runtime",
      codeTheme: "github-dark",
    }, okDeps)).toEqual({
      kind: "docx:prepare-runtime-result",
      ok: true,
      preparation,
    });
    expect(await routeMessage(
      { kind: "docx:prepare-runtime" },
      {
        ...okDeps,
        prepareDocxRuntime: async () => {
          throw new Error("font unavailable");
        },
      },
    )).toEqual({
      kind: "docx:prepare-runtime-result",
      ok: false,
      error: "font unavailable",
    });
  });

  it("wakes the common queue with opaque ids only", async () => {
    const jobId = "job-1";
    expect(await routeMessage({ kind: "jobs:wake", jobIds: [jobId] }, okDeps)).toEqual({
      kind: "jobs:wake-result",
      claimedJobId: jobId,
    });
  });

  it("forwards explicit waiting-job resume authority without broadening the id set", async () => {
    const observed: unknown[] = [];
    const jobId = "job-auth";
    expect(await routeMessage(
      { kind: "jobs:wake", jobIds: [jobId], resumeWaiting: true },
      {
        ...okDeps,
        runJobsWake: async (jobIds, options) => {
          observed.push(jobIds, options);
          return jobIds?.[0];
        },
      },
    )).toEqual({
      kind: "jobs:wake-result",
      claimedJobId: jobId,
    });
    expect(observed).toEqual([[jobId], { resumeWaiting: true }]);
  });

  it("returns a distinguishable common queue wake failure", async () => {
    expect(await routeMessage(
      { kind: "jobs:wake", jobIds: ["job-1"] },
      { ...okDeps, runJobsWake: async () => { throw new Error("catalog blocked"); } },
    )).toEqual({ kind: "jobs:wake-result", error: "catalog blocked" });
  });

  it("routes research runs and cancellation without carrying a credential", async () => {
    const request = {
      schema: "atlcli.research-request/v1",
    } as ResearchRequestV1;
    const policy = {
      schema: "atlcli.research-one-shot-policy/v1",
      requestedEffort: "analysis",
      requestedPlanApproval: "automatic",
      scopeExpansionMode: "ask",
      requestedReconciliation: "auto",
    } as const;
    const observed: unknown[] = [];
    const qualityPolicy = {
      mode: "quick",
      delegation: "disabled",
      completionTarget: "direct",
      planning: "none",
      scopeExpansion: "deny",
      providerReasoningPreference: "fast",
    } as const;
    expect(await routeMessage({
      kind: "research:run",
      runId: "run-1",
      sessionId: "research-session:run-1",
      turnId: "research-turn:run-1",
      windowId: 7,
      mode: "chat",
      request,
      policy,
      qualityPolicy,
    }, {
      ...okDeps,
      runResearch: async (_runId, _sessionId, _turnId, _windowId, mode, _request, receivedPolicy, receivedQuality) => {
        observed.push(mode, receivedPolicy, receivedQuality);
        return researchReport;
      },
    })).toEqual({
      kind: "research:run-result",
      runId: "run-1",
      ok: true,
      report: researchReport,
    });
    expect(observed).toEqual(["chat", policy, qualityPolicy]);
    expect(await routeMessage({
      kind: "research:cancel",
      runId: "run-1",
    }, okDeps)).toEqual({
      kind: "research:cancel-result",
      runId: "run-1",
      cancelled: true,
    });
    expect(await routeMessage({
      kind: "research:pause-session",
      runId: "run-1",
    }, {
      ...okDeps,
      requestResearchPause: async (runId) => {
        expect(runId).toBe("run-1");
        return "pause_requested";
      },
    })).toEqual({
      kind: "research:pause-session-result",
      runId: "run-1",
      ok: true,
      status: "pause_requested",
    });
    expect(await routeMessage({
      kind: "research:cancel-session",
      runId: "run-1",
    }, {
      ...okDeps,
      cancelResearchSession: async (runId) => runId === "run-1",
    })).toEqual({
      kind: "research:cancel-session-result",
      runId: "run-1",
      cancelled: true,
    });
    expect(JSON.stringify({
      kind: "research:run",
      runId: "run-1",
      sessionId: "research-session:run-1",
      turnId: "research-turn:run-1",
      windowId: 7,
      request,
      policy,
    })).not.toContain("apiKey");
    expect(observed).toEqual(["chat", policy, qualityPolicy]);
  });

  it("preserves a typed Chat question instead of flattening it into a research error", async () => {
    const question = {
      schema: CHAT_USER_QUESTION_SCHEMA_V1,
      id: "chat-question:window",
      prompt: "Which reporting window should I use?",
      required: true,
      responseKind: "free_text" as const,
      maxLength: 120,
    };
    const response = await routeMessage({
      kind: "research:run",
      runId: "run-hitl",
      sessionId: "research-session:hitl",
      turnId: "research-turn:hitl",
      windowId: 7,
      mode: "chat",
      request: { schema: "atlcli.research-request/v1" } as ResearchRequestV1,
      hostIdentity: {
        userId: "browser-principal:hitl",
        providerCacheIdentity: "provider-cache:hitl",
      },
    }, {
      ...okDeps,
      runResearch: async () => { throw new ChatUserQuestionRequiredError(question); },
    });
    expect(response).toMatchObject({
      kind: "research:run-result",
      ok: false,
      code: "clarification-required",
      question,
    });
  });

  it("routes a durable research resume with opaque identifiers only", async () => {
    const observed: unknown[] = [];
    expect(await routeMessage({
      kind: "research:resume",
      runId: "run-resume",
      sessionId: "research-session:resume",
      windowId: 7,
    }, {
      ...okDeps,
      resumeResearch: async (runId, sessionId, windowId) => {
        observed.push(runId, sessionId, windowId);
        return researchReport;
      },
    })).toEqual({
      kind: "research:resume-result",
      runId: "run-resume",
      ok: true,
      report: researchReport,
    });
    expect(observed).toEqual(["run-resume", "research-session:resume", 7]);
  });

  it("routes a revision-fenced durable session deletion without report content", async () => {
    const observed: unknown[] = [];
    expect(await routeMessage({
      kind: "research:delete-session",
      windowId: 7,
      sessionId: "research-session:terminal",
      revision: 12,
    }, {
      ...okDeps,
      deleteResearchSession: async (windowId, action) => {
        observed.push(windowId, action);
        return true;
      },
    })).toEqual({
      kind: "research:delete-session-result",
      ok: true,
      deleted: true,
    });
    expect(observed).toEqual([
      7,
      { sessionId: "research-session:terminal", revision: 12 },
    ]);
  });

  it("lists only host-projected resumable research sessions", async () => {
    const sessions = [{
      schema: "atlcli.research-resumable-session/v1" as const,
      sessionId: "research-session:resume",
      revision: 4,
      turnId: "research-turn:resume",
      status: "paused" as const,
      updatedAt: "2026-08-02T12:00:00.000Z",
      question: "Continue the durable research.",
      scope: { jiraProjectKeys: ["DEMO"], confluenceSpaceKeys: ["KB"] },
    }];
    expect(await routeMessage({
      kind: "research:list-resumable-sessions",
      windowId: 7,
    }, {
      ...okDeps,
      listResumableResearchSessions: async (windowId) => {
        expect(windowId).toBe(7);
        return sessions;
      },
    })).toEqual({
      kind: "research:list-resumable-sessions-result",
      ok: true,
      sessions,
    });
  });

  it("lists terminal sessions and prepares a revision-fenced follow-up without caller scope", async () => {
    const sessions = [{
      schema: "atlcli.research-retained-session/v1" as const,
      sessionId: "research-session:terminal",
      revision: 12,
      turnId: "research-turn:terminal",
      status: "complete" as const,
      updatedAt: "2026-08-02T12:00:00.000Z",
      question: "What did the original research establish?",
      scope: { jiraProjectKeys: ["DEMO"], confluenceSpaceKeys: ["KB"] },
    }];
    expect(await routeMessage({
      kind: "research:list-retained-sessions",
      windowId: 7,
    }, {
      ...okDeps,
      listRetainedResearchSessions: async (windowId) => {
        expect(windowId).toBe(7);
        return sessions;
      },
    })).toEqual({
      kind: "research:list-retained-sessions-result",
      ok: true,
      sessions,
    });

    const request = {
      kind: "research:prepare-follow-up-turn" as const,
      windowId: 7,
      sessionId: sessions[0]!.sessionId,
      revision: sessions[0]!.revision,
      question: "Which remaining evidence should be checked?",
    };
    expect(await routeMessage(request, {
      ...okDeps,
      prepareResearchFollowUpTurn: async (windowId, action) => {
        expect(windowId).toBe(7);
        expect(action).toEqual({
          sessionId: sessions[0]!.sessionId,
          revision: sessions[0]!.revision,
          question: request.question,
        });
        return {
          kind: "resumable" as const,
          session: {
            schema: "atlcli.research-resumable-session/v1" as const,
            sessionId: sessions[0]!.sessionId,
            revision: 16,
            turnId: "research-turn:follow-up",
            status: "running" as const,
            updatedAt: sessions[0]!.updatedAt,
            question: request.question,
            scope: sessions[0]!.scope,
          },
        };
      },
    })).toMatchObject({
      kind: "research:prepare-follow-up-turn-result",
      ok: true,
      outcome: { kind: "resumable", session: { turnId: "research-turn:follow-up" } },
    });
    expect(JSON.stringify(request)).not.toContain("scope");
    expect(JSON.stringify(request)).not.toContain("policy");
    expect(JSON.stringify(request)).not.toContain("limits");
  });

  it("routes revision-fenced steering without caller graph authority", async () => {
    const request = {
      kind: "research:steer-session" as const,
      windowId: 7,
      sessionId: "research-session:checkpoint",
      revision: 12,
      instruction: "Prioritize the approved comparison.",
    };
    expect(await routeMessage(request, {
      ...okDeps,
      requestResearchSteering: async (windowId, action) => {
        expect(windowId).toBe(7);
        expect(action).toEqual({
          sessionId: "research-session:checkpoint",
          revision: 12,
          instruction: "Prioritize the approved comparison.",
        });
        return {
          sessionId: "research-session:checkpoint",
          revision: 13,
          status: "waiting_steering",
        };
      },
    })).toEqual({
      kind: "research:steer-session-result",
      ok: true,
      sessionId: "research-session:checkpoint",
      revision: 13,
      status: "waiting_steering",
    });
  });

  it("routes revision-fenced body-free scope reviews without caller scope authority", async () => {
    const review: ResearchSessionScopeReviewV1 = {
      schema: "atlcli.research-session-scope-review/v1",
      sessionId: "research-session:scope-review",
      revision: 12,
      status: "waiting_scope_approval",
      updatedAt: "2026-08-02T12:00:00.000Z",
      turn: {
        id: "research-turn:scope-review",
        briefRevision: 3,
        graphRevision: 4,
        candidates: [{
          id: "research-scope-candidate:confluence-space-related",
          product: "confluence",
          entityKind: "space",
          key: "RELATED",
          name: "Related documentation",
        }],
        bindings: [],
        discoveryDispositions: [],
        expansionProposals: [{
          id: "scope-expansion:related-space",
          candidateId: "research-scope-candidate:confluence-space-related",
          expansionKind: "whole_scope",
          basedOnBriefRevision: 3,
          basedOnGraphRevision: 4,
          reason: "An exact reference was found.",
          status: "proposed",
        }],
        scopeRevisions: [],
      },
    };
    const request = {
      kind: "research:approve-scope-review" as const,
      windowId: 7,
      sessionId: review.sessionId,
      revision: review.revision,
      briefRevision: review.turn.briefRevision,
      graphRevision: review.turn.graphRevision,
      proposalId: review.turn.expansionProposals[0]!.id,
    };
    let observed: unknown;
    expect(await routeMessage(request, {
      ...okDeps,
      approveResearchScopeReview: async (windowId, action) => {
        observed = { windowId, action };
        return review;
      },
    })).toEqual({
      kind: "research:approve-scope-review-result",
      ok: true,
      review,
    });
    expect(observed).toEqual({
      windowId: 7,
      action: {
        sessionId: review.sessionId,
        revision: 12,
        briefRevision: 3,
        graphRevision: 4,
        proposalId: "scope-expansion:related-space",
      },
    });
    expect(JSON.stringify(request)).not.toContain("candidateId");
    expect(JSON.stringify(request)).not.toContain("tenantOrigin");
  });

  it("approves a replacement scope plan with revisions only", async () => {
    const review: ResearchSessionScopeReviewV1 = {
      schema: "atlcli.research-session-scope-review/v1",
      sessionId: "research-session:scope-plan-review",
      revision: 13,
      status: "waiting_plan_approval",
      updatedAt: "2026-08-02T12:00:00.000Z",
      turn: {
        id: "research-turn:scope-plan-review",
        briefRevision: 4,
        graphRevision: 5,
        candidates: [],
        bindings: [],
        discoveryDispositions: [],
        expansionProposals: [],
        scopeRevisions: [{
          id: "scope-revision:related-space",
          proposalId: "scope-expansion:related-space",
          basedOnBriefRevision: 3,
          basedOnGraphRevision: 4,
          revisedBriefRevision: 4,
          proposedGraphRevision: 5,
          state: "proposed",
        }],
      },
    };
    const request = {
      kind: "research:approve-scope-plan-review" as const,
      windowId: 7,
      sessionId: review.sessionId,
      revision: review.revision,
      briefRevision: review.turn.briefRevision,
      graphRevision: review.turn.graphRevision,
    };
    let observed: unknown;
    expect(await routeMessage(request, {
      ...okDeps,
      approveResearchScopePlanReview: async (windowId, action) => {
        observed = { windowId, action };
        return review;
      },
    })).toEqual({
      kind: "research:approve-scope-plan-review-result",
      ok: true,
      review,
    });
    expect(observed).toEqual({
      windowId: 7,
      action: {
        sessionId: review.sessionId,
        revision: 13,
        briefRevision: 4,
        graphRevision: 5,
      },
    });
    expect(JSON.stringify(request)).not.toContain("proposalId");
    expect(JSON.stringify(request)).not.toContain("tenantOrigin");
  });

  it("prepares and approves an initial plan with a revision fence only", async () => {
    const review = {
      schema: "atlcli.research-session-plan-review/v1" as const,
      sessionId: "research-session:plan-review",
      revision: 13,
      status: "waiting_plan_approval" as const,
      updatedAt: "2026-08-02T12:00:00.000Z",
      turn: {
        id: "research-turn:plan-review",
        briefRevision: 4,
        graphRevision: 5,
        resolvedEffort: "deep" as const,
        selectedRoleIds: ["focused-researcher"],
        scopeExpansionMode: "ask" as const,
        reconciliationMode: "required" as const,
        scope: { jiraProjectKeys: ["DEMO"], confluenceSpaceKeys: ["KB"] },
        budget: planReviewBudget,
      },
    };
    const request = {
      kind: "research:prepare-plan-review" as const,
      windowId: 7,
      request: { schema: "atlcli.research-request/v1" } as ResearchRequestV1,
      policy: { schema: "atlcli.research-one-shot-policy/v1" } as ResearchOneShotPolicyV1,
    };
    expect(await routeMessage(request, {
      ...okDeps,
      prepareResearchPlanReview: async (windowId, received, policy) => {
        expect(windowId).toBe(7);
        expect(received).toBe(request.request);
        expect(policy).toBe(request.policy);
        return review;
      },
    })).toEqual({ kind: "research:prepare-plan-review-result", ok: true, review });

    const approval = {
      kind: "research:approve-plan-review" as const,
      windowId: 7,
      sessionId: review.sessionId,
      revision: review.revision,
      briefRevision: review.turn.briefRevision,
      graphRevision: review.turn.graphRevision,
    };
    expect(await routeMessage(approval, {
      ...okDeps,
      approveResearchPlanReview: async (_windowId, action) => {
        expect(action).toEqual({
          sessionId: review.sessionId,
          revision: 13,
          briefRevision: 4,
          graphRevision: 5,
        });
        return {
          schema: "atlcli.research-resumable-session/v1",
          sessionId: review.sessionId,
          revision: 14,
          turnId: review.turn.id,
          status: "running",
          updatedAt: review.updatedAt,
          question: "not exposed by approval request",
          scope: review.turn.scope,
        };
      },
    })).toMatchObject({
      kind: "research:approve-plan-review-result",
      ok: true,
      session: { sessionId: review.sessionId },
    });
    expect(JSON.stringify(approval)).not.toContain("scope");

    const correction = {
      kind: "research:reject-plan-review" as const,
      windowId: 7,
      sessionId: review.sessionId,
      revision: review.revision,
      briefRevision: review.turn.briefRevision,
      graphRevision: review.turn.graphRevision,
      instruction: "Separate direct evidence from inferred relationships.",
    };
    expect(await routeMessage(correction, {
      ...okDeps,
      rejectResearchPlanReview: async (_windowId, action) => {
        expect(action).toEqual({
          sessionId: review.sessionId,
          revision: 13,
          briefRevision: 4,
          graphRevision: 5,
          instruction: "Separate direct evidence from inferred relationships.",
        });
        return {
          ...review,
          revision: 16,
          turn: { ...review.turn, briefRevision: 5, graphRevision: 6 },
        };
      },
    })).toMatchObject({
      kind: "research:reject-plan-review-result",
      ok: true,
      review: { sessionId: review.sessionId, revision: 16 },
    });
    expect(JSON.stringify(correction)).not.toContain("scope");
  });

  it("routes revision-fenced clarification answers and post-answer recovery", async () => {
    const review = {
      schema: "atlcli.research-session-clarification-review/v1" as const,
      sessionId: "research-session:clarification-review",
      revision: 13,
      status: "waiting_clarification" as const,
      stage: "answer_required" as const,
      updatedAt: "2026-08-02T12:00:00.000Z",
      turn: {
        id: "research-turn:clarification-review",
        briefRevision: 4,
        scope: { jiraProjectKeys: ["DEMO"], confluenceSpaceKeys: ["KB"] },
        questions: [{
          id: "clarification:window",
          prompt: "Which reporting window should be used?",
        }],
        assumptions: [{ id: "assumption:archive", text: "Include archived items." }],
      },
    };
    const prepare = {
      kind: "research:prepare-clarification-review" as const,
      windowId: 7,
      request: { schema: "atlcli.research-request/v1" } as ResearchRequestV1,
      policy: { schema: "atlcli.research-one-shot-policy/v1" } as ResearchOneShotPolicyV1,
    };
    expect(await routeMessage(prepare, {
      ...okDeps,
      prepareResearchClarificationReview: async (windowId, request, policy) => {
        expect({ windowId, request, policy }).toEqual({
          windowId: 7,
          request: prepare.request,
          policy: prepare.policy,
        });
        return review;
      },
    })).toEqual({
      kind: "research:prepare-clarification-review-result",
      ok: true,
      review,
    });

    const resolve = {
      kind: "research:resolve-clarification-review" as const,
      windowId: 7,
      sessionId: review.sessionId,
      revision: review.revision,
      briefRevision: review.turn.briefRevision,
      answers: [{ questionId: "clarification:window", response: "Use the latest week." }],
      assumptionDecisions: [{ assumptionId: "assumption:archive", decision: "rejected" as const }],
    };
    expect(await routeMessage(resolve, {
      ...okDeps,
      resolveResearchClarificationReview: async (_windowId, action) => {
        expect(action).toEqual({
          sessionId: review.sessionId,
          revision: 13,
          briefRevision: 4,
          answers: resolve.answers,
          assumptionDecisions: resolve.assumptionDecisions,
        });
        return {
          kind: "resumable" as const,
          session: {
            schema: "atlcli.research-resumable-session/v1" as const,
            sessionId: review.sessionId,
            revision: 14,
            turnId: review.turn.id,
            status: "running" as const,
            updatedAt: review.updatedAt,
            question: "not present in the request",
            scope: review.turn.scope,
          },
        };
      },
    })).toMatchObject({
      kind: "research:resolve-clarification-review-result",
      ok: true,
      outcome: { kind: "resumable", session: { sessionId: review.sessionId } },
    });
    expect(JSON.stringify(resolve)).not.toContain("scope");
    expect(JSON.stringify(resolve)).not.toContain("tenantOrigin");

    const continueRequest = {
      kind: "research:continue-clarification-review" as const,
      windowId: 7,
      sessionId: review.sessionId,
      revision: 14,
      briefRevision: 5,
    };
    expect(await routeMessage(continueRequest, {
      ...okDeps,
      continueResearchClarificationReview: async (_windowId, action) => {
        expect(action).toEqual({
          sessionId: review.sessionId,
          revision: 14,
          briefRevision: 5,
        });
        return {
          kind: "plan_review" as const,
          review: {
            schema: "atlcli.research-session-plan-review/v1" as const,
            sessionId: review.sessionId,
            revision: 15,
            status: "waiting_plan_approval" as const,
            updatedAt: review.updatedAt,
            turn: {
              id: review.turn.id,
              briefRevision: 5,
              graphRevision: 1,
              resolvedEffort: "analysis" as const,
              selectedRoleIds: ["focused-researcher"],
              scopeExpansionMode: "ask" as const,
              reconciliationMode: "auto" as const,
              scope: review.turn.scope,
              budget: planReviewBudget,
            },
          },
        };
      },
    })).toMatchObject({
      kind: "research:continue-clarification-review-result",
      ok: true,
      outcome: { kind: "plan_review" },
    });
  });

  it("routes catalog-only research scope preflight without an Anthropic key", async () => {
    const request = {
      schema: "atlcli.research-request/v1",
    } as ResearchRequestV1;
    const outcome: ResearchScopePreflightOutcomeV1 = {
      schema: "atlcli.research-scope-preflight-outcome/v1",
      kind: "clarification_required",
      clarification: {
        schema: "atlcli.research-clarification-required/v1",
        reason: "ambiguous",
        mentionId: "mention:scope-1",
        candidateIds: ["research-scope-candidate:confluence-space-a"],
        rerunGuidance: ["Pass --space <KEY>."],
      },
      candidateChoices: [],
      mentions: [],
      resolutions: [],
    };
    const options = {
      candidateSelections: [{
        schema: "atlcli.research-scope-candidate-selection/v1" as const,
        mentionId: "mention:scope-1",
        candidateId: "research-scope-candidate:confluence-space-a",
      }],
    };
    let observedOptions: unknown;
    expect(await routeMessage({
      kind: "research:resolve-scope",
      windowId: 7,
      request,
      options,
    }, {
      ...okDeps,
      resolveResearchScope: async (_windowId, _request, value) => {
        observedOptions = value;
        return outcome;
      },
    })).toEqual({
      kind: "research:resolve-scope-result",
      ok: true,
      outcome,
    });
    expect(JSON.stringify({
      kind: "research:resolve-scope",
      windowId: 7,
      request,
      options,
    })).not.toContain("apiKey");
    expect(observedOptions).toEqual(options);
  });

  it("routes a persisted scope choice with only its revision-fenced candidate selection", async () => {
    const request = {
      kind: "research:resolve-scope-clarification-review" as const,
      windowId: 7,
      sessionId: "research-session:scope-clarification-review",
      revision: 2,
      selection: {
        schema: "atlcli.research-scope-candidate-selection/v1" as const,
        mentionId: "mention:scope-1",
        candidateId: "research-scope-candidate:account-management",
      },
    };
    expect(await routeMessage(request, {
      ...okDeps,
      resolveResearchScopeClarificationReview: async (windowId, action) => {
        expect({ windowId, action }).toEqual({
          windowId: 7,
          action: {
            sessionId: request.sessionId,
            revision: 2,
            selection: request.selection,
          },
        });
        return {
          kind: "scope_clarification" as const,
          review: {
            schema: "atlcli.research-session-scope-clarification-review/v1" as const,
            sessionId: request.sessionId,
            revision: 3,
            status: "waiting_scope_clarification" as const,
            stage: "choice_required" as const,
            updatedAt: "2026-08-02T12:00:00.000Z",
            clarification: {
              mentionId: "mention:scope-1",
              reason: "ambiguous" as const,
              rerunGuidance: ["Choose a scope."],
              candidates: [],
            },
          },
        };
      },
    })).toMatchObject({
      kind: "research:resolve-scope-clarification-review-result",
      ok: true,
      outcome: { kind: "scope_clarification", review: { revision: 3 } },
    });
    expect(JSON.stringify(request)).not.toContain("tenantOrigin");
    expect(JSON.stringify(request)).not.toContain("scope:");
  });

  it("preserves the Chat purpose while preparing a durable scope clarification", async () => {
    const review = {
      schema: "atlcli.research-session-scope-clarification-review/v1" as const,
      sessionId: "research-session:chat-scope-choice",
      purpose: "chat" as const,
      revision: 3,
      status: "waiting_scope_clarification" as const,
      stage: "choice_required" as const,
      updatedAt: "2026-08-05T12:00:00.000Z",
      clarification: {
        mentionId: "mention:space",
        reason: "ambiguous" as const,
        rerunGuidance: ["Choose the intended space."],
        candidates: [],
      },
    };
    const request = {
      kind: "research:prepare-scope-clarification-review" as const,
      windowId: 7,
      request: { schema: "atlcli.research-request/v1" } as ResearchRequestV1,
      policy: { schema: "atlcli.research-one-shot-policy/v1" } as ResearchOneShotPolicyV1,
      purpose: "chat" as const,
    };
    expect(await routeMessage(request, {
      ...okDeps,
      prepareResearchScopeClarificationReview: async (windowId, input, policy, purpose) => {
        expect({ windowId, input, policy, purpose }).toEqual({
          windowId: 7,
          input: request.request,
          policy: request.policy,
          purpose: "chat",
        });
        return review;
      },
    })).toEqual({
      kind: "research:prepare-scope-clarification-review-result",
      ok: true,
      review,
    });
  });
});
