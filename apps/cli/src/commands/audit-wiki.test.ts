/**
 * `audit wiki` through the real CLI on a fixture sync database: the
 * snapshot the rules see, the older check flags, baseline, --fail-on, a
 * custom rule and the rules file's confluence: section.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createSyncDb, initAtlcliDir, type PageRecord } from "@atlcli/confluence/internal";

const CLI = fileURLToPath(new URL("../index.ts", import.meta.url));
const DAY = 24 * 60 * 60 * 1000;
const ago = (days: number) => new Date(Date.now() - days * DAY).toISOString();

let home: string;
let docs: string;

function record(pageId: string, p: Partial<PageRecord> = {}): PageRecord {
  const now = new Date().toISOString();
  return {
    pageId,
    path: `${pageId}.md`,
    title: `Page ${pageId}`,
    spaceKey: "TEST",
    version: 1,
    lastSyncedAt: now,
    localHash: "a",
    remoteHash: "a",
    baseHash: "a",
    syncState: "synced",
    parentId: "2",
    ancestors: ["2"],
    hasAttachments: false,
    contentType: "page",
    createdBy: "ann",
    createdAt: ago(900),
    lastModifiedBy: "ann",
    lastModified: ago(3),
    contentStatus: "current",
    versionCount: 1,
    wordCount: null,
    isRestricted: false,
    syncCreatedAt: now,
    syncUpdatedAt: now,
    remoteInaccessibleAt: null,
    remoteInaccessibleReason: null,
    ...p,
  };
}

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), "atlcli-audit-wiki-"));
  docs = join(home, "docs");
  await mkdir(join(home, ".atlcli"), { recursive: true });
  await writeFile(join(home, ".atlcli", "config.json"), JSON.stringify({ profiles: {} }));
  await mkdir(docs, { recursive: true });
  await initAtlcliDir(docs, { space: "TEST", baseUrl: "https://example.atlassian.net" });
  const db = await createSyncDb(join(docs, ".atlcli"), { autoMigrate: true });
  await db.init();
  await db.setMeta("space_key", "TEST");
  // 1: stale (400 d), orphan, one contributor, a broken link. 2: the parent, linked from 1.
  // 3: child of 2, restricted draft with 60 versions, contributors inactive.
  await db.upsertPage(record("1", { parentId: null, ancestors: [], lastModified: ago(400) }));
  await db.upsertPage(record("2", { parentId: null, ancestors: [] }));
  await db.upsertPage(record("3", { contentStatus: "draft", isRestricted: true, versionCount: 60 }));
  const link = { linkText: null, lineNumber: 7, createdAt: new Date().toISOString() };
  await db.setPageLinks("1", [
    { ...link, sourcePageId: "1", targetPageId: "2", targetPath: "./2.md", linkType: "internal", isBroken: false },
    { ...link, sourcePageId: "1", targetPageId: null, targetPath: "./gone.md", linkType: "internal", isBroken: true },
  ]);
  await db.setPageLinks("3", [{ ...link, sourcePageId: "3", targetPageId: "2", targetPath: "./2.md", linkType: "internal", isBroken: false }]);
  for (const [id, name, active] of [["ann", "Ann", true], ["cy", "Cy", false], ["di", "Di", false]] as const) {
    await db.upsertUser({ userId: id, displayName: name, email: null, isActive: active, lastCheckedAt: new Date().toISOString() });
  }
  const contributor = (pageId: string, userId: string) => ({ pageId, userId, contributionCount: 1, lastContributedAt: null });
  await db.setPageContributors("1", [contributor("1", "ann")]);
  await db.setPageContributors("2", [contributor("2", "ann"), contributor("2", "cy")]);
  await db.setPageContributors("3", [contributor("3", "cy"), contributor("3", "di")]);
  await db.setPageLabels("2", ["owner-ann"]);
  await db.close();
});

afterAll(async () => {
  if (home) await rm(home, { recursive: true, force: true });
});

async function runCli(args: string[]) {
  const proc = Bun.spawn([process.execPath, "--conditions=development", "run", CLI, "audit", "wiki", ...args], {
    cwd: docs,
    env: { ...process.env, HOME: home, USERPROFILE: home, FLAG_AUDIT: "true", ATLCLI_DISABLE_UPDATE_CHECK: "1" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { stdout, stderr, exitCode };
}
const json = async (args: string[]) => {
  const r = await runCli([...args, "--json"]);
  try {
    return { ...r, report: JSON.parse(r.stdout) };
  } catch {
    throw new Error(`not JSON: ${r.stdout}\n${r.stderr}`);
  }
};
const ids = (report: { findings: Array<{ rule: string; key: string; severity: string }> }) => report.findings.map((f) => `${f.rule}:${f.key}:${f.severity}`);

describe("audit wiki", () => {
  test("no flags: the default profile; errors exit 2", async () => {
    const { report, exitCode } = await json([]);
    expect(exitCode).toBe(2);
    expect(report.schemaVersion).toBe("3");
    expect(report.product).toBe("confluence");
    expect(report.query).toBe("space TEST");
    expect(report.rules.source).toBe("built-in profile default");
    expect(ids(report)).toEqual(["content/stale:1:error", "links/orphan:1:warning", "links/broken:1:warning", "people/inactive-contributors:3:warning"]);
    expect(report.findings[0].target).toEqual({ kind: "page", key: "1", url: "https://example.atlassian.net/wiki/pages/viewpage.action?pageId=1" });
    expect(report.findings[0].assignee).toBe("Ann");
    expect(report.quiet).toEqual({ "people/single-contributor": 1, "content/restricted": 1, "content/draft": 1 });
    expect((await runCli(["--fail-on", "never"])).exitCode).toBe(0);
  });

  test("the older check flags pick the rules and list everything they find", async () => {
    const { report } = await json(["--orphans", "--stale-high", "12", "--high-churn", "50", "--missing-label", "owner-ann", "--fail-on", "never"]);
    expect(report.rules.minLevel).toBe("info");
    expect(ids(report)).toEqual([
      "content/stale:1:error",
      "links/orphan:1:warning",
      "content/missing-label:1:info",
      "content/missing-label:3:info",
      "content/high-churn:3:info",
    ]);
    expect(report.findings[0].detail).toMatch(/^Not edited for 1[23] months \(last \d{4}-\d\d-\d\d\)\.$/);
    const bad = await json(["--stale-high", "soon"]);
    expect(bad.exitCode).toBe(1);
    expect(bad.report.error.message).toContain("--stale-high must be a number (months)");
  });

  test("--checks, text output and the user-status note", async () => {
    const { stdout } = await runCli(["--checks", "people", "--min-level", "info", "--fail-on", "never"]);
    expect(stdout).toContain("Wiki audit: 2 finding(s)");
    expect(stdout).toContain("Single contributor — people/single-contributor (1)");
    expect(stdout).toContain("[warning] 3  Page 3 (Ann) — All 2 contributors inactive");
    expect(stdout).toContain("Note: User status checked today");
  });

  test("--update-baseline accepts the findings; later runs hide them", async () => {
    const file = join(docs, ".atlcli", "audit-baseline.json");
    try {
      const first = await json(["--update-baseline", "--fail-on", "never"]);
      // macOS reports the temp dir through its /private symlink.
      expect(first.report.diagnostics.join(" ")).toMatch(new RegExp(`accepted in .*${file}\\.$`));
      expect(JSON.parse(await readFile(file, "utf8")).entries).toHaveLength(7);
      const next = await json([]);
      expect(next.exitCode).toBe(0);
      expect(next.report.findings).toEqual([]);
      expect((await json(["--no-baseline", "--fail-on", "never"])).report.findings).toHaveLength(4);
    } finally {
      await rm(file, { force: true });
    }
  });

  test("a custom rule, the confluence: section, --list-rules", async () => {
    await mkdir(join(docs, ".atlcli", "audit"), { recursive: true });
    await writeFile(
      join(docs, ".atlcli", "audit", "owner.ts"),
      `export const meta = { audit: { id: "team/owner", product: "confluence", title: "Owner label" } };
export default (page: AuditPage, rule: AuditRule) => page.labels.some((l) => l.startsWith("owner-")) ? undefined : rule.finding({ detail: \`\${page.title} has no owner.\` });
`,
    );
    await writeFile(join(docs, ".atlcli", "audit-rules.yaml"), "minLevel: error\nconfluence:\n  extends: minimal\n  rules:\n    content/stale: off\n    team/owner: error\n");
    try {
      const { report } = await json(["--fail-on", "never"]);
      expect(report.rules.source).toMatch(/audit-rules\.yaml$/);
      expect(ids(report)).toEqual(["links/broken:1:warning", "team/owner:1:error", "team/owner:3:error"]);
      const list = (await json(["--list-rules"])).report.rules;
      expect(list.filter((r: { origin: string }) => r.origin === "built-in")).toHaveLength(14);
      expect(list.at(-1).id).toBe("team/owner");
    } finally {
      await rm(join(docs, ".atlcli", "audit"), { recursive: true, force: true });
      await rm(join(docs, ".atlcli", "audit-rules.yaml"), { force: true });
    }
  });

  test("--fix needs a profile; --markdown uses the default template", async () => {
    const fix = await json(["--fix"]);
    expect(fix.exitCode).toBe(1);
    expect(fix.report.error.message).toContain("No active profile");
    const md = (await runCli(["--checks", "links/broken", "--markdown"])).stdout;
    expect(md).toContain("# Wiki audit");
    expect(md).toContain("| Severity | Page | Summary | Owner | Finding |");
    expect(md).toContain("| warning | [1](https://example.atlassian.net/wiki/pages/viewpage.action?pageId=1) | Page 1 | Ann | Broken link to ./gone.md (line 7). |");
  });
});
