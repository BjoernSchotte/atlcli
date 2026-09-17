/**
 * The WebDAV frontend, driven over real HTTP (WP7.1–7.3b, WP7.8).
 *
 * The server runs in-process on loopback and every assertion goes through an
 * actual request, because the things worth testing here are protocol-level:
 * does `PROPFIND` fetch bodies, does `LOCK` return a token, does an
 * AppleDouble probe reach the backend. A unit test of the adapter class would
 * answer none of those.
 *
 * This is also the Linux CI story for WP7.8: a kernel mount is impossible in a
 * container, so the server is exercised through HTTP exactly as a mounted
 * client would.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfluenceVfsImpl } from "@atlcli/confluence-vfs";
import { FakeConfluenceClient } from "@atlcli/confluence-vfs/testing";
import {
  isClientDropping,
  isIndexerShield,
  SweepDetector,
} from "./webdav-fs.js";
import {
  generateBearerToken,
  isLoopback,
  startWebdavServer,
  type RunningWebdavServer,
} from "./webdav-server.js";

let root: string;
let client: FakeConfluenceClient;
let vfs: ConfluenceVfsImpl;
let server: RunningWebdavServer;

function seeded(children = 3): FakeConfluenceClient {
  const fake = new FakeConfluenceClient()
    .seedSpace({ id: "sp-1", key: "DOCSY", name: "Docs", homepageId: "100" })
    .seedPage({ id: "100", title: "Docs Home", spaceKey: "DOCSY", storage: "<p>Home.</p>" });
  for (let i = 0; i < children; i++) {
    fake.seedPage({
      id: String(200 + i),
      title: `Page ${i}`,
      spaceKey: "DOCSY",
      parentId: "100",
      position: i,
      storage: `<h1>Page ${i}</h1><p>Body ${i}.</p>`,
    });
  }
  return fake;
}

async function start(
  fake: FakeConfluenceClient,
  overrides: Record<string, unknown> = {},
): Promise<void> {
  client = fake;
  vfs = await ConfluenceVfsImpl.open({
    profile: "mayflower",
    client: fake,
    spaces: ["DOCSY"],
    mode: "rw",
    allowDelete: true,
    cacheDir: root,
    offline: false,
    coalesceMs: 0,
    ...overrides,
  });
  server = await startWebdavServer({ vfs, spaces: ["DOCSY"] });
}

async function dav(
  path: string,
  init: RequestInit & { depth?: string } = {},
): Promise<{ status: number; body: string }> {
  const headers = new Headers(init.headers);
  if (init.depth !== undefined) headers.set("Depth", init.depth);
  const response = await fetch(new URL(path, server.url), { ...init, headers });
  return { status: response.status, body: await response.text() };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "vfs-dav-"));
});

it("counts HTTP protocol requests independently of backend calls", async () => {
  await start(seeded());
  expect(await server.requestCount()).toBe(0);
  expect((await dav("/DOCSY/", { method: "OPTIONS" })).status).toBe(200);
  expect((await dav("/DOCSY/.metadata_never_index")).status).toBe(200);
  expect(await server.requestCount()).toBe(2);
  expect(await server.requestCount()).toBe(2);
  client.resetCalls();
  await dav("/DOCSY/", { method: "OPTIONS" });
  await dav("/DOCSY/.metadata_never_index");
  expect(await server.requestCount()).toBe(4);
  expect(client.requestCount).toBe(0);
});

afterEach(async () => {
  await server?.stop();
  await vfs?.close();
  rmSync(root, { recursive: true, force: true });
});

describe("listing", () => {
  it("serves PROPFIND at depth 1", async () => {
    await start(seeded());
    const result = await dav("/DOCSY", { method: "PROPFIND", depth: "1" });
    expect(result.status).toBe(207);
    expect(result.body).toContain("page-0-200");
    expect(result.body).toContain("_index.md");
  });

  /**
   * Rule 2, at the protocol level. A Finder window over a large directory must
   * cost one listing, not one body fetch per row.
   */
  it("hydrates only the listed homepage body, not 250 child directories", async () => {
    await start(seeded(250));
    client.resetCalls();
    const result = await dav("/DOCSY", { method: "PROPFIND", depth: "1" });
    expect(result.status).toBe(207);
    expect(client.callsTo("getPage")).toBe(1);
    expect(client.callsTo("getPagesBulk")).toBe(0);
  });

  it("reports a size for an unread page rather than zero", async () => {
    await start(seeded());
    const result = await dav("/DOCSY/page-0-200.md", { method: "PROPFIND", depth: "0" });
    expect(result.body).toMatch(/<D:getcontentlength>[1-9]\d*<\/D:getcontentlength>/);
  });
});

