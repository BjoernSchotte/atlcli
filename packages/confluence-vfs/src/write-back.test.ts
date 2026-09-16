import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeMarkdown } from "@atlcli/confluence/internal";
import { ConfluenceVfsImpl } from "./confluence-vfs.js";
import { parseVfsFrontmatter } from "./page-store.js";
import { FakeConfluenceClient } from "./testing/fake-client.js";

let root: string;
let clock: number;
/** Timers the coalescing window scheduled, run on demand. */
let scheduled: (() => void)[];

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
      storage: "<p>Install the CLI.</p>",
    })
    .seedPage({
      id: "102",
      title: "Architecture",
      spaceKey: "DOCSY",
      parentId: "100",
      position: 2,
      storage: "<p>Arch.</p>",
    })
    .seedPage({
      id: "103",
      title: "Deployment",
      spaceKey: "DOCSY",
      parentId: "102",
      position: 1,
      storage: "<p>Deploy.</p>",
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

async function openVfs(
  client: FakeConfluenceClient,
  overrides: Record<string, unknown> = {},
): Promise<ConfluenceVfsImpl> {
  return ConfluenceVfsImpl.open({
    profile: "mayflower",
    client,
    mode: "rw",
    allowDelete: true,
    cacheDir: root,
    offline: false,
    // Coalescing off by default here; the coalescing tests opt in.
    coalesceMs: 0,
    now: () => clock,
    sleep: async (ms) => void (clock += ms),
    schedule: (fn) => void scheduled.push(fn),
    ...overrides,
  });
}

/** Lets pending promises reach the point where they schedule their flush. */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

function runScheduled(): void {
  const due = scheduled;
  scheduled = [];
  for (const fn of due) fn();
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "vfs-write-"));
  clock = Date.parse("2026-09-16T09:00:00.000Z");
  scheduled = [];
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("mode guard on every route", () => {
  const writes: [string, (vfs: ConfluenceVfsImpl) => Promise<unknown>][] = [
    ["writeFile", (vfs) => vfs.writeFile("/DOCSY/getting-started-101/_index.md", "# x")],
    ["create", (vfs) => vfs.writeFile("/DOCSY/brand-new.md", "# new")],
    ["mkdir", (vfs) => vfs.mkdir("/DOCSY/new-section")],
    ["rename", (vfs) => vfs.rename("/DOCSY/getting-started-101", "/DOCSY/renamed")],
    ["rm", (vfs) => vfs.rm("/DOCSY/getting-started-101")],
    ["copy", (vfs) => vfs.copy("/DOCSY/getting-started-101", "/DOCSY/copy")],
  ];

  for (const [name, run] of writes) {
    it(`refuses ${name} with EROFS in ro mode`, async () => {
      const vfs = await openVfs(seeded(), { mode: "ro", allowDelete: false });
      await expect(run(vfs)).rejects.toMatchObject({ code: "EROFS" });
      await vfs.close();
    });
  }

  it("refuses rm with EACCES in rw mode until --allow-delete", async () => {
    const vfs = await openVfs(seeded(), { allowDelete: false });
    await expect(vfs.rm("/DOCSY/getting-started-101")).rejects.toMatchObject({ code: "EACCES" });
    await vfs.close();
  });

  it("makes no request at all when the mode refuses", async () => {
    const client = seeded();
    const vfs = await openVfs(client, { mode: "ro", allowDelete: false });
    await vfs.readdir("/DOCSY");
    client.resetCalls();
    await expect(vfs.writeFile("/DOCSY/getting-started-101/_index.md", "# x")).rejects.toBeDefined();
    expect(client.callsTo("updatePage")).toBe(0);
    await vfs.close();
  });
});

describe("update", () => {
  it("writes a changed body back at version + 1", async () => {
    const client = seeded();
    const vfs = await openVfs(client);
    const original = await vfs.readFile("/DOCSY/getting-started-101.md");
    const edited = original.replace("Install the CLI.", "Install the CLI with brew.");

    const result = await vfs.writeFile("/DOCSY/getting-started-101/_index.md", edited);

    expect(result.version).toBe(2);
    expect(client.peekPage("101")?.storage).toContain("brew");
    await vfs.close();
  });

  it("never sends frontmatter to Confluence", async () => {
    const client = seeded();
    const vfs = await openVfs(client);
    const original = await vfs.readFile("/DOCSY/getting-started-101.md");
    await vfs.writeFile("/DOCSY/getting-started-101/_index.md", original);
    expect(client.peekPage("101")?.storage).not.toContain("atlcli");
    await vfs.close();
  });

  it("takes a changed title from the frontmatter", async () => {
    const client = seeded();
    const vfs = await openVfs(client);
    const original = await vfs.readFile("/DOCSY/getting-started-101.md");
    const retitled = original.replace('title: "Getting Started"', 'title: "Getting Started Fast"');
    await vfs.writeFile("/DOCSY/getting-started-101/_index.md", retitled);
    expect(client.peekPage("101")?.title).toBe("Getting Started Fast");
    await vfs.close();
  });

  it("refuses to write the _index.md of a Confluence folder", async () => {
    const vfs = await openVfs(seeded());
    await expect(vfs.writeFile("/DOCSY/runbooks-104/_index.md", "# x")).rejects.toMatchObject({
      code: "EROFS",
    });
    await vfs.close();
  });

  it("refuses to write a generated view, whatever the mode", async () => {
    const vfs = await openVfs(seeded());
    for (const path of [
      "/DOCSY/getting-started-101/.versions/1.md",
      "/DOCSY/getting-started-101/.comments.md",
      "/DOCSY/_space.json",
      "/.me.json",
    ]) {
      await expect(vfs.writeFile(path, "x")).rejects.toMatchObject({ code: "EROFS" });
    }
    await vfs.close();
  });

  it("serves the next read from the cache without refetching", async () => {
    const client = seeded();
    const vfs = await openVfs(client);
    const original = await vfs.readFile("/DOCSY/getting-started-101.md");
    await vfs.writeFile("/DOCSY/getting-started-101/_index.md", original.replace("CLI", "tool"));
    client.resetCalls();
    expect(await vfs.readFile("/DOCSY/getting-started-101.md")).toContain("tool");
    expect(client.callsTo("getPage")).toBe(0);
    await vfs.close();
  });
});

describe("conflicts", () => {
  async function staleEdit(client: FakeConfluenceClient, serverBody: string, localEdit: string) {
    const vfs = await openVfs(client);
    const original = await vfs.readFile("/DOCSY/getting-started-101.md");
    // Someone else edits the page after we read it.
    client.bumpVersion("101", serverBody);
    return { vfs, edited: original.replace("Install the CLI.", localEdit) };
  }

  it("merges a stale write cleanly when the edits do not overlap", async () => {
    const client = seeded();
    const { vfs, edited } = await staleEdit(
      client,
      "<p>Install the CLI.</p><p>A new paragraph from someone else.</p>",
      "Install the CLI with brew.",
    );

    const result = await vfs.writeFile("/DOCSY/getting-started-101/_index.md", edited);

    expect(result.version).toBe(3);
    const stored = client.peekPage("101")!.storage;
    expect(stored).toContain("brew");
    expect(stored).toContain("someone else");
    await vfs.close();
  });

  it("writes a conflict file and fails with EBUSY when the edits collide", async () => {
    const client = seeded();
    const { vfs, edited } = await staleEdit(
      client,
      "<p>Install the CLI from source.</p>",
      "Install the CLI with brew.",
    );

    await expect(vfs.writeFile("/DOCSY/getting-started-101/_index.md", edited)).rejects.toMatchObject(
      { code: "EBUSY" },
    );

    const conflicts = vfs.conflicts!.list();
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({ pageId: "101", baseVersion: 1, serverVersion: 2 });
    expect(conflicts[0]!.content).toContain("<<<<<<<");
    // And the server was left alone.
    expect(client.peekPage("101")?.version).toBe(2);
    await vfs.close();
  });

  it("names the conflict file and the command that lists them", async () => {
    const client = seeded();
    const { vfs, edited } = await staleEdit(
      client,
      "<p>Install the CLI from source.</p>",
      "Install the CLI with brew.",
    );
    await expect(vfs.writeFile("/DOCSY/getting-started-101/_index.md", edited)).rejects.toThrow(
      /conflicts/,
    );
    await vfs.close();
  });

  it("survives a process restart", async () => {
    const client = seeded();
    const { vfs, edited } = await staleEdit(
      client,
      "<p>Install the CLI from source.</p>",
      "Install the CLI with brew.",
    );
    await expect(vfs.writeFile("/DOCSY/getting-started-101/_index.md", edited)).rejects.toBeDefined();
    const file = vfs.conflicts!.list()[0]!.file;
    await vfs.close();

    // A brand-new filesystem object, as a second process would have.
    const reopened = await openVfs(client);
    expect(reopened.conflicts!.list().map((c) => c.file)).toEqual([file]);
    expect(readFileSync(file, "utf8")).toContain("<<<<<<<");
    await reopened.close();
  });

  it("lets a read-only session discard a conflict, because that is local", async () => {
    const client = seeded();
    const { vfs, edited } = await staleEdit(
      client,
      "<p>Install the CLI from source.</p>",
      "Install the CLI with brew.",
    );
    await expect(vfs.writeFile("/DOCSY/getting-started-101/_index.md", edited)).rejects.toBeDefined();
    const file = vfs.conflicts!.list()[0]!.file;
    await vfs.close();

    const readOnly = await openVfs(client, { mode: "ro", allowDelete: false });
    expect(readOnly.conflicts!.discard(file)).toBe(true);
    expect(existsSync(file)).toBe(false);
    await readOnly.close();
  });

  it("handles a 409 the server raised after our check", async () => {
    const client = seeded();
    const vfs = await openVfs(client);
    const original = await vfs.readFile("/DOCSY/getting-started-101.md");
    // The index still believes version 1, so the pre-check passes; the server
    // rejects the PUT, which is the race this path exists for.
    client.failNext({ method: "updatePage", status: 409, times: 1, match: "101" });
    client.bumpVersion("101", "<p>Install the CLI.</p><p>Added remotely.</p>");

    const result = await vfs.writeFile(
      "/DOCSY/getting-started-101/_index.md",
      original.replace("Install the CLI.", "Install the CLI with brew."),
    );

    expect(result.version).toBe(3);
    expect(client.peekPage("101")?.storage).toContain("brew");
    await vfs.close();
  });
});

describe("creating pages", () => {
  it("creates a page from a write to a name that does not exist", async () => {
    const client = seeded();
    const vfs = await openVfs(client);
    await vfs.readdir("/DOCSY");

    const result = await vfs.writeFile("/DOCSY/release-notes.md", "# Release notes\n\nHello.\n");

    expect(result.created).toBe(true);
    // The canonical name carries the new id.
    expect(result.path).toMatch(/\/DOCSY\/release-notes-\d+\.md$/);
    expect(client.peekPage(result.pageId)?.title).toBe("Release Notes");
    await vfs.close();
  });

  it("prefers a title from the frontmatter over the file name", async () => {
    const client = seeded();
    const vfs = await openVfs(client);
    await vfs.readdir("/DOCSY");
    const result = await vfs.writeFile(
      "/DOCSY/whatever.md",
      '---\natlcli:\n  id: ""\n  title: "Proper Title"\n---\n\nBody.\n',
    );
    expect(client.peekPage(result.pageId)?.title).toBe("Proper Title");
    await vfs.close();
  });

  it("creates under the directory it was written into", async () => {
    const client = seeded();
    const vfs = await openVfs(client);
    await vfs.readdir("/DOCSY/architecture-102");
    const result = await vfs.writeFile("/DOCSY/architecture-102/scaling.md", "# Scaling\n");
    expect(client.peekPage(result.pageId)?.parentId).toBe("102");
    await vfs.close();
  });

  it("moves a page created under a folder into that folder", async () => {
    const client = seeded();
    const vfs = await openVfs(client);
    await vfs.readdir("/DOCSY/runbooks-104");
    const result = await vfs.writeFile("/DOCSY/runbooks-104/restart.md", "# Restart\n");
    expect(client.callsTo("movePageToFolder")).toBe(1);
    expect(client.peekPage(result.pageId)?.parentId).toBe("104");
    await vfs.close();
  });

  it("answers EEXIST when the space already has that title", async () => {
    const client = seeded();
    const vfs = await openVfs(client);
    await vfs.readdir("/DOCSY");
    await expect(vfs.writeFile("/DOCSY/architecture.md", "# dup\n")).rejects.toMatchObject({
      code: "EEXIST",
    });
    await vfs.close();
  });

  it("refuses to create a file whose name the filesystem owns", async () => {
    const client = seeded();
    const vfs = await openVfs(client);
    await vfs.readdir("/DOCSY/architecture-102");
    await expect(
      vfs.writeFile("/DOCSY/architecture-102/.comments.md", "# nope\n"),
    ).rejects.toMatchObject({ code: "EROFS" });
    await vfs.close();
  });
});

describe("mkdir", () => {
  it("creates a page with an empty body, never a folder", async () => {
    const client = seeded();
    const vfs = await openVfs(client);
    await vfs.readdir("/DOCSY");

    const result = await vfs.mkdir("/DOCSY/new-section");

    expect(client.peekPage(result.pageId)?.type).toBe("page");
    expect(client.peekPage(result.pageId)?.storage).toBe("");
    await vfs.close();
  });

  it("makes the new directory's _index.md writable", async () => {
    const client = seeded();
    const vfs = await openVfs(client);
    await vfs.readdir("/DOCSY");
    const result = await vfs.mkdir("/DOCSY/new-section");
    const node = vfs.index.node(result.pageId)!;
    await vfs.writeFile(`/DOCSY/new-section-${node.id}/_index.md`, "# Filled in\n");
    expect(client.peekPage(result.pageId)?.storage).toContain("Filled in");
    await vfs.close();
  });

  it("answers EEXIST for a directory that is already there", async () => {
    const vfs = await openVfs(seeded());
    await vfs.readdir("/DOCSY");
    await expect(vfs.mkdir("/DOCSY/architecture-102")).rejects.toMatchObject({ code: "EEXIST" });
    await vfs.close();
  });
});

describe("rename and move", () => {
  it("retitles inside the same directory", async () => {
    const client = seeded();
    const vfs = await openVfs(client);
    await vfs.readdir("/DOCSY");
    await vfs.rename("/DOCSY/getting-started-101", "/DOCSY/quick-start-101");
    expect(client.peekPage("101")?.title).toBe("Quick Start");
    await vfs.close();
  });

  it("moves into another directory of the same space", async () => {
    const client = seeded();
    const vfs = await openVfs(client);
    await vfs.readdir("/DOCSY");
    await vfs.readdir("/DOCSY/architecture-102");
    await vfs.rename("/DOCSY/getting-started-101", "/DOCSY/architecture-102/getting-started-101");
    expect(client.peekPage("101")?.parentId).toBe("102");
    expect(client.callsTo("movePage")).toBe(1);
    await vfs.close();
  });

  it("uses the folder endpoint when the destination is a folder", async () => {
    const client = seeded();
    const vfs = await openVfs(client);
    await vfs.readdir("/DOCSY");
    await vfs.readdir("/DOCSY/runbooks-104");
    await vfs.rename("/DOCSY/getting-started-101", "/DOCSY/runbooks-104/getting-started-101");
    expect(client.callsTo("movePageToFolder")).toBe(1);
    await vfs.close();
  });

  it("uses the positional endpoint across spaces", async () => {
    const client = seeded()
      .seedSpace({ id: "sp-2", key: "OTHER", name: "Other", homepageId: "200" })
      .seedPage({ id: "200", title: "Other Home", spaceKey: "OTHER", storage: "<p>o</p>" });
    const vfs = await openVfs(client);
    await vfs.readdir("/DOCSY");
    await vfs.readdir("/OTHER");
    await vfs.rename("/DOCSY/getting-started-101", "/OTHER/getting-started-101");
    expect(client.callsTo("movePageToPosition")).toBe(1);
    await vfs.close();
  });

  it("carries the subtree along when a directory moves", async () => {
    const client = seeded();
    const vfs = await openVfs(client);
    await vfs.readdir("/DOCSY");
    await vfs.readdir("/DOCSY/architecture-102");
    await vfs.rename("/DOCSY/architecture-102", "/DOCSY/getting-started-101/architecture-102");
    // Confluence takes the children with the page; one call, not one per child.
    expect(client.callsTo("movePage")).toBe(1);
    expect(client.peekPage("103")?.parentId).toBe("102");
    await vfs.close();
  });

  it("refuses to change the id suffix", async () => {
    const vfs = await openVfs(seeded());
    await vfs.readdir("/DOCSY");
    await expect(
      vfs.rename("/DOCSY/getting-started-101", "/DOCSY/getting-started-999"),
    ).rejects.toMatchObject({ code: "EINVAL" });
    await vfs.close();
  });
});

describe("rm", () => {
  it("sends a page to the trash and never purges it", async () => {
    const client = seeded();
    const vfs = await openVfs(client);
    await vfs.readdir("/DOCSY");
    await vfs.rm("/DOCSY/getting-started-101");
    expect(client.isTrashed("101")).toBe(true);
    // Still in the store: trash, not purge.
    expect(client.peekPage("101")).toBeDefined();
    await vfs.close();
  });

  it("refuses a non-empty directory without the recursive flag", async () => {
    const vfs = await openVfs(seeded());
    await vfs.readdir("/DOCSY");
    await expect(vfs.rm("/DOCSY/architecture-102")).rejects.toMatchObject({ code: "ENOTEMPTY" });
    await vfs.close();
  });

  it("takes the subtree with it when told to", async () => {
    const client = seeded();
    const vfs = await openVfs(client);
    await vfs.readdir("/DOCSY");
    await vfs.rm("/DOCSY/architecture-102", { recursive: true });
    expect(client.isTrashed("102")).toBe(true);
    expect(client.isTrashed("103")).toBe(true);
    expect(client.calls.filter((call) => call.method === "deletePage").map((call) => call.arg)).toEqual(["103", "102"]);
    await vfs.close();
  });

  it("models the REST endpoint faithfully: deleting a parent alone leaves its children current", async () => {
    const client = seeded();
    await client.deletePage("102");
    expect(client.isTrashed("102")).toBe(true);
    expect(client.isTrashed("103")).toBe(false);
  });

  it("refreshes cached descendants and deletes grandchildren before their parents", async () => {
    const client = seeded();
    const vfs = await openVfs(client);
    await vfs.readdir("/DOCSY/architecture-102");
    await vfs.readFile("/DOCSY/architecture-102/deployment-103.md");
    client.seedPage({ id: "105", title: "New Grandchild", spaceKey: "DOCSY", parentId: "103" });
    client.seedPage({ id: "106", title: "New Child", spaceKey: "DOCSY", parentId: "102" });
    await vfs.rm("/DOCSY/architecture-102", { recursive: true });
    const deleted = client.calls.filter((call) => call.method === "deletePage").map((call) => call.arg);
    expect([...deleted].sort()).toEqual(["102", "103", "105", "106"]);
    expect(deleted.indexOf("105")).toBeLessThan(deleted.indexOf("103"));
    expect(deleted.at(-1)).toBe("102");
    for (const id of deleted) {
      expect(client.isTrashed(id)).toBe(true);
      expect(vfs.index.knowsId(id)).toBe(false);
    }
    expect(vfs.cache!.getBody("103", 1)).toBeUndefined();
    await vfs.close();
  });

  it("rejects unsupported descendants and folders before any deletion", async () => {
    const client = seeded().seedPage({ id: "105", title: "Child Folder", spaceKey: "DOCSY", parentId: "102", type: "folder" });
    const vfs = await openVfs(client);
    await expect(vfs.rm("/DOCSY/architecture-102", { recursive: true })).rejects.toMatchObject({ code: "EROFS" });
    await expect(vfs.rm("/DOCSY/runbooks-104", { recursive: true })).rejects.toMatchObject({ code: "EROFS" });
    expect(client.callsTo("deletePage")).toBe(0);
    await vfs.close();
  });

  it("completes bounded enumeration before any deletion", async () => {
    const client = seeded().seedPages(5001, (i) => ({ id: String(1000 + i), title: `Child ${i}`, spaceKey: "DOCSY", parentId: "102" }));
    const vfs = await openVfs(client);
    await expect(vfs.rm("/DOCSY/architecture-102", { recursive: true })).rejects.toMatchObject({ code: "EINVAL" });
    expect(client.callsTo("deletePage")).toBe(0);
    expect(client.isTrashed("102")).toBe(false);
    await vfs.close();
  });

  it("stops on a child deletion failure without deleting its parent", async () => {
    const client = seeded();
    const vfs = await openVfs(client);
    client.failNext({ method: "deletePage", match: "103", status: 403, times: 1 });
    await expect(vfs.rm("/DOCSY/architecture-102", { recursive: true })).rejects.toMatchObject({ code: "EACCES" });
    expect(client.isTrashed("102")).toBe(false);
    expect(client.isTrashed("103")).toBe(false);
    await vfs.close();
  });

  it("drops the deleted page from the index and the cache", async () => {
    const client = seeded();
    const vfs = await openVfs(client);
    await vfs.readFile("/DOCSY/getting-started-101.md");
    await vfs.rm("/DOCSY/getting-started-101");
    expect(vfs.index.knowsId("101")).toBe(false);
    expect(vfs.cache!.getBody("101", 1)).toBeUndefined();
    await vfs.close();
  });

  it("refuses to delete a generated view", async () => {
    const vfs = await openVfs(seeded());
    await expect(vfs.rm("/DOCSY/getting-started-101/.comments.md")).rejects.toMatchObject({
      code: "EROFS",
    });
    await vfs.close();
  });
});

describe("copy", () => {
  it("copies a page into the target directory", async () => {
    const client = seeded();
    const vfs = await openVfs(client);
    await vfs.readdir("/DOCSY");
    await vfs.readdir("/DOCSY/architecture-102");
    const result = await vfs.copy("/DOCSY/getting-started-101", "/DOCSY/architecture-102/copied");
    expect(client.peekPage(result.pageId)?.parentId).toBe("102");
    expect(client.peekPage(result.pageId)?.title).toBe("Copied");
    await vfs.close();
  });
});

describe("attachments in rw mode", () => {
  it("uploads, updates and deletes", async () => {
    const client = seeded().seedAttachment({
      id: "att-1",
      pageId: "102",
      filename: "existing.bin",
      bytes: new Uint8Array([1]),
    });
    const vfs = await openVfs(client);

    await vfs.writeFile(
      "/DOCSY/architecture-102/_attachments/new.bin",
      new Uint8Array([9, 9, 9]),
    );
    expect(client.callsTo("uploadAttachment")).toBe(1);

    await vfs.writeFile(
      "/DOCSY/architecture-102/_attachments/existing.bin",
      new Uint8Array([2, 2]),
    );
    expect(client.callsTo("updateAttachment")).toBe(1);

    await vfs.rm("/DOCSY/architecture-102/_attachments/existing.bin");
    expect(client.callsTo("deleteAttachment")).toBe(1);
    await vfs.close();
  });

  it("refuses an attachment delete without --allow-delete", async () => {
    const client = seeded().seedAttachment({
      id: "att-1",
      pageId: "102",
      filename: "existing.bin",
      bytes: new Uint8Array([1]),
    });
    const vfs = await openVfs(client, { allowDelete: false });
    await expect(
      vfs.rm("/DOCSY/architecture-102/_attachments/existing.bin"),
    ).rejects.toMatchObject({ code: "EACCES" });
    await vfs.close();
  });
});

describe("write coalescing", () => {
  it("merges several writes to the same file into one update", async () => {
    const client = seeded();
    const vfs = await openVfs(client, { coalesceMs: 500 });
    const original = await vfs.readFile("/DOCSY/getting-started-101.md");

    const first = vfs.writeFile("/DOCSY/getting-started-101/_index.md", `${original}chunk one\n`);
    const second = vfs.writeFile("/DOCSY/getting-started-101/_index.md", `${original}chunk two\n`);
    await settle();
    expect(client.callsTo("updatePage")).toBe(0);

    runScheduled();
    await Promise.all([first, second]);

    // One version burned, not two, and the last write wins.
    expect(client.callsTo("updatePage")).toBe(1);
    expect(client.peekPage("101")?.version).toBe(2);
    expect(client.peekPage("101")?.storage).toContain("chunk two");
    await vfs.close();
  });

  it("flushes whatever is pending when the session ends", async () => {
    const client = seeded();
    const vfs = await openVfs(client, { coalesceMs: 500 });
    const original = await vfs.readFile("/DOCSY/getting-started-101.md");
    const pending = vfs.writeFile("/DOCSY/getting-started-101/_index.md", `${original}late\n`);
    await settle();

    await vfs.flush();
    await pending;

    expect(client.callsTo("updatePage")).toBe(1);
    await vfs.close();
  });

  it("sends immediately when coalescing is off", async () => {
    const client = seeded();
    const vfs = await openVfs(client, { coalesceMs: 0 });
    const original = await vfs.readFile("/DOCSY/getting-started-101.md");
    await vfs.writeFile("/DOCSY/getting-started-101/_index.md", `${original}now\n`);
    expect(client.callsTo("updatePage")).toBe(1);
    await vfs.close();
  });
});

describe("the audit log", () => {
  function readLog(): Record<string, unknown>[] {
    const file = join(root, "vfs-audit.jsonl");
    if (!existsSync(file)) return [];
    return readFileSync(file, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  }

  it("records every successful write with its versions", async () => {
    const client = seeded();
    const vfs = await openVfs(client);
    const original = await vfs.readFile("/DOCSY/getting-started-101.md");
    await vfs.writeFile("/DOCSY/getting-started-101/_index.md", `${original}edit\n`);
    await vfs.close();

    const entries = readLog();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      op: "update",
      pageId: "101",
      fromVersion: 1,
      toVersion: 2,
      result: "ok",
      profile: "mayflower",
      accountId: "acct-001",
    });
  });

  it("records a failed write too", async () => {
    const client = seeded();
    const vfs = await openVfs(client);
    const original = await vfs.readFile("/DOCSY/getting-started-101.md");
    client.bumpVersion("101", "<p>Install the CLI from source.</p>");
    await expect(
      vfs.writeFile(
        "/DOCSY/getting-started-101/_index.md",
        original.replace("Install the CLI.", "Install the CLI with brew."),
      ),
    ).rejects.toBeDefined();
    await vfs.close();

    const ops = readLog().map((e) => e.op);
    expect(ops).toContain("conflict");
    expect(readLog().some((e) => e.result === "error")).toBe(true);
  });

  it("records what was touched, never the content and never a token", async () => {
    const client = seeded();
    const vfs = await openVfs(client);
    const original = await vfs.readFile("/DOCSY/getting-started-101.md");
    await vfs.writeFile(
      "/DOCSY/getting-started-101/_index.md",
      `${original}SECRET-CONTENT-MARKER\n`,
    );
    await vfs.close();

    const raw = readFileSync(join(root, "vfs-audit.jsonl"), "utf8");
    expect(raw).not.toContain("SECRET-CONTENT-MARKER");
    expect(raw).not.toMatch(/token|password|authorization/i);
  });

  it("records deletes", async () => {
    const client = seeded();
    const vfs = await openVfs(client);
    await vfs.readdir("/DOCSY");
    await vfs.rm("/DOCSY/getting-started-101");
    await vfs.close();
    expect(readLog().some((e) => e.op === "delete" && e.pageId === "101")).toBe(true);
  });
});

