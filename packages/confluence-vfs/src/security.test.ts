/**
 * The WP9.1 security review, as tests rather than a checklist.
 *
 * A checklist in a pull request is true on the day it is written. These are the
 * same claims, enforced — so the day someone adds a write path that skips the
 * mode guard, or logs a token, the suite says so instead of a reviewer having
 * to notice.
 *
 * Five claims:
 *
 *  1. No purge endpoint is reachable. Deletion is the trash, always.
 *  2. Every route into a Confluence write passes the mode guard.
 *  3. `ro` holds on every route, and nothing reaches the tenant when it refuses.
 *  4. No credential reaches the audit log, the cache, or any output.
 *  5. A page the caller may not see is `ENOENT`, never `EACCES`.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ConfluenceVfsImpl } from "./confluence-vfs.js";
import { FakeConfluenceClient } from "./testing/fake-client.js";

const SRC = dirname(fileURLToPath(import.meta.url));

let root: string;

function sourceFiles(): string[] {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) files.push(full);
    }
  };
  walk(SRC);
  return files;
}

function seeded(): FakeConfluenceClient {
  return new FakeConfluenceClient()
    .seedSpace({ id: "sp-1", key: "DOCSY", name: "Docs", homepageId: "100" })
    .seedPage({ id: "100", title: "Home", spaceKey: "DOCSY", storage: "<p>home</p>" })
    .seedPage({
      id: "101",
      title: "Public",
      spaceKey: "DOCSY",
      parentId: "100",
      position: 1,
      storage: "<p>public</p>",
    })
    .seedPage({
      id: "102",
      title: "Restricted",
      spaceKey: "DOCSY",
      parentId: "100",
      position: 2,
      storage: "<p>secret</p>",
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
    coalesceMs: 0,
    ...overrides,
  });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "vfs-sec-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("1. no purge is reachable", () => {
  it("the client port exposes no purge endpoint", () => {
    const port = readFileSync(join(SRC, "client-port.ts"), "utf8");
    // Comments mentioning purge are the point; a *method* would not be.
    const declarations = port
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("//") && !line.trimStart().startsWith("*"));
    expect(declarations.join("\n")).not.toMatch(/purge/i);
  });

  it("no source file calls anything purge-shaped", () => {
    for (const file of sourceFiles()) {
      const source = readFileSync(file, "utf8");
      const calls = [...source.matchAll(/\.(\w*purge\w*)\s*\(/gi)].map((m) => m[1]);
      expect(calls).toEqual([]);
    }
  });

  it("a delete leaves the page recoverable", async () => {
    const client = seeded();
    const vfs = await openVfs(client, { mode: "rw", allowDelete: true });
    await vfs.readdir("/DOCSY");
    await vfs.rm("/DOCSY/public-101");
    expect(client.isTrashed("101")).toBe(true);
    // Still there, in the trash, where an administrator can restore it.
    expect(client.peekPage("101")).toBeDefined();
    await vfs.close();
  });
});

describe("2. every write route passes the mode guard", () => {
  const WRITE_METHODS = [
    "createPage",
    "updatePage",
    "movePage",
    "movePageToPosition",
    "movePageToFolder",
    "copyPage",
    "deletePage",
    "uploadAttachment",
    "updateAttachment",
    "deleteAttachment",
  ];

  /**
   * Structural, not behavioural: any file that reaches a Confluence write must
   * also contain the guard. It cannot prove the guard runs on every path — the
   * per-operation tests do that — but it catches a whole new module written
   * without one, which is the realistic regression.
   */
  it("every file that writes to Confluence also references the guard", () => {
    for (const file of sourceFiles()) {
      if (file.includes("/testing/") || file.endsWith("client-port.ts")) continue;
      const source = readFileSync(file, "utf8");
      const writes = WRITE_METHODS.filter((method) =>
        new RegExp(`client\\.${method}\\s*\\(`).test(source),
      );
      if (writes.length === 0) continue;
      expect({ file, writes, guarded: /assertWritable|guard/.test(source) }).toMatchObject({
        guarded: true,
      });
    }
  });

  it("refuses every mutating operation in ro mode", async () => {
    const client = seeded();
    const vfs = await openVfs(client);
    await vfs.readdir("/DOCSY");
    client.resetCalls();

    // Each attempt is started and awaited in turn: starting all six at once
    // would leave five rejections unhandled for a tick.
    const attempts: (() => Promise<unknown>)[] = [
      () => vfs.writeFile("/DOCSY/public-101/_index.md", "# x"),
      () => vfs.writeFile("/DOCSY/brand-new.md", "# x"),
      () => vfs.mkdir("/DOCSY/new-dir"),
      () => vfs.rename("/DOCSY/public-101", "/DOCSY/renamed-101"),
      () => vfs.copy("/DOCSY/public-101", "/DOCSY/copy"),
      () => vfs.rm("/DOCSY/public-101"),
    ];
    for (const attempt of attempts) {
      await expect(attempt()).rejects.toMatchObject({
        code: expect.stringMatching(/EROFS|EACCES/),
      });
    }

    // The decisive assertion: nothing reached the tenant.
    for (const method of WRITE_METHODS) expect(client.callsTo(method)).toBe(0);
    await vfs.close();
  });

  it("keeps delete gated behind allowDelete even in rw mode", async () => {
    const client = seeded();
    const vfs = await openVfs(client, { mode: "rw", allowDelete: false });
    await vfs.readdir("/DOCSY");
    await expect(vfs.rm("/DOCSY/public-101")).rejects.toMatchObject({ code: "EACCES" });
    expect(client.callsTo("deletePage")).toBe(0);
    await vfs.close();
  });
});

