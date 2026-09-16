import { expect, test } from "bun:test";
import { ConfluenceClient } from "./client.js";

test("counts v1, v2 retries, binary and multipart HTTP attempts without exposing content", async () => {
  let calls = 0;
  let limited = false;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    calls++;
    const path = new URL(request.url).pathname;
    if (path.includes("/api/v2/") && !limited) {
      limited = true;
      return new Response("", { status: 429, headers: { "Retry-After": "0" } });
    }
    if (path.includes("/download/")) return new Response("fixture");
    return Response.json({ id: "1", key: "DOCSY", name: "Fixture", results: [] });
  }});
  try {
    const client = new ConfluenceClient({ name: "fixture", baseUrl: `http://127.0.0.1:${server.port}`,
      deploymentType: "cloud", auth: { type: "apiToken", email: "fixture@example.test", token: "fixture" } });
    expect(client.getRequestStats()).toEqual({ requests: 0, rateLimits: 0 });
    await client.getSpace("DOCSY");
    await client.getPagesBulk(["1"]);
    await client.downloadAttachment({ downloadUrl: "/download/attachments/1/fixture.txt" });
    // Upload's empty result is rejected by the parser, after the HTTP attempt.
    await client.uploadAttachment({ pageId: "1", filename: "fixture.txt", data: new Uint8Array([1]) }).catch(() => {});
    expect(calls).toBe(6);
    expect(client.getRequestStats()).toEqual({ requests: calls, rateLimits: 1 });
    const snapshot = client.getRequestStats();
    snapshot.requests = 0;
    expect(client.getRequestStats().requests).toBe(calls);
  } finally { server.stop(true); }
});