describe("reading", () => {
  it("keeps homepage attachments discoverable after repeated root listings", async () => {
    await start(seeded().seedAttachment({ id: "900", pageId: "100", filename: "proof.txt", bytes: Buffer.from("Grüße 🐴") }));
    for (let pass = 0; pass < 2; pass++) {
      const root = await dav("/DOCSY/", { method: "PROPFIND", depth: "1" });
      expect(root.body).toContain("/DOCSY/_attachments");
      expect(root.body).toContain("/DOCSY/.versions");
      expect(root.body).toContain("/DOCSY/.comments.md");
      const directory = await dav("/DOCSY/_attachments/", { method: "PROPFIND", depth: "1" });
      expect(directory.body).toContain("proof.txt");
      const file = await dav("/DOCSY/_attachments/proof.txt", { method: "GET" });
      expect(file.status).toBe(200);
      expect(file.body).toBe("Grüße 🐴");
    }
  });

  it("GETs a page as Markdown", async () => {
    await start(seeded());
    const result = await dav("/DOCSY/page-0-200.md", { method: "GET" });
    expect(result.status).toBe(200);
    expect(result.body).toContain("# Page 0");
    expect(result.body).toContain("atlcli:");
  });

  it("answers 404 for a page that is not there", async () => {
    await start(seeded());
    expect((await dav("/DOCSY/ghost-999999.md", { method: "GET" })).status).toBe(404);
  });

  it("gives an ETag built from the page id and version", async () => {
    await start(seeded());
    // webdav-server exposes the ETag through PROPFIND rather than as a GET
    // header, which is where an If-Match client reads it anyway.
    const result = await dav("/DOCSY/page-0-200.md", { method: "PROPFIND", depth: "0" });
    expect(result.body).toContain('<D:getetag>"200-1"</D:getetag>');
  });

  /**
   * A stable validator matters more than it looks: the version comes from a
   * body-free probe on the listing, so the ETag a client caches before reading
   * is the same one it sees afterwards. Without that it would be `"200-0"`
   * until the first read and every conditional request would miss.
   */
  it("gives the same ETag before and after the body is read", async () => {
    await start(seeded());
    const before = await dav("/DOCSY/page-0-200.md", { method: "PROPFIND", depth: "0" });
    await dav("/DOCSY/page-0-200.md", { method: "GET" });
    const after = await dav("/DOCSY/page-0-200.md", { method: "PROPFIND", depth: "0" });
    const etag = (body: string): string => /<D:getetag>([^<]*)<\/D:getetag>/.exec(body)?.[1] ?? "";
    expect(etag(before.body)).toBe('"200-1"');
    expect(etag(after.body)).toBe(etag(before.body));
  });

  it("advertises the complete cold file length before GET, including bodies over 4 KiB", async () => {
    const fake = seeded().seedPage({ id: "200", title: "Page 0", spaceKey: "DOCSY", parentId: "100", storage: `<p>${"long body ü ".repeat(1000)}END-MARKER</p>` });
    await start(fake);
    const propfind = await dav("/DOCSY/page-0-200.md", { method: "PROPFIND", depth: "0" });

    const response = await fetch(new URL("/DOCSY/page-0-200.md", server.url));
    const body = await response.text();
    // The read must be exact, or the client waits for bytes that never come.
    expect(response.headers.get("content-length")).toBe(String(Buffer.byteLength(body, "utf8")));
    expect(Buffer.byteLength(body)).toBeGreaterThan(4096);
    expect(body).toContain("END-MARKER");
    expect(propfind.body).toContain(`<D:getcontentlength>${Buffer.byteLength(body)}</D:getcontentlength>`);
  });
});

