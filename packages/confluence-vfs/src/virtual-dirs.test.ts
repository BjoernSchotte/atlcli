import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfluenceVfsImpl } from "./confluence-vfs.js";
import { FakeConfluenceClient } from "./testing/fake-client.js";

let root: string;
let clock: number;

function seeded(): FakeConfluenceClient {
  return new FakeConfluenceClient()
    .seedSpace({ id: "sp-1", key: "DOCSY", name: "Docs", homepageId: "100" })
    .seedPage({ id: "100", title: "Docs Home", spaceKey: "DOCSY", storage: "<p>Home.</p>" })
    .seedPage({
      id: "101",
      title: "Getting Started",
      spaceKey: "DOCSY",
      parentId: "100",
      position: 1,
      storage: "<p>Start here.</p>",
      labels: ["runbook", "onboarding"],
      lastModified: "2026-09-16T08:00:00.000Z",
    })
    .seedPage({
      id: "102",
      title: "Architecture",
      spaceKey: "DOCSY",
      parentId: "100",
      position: 2,
      storage: "<p>Arch.</p>",
      labels: ["runbook"],
      lastModified: "2026-09-16T08:30:00.000Z",
    })
    .seedPage({
      id: "103",
      title: "Deployment",
      spaceKey: "DOCSY",
      parentId: "102",
      position: 1,
      storage: "<p>Deploy.</p>",
      lastModified: "2026-01-01T00:00:00.000Z",
    });
}

async function openVfs(
  client: FakeConfluenceClient,
  overrides: Record<string, unknown> = {},
): Promise<ConfluenceVfsImpl> {
  return ConfluenceVfsImpl.open({
    profile: "mayflower",
    client,
    mode: "ro",
    allowDelete: false,
    cacheDir: root,
    offline: false,
    now: () => clock,
    sleep: async (ms) => void (clock += ms),
    ...overrides,
  });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "vfs-virtual-"));
  clock = Date.parse("2026-09-16T09:00:00.000Z");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("_space.json and .me.json", () => {
  it("describes the space", async () => {
    const vfs = await openVfs(seeded());
    const json = JSON.parse(await vfs.readFile("/DOCSY/_space.json"));
    expect(json).toMatchObject({ key: "DOCSY", name: "Docs", homepageId: "100" });
    await vfs.close();
  });

  it("describes the caller, and names the visibility guarantee", async () => {
    const vfs = await openVfs(seeded());
    const json = JSON.parse(await vfs.readFile("/.me.json"));
    expect(json).toMatchObject({
      accountId: "acct-001",
      profile: "mayflower",
      deployment: "cloud",
    });
    expect(json.note).toContain("Confluence filters server-side");
    // And no token anywhere near it.
    expect(JSON.stringify(json)).not.toMatch(/token|password|secret/i);
    await vfs.close();
  });
});

