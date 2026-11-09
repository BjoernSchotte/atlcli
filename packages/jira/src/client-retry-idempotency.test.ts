/**
 * 5xx retries against a real HTTP origin: a create POST whose response is lost
 * may already have been applied, so it is sent once; GET/PUT/DELETE, read-style
 * POSTs and rate-limited (429, never processed) requests keep retrying.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Profile } from "@atlcli/core";
import { JiraClient } from "./client.js";

const retrySchedulerHook = Symbol.for("atlcli.jira.retry-scheduler.test-hook");
const host = globalThis as typeof globalThis & Record<symbol, unknown>;
const originalScheduler = host[retrySchedulerHook];

let server: ReturnType<typeof Bun.serve>;
let client: JiraClient;
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
        ? Response.json({ id: "1", key: "T-1", fields: {}, issues: [] })
        : new Response("boom", { status });
    },
  });
  const profile: Profile = {
    name: "test",
    baseUrl: `http://localhost:${server.port}`,
    auth: { type: "apiToken", email: "test@example.com", token: "test-token" },
  };
  client = new JiraClient(profile);
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
    ["issue create", () => client.createIssue({ fields: {} } as never)],
    ["comment", () => client.addComment("T-1", "hi")],
    ["worklog", () => client.addWorklog("T-1", { timeSpentSeconds: 60 } as never)],
    ["requestJson", () => client.requestJson("POST", "/rest/api/3/version", { body: { name: "1" } })],
    ["requestJson PATCH", () => client.requestJson("PATCH", "/rest/api/3/thing", { body: {} })],
    // Has its own request loop; it used to re-send after ANY failure.
    ["attachment upload", () => client.uploadAttachment("T-1", "a.txt", Buffer.from("x"))],
  ];
  for (const [name, create] of creates) {
    test(`a ${name} answered with 500 is sent once and the error surfaces`, async () => {
      statuses = [500, 200];
      await expect(create()).rejects.toThrow("500");
      expect(requests).toHaveLength(1);
    });
  }

  test("a create POST answered with 429 is still retried", async () => {
    statuses = [429, 200];
    await client.requestJson("POST", "/rest/api/3/version", { body: { name: "1" } });
    expect(requests).toHaveLength(2);
  });

  test("an attachment upload answered with 429 is still retried", async () => {
    statuses = [429, 200];
    await client.uploadAttachment("T-1", "a.txt", Buffer.from("x"));
    expect(requests).toHaveLength(2);
  });

  test("GET, PUT and DELETE answered with 500 are still retried", async () => {
    statuses = [500, 200];
    await client.getIssue("T-1");
    statuses = [500, 200];
    await client.requestJson("PUT", "/rest/api/3/issue/T-1", { body: {} });
    statuses = [500, 200];
    await client.requestJson("DELETE", "/rest/api/3/issue/T-1");
    expect(requests).toHaveLength(6);
  });

  test("the JQL search POST (a read) answered with 500 is still retried", async () => {
    statuses = [500, 200];
    await client.search("project = T");
    expect(requests).toHaveLength(2);
    expect(requests.every((r) => r.startsWith("POST ") && r.endsWith("/search/jql"))).toBe(true);
  });
});
