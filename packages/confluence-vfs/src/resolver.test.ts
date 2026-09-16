import { beforeEach, describe, expect, it } from "bun:test";
import { ConfluenceVfsImpl } from "./confluence-vfs.js";
import { resolveVfsOptions } from "./options.js";
import { FakeConfluenceClient } from "./testing/fake-client.js";

function seeded(): FakeConfluenceClient {
  return new FakeConfluenceClient()
    .seedSpace({ id: "sp-1", key: "DOCSY", name: "Docs", homepageId: "100" })
    .seedPage({ id: "100", title: "Docs Home", spaceKey: "DOCSY", storage: "<p>home</p>" })
    .seedPage({
      id: "101",
      title: "Getting Started",
      spaceKey: "DOCSY",
      parentId: "100",
      position: 1,
      storage: "<p>start</p>",
    })
    .seedPage({
      id: "102",
      title: "Architecture",
      spaceKey: "DOCSY",
      parentId: "100",
      position: 2,
      storage: "<p>arch</p>",
    })
    .seedPage({
      id: "103",
      title: "Deployment",
      spaceKey: "DOCSY",
      parentId: "102",
      position: 1,
      storage: "<p>deploy</p>",
    })
    .seedPage({
      id: "104",
      title: "Runbooks",
      spaceKey: "DOCSY",
      parentId: "100",
      type: "folder",
      position: 3,
    })
    .seedPage({
      id: "105",
      title: "Roadmap Board",
      spaceKey: "DOCSY",
      parentId: "100",
      type: "whiteboard",
      position: 4,
    });
}

function makeVfs(client: FakeConfluenceClient, overrides = {}): ConfluenceVfsImpl {
  let clock = 1_700_000_000_000;
  return new ConfluenceVfsImpl(
    resolveVfsOptions({
      profile: "test",
      client,
      mode: "ro",
      allowDelete: false,
      cacheDir: "/tmp/vfs-test",
      offline: false,
      now: () => clock,
      sleep: async (ms) => void (clock += ms),
      ...overrides,
    }),
  );
}