describe("_attachments", () => {
  function withAttachments(): FakeConfluenceClient {
    const client = seeded();
    for (let i = 0; i < 10; i++) {
      client.seedAttachment({
        id: `att-${i}`,
        pageId: "102",
        filename: `file-${i}.bin`,
        bytes: new Uint8Array(1000 + i),
        mediaType: "application/octet-stream",
        modified: "2026-09-10T00:00:00.000Z",
      });
    }
    return client;
  }

  it("lists ten attachments and downloads zero bytes", async () => {
    const client = withAttachments();
    const vfs = await openVfs(client);
    const entries = await vfs.readdir("/DOCSY/architecture-102/_attachments");
    expect(entries).toHaveLength(10);
    expect(client.callsTo("downloadAttachment")).toBe(0);
    await vfs.close();
  });

  it("shares one listing across concurrent and sequential attachment stats, then expires", async () => {
    const client = withAttachments();
    const vfs = await openVfs(client);
    const directory = "/DOCSY/architecture-102/_attachments";
    await Promise.all(Array.from({ length: 10 }, (_, i) => vfs.stat(`${directory}/file-${i}.bin`)));
    await vfs.readdir(directory);
    await vfs.stat(`${directory}/file-3.bin`);
    expect(client.callsTo("listAttachments")).toBe(1);
    expect(client.callsTo("downloadAttachment")).toBe(0);
    clock += 60_001;
    await vfs.stat(`${directory}/file-3.bin`);
    expect(client.callsTo("listAttachments")).toBe(2);
    await vfs.close();
  });

  it("invalidates listed sizes after attachment writes and deletion", async () => {
    const client = withAttachments();
    const vfs = await openVfs(client, { mode: "rw", allowDelete: true });
    const path = "/DOCSY/architecture-102/_attachments/file-3.bin";
    expect((await vfs.stat(path)).size).toBe(1003);
    await vfs.writeFile(path, new Uint8Array(42));
    expect((await vfs.stat(path)).size).toBe(42);
    await vfs.rm(path);
    await expect(vfs.stat(path)).rejects.toMatchObject({ code: "ENOENT" });
    await vfs.close();
  });

  it("does not retain failed attachment listings", async () => {
    const client = withAttachments();
    const list = client.listAttachments.bind(client);
    let first = true;
    client.listAttachments = async (pageId) => {
      if (first) { first = false; throw new Error("temporary failure"); }
      return list(pageId);
    };
    const vfs = await openVfs(client);
    await expect(vfs.readdir("/DOCSY/architecture-102/_attachments")).rejects.toThrow();
    expect(await vfs.readdir("/DOCSY/architecture-102/_attachments")).toHaveLength(10);
    await vfs.close();
  });

  it("reports the exact size from metadata without a download", async () => {
    const client = withAttachments();
    const vfs = await openVfs(client);
    const stat = await vfs.stat("/DOCSY/architecture-102/_attachments/file-3.bin");
    expect(stat.size).toBe(1003);
    expect(stat.sizeEstimated).toBe(false);
    expect(client.callsTo("downloadAttachment")).toBe(0);
    await vfs.close();
  });

  it("downloads on a real read, then serves from the blob cache", async () => {
    const client = withAttachments();
    const vfs = await openVfs(client);
    const bytes = await vfs.readFileBytes("/DOCSY/architecture-102/_attachments/file-3.bin");
    expect(bytes.byteLength).toBe(1003);
    client.resetCalls();
    await vfs.readFileBytes("/DOCSY/architecture-102/_attachments/file-3.bin");
    expect(client.callsTo("downloadAttachment")).toBe(0);
    await vfs.close();
  });

  it("answers ENOENT for a filename that is not there", async () => {
    const vfs = await openVfs(withAttachments());
    await expect(vfs.readFileBytes("/DOCSY/architecture-102/_attachments/ghost.bin")).rejects.toMatchObject(
      { code: "ENOENT" },
    );
    await vfs.close();
  });
});

describe(".versions", () => {
  it("lists newest first and caps the list", async () => {
    const client = seeded();
    for (let v = 2; v <= 60; v++) {
      await client.updatePage({ id: "101", title: "Getting Started", storage: `<p>v${v}</p>`, version: v });
    }
    const vfs = await openVfs(client);
    await vfs.readdir("/DOCSY");
    const entries = await vfs.readdir("/DOCSY/getting-started-101/.versions");
    expect(entries).toHaveLength(50);
    expect(entries[0]!.name).toBe("60.md");
    expect(entries.at(-1)!.name).toBe("11.md");
    await vfs.close();
  });

  it("reads one version and refuses to write it", async () => {
    const client = seeded();
    await client.updatePage({ id: "101", title: "Getting Started", storage: "<p>v2</p>", version: 2 });
    const vfs = await openVfs(client);
    expect(await vfs.readFile("/DOCSY/getting-started-101/.versions/1.md")).toContain("Start here.");
    const stat = await vfs.stat("/DOCSY/getting-started-101/.versions/1.md");
    expect(stat.mode & 0o200).toBe(0);
    await vfs.close();
  });
});

