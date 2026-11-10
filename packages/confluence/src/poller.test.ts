import { describe, test, expect, beforeEach } from "bun:test";
import {
  ConfluencePoller,
  createPagePoller,
  createTreePoller,
  createSpacePoller,
  PollChangeEvent,
} from "./poller.js";
import { ConfluenceClient, SyncScope, PageChangeInfo } from "./client.js";

// Mock ConfluenceClient
function createMockClient(initialPages: PageChangeInfo[] = []): {
  client: ConfluenceClient;
  setPages: (pages: PageChangeInfo[]) => void;
} {
  let pages = [...initialPages];

  const client = {
    getAllPages: async () => pages,
    getPageVersion: async (id: string) => {
      const page = pages.find(p => p.id === id);
      return page ?? { id, title: "Unknown", version: 1 };
    },
    getAllFoldersWithVersions: async () => [], // No folders in basic tests
  } as unknown as ConfluenceClient;

  return {
    client,
    setPages: (newPages: PageChangeInfo[]) => { pages = newPages; },
  };
}

describe("ConfluencePoller", () => {
  describe("initialization", () => {
    test("initializes with pages from scope", async () => {
      const pages: PageChangeInfo[] = [
        { id: "1", title: "Page 1", version: 1 },
        { id: "2", title: "Page 2", version: 2 },
      ];
      const { client } = createMockClient(pages);
      const poller = new ConfluencePoller({
        client,
        scope: { type: "space", spaceKey: "TEST" },
      });

      await poller.initialize();
      const state = poller.getState();

      expect(state.knownPages.size).toBe(2);
      expect(state.knownPages.get("1")?.version).toBe(1);
      expect(state.knownPages.get("2")?.version).toBe(2);
    });

    test("sets lastPollAt on initialization", async () => {
      const { client } = createMockClient([]);
      const poller = new ConfluencePoller({
        client,
        scope: { type: "space", spaceKey: "TEST" },
      });

      const before = new Date().toISOString();
      await poller.initialize();
      const after = new Date().toISOString();

      const state = poller.getState();
      expect(state.lastPollAt >= before).toBe(true);
      expect(state.lastPollAt <= after).toBe(true);
    });
  });

  describe("polling", () => {
    test("detects new pages", async () => {
      const { client, setPages } = createMockClient([]);
      const poller = new ConfluencePoller({
        client,
        scope: { type: "space", spaceKey: "TEST" },
      });

      await poller.initialize();

      // Simulate new page appearing
      const newPage = { id: "new", title: "New Page", version: 1 };
      setPages([newPage]);

      const events: PollChangeEvent[] = [];
      poller.on((e) => { events.push(e); });

      await poller.poll();

      expect(events.length).toBe(1);
      expect(events[0].type).toBe("created");
      expect(events[0].pageId).toBe("new");
    });

    test("detects updated pages", async () => {
      const pages: PageChangeInfo[] = [
        { id: "1", title: "Page 1", version: 1 },
      ];
      const { client, setPages } = createMockClient(pages);
      const poller = new ConfluencePoller({
        client,
        scope: { type: "space", spaceKey: "TEST" },
      });

      await poller.initialize();

      // Simulate version bump
      const updatedPage = { id: "1", title: "Page 1", version: 2 };
      setPages([updatedPage]);

      const events: PollChangeEvent[] = [];
      poller.on((e) => { events.push(e); });

      await poller.poll();

      expect(events.length).toBe(1);
      expect(events[0].type).toBe("changed");
      expect(events[0].pageId).toBe("1");
      expect(events[0].version).toBe(2);
      expect(events[0].previousVersion).toBe(1);
    });

    test("reports an edit that landed between the caller's sync and initialize", async () => {
      // The caller pulled version 1; the remote moved to 2 before the poller
      // took its baseline. Baselining at 2 would lose that edit for good.
      const { client } = createMockClient([{ id: "1", title: "Page 1", version: 2 }]);
      const poller = new ConfluencePoller({ client, scope: { type: "page", pageId: "1" } });
      await poller.initialize(new Map([["1", 1], ["unrelated", 9]]));
      expect(poller.getState().knownPages.get("1")?.version).toBe(1);

      const events: PollChangeEvent[] = [];
      poller.on((e) => { events.push(e); });
      await poller.poll();
      expect(events.map((e) => [e.type, e.version, e.previousVersion])).toEqual([["changed", 2, 1]]);
    });

    test("detects deleted pages for space/tree scope", async () => {
      const pages: PageChangeInfo[] = [
        { id: "1", title: "Page 1", version: 1 },
        { id: "2", title: "Page 2", version: 1 },
      ];
      const { client, setPages } = createMockClient(pages);
      const poller = new ConfluencePoller({
        client,
        scope: { type: "space", spaceKey: "TEST" },
      });

      await poller.initialize();

      // Simulate page deletion
      setPages([{ id: "1", title: "Page 1", version: 1 }]);

      const events: PollChangeEvent[] = [];
      poller.on((e) => { events.push(e); });

      await poller.poll();

      const deleteEvent = events.find(e => e.type === "deleted");
      expect(deleteEvent).toBeDefined();
      expect(deleteEvent?.pageId).toBe("2");
    });

    test("ignores unchanged pages", async () => {
      const pages: PageChangeInfo[] = [
        { id: "1", title: "Page 1", version: 1 },
      ];
      const { client } = createMockClient(pages);
      const poller = new ConfluencePoller({
        client,
        scope: { type: "space", spaceKey: "TEST" },
      });

      await poller.initialize();

      const events: PollChangeEvent[] = [];
      poller.on((e) => { events.push(e); });

      await poller.poll();

      // No change events for unchanged pages
      expect(events.filter(e => e.pageId === "1")).toHaveLength(0);
    });
  });

  describe("start/stop", () => {
    test("isRunning returns correct state", () => {
      const { client } = createMockClient([]);
      const poller = new ConfluencePoller({
        client,
        scope: { type: "space", spaceKey: "TEST" },
        intervalMs: 100000, // Long interval to prevent actual polling
      });

      expect(poller.isRunning()).toBe(false);
      poller.start();
      expect(poller.isRunning()).toBe(true);
      poller.stop();
      expect(poller.isRunning()).toBe(false);
    });

    test("can update interval", () => {
      const { client } = createMockClient([]);
      const poller = new ConfluencePoller({
        client,
        scope: { type: "space", spaceKey: "TEST" },
        intervalMs: 1000,
      });

      poller.setInterval(5000);
      // Just verify it doesn't throw
      expect(true).toBe(true);
    });
  });

  describe("event handlers", () => {
    test("can add and remove handlers", async () => {
      const { client } = createMockClient([]);
      const poller = new ConfluencePoller({
        client,
        scope: { type: "space", spaceKey: "TEST" },
      });

      let callCount = 0;
      const handler = () => { callCount++; };
      poller.on(handler);
      poller.off(handler);

      // Verify handler was removed - no calls should happen
      expect(callCount).toBe(0);
    });
  });
});

