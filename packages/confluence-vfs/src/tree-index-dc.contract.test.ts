/**
 * Data Center contract suite (WP2.6), modelled on
 * `apps/cli/src/commands/wiki-import-dc.contract.test.ts`.
 *
 * The other tree-index tests drive a fake *client*. This one drives the **real**
 * `ConfluenceClient` against a local HTTP server that speaks Confluence Data
 * Center REST v1 — bearer auth, a non-root context path, CQL child search — so
 * it certifies the contract rather than our mental model of it. Two things it
 * exists to catch:
 *
 *  1. The VFS calling a v2-only endpoint on Data Center. `getPageVersions`
 *     throws a TypeError there, and the server below has no v2 routes at all,
 *     so any such call fails the suite.
 *  2. The demand principle holding over the wire: the recorded request list is
 *     asserted, not just the results.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { ConfluenceClient } from "@atlcli/confluence";
import type { Profile } from "@atlcli/core";
import { TreeIndex } from "./tree-index.js";

interface Recorded {
  method: string;
  path: string;
  authorization: string | null;
}

const CONTEXT_PATH = "/confluence";
const recorded: Recorded[] = [];

interface DcPage {
  id: string;
  title: string;
  parentId: string | null;
  version: number;
  lastModified: string;
}

const pages = new Map<string, DcPage>([
  ["100", { id: "100", title: "Docs Home", parentId: null, version: 1, lastModified: "2026-09-01T10:00:00.000Z" }],
  ["101", { id: "101", title: "Getting Started", parentId: "100", version: 3, lastModified: "2026-09-02T10:00:00.000Z" }],
  ["102", { id: "102", title: "Architecture", parentId: "100", version: 7, lastModified: "2026-09-03T10:00:00.000Z" }],
  ["103", { id: "103", title: "Deployment", parentId: "102", version: 2, lastModified: "2026-09-04T10:00:00.000Z" }],
]);

let server: ReturnType<typeof Bun.serve>;
let baseUrl: string;

/** The `GET /rest/api/content/search` shape the v1 client parses. */
function searchResponse(matches: DcPage[], base: string): unknown {
  return {
    results: matches.map((page) => ({
      id: page.id,
      type: "page",
      title: page.title,
      space: { key: "DOCSY", name: "Docs" },
      version: { number: page.version },
      history: { lastUpdated: { when: page.lastModified } },
      metadata: { labels: { results: [] } },
      _links: { base, webui: `/spaces/DOCSY/pages/${page.id}` },
    })),
    start: 0,
    limit: 250,
    size: matches.length,
    totalSize: matches.length,
    _links: { base },
  };
}

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      recorded.push({
        method: request.method,
        path: url.pathname + url.search,
        authorization: request.headers.get("authorization"),
      });

      // Anything outside the v1 REST namespace is a contract violation.
      if (!url.pathname.startsWith(`${CONTEXT_PATH}/rest/api/`)) {
        return new Response(JSON.stringify({ message: "not a v1 endpoint" }), { status: 404 });
      }
      const route = url.pathname.slice(`${CONTEXT_PATH}/rest/api/`.length);
      const base = `${baseUrl}${CONTEXT_PATH}`;

      if (route === "space/DOCSY") {
        // `getSpaceHomepageId` asks for the same route with
        // `?expand=homepage.id`, so one handler serves both.
        return Response.json({
          id: 555,
          key: "DOCSY",
          name: "Docs",
          type: "global",
          status: "current",
          homepage: { id: "100", title: "Docs Home" },
          _links: { base, webui: "/spaces/DOCSY" },
        });
      }

      if (route === "content/search") {
        const cql = url.searchParams.get("cql") ?? "";
        const parent = /parent=(\d+)/.exec(cql)?.[1];
        const matches = [...pages.values()].filter((page) => page.parentId === parent);
        return Response.json(searchResponse(matches, base));
      }

      return new Response(JSON.stringify({ message: `unmapped route ${route}` }), { status: 404 });
    },
  });
  baseUrl = `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
  server.stop(true);
});

function dcProfile(): Profile {
  return {
    name: "dc",
    baseUrl: `${baseUrl}${CONTEXT_PATH}`,
    deploymentType: "data-center",
    auth: { type: "bearer", pat: "dc-personal-access-token" },
  };
}

function makeIndex(): { index: TreeIndex; advance: (ms: number) => void } {
  let clock = 1_700_000_000_000;
  const index = new TreeIndex({
    client: new ConfluenceClient(dcProfile()),
    ttlMs: 60_000,
    concurrency: 4,
    offline: false,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    now: () => clock,
    sleep: async (ms) => void (clock += ms),
  });
  return { index, advance: (ms) => void (clock += ms) };
}

describe("Data Center tree index over real HTTP", () => {
  it("authenticates with the personal access token as a bearer token", async () => {
    recorded.length = 0;
    const { index } = makeIndex();
    await index.getSpace("DOCSY");
    expect(recorded.every((r) => r.authorization === "Bearer dc-personal-access-token")).toBe(true);
  });

  it("lists one level through the v1 CQL child search", async () => {
    recorded.length = 0;
    const { index } = makeIndex();
    await index.getHomepageId("DOCSY");
    const children = await index.loadChildren("100");

    expect(children.map((c) => c.title)).toEqual(["Getting Started", "Architecture"]);
    expect(children.map((c) => c.version)).toEqual([3, 7]);
    const searches = recorded.filter((r) => r.path.includes("/rest/api/content/search"));
    expect(searches).toHaveLength(1);
    // `+` is the query encoding of a space, so decode it back before matching.
    expect(decodeURIComponent(searches[0]!.path).replace(/\+/g, " ")).toContain(
      "parent=100 AND type=page",
    );
  });

  it("never touches a v2 endpoint, including on revalidation", async () => {
    recorded.length = 0;
    const { index, advance } = makeIndex();
    await index.getHomepageId("DOCSY");
    await index.loadChildren("100");
    advance(60_001);

    // The Cloud path would call `getPageVersions`, which throws on Data Center.
    await index.revalidate("100");

    expect(recorded.some((r) => r.path.includes("/api/v2/"))).toBe(false);
    expect(recorded.some((r) => r.path.includes("include-version"))).toBe(false);
  });

  it("keeps a branch nobody entered unfetched", async () => {
    const { index } = makeIndex();
    await index.getHomepageId("DOCSY");
    await index.loadChildren("100");
    recorded.length = 0;

    expect(index.isUnloaded("102")).toBe(true);
    expect(recorded).toHaveLength(0);
  });

  it("fetches no bodies while walking the tree", async () => {
    recorded.length = 0;
    const { index } = makeIndex();
    await index.getHomepageId("DOCSY");
    await index.loadChildren("100");
    await index.loadChildren("102");

    const bodyFetches = recorded.filter((r) => /expand=.*body/.test(r.path));
    expect(bodyFetches).toHaveLength(0);
  });
});