describe(".comments.md", () => {
  it("shares concurrent reads and observes external comments when the metadata TTL expires", async () => {
    const client = seeded();
    const vfs = await openVfs(client, { treeTtlMs: 100 });
    const path = "/DOCSY/architecture-102/.comments.md";
    const reads = await Promise.all(Array.from({ length: 10 }, () => vfs.readFile(path)));
    expect(new Set(reads).size).toBe(1);
    expect(client.callsTo("getAllComments")).toBe(1);
    client.seedComments("102", { pageId: "102", lastSynced: "2026-09-17T00:00:00Z", inlineComments: [],
      footerComments: [{ id: "c1", author: { displayName: "Ada" }, created: "2026-09-17T00:00:00Z",
        body: "<p>External change</p>", status: "open", replies: [] }] });
    clock += 99;
    expect(await vfs.readFile(path)).toBe(reads[0]!);
    clock++;
    expect(await vfs.readFile(path)).toContain("External change");
    expect(client.callsTo("getAllComments")).toBe(2);
    await vfs.close();
  });

  it("retries failed comment loads instead of caching their rejection", async () => {
    const client = seeded(), get = client.getAllComments.bind(client);
    let first = true;
    client.getAllComments = async id => {
      if (first) { first = false; throw new Error("temporary failure"); }
      return get(id);
    };
    const vfs = await openVfs(client);
    const path = "/DOCSY/architecture-102/.comments.md";
    await expect(vfs.readFile(path)).rejects.toThrow();
    expect(await vfs.readFile(path)).toContain("_None._");
    await vfs.close();
  });

  it("evicts old comment listings after 256 pages", async () => {
    const client = seeded();
    for (let i = 0; i < 257; i++) client.seedPage({ id: String(1000 + i), title: `Page ${i}`,
      spaceKey: "DOCSY", parentId: "100", storage: "<p>Body</p>" });
    const vfs = await openVfs(client);
    for (let i = 0; i < 257; i++) await vfs.readFile(`/DOCSY/page-${i}-${1000 + i}/.comments.md`);
    expect(client.callsTo("getAllComments")).toBe(257);
    await vfs.readFile("/DOCSY/page-256-1256/.comments.md");
    expect(client.callsTo("getAllComments")).toBe(257);
    await vfs.readFile("/DOCSY/page-0-1000/.comments.md");
    expect(client.callsTo("getAllComments")).toBe(258);
    await vfs.close();
  });

  it("renders footer and inline comments with author, date and state", async () => {
    const client = seeded();
    client.seedComments("102", {
      pageId: "102",
      lastSynced: "2026-09-16T09:00:00.000Z",
      footerComments: [
        {
          id: "c1",
          author: { displayName: "Ada" },
          created: "2026-09-15T10:00:00.000Z",
          body: "<p>Looks good to me.</p>",
          status: "open",
          replies: [
            {
              id: "c2",
              author: { displayName: "Grace" },
              created: "2026-09-15T11:00:00.000Z",
              body: "<p>Agreed.</p>",
              status: "open",
              replies: [],
            },
          ],
        },
      ],
      inlineComments: [
        {
          id: "c3",
          author: { displayName: "Linus" },
          created: "2026-09-15T12:00:00.000Z",
          body: "<p>Is this still true?</p>",
          status: "resolved",
          textSelection: "Runs on clusters",
          replies: [],
        },
      ],
    } as never);

    const vfs = await openVfs(client);
    const markdown = await vfs.readFile("/DOCSY/architecture-102/.comments.md");

    expect(markdown).toContain("**Ada**, 2026-09-15T10:00:00.000Z");
    expect(markdown).toContain("Looks good to me.");
    expect(markdown).toContain("  - **Grace**");
    expect(markdown).toContain("_(resolved)_");
    expect(markdown).toContain("> Runs on clusters");
    // Storage HTML must not leak into the rendered view.
    expect(markdown).not.toContain("<p>");
    await vfs.close();
  });

  it("says so when there are none", async () => {
    const vfs = await openVfs(seeded());
    expect(await vfs.readFile("/DOCSY/architecture-102/.comments.md")).toContain("_None._");
    await vfs.close();
  });
});

