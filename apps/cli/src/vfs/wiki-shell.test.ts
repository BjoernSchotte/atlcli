/**
 * The conformance suite for the just-bash adapter (WP6.1–6.5).
 *
 * This drives the **real** just-bash interpreter over the **real** VFS core
 * against a fake Confluence, because the thing worth testing is the seam: a
 * unit test of the adapter would not have caught, say, `ls -l` issuing a stat
 * per entry, and that is the failure mode that matters against a REST API.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfluenceVfsImpl } from "@atlcli/confluence-vfs";
import { FakeConfluenceClient } from "@atlcli/confluence-vfs/testing";
import { createWikiShell, type WikiShell } from "./wiki-shell.js";

let root: string;
let clock: number;
let diagnostics: string[];

function seeded(): FakeConfluenceClient {
  return new FakeConfluenceClient()
    .seedSpace({ id: "sp-1", key: "DOCSY", name: "Docs", homepageId: "100" })
    .seedPage({ id: "100", title: "Docs Home", spaceKey: "DOCSY", storage: "<p>Space home.</p>" })
    .seedPage({
      id: "101",
      title: "Getting Started",
      spaceKey: "DOCSY",
      parentId: "100",
      position: 1,
      storage: "<h1>Getting Started</h1><p>Install with kubernetes tooling.</p>",
      labels: ["onboarding"],
    })
    .seedPage({
      id: "102",
      title: "Architecture",
      spaceKey: "DOCSY",
      parentId: "100",
      position: 2,
      storage: "<h1>Architecture</h1><p>Runs on kubernetes clusters.</p>",
    })
    .seedPage({
      id: "103",
      title: "Deployment",
      spaceKey: "DOCSY",
      parentId: "102",
      position: 1,
      storage: "<h1>Deployment</h1><p>No container platform mentioned here.</p>",
    });
}

async function makeShell(
  client: FakeConfluenceClient,
  overrides: Record<string, unknown> = {},
): Promise<{ shell: WikiShell; vfs: ConfluenceVfsImpl }> {
  const vfs = await ConfluenceVfsImpl.open({
    profile: "mayflower",
    client,
    mode: "rw",
    allowDelete: true,
    cacheDir: root,
    offline: false,
    coalesceMs: 0,
    now: () => clock,
    sleep: async (ms) => void (clock += ms),
    ...overrides,
  });
  const shell = await createWikiShell({
    vfs,
    spaces: ["DOCSY"],
    cqlGrep: false, // This suite pins exhaustive filesystem semantics.
    onDiagnostic: (line) => diagnostics.push(line),
    ...(overrides.cqlGrep !== undefined ? { cqlGrep: overrides.cqlGrep as boolean } : {}),
    ...(overrides.prefetchMax !== undefined ? { prefetchMax: overrides.prefetchMax as number } : {}),
  });
  return { shell, vfs };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "vfs-shell-"));
  clock = Date.parse("2026-09-16T09:00:00.000Z");
  diagnostics = [];
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("reading", () => {
  it("completes commands and paths without fetching bodies, relative to persistent cd", async () => {
    const client = seeded();
    const { shell, vfs } = await makeShell(client, { mode: "ro" });
    try {
      expect((await shell.complete("gr"))[0]).toContain("grep");
      expect((await shell.complete("cq"))[0]).toContain("cql");
      expect((await shell.complete("cd"))[0]).toContain("cd");
      expect((await shell.complete("curl"))[0]).not.toContain("curl");
      expect(await shell.complete("cat /DOCSY/arch")).toEqual([["/DOCSY/architecture-102/"], "/DOCSY/arch"]);
      expect(await shell.complete("cat arch")).toEqual([["architecture-102/"], "arch"]);
      expect(await shell.complete("cat architecture-102/_i")).toEqual([["architecture-102/_index.md"], "architecture-102/_i"]);
      expect((await shell.exec("cd architecture-102")).exitCode).toBe(0);
      expect((await shell.exec("pwd")).stdout.trim()).toBe("/DOCSY/architecture-102");
      expect(await shell.complete("cat _i")).toEqual([["_index.md"], "_i"]);
      expect(await shell.complete("cat ../gett")).toEqual([["../getting-started-101/"], "../gett"]);
      expect((await shell.complete("ls .v"))[0]).toContain(".versions/");
      expect(await shell.complete("cat missing/xx")).toEqual([[], "missing/xx"]);
      expect(client.callsTo("getPage")).toBe(0);
      expect(client.callsTo("getPagesBulk")).toBe(0);
      expect(vfs.cache!.stats().bodies).toBe(0);
    } finally {
      await vfs.close();
    }
  });

  it("completion does not execute shell input or change session variables", async () => {
    const client = seeded();
    const { shell, vfs } = await makeShell(client);
    try {
      await shell.exec("export CHECK=unchanged");
      expect((await shell.complete("echo unsafe > injected.md; gr"))[0]).toContain("grep");
      expect(await shell.complete("cat $(touch injected.md)")).toEqual([[], "injected.md)"]);
      expect((await shell.exec("echo $CHECK")).stdout.trim()).toBe("unchanged");
      expect(client.callsTo("createPage")).toBe(0);
      expect(client.callsTo("updatePage")).toBe(0);
    } finally {
      await vfs.close();
    }
  });

  it("lists a space", async () => {
    const { shell, vfs } = await makeShell(seeded());
    const result = await shell.exec("ls");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("getting-started-101");
    expect(result.stdout).toContain("architecture-102");
    await vfs.close();
  });

  it("lists with details without a stat storm", async () => {
    const client = seeded();
    const { shell, vfs } = await makeShell(client);
    await shell.exec("ls");
    client.resetCalls();
    const result = await shell.exec("ls -la");
    expect(result.exitCode).toBe(0);
    // Everything `ls -l` needs is already in the index.
    expect(client.callsTo("getPage")).toBe(0);
    await vfs.close();
  });

  it("cats a page through both addressable forms", async () => {
    const { shell, vfs } = await makeShell(seeded());
    const viaIndex = await shell.exec("cat architecture-102/_index.md");
    const viaAlias = await shell.exec("cat architecture-102.md");
    expect(viaIndex.stdout).toContain("Runs on kubernetes clusters.");
    expect(viaAlias.stdout).toBe(viaIndex.stdout);
    await vfs.close();
  });

  it("walks recursively", async () => {
    const { shell, vfs } = await makeShell(seeded());
    const result = await shell.exec("ls -R");
    expect(result.stdout).toContain("deployment-103");
    await vfs.close();
  });

  it("pipes, sorts, counts and heads", async () => {
    const { shell, vfs } = await makeShell(seeded());
    const result = await shell.exec("ls | sort | head -2 | wc -l");
    expect(result.stdout.trim()).toBe("2");
    await vfs.close();
  });

  it("runs sed, awk and jq over page content", async () => {
    const { shell, vfs } = await makeShell(seeded());
    const sed = await shell.exec("cat architecture-102.md | sed 's/kubernetes/k8s/'");
    expect(sed.stdout).toContain("Runs on k8s clusters.");

    const awk = await shell.exec("cat architecture-102.md | awk 'NR==2'");
    expect(awk.exitCode).toBe(0);

    const jq = await shell.exec("cat _space.json | jq -r .key");
    expect(jq.stdout.trim()).toBe("DOCSY");
    await vfs.close();
  });

  it("finds by name from the tree index", async () => {
    const { shell, vfs } = await makeShell(seeded());
    const result = await shell.exec("find . -name '*-103' -type d");
    expect(result.stdout).toContain("deployment-103");
    expect(diagnostics.some((d) => d.startsWith("find:"))).toBe(true);
    await vfs.close();
  });

  it("renders a tree", async () => {
    const { shell, vfs } = await makeShell(seeded());
    const result = await shell.exec("tree");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("architecture-102");
    await vfs.close();
  });

  it("reads the convenience directories", async () => {
    const { shell, vfs } = await makeShell(seeded());
    expect((await shell.exec("ls .recent")).stdout).toContain("7d");
    expect((await shell.exec("cat .search/README")).stdout).toContain("CQL");
    expect((await shell.exec("cat .by-id/103.md")).stdout).toContain("No container platform");
    await vfs.close();
  });
});

describe("grep", () => {
  it("searches a glob through real folder endpoints, including nested folders", async () => {
    const client = seeded()
      .seedPage({ id: "104", title: "Library", type: "folder", spaceKey: "DOCSY", parentId: "100" })
      .seedPage({ id: "105", title: "Practices", type: "folder", spaceKey: "DOCSY", parentId: "104" })
      .seedPage({ id: "106", title: "Craft", spaceKey: "DOCSY", parentId: "105",
        storage: "<p>Craftsmanship</p>" });
    const { shell, vfs } = await makeShell(client, { mode: "ro" });
    try {
      const result = await shell.exec("grep -r -i craftsmanship *");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("library-104/practices-105/craft-106/_index.md:Craftsmanship");
      expect(client.callsTo("getFolderChildren")).toBe(2);
      expect(client.callsTo("createPage")).toBe(0);
      expect(client.callsTo("updatePage")).toBe(0);
    } finally {
      await vfs.close();
    }
  });

  it("finds dotted words and fresh content without visiting history or attachments", async () => {
    const client = seeded();
    client.seedPage({ id: "104", title: "Tokens", spaceKey: "DOCSY", parentId: "100",
      storage: "<p>prefix.zqxdotted.suffix</p>" });
    const { shell, vfs } = await makeShell(client);
    const result = await shell.exec("grep -rnw zqxdotted .");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/tokens-104\/_index.md:\d+:.*zqxdotted/);
    for (const method of ["searchPages", "getPageAtVersion", "getPageVersions", "listAttachments", "getPageComments"]) {
      expect(client.callsTo(method)).toBe(0);
    }
    await vfs.close();
  });

  it("preserves explicit patterns, inversion, filters and file/subtree scope", async () => {
    const { shell, vfs } = await makeShell(seeded());
    for (const command of [
      "grep -rln -e kubernetes architecture-102/_index.md",
      "grep --recursive -l -- kubernetes architecture-102/_index.md",
      "grep -rlv kubernetes architecture-102/_index.md",
      "grep -rl --include='*.md' kubernetes architecture-102",
    ]) {
      const result = await shell.exec(command);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("architecture-102/_index.md");
      expect(result.stdout).not.toContain("getting-started-101");
      expect(result.stdout).not.toContain("deployment-103");
    }
    expect(await vfs.subtreePageIds("/DOCSY/architecture-102/_index.md", "DOCSY")).toEqual(["102"]);
    await vfs.close();
  });
  it("scans current bodies for whole-word matches without CQL narrowing", async () => {
    const client = seeded();
    const { shell, vfs } = await makeShell(client);
    const result = await shell.exec("grep -rlw kubernetes .");

    expect(result.stdout).toContain("architecture-102");
    expect(result.stdout).toContain("getting-started-101");
    expect(result.stdout).not.toContain("deployment-103");
    expect(diagnostics.some((d) => d.includes("full scan"))).toBe(true);
    // One bulk fetch for the candidates, not one per page in the space.
    expect(client.callsTo("getPagesBulk")).toBe(1);
    await vfs.close();
  });

  it("gives exact line numbers, from grep rather than from CQL", async () => {
    const { shell, vfs } = await makeShell(seeded());
    const result = await shell.exec("grep -rnw kubernetes .");
    expect(result.stdout).toMatch(/architecture-102[^\n]*:\d+:/);
    await vfs.close();
  });

  /**
   * The regression that rewrote the guard (deviation D9).
   *
   * "kubern" satisfies every condition decision 12 lists — plain literal, six
   * characters, no metacharacters, no separators — and `text ~ "kubern"`
   * matches nothing, while the real grep matches two pages. A syntactic guard
   * cannot see that, so the shortcut now requires the caller to assert a whole
   * word with `-w`.
   */
  it("does not let a word *prefix* take the CQL path and return nothing", async () => {
    const { shell, vfs } = await makeShell(seeded());
    const result = await shell.exec("grep -rl kubern .");
    expect(result.stdout).toContain("architecture-102");
    expect(result.stdout).toContain("getting-started-101");
    expect(diagnostics.some((d) => d.includes("full scan"))).toBe(true);
    await vfs.close();
  });

  it("also refuses the shortcut for an unmarked whole word", async () => {
    const { shell, vfs } = await makeShell(seeded());
    const result = await shell.exec("grep -rl kubernetes .");
    expect(result.stdout).toContain("architecture-102");
    expect(diagnostics.some((d) => d.includes("CQL text indexing"))).toBe(true);
    await vfs.close();
  });

  it("accepts an explicitly anchored pattern", async () => {
    const { shell, vfs } = await makeShell(seeded());
    await shell.exec(String.raw`grep -rl '\bkubernetes\b' .`);
    expect(diagnostics.some((d) => d.includes("full scan"))).toBe(true);
    await vfs.close();
  });

  it("falls back for a regex, a separator and a short pattern", async () => {
    const { shell, vfs } = await makeShell(seeded());
    for (const pattern of ["-w 'kube.*'", "-w 'container-platform'", "-w 'on'"]) {
      diagnostics = [];
      await shell.exec(`grep -rl ${pattern} .`);
      expect(diagnostics.some((d) => d.includes("full scan"))).toBe(true);
    }
    await vfs.close();
  });

  it("honours --no-cql", async () => {
    const { shell, vfs } = await makeShell(seeded());
    const result = await shell.exec("grep -rlw --no-cql kubernetes .");
    expect(result.stdout).toContain("architecture-102");
    expect(diagnostics.some((d) => d.includes("full scan"))).toBe(true);
    await vfs.close();
  });

  it("honours the environment switch", async () => {
    const { shell, vfs } = await makeShell(seeded());
    await shell.exec("ATLCLI_VFS_NO_CQL=1 grep -rlw kubernetes .");
    expect(diagnostics.some((d) => d.includes("full scan"))).toBe(true);
    await vfs.close();
  });

  it("aborts with a message when a full scan breaches the prefetch budget", async () => {
    const client = seeded();
    const { shell, vfs } = await makeShell(client, { prefetchMax: 1 });
    const result = await shell.exec("grep -rl kubern .");
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("prefetch limit");
    expect(result.stderr).toContain("--prefetch-max");
    // Nothing partial was downloaded.
    expect(client.callsTo("getPagesBulk")).toBe(0);
    await vfs.close();
  });

  it("passes a non-recursive grep straight through", async () => {
    const { shell, vfs } = await makeShell(seeded());
    diagnostics = [];
    const result = await shell.exec("cat architecture-102.md | grep kubernetes");
    expect(result.stdout).toContain("kubernetes");
    expect(diagnostics).toHaveLength(0);
    await vfs.close();
  });

  it("names the chosen path on every recursive run", async () => {
    const { shell, vfs } = await makeShell(seeded());
    await shell.exec("grep -rlw kubernetes .");
    expect(diagnostics).not.toHaveLength(0);
    await vfs.close();
  });
});