describe("locking", () => {
  /**
   * Without a working LOCK the macOS Finder mounts the volume read-only, so
   * this is the single protocol feature the mount depends on most.
   */
  it("returns a lock token, which is what makes the Finder mount read-write", async () => {
    await start(seeded());
    const result = await dav("/DOCSY/page-0-200.md", {
      method: "LOCK",
      headers: { "Content-Type": "application/xml", Timeout: "Second-600" },
      body: `<?xml version="1.0" encoding="utf-8"?><D:lockinfo xmlns:D="DAV:"><D:lockscope><D:exclusive/></D:lockscope><D:locktype><D:write/></D:locktype><D:owner><D:href>atlcli</D:href></D:owner></D:lockinfo>`,
    });
    expect(result.status).toBe(200);
    expect(result.body).toContain("locktoken");
  });

  it("advertises the DAV capabilities on OPTIONS", async () => {
    await start(seeded());
    const response = await fetch(new URL("/", server.url), { method: "OPTIONS" });
    expect(response.status).toBe(200);
    expect(response.headers.get("allow") ?? "").toContain("LOCK");
  });
});

describe("writing", () => {
  it("enforces tagged and untagged If conditions without crashing macOS writes", async () => {
    await start(seeded());
    const path = "/DOCSY/page-0-200.md";
    const lock = await fetch(new URL(path, server.url), {
      method: "LOCK", headers: { "Content-Type": "application/xml" },
      body: '<D:lockinfo xmlns:D="DAV:"><D:lockscope><D:exclusive/></D:lockscope><D:locktype><D:write/></D:locktype></D:lockinfo>',
    });
    await lock.text();
    const token = lock.headers.get("lock-token")!;
    expect(token).toBeTruthy();
    for (const condition of ['(<opaquelocktoken:invalid>)', '(["200-999"])',
      `<${new URL(path, server.url)}> (["200-999"])`]) {
      expect((await dav(path, { method: "PUT", headers: { If: condition }, body: "rejected" })).status).toBe(412);
    }
    expect(client.callsTo("updatePage")).toBe(0);
    expect((await dav(path, { method: "PUT", headers: { If: `(${token})` }, body: "accepted" })).status).toBe(200);
    expect(client.peekPage("200")?.storage).toContain("accepted");
    // Tagged resource paths must be relative to the mounted filesystem.
    expect((await dav(path, { method: "PUT", headers: { If: `<${new URL(path, server.url)}> (${token})` }, body: "tagged" })).status).toBe(200);
    expect(client.peekPage("200")?.storage).toContain("tagged");
  });

  it("PUTs a changed body back as a page update", async () => {
    await start(seeded());
    const original = (await dav("/DOCSY/page-0-200.md", { method: "GET" })).body;
    const result = await dav("/DOCSY/page-0-200.md", {
      method: "PUT",
      body: original.replace("Body 0.", "Body zero, edited."),
    });
    expect([200, 201, 204]).toContain(result.status);
    expect(client.peekPage("200")?.storage).toContain("edited");
  });

  it("refuses a PUT with 403 in ro mode", async () => {
    await start(seeded(), { mode: "ro", allowDelete: false });
    const result = await dav("/DOCSY/page-0-200.md", { method: "PUT", body: "nope" });
    expect(result.status).toBe(403);
    expect(client.callsTo("updatePage")).toBe(0);
  });

  it("DELETEs into the trash", async () => {
    await start(seeded());
    await dav("/DOCSY", { method: "PROPFIND", depth: "1" });
    const result = await dav("/DOCSY/page-0-200", { method: "DELETE" });
    expect([200, 204]).toContain(result.status);
    expect(client.isTrashed("200")).toBe(true);
  });

  it("MOVEs a page to another parent", async () => {
    await start(seeded());
    await dav("/DOCSY", { method: "PROPFIND", depth: "1" });
    await dav("/DOCSY/page-1-201", { method: "PROPFIND", depth: "1" });
    const result = await dav("/DOCSY/page-0-200", {
      method: "MOVE",
      headers: { Destination: new URL("/DOCSY/page-1-201/page-0-200", server.url).toString() },
    });
    expect([201, 204]).toContain(result.status);
    expect(client.peekPage("200")?.parentId).toBe("201");
  });
});

