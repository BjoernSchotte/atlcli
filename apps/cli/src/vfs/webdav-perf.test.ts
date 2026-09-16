/**
 * WebDAV performance measurement (WP7.7), as a test rather than a script.
 *
 * WP7.7 asks for `ls -R` over 500 pages, a `grep -r` over 100, and an editor
 * open-and-save, measured on macOS in both the Finder and the terminal, with a
 * threshold that listing a 100-entry directory stays under a second after
 * warmup.
 *
 * **Half of that needs a Mac.** What can be measured anywhere — and what
 * actually decides the outcome — is the *request count*, because Confluence API
 * latency dominates the protocol by an order of magnitude (plan section 6). So
 * this measures requests against a fake tenant and asserts the shape; the
 * wall-clock numbers from a real Finder go in EVIDENCE.md when someone runs
 * WP7.9 on a Mac.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfluenceVfsImpl } from "@atlcli/confluence-vfs";
import { FakeConfluenceClient } from "@atlcli/confluence-vfs/testing";
import { startWebdavServer, type RunningWebdavServer } from "./webdav-server.js";

let root: string;
let client: FakeConfluenceClient;
let vfs: ConfluenceVfsImpl;
let server: RunningWebdavServer;

/** A space of `sections` directories holding `perSection` pages each. */
function bigSpace(sections: number, perSection: number): FakeConfluenceClient {
  const fake = new FakeConfluenceClient()
    .seedSpace({ id: "sp-1", key: "BIG", name: "Big", homepageId: "1" })
    .seedPage({ id: "1", title: "Home", spaceKey: "BIG", storage: "<p>home</p>" });
  for (let s = 0; s < sections; s++) {
    const sectionId = String(10_000 + s);
    fake.seedPage({
      id: sectionId,
      title: `Section ${s}`,
      spaceKey: "BIG",
      parentId: "1",
      position: s,
      storage: "<p>section</p>",
    });
    for (let p = 0; p < perSection; p++) {
      fake.seedPage({
        id: `${sectionId}${String(p).padStart(3, "0")}`,
        title: `Page ${s}-${p}`,
        spaceKey: "BIG",
        parentId: sectionId,
        position: p,
        storage: `<h1>Page ${s}-${p}</h1><p>Body mentioning kubernetes.</p>`,
      });
    }
  }
  return fake;
}

async function start(fake: FakeConfluenceClient): Promise<void> {
  client = fake;
  vfs = await ConfluenceVfsImpl.open({
    profile: "mayflower",
    client: fake,
    spaces: ["BIG"],
    mode: "ro",
    allowDelete: false,
    cacheDir: root,
    offline: false,
  });
  server = await startWebdavServer({ vfs, spaces: ["BIG"] });
}

async function propfind(path: string, depth = "1"): Promise<number> {
  const response = await fetch(new URL(path, server.url), {
    method: "PROPFIND",
    headers: { Depth: depth },
  });
  await response.text();
  return response.status;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "vfs-perf-"));
});

afterEach(async () => {
  await server?.stop();
  await vfs?.close();
  rmSync(root, { recursive: true, force: true });
});

describe("request cost of a mounted volume", () => {
  it("costs one listing request per directory a client opens", async () => {
    await start(bigSpace(10, 50));
    client.resetCalls();

    await propfind("/BIG");
    const afterRoot = client.callsTo("getPageDirectChildren");
    await propfind("/BIG/section-0-10000");
    const afterOne = client.callsTo("getPageDirectChildren");

    expect(afterRoot).toBe(1);
    expect(afterOne).toBe(2);
  });

  it("fetches no bodies for a 500-page walk", async () => {
    await start(bigSpace(10, 50));
    client.resetCalls();

    await propfind("/BIG");
    for (let s = 0; s < 10; s++) await propfind(`/BIG/section-${s}-${10_000 + s}`);

    expect(client.callsTo("getPage")).toBe(0);
    expect(client.callsTo("getPagesBulk")).toBe(0);
    // Eleven listings plus one body-free version probe each.
    expect(client.callsTo("getPageDirectChildren")).toBe(11);
  });

  it("serves a repeat listing from the index within the TTL", async () => {
    await start(bigSpace(5, 20));
    await propfind("/BIG");
    client.resetCalls();
    await propfind("/BIG");
    expect(client.requestCount).toBe(0);
  });

  it("keeps a 100-entry directory listing to a single round trip", async () => {
    await start(bigSpace(2, 100));
    await propfind("/BIG");
    client.resetCalls();

    const started = performance.now();
    expect(await propfind("/BIG/section-0-10000")).toBe(207);
    const elapsed = performance.now() - started;

    // One listing plus one version probe. Against a real tenant those two
    // requests are the whole cost; the protocol adds milliseconds.
    expect(client.requestCount).toBeLessThanOrEqual(2);
    // The WP7.7 threshold, measured against a fake so it only catches an
    // adapter that became accidentally quadratic.
    expect(elapsed).toBeLessThan(1000);
  });

  it("reads exactly the bodies a client opens, and no more", async () => {
    await start(bigSpace(3, 20));
    await propfind("/BIG");
    // Take the names from the listing rather than constructing them, so the
    // test cannot drift from the naming scheme.
    const listing = await fetch(new URL("/BIG/section-0-10000", server.url), {
      method: "PROPFIND",
      headers: { Depth: "1" },
    });
    const body = await listing.text();
    const pages = [...body.matchAll(/<D:href>[^<]*\/BIG\/section-0-10000\/(page-[^<\/]*)\/<\/D:href>/g)]
      .map((match) => match[1]!)
      .slice(0, 3);
    expect(pages).toHaveLength(3);
    client.resetCalls();

    for (const page of pages) {
      const response = await fetch(
        new URL(`/BIG/section-0-10000/${page}/_index.md`, server.url),
      );
      await response.text();
    }
    expect(client.callsTo("getPage")).toBe(3);
  });
});