describe("factory functions", () => {
  test("createPagePoller creates poller with page scope", () => {
    const { client } = createMockClient([]);
    const poller = createPagePoller(client, "12345");
    expect(poller).toBeInstanceOf(ConfluencePoller);
  });

  test("createTreePoller creates poller with tree scope", () => {
    const { client } = createMockClient([]);
    const poller = createTreePoller(client, "12345");
    expect(poller).toBeInstanceOf(ConfluencePoller);
  });

  test("createSpacePoller creates poller with space scope", () => {
    const { client } = createMockClient([]);
    const poller = createSpacePoller(client, "TEST");
    expect(poller).toBeInstanceOf(ConfluencePoller);
  });

  test("factory functions accept custom interval", () => {
    const { client } = createMockClient([]);
    const poller = createPagePoller(client, "12345", 5000);
    expect(poller).toBeInstanceOf(ConfluencePoller);
  });
});

describe("one listing per poll", () => {
  function countingClient(folders: () => Promise<unknown[]>) {
    const calls = { all: 0 };
    const client = {
      getAllPages: async () => { calls.all += 1; return [{ id: "1", title: "Page 1", version: 1 }]; },
      getAllFoldersWithVersions: folders,
    } as unknown as ConfluenceClient;
    return { client, calls };
  }

  test("a poll lists the scope once", async () => {
    const { client, calls } = countingClient(async () => []);
    const poller = new ConfluencePoller({ client, scope: { type: "space", spaceKey: "TEST" } });
    await poller.initialize();
    calls.all = 0;

    await poller.poll();

    expect(calls.all).toBe(1);
  });

  test("a failed folder listing emits no deleted events and keeps the known folders", async () => {
    let fail = false;
    const { client } = countingClient(async () => {
      if (fail) throw new Error("503");
      return [{ id: "f1", title: "Folder", version: 1 }];
    });
    const poller = new ConfluencePoller({ client, scope: { type: "space", spaceKey: "TEST" } });
    await poller.initialize();
    const events: PollChangeEvent[] = [];
    poller.on((event) => { events.push(event); });

    fail = true;
    await expect(poller.poll()).rejects.toThrow("503");
    expect(events).toEqual([]);
    expect(poller.getState().knownFolders.has("f1")).toBe(true);

    // The next poll runs again instead of staying locked out.
    fail = false;
    expect(await poller.poll()).toEqual([]);
  });

  test("a failed scheduled poll goes to onError instead of an unhandled rejection", async () => {
    const errors: unknown[] = [];
    const client = { getAllPages: async () => { throw new Error("offline"); } } as unknown as ConfluenceClient;
    const poller = new ConfluencePoller({
      client,
      scope: { type: "space", spaceKey: "TEST" },
      intervalMs: 60_000,
      onError: (error) => errors.push(error),
    });

    poller.start();
    poller.stop();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(errors.map((error) => (error as Error).message)).toEqual(["offline"]);
  });
});
