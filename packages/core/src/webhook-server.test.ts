import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import {
  WebhookServer,
  createWebhookServer,
  WebhookPayload,
  WebhookHandler,
} from "./webhook-server.js";

// Use a random port for each test to avoid conflicts
let testPort = 40000 + Math.floor(Math.random() * 10000);

describe("WebhookServer", () => {
  let server: WebhookServer | null = null;

  afterEach(() => {
    if (server) {
      server.stop();
      server = null;
    }
  });

  describe("lifecycle", () => {
    test("starts and stops correctly", () => {
      server = new WebhookServer({ port: ++testPort });
      expect(server.isRunning()).toBe(false);

      server.start();
      expect(server.isRunning()).toBe(true);

      server.stop();
      expect(server.isRunning()).toBe(false);
    });

    test("getUrl returns correct URL when running", () => {
      const port = ++testPort;
      server = new WebhookServer({ port });
      server.start();

      expect(server.getUrl()).toBe(`http://localhost:${port}/webhook`);
    });

    test("getUrl returns null when not running", () => {
      server = new WebhookServer({ port: ++testPort });
      expect(server.getUrl()).toBe(null);
    });

    test("custom path is used", () => {
      const port = ++testPort;
      server = new WebhookServer({ port, path: "/custom-hook" });
      server.start();

      expect(server.getUrl()).toBe(`http://localhost:${port}/custom-hook`);
    });
  });

  describe("HTTP endpoints", () => {
    test("health endpoint returns ok", async () => {
      const port = ++testPort;
      server = new WebhookServer({ port });
      server.start();

      const res = await fetch(`http://localhost:${port}/health`);
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.status).toBe("ok");
    });

    test("webhook endpoint accepts POST", async () => {
      const port = ++testPort;
      server = new WebhookServer({ port });
      server.start();

      const payload: WebhookPayload = {
        eventType: "page_updated",
        timestamp: new Date().toISOString(),
        page: {
          id: "123",
          title: "Test Page",
          spaceKey: "TEST",
          version: 1,
        },
      };

      const res = await fetch(`http://localhost:${port}/webhook`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.status).toBe("ok");
    });

    test("returns 404 for unknown paths", async () => {
      const port = ++testPort;
      server = new WebhookServer({ port });
      server.start();

      const res = await fetch(`http://localhost:${port}/unknown`);
      expect(res.status).toBe(404);
    });

    test("returns 400 for invalid JSON", async () => {
      const port = ++testPort;
      server = new WebhookServer({ port });
      server.start();

      const res = await fetch(`http://localhost:${port}/webhook`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not valid json",
      });

      expect(res.status).toBe(400);
    });
  });

  describe("event handling", () => {
    test("calls registered handlers", async () => {
      const port = ++testPort;
      server = new WebhookServer({ port });

      const receivedPayloads: WebhookPayload[] = [];
      server.on((payload) => {
        receivedPayloads.push(payload);
      });

      server.start();

      const payload: WebhookPayload = {
        eventType: "page_created",
        timestamp: new Date().toISOString(),
        page: {
          id: "456",
          title: "New Page",
          spaceKey: "SPACE",
          version: 1,
        },
      };

      await fetch(`http://localhost:${port}/webhook`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      // Wait a bit for async handler
      await new Promise(resolve => setTimeout(resolve, 50));

      expect(receivedPayloads.length).toBe(1);
      expect(receivedPayloads[0].eventType).toBe("page_created");
      expect(receivedPayloads[0].page?.id).toBe("456");
    });

    test("can remove handlers", async () => {
      const port = ++testPort;
      server = new WebhookServer({ port });

      let callCount = 0;
      const handler: WebhookHandler = () => { callCount++; };

      server.on(handler);
      server.off(handler);
      server.start();

      await fetch(`http://localhost:${port}/webhook`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          eventType: "page_updated",
          timestamp: new Date().toISOString(),
        }),
      });

      await new Promise(resolve => setTimeout(resolve, 50));
      expect(callCount).toBe(0);
    });

    test("async handlers are awaited", async () => {
      const port = ++testPort;
      server = new WebhookServer({ port });

      let completed = false;
      server.on(async () => {
        await new Promise(resolve => setTimeout(resolve, 10));
        completed = true;
      });

      server.start();

      await fetch(`http://localhost:${port}/webhook`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          eventType: "page_updated",
          timestamp: new Date().toISOString(),
        }),
      });

      await new Promise(resolve => setTimeout(resolve, 100));
      expect(completed).toBe(true);
    });
  });

  describe("filtering", () => {
    test("filters by page ID", async () => {
      const port = ++testPort;
      server = new WebhookServer({
        port,
        filterPageIds: new Set(["allowed"]),
      });

      const receivedPayloads: WebhookPayload[] = [];
      server.on((payload) => { receivedPayloads.push(payload); });
      server.start();

      // Send allowed page
      await fetch(`http://localhost:${port}/webhook`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          eventType: "page_updated",
          timestamp: new Date().toISOString(),
          page: { id: "allowed", title: "Allowed", spaceKey: "X", version: 1 },
        }),
      });

      // Send filtered page
      await fetch(`http://localhost:${port}/webhook`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          eventType: "page_updated",
          timestamp: new Date().toISOString(),
          page: { id: "blocked", title: "Blocked", spaceKey: "X", version: 1 },
        }),
      });

      await new Promise(resolve => setTimeout(resolve, 50));

      expect(receivedPayloads.length).toBe(1);
      expect(receivedPayloads[0].page?.id).toBe("allowed");
    });

    test("filters by space key", async () => {
      const port = ++testPort;
      server = new WebhookServer({
        port,
        filterSpaceKeys: new Set(["ALLOWED"]),
      });

      const receivedPayloads: WebhookPayload[] = [];
      server.on((payload) => { receivedPayloads.push(payload); });
      server.start();

      // Send allowed space
      await fetch(`http://localhost:${port}/webhook`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          eventType: "page_updated",
          timestamp: new Date().toISOString(),
          page: { id: "1", title: "Page", spaceKey: "ALLOWED", version: 1 },
        }),
      });

      // Send filtered space
      await fetch(`http://localhost:${port}/webhook`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          eventType: "page_updated",
          timestamp: new Date().toISOString(),
          page: { id: "2", title: "Page", spaceKey: "BLOCKED", version: 1 },
        }),
      });

      await new Promise(resolve => setTimeout(resolve, 50));

      expect(receivedPayloads.length).toBe(1);
      expect(receivedPayloads[0].page?.spaceKey).toBe("ALLOWED");
    });
  });
});

describe("createWebhookServer", () => {
  test("creates server with default options", () => {
    const server = createWebhookServer(3000);
    expect(server).toBeInstanceOf(WebhookServer);
  });

  test("creates server with custom options", () => {
    const server = createWebhookServer(3000, {
      path: "/custom",
      filterPageIds: new Set(["123"]),
    });
    expect(server).toBeInstanceOf(WebhookServer);
  });
});
