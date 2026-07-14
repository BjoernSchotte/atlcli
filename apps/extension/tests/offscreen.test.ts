import { afterEach, describe, expect, it } from "bun:test";
import {
  ensureOffscreen,
  __resetOffscreenState,
  type OffscreenChrome,
} from "../utils/offscreen.js";

/** Build a mock chrome whose offscreen document "exists" once created. */
function makeMockChrome(startsExisting = false) {
  const state = { exists: startsExisting, createCalls: 0 };
  const chrome: OffscreenChrome = {
    runtime: {
      getURL: (p) => `chrome-extension://test-id/${p}`,
      getContexts: async () => (state.exists ? [{}] : []),
    },
    offscreen: {
      createDocument: async () => {
        state.createCalls += 1;
        state.exists = true;
      },
    },
  };
  return { chrome, state };
}

afterEach(() => __resetOffscreenState());

describe("ensureOffscreen", () => {
  it("creates the offscreen document when none exists", async () => {
    const { chrome, state } = makeMockChrome(false);
    await ensureOffscreen(chrome);
    expect(state.createCalls).toBe(1);
  });

  it("does not create a second document when one already exists", async () => {
    const { chrome, state } = makeMockChrome(true);
    await ensureOffscreen(chrome);
    expect(state.createCalls).toBe(0);
  });

  it("is idempotent across sequential invocations", async () => {
    const { chrome, state } = makeMockChrome(false);
    await ensureOffscreen(chrome);
    await ensureOffscreen(chrome);
    await ensureOffscreen(chrome);
    expect(state.createCalls).toBe(1);
  });

  it("coalesces concurrent double-invocation into one createDocument", async () => {
    const { chrome, state } = makeMockChrome(false);
    // getContexts resolves empty for both callers before either creates.
    await Promise.all([ensureOffscreen(chrome), ensureOffscreen(chrome)]);
    expect(state.createCalls).toBe(1);
  });

  it("does not create a second document when a stale getContexts resolves after creation (single-flight)", async () => {
    // Regression (finding 4): with the old "guard-after-getContexts" design, a
    // second caller whose getContexts resolves EMPTY only *after* the first
    // caller already created the document would create a duplicate. The
    // single-flight promise makes the second caller await the first operation
    // and never run its own getContexts.
    let releaseStale: (v: unknown[]) => void = () => {};
    const stale = new Promise<unknown[]>((r) => {
      releaseStale = r;
    });
    let getContextsCalls = 0;
    const state = { createCalls: 0 };
    const chrome: OffscreenChrome = {
      runtime: {
        getURL: (p) => p,
        getContexts: async () => {
          getContextsCalls += 1;
          // First caller: none exist. Any later caller: a STALE empty snapshot
          // that only resolves after the first create has completed.
          return getContextsCalls === 1 ? [] : stale;
        },
      },
      offscreen: {
        createDocument: async () => {
          state.createCalls += 1;
        },
      },
    };

    const a = ensureOffscreen(chrome);
    const b = ensureOffscreen(chrome);
    await a; // first caller creates the document
    releaseStale([]); // the stale empty getContexts result arrives now
    await b;

    expect(state.createCalls).toBe(1);
  });

  it("passes the WORKERS reason and a justification", async () => {
    const captured: { reasons?: string[]; justification?: string } = {};
    const chrome: OffscreenChrome = {
      runtime: {
        getURL: (p) => p,
        getContexts: async () => [],
      },
      offscreen: {
        createDocument: async (opts) => {
          captured.reasons = opts.reasons;
          captured.justification = opts.justification;
        },
      },
    };
    await ensureOffscreen(chrome);
    expect(captured.reasons).toEqual(["WORKERS"]);
    expect(captured.justification && captured.justification.length).toBeGreaterThan(0);
  });
});