describe(".by-id", () => {
  it("resolves a page the index has never walked to", async () => {
    const client = seeded();
    const vfs = await openVfs(client);
    // Nothing listed yet: 103 is two levels down.
    const stat = await vfs.stat("/DOCSY/.by-id/103.md");
    expect(stat.id).toBe("103");
    expect(client.callsTo("getPage")).toBe(0);
    expect(client.callsTo("getPagesBulk")).toBe(0);
    expect(client.callsTo("getPageMetadata")).toBe(1);
    await vfs.close();
  });

  it("is a symlink to the canonical path", async () => {
    const vfs = await openVfs(seeded());
    expect(await vfs.readlink("/DOCSY/.by-id/103.md")).toBe(
      "/DOCSY/architecture-102/deployment-103/_index.md",
    );
    await vfs.close();
  });

  it("reads transparently through the link", async () => {
    const vfs = await openVfs(seeded());
    expect(await vfs.readFile("/DOCSY/.by-id/103.md")).toContain("Deploy.");
    await vfs.close();
  });

  it("reads an unvisited result with one body download and no hierarchy requests", async () => {
    for (const deploymentType of ["cloud", "datacenter"] as const) {
      const client = seeded();
      Object.defineProperty(client, "deploymentType", { value: deploymentType });
      const vfs = await openVfs(client, { cacheDir: join(root, deploymentType) });
      try {
        const markdown = await vfs.readFile("/DOCSY/.by-id/103.md");
        expect(markdown).toContain("Deploy.");
        expect(markdown).toContain('parentId: "102"');
        expect(await vfs.readFile("/DOCSY/.by-id/103.md")).toBe(markdown);
        expect(client.callsTo("getPage")).toBe(1);
        expect(client.callsTo("getPageMetadata")).toBe(1);
        expect(client.callsTo("getAncestors")).toBe(0);
        expect(client.callsTo("getPageDirectChildren")).toBe(0);
        expect(client.callsTo("getChildren")).toBe(0);
      } finally { await vfs.close(); }
    }
  });

  it("revalidates a known by-id body after TTL without walking any hierarchy", async () => {
    const client = seeded();
    const vfs = await openVfs(client);
    try {
      expect(await vfs.readFile("/DOCSY/.by-id/103.md")).toContain("Deploy.");
      client.bumpVersion("103", "<p>Updated deployment.</p>");
      clock += 60_001;
      expect(await vfs.readFile("/DOCSY/.by-id/103.md")).toContain("Updated deployment.");
      expect(await vfs.readFile("/DOCSY/.by-id/103.md")).toContain("Updated deployment.");
      expect(client.callsTo("getPage")).toBe(2);
      expect(client.callsTo("getPageMetadata")).toBe(1);
      expect(client.callsTo("getPageVersions")).toBe(1);
      expect(client.callsTo("getPageDirectChildren")).toBe(0);
      expect(client.callsTo("getAncestors")).toBe(0);
    } finally { await vfs.close(); }
  });

  it("does not expose a foreign-space page through a mounted by-id alias", async () => {
    const client = seeded().seedSpace({ id: "sp-2", key: "OTHER", name: "Other", homepageId: "900" })
      .seedPage({ id: "900", title: "Other home", spaceKey: "OTHER", storage: "<p>Foreign content</p>" });
    const vfs = await openVfs(client, { spaces: ["DOCSY"] });
    try {
      await expect(vfs.readFile("/DOCSY/.by-id/900.md")).rejects.toMatchObject({ code: "ENOENT" });
      await expect(vfs.readlink("/DOCSY/.by-id/900.md")).rejects.toMatchObject({ code: "ENOENT" });
    } finally { await vfs.close(); }
  });

  it("answers ENOENT for an unknown id", async () => {
    const vfs = await openVfs(seeded());
    await expect(vfs.stat("/DOCSY/.by-id/999999.md")).rejects.toMatchObject({ code: "ENOENT" });
    await vfs.close();
  });

  it("answers ENOENT for a restricted id, revealing nothing", async () => {
    const client = seeded();
    client.hiddenIds.add("103");
    const vfs = await openVfs(client);
    await expect(vfs.stat("/DOCSY/.by-id/103.md")).rejects.toMatchObject({ code: "ENOENT" });
    await vfs.close();
  });

  it("lists only a README, never the whole space", async () => {
    const vfs = await openVfs(seeded());
    const entries = await vfs.readdir("/DOCSY/.by-id");
    expect(entries.map((e) => e.name)).toEqual(["README"]);
    expect(await vfs.readFile("/DOCSY/.by-id/README")).toContain("whole-space copy");
    await vfs.close();
  });
});

