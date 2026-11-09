/**
 * 5xx retries against a real HTTP origin: a create POST whose response is lost
 * may already have been applied, so it is sent once; reads and rate-limited
 * (429, never processed) requests keep retrying.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Profile } from "@atlcli/core";
import { ConfluenceClient } from "./client.js";

const retrySchedulerHook = Symbol.for("atlcli.confluence.retry-scheduler.test-hook");
const host = globalThis as typeof globalThis & Record<symbol, unknown>;
const originalScheduler = host[retrySchedulerHook];

let server: ReturnType<typeof Bun.serve>;
let client: ConfluenceClient;
let statuses: number[] = [];
let requests: string[] = [];

beforeAll(() => {
  host[retrySchedulerHook] = async () => {};
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      requests.push(`${req.method} ${new URL(req.url).pathname}`);
      const status = statuses.shift() ?? 200;
      return status === 200
        ? Response.json({ id: "1", key: "k", title: "t", version: { number: 1 }, results: [] })
        : new Response("boom", { status });
    },
  });
  const profile: Profile = {
    name: "test",
    baseUrl: `http://localhost:${server.port}`,
    auth: { type: "apiToken", email: "test@example.com", token: "test-token" },
  };
  client = new ConfluenceClient(profile);
});
afterAll(() => {
  server.stop(true);
  if (originalScheduler) host[retrySchedulerHook] = originalScheduler;
  else delete host[retrySchedulerHook];
});
beforeEach(() => {
  statuses = [];
  requests = [];
});

describe("5xx retries and idempotency", () => {
  const creates: Array<[string, () => Promise<unknown>]> = [
    ["footer comment", () => client.createFooterComment({ pageId: "1", body: "<p>x</p>" })],
    ["inline comment", () => client.createInlineComment({ pageId: "1", body: "<p>x</p>", textSelection: "x" } as never)],
    ["page property", () => client.createPageProperty("1", "k", { a: 1 })],
    ["folder", () => client.createFolder({ spaceId: "1", title: "t" })],
    ["ADF page", () => client.createPageAdf({ spaceId: "1", title: "t", adf: {} })],
    ["webhook", () => client.registerWebhook({ name: "n", url: "https://example.test/hook", events: [] })],
    ["space", () => client.createSpace({ key: "K", name: "n" })],
    ["space role assignments", () => client.setSpaceRoleAssignments("1", [])],
    ["archive", () => client.archivePage("1")],
    ["v2 requestJson POST", () => client.requestJson("POST", "/api/v2/pages", { body: { title: "t" } })],
  ];
  for (const [name, create] of creates) {
    test(`a ${name} POST answered with 500 is sent once and the error surfaces`, async () => {
      // archivePage reads the page first; let that read succeed.
      statuses = name === "archive" ? [200, 500, 200] : [500, 200];
      await expect(create()).rejects.toThrow("500");
      expect(requests.filter((r) => r.startsWith("POST"))).toHaveLength(1);
    });
  }

  test("a create POST answered with 429 is still retried", async () => {
    statuses = [429, 200];
    await client.createPageProperty("1", "k", { a: 1 });
    expect(requests).toHaveLength(2);
  });

  test("a v2 GET answered with 500 is still retried", async () => {
    statuses = [500, 200];
    await client.getJson("/api/v2/pages");
    expect(requests).toHaveLength(2);
  });

  test("adding a label (idempotent POST) answered with 500 is still retried", async () => {
    statuses = [500, 200];
    await client.addLabels("1", ["a"]);
    expect(requests).toHaveLength(2);
  });
});