describe("resolve", () => {
  let client: FakeConfluenceClient;
  let vfs: ConfluenceVfsImpl;

  beforeEach(() => {
    client = seeded();
    vfs = makeVfs(client);
  });

  it("resolves the root and the space", async () => {
    expect((await vfs.stat("/")).isDirectory).toBe(true);
    expect((await vfs.stat("/DOCSY")).kind).toBe("space");
  });

  it("resolves a page by id, ignoring the slug", async () => {
    const canonical = await vfs.stat("/DOCSY/architecture-102");
    const stale = await vfs.stat("/DOCSY/whatever-the-old-title-was-102");
    expect(canonical.id).toBe("102");
    expect(stale.id).toBe("102");
  });

  it("resolves the body through both _index.md and the .md alias", async () => {
    expect((await vfs.stat("/DOCSY/architecture-102/_index.md")).id).toBe("102");
    expect((await vfs.stat("/DOCSY/architecture-102.md")).id).toBe("102");
  });

  it("resolves a nested page one level at a time", async () => {
    const stat = await vfs.stat("/DOCSY/architecture-102/deployment-103");
    expect(stat.id).toBe("103");
  });

  it("resolves the space home page body", async () => {
    expect((await vfs.stat("/DOCSY/_index.md")).id).toBe("100");
  });

  it("answers ENOENT for an id the index does not know", async () => {
    await expect(vfs.stat("/DOCSY/ghost-999999")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("answers ENOENT for a name with no id at all", async () => {
    await expect(vfs.stat("/DOCSY/new-page.md")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("answers ENOENT for an unknown space", async () => {
    await expect(vfs.stat("/NOPE")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("answers ENOTDIR when a path continues past a body", async () => {
    await expect(vfs.stat("/DOCSY/architecture-102.md/nested")).rejects.toMatchObject({
      code: "ENOTDIR",
    });
  });

  it("refuses to escape the root", async () => {
    await expect(vfs.stat("/DOCSY/../../etc/passwd")).rejects.toMatchObject({ code: "EINVAL" });
  });

  it("resolves the side objects of a page", async () => {
    expect((await vfs.stat("/DOCSY/architecture-102/_attachments")).isDirectory).toBe(true);
    expect((await vfs.stat("/DOCSY/architecture-102/.versions")).isDirectory).toBe(true);
    expect((await vfs.stat("/DOCSY/architecture-102/.versions/3.md")).version).toBe(3);
    expect((await vfs.stat("/DOCSY/architecture-102/.comments.md")).isFile).toBe(true);
  });

  it("resolves the space-level convenience directories", async () => {
    for (const name of [".by-id", ".labels", ".recent", ".search"]) {
      expect((await vfs.stat(`/DOCSY/${name}`)).isDirectory).toBe(true);
    }
    expect((await vfs.stat("/DOCSY/.recent/7d")).isDirectory).toBe(true);
    expect((await vfs.stat("/DOCSY/.by-id/102.md")).isSymbolicLink).toBe(true);
    expect((await vfs.stat("/.me.json")).isFile).toBe(true);
    expect((await vfs.stat("/DOCSY/_space.json")).isFile).toBe(true);
  });

  it("rejects an unknown .recent window", async () => {
    await expect(vfs.stat("/DOCSY/.recent/99d")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("resolves a non-page child as a read-only json stub", async () => {
    const stat = await vfs.stat("/DOCSY/roadmap-board-105.whiteboard.json");
    expect(stat.isFile).toBe(true);
    expect(stat.mode & 0o200).toBe(0);
  });
});

describe("readdir", () => {
  let client: FakeConfluenceClient;
  let vfs: ConfluenceVfsImpl;

  beforeEach(() => {
    client = seeded();
    vfs = makeVfs(client);
  });

  it("lists spaces and .me.json at the root", async () => {
    const entries = await vfs.readdir("/");
    expect(entries.map((e) => e.name)).toEqual(["DOCSY", ".me.json"]);
  });

  it("lists a space: metadata, home body, children, convenience dirs", async () => {
    const names = (await vfs.readdir("/DOCSY")).map((e) => e.name);
    expect(names).toEqual([
      "_space.json",
      "_index.md",
      "getting-started-101",
      "architecture-102",
      "runbooks-104",
      "roadmap-board-105.whiteboard.json",
      ".by-id",
      ".labels",
      ".recent",
      ".search",
    ]);
  });

  it("presents every page as a directory (deviation D1)", async () => {
    const entries = await vfs.readdir("/DOCSY");
    const leaf = entries.find((e) => e.name === "getting-started-101");
    expect(leaf?.isDirectory).toBe(true);
  });

  it("lists a page directory with its body, children and side objects", async () => {
    const names = (await vfs.readdir("/DOCSY/architecture-102")).map((e) => e.name);
    expect(names).toEqual([
      "_index.md",
      "deployment-103",
      "_attachments",
      ".versions",
      ".comments.md",
    ]);
  });

  it("gives a Confluence folder no attachments, versions or comments", async () => {
    const names = (await vfs.readdir("/DOCSY/runbooks-104")).map((e) => e.name);
    expect(names).toEqual(["_index.md"]);
  });

  it("refuses to list a file", async () => {
    await expect(vfs.readdir("/DOCSY/architecture-102.md")).rejects.toMatchObject({
      code: "ENOTDIR",
    });
  });
});

describe("demand principle: stat and readdir never fetch a body", () => {
  it("holds across a 5,000-page space", async () => {
    const client = new FakeConfluenceClient().seedSpace({
      id: "sp-1",
      key: "BIG",
      name: "Big",
      homepageId: "1",
    });
    client.seedPage({ id: "1", title: "Home", spaceKey: "BIG", storage: "<p>home</p>" });
    // 50 top-level pages, 100 children each: 5,050 pages in total.
    for (let top = 0; top < 50; top++) {
      const topId = String(10_000 + top);
      client.seedPage({
        id: topId,
        title: `Section ${top}`,
        spaceKey: "BIG",
        parentId: "1",
        position: top,
        storage: "<p>section</p>",
      });
      for (let child = 0; child < 100; child++) {
        client.seedPage({
          id: `${topId}${String(child).padStart(3, "0")}`,
          title: `Page ${top}-${child}`,
          spaceKey: "BIG",
          parentId: topId,
          position: child,
          storage: "<p>leaf</p>",
        });
      }
    }

    const vfs = makeVfs(client);
    client.resetCalls();

    // List ten directories and stat a hundred files.
    const top = await vfs.readdir("/BIG");
    const sections = top.filter((e) => e.name.startsWith("section-")).slice(0, 10);
    for (const section of sections) {
      const children = await vfs.readdir(`/BIG/${section.name}`);
      for (const child of children.slice(0, 10)) {
        await vfs.stat(`/BIG/${section.name}/${child.name}`);
      }
    }

    expect(client.callsTo("getPage")).toBe(0);
    expect(client.callsTo("getPageAtVersion")).toBe(0);
    expect(client.callsTo("downloadAttachment")).toBe(0);
    // Requests track the directories *visited*, not the size of the space:
    // one for the space root plus one per section entered.
    expect(client.callsTo("getPageDirectChildren")).toBe(11);
  });

  it("marks an unmeasured size as an estimate rather than reporting zero", async () => {
    const vfs = makeVfs(seeded());
    const stat = await vfs.stat("/DOCSY/architecture-102.md");
    expect(stat.sizeEstimated).toBe(true);
    expect(stat.size).toBeGreaterThan(0);
  });
});

describe("visibility", () => {
  it("hides a restricted page as ENOENT, never EACCES", async () => {
    const client = seeded();
    client.hiddenIds.add("102");
    const vfs = makeVfs(client);
    await expect(vfs.stat("/DOCSY/architecture-102")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(vfs.stat("/DOCSY/.by-id/102.md")).resolves.toBeDefined();
    const names = (await vfs.readdir("/DOCSY")).map((e) => e.name);
    expect(names).not.toContain("architecture-102");
  });

  it("keeps a restricted page out of a nested listing too", async () => {
    const client = seeded();
    client.hiddenIds.add("103");
    const vfs = makeVfs(client);
    const names = (await vfs.readdir("/DOCSY/architecture-102")).map((e) => e.name);
    expect(names).not.toContain("deployment-103");
  });
});