describe(".labels", () => {
  it("resolves a label with no registration step", async () => {
    const client = seeded();
    const vfs = await openVfs(client);
    const entries = await vfs.readdir("/DOCSY/.labels/runbook");
    expect(entries.map((e) => e.name).sort()).toEqual([
      "architecture-102.md",
      "getting-started-101.md",
    ]);
    expect(entries.every((e) => e.isSymbolicLink)).toBe(true);
    await vfs.close();
  });

  it("points its entries back through .by-id so a page has one home", async () => {
    const vfs = await openVfs(seeded());
    await vfs.readdir("/DOCSY/.labels/runbook");
    expect(await vfs.readlink("/DOCSY/.labels/runbook/architecture-102.md")).toBe(
      "/DOCSY/.by-id/102.md",
    );
    await vfs.close();
  });

  it("reads a page through the label view", async () => {
    const vfs = await openVfs(seeded());
    expect(await vfs.readFile("/DOCSY/.labels/runbook/architecture-102.md")).toContain("Arch.");
    await vfs.close();
  });

  it("explains in its README why the listing is partial", async () => {
    const vfs = await openVfs(seeded());
    const readme = await vfs.readFile("/DOCSY/.labels/README");
    expect(readme).toContain("no endpoint that enumerates the labels");
    expect(readme).toContain("still works");
    await vfs.close();
  });

  it("returns an empty listing for a label nothing carries", async () => {
    const vfs = await openVfs(seeded());
    expect(await vfs.readdir("/DOCSY/.labels/nonexistent")).toEqual([]);
    await vfs.close();
  });
});

describe(".recent", () => {
  it("offers the three windows", async () => {
    const vfs = await openVfs(seeded());
    expect((await vfs.readdir("/DOCSY/.recent")).map((e) => e.name)).toEqual(["24h", "7d", "30d"]);
    await vfs.close();
  });

  it("lists only pages inside the window", async () => {
    const vfs = await openVfs(seeded());
    const recent = await vfs.readdir("/DOCSY/.recent/24h");
    const names = recent.map((e) => e.name);
    expect(names).toContain("getting-started-101.md");
    expect(names).toContain("architecture-102.md");
    // Deployment was last touched in January.
    expect(names).not.toContain("deployment-103.md");
    await vfs.close();
  });
});

