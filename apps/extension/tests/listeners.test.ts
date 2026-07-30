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
    const received: unknown[] = [];
    expect(handleOffscreenMessage(
      {
        kind: "offscreen:research-run",
        runId: "run-1",
        apiKey: "sk-ant-test-listener",
        request,
      },
      cap.sendResponse,
      {
        ...okOffscreenDeps,
        runResearch: async (runId, apiKey, receivedRequest) => {
          received.push(runId, apiKey, receivedRequest);
          return report;
        },
      },
    )).toBe(true);
    await cap.called;
    expect(received).toEqual(["run-1", "sk-ant-test-listener", request]);
    expect(cap.values).toEqual([{
      kind: "offscreen:research-run-result",
      runId: "run-1",
      ok: true,
      report,
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
