/**
 * `ConfluenceClient.searchDetailed` against a REAL HTTP origin (`Bun.serve`).
 *
 * The response body below is the SHAPE MEASURED off Confluence Cloud's
 * `GET /rest/api/search` on 2026-07-21 while resolving the Confluence-list
 * datasource's eight columns — including the two facts that decided which
 * endpoint this method drives:
 *
 * - `excerpt` and `totalSize` exist HERE and not on `/content/search` (which
 *   returned neither, with `excerpt=indexed` or `excerpt=highlight`);
 * - `content.status`, `content.history.ownedBy` and `content.metadata.labels`
 *   arrive in the SAME response, so an eight-column table costs one request.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Profile } from "@atlcli/core";
import { ConfluenceClient } from "./client.js";

const OWNER = "Robert Lippert";

/** One `/search` result, shaped exactly as Cloud returns it. */
function result(i: number, over: Record<string, unknown> = {}): unknown {
  return {
    content: {
      id: `${1000 + i}`,
      type: "page",
      status: "current",
      title: `Page ${i}`,
      space: { key: "DOCSY", name: "Docs & Systems" },
      history: {
        lastUpdated: { when: "2026-05-26T06:25:48.628Z" },
        ownedBy: { displayName: OWNER, accountId: "557058:x" },
      },
      metadata: { labels: { results: [{ name: "jourfixe" }, { name: "m1" }] } },
      _links: { webui: `/spaces/DOCSY/pages/${1000 + i}/Page+${i}` },
      ...over,
    },
    title: `Page ${i}`,
    // Cloud's own excerpt: entity-encoded, newline-rich, sometimes highlighted.
    excerpt: `ChatGPT kann helfen: &quot;Hallo&quot;\nKanal ${i}`,
    url: `/spaces/DOCSY/pages/${1000 + i}/Page+${i}`,
    entityType: "content",
    lastModified: "2026-05-26T06:25:48.000Z",
  };
}

describe("ConfluenceClient.searchDetailed (spec SUPPORT-DATASOURCE-CONFLUENCE)", () => {
  let server: ReturnType<typeof Bun.serve>;
  let base = "";
  const requests: URL[] = [];

  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req) {
        const url = new URL(req.url);
        requests.push(url);
        if (url.pathname !== "/wiki/rest/api/search") {
          return new Response(JSON.stringify({ message: "no route" }), { status: 404 });
        }
        return Response.json({
          results: [result(1), result(2, { status: "archived", type: "blogpost" })],
          start: 0,
          limit: 25,
          size: 2,
          totalSize: 3309,
          _links: { base: `${base}/wiki`, context: "/wiki" },
        });
      },
    });
    base = `http://127.0.0.1:${server.port}`;
  });

  afterAll(() => server.stop(true));

  const profile = (): Profile => ({
    name: "token",
    baseUrl: base,
    deploymentType: "cloud",
    auth: { type: "apiToken", email: "t@example.com", token: "tok" },
  });

  test("drives GET /search — NOT /content/search, which carries no excerpt and no total", async () => {
    requests.length = 0;
    await new ConfluenceClient(profile()).searchDetailed('space in ("DOCSY")', { limit: 5 });
    expect(requests).toHaveLength(1);
    expect(requests[0]!.pathname).toBe("/wiki/rest/api/search");
    expect(requests[0]!.searchParams.get("cql")).toBe('space in ("DOCSY")');
    expect(requests[0]!.searchParams.get("limit")).toBe("5");
  });

  test("expands exactly the fields the four uncertain columns need", async () => {
    requests.length = 0;
    await new ConfluenceClient(profile()).searchDetailed("type = page");
    const expand = requests[0]!.searchParams.get("expand") ?? "";
    // `ownedBy` and `labels` are EXPANSIONS — measured, not assumed. Dropping
    // either blanks a column while the request still succeeds.
    expect(expand).toContain("content.history.ownedBy");
    expect(expand).toContain("content.metadata.labels");
    expect(expand).toContain("content.space");
    expect(expand).toContain("content.history.lastUpdated");
  });

  test("maps every one of the eight columns off ONE response", async () => {
    const page = await new ConfluenceClient(profile()).searchDetailed("type = page");
    const first = page.results[0]!;
    expect(first).toMatchObject({
      id: "1001",
      title: "Page 1",
      type: "page",
      spaceKey: "DOCSY",
      spaceName: "Docs & Systems",
      ownedBy: OWNER,
      lastModified: "2026-05-26T06:25:48.628Z",
      labels: ["jourfixe", "m1"],
      status: "current",
    });
    // `status` is a top-level field on the CONTENT, not a CQL-queryable one.
    expect(page.results[1]!.status).toBe("archived");
    expect(page.results[1]!.type).toBe("blogpost");
  });

  test("the excerpt is plain text: entities decoded, newlines collapsed", async () => {
    const page = await new ConfluenceClient(profile()).searchDetailed("type = page");
    expect(page.results[0]!.excerpt).toBe('ChatGPT kann helfen: "Hallo" Kanal 1');
  });

  test("relative result URLs become absolute against the response's own base", async () => {
    const page = await new ConfluenceClient(profile()).searchDetailed("type = page");
    expect(page.results[0]!.url).toBe(`${base}/wiki/spaces/DOCSY/pages/1001/Page+1`);
  });

  test("the server's total match count survives — it is what the truncation note names", async () => {
    const page = await new ConfluenceClient(profile()).searchDetailed("type = page");
    expect(page.totalSize).toBe(3309);
  });

  test("contentStatuses travels in cqlcontext, because CQL has no content-status field", async () => {
    requests.length = 0;
    await new ConfluenceClient(profile()).searchDetailed("type = page", {
      contentStatuses: ["current", "archived"],
    });
    expect(JSON.parse(requests[0]!.searchParams.get("cqlcontext")!)).toEqual({
      contentStatuses: ["current", "archived"],
    });
    expect(requests[0]!.searchParams.get("cql")).not.toContain("status");
  });

  test("no contentStatuses ⇒ no cqlcontext parameter at all", async () => {
    requests.length = 0;
    await new ConfluenceClient(profile()).searchDetailed("type = page");
    expect(requests[0]!.searchParams.has("cqlcontext")).toBe(false);
  });
});