describe("client quirks", () => {
  it("answers AppleDouble and desktop droppings without touching the backend", async () => {
    await start(seeded());
    await dav("/DOCSY", { method: "PROPFIND", depth: "1" });
    client.resetCalls();
    for (const name of ["._page-0-200.md", ".DS_Store", "desktop.ini", "Thumbs.db"]) {
      expect((await dav(`/DOCSY/${name}`, { method: "GET" })).status).toBe(404);
    }
    expect(client.requestCount).toBe(0);
  });

  /**
   * WP7.3b. These files must *exist* for Spotlight to skip the volume; a 404
   * is an invitation to index, and indexing a demand-driven filesystem means
   * downloading every page of every space.
   */
  it("serves the Spotlight exclusions as empty files rather than refusing them", async () => {
    await start(seeded());
    for (const name of [".metadata_never_index", ".metadata_never_index_unless_rootfs"]) {
      const result = await dav(`/${name}`, { method: "GET" });
      expect(result.status).toBe(200);
      expect(result.body).toBe("");
    }
  });

  it("lists the exclusions at the volume root, so a client can find them", async () => {
    await start(seeded());
    for (const path of ["/", "/DOCSY/"]) {
      const result = await dav(path, { method: "PROPFIND", depth: "1" });
      expect(result.body).toContain(".metadata_never_index");
    }
  });

  it("accepts and discards a client writing its own droppings", async () => {
    await start(seeded());
    const result = await dav("/DOCSY/.DS_Store", { method: "PUT", body: "junk" });
    expect([200, 201, 204]).toContain(result.status);
    expect(client.callsTo("createPage")).toBe(0);
  });
});

describe("the sweep detector", () => {
  it("reports many unlisted reads in a short window", () => {
    const seen: unknown[] = [];
    let now = 0;
    const detector = new SweepDetector(5, 1000, (report) => seen.push(report), () => now);
    for (let i = 0; i < 5; i++) {
      now += 10;
      detector.noteRead("/DOCSY", i);
    }
    expect(seen).toHaveLength(1);
    expect(detector.suspected).toBe(true);
  });

  it("stays quiet for reads that follow a listing, which is ordinary browsing", () => {
    const seen: unknown[] = [];
    let now = 0;
    const detector = new SweepDetector(3, 1000, (report) => seen.push(report), () => now);
    detector.noteListing("/DOCSY");
    for (let i = 0; i < 10; i++) {
      now += 10;
      detector.noteRead("/DOCSY", i);
    }
    expect(seen).toHaveLength(0);
  });

  it("stays quiet when the reads are spread out", () => {
    const seen: unknown[] = [];
    let now = 0;
    const detector = new SweepDetector(3, 1000, (report) => seen.push(report), () => now);
    for (let i = 0; i < 10; i++) {
      now += 5000;
      detector.noteRead("/DOCSY", i);
    }
    expect(seen).toHaveLength(0);
  });

  it("reports once, not once per read after the threshold", () => {
    const seen: unknown[] = [];
    let now = 0;
    const detector = new SweepDetector(3, 10_000, (report) => seen.push(report), () => now);
    for (let i = 0; i < 50; i++) {
      now += 10;
      detector.noteRead("/DOCSY", i);
    }
    expect(seen).toHaveLength(1);
  });
});

it("expires old listings and deduplicates repeated reads within the sweep window", () => {
  let now = 0;
  const reports: unknown[] = [];
  const detector = new SweepDetector(2, 1000, report => reports.push(report), () => now);
  detector.noteListing("/DOCSY");
  detector.noteRead("/DOCSY", "a");
  detector.noteRead("/DOCSY", "b");
  expect(reports).toHaveLength(0);
  now = 1001;
  for (let i = 0; i < 60; i++) detector.noteRead("/DOCSY", "a");
  expect(reports).toHaveLength(0);
  detector.noteRead("/DOCSY", "b");
  expect(reports).toEqual([{ reads: 2, windowMs: 1000 }]);
});

describe("the name guards", () => {
  it("recognises the droppings and the shields", () => {
    for (const name of ["._x", ".DS_Store", "desktop.ini", "Thumbs.db", ".hidden"]) {
      expect(isClientDropping(name)).toBe(true);
    }
    expect(isClientDropping("page-0-200.md")).toBe(false);
    expect(isIndexerShield(".metadata_never_index")).toBe(true);
    expect(isIndexerShield("page-0-200.md")).toBe(false);
  });
});

describe("the binding rule", () => {
  it("knows which hostnames are loopback", () => {
    expect(isLoopback("127.0.0.1")).toBe(true);
    expect(isLoopback("::1")).toBe(true);
    expect(isLoopback("localhost")).toBe(true);
    expect(isLoopback("0.0.0.0")).toBe(false);
    expect(isLoopback("192.168.1.10")).toBe(false);
  });

  it("refuses a non-loopback binding without a token", async () => {
    const fake = seeded();
    const unbound = await ConfluenceVfsImpl.open({
      profile: "mayflower",
      client: fake,
      spaces: ["DOCSY"],
      mode: "ro",
      allowDelete: false,
      cacheDir: root,
      offline: false,
    });
    try {
      await expect(
        startWebdavServer({ vfs: unbound, spaces: ["DOCSY"], hostname: "0.0.0.0" }),
      ).rejects.toThrow(/without authentication/);
    } finally {
      await unbound.close();
    }
    // Keep afterEach happy.
    await start(seeded());
  });

  it("generates a token with enough entropy to be worth having", () => {
    const token = generateBearerToken();
    expect(token.length).toBeGreaterThanOrEqual(32);
    expect(generateBearerToken()).not.toBe(token);
  });
});


