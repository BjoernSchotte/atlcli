import { describe, expect, it } from "bun:test";
import {
  handleExtMessage,
  handleOffscreenMessage,
  type OffscreenListenerDeps,
} from "../utils/listeners.js";
import type { ExtResponse, OffscreenResponse } from "../utils/messages.js";
import type {
  ResearchReportV1,
  ResearchRequestV1,
} from "../utils/research/contracts.js";
import type { RouterDeps } from "../utils/router.js";
import {
  CHAT_USER_QUESTION_SCHEMA_V1,
  ChatUserQuestionRequiredError,
  createChatInteractionStateV1,
} from "@atlcli/research";

const preparation = {
  totalMs: 12,
  highlightingMs: 8,
  codeFontMs: 10,
  codeFontBytes: 273_900,
};
const okRouterDeps: RouterDeps = {
  runWasmSmoke: async (a, b) => a + b,
  getCurrentEntity: async (windowId) => ({ windowId, url: null, entity: null, seq: 0 }),
  runPdfCompile: async () => ({ ok: true }),
  runPdfCancel: async () => true,
  prepareDocxRuntime: async () => preparation,
  runJobsWake: async (jobIds) => jobIds?.[0],
};
const okOffscreenDeps: OffscreenListenerDeps = {
  runWasmAdd: async (a, b) => a + b,
  runPdfCompile: async () => ({ ok: true }),
  runPdfCancel: async () => true,
  prepareDocxRuntime: async () => preparation,
  runJobsWake: async (jobIds) => jobIds?.[0],
};

/**
 * A sendResponse spy that also exposes a promise resolving when it is called,
 * so tests can deterministically await the async response (no timers).
 */
function captureResponse<T>() {
  let resolve: () => void = () => {};
  const called = new Promise<void>((r) => (resolve = r));
  const values: T[] = [];
  const sendResponse = (v: T) => {
    values.push(v);
    resolve();
  };
  return { sendResponse, called, values };
}

/**
 * Regression (finding 8): the load-bearing `return true` in both onMessage
 * listeners keeps the async response channel open. These tests assert (a) the
 * adapter returns true for handled async messages, and (b) sendResponse is
 * eventually called with the routed result/error — for both listeners.
 */
