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
  return fetch(url, { method: "POST", body, headers: { "Content-Type": "application/json", ...headers } });
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

  // Bun.serve without a hostname listens on every interface.
  test("binds loopback by default and refuses another interface without a secret", () => {
    expect(new URL(start()).hostname).toBe("127.0.0.1");
    for (const hostname of ["0.0.0.0", "::", "192.0.2.10"]) {
      const unauthenticated = new JiraWebhookServer({ port: 0, hostname });
      expect(() => unauthenticated.start()).toThrow(/without a secret/);
      expect(unauthenticated.isRunning()).toBe(false);
    }
  });

  test("binds every interface when a secret is set", () => {
    expect(new URL(start({ hostname: "0.0.0.0", secret: "s3cret" })).hostname).toBe("localhost");
  });

  // A page in the user's browser can send form or text bodies to a loopback
  // port without a CORS preflight; JSON it cannot.
  test("answers 415 to a POST that is not application/json", async () => {
    const url = start();
    const seen: JiraWebhookPayload[] = [];
    server!.on((payload) => void seen.push(payload));
    const body = JSON.stringify({ webhookEvent: "jira:issue_created", timestamp: 0 });

    for (const type of ["text/plain", "application/x-www-form-urlencoded", "multipart/form-data"]) {
      expect((await post(url, body, { "Content-Type": type })).status).toBe(415);
    }
    expect(seen).toEqual([]);
    expect((await post(url, body, { "Content-Type": "application/json; charset=UTF-8" })).status).toBe(200);
    expect(seen).toHaveLength(1);
  });

  test("answers 413 to a body over 1 MiB", async () => {
    const url = start();
    const body = (padding: number) => JSON.stringify({ webhookEvent: "jira:issue_created", pad: "x".repeat(padding) });
    expect((await post(url, body(1 << 20))).status).toBe(413);
    expect((await post(url, body(1 << 19))).status).toBe(200);
  });
});

test("formatWebhookEvent strips control characters from everything the request controls", () => {
  const evil = "\u001b]0;pwned\u0007\u001b[2A\r\n\u009b";
  const base = { timestamp: 0, user: { accountId: "a", displayName: evil } };
  const issue = { id: "1", key: `X-1${evil}`, fields: { summary: `sum${evil}`, status: { name: `st${evil}` } } };
  const lines = [
    formatWebhookEvent({ ...base, webhookEvent: "jira:issue_created", issue } as JiraWebhookPayload),
    formatWebhookEvent({ ...base, webhookEvent: "jira:issue_updated", issue } as JiraWebhookPayload),
    formatWebhookEvent({
      ...base,
      webhookEvent: "jira:issue_updated",
      issue,
      changelog: { id: "1", items: [{ field: `f${evil}`, fromString: `a${evil}`, toString: `b${evil}` }] },
    } as unknown as JiraWebhookPayload),
    formatWebhookEvent({
      ...base,
      webhookEvent: "comment_created",
      issue,
      comment: { author: { displayName: `author${evil}` } },
    } as JiraWebhookPayload),
    formatWebhookEvent({ ...base, webhookEvent: "sprint_started", sprint: { id: 1, name: `S${evil}`, state: "" } }),
    formatWebhookEvent({ ...base, webhookEvent: `custom${evil}` } as unknown as JiraWebhookPayload),
  ];
  for (const line of lines) expect(line).not.toMatch(/[\x00-\x1f\x7f-\x9f]/);
  expect(lines[2]).toContain("UPDATED: X-1]0;pwned[2A - sum]0;pwned[2A (f]0;pwned[2A: a]0;pwned[2A → b]0;pwned[2A)");
  expect(lines[3]).toContain("New comment by author]0;pwned[2A");
  expect(lines[4]).toContain("SPRINT: S]0;pwned[2A - started");
});

test("formatWebhookEvent tolerates an issue without fields", () => {
  const payload = { timestamp: 0, webhookEvent: "jira:issue_deleted", issue: { id: "1", key: "X-1" } };
  expect(formatWebhookEvent(payload as JiraWebhookPayload)).toContain("DELETED: X-1");
});
