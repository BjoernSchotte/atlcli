import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfluenceVfsImpl } from "@atlcli/confluence-vfs";
import { FakeConfluenceClient } from "@atlcli/confluence-vfs/testing";
import { createWikiShell } from "./wiki-shell.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });

function seeded(): FakeConfluenceClient {
  return new FakeConfluenceClient()
    .seedSpace({ id: "space", key: "DOCSY", name: "Docs", homepageId: "100" })
    .seedPage({ id: "100", title: "Home", spaceKey: "DOCSY", storage: "<p>Welcome.</p>" })
    .seedPage({ id: "101", title: "Alpha", spaceKey: "DOCSY", parentId: "100", position: 1,
      storage: "<p>Alpha craftsmanship.</p><p>retrospektive.foo Äpfel</p>" })
    .seedPage({ id: "102", title: "Archive", spaceKey: "DOCSY", parentId: "100", position: 2,
      storage: "<p>Beta CRAFTSMANSHIP.</p>" })
    .seedPage({ id: "103", title: "Nested", spaceKey: "DOCSY", parentId: "102", position: 1,
      storage: "<p>Needle unique.</p>" });
}

async function setup(client = seeded(), prefetchMax = 20) {
  const root = mkdtempSync(join(tmpdir(), "vfs-indexed-search-"));
  let clock = Date.parse("2026-09-16T09:00:00Z");
  const vfs = await ConfluenceVfsImpl.open({ client, profile: "mayflower", mode: "ro", cacheDir: root, allowDelete: false, offline: false,
    now: () => clock, sleep: async (ms) => { clock += ms; } });
  cleanup.push(async () => { await vfs.close(); rmSync(root, { recursive: true, force: true }); });
  const diagnostics: string[] = [];
  const shell = await createWikiShell({ vfs, spaces: ["DOCSY"], prefetchMax, onDiagnostic: (line) => diagnostics.push(line) });
  return { client, vfs, shell, diagnostics, advance: () => { clock += 24 * 60 * 60 * 1000; } };
}

function bodies(client: FakeConfluenceClient): string[] {
  return client.calls.flatMap((call) => call.method === "getPagesBulk" ? call.arg.split(",") : call.method === "getPage" ? [call.arg] : []);
}

// Keep index responses programmable: correctness concerns the index/Markdown seam,
// not whether the fake implements Atlassian's analyzer and CQL grammar perfectly.
function indexOnly(client: FakeConfluenceClient, ids: string[], totalSize = ids.length): void {
  const search = client.searchDetailed.bind(client);
  client.searchDetailed = async () => {
    const rows = [];
    for (const id of ids) rows.push(...(await search(`id = "${id}"`)).results);
    if (!ids.length) await search('id = "99999"');
    return { results: rows, totalSize };
  };
}

