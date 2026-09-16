/**
 * The fake is the substrate of every VFS test, so its own behaviour is pinned
 * here. A fake that quietly diverges from Confluence would make green tests
 * meaningless.
 */
import { beforeEach, describe, expect, it } from "bun:test";
import { FakeConfluenceClient } from "./fake-client.js";

function seeded(): FakeConfluenceClient {
  return new FakeConfluenceClient()
    .seedSpace({ id: "sp-1", key: "DOCSY", name: "Docs", homepageId: "100" })
    .seedPage({ id: "100", title: "Docs Home", spaceKey: "DOCSY", storage: "<p>home</p>" })
    .seedPage({
      id: "101",
      title: "Getting Started",
      spaceKey: "DOCSY",
      parentId: "100",
      storage: "<p>Install with Kubernetes.</p>",
      position: 1,
      labels: ["runbook"],
    })
    .seedPage({
      id: "102",
      title: "Architecture",
      spaceKey: "DOCSY",
      parentId: "100",
      storage: "<p>Runs on clusters.</p>",
      position: 2,
    })
    .seedPage({
      id: "103",
      title: "Deployment",
      spaceKey: "DOCSY",
      parentId: "102",
      storage: "<p>Deep child.</p>",
    })
    .seedPage({
      id: "104",
      title: "Runbooks",
      spaceKey: "DOCSY",
      parentId: "100",
      type: "folder",
      position: 3,
    });
}

describe("hierarchy", () => {
  let client: FakeConfluenceClient;
  beforeEach(() => {
    client = seeded();
  });

  it("lists direct children in child position order", async () => {
    const children = await client.getPageDirectChildren("100");
    expect(children.map((c) => c.id)).toEqual(["101", "102", "104"]);
    expect(children.map((c) => c.type)).toEqual(["page", "page", "folder"]);
  });

  it("does not descend for direct children", async () => {
    const children = await client.getPageDirectChildren("100");
    expect(children.map((c) => c.id)).not.toContain("103");
  });

  it("counts every call", async () => {
    client.resetCalls();
    await client.getPageDirectChildren("100");
    await client.getPageDirectChildren("102");
    expect(client.callsTo("getPageDirectChildren")).toBe(2);
    expect(client.requestCount).toBe(2);
  });
});

describe("visibility", () => {
  it("answers 404 for a hidden page, never 403", async () => {
    const client = seeded();
    client.hiddenIds.add("102");
    await expect(client.getPage("102")).rejects.toMatchObject({ status: 404 });
  });

  it("omits hidden pages from listings", async () => {
    const client = seeded();
    client.hiddenIds.add("102");
    const children = await client.getPageDirectChildren("100");
    expect(children.map((c) => c.id)).toEqual(["101", "104"]);
  });

  it("omits hidden pages from the body-free version probe", async () => {
    const client = seeded();
    client.hiddenIds.add("102");
    const versions = await client.getPageVersions(["101", "102"]);
    expect([...versions.keys()]).toEqual(["101"]);
  });
});

describe("versions", () => {
  it("requires version = current + 1 and answers 409 otherwise", async () => {
    const client = seeded();
    await expect(
      client.updatePage({ id: "101", title: "Getting Started", storage: "<p>x</p>", version: 1 }),
    ).rejects.toMatchObject({ status: 409 });
    const updated = await client.updatePage({
      id: "101",
      title: "Getting Started",
      storage: "<p>x</p>",
      version: 2,
    });
    expect(updated.version).toBe(2);
  });

  it("keeps every version readable and immutable", async () => {
    const client = seeded();
    await client.updatePage({ id: "101", title: "Getting Started", storage: "<p>v2</p>", version: 2 });
    const v1 = await client.getPageAtVersion("101", 1);
    expect(v1.storage).toBe("<p>Install with Kubernetes.</p>");
    const v2 = await client.getPageAtVersion("101", 2);
    expect(v2.storage).toBe("<p>v2</p>");
  });

  it("simulates an out-of-band edit through bumpVersion", async () => {
    const client = seeded();
    expect(client.bumpVersion("101", "<p>someone else</p>")).toBe(2);
    expect((await client.getPage("101")).version).toBe(2);
  });
});

describe("failure injection", () => {
  it("fails the programmed number of times, then recovers", async () => {
    const client = seeded();
    client.failNext({ method: "getPage", status: 429, times: 2, retryAfterMs: 100 });
    await expect(client.getPage("101")).rejects.toMatchObject({ status: 429 });
    await expect(client.getPage("101")).rejects.toMatchObject({ status: 429 });
    expect((await client.getPage("101")).id).toBe("101");
  });

  it("can target one id only", async () => {
    const client = seeded();
    client.failNext({ method: "getPage", status: 409, times: 5, match: "102" });
    expect((await client.getPage("101")).id).toBe("101");
    await expect(client.getPage("102")).rejects.toMatchObject({ status: 409 });
  });
});

describe("CQL subset", () => {
  it("matches text on whole words, not word parts", async () => {
    const client = seeded();
    const hit = await client.searchPages('space = DOCSY AND type = page AND text ~ "kubernetes"');
    expect(hit.map((r) => r.id)).toEqual(["101"]);
    const miss = await client.searchPages('space = DOCSY AND type = page AND text ~ "kubern"');
    expect(miss).toHaveLength(0);
  });

  it("honours an explicit trailing wildcard", async () => {
    const client = seeded();
    const hit = await client.searchPages('space = DOCSY AND text ~ "kubern*"');
    expect(hit.map((r) => r.id)).toEqual(["101"]);
  });

  it("filters by label and by space", async () => {
    const client = seeded();
    expect((await client.searchPages('space = DOCSY AND label = "runbook"')).map((r) => r.id)).toEqual(["101"]);
    expect(await client.searchPages('space = OTHER AND text ~ "kubernetes"')).toHaveLength(0);
  });
});

describe("delete is the trash", () => {
  it("marks the page and its descendants trashed rather than removing them", async () => {
    const client = seeded();
    await client.deletePage("102");
    expect(client.isTrashed("102")).toBe(true);
    expect(client.isTrashed("103")).toBe(true);
    // Still present in the store — nothing was purged.
    expect(client.peekPage("103")).toBeDefined();
    await expect(client.getPage("103")).rejects.toMatchObject({ status: 404 });
  });
});

describe("title uniqueness", () => {
  it("answers 400 when a page with that title already exists in the space", async () => {
    const client = seeded();
    await expect(
      client.createPage({ spaceKey: "DOCSY", title: "Architecture", storage: "<p>dup</p>" }),
    ).rejects.toMatchObject({ status: 400 });
  });
});

describe("attachments", () => {
  it("lists, downloads and versions attachments", async () => {
    const client = seeded().seedAttachment({
      id: "att-1",
      pageId: "102",
      filename: "diagram.png",
      bytes: new Uint8Array([1, 2, 3]),
      mediaType: "image/png",
    });
    const listed = await client.listAttachments("102");
    expect(listed).toHaveLength(1);
    expect(listed[0]!.fileSize).toBe(3);
    expect(await client.downloadAttachment(listed[0]!)).toEqual(new Uint8Array([1, 2, 3]));
    const updated = await client.updateAttachment({
      attachmentId: "att-1",
      pageId: "102",
      data: new Uint8Array([9]),
    });
    expect(updated.version).toBe(2);
  });
});
