import { describe, expect, it } from "bun:test";
import { routeMessage, type RouterDeps } from "../utils/router.js";

const okDeps: RouterDeps = {
  runWasmSmoke: async (a, b) => a + b,
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
      }
    );
    expect(res).toEqual({
      kind: "wasm-smoke-result",
      ok: false,
      error: "plain string",
    });
  });
});