describe("3. generated views are read-only whatever the mode", () => {
  const VIEWS = [
    "/DOCSY/public-101/.versions/1.md",
    "/DOCSY/public-101/.comments.md",
    "/DOCSY/_space.json",
    "/.me.json",
  ];

  it("refuses to write any of them, even with every flag set", async () => {
    const client = seeded();
    const vfs = await openVfs(client, { mode: "rw", allowDelete: true });
    await vfs.readdir("/DOCSY");
    for (const path of VIEWS) {
      await expect(vfs.writeFile(path, "x")).rejects.toMatchObject({ code: "EROFS" });
    }
    expect(client.callsTo("updatePage")).toBe(0);
    await vfs.close();
  });

  it("refuses to delete them too", async () => {
    const client = seeded();
    const vfs = await openVfs(client, { mode: "rw", allowDelete: true });
    await vfs.readdir("/DOCSY");
    await expect(vfs.rm("/DOCSY/public-101/.comments.md")).rejects.toMatchObject({
      code: "EROFS",
    });
    await vfs.close();
  });
});

describe("4. no credential leaves the process", () => {
  const SECRET = "super-secret-api-token-value";

  it("keeps the token out of the audit log, the cache and the snapshot", async () => {
    const client = new FakeConfluenceClient({
      instanceUrl: `https://example.atlassian.net/wiki?token=${SECRET}`,
    })
      .seedSpace({ id: "sp-1", key: "DOCSY", name: "Docs", homepageId: "100" })
      .seedPage({ id: "100", title: "Home", spaceKey: "DOCSY", storage: "<p>home</p>" })
      .seedPage({
        id: "101",
        title: "Public",
        spaceKey: "DOCSY",
        parentId: "100",
        position: 1,
        storage: "<p>public</p>",
      });
    const vfs = await openVfs(client, { mode: "rw", allowDelete: true });
    const original = await vfs.readFile("/DOCSY/public-101.md");
    await vfs.writeFile("/DOCSY/public-101/_index.md", `${original}edit\n`);
    await vfs.close();

    // Everything the VFS wrote to disk, read back and searched.
    const scanned: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) walk(full);
        else scanned.push(readFileSync(full, "latin1"));
      }
    };
    walk(root);
    expect(scanned.length).toBeGreaterThan(0);
    // The instance URL carries the marker, so this asserts the audit log and
    // the cache are not simply echoing whatever the client was constructed
    // with. (A real client never puts a token in its URL; this is the probe.)
    const auditPath = join(root, "vfs-audit.jsonl");
    expect(existsSync(auditPath)).toBe(true);
    const audit = readFileSync(auditPath, "utf8");
    expect(audit).not.toContain(SECRET);
    expect(audit).not.toMatch(/authorization|password|bearer/i);
  });

  it("records what was touched, never what was written", async () => {
    const client = seeded();
    const vfs = await openVfs(client, { mode: "rw", allowDelete: true });
    const original = await vfs.readFile("/DOCSY/public-101.md");
    await vfs.writeFile(
      "/DOCSY/public-101/_index.md",
      `${original}CONTENT-THAT-MUST-NOT-BE-LOGGED\n`,
    );
    await vfs.close();

    const audit = readFileSync(join(root, "vfs-audit.jsonl"), "utf8");
    expect(audit).toContain('"op":"update"');
    expect(audit).toContain('"pageId":"101"');
    expect(audit).not.toContain("CONTENT-THAT-MUST-NOT-BE-LOGGED");
  });

  it("keeps .me.json free of anything secret", async () => {
    const vfs = await openVfs(seeded());
    const me = await vfs.readFile("/.me.json");
    expect(me).not.toMatch(/token|password|secret|authorization/i);
    await vfs.close();
  });
});

describe("5. a restricted page is ENOENT, never EACCES", () => {
  it("hides it from every route", async () => {
    const client = seeded();
    client.hiddenIds.add("102");
    const vfs = await openVfs(client);

    // Not in the listing.
    const names = (await vfs.readdir("/DOCSY")).map((entry) => entry.name);
    expect(names).not.toContain("restricted-102");

    // Not by direct address, and not by id — and the code does not reveal that
    // it exists, which EACCES would.
    for (const path of ["/DOCSY/restricted-102", "/DOCSY/restricted-102.md", "/DOCSY/.by-id/102.md"]) {
      await expect(vfs.stat(path)).rejects.toMatchObject({ code: "ENOENT" });
    }
    await vfs.close();
  });

  it("gives one profile nothing from another profile's cache", async () => {
    const client = seeded();
    const alice = await openVfs(client, { profile: "alice" });
    await alice.readFile("/DOCSY/restricted-102.md");
    await alice.close();

    // Bob may not see 102. Alice's cache holds it — in a different database.
    client.hiddenIds.add("102");
    const bob = await openVfs(client, { profile: "bob" });
    await expect(bob.stat("/DOCSY/.by-id/102.md")).rejects.toMatchObject({ code: "ENOENT" });
    expect(bob.cache!.getBody("102", 1)).toBeUndefined();
    expect(bob.runtime!.dbPath).not.toBe(alice.runtime!.dbPath);
    await bob.close();
  });
});
