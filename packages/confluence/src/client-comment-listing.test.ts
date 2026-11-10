import { afterAll, beforeAll, expect, it } from "bun:test";
import { ConfluenceClient } from "./client.js";

// Comment listings read only the first page (100 comments, 50 replies), fetched
// replies one comment at a time, and turned any reply failure into "no replies".

const retrySchedulerHook = Symbol.for("atlcli.confluence.retry-scheduler.test-hook");
const host = globalThis as typeof globalThis & Record<symbol, unknown>;
const originalScheduler = host[retrySchedulerHook];
beforeAll(() => { host[retrySchedulerHook] = async () => {}; });
afterAll(() => {
  if (originalScheduler) host[retrySchedulerHook] = originalScheduler;
  else delete host[retrySchedulerHook];
});

function client(port: number): ConfluenceClient {
  return new ConfluenceClient({ name: "fixture", baseUrl: `http://127.0.0.1:${port}`,
    deploymentType: "cloud", auth: { type: "apiToken", email: "fixture@example.com", token: "fixture" } });
}

const comment = (id: string) => ({ id, body: { storage: { value: `<p>${id}</p>` } }, version: { number: 1 } });

/** Two pages per listing; `replyStatus` overrides the reply endpoint of comment c1. */
function serve(kind: "footer" | "inline", replyStatus = 200) {
  const state = { inFlight: 0, maxInFlight: 0 };
  const server = Bun.serve({ port: 0, async fetch(request) {
    const url = new URL(request.url);
    const second = url.searchParams.get("cursor") === "next";
    const page = (ids: [string, string]) => Response.json({
      results: [comment(second ? ids[1] : ids[0])],
      _links: second ? {} : { next: `${url.pathname}?cursor=next` },
    });
    if (url.pathname.endsWith(`/pages/7/${kind}-comments`)) return page(["c1", "c2"]);
    const reply = new RegExp(`/${kind}-comments/(c\\d)/children$`).exec(url.pathname);
    if (!reply) return new Response("unexpected " + url.pathname, { status: 404 });
    if (reply[1] === "c1" && replyStatus !== 200) return new Response("no", { status: replyStatus });
    state.inFlight += 1;
    state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
    await new Promise((resolve) => setTimeout(resolve, 20));
    state.inFlight -= 1;
    return page([`${reply[1]}-r1`, `${reply[1]}-r2`]);
  } });
  return { server, state };
}

for (const kind of ["footer", "inline"] as const) {
  const list = (c: ConfluenceClient) => (kind === "footer" ? c.getFooterComments("7") : c.getInlineComments("7"));

  it(`${kind} comments and their replies are read past the first page, replies in parallel`, async () => {
    const { server, state } = serve(kind);
    try {
      const comments = await list(client(server.port!));
      expect(comments.map((c) => [c.id, c.replies.map((r) => r.id)])).toEqual([
        ["c1", ["c1-r1", "c1-r2"]],
        ["c2", ["c2-r1", "c2-r2"]],
      ]);
      expect(state.maxInFlight).toBe(2);
    } finally { server.stop(true); }
  });

  it(`${kind} replies of a comment deleted meanwhile (404) are empty`, async () => {
    const { server } = serve(kind, 404);
    try {
      const comments = await list(client(server.port!));
      expect(comments.map((c) => c.replies.length)).toEqual([0, 2]);
    } finally { server.stop(true); }
  });

  it(`${kind} reply failure is reported, not turned into "no replies"`, async () => {
    const { server } = serve(kind, 403);
    try {
      await expect(list(client(server.port!))).rejects.toThrow("403");
    } finally { server.stop(true); }
  });
}
