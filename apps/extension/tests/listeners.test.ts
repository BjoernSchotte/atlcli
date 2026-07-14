import { describe, expect, it } from "bun:test";
import {
  handleExtMessage,
  handleOffscreenMessage,
  type OffscreenListenerDeps,
} from "../utils/listeners.js";
import type { ExtResponse, OffscreenResponse } from "../utils/messages.js";
import type { RouterDeps } from "../utils/router.js";

const okRouterDeps: RouterDeps = { runWasmSmoke: async (a, b) => a + b };
const okOffscreenDeps: OffscreenListenerDeps = { runWasmAdd: async (a, b) => a + b };

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
      }
    );
    expect(ret).toBe(true);
    await cap.called;
    expect(cap.values).toEqual([
      { kind: "wasm-smoke-result", ok: false, error: "boom" },
    ]);
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
      }
    );
    expect(ret).toBe(true);
    await cap.called;
    expect(cap.values).toEqual([
      { kind: "offscreen:wasm-add-result", ok: false, error: "instantiate boom" },
    ]);
  });
});
