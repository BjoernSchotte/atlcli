import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bash } from "just-bash";
import { ConfluenceVfsImpl } from "@atlcli/confluence-vfs";
import { FakeConfluenceClient } from "@atlcli/confluence-vfs/testing";
import { createWikiShell } from "./wiki-shell.js";

const roots: string[] = [];
const open: ConfluenceVfsImpl[] = [];
afterEach(async () => {
  for (const vfs of open.splice(0)) await vfs.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function seeded(): FakeConfluenceClient {
  return new FakeConfluenceClient()
    .seedSpace({ id: "space", key: "DOCSY", name: "Docs", homepageId: "100" })
    .seedPage({ id: "100", title: "Home", spaceKey: "DOCSY", storage: "<p>Welcome.</p>" })
    .seedPage({ id: "101", title: "Alpha", spaceKey: "DOCSY", parentId: "100", position: 1,
      storage: "<p>Alpha craftsmanship.</p><p>retrospektive.foo Äpfel</p><p>--no-cql</p><p>common line</p>" })
    .seedPage({ id: "102", title: "Archive", spaceKey: "DOCSY", parentId: "100", position: 2,
      storage: "<p>Beta CRAFTSMANSHIP.</p><p>common line</p>" })
    .seedPage({ id: "103", title: "Nested", spaceKey: "DOCSY", parentId: "102", position: 1,
      storage: "<p>Needle unique.</p><p>common line</p>" });
}

async function setup(client = seeded(), prefetchMax = 20, cqlGrep = true) {
  const root = mkdtempSync(join(tmpdir(), "vfs-search-"));
  roots.push(root);
  let clock = Date.parse("2026-09-16T09:00:00Z");
  const vfs = await ConfluenceVfsImpl.open({ client, profile: "mayflower", mode: "ro", cacheDir: root, allowDelete: false, offline: false,
    now: () => clock, sleep: async (ms) => { clock += ms; } });
  open.push(vfs);
  const diagnostics: string[] = [];
  const shell = await createWikiShell({ vfs, spaces: ["DOCSY"], prefetchMax, cqlGrep, onDiagnostic: (line) => diagnostics.push(line) });
  return { client, vfs, shell, diagnostics, advance: () => { clock += 24 * 60 * 60 * 1000; } };
}

function bodies(client: FakeConfluenceClient): string[] {
  return client.calls.flatMap((call) => call.method === "getPagesBulk" ? call.arg.split(",") : call.method === "getPage" ? [call.arg] : []);
}

const files = ["/DOCSY/_index.md", "/DOCSY/alpha-101/_index.md", "/DOCSY/archive-102/_index.md", "/DOCSY/archive-102/nested-103/_index.md"];
const quote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;

describe("exact grep search planning", () => {
  it("refreshes stale explicit body operands for full and quiet searches", async () => {
    for (const flags of ["-r", "-rq"]) {
      const { shell, client, advance } = await setup();
      expect((await shell.exec(`grep ${flags} craftsmanship alpha-101.md`)).exitCode).toBe(0);
      client.bumpVersion("101", "<p>changedunique</p>");
      advance();
      client.resetCalls();
      expect((await shell.exec(`grep ${flags} changedunique alpha-101.md`)).exitCode).toBe(0);
      expect(bodies(client)).toEqual(["101"]);
      expect(client.callsTo("getPageVersions")).toBe(1);
    }
  });

  it("matches reference grep on the same generated Markdown for agent command forms", async () => {
    const { vfs, shell, client } = await setup();
    const referenceFiles: Record<string, string> = {};
    for (const file of files) referenceFiles[file] = String(await vfs.readFile(file));
    const bash = new Bash({ defenseInDepth: false, files: referenceFiles, cwd: "/DOCSY" });
    const cases = [
      ["-i", "craftsmanship"], ["-n", "common"], ["-l", "common"], ["-c", "common"],
      ["-v", "common"], ["-o", "[A-Za-z]+"], ["-E", "Alpha|Beta"], ["-F", "retrospektive.foo"],
      ["-i", "Äpfel"], ["-w", "craftsmanship"], ["-x", "common line"], ["-q", "Needle"],
      ["-q", "definitelyAbsent"], ["-A", "1", "Alpha"], ["-B", "1", "common"], ["-C", "1", "Alpha"],
      ["-m", "1", "common"], ["-e", "--no-cql"], ["--include=*.md", "common"],
      ["--exclude=_index.md", "common"], ["-h", "common"],
    ];
    for (const args of cases) {
      const actual = await shell.exec(["grep", "-r", ...args.map(quote), "."].join(" "));
      const expected = await bash.exec("grep", { args: ["-r", ...args, ...files] });
      expect({ args, stdout: actual.stdout, exitCode: actual.exitCode }).toEqual({ args, stdout: expected.stdout, exitCode: expected.exitCode });
      expect(actual.stderr).toBe("");
    }
    expect(bodies(client).length).toBe(4);
  });

  it("combines multiple expressions and handles bundled values and option-looking literals", async () => {
    const { shell } = await setup();
    const result = await shell.exec("grep -rieAlpha -e Beta .");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Alpha craftsmanship.");
    expect(result.stdout).toContain("Beta CRAFTSMANSHIP.");
    expect((await shell.exec("grep -r -e --no-cql .")).stdout).toContain("--no-cql");
  });

  it("reads pattern files as patterns, including combined explicit alternatives", async () => {
    const { vfs, shell, client } = await setup();
    const patternPath = "/DOCSY/alpha-101/_index.md";
    const inputPath = "/DOCSY/archive-102/_index.md";
    const bash = new Bash({ defenseInDepth: false, files: {
      [patternPath]: String(await vfs.readFile(patternPath)),
      [inputPath]: String(await vfs.readFile(inputPath)),
    } });
    const args = ["-r", "-F", "-f", patternPath, "-e", "Beta", inputPath];
    const actual = await shell.exec(["grep", ...args.map(quote)].join(" "));
    const expected = await bash.exec("grep", { args });
    expect(actual).toMatchObject({ stdout: expected.stdout, exitCode: expected.exitCode });
    expect(client.callsTo("searchDetailed")).toBe(0);
  });

  it("downloads cold bodies once, reuses warm bodies, then reloads only changed bodies", async () => {
    const { shell, client, advance } = await setup();
    expect((await shell.exec("grep -ri common .")).exitCode).toBe(0);
    expect(bodies(client).sort()).toEqual(["100", "101", "102", "103"]);
    client.resetCalls();
    expect((await shell.exec("grep -ri common .")).exitCode).toBe(0);
    expect(bodies(client)).toEqual([]);
    client.bumpVersion("101", "<p>changedunique</p>");
    advance();
    client.resetCalls();
    const changed = await shell.exec("grep -ri changedunique .");
    expect(changed.exitCode).toBe(0);
    expect(changed.stdout).toContain("changedunique");
    expect(bodies(client)).toEqual(["101"]);
  });

  it("prunes excluded directories and impossible filename filters before downloads", async () => {
    const { shell, client } = await setup();
    const result = await shell.exec("grep -r --exclude-dir=archive-* common .");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain("archive-102");
    expect(bodies(client).sort()).toEqual(["100", "101"]);
    expect(client.calls.some((call) => call.method === "getPageDirectChildren" && call.arg === "102")).toBe(false);
    client.resetCalls();
    expect((await shell.exec("grep -r --include '*.json' common .")).exitCode).toBe(1);
    expect(bodies(client)).toEqual([]);
  });

  it("rejects invalid arguments and regex before any body downloads", async () => {
    const { shell, client } = await setup();
    for (const command of ["grep -rz word .", "grep -r -A nope word .", "grep -r '[' .", "grep -r --include", "grep -re"]) {
      const result = await shell.exec(command);
      expect({ command, code: result.exitCode }).toEqual({ command, code: 2 });
      expect(bodies(client)).toEqual([]);
    }
  });
});

describe("quiet grep verified positive hints", () => {
  it("verifies a CQL candidate with one body and retains full scope semantics", async () => {
    const { shell, client } = await setup(seeded(), 1);
    const result = await shell.exec("grep -rqi Needle .");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
    expect(bodies(client)).toEqual(["103"]);
    expect(client.callsTo("searchDetailed")).toBe(1);
  });

  it("answers repeated quiet hits from cache without another search request", async () => {
    const { shell, client } = await setup(seeded(), 1);
    expect((await shell.exec("grep -rqi Needle .")).exitCode).toBe(0);
    client.resetCalls();
    expect((await shell.exec("grep -rqi Needle .")).exitCode).toBe(0);
    expect(bodies(client)).toEqual([]);
    expect(client.callsTo("searchDetailed")).toBe(0);
  });

  it("falls back when the search service is unavailable", async () => {
    const client = seeded();
    client.searchDetailed = async () => { throw new Error("search unavailable"); };
    const { shell, diagnostics } = await setup(client);
    expect((await shell.exec("grep -rqi Needle .")).exitCode).toBe(0);
    expect(diagnostics.join("\n")).toContain("hint unavailable");
    expect(bodies(client)).toHaveLength(4);
  });

  it("honors the opt-out and never issues text hints for inverted matches", async () => {
    const { shell, client } = await setup();
    expect((await shell.exec("grep --no-cql -rqi Needle .")).exitCode).toBe(0);
    expect(client.callsTo("searchDetailed")).toBe(0);
    expect((await shell.exec("grep -rqv Needle .")).exitCode).toBe(0);
    expect(client.callsTo("searchDetailed")).toBe(0);
  });

  it("falls back after a CQL false negative", async () => {
    const client = seeded();
    client.searchDetailed = async () => ({ results: [], totalSize: 0 });
    const { shell } = await setup(client);
    expect((await shell.exec("grep -rqi Needle .")).exitCode).toBe(0);
    expect(bodies(client).sort()).toEqual(["100", "101", "102", "103"]);
  });

  it("does not return a false CQL candidate without checking its body", async () => {
    const client = seeded();
    const search = client.searchDetailed.bind(client);
    client.searchDetailed = async () => search('id = "101"');
    const { shell } = await setup(client);
    expect((await shell.exec("grep -rqi definitelyAbsent .")).exitCode).toBe(1);
    expect(bodies(client)[0]).toBe("101");
    expect(bodies(client).sort()).toEqual(["100", "101", "102", "103"]);
  });

  it("reports incomplete quiet scans as errors rather than false no-match", async () => {
    const { shell, client } = await setup(seeded(), 1, false);
    const result = await shell.exec("grep -rqi definitelyAbsent .");
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("prefetch");
    expect(bodies(client)).toHaveLength(1);
  });
});

describe("indexed excerpts for agent discovery", () => {
  it("returns excerpts and usable paths without bodies or hierarchy traversal", async () => {
    const { shell, client, diagnostics } = await setup();
    client.resetCalls();
    const result = await shell.exec(`cql --excerpt 'text ~ "Needle"'`);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Needle unique.");
    expect(result.stdout).toContain("Nested");
    expect(bodies(client)).toEqual([]);
    expect(client.callsTo("getPageDirectChildren")).toBe(0);
    expect(client.callsTo("getFolderChildren")).toBe(0);
    expect(diagnostics.join("\n")).toContain("0 page bodies");
    const path = result.stdout.split("\t")[0]!;
    expect((await shell.exec(`cat ${quote(path)}`)).stdout).toContain("Needle unique.");
  });

  it("reports truncation in structured output and diagnostics without downloading bodies", async () => {
    const { shell, client, diagnostics } = await setup();
    const result = await shell.exec(`cql --json --limit 1 'type = page'`);
    expect(result.exitCode).toBe(0);
    const json = JSON.parse(result.stdout);
    expect(json).toMatchObject({ source: "confluence-index", complete: false, truncated: true });
    expect(json.results).toHaveLength(1);
    expect(diagnostics.join("\n")).toContain("TRUNCATED");
    expect(bodies(client)).toEqual([]);
    expect(client.callsTo("getPageDirectChildren")).toBe(0);
    const complete = JSON.parse((await shell.exec(`cql --json --limit 10 'type = page'`)).stdout);
    expect(complete).toMatchObject({ complete: true, truncated: false });
    expect(complete.results).toHaveLength(4);
    expect(bodies(client)).toEqual([]);
  });

  it("validates indexed search limits before issuing requests", async () => {
    const { shell, client } = await setup();
    for (const limit of ["0", "1001", "NaN", "1.5"]) {
      const result = await shell.exec(`cql --excerpt --limit ${limit} 'type = page'`);
      expect(result.exitCode).not.toBe(0);
    }
    expect(client.callsTo("searchDetailed")).toBe(0);
    expect(bodies(client)).toEqual([]);
  });
});

it("fgrep and egrep share bounded current-body search", async () => {
  const { shell, client } = await setup(seeded(), 1);
  for (const command of ["fgrep -r craftsmanship .", "egrep -r 'craft.*' ."]) {
    const result = await shell.exec(command);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("prefetch limit");
  }
  expect(bodies(client)).toHaveLength(0);
});

it("explicit by-id grep follows the page and honors a zero download budget", async () => {
  const first = await setup(seeded(), 0);
  const limited = await first.shell.exec("grep -r craftsmanship .by-id/101.md");
  expect(limited.exitCode).toBe(2);
  expect(bodies(first.client)).toHaveLength(0);
  const second = await setup(seeded(), 1);
  const found = await second.shell.exec("grep -r craftsmanship .by-id/101.md");
  expect(found.exitCode).toBe(0);
  expect(found.stdout).toContain("craftsmanship");
  expect(bodies(second.client)).toEqual(["101"]);
});