describe("handleExtMessage (background listener adapter)", () => {
  it("returns false and never responds for non-request messages", () => {
    const cap = captureResponse<ExtResponse>();
    const ret = handleExtMessage(
      { kind: "offscreen:wasm-add", a: 1, b: 2 },
      cap.sendResponse,
      okRouterDeps
    );
    expect(ret).toBe(false);
    expect(cap.values).toEqual([]);
  });

  it("returns true and eventually responds pong to ping", async () => {
    const cap = captureResponse<ExtResponse>();
    const ret = handleExtMessage({ kind: "ping" }, cap.sendResponse, okRouterDeps);
    expect(ret).toBe(true); // channel kept open
    await cap.called;
    expect(cap.values).toEqual([{ kind: "pong" }]);
  });

  it("returns true and responds with the routed wasm-smoke result", async () => {
    const cap = captureResponse<ExtResponse>();
    const ret = handleExtMessage(
      { kind: "wasm-smoke", a: 40, b: 2 },
      cap.sendResponse,
      okRouterDeps
    );
    expect(ret).toBe(true);
    await cap.called;
    expect(cap.values).toEqual([{ kind: "wasm-smoke-result", ok: true, result: 42 }]);
  });

  it("responds with an error response when the effect rejects", async () => {
    const cap = captureResponse<ExtResponse>();
    const ret = handleExtMessage(
      { kind: "wasm-smoke", a: 1, b: 2 },
      cap.sendResponse,
      {
        runWasmSmoke: async () => {
          throw new Error("boom");
        },
        getCurrentEntity: async (windowId) => ({ windowId, url: null, entity: null, seq: 0 }),
        runPdfCompile: okRouterDeps.runPdfCompile,
        runPdfCancel: okRouterDeps.runPdfCancel,
      }
    );
    expect(ret).toBe(true);
    await cap.called;
    expect(cap.values).toEqual([
      { kind: "wasm-smoke-result", ok: false, error: "boom" },
    ]);
  });

  it("returns true and responds to PDF compile", async () => {
    const cap = captureResponse<ExtResponse>();
    const jobId = "123e4567-e89b-42d3-a456-426614174000";
    const ret = handleExtMessage({ kind: "pdf:compile", jobId }, cap.sendResponse, okRouterDeps);
    expect(ret).toBe(true);
    await cap.called;
    expect(cap.values).toEqual([{ kind: "pdf:compile-result", jobId, ok: true }]);
  });

  it("returns true and responds to a common queue wake", async () => {
    const cap = captureResponse<ExtResponse>();
    const jobId = "job-1";
    expect(handleExtMessage({ kind: "jobs:wake", jobIds: [jobId] }, cap.sendResponse, okRouterDeps)).toBe(true);
    await cap.called;
    expect(cap.values).toEqual([{ kind: "jobs:wake-result", claimedJobId: jobId }]);
  });

  it("returns true and lists host-projected resumable research sessions", async () => {
    const cap = captureResponse<ExtResponse>();
    expect(handleExtMessage(
      { kind: "research:list-resumable-sessions", windowId: 7 },
      cap.sendResponse,
      {
        ...okRouterDeps,
        listResumableResearchSessions: async () => [{
          schema: "atlcli.research-resumable-session/v1",
          sessionId: "research-session:resume",
          revision: 4,
          turnId: "research-turn:resume",
          status: "paused",
          updatedAt: "2026-08-02T12:00:00.000Z",
          question: "Continue the durable research.",
          scope: { jiraProjectKeys: ["DEMO"], confluenceSpaceKeys: ["KB"] },
        }],
      },
    )).toBe(true);
    await cap.called;
    expect(cap.values).toEqual([{
      kind: "research:list-resumable-sessions-result",
      ok: true,
      sessions: [{
        schema: "atlcli.research-resumable-session/v1",
        sessionId: "research-session:resume",
        revision: 4,
        turnId: "research-turn:resume",
        status: "paused",
        updatedAt: "2026-08-02T12:00:00.000Z",
        question: "Continue the durable research.",
        scope: { jiraProjectKeys: ["DEMO"], confluenceSpaceKeys: ["KB"] },
      }],
    }]);
  });

  it("returns true and lists tenant-bound scope reviews", async () => {
    const cap = captureResponse<ExtResponse>();
    expect(handleExtMessage(
      { kind: "research:list-scope-reviews", windowId: 7 },
      cap.sendResponse,
      {
        ...okRouterDeps,
        listResearchScopeReviews: async (windowId) => {
          expect(windowId).toBe(7);
          return [];
        },
      },
    )).toBe(true);
    await cap.called;
    expect(cap.values).toEqual([{
      kind: "research:list-scope-reviews-result",
      ok: true,
      reviews: [],
    }]);
  });

  it("returns true and lists tenant-bound replacement-plan reviews", async () => {
    const cap = captureResponse<ExtResponse>();
    expect(handleExtMessage(
      { kind: "research:list-scope-plan-reviews", windowId: 7 },
      cap.sendResponse,
      {
        ...okRouterDeps,
        listResearchScopePlanReviews: async (windowId) => {
          expect(windowId).toBe(7);
          return [];
        },
      },
    )).toBe(true);
    await cap.called;
    expect(cap.values).toEqual([{
      kind: "research:list-scope-plan-reviews-result",
      ok: true,
      reviews: [],
    }]);
  });

  it("returns true and lists tenant-bound initial plan reviews", async () => {
    const cap = captureResponse<ExtResponse>();
    expect(handleExtMessage(
      { kind: "research:list-plan-reviews", windowId: 7 },
      cap.sendResponse,
      {
        ...okRouterDeps,
        listResearchPlanReviews: async (windowId) => {
          expect(windowId).toBe(7);
          return [];
        },
      },
    )).toBe(true);
    await cap.called;
    expect(cap.values).toEqual([{
      kind: "research:list-plan-reviews-result",
      ok: true,
      reviews: [],
    }]);
  });

  it("returns true and lists tenant-bound clarification reviews", async () => {
    const cap = captureResponse<ExtResponse>();
    expect(handleExtMessage(
      { kind: "research:list-clarification-reviews", windowId: 7 },
      cap.sendResponse,
      {
        ...okRouterDeps,
        listResearchClarificationReviews: async (windowId) => {
          expect(windowId).toBe(7);
          return [];
        },
      },
    )).toBe(true);
    await cap.called;
    expect(cap.values).toEqual([{
      kind: "research:list-clarification-reviews-result",
      ok: true,
      reviews: [],
    }]);
  });

  it("returns true and lists tenant-bound pre-brief scope clarification reviews", async () => {
    const cap = captureResponse<ExtResponse>();
    expect(handleExtMessage(
      { kind: "research:list-scope-clarification-reviews", windowId: 7 },
      cap.sendResponse,
      {
        ...okRouterDeps,
        listResearchScopeClarificationReviews: async (windowId) => {
          expect(windowId).toBe(7);
          return [];
        },
      },
    )).toBe(true);
    await cap.called;
    expect(cap.values).toEqual([{
      kind: "research:list-scope-clarification-reviews-result",
      ok: true,
      reviews: [],
    }]);
  });

  it("returns true and responds to DOCX runtime preparation", async () => {
    const cap = captureResponse<ExtResponse>();
    expect(handleExtMessage(
      { kind: "docx:prepare-runtime", codeTheme: "github-dark" },
      cap.sendResponse,
      okRouterDeps,
    )).toBe(true);
    await cap.called;
    expect(cap.values).toEqual([{
      kind: "docx:prepare-runtime-result",
      ok: true,
      preparation,
    }]);
  });
});

