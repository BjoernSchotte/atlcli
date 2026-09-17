/**
 * `getPagesBulk` (VFS plan WP3.4): the one bulk body fetch in the client.
 *
 * Driven against a local HTTP server rather than a mocked fetch, so the query
 * the client actually builds — `id`, `body-format`, `limit`, cursor — is part
 * of what is asserted.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { Profile } from "@atlcli/core";
import { ConfluenceClient } from "./client.js";

interface Recorded {
  path: string;
  query: URLSearchParams;
}

let server: ReturnType<typeof Bun.serve>;
let baseUrl: string;
let recorded: Recorded[] = [];
/** Ids the server pretends the caller cannot see. */
const hidden = new Set<string>();
/** Serve a second page of results for this many ids. */
let paginateAfter: number | undefined;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      recorded.push({ path: url.pathname, query: url.searchParams });

      if (!url.pathname.endsWith("/api/v2/pages")) {
        return new Response(JSON.stringify({ message: "unexpected route" }), { status: 404 });
      }

      const ids = (url.searchParams.get("id") ?? "").split(",").filter(Boolean);
      const cursor = url.searchParams.get("cursor");
      const visible = ids.filter((id) => !hidden.has(id));
      const split = paginateAfter ?? visible.length;
      const slice = cursor ? visible.slice(split) : visible.slice(0, split);
      const withBody = url.searchParams.get("body-format") === "storage";

      return Response.json({
        results: slice.map((id) => ({
          id,
          title: `Page ${id}`,
          parentId: "100",
          version: { number: Number(id) % 10, createdAt: "2026-09-17T12:34:56Z" },
          ...(withBody ? { body: { storage: { value: `<p>body of ${id}</p>` } } } : {}),
          _links: { webui: `/spaces/DOCSY/pages/${id}` },
        })),
        _links:
          !cursor && paginateAfter !== undefined
            ? { next: `/wiki/api/v2/pages?cursor=next-page&id=${ids.join(",")}` }
            : {},
      });
    },
  });
  baseUrl = `http://127.0.0.1:${server.port}`;
});

afterAll(() => server.stop(true));

function cloudProfile(): Profile {
  return {
    name: "cloud",
    baseUrl,
    deploymentType: "cloud",
    auth: { type: "apiToken", email: "user@example.com", token: "api-token" },
  };
}

describe("getPagesBulk", () => {
  it("fetches many bodies in one request", async () => {
    recorded = [];
    hidden.clear();
    paginateAfter = undefined;
    const client = new ConfluenceClient(cloudProfile());

    const pages = await client.getPagesBulk(["101", "102", "103"]);

    expect(pages.map((p) => p.id)).toEqual(["101", "102", "103"]);
    expect(pages[0]!.storage).toBe("<p>body of 101</p>");
    expect(pages[0]!.lastModified).toBe("2026-09-17T12:34:56Z");
    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.query.get("id")).toBe("101,102,103");
    expect(recorded[0]!.query.get("body-format")).toBe("storage");
    expect(recorded[0]!.query.get("limit")).toBe("250");
  });

  it("omits a page the caller may not see rather than failing", async () => {
    recorded = [];
    hidden.clear();
    hidden.add("102");
    paginateAfter = undefined;
    const client = new ConfluenceClient(cloudProfile());

    const pages = await client.getPagesBulk(["101", "102", "103"]);

    expect(pages.map((p) => p.id)).toEqual(["101", "103"]);
  });

  it("follows the cursor rather than stopping on a short page", async () => {
    recorded = [];
    hidden.clear();
    paginateAfter = 2;
    const client = new ConfluenceClient(cloudProfile());

    const pages = await client.getPagesBulk(["101", "102", "103"]);

    expect(pages.map((p) => p.id)).toEqual(["101", "102", "103"]);
    expect(recorded).toHaveLength(2);
  });

  it("de-duplicates ids and drops anything that is not numeric", async () => {
    recorded = [];
    hidden.clear();
    paginateAfter = undefined;
    const client = new ConfluenceClient(cloudProfile());

    await client.getPagesBulk(["101", "101", "not-an-id", "102"]);

    expect(recorded[0]!.query.get("id")).toBe("101,102");
  });

  it("makes no request at all for an empty id list", async () => {
    recorded = [];
    const client = new ConfluenceClient(cloudProfile());
    expect(await client.getPagesBulk([])).toEqual([]);
    expect(recorded).toHaveLength(0);
  });

  it("refuses on Data Center, where REST v2 does not exist", async () => {
    const client = new ConfluenceClient({
      name: "dc",
      baseUrl,
      deploymentType: "data-center",
      auth: { type: "bearer", pat: "pat" },
    });
    // `getPagesBulk` is async, so the refusal arrives as a rejection.
    await expect(client.getPagesBulk(["101"])).rejects.toBeInstanceOf(TypeError);
  });

  it("chunks beyond the 250-page ceiling", async () => {
    recorded = [];
    hidden.clear();
    paginateAfter = undefined;
    const client = new ConfluenceClient(cloudProfile());

    const ids = Array.from({ length: 251 }, (_, i) => String(1000 + i));
    const pages = await client.getPagesBulk(ids);

    expect(pages).toHaveLength(251);
    expect(recorded).toHaveLength(2);
    expect(recorded[0]!.query.get("id")!.split(",")).toHaveLength(250);
    expect(recorded[1]!.query.get("id")!.split(",")).toHaveLength(1);
  });
});
