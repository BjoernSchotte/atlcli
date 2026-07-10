import { describe, test, expect, afterEach } from "bun:test";
import {
  WebhookServer,
  createWebhookServer,
} from "./webhook-server.js";
import type {
  WebhookHandler,
  WebhookPayload,
  WebhookServerOptions,
} from "./webhook-server.js";

function createTestServer(
  options: Omit<WebhookServerOptions, "port"> = {},
): WebhookServer {
  return new WebhookServer({ ...options, port: 0 });
}

function startServer(instance: WebhookServer): URL {
  instance.start();
  const url = instance.getUrl();
  if (!url) throw new Error("Webhook server did not start");
  return new URL(url);
}

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
      server = createTestServer();
      expect(server.isRunning()).toBe(false);

      server.start();
      expect(server.isRunning()).toBe(true);

      server.stop();
      expect(server.isRunning()).toBe(false);
    });

    test("getUrl returns correct URL when running", () => {
      server = createTestServer();
      const url = startServer(server);

      expect(url.hostname).toBe("localhost");
      expect(Number(url.port)).toBeGreaterThan(0);
      expect(url.pathname).toBe("/webhook");
    });

    test("getUrl returns null when not running", () => {
      server = createTestServer();
      expect(server.getUrl()).toBe(null);
    });

    test("custom path is used", () => {
      server = createTestServer({ path: "/custom-hook" });
      const url = startServer(server);

      expect(url.pathname).toBe("/custom-hook");
    });
  });

  describe("HTTP endpoints", () => {
    test("health endpoint returns ok", async () => {
      server = createTestServer();
      const url = startServer(server);

      const res = await fetch(new URL("/health", url));
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.status).toBe("ok");
    });

    test("webhook endpoint accepts POST", async () => {
      server = createTestServer();
      const url = startServer(server);

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

      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.status).toBe("ok");
    });

    test("returns 404 for unknown paths", async () => {
      server = createTestServer();
      const url = startServer(server);

      const res = await fetch(new URL("/unknown", url));
      expect(res.status).toBe(404);
    });

    test("returns 400 for invalid JSON", async () => {
      server = createTestServer();
      const url = startServer(server);

      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not valid json",
      });

      expect(res.status).toBe(400);
    });
  });

  describe("event handling", () => {
    test("calls registered handlers", async () => {
      server = createTestServer();

      const receivedPayloads: WebhookPayload[] = [];
      server.on((payload) => {
        receivedPayloads.push(payload);
      });

      const url = startServer(server);

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

      await fetch(url, {
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
      server = createTestServer();

      let callCount = 0;
      const handler: WebhookHandler = () => { callCount++; };

      server.on(handler);
      server.off(handler);
      const url = startServer(server);

      await fetch(url, {
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
      server = createTestServer();

      let completed = false;
      server.on(async () => {
        await new Promise(resolve => setTimeout(resolve, 10));
        completed = true;
      });

      const url = startServer(server);

      await fetch(url, {
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
      server = createTestServer({
        filterPageIds: new Set(["allowed"]),
      });

      const receivedPayloads: WebhookPayload[] = [];
      server.on((payload) => { receivedPayloads.push(payload); });
      const url = startServer(server);

      // Send allowed page
      await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          eventType: "page_updated",
          timestamp: new Date().toISOString(),
          page: { id: "allowed", title: "Allowed", spaceKey: "X", version: 1 },
        }),
      });

      // Send filtered page
      await fetch(url, {
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
      server = createTestServer({
        filterSpaceKeys: new Set(["ALLOWED"]),
      });

      const receivedPayloads: WebhookPayload[] = [];
      server.on((payload) => { receivedPayloads.push(payload); });
      const url = startServer(server);

      // Send allowed space
      await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          eventType: "page_updated",
          timestamp: new Date().toISOString(),
          page: { id: "1", title: "Page", spaceKey: "ALLOWED", version: 1 },
        }),
      });

      // Send filtered space
      await fetch(url, {
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
