import { describe, expect, it } from "bun:test";
import { routeMessage, type RouterDeps } from "../utils/router.js";
import type { EntityDetection } from "../utils/messages.js";
import type {
  ResearchReportV1,
  ResearchRequestV1,
} from "../utils/research/contracts.js";
import type { ResearchScopePreflightOutcomeV1 } from "@atlcli/research";

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
    expect(await routeMessage({
      kind: "research:run",
      runId: "run-1",
      sessionId: "research-session:run-1",
      turnId: "research-turn:run-1",
      windowId: 7,
      request,
      policy,
    }, {
      ...okDeps,
      runResearch: async (_runId, _sessionId, _turnId, _windowId, _request, receivedPolicy) => {
        observed.push(receivedPolicy);
        return researchReport;
      },
    })).toEqual({
      kind: "research:run-result",
      runId: "run-1",
      ok: true,
      report: researchReport,
    });
    expect(await routeMessage({
      kind: "research:cancel",
      runId: "run-1",
    }, okDeps)).toEqual({
      kind: "research:cancel-result",
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
    expect(observed).toEqual([policy]);
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
});
