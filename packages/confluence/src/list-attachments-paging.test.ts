import { afterAll, beforeAll, expect, test } from "bun:test";
import { ConfluenceClient } from "./client.js";

const TOTAL = 230;
let server: ReturnType<typeof Bun.serve>;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname !== "/rest/api/content/10/child/attachment") return Response.json({}, { status: 404 });
      const start = Number(url.searchParams.get("start") ?? 0);
      const limit = Number(url.searchParams.get("limit"));
      const end = Math.min(start + limit, TOTAL);
      return Response.json({
        results: Array.from({ length: end - start }, (_, i) => ({ id: `att${start + i}`, title: `f${start + i}.png` })),
        _links: end < TOTAL ? { next: `/rest/api/content/10/child/attachment?limit=${limit}&start=${end}` } : {},
      });
    },
  });
});

afterAll(() => {
  server?.stop(true);
});

// Regression: one request (100 attachments) was read as the whole list, so
// copies dropped the rest and an upload of an existing file became a duplicate.
test("listAttachments follows the next link to the last attachment", async () => {
  const client = new ConfluenceClient({ name: "t", baseUrl: server.url.origin, deploymentType: "data-center", auth: { type: "bearer", pat: "t" } });
  const all = await client.listAttachments("10");
  expect(all.length).toBe(TOTAL);
  expect(all.at(-1)).toMatchObject({ id: `att${TOTAL - 1}`, filename: `f${TOTAL - 1}.png`, pageId: "10" });
});
