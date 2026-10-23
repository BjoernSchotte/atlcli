/**
 * `audit jira` through the real CLI against a local Bun HTTP server speaking
 * the Jira Cloud paths.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { auditRulesCandidates, parseStaleDays } from "./audit-jira.js";

const CLI = fileURLToPath(new URL("../index.ts", import.meta.url));
const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.now();
const ago = (days: number) => new Date(NOW - days * DAY).toISOString();

const STATUSES = [
  { id: "1", name: "To Do", statusCategory: { id: 2, key: "new", name: "To Do" } },
  { id: "2", name: "In Progress", statusCategory: { id: 4, key: "indeterminate", name: "In Progress" } },
  { id: "3", name: "Done", statusCategory: { id: 3, key: "done", name: "Done" } },
];
const status = (id: string) => STATUSES.find((s) => s.id === id)!;
const story = { id: "1", name: "Story", subtask: false, hierarchyLevel: 0 };

function issue(n: number, current: string, fields: Record<string, unknown> = {}) {
  return {
    id: String(n),
    key: `ATLCLI-${n}`,
    self: "",
    fields: {
      summary: `Issue ${n}`,
      status: status(current),
      issuetype: story,
      project: { id: "1", key: "ATLCLI" },
      created: ago(200),
      updated: ago(1),
      assignee: { accountId: "a", displayName: "Ann" },
      parent: { id: "99", key: "ATLCLI-99" },
      fixVersions: [],
      ...fields,
    },
  };
}
function move(id: string, from: string, to: string, at: string) {
  return { id, author: {}, created: Date.parse(at), items: [{ field: "status", fieldtype: "jira", fieldId: "status", from, fromString: status(from).name, to, toString: status(to).name }] };
}

// ATLCLI-1: in progress for 100 days, unassigned, not updated for 95 days, no parent.
// ATLCLI-2: to do, in an open sprint, no story points.
// ATLCLI-10..14: done 10 days ago with cycle times 1..5 days, no fix version.
const OPEN = [
  issue(1, "2", { assignee: null, updated: ago(95), parent: undefined }),
  issue(2, "1"),
];
const DONE = [10, 11, 12, 13, 14].map((n) => issue(n, "3"));
const CHANGELOGS: Record<string, unknown[]> = {
  "1": [move("o1", "1", "2", ago(100))],
  ...Object.fromEntries(DONE.map((d, i) => [d.id, [move(`d${i}a`, "1", "2", ago(10 + i + 1)), move(`d${i}b`, "2", "3", ago(10))]])),
};

let searches: string[] = [];
let server: ReturnType<typeof Bun.serve>;
let home: string;

beforeAll(async () => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const { pathname } = new URL(req.url);
      if (pathname === "/rest/api/3/status") return Response.json(STATUSES);
      if (pathname === "/rest/api/3/field") return Response.json([]);
      if (pathname === "/rest/api/3/project/ATLCLI/versions") return Response.json([{ id: "1", name: "1.0" }]);
      if (pathname === "/rest/api/3/search/jql") {
        const { jql } = (await req.json()) as { jql: string };
        searches.push(jql);
        const issues = jql.includes("resolution IS NOT EMPTY") ? [] : jql.includes("openSprints()") ? [OPEN[1]] : jql.includes("statusCategory = Done") ? DONE : OPEN;
        return Response.json({ issues });
      }
      if (pathname === "/rest/api/3/changelog/bulkfetch") {
        const { issueIdsOrKeys } = (await req.json()) as { issueIdsOrKeys: string[] };
        return Response.json({
          issueChangeLogs: issueIdsOrKeys.map((key) => {
            const id = key.replace("ATLCLI-", "");
            return { issueId: id, changeHistories: CHANGELOGS[id] ?? [] };
          }),
        });
      }
      return new Response(JSON.stringify({ message: `stub: no route for ${pathname}` }), { status: 404 });
    },
  });
  home = await mkdtemp(join(tmpdir(), "atlcli-audit-jira-"));
  await mkdir(join(home, ".atlcli"), { recursive: true });
  await writeFile(
    join(home, ".atlcli", "config.json"),
    JSON.stringify({
      currentProfile: "p",
      profiles: { p: { name: "p", baseUrl: server.url.origin, deploymentType: "cloud", auth: { type: "bearer" } } },
    })
  );
});

afterAll(async () => {
  server?.stop(true);
  if (home) await rm(home, { recursive: true, force: true });
});

async function runCli(args: string[], env: Record<string, string> = { FLAG_AUDIT: "true" }) {
  const proc = Bun.spawn([process.execPath, "--conditions=development", "run", CLI, ...args], {
    cwd: home,
    env: { ...process.env, HOME: home, USERPROFILE: home, ATLCLI_API_TOKEN: "stub-token", ATLCLI_DISABLE_UPDATE_CHECK: "1", ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
}

const BASE = ["audit", "jira", "--project", "ATLCLI", "--points-field", "customfield_10016"];

const rulesFile = () => join(home, ".atlcli", "audit-rules.yaml");
const baselineFile = () => join(home, ".atlcli", "profiles", "p", "audit-baseline.json");

describe("audit jira", () => {
  test("default profile: loud findings listed, info findings quiet, exit 2 on errors", async () => {
    searches = [];
    const { stdout, stderr, exitCode } = await runCli([...BASE, "--json"]);
    expect(stderr).toBe("");
    expect(exitCode).toBe(2);
    const report = JSON.parse(stdout);
    expect(report.schemaVersion).toBe("2");
    expect(report.query).toBe('project = "ATLCLI"');
    expect(report.rules).toEqual({ source: "built-in profile default", extends: "default", minLevel: "warning" });
    const rules = report.findings.map((f: { rule: string; key: string; severity: string }) => `${f.rule}:${f.key}:${f.severity}`);
    expect(rules).toEqual([
      "flow/stuck-wip:ATLCLI-1:error",
      "flow/unassigned-wip:ATLCLI-1:warning",
      "hygiene/stale:ATLCLI-1:error",
      "hygiene/unestimated-in-sprint:ATLCLI-2:warning",
    ]);
    expect(report.quiet).toEqual({ "hygiene/no-parent": 1, "hygiene/done-without-version": DONE.length });
    expect(report.diagnostics).toContain("hygiene/flagged skipped: no Flagged field found (set flagged.field in the rules file).");
    expect(searches.some((jql) => jql.includes("sprint in openSprints()"))).toBe(true);
    expect(searches.some((jql) => jql.includes("resolution IS NOT EMPTY"))).toBe(true);

    expect((await runCli([...BASE, "--fail-on", "never", "--json"])).exitCode).toBe(0);
    const all = JSON.parse((await runCli([...BASE, "--min-level", "info", "--json"])).stdout);
    expect(all.findings).toHaveLength(4 + 1 + DONE.length);
  });

  test("--checks stale limits the output; --markdown renders tables", async () => {
    const json = JSON.parse((await runCli([...BASE, "--checks", "stale", "--json"])).stdout);
    expect(json.findings.map((f: { rule: string }) => f.rule)).toEqual(["hygiene/stale"]);
    const md = (await runCli([...BASE, "--checks", "stale", "--markdown"])).stdout;
    expect(md).toContain("## Stale (1)");
    expect(md).toContain(`| error | [ATLCLI-1](${server.url.origin}/browse/ATLCLI-1) | Issue 1 |`);
  });

  test("a project rules file: profile, overrides, custom JQL rules", async () => {
    await writeFile(
      rulesFile(),
      [
        "extends: minimal",
        "minLevel: info",
        "rules:",
        "  hygiene/no-parent: warning",
        "custom:",
        "  - id: team/no-fix-version",
        "    jql: fixVersion IS EMPTY",
        "    severity: info",
        "    message: No fix version.",
        "overrides:",
        "  - match: { project: ATLCLI }",
        "    rules:",
        "      hygiene/stale: off",
      ].join("\n")
    );
    try {
      searches = [];
      const report = JSON.parse((await runCli([...BASE, "--json"])).stdout);
      // macOS reports the temp dir through its /private symlink.
      expect(report.rules).toEqual({ source: expect.stringMatching(new RegExp(`${rulesFile()}$`)), extends: "minimal", minLevel: "info" });
      expect(searches).toContain('(project = "ATLCLI") AND (fixVersion IS EMPTY) ORDER BY key ASC');
      const rules = [...new Set(report.findings.map((f: { rule: string }) => f.rule))];
      expect(rules).toEqual(["flow/unassigned-wip", "hygiene/no-parent", "team/no-fix-version"]);
    } finally {
      await rm(rulesFile(), { force: true });
    }
  });

  test("an invalid rules file is a usage error naming the path", async () => {
    await writeFile(rulesFile(), "rules:\n  hygiene/stale: { warning: soon }\n");
    try {
      const { stdout, exitCode } = await runCli([...BASE, "--json"]);
      expect(exitCode).toBe(1);
      expect(JSON.parse(stdout).error.message).toContain(`${rulesFile()}: rules.hygiene/stale.warning: expected days`);
    } finally {
      await rm(rulesFile(), { force: true });
    }
  });

  test("--update-baseline accepts current findings; later runs hide them", async () => {
    await rm(baselineFile(), { force: true });
    const first = JSON.parse((await runCli([...BASE, "--update-baseline", "--json"])).stdout);
    const saved = JSON.parse(await readFile(baselineFile(), "utf8"));
    expect(saved.schemaVersion).toBe(1);
    expect(saved.entries.map((e: { rule: string; subject: string }) => `${e.rule}:${e.subject}`)).toContain("hygiene/stale:ATLCLI-1");
    expect(first.diagnostics.join(" ")).toContain(`accepted in ${baselineFile()}`);
    const { stdout, exitCode } = await runCli([...BASE, "--json"]);
    expect(exitCode).toBe(0);
    const next = JSON.parse(stdout);
    expect(next.findings).toEqual([]);
    expect(next.summary.suppressed.baseline).toBe(saved.entries.length);
    expect(JSON.parse((await runCli([...BASE, "--no-baseline", "--json"])).stdout).findings).toHaveLength(4);
    await rm(baselineFile(), { force: true });
  });

  test("usage errors: no selection, unknown check, bad --fail-on", async () => {
    const none = await runCli(["audit", "jira", "--json"]);
    expect(none.exitCode).toBe(1);
    expect(JSON.parse(none.stdout).error.code).toBe("ATLCLI_ERR_USAGE");
    const bad = await runCli([...BASE, "--checks", "nope", "--json"]);
    expect(JSON.parse(bad.stdout).error.message).toContain('Unknown check "nope"');
    const failOn = await runCli([...BASE, "--fail-on", "loud", "--json"]);
    expect(JSON.parse(failOn.stdout).error.message).toContain("--fail-on must be one of");
  });

  test("feature flag off: same message as audit wiki", async () => {
    const { stdout, exitCode } = await runCli([...BASE, "--json"], { FLAG_AUDIT: "false" });
    expect(exitCode).toBe(1);
    expect(JSON.parse(stdout).error.message).toBe("Audit feature is not enabled. Run: atlcli flag set audit true --global");
  });
});

describe("audit jira with a status map", () => {
  test("a status mapped to done is searched as done, so stuck-wip gets its reference set", async () => {
    searches = [];
    const { exitCode } = await runCli([...BASE, "--checks", "stuck-wip", "--status-map", "In Progress=done", "--fail-on", "never", "--json"]);
    expect(exitCode).toBe(0);
    expect(searches).toContain('(project = "ATLCLI") AND (statusCategory != Done AND status not in (2)) ORDER BY key ASC');
    expect(searches).toContain('(project = "ATLCLI") AND (statusCategory = Done OR status in (2)) AND updated >= -90d ORDER BY key ASC');
  });
});

describe("flag parsers", () => {
  test("parseStaleDays", () => {
    expect(parseStaleDays("10,20,30")).toEqual([10, 20, 30]);
    expect(parseStaleDays("30,20,90")).toContain("ascending");
    expect(parseStaleDays("30,60")).toContain("three");
  });
});

describe("auditRulesCandidates", () => {
  test("the project file comes first; cwd null (the digest) skips it", () => {
    const withCwd = auditRulesCandidates("p", "/repo");
    expect(withCwd[0]).toBe(join("/repo", ".atlcli", "audit-rules.yaml"));
    expect(auditRulesCandidates("p", null)).toEqual(withCwd.slice(1));
  });
});