describe("macOS editor atomic saves", () => {
  for (const overwrite of [undefined, "T", "F"]) {
    it(`honors MOVE overwrite semantics for an editor replacement (${overwrite ?? "omitted"})`, async () => {
      await start(seeded(), { allowDelete: false });
      const target = "/DOCSY/page-0-200/_index.md", draft = `${target}.sb-repeat`;
      await dav(draft, { method: "PUT", body: "Repeated TextEdit save" });
      const headers: Record<string, string> = { Destination: new URL(target, server.url).href };
      if (overwrite !== undefined) headers.Overwrite = overwrite;
      const moved = await dav(draft, { method: "MOVE", headers });
      expect(moved.status).toBe(overwrite === "F" ? 412 : 204);
      expect(client.callsTo("updatePage")).toBe(overwrite === "F" ? 0 : 1);
      expect(client.callsTo("createPage")).toBe(0);
      expect(client.callsTo("deletePage")).toBe(0);
      expect((await dav(draft)).status).toBe(overwrite === "F" ? 200 : 404);
    });
  }

  it("makes a PUT replacement visible after moving the original to a Vim backup", async () => {
    await start(seeded(), { allowDelete: false });
    const target = "/DOCSY/newpage.md";
    expect((await dav(target, { method: "PUT", body: "First plain page" })).status).toBe(201);
    const id = (await vfs.resolve(target)).id;
    expect((await dav(target, { method: "MOVE", headers: {
      Destination: new URL(`${target}~`, server.url).href, Overwrite: "T",
    } })).status).toBe(204);
    expect(client.peekPage(id)?.title).toBe("Newpage");
    expect((await dav(`${target}~`)).body).toContain("First plain page");
    expect((await dav(target, { method: "PUT", body: "Second plain page" })).status).toBe(201);
    const read = await dav(target);
    expect(read.status).toBe(200);
    expect(read.body).toContain("Second plain page");
    expect((await vfs.resolve(target)).id).toBe(id);
    expect(client.callsTo("createPage")).toBe(1);
    expect(client.callsTo("deletePage")).toBe(0);
  });

  it("allows davfs to LOCK a replacement after moving its original to a backup", async () => {
    await start(seeded(), { allowDelete: false });
    const target = "/DOCSY/newpage.md";
    await dav(target, { method: "PUT", body: "Original" });
    const id = (await vfs.resolve(target)).id;
    await dav(target, { method: "MOVE", headers: { Destination: new URL(`${target}~`, server.url).href } });
    const locked = await fetch(new URL(target, server.url), { method: "LOCK", headers: { "Content-Type": "application/xml" },
      body: '<D:lockinfo xmlns:D="DAV:"><D:lockscope><D:exclusive/></D:lockscope><D:locktype><D:write/></D:locktype></D:lockinfo>' });
    expect(locked.status).toBe(201);
    await locked.text();
    const token = locked.headers.get("lock-token");
    expect(token).not.toBeNull();
    const written = await dav(target, { method: "PUT", headers: { If: `(<${token}>)` }, body: "Replacement" });
    expect(written.status).toBe(200);
    expect((await dav(target)).body).toContain("Replacement");
    expect((await vfs.resolve(target)).id).toBe(id);
    expect(client.callsTo("createPage")).toBe(1);
  });

  it("stages sibling drafts locally and replaces the body without creating or deleting pages", async () => {
    await start(seeded(), { allowDelete: false });
    const target = "/DOCSY/page-0-200/_index.md";
    const draft = `${target}.sb-b07a6f65-F1i1ro`;
    const original = await dav(target);
    client.resetCalls();
    expect((await dav(draft, { method: "PUT", body: "Edited by TextEdit.\n" })).status).toBe(201);
    expect((await dav(draft)).body).toBe("Edited by TextEdit.\n");
    expect((await dav(target)).body).toBe(original.body);
    expect(client.callsTo("createPage")).toBe(0);
    expect(client.callsTo("updatePage")).toBe(0);
    const moved = await dav(draft, { method: "MOVE", headers: {
      Destination: new URL(target, server.url).href, Overwrite: "T",
    } });
    expect(moved.status).toBe(204);
    expect((await dav(target)).body).toContain("Edited by TextEdit.");
    expect((await dav(draft)).status).toBe(404);
    expect(client.callsTo("createPage")).toBe(0);
    expect(client.callsTo("deletePage")).toBe(0);
    expect(client.callsTo("updatePage")).toBe(1);
  });

  it("handles TextEdit staging directory, PUT child, MOVE child and DELETE directory", async () => {
    await start(seeded(), { allowDelete: false });
    const target = "/DOCSY/page-0-200/_index.md";
    const directory = `${target}.sb-b07a6f65-vD5adZ`;
    const draft = `${directory}/_index.md`;
    await dav(target);
    client.resetCalls();
    expect((await dav(directory, { method: "MKCOL" })).status).toBe(201);
    expect((await dav(draft, { method: "PUT", body: "Actual TextEdit sequence" })).status).toBe(201);
    expect((await dav(`${directory}/`, { method: "PROPFIND", depth: "1" })).body).toContain("_index.md");
    const backup = `${target}.sb-b07a6f65-5pI2JE`;
    expect((await dav(target, { method: "MOVE", headers: {
      Destination: new URL(backup, server.url).href, Overwrite: "T",
    } })).status).toBe(204);
    expect((await dav(backup)).body).toContain("Body 0.");
    expect((await dav(target, { method: "PROPFIND", depth: "0" })).status).toBe(404);
    expect(client.callsTo("updatePage")).toBe(0);
    expect(client.callsTo("deletePage")).toBe(0);
    expect((await dav(draft, { method: "MOVE", headers: {
      Destination: new URL(target, server.url).href, Overwrite: "F",
    } })).status).toBe(204);
    expect((await dav(directory, { method: "DELETE" })).status).toBe(200);
    expect((await dav(backup, { method: "DELETE" })).status).toBe(200);
    expect((await dav(target)).body).toContain("Actual TextEdit sequence");
    expect(client.callsTo("createPage")).toBe(0);
    expect(client.callsTo("deletePage")).toBe(0);
    expect(client.callsTo("updatePage")).toBe(1);
  });

  it("keeps a staged draft when its commit fails", async () => {
    await start(seeded());
    const target = "/DOCSY/page-0-200/_index.md";
    const draft = `${target}.sb-test`;
    await dav(target);
    expect((await dav(draft, { method: "PUT", body: "Keep my edit" })).status).toBe(201);
    expect((await dav(target, { method: "MOVE", headers: {
      Destination: new URL(`${target}.sb-backup`, server.url).href, Overwrite: "F",
    } })).status).toBe(204);
    const write = vfs.writeFile.bind(vfs);
    vfs.writeFile = async () => { throw new Error("commit failed"); };
    try {
      expect((await dav(draft, { method: "MOVE", headers: {
        Destination: new URL(target, server.url).href, Overwrite: "T",
      } })).status).toBe(500);
      expect((await dav(draft)).body).toBe("Keep my edit");
      expect((await dav(target)).body).toContain("Body 0.");
    } finally { vfs.writeFile = write; }
    expect(client.callsTo("deletePage")).toBe(0);
  });

  it("restores the original view when a safe-save backup is discarded", async () => {
    await start(seeded(), { allowDelete: false });
    const target = "/DOCSY/page-0-200/_index.md";
    const backup = `${target}.sb-aborted`;
    expect((await dav(target, { method: "MOVE", headers: {
      Destination: new URL(backup, server.url).href, Overwrite: "F",
    } })).status).toBe(204);
    expect((await dav(target)).status).toBe(404);
    expect((await dav(backup, { method: "DELETE" })).status).toBe(200);
    expect((await dav(target)).body).toContain("Body 0.");
    expect(client.callsTo("deletePage")).toBe(0);
    expect(client.callsTo("updatePage")).toBe(0);
  });

  it("refuses editor drafts on readonly mounts", async () => {
    await start(seeded(), { mode: "ro" });
    expect((await dav("/DOCSY/page-0-200/_index.md.sb-test", { method: "PUT", body: "no" })).status).toBe(403);
    expect(client.callsTo("createPage")).toBe(0);
  });
});