describe(".search", () => {
  it("resolves a query without a prior mkdir", async () => {
    const vfs = await openVfs(seeded());
    const entries = await vfs.readdir('/DOCSY/.search/text ~ "arch"');
    expect(entries.map((e) => e.name)).toEqual(["architecture-102.md"]);
    await vfs.close();
  });

  it("keeps resolving after the hint list is lost", async () => {
    const vfs = await openVfs(seeded());
    await vfs.readdir('/DOCSY/.search/text ~ "arch"');
    expect((await vfs.readdir("/DOCSY/.search")).map((e) => e.name)).toContain('text ~ "arch"');

    rmSync(join(root, "search-hints.json"), { force: true });
    expect((await vfs.readdir("/DOCSY/.search")).map((e) => e.name)).toEqual(["README"]);
    // Resolution never consulted the list, so it still works.
    const entries = await vfs.readdir('/DOCSY/.search/text ~ "arch"');
    expect(entries.map((e) => e.name)).toEqual(["architecture-102.md"]);
    await vfs.close();
  });

  it("scopes every query to its own space", async () => {
    const client = seeded()
      .seedSpace({ id: "sp-2", key: "OTHER", name: "Other", homepageId: "200" })
      .seedPage({ id: "200", title: "Other Home", spaceKey: "OTHER", storage: "<p>arch</p>" });
    const vfs = await openVfs(client);
    const entries = await vfs.readdir('/DOCSY/.search/text ~ "arch"');
    expect(entries.map((e) => e.name)).not.toContain("other-home-200.md");
    await vfs.close();
  });

  it("cannot express a query containing a slash, and says so", async () => {
    const vfs = await openVfs(seeded());
    // A slash splits the path, so the query arrives as several segments and
    // must fail loudly rather than silently searching for its first fragment.
    await expect(
      vfs.readdir('/DOCSY/.search/created >= "2026/01/01"'),
    ).rejects.toMatchObject({ code: "ENOTDIR" });

    const readme = await vfs.readFile("/DOCSY/.search/README");
    expect(readme).toContain("cannot contain");
    expect(readme).toContain("cql");
    await vfs.close();
  });

  it("remembers at most twenty queries", async () => {
    const vfs = await openVfs(seeded());
    for (let i = 0; i < 25; i++) {
      await vfs.readdir(`/DOCSY/.search/text ~ "q${i}"`);
    }
    const entries = (await vfs.readdir("/DOCSY/.search")).filter((e) => e.name !== "README");
    expect(entries).toHaveLength(20);
    expect(entries[0]!.name).toBe('text ~ "q24"');
    await vfs.close();
  });
});

describe("non-page children", () => {
  it("renders a database and an embed as read-only json stubs", async () => {
    const client = seeded()
      .seedPage({
        id: "300",
        title: "Metrics",
        spaceKey: "DOCSY",
        parentId: "100",
        type: "database",
        position: 8,
      })
      .seedPage({
        id: "301",
        title: "Figma",
        spaceKey: "DOCSY",
        parentId: "100",
        type: "embed",
        position: 9,
      });
    const vfs = await openVfs(client);
    const names = (await vfs.readdir("/DOCSY")).map((e) => e.name);
    expect(names).toContain("metrics-300.database.json");
    expect(names).toContain("figma-301.embed.json");

    const json = JSON.parse(await vfs.readFile("/DOCSY/metrics-300.database.json"));
    expect(json.type).toBe("database");
    expect(json.note).toContain("link only");
    expect((await vfs.stat("/DOCSY/metrics-300.database.json")).mode & 0o200).toBe(0);
    await vfs.close();
  });
});

describe("the convenience directories obey the demand principle", () => {
  it("fetches no bodies while listing every view", async () => {
    const client = seeded();
    const vfs = await openVfs(client);
    await vfs.readdir("/DOCSY");
    client.resetCalls();

    await vfs.readdir("/DOCSY/.by-id");
    await vfs.readdir("/DOCSY/.labels");
    await vfs.readdir("/DOCSY/.labels/runbook");
    await vfs.readdir("/DOCSY/.recent");
    await vfs.readdir("/DOCSY/.recent/7d");
    await vfs.readdir("/DOCSY/.search");
    await vfs.readdir('/DOCSY/.search/text ~ "arch"');
    await vfs.readdir("/DOCSY/architecture-102/_attachments");
    await vfs.readdir("/DOCSY/architecture-102/.versions");

    expect(client.callsTo("getPage")).toBe(0);
    expect(client.callsTo("getPagesBulk")).toBe(0);
    expect(client.callsTo("downloadAttachment")).toBe(0);
    await vfs.close();
  });
});
