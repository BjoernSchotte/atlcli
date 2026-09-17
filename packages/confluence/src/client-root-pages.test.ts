import { expect, it } from "bun:test";
import { ConfluenceClient } from "./client.js";

it("lists only Cloud roots without bodies and follows short cursor pages", async () => {
  const requests: URL[] = [];
  let invalid = false;
  const server = Bun.serve({ port: 0, fetch(request) {
    const url = new URL(request.url); requests.push(url);
    if (url.pathname.endsWith("/space/DOCSY")) return Response.json({ id: "1", key: "DOCSY", name: "Docs" });
    if (!url.pathname.endsWith("/api/v2/spaces/1/pages")) return new Response("unexpected", { status: 404 });
    return Response.json({ results: [{ id: url.searchParams.has("cursor") ? "101" : "100",
      spaceId: "1", parentId: invalid ? "999" : null, title: "Root", version: { number: 2 },
      body: { storage: { value: "must not escape into metadata" } } }],
      _links: url.searchParams.has("cursor") ? {} : { next: "/wiki/api/v2/spaces/1/pages?cursor=next" } });
  } });
  try {
    const client = new ConfluenceClient({ name: "fixture", baseUrl: `http://127.0.0.1:${server.port}`,
      deploymentType: "cloud", auth: { type: "apiToken", email: "fixture@example.com", token: "fixture" } });
    const pages = await client.getSpaceRootPages({ id: "1", key: "DOCSY" });
    expect(pages.map(page => page.id)).toEqual(["100", "101"]);
    expect(pages.every(page => page.parentId === null && page.spaceKey === "DOCSY" && !("storage" in page))).toBe(true);
    const listings = requests.filter(url => url.pathname.endsWith("/pages"));
    expect(listings).toHaveLength(2);
    expect(requests).toHaveLength(2); // Reuse the caller's resolved space; no second ID lookup.
    for (const url of listings) {
      expect(url.searchParams.get("depth")).toBe("root");
      expect(url.searchParams.get("status")).toBe("current");
      expect(url.searchParams.has("body-format")).toBe(false);
    }
    invalid = true;
    await expect(client.getSpaceRootPages({ id: "1", key: "DOCSY" })).rejects.toThrow("identity or parent");
  } finally { server.stop(true); }
});
