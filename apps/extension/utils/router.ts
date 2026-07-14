/**
 * Pure message router (functional core — spec 002 Task 3).
 *
 * `routeMessage` is a pure async function of (request, injected effects) ->
 * response. It contains ZERO references to `chrome.*` or any ambient global,
 * so it is exhaustively unit-testable. The imperative shell (background.ts)
 * wires the real effects (offscreen round-trip) into `RouterDeps` and adapts
 * the result onto `chrome.runtime.onMessage`.
 */
import type { ExtRequest, ExtResponse } from "./messages.js";

/** Injected side effects the router needs to fulfil requests. */
export interface RouterDeps {
  /** Runs the WASM smoke computation (in practice: round-trip to offscreen). */
  runWasmSmoke: (a: number, b: number) => Promise<number>;
}

/**
 * Route one request to its response. Never throws: the `wasm-smoke` failure
 * path is captured and returned as an error response so the panel gets a
 * message instead of a hang (Task 5 failure path).
 */
export async function routeMessage(
  msg: ExtRequest,
  deps: RouterDeps
): Promise<ExtResponse> {
  switch (msg.kind) {
    case "ping":
      return { kind: "pong" };
    case "wasm-smoke": {
      try {
        const result = await deps.runWasmSmoke(msg.a, msg.b);
        return { kind: "wasm-smoke-result", ok: true, result };
      } catch (err) {
        return {
          kind: "wasm-smoke-result",
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }
    default: {
      // Exhaustiveness: adding a request kind without handling it fails typecheck.
      const _exhaustive: never = msg;
      return _exhaustive;
    }
  }
}
