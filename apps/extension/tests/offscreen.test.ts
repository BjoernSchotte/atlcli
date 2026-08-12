import { afterEach, describe, expect, it } from "bun:test";
import {
  closeOffscreen,
  ensureCompatibleOffscreen,
  ensureOffscreen,
  __resetOffscreenState,
  type CompatibleOffscreenChrome,
  type OffscreenChrome,
} from "../utils/offscreen.js";

/** Build a mock chrome whose offscreen document "exists" once created. */
function makeMockChrome(startsExisting = false) {
  const state = { exists: startsExisting, createCalls: 0, closeCalls: 0 };
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
      closeDocument: async () => {
        state.closeCalls += 1;
        state.exists = false;
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
        closeDocument: async () => {},
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
        closeDocument: async () => {},
      },
    };
    await ensureOffscreen(chrome);
    expect(captured.reasons).toEqual(["WORKERS"]);
    expect(captured.justification && captured.justification.length).toBeGreaterThan(0);
  });
});

describe("closeOffscreen", () => {
  it("closes the document when one exists", async () => {
    const { chrome, state } = makeMockChrome(true);
    await closeOffscreen(chrome);
    expect(state.closeCalls).toBe(1);
    expect(state.exists).toBe(false);
  });

  it("is a no-op when no document exists", async () => {
    const { chrome, state } = makeMockChrome(false);
    await closeOffscreen(chrome);
    expect(state.closeCalls).toBe(0);
  });

  it("lets a subsequent ensureOffscreen re-create the document", async () => {
    const { chrome, state } = makeMockChrome(false);
    await ensureOffscreen(chrome); // create
    await closeOffscreen(chrome); // close
    await ensureOffscreen(chrome); // re-create
    expect(state.createCalls).toBe(2);
    expect(state.closeCalls).toBe(1);
    expect(state.exists).toBe(true);
  });
});

describe("ensureCompatibleOffscreen", () => {
  it("keeps an offscreen document with the current runtime protocol", async () => {
    const { chrome: base, state } = makeMockChrome(true);
    const chrome: CompatibleOffscreenChrome = {
      ...base,
      runtime: {
        ...base.runtime,
        sendMessage: async () => ({
          kind: "offscreen:runtime-protocol-result",
          version: 1,
        }),
      },
    };

    await ensureCompatibleOffscreen(chrome);

    expect(state.closeCalls).toBe(0);
    expect(state.createCalls).toBe(0);
  });

  it("replaces a stale retained document without deleting durable data", async () => {
    const { chrome: base, state } = makeMockChrome(true);
    let handshakes = 0;
    const chrome: CompatibleOffscreenChrome = {
      ...base,
      runtime: {
        ...base.runtime,
        sendMessage: async () => {
          handshakes += 1;
          return handshakes === 1
            ? undefined
            : { kind: "offscreen:runtime-protocol-result", version: 1 };
        },
      },
    };

    await ensureCompatibleOffscreen(chrome);

    expect(state.closeCalls).toBe(1);
    expect(state.createCalls).toBe(1);
    expect(state.exists).toBe(true);
  });

  it("coalesces concurrent protocol checks", async () => {
    const { chrome: base } = makeMockChrome(true);
    let handshakes = 0;
    const chrome: CompatibleOffscreenChrome = {
      ...base,
      runtime: {
        ...base.runtime,
        sendMessage: async () => {
          handshakes += 1;
          return { kind: "offscreen:runtime-protocol-result", version: 1 };
        },
      },
    };

    await Promise.all([
      ensureCompatibleOffscreen(chrome),
      ensureCompatibleOffscreen(chrome),
    ]);

    expect(handshakes).toBe(1);
  });
});
