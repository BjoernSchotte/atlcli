import { afterEach, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { JiraWebhookServer, formatWebhookEvent, type JiraWebhookPayload } from "./webhook-server.js";

let server: JiraWebhookServer | null = null;

function start(options: Omit<ConstructorParameters<typeof JiraWebhookServer>[0], "port"> = {}): string {
  server = new JiraWebhookServer({ ...options, port: 0 });
  server.start();
  return server.getUrl()!;
}

function post(url: string, body: string, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(url, { method: "POST", body, headers });
}

afterEach(() => {
  server?.stop();
  server = null;
});

describe("JiraWebhookServer", () => {
  test("getUrl and getPort report the bound port, not the requested one", async () => {
    const url = start();
    expect(server!.getPort()).toBeGreaterThan(0);
    expect(new URL(url).port).toBe(String(server!.getPort()));
    expect((await fetch(new URL("/health", url))).status).toBe(200);
  });

  test("invalid or non-object JSON is a 400, not a 500", async () => {
    const url = start();
    for (const body of ["{not json", "null", "[]", "42"]) {
      expect((await post(url, body)).status).toBe(400);
    }
  });

  test("an issue without a project is filtered instead of crashing the project filter", async () => {
    const url = start({ filterProjects: new Set(["ABC"]) });
    const seen: JiraWebhookPayload[] = [];
    server!.on((payload) => void seen.push(payload));

    const malformed = await post(url, JSON.stringify({ webhookEvent: "jira:issue_updated", issue: { key: "X-1" } }));
    expect(malformed.status).toBe(200);
    expect(await malformed.json()).toEqual({ status: "filtered", reason: "project" });

    const matching = await post(
      url,
      JSON.stringify({ webhookEvent: "jira:issue_updated", issue: { key: "ABC-1", fields: { project: { key: "ABC" } } } }),
    );
    expect(await matching.json()).toEqual({ status: "ok" });
    expect(seen.map((payload) => payload.issue?.key)).toEqual(["ABC-1"]);
  });

  test("accepts only a matching HMAC signature", async () => {
    const url = start({ secret: "s3cret" });
    const body = JSON.stringify({ webhookEvent: "jira:issue_created", timestamp: 0 });
    const good = `sha256=${createHmac("sha256", "s3cret").update(body).digest("hex")}`;

    expect((await post(url, body, { "X-Hub-Signature": good })).status).toBe(200);
    expect((await post(url, body, { "X-Hub-Signature": good.slice(0, -1) + (good.endsWith("0") ? "1" : "0") })).status).toBe(401);
    expect((await post(url, body, { "X-Hub-Signature": "sha256=short" })).status).toBe(401);
    expect((await post(url, body)).status).toBe(401);
  });
});

test("formatWebhookEvent tolerates an issue without fields", () => {
  const payload = { timestamp: 0, webhookEvent: "jira:issue_deleted", issue: { id: "1", key: "X-1" } };
  expect(formatWebhookEvent(payload as JiraWebhookPayload)).toContain("DELETED: X-1");
});