describe("writing", () => {
  it("renames a page when the destination slug already resolves to the same ID", async () => {
    const client = seeded();
    const { shell, vfs } = await makeShell(client);
    const result = await shell.exec("mv getting-started-101 renamed-101");
    expect(result.exitCode).toBe(0);
    expect(client.peekPage("101")?.title).toBe("Renamed");
    expect(client.peekPage("101")?.parentId).toBe("100");
    expect(client.callsTo("movePage")).toBe(0);
    await vfs.close();
  });
  it("edits a page in place with sed", async () => {
    const client = seeded();
    const { shell, vfs } = await makeShell(client);
    const result = await shell.exec("sed -i 's/kubernetes/k8s/' architecture-102/_index.md");
    expect(result.exitCode).toBe(0);
    expect(client.peekPage("102")?.storage).toContain("k8s");
    await vfs.close();
  });

  it("creates a page with a redirect", async () => {
    const client = seeded();
    const { shell, vfs } = await makeShell(client);
    await shell.exec("ls");
    const result = await shell.exec("echo '# Release notes' > release-notes.md");
    expect(result.exitCode).toBe(0);
    expect(client.callsTo("createPage")).toBe(1);
    // The name the writer used keeps working for the rest of the session, even
    // though the page's canonical name now carries its id.
    expect((await shell.exec("cat release-notes.md")).stdout).toContain("Release notes");
    await vfs.close();
  });

  it("refuses every write in ro mode, and nothing reaches Confluence", async () => {
    const client = seeded();
    const { shell, vfs } = await makeShell(client, { mode: "ro", allowDelete: false });
    for (const script of [
      "sed -i 's/kubernetes/k8s/' architecture-102/_index.md",
      "echo x > architecture-102/_index.md",
      "echo x >> architecture-102/_index.md",
      "mkdir new-section",
      "mv architecture-102 renamed-102",
      "cp architecture-102 copy-102",
      "rm -r architecture-102",
    ]) {
      const result = await shell.exec(script);
      expect(result.exitCode).not.toBe(0);
    }
    expect(client.callsTo("updatePage")).toBe(0);
    expect(client.callsTo("createPage")).toBe(0);
    expect(client.callsTo("deletePage")).toBe(0);
    expect(client.callsTo("movePage")).toBe(0);
    expect(client.callsTo("copyPage")).toBe(0);
    await vfs.close();
  });

  /**
   * A redirect is the one write path that shows the core's own message, and it
   * used to be the one that crashed the process: just-bash lets a filesystem
   * error escape `exec()` there rather than turning it into a shell error.
   */
  it("shows the real refusal, naming the flag, on a redirect", async () => {
    const { shell, vfs } = await makeShell(seeded(), { mode: "ro", allowDelete: false });
    const result = await shell.exec("echo x > architecture-102/_index.md");
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("EROFS");
    expect(result.stderr).toContain("--mode rw");
    await vfs.close();
  });

  /**
   * Known rough edge, upstream's and not ours: `sed -i` catches every write
   * error and reports it as "No such file or directory", so the reason is lost.
   * Pinned here so the day it improves, this test tells us.
   */
  it("loses the reason through sed -i, which is just-bash's mapping", async () => {
    const { shell, vfs } = await makeShell(seeded(), { mode: "ro", allowDelete: false });
    const result = await shell.exec("sed -i 's/kubernetes/k8s/' architecture-102/_index.md");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("No such file or directory");
    await vfs.close();
  });

  it("refuses rm without --allow-delete", async () => {
    const { shell, vfs } = await makeShell(seeded(), { allowDelete: false });
    // Every page is a directory (deviation D1), so `rm` needs -r.
    const result = await shell.exec("rm -r architecture-102/deployment-103");
    expect(result.exitCode).not.toBe(0);
    expect(`${result.stderr}${result.stdout}`).toContain("--allow-delete");
    await vfs.close();
  });

  it("moves a page with mv", async () => {
    const client = seeded();
    const { shell, vfs } = await makeShell(client);
    await shell.exec("ls && ls architecture-102");
    const result = await shell.exec("mv getting-started-101 architecture-102/getting-started-101");
    expect(result.exitCode).toBe(0);
    expect(client.peekPage("101")?.parentId).toBe("102");
    await vfs.close();
  });

  it("deletes into the trash with rm", async () => {
    const client = seeded();
    const { shell, vfs } = await makeShell(client);
    await shell.exec("ls architecture-102");
    const result = await shell.exec("rm -r architecture-102/deployment-103");
    expect(result.exitCode).toBe(0);
    expect(client.isTrashed("103")).toBe(true);
    await vfs.close();
  });
});