describe("round trip through the filesystem", () => {
  it("reads, edits, writes and reads back the same Markdown", async () => {
    const client = seeded();
    const vfs = await openVfs(client);
    const before = await vfs.readFile("/DOCSY/getting-started-101.md");
    const edited = before.replace("Install the CLI.", "Install the CLI, then run it.");

    await vfs.writeFile("/DOCSY/getting-started-101/_index.md", edited);
    const after = await vfs.readFile("/DOCSY/getting-started-101.md");

    expect(normalizeMarkdown(parseVfsFrontmatter(after).body)).toBe(
      normalizeMarkdown(parseVfsFrontmatter(edited).body),
    );
    await vfs.close();
  });
});

describe("lossy conversion", () => {
  /**
   * WP5.11: a page holding something Markdown cannot express must not be
   * flattened silently. The warning is the deliverable — the write still
   * happens, because refusing it would make such pages unreachable.
   */
  it("warns when the page does not survive the Markdown round trip", async () => {
    const client = seeded().seedPage({
      id: "201",
      title: "Macro Page",
      spaceKey: "DOCSY",
      parentId: "100",
      position: 5,
      // A two-column layout: Markdown has no way to express it, so the
      // converter flattens the columns into consecutive paragraphs.
      storage:
        '<ac:layout><ac:layout-section ac:type="two_equal"><ac:layout-cell><p>Before.</p></ac:layout-cell><ac:layout-cell><p>After.</p></ac:layout-cell></ac:layout-section></ac:layout>',
    });
    const warnings: string[] = [];
    const vfs = await openVfs(client, {
      logger: {
        debug() {},
        info() {},
        warn: (message: string) => void warnings.push(message),
        error() {},
      },
    });

    const original = await vfs.readFile("/DOCSY/macro-page-201.md");
    await vfs.writeFile("/DOCSY/macro-page-201/_index.md", original.replace("After.", "Later."));

    expect(warnings.some((w) => w.includes("does not round-trip"))).toBe(true);
    // The write still went through.
    expect(client.peekPage("201")?.storage).toContain("Later.");
    await vfs.close();
  });

  it("stays quiet for a page that round-trips cleanly", async () => {
    const client = seeded();
    const warnings: string[] = [];
    const vfs = await openVfs(client, {
      logger: {
        debug() {},
        info() {},
        warn: (message: string) => void warnings.push(message),
        error() {},
      },
    });
    const original = await vfs.readFile("/DOCSY/getting-started-101.md");
    await vfs.writeFile("/DOCSY/getting-started-101/_index.md", `${original}More.\n`);
    expect(warnings.filter((w) => w.includes("round-trip"))).toHaveLength(0);
    await vfs.close();
  });

  it("warns once per page, not once per write", async () => {
    const client = seeded().seedPage({
      id: "201",
      title: "Macro Page",
      spaceKey: "DOCSY",
      parentId: "100",
      position: 5,
      storage:
        '<ac:layout><ac:layout-section ac:type="two_equal"><ac:layout-cell><p>Before.</p></ac:layout-cell><ac:layout-cell><p>After.</p></ac:layout-cell></ac:layout-section></ac:layout>',
    });
    const warnings: string[] = [];
    const vfs = await openVfs(client, {
      logger: {
        debug() {},
        info() {},
        warn: (message: string) => void warnings.push(message),
        error() {},
      },
    });
    const original = await vfs.readFile("/DOCSY/macro-page-201.md");
    await vfs.writeFile("/DOCSY/macro-page-201/_index.md", `${original}one\n`);
    const again = await vfs.readFile("/DOCSY/macro-page-201.md");
    await vfs.writeFile("/DOCSY/macro-page-201/_index.md", `${again}two\n`);
    expect(warnings.filter((w) => w.includes("round-trip"))).toHaveLength(1);
    await vfs.close();
  });
});
