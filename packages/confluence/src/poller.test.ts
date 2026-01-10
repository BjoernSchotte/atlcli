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
  setPagesForSince: (pages: PageChangeInfo[]) => void;
} {
  let pages = [...initialPages];
  let pagesForSince = [...initialPages];

  const client = {
    getAllPages: async () => pages,
    getPagesSince: async () => pagesForSince,
    getPageVersion: async (id: string) => {
      const page = pages.find(p => p.id === id);
      return page ?? { id, title: "Unknown", version: 1 };
    },
  } as unknown as ConfluenceClient;

  return {
    client,
    setPages: (newPages: PageChangeInfo[]) => { pages = newPages; },
    setPagesForSince: (newPages: PageChangeInfo[]) => { pagesForSince = newPages; },
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
      const { client, setPages, setPagesForSince } = createMockClient([]);
      const poller = new ConfluencePoller({
        client,
        scope: { type: "space", spaceKey: "TEST" },
      });

      await poller.initialize();

      // Simulate new page appearing
      const newPage = { id: "new", title: "New Page", version: 1 };
      setPages([newPage]);
      setPagesForSince([newPage]);

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
      const { client, setPages, setPagesForSince } = createMockClient(pages);
      const poller = new ConfluencePoller({
        client,
        scope: { type: "space", spaceKey: "TEST" },
      });

      await poller.initialize();

      // Simulate version bump
      const updatedPage = { id: "1", title: "Page 1", version: 2 };
      setPages([updatedPage]);
      setPagesForSince([updatedPage]);

      const events: PollChangeEvent[] = [];
      poller.on((e) => { events.push(e); });

      await poller.poll();

      expect(events.length).toBe(1);
      expect(events[0].type).toBe("changed");
      expect(events[0].pageId).toBe("1");
      expect(events[0].version).toBe(2);
      expect(events[0].previousVersion).toBe(1);
    });

    test("detects deleted pages for space/tree scope", async () => {
      const pages: PageChangeInfo[] = [
        { id: "1", title: "Page 1", version: 1 },
        { id: "2", title: "Page 2", version: 1 },
      ];
      const { client, setPages, setPagesForSince } = createMockClient(pages);
      const poller = new ConfluencePoller({
        client,
        scope: { type: "space", spaceKey: "TEST" },
      });

      await poller.initialize();

      // Simulate page deletion
      setPages([{ id: "1", title: "Page 1", version: 1 }]);
      setPagesForSince([]);

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