describe("the extra commands", () => {
  it("cql prints paths", async () => {
    const { shell, vfs } = await makeShell(seeded());
    const result = await shell.exec(`cql 'text ~ "kubernetes"'`);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("/DOCSY/.by-id/102.md");
    await vfs.close();
  });

  it("page-id and page-url resolve a path", async () => {
    const { shell, vfs } = await makeShell(seeded());
    expect((await shell.exec("page-id architecture-102")).stdout.trim()).toBe("102");
    expect((await shell.exec("page-url architecture-102")).stdout.trim()).toContain(
      "/spaces/DOCSY/pages/102",
    );
    await vfs.close();
  });

  it("vfs-status reports the mode, the cache and the counters", async () => {
    const { shell, vfs } = await makeShell(seeded());
    await shell.exec("cat architecture-102.md");
    const result = await shell.exec("vfs-status");
    expect(result.stdout).toContain("mode:");
    expect(result.stdout).toContain("rw");
    expect(result.stdout).toContain("DOCSY");
    expect(result.stdout).toContain("cache:");
    await vfs.close();
  });

  it("keeps the network commands out of the shell entirely", async () => {
    const { shell, vfs } = await makeShell(seeded());
    for (const forbidden of ["curl https://example.com", "python3 -c 'print(1)'", "sqlite3 :memory:"]) {
      const result = await shell.exec(forbidden);
      expect(result.exitCode).not.toBe(0);
    }
    await vfs.close();
  });
});

describe("the demand principle, through the shell", () => {
  it("lists without fetching a single body", async () => {
    const client = seeded();
    const { shell, vfs } = await makeShell(client);
    client.resetCalls();
    await shell.exec("ls -R");
    expect(client.callsTo("getPage")).toBe(0);
    expect(client.callsTo("getPagesBulk")).toBe(0);
    await vfs.close();
  });
});
