/**
 * The author, container and comment fields `atlcli digest` reads from
 * `search()` and `listPageCommentsV1()`, against a real HTTP origin. Shapes
 * as measured on Confluence Cloud (v1 `content` items) on 2026-10-22.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Profile } from "@atlcli/core";
import { ConfluenceClient } from "./client.js";

const COMMENT = {
  id: "2001",
  type: "comment",
  title: "Re: Plan",
  container: { id: 1350270983, type: "page", title: "Plan" },
  history: {
    createdBy: { accountId: "acc-2", displayName: "Eugen" },
    createdDate: "2026-10-19T13:11:35.832Z",
    lastUpdated: { when: "2026-10-19T13:11:35.832Z", by: { accountId: "acc-2", displayName: "Eugen" } },
  },
  extensions: { location: "inline", resolution: { status: "open", lastModifiedDate: "1970-01-01T00:00:00.000Z" } },
  _links: { webui: "/pages/2001" },
};
const PAGE = {
  id: "1001",
  type: "page",
  title: "Plan",
  space: { key: "DOCSY" },
  version: { number: 3, by: { accountId: "acc-3", displayName: "Robert" } },
  _links: { webui: "/pages/1001" },
};

let server: ReturnType<typeof Bun.serve>;
let seen: URL[] = [];

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      seen.push(url);
      if (url.pathname === "/wiki/rest/api/content/search") {
        return Response.json({ results: url.searchParams.get("cql")?.includes("comment") ? [COMMENT] : [PAGE], start: 0, limit: 25, size: 1 });
      }
      if (url.pathname === "/wiki/rest/api/content/1001/child/comment") return Response.json({ results: [COMMENT] });
      return new Response("no route", { status: 404 });
    },
  });
});

afterAll(() => server?.stop(true));

function client(): ConfluenceClient {
  const profile: Profile = {
    name: "t",
    baseUrl: `${server.url.origin}/wiki`,
    auth: { type: "apiToken", email: "t@example.com", token: "tok" },
  };
  return new ConfluenceClient(profile);
}

describe("digest fields", () => {
  test("search() appends extra expansions and parses comment fields", async () => {
    seen = [];
    const { results } = await client().search("type = comment", { expand: ["container", "extensions.resolution"] });
    expect(seen[0].searchParams.get("expand")).toBe(
      "version,space,history.lastUpdated,history.createdBy,history.createdDate,metadata.labels,container,extensions.resolution"
    );
    expect(results[0]).toMatchObject({
      id: "2001",
      creator: "Eugen",
      creatorId: "acc-2",
      lastModifiedBy: "Eugen",
      lastModifiedById: "acc-2",
      container: { id: "1350270983", type: "page", title: "Plan" },
      resolutionStatus: "open",
      location: "inline",
    });
  });

  test("the last editor falls back to version.by; absent fields stay absent", async () => {
    const { results } = await client().search("type = page");
    expect(results[0]).toMatchObject({ lastModifiedBy: "Robert", lastModifiedById: "acc-3" });
    expect("container" in results[0]).toBe(false);
    expect("resolutionStatus" in results[0]).toBe(false);
  });

  test("listPageCommentsV1 reads inline comments with display names", async () => {
    seen = [];
    const comments = await client().listPageCommentsV1("1001", { location: "inline", limit: 10 });
    expect(Object.fromEntries(seen[0].searchParams)).toEqual({
      location: "inline",
      depth: "all",
      limit: "10",
      expand: "history,version,container,extensions.resolution",
    });
    expect(comments[0]).toMatchObject({ creator: "Eugen", resolutionStatus: "open", created: "2026-10-19T13:11:35.832Z" });
  });
});
