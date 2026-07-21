/**
 * Pure message router (functional core — spec 002 Task 3).
 *
 * `routeMessage` is a pure async function of (request, injected effects) ->
 * response. It contains ZERO references to `chrome.*` or any ambient global,
 * so it is exhaustively unit-testable. The imperative shell (background.ts)
 * wires the real effects (offscreen round-trip) into `RouterDeps` and adapts
 * the result onto `chrome.runtime.onMessage`.
 */
import type {
  EntityDetection,
  ExtRequest,
  ExtResponse,
  PdfCompileHints,
} from "./messages.js";

/** Injected side effects the router needs to fulfil requests. */
export interface RouterDeps {
  /** Runs the WASM smoke computation (in practice: round-trip to offscreen). */
  runWasmSmoke: (a: number, b: number) => Promise<number>;
  /** Resolves the active tab's current entity (queries `chrome.tabs`). */
  getCurrentEntity: (windowId: number) => Promise<EntityDetection>;
  /**
   * Compiles a prepared PDF job through the offscreen worker. `hints` carries
   * the T5.3 scheduling metadata (`job` kind, estimated source `pages`); it is
   * advisory and every implementation must behave sanely when it is empty.
   */
  runPdfCompile: (
    jobId: string,
    hints?: PdfCompileHints
  ) => Promise<{ ok: true } | { ok: false; error: string }>;
  /** Cancels a queued or active PDF job. */
  runPdfCancel: (jobId: string) => Promise<boolean>;
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
    case "get-current-entity": {
      const detection = await deps.getCurrentEntity(msg.windowId);
      return { kind: "current-entity", detection };
    }
    case "pdf:compile": {
      try {
        const result = await deps.runPdfCompile(msg.jobId, { job: msg.job, pages: msg.pages });
        return result.ok
          ? { kind: "pdf:compile-result", jobId: msg.jobId, ok: true }
          : { kind: "pdf:compile-result", jobId: msg.jobId, ok: false, error: result.error };
      } catch (error) {
        return {
          kind: "pdf:compile-result",
          jobId: msg.jobId,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }
    case "pdf:cancel": {
      const cancelled = await deps.runPdfCancel(msg.jobId).catch(() => false);
      return { kind: "pdf:cancel-result", jobId: msg.jobId, cancelled };
    }
    default: {
      // Exhaustiveness: adding a request kind without handling it fails typecheck.
      const _exhaustive: never = msg;
      return _exhaustive;
    }
  }
}
