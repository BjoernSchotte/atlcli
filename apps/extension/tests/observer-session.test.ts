import { describe, expect, it } from "bun:test";
import {
  createObserverSession,
  type ObserverSessionStorage,
} from "../utils/observer-session.js";
import {
  initialObserverState,
  isObserverState,
  observeTab,
  type ObserverState,
} from "../utils/tab-observer.js";

interface TestState {
  seq: number;
  lastUrlByWindow: Record<string, string>;
}

const KEY = "tab-observer-state";

function isTestState(value: unknown): value is TestState {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<TestState>;
  return (
    Number.isSafeInteger(candidate.seq) &&
    (candidate.seq ?? -1) >= 0 &&
    !!candidate.lastUrlByWindow &&
    typeof candidate.lastUrlByWindow === "object" &&
    !Array.isArray(candidate.lastUrlByWindow) &&
    Object.values(candidate.lastUrlByWindow).every((url) => typeof url === "string")
  );
}

function initialState(): TestState {
  return { seq: 0, lastUrlByWindow: {} };
}

class MemoryStorage implements ObserverSessionStorage {
  readonly values: Record<string, unknown>;
  readonly writes: Record<string, unknown>[] = [];

  constructor(values: Record<string, unknown> = {}) {
    this.values = { ...values };
  }

  async get(key: string): Promise<Record<string, unknown>> {
    return key in this.values ? { [key]: this.values[key] } : {};
  }

  async set(items: Record<string, unknown>): Promise<void> {
    this.writes.push(items);
    Object.assign(this.values, items);
  }
}

function makeSession(storage: ObserverSessionStorage) {
  return createObserverSession(storage, {
    key: KEY,
    initialState,
    isState: isTestState,
  });
}

describe("createObserverSession", () => {
  it("loads valid persisted state without rewriting it", async () => {
    const persisted: TestState = {
      seq: 17,
      lastUrlByWindow: { "4": "https://acme.atlassian.net/wiki/spaces/D/pages/1/A" },
    };
    const storage = new MemoryStorage({ [KEY]: persisted });

    expect(await makeSession(storage).load()).toEqual(persisted);
    expect(storage.writes).toEqual([]);
  });

  it("repairs missing or invalid persisted state with a fresh initial value", async () => {
    for (const stored of [undefined, { seq: -1, lastUrlByWindow: [] }]) {
      const storage = new MemoryStorage(stored === undefined ? {} : { [KEY]: stored });

      expect(await makeSession(storage).load()).toEqual(initialState());
      expect(storage.writes).toEqual([{ [KEY]: initialState() }]);
    }
  });

  it("persists a transition before returning its value", async () => {
    const storage = new MemoryStorage({ [KEY]: initialState() });
    const session = makeSession(storage);

    const value = await session.mutate((state) => ({
      state: { seq: state.seq + 1, lastUrlByWindow: { "9": "https://example.test/b" } },
      value: "entity-changed",
    }));

    expect(value).toBe("entity-changed");
    expect(storage.values[KEY]).toEqual({
      seq: 1,
      lastUrlByWindow: { "9": "https://example.test/b" },
    });
  });

  it("serializes concurrent mutations so they cannot reuse one sequence", async () => {
    let releaseFirstWrite!: () => void;
    let signalFirstWrite!: () => void;
    const firstWriteBlocked = new Promise<void>((resolve) => {
      releaseFirstWrite = resolve;
    });
    const firstWriteStarted = new Promise<void>((resolve) => {
      signalFirstWrite = resolve;
    });
    const storage = new MemoryStorage({ [KEY]: initialState() });
    let writeCount = 0;
    storage.set = async (items: Record<string, unknown>): Promise<void> => {
      writeCount += 1;
      if (writeCount === 1) {
        signalFirstWrite();
        await firstWriteBlocked;
      }
      storage.writes.push(items);
      Object.assign(storage.values, items);
    };
    const session = makeSession(storage);
    const bump = () =>
      session.mutate((state) => ({
        state: { ...state, seq: state.seq + 1 },
        value: state.seq + 1,
      }));

    const first = bump();
    const second = bump();
    await firstWriteStarted;
    expect(writeCount).toBe(1);

    releaseFirstWrite();
    expect(await Promise.all([first, second])).toEqual([1, 2]);
    expect(storage.values[KEY]).toEqual({ seq: 2, lastUrlByWindow: {} });
  });

  it("serializes asynchronous transitions before later tab events", async () => {
    const storage = new MemoryStorage({ [KEY]: initialState() });
    const session = makeSession(storage);
    let releaseQuery!: () => void;
    let signalQuery!: () => void;
    const queryBlocked = new Promise<void>((resolve) => (releaseQuery = resolve));
    const queryStarted = new Promise<void>((resolve) => (signalQuery = resolve));
    let secondStarted = false;

    const pull = session.mutate(async (state) => {
      signalQuery();
      await queryBlocked;
      return { state: { ...state, seq: state.seq + 1 }, value: state.seq + 1 };
    });
    const push = session.mutate((state) => {
      secondStarted = true;
      return { state: { ...state, seq: state.seq + 1 }, value: state.seq + 1 };
    });

    await queryStarted;
    expect(secondStarted).toBe(false);
    releaseQuery();
    expect(await Promise.all([pull, push])).toEqual([1, 2]);
  });

  it("continues the queue after a failed persistence without advancing cached state", async () => {
    const storage = new MemoryStorage({ [KEY]: initialState() });
    let fail = true;
    storage.set = async (items: Record<string, unknown>): Promise<void> => {
      if (fail) {
        fail = false;
        throw new Error("session storage unavailable");
      }
      storage.writes.push(items);
      Object.assign(storage.values, items);
    };
    const session = makeSession(storage);
    const bump = () =>
      session.mutate((state) => ({
        state: { ...state, seq: state.seq + 1 },
        value: state.seq + 1,
      }));

    expect(bump()).rejects.toThrow("session storage unavailable");
    expect(await bump()).toBe(1);
    expect(storage.values[KEY]).toEqual({ seq: 1, lastUrlByWindow: {} });
  });

  it("rejects invalid transition state without persisting it", async () => {
    const storage = new MemoryStorage({ [KEY]: initialState() });
    const session = makeSession(storage);

    expect(
      session.mutate(() => ({
        state: { seq: -1, lastUrlByWindow: {} },
        value: undefined,
      }))
    ).rejects.toThrow("transition returned an invalid state");
    expect(storage.writes).toEqual([]);
  });

  it("hydrates the real tab observer cursor across a worker restart", async () => {
    const observerKey = "real-tab-observer";
    const persisted: ObserverState = {
      seq: 4,
      lastEmittedUrlByWindow: {
        "7": "https://myco.atlassian.net/wiki/spaces/DOCSY/pages/100/A",
      },
    };
    const storage = new MemoryStorage({ [observerKey]: persisted });
    const restartedWorker = createObserverSession(storage, {
      key: observerKey,
      initialState: initialObserverState,
      isState: isObserverState,
    });

    const message = await restartedWorker.mutate((state) => {
      const result = observeTab(
        state,
        7,
        "https://myco.atlassian.net/wiki/spaces/DOCSY/pages/200/B"
      );
      return { state: result.state, value: result.message };
    });

    expect(message?.detection.seq).toBe(5);
    expect(message?.detection.entity).toMatchObject({ type: "page", pageId: "200" });
    expect(storage.values[observerKey]).toMatchObject({ seq: 5 });
  });
});