describe("default indexed recursive grep", () => {
  it("bounds a complete 5,000-page shell search by candidates and reuses warm bodies", async () => {
    const client = new FakeConfluenceClient()
      .seedSpace({ id: "space", key: "DOCSY", name: "Docs", homepageId: "100" })
      .seedPage({ id: "100", title: "Home", spaceKey: "DOCSY", storage: "<p>Home.</p>" })
      .seedPages(4999, (i) => ({ id: String(1000 + i), title: `Page ${i}`, spaceKey: "DOCSY", parentId: "100",
        storage: `<p>${i < 50 ? "craftsmanship" : "unrelated"} page ${i}</p>` }));
    const { shell, diagnostics, vfs } = await setup(client, 100);
    const started = performance.now();
    const cold = await shell.exec("grep -ri craftsmanship .");
    const coldMs = performance.now() - started;
    expect(cold.exitCode).toBe(0);
    expect(cold.stdout.trim().split("\n")).toHaveLength(50);
    expect(bodies(client)).toHaveLength(50);
    expect(client.callsTo("getPagesBulk")).toBe(1);
    expect(client.callsTo("getPageDirectChildren")).toBe(0);
    expect(client.callsTo("searchDetailed")).toBe(1);
    const coldRequests = client.calls.length;
    const cacheBytes = vfs.cache!.stats().bytes;
    expect(cacheBytes).toBeGreaterThan(0);
    expect(cacheBytes).toBeLessThan(100_000);
    expect(coldMs).toBeLessThan(2000); // Generous CI ceiling, catches accidental space walks.

    client.resetCalls();
    const warmStarted = performance.now();
    const warm = await shell.exec("grep -ri craftsmanship .");
    const warmMs = performance.now() - warmStarted;
    expect(warm).toEqual(cold);
    expect(vfs.cache!.stats().bytes).toBe(cacheBytes);
    expect(warmMs).toBeLessThan(2000);
    expect(bodies(client)).toHaveLength(0);
    expect(client.callsTo("getPageDirectChildren")).toBe(0);
    expect(client.callsTo("searchDetailed")).toBe(1);
    expect(diagnostics.some((line) => line.includes("50 candidate pages"))).toBe(true);
    console.info(JSON.stringify({ benchmark: "5000-page indexed shell grep", coldMs: Math.round(coldMs), warmMs: Math.round(warmMs), coldRequests, cacheBytes, warmRequests: client.calls.length, coldBodies: 50, warmBodies: 0 }));
  });

  it("searches the index and downloads matching candidates without walking the hierarchy", async () => {
    const client = seeded();
    indexOnly(client, ["101", "102"]);
    const { shell, diagnostics } = await setup(client);
    const result = await shell.exec("grep -r -i craftsmanship .");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("/DOCSY/.by-id/101.md:Alpha craftsmanship.");
    expect(result.stdout).toContain("/DOCSY/.by-id/102.md:Beta CRAFTSMANSHIP.");
    expect(bodies(client).sort()).toEqual(["101", "102"]);
    expect(client.callsTo("searchDetailed")).toBeGreaterThan(0);
    expect(client.callsTo("getPageDirectChildren")).toBe(0);
    expect(diagnostics.join("\n")).toContain("index gaps");
  });

  it("scopes indexed results to a supplied subtree without enumerating its children", async () => {
    const { shell, client } = await setup();
    const result = await shell.exec("grep -ri craftsmanship archive-102");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("/DOCSY/.by-id/102.md:");
    expect(result.stdout).not.toContain("/101.md:");
    expect(bodies(client)).toEqual(["102"]);
    expect(client.calls.some((call) => call.method === "searchDetailed" && call.arg.includes("id = 102 OR ancestor = 102"))).toBe(true);
    expect(client.calls.some((call) => call.method === "getPageDirectChildren" && call.arg === "102")).toBe(false);
  });

  it("returns no index hits without body downloads and discloses index semantics", async () => {
    const client = seeded();
    indexOnly(client, []);
    const { shell, diagnostics } = await setup(client);
    expect((await shell.exec("grep -ri craftsmanship .")).exitCode).toBe(1);
    expect(bodies(client)).toEqual([]);
    expect(client.callsTo("getPageDirectChildren")).toBe(0);
    expect(diagnostics.join("\n")).toContain("index gaps");
  });

  it("rejects index false positives using actual Markdown", async () => {
    const client = seeded();
    indexOnly(client, ["100"]);
    const { shell } = await setup(client);
    const result = await shell.exec("grep -ri craftsmanship .");
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(bodies(client)).toEqual(["100"]);
  });

  it("finds index-omitted pages when explicitly requesting exhaustive search", async () => {
    const client = seeded();
    indexOnly(client, []);
    const { shell } = await setup(client);
    const result = await shell.exec("grep --no-cql -ri craftsmanship .");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Alpha craftsmanship.");
    expect(client.callsTo("searchDetailed")).toBe(0);
    expect(bodies(client)).toHaveLength(4);
  });

  it("falls back for complex regex, inverted matches, counts, and path filters", async () => {
    for (const command of ["grep -r 'craft.*ship' .", "grep -rv craftsmanship .", "grep -rc craftsmanship .", "grep -r --include=*.md craftsmanship .", "grep -rL craftsmanship ."]) {
      const { shell, client, diagnostics } = await setup();
      expect((await shell.exec(command)).exitCode).toBe(0);
      expect(client.callsTo("searchDetailed")).toBe(0);
      expect(bodies(client)).toHaveLength(4);
      expect(diagnostics.join("\n")).toContain("fallback");
    }
  });

  it("searches explicit files directly, even with -r", async () => {
    const { shell, client } = await setup();
    const result = await shell.exec("grep -ri craftsmanship /DOCSY/.by-id/101.md");
    expect(result.exitCode).toBe(0);
    expect(client.callsTo("searchDetailed")).toBe(0);
    expect(bodies(client)).toEqual(["101"]);
  });

  it("falls back to exhaustive search on index request failure", async () => {
    const client = seeded();
    client.searchDetailed = async () => { throw new Error("search unavailable"); };
    const { shell, diagnostics } = await setup(client);
    expect((await shell.exec("grep -ri craftsmanship .")).exitCode).toBe(0);
    expect(bodies(client)).toHaveLength(4);
    expect(diagnostics.join("\n")).toContain("CQL unavailable");
  });

  it("fails before downloads on known truncated nonquiet candidate results", async () => {
    const client = seeded();
    indexOnly(client, ["101"], 1001);
    const { shell } = await setup(client);
    const result = await shell.exec("grep -ri craftsmanship .");
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("limit");
    expect(bodies(client)).toEqual([]);
  });

  it("stops quiet search after one verified match but reports inconclusive truncated negatives", async () => {
    const client = seeded();
    indexOnly(client, ["101", "102"], 1001);
    const { shell } = await setup(client);
    expect((await shell.exec("grep -rqi craftsmanship .")).exitCode).toBe(0);
    expect(bodies(client)).toEqual(["101"]);
    client.resetCalls();
    expect((await shell.exec("grep -rqi definitelyAbsent .")).exitCode).toBe(2);
    expect(bodies(client)).toEqual(["102"]);
  });

  it("routes egrep and fgrep through the same indexed optimization", async () => {
    const client = seeded();
    indexOnly(client, ["101"]);
    const { shell, diagnostics } = await setup(client);
    expect((await shell.exec("fgrep -ri retrospektive.foo .")).exitCode).toBe(0);
    expect((await shell.exec("egrep -ri 'craftsmanship|Needle' .")).exitCode).toBe(0);
    expect(diagnostics.filter((line) => line.includes("CQL-indexed")).length).toBe(2);
    expect(bodies(client)).toEqual(["101"]);
  });

  it("reuses candidate bodies and refreshes changed content versions", async () => {
    const client = seeded();
    indexOnly(client, ["101"]);
    const { shell, advance } = await setup(client);
    expect((await shell.exec("grep -ri craftsmanship .")).exitCode).toBe(0);
    expect(bodies(client)).toEqual(["101"]);
    client.resetCalls();
    expect((await shell.exec("grep -ri craftsmanship .")).exitCode).toBe(0);
    expect(bodies(client)).toEqual([]);
    client.bumpVersion("101", "<p>craftsmanship changedunique</p>");
    advance();
    client.resetCalls();
    const result = await shell.exec("grep -ri changedunique .");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("changedunique");
    expect(bodies(client)).toEqual(["101"]);
  });
});