describe("handleOffscreenMessage (offscreen listener adapter)", () => {
  it("returns false and never responds for non-offscreen messages", () => {
    const cap = captureResponse<OffscreenResponse>();
    const ret = handleOffscreenMessage({ kind: "ping" }, cap.sendResponse, okOffscreenDeps);
    expect(ret).toBe(false);
    expect(cap.values).toEqual([]);
  });

  it("returns true and eventually responds with the wasm-add result", async () => {
    const cap = captureResponse<OffscreenResponse>();
    const ret = handleOffscreenMessage(
      { kind: "offscreen:wasm-add", a: 40, b: 2 },
      cap.sendResponse,
      okOffscreenDeps
    );
    expect(ret).toBe(true); // channel kept open
    await cap.called;
    expect(cap.values).toEqual([
      { kind: "offscreen:wasm-add-result", ok: true, result: 42 },
    ]);
  });

  it("returns true and responds with an error when instantiation rejects", async () => {
    const cap = captureResponse<OffscreenResponse>();
    const ret = handleOffscreenMessage(
      { kind: "offscreen:wasm-add", a: 1, b: 2 },
      cap.sendResponse,
      {
        runWasmAdd: async () => {
          throw new Error("instantiate boom");
        },
        runPdfCompile: okOffscreenDeps.runPdfCompile,
        runPdfCancel: okOffscreenDeps.runPdfCancel,
      }
    );
    expect(ret).toBe(true);
    await cap.called;
    expect(cap.values).toEqual([
      { kind: "offscreen:wasm-add-result", ok: false, error: "instantiate boom" },
    ]);
  });

  it("returns true and responds to an offscreen PDF compile", async () => {
    const cap = captureResponse<OffscreenResponse>();
    const jobId = "123e4567-e89b-42d3-a456-426614174000";
    const ret = handleOffscreenMessage(
      { kind: "offscreen:pdf-compile", jobId },
      cap.sendResponse,
      okOffscreenDeps
    );
    expect(ret).toBe(true);
    await cap.called;
    expect(cap.values).toEqual([{ kind: "offscreen:pdf-compile-result", jobId, ok: true }]);
  });

  it("returns true and responds to an offscreen queue wake", async () => {
    const cap = captureResponse<OffscreenResponse>();
    const jobId = "job-1";
    expect(handleOffscreenMessage(
      { kind: "offscreen:jobs-wake", jobIds: [jobId] },
      cap.sendResponse,
      okOffscreenDeps,
    )).toBe(true);
    await cap.called;
    expect(cap.values).toEqual([{ kind: "offscreen:jobs-wake-result", claimedJobId: jobId }]);
  });

  it("returns true and responds to offscreen DOCX runtime preparation", async () => {
    const cap = captureResponse<OffscreenResponse>();
    expect(handleOffscreenMessage(
      { kind: "offscreen:docx-prepare-runtime", codeTheme: "github-light" },
      cap.sendResponse,
      okOffscreenDeps,
    )).toBe(true);
    await cap.called;
    expect(cap.values).toEqual([{
      kind: "offscreen:docx-prepare-runtime-result",
      ok: true,
      preparation,
    }]);
  });

  it("passes the transient session key only to the offscreen research host", async () => {
    const cap = captureResponse<OffscreenResponse>();
    const report = { schema: "atlcli.research-report/v1" } as ResearchReportV1;
    const request = { schema: "atlcli.research-request/v1" } as ResearchRequestV1;
    const policy = {
      schema: "atlcli.research-one-shot-policy/v1",
      requestedEffort: "analysis",
      requestedPlanApproval: "automatic",
      scopeExpansionMode: "ask",
      requestedReconciliation: "auto",
    } as const;
    const received: unknown[] = [];
    const qualityPolicy = {
      mode: "quick",
      delegation: "disabled",
      completionTarget: "direct",
      planning: "none",
      scopeExpansion: "deny",
      providerReasoningPreference: "fast",
    } as const;
    const hostIdentity = {
      userId: "browser-principal:synthetic-listener",
      providerCacheIdentity: "anthropic:browser-principal:synthetic-listener",
    } as const;
    expect(handleOffscreenMessage(
      {
        kind: "offscreen:research-run",
        runId: "run-1",
        sessionId: "research-session:run-1",
        turnId: "research-turn:run-1",
        apiKey: "sk-ant-test-listener",
        mode: "chat",
        request,
        policy,
        qualityPolicy,
        hostIdentity,
        resumeCheckpoint: { kind: "steering" },
      },
      cap.sendResponse,
      {
        ...okOffscreenDeps,
        runResearch: async (
          runId,
          sessionId,
          turnId,
          apiKey,
          mode,
          receivedRequest,
          receivedPolicy,
          receivedQuality,
          receivedIdentity,
          _answer,
          receivedCheckpoint,
        ) => {
          received.push(
            runId,
            sessionId,
            turnId,
            apiKey,
            mode,
            receivedRequest,
            receivedPolicy,
            receivedQuality,
            receivedIdentity,
            receivedCheckpoint,
          );
          return report;
        },
      },
    )).toBe(true);
    await cap.called;
    expect(received).toEqual([
      "run-1",
      "research-session:run-1",
      "research-turn:run-1",
      "sk-ant-test-listener",
      "chat",
      request,
      policy,
      qualityPolicy,
      hostIdentity,
      { kind: "steering" },
    ]);
    expect(cap.values).toEqual([{
      kind: "offscreen:research-run-result",
      runId: "run-1",
      ok: true,
      report,
    }]);
  });

  it("returns a typed durable Chat question from the offscreen host", async () => {
    const cap = captureResponse<OffscreenResponse>();
    const question = {
      schema: CHAT_USER_QUESTION_SCHEMA_V1,
      id: "chat-question:scope",
      prompt: "Which approved scope should I use?",
      required: true,
      responseKind: "free_text" as const,
      maxLength: 200,
    };
    expect(handleOffscreenMessage({
      kind: "offscreen:research-run",
      runId: "run-hitl",
      sessionId: "research-session:hitl",
      turnId: "research-turn:hitl",
      apiKey: "sk-ant-test-listener",
      mode: "chat",
      request: { schema: "atlcli.research-request/v1" } as ResearchRequestV1,
      hostIdentity: {
        userId: "browser-principal:hitl",
        providerCacheIdentity: "provider-cache:hitl",
      },
    }, cap.sendResponse, {
      ...okOffscreenDeps,
      runResearch: async () => { throw new ChatUserQuestionRequiredError(question); },
    })).toBe(true);
    await cap.called;
    expect(cap.values).toEqual([expect.objectContaining({
      kind: "offscreen:research-run-result",
      runId: "run-hitl",
      ok: false,
      code: "clarification-required",
      question,
    })]);
  });

  it("passes only opaque IDs and the transient key to the offscreen resume host", async () => {
    const cap = captureResponse<OffscreenResponse>();
    const report = { schema: "atlcli.research-report/v1" } as ResearchReportV1;
    const received: unknown[] = [];
    expect(handleOffscreenMessage(
      {
        kind: "offscreen:research-resume",
        runId: "run-resume",
        sessionId: "research-session:resume",
        turnId: "research-turn:resume",
        apiKey: "sk-ant-test-listener",
      },
      cap.sendResponse,
      {
        ...okOffscreenDeps,
        resumeResearch: async (runId, sessionId, turnId, apiKey) => {
          received.push(runId, sessionId, turnId, apiKey);
          return report;
        },
      },
    )).toBe(true);
    await cap.called;
    expect(received).toEqual([
      "run-resume",
      "research-session:resume",
      "research-turn:resume",
      "sk-ant-test-listener",
    ]);
    expect(cap.values).toEqual([{
      kind: "offscreen:research-resume-result",
      runId: "run-resume",
      ok: true,
      report,
    }]);
  });

  it("pauses an offscreen worker using only its opaque run id", async () => {
    const cap = captureResponse<OffscreenResponse>();
    const received: string[] = [];
    expect(handleOffscreenMessage(
      { kind: "offscreen:research-pause", runId: "run-pause" },
      cap.sendResponse,
      {
        ...okOffscreenDeps,
        pauseResearch: async (runId) => {
          received.push(runId);
          return true;
        },
      },
    )).toBe(true);
    await cap.called;
    expect(received).toEqual(["run-pause"]);
    expect(cap.values).toEqual([{
      kind: "offscreen:research-pause-result",
      runId: "run-pause",
      paused: true,
    }]);
  });

  it("keeps Chat controls correlated through the offscreen worker host", async () => {
    const state = createChatInteractionStateV1({
      conversationId: "research-session:chat-control",
      binding: {
        userId: "browser-principal:chat-control",
        providerCacheIdentity: "anthropic:browser-principal:chat-control",
        threadId: "research-session:chat-control",
        tenantOrigin: "https://example.atlassian.net",
      },
      createdAt: "2026-08-06T10:00:00.000Z",
    });
    const cap = captureResponse<OffscreenResponse>();
    const received: unknown[] = [];
    const control = {
      kind: "enqueue" as const,
      expectedRevision: 1,
      messageId: "chat-message:next",
      content: "Check this next.",
      at: "2026-08-06T10:00:01.000Z",
    };
    expect(handleOffscreenMessage({
      kind: "offscreen:research-chat-control",
      runId: "run-chat-control",
      controlId: "chat-control:1",
      control,
    }, cap.sendResponse, {
      ...okOffscreenDeps,
      controlChat: async (runId, controlId, receivedControl) => {
        received.push(runId, controlId, receivedControl);
        return state;
      },
    })).toBe(true);
    await cap.called;
    expect(received).toEqual(["run-chat-control", "chat-control:1", control]);
    expect(cap.values).toEqual([{
      kind: "offscreen:research-chat-control-result",
      runId: "run-chat-control",
      controlId: "chat-control:1",
      ok: true,
      state,
    }]);
  });

  it("keeps an offscreen queue wake failure distinct from an empty queue", async () => {
    const cap = captureResponse<OffscreenResponse>();
    expect(handleOffscreenMessage(
      { kind: "offscreen:jobs-wake", jobIds: ["job-1"] },
      cap.sendResponse,
      { ...okOffscreenDeps, runJobsWake: async () => { throw new Error("catalog blocked"); } },
    )).toBe(true);
    await cap.called;
    expect(cap.values).toEqual([{ kind: "offscreen:jobs-wake-result", error: "catalog blocked" }]);
  });
});
