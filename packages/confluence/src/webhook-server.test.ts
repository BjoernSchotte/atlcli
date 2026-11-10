import { describe, test, expect, afterEach } from "bun:test";
import { createHmac } from "node:crypto";
import {
  WebhookServer,
  createWebhookServer,
  isLoopbackHost,
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

      expect(url.hostname).toBe("127.0.0.1");
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

    // `null` parsed fine and then crashed the page filter into a 500.
    test("returns 400 for JSON that is not an object", async () => {
      server = createTestServer({ filterPageIds: new Set(["1"]) });
      const url = startServer(server);

      for (const body of ["null", "[]", "42", '"text"']) {
        expect((await fetch(url, { method: "POST", body, headers: { "Content-Type": "application/json" } })).status).toBe(400);
      }
    });

    test("accepts only a matching HMAC signature", async () => {
      server = createTestServer({ secret: "fixture-secret" });
      const url = startServer(server);
      const body = JSON.stringify({ eventType: "page_updated", timestamp: "" });
      const good = `sha256=${createHmac("sha256", "fixture-secret").update(body).digest("hex")}`;
      const post = (signature?: string) =>
        fetch(url, {
          method: "POST",
          body,
          headers: { "Content-Type": "application/json", ...(signature ? { "X-Hub-Signature": signature } : {}) },
        });

      expect((await post(good)).status).toBe(200);
      expect((await post(good.slice(0, -1) + (good.endsWith("0") ? "1" : "0"))).status).toBe(401);
      expect((await post("sha256=short")).status).toBe(401);
      // Same character count as the expected header, different byte length.
      expect((await post("é".repeat(good.length))).status).toBe(401);
      expect((await post()).status).toBe(401);
    });

    // A sender that cannot sign the body (an automation rule's web request)
    // presents the secret as a bearer token instead.
    test("accepts the secret as a bearer token, and nothing else", async () => {
      server = createTestServer({ secret: "fixture-secret" });
      const url = startServer(server);
      const post = (headers: Record<string, string>) =>
        fetch(url, {
          method: "POST",
          body: JSON.stringify({ eventType: "page_updated" }),
          headers: { "Content-Type": "application/json", ...headers },
        });

      expect((await post({ Authorization: "Bearer fixture-secret" })).status).toBe(200);
      expect((await post({ Authorization: "Bearer wrong-secret!!" })).status).toBe(401);
      expect((await post({ Authorization: "fixture-secret" })).status).toBe(401);
      // A bad signature is not rescued by a good token.
      expect(
        (await post({ Authorization: "Bearer fixture-secret", "X-Hub-Signature": "sha256=00" })).status
      ).toBe(401);
    });
  });

  describe("request limits", () => {
    // A page in the user's browser can send form or text bodies to a loopback
    // port without a CORS preflight; JSON it cannot.
    test("answers 415 to a POST that is not application/json", async () => {
      server = createTestServer();
      const url = startServer(server);
      const seen: WebhookPayload[] = [];
      server.on((payload) => void seen.push(payload));
      const body = JSON.stringify({ eventType: "page_updated", page: { id: "1" } });

      for (const type of ["text/plain", "application/x-www-form-urlencoded", "multipart/form-data"]) {
        expect((await fetch(url, { method: "POST", body, headers: { "Content-Type": type } })).status).toBe(415);
      }
      expect(seen).toEqual([]);
      expect(
        (await fetch(url, { method: "POST", body, headers: { "Content-Type": "Application/JSON; charset=utf-8" } })).status
      ).toBe(200);
      expect(seen).toHaveLength(1);
    });

    test("answers 413 to a body over 1 MiB", async () => {
      server = createTestServer();
      const url = startServer(server);
      const post = (padding: number) =>
        fetch(url, {
          method: "POST",
          body: JSON.stringify({ eventType: "page_updated", pad: "x".repeat(padding) }),
          headers: { "Content-Type": "application/json" },
        });

      expect((await post(1 << 20)).status).toBe(413);
      expect((await post(1 << 19)).status).toBe(200);
    });
  });

  describe("bind address", () => {
    // Bun.serve without a hostname listens on every interface.
    test("binds loopback by default", () => {
      server = createTestServer();
      expect(startServer(server).hostname).toBe("127.0.0.1");
    });

    test("refuses a non-loopback interface without a secret", () => {
      for (const hostname of ["0.0.0.0", "::", "192.0.2.10"]) {
        const unauthenticated = createTestServer({ hostname });
        expect(() => unauthenticated.start()).toThrow(/without a secret/);
        expect(unauthenticated.isRunning()).toBe(false);
      }
    });

    test("binds every interface when a secret is set", () => {
      server = createTestServer({ hostname: "0.0.0.0", secret: "fixture-secret" });
      expect(startServer(server).hostname).toBe("localhost");
    });

    test("isLoopbackHost", () => {
      for (const host of ["127.0.0.1", "127.8.9.1", "::1", "[::1]", "localhost"]) expect(isLoopbackHost(host)).toBe(true);
      for (const host of ["0.0.0.0", "::", "192.0.2.10", "127.0.0.1.example.test", ""]) expect(isLoopbackHost(host)).toBe(false);
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
