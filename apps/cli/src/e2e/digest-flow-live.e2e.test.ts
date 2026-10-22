/**
 * Live E2E for spec digest-flow-metrics (Bundle B): `atlcli digest`,
 * `jira analyze flow | aging | cfd` and `audit jira`.
 *
 * Skipped during ordinary tests. Run the checked-in command:
 *
 *   bun run test:e2e:digest-flow
 *
 * It drives the built CLI against Jira project ATLCLI and Confluence space
 * DOCSY only and deletes every owned issue and page in `finally`. One account
 * plays both sides, so the digest runs with --include-own; foreign-author
 * filtering is covered by fixtures. With ANTHROPIC_API_KEY set, --summarize
 * is exercised too. No response body, tenant URL or credential is written to
 * disk.
 */
import { describe, expect, it } from "bun:test";
import { cp, mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { getActiveProfile, loadConfig, resolveDeploymentType, type Profile } from "@atlcli/core";
import { ConfluenceClient } from "@atlcli/confluence";
import { JiraClient } from "@atlcli/jira";
import { resolveSweeperProfile } from "./cleanup.js";
import { createConfluencePort, createJiraPort } from "./rest-ports.js";
import { E2E_PROJECT_KEY, withE2eResources } from "./resources.js";

const RUN = process.env.ATLCLI_DIGEST_FLOW_E2E === "1";
const PROFILE_NAME = process.env.ATLCLI_E2E_PROFILE?.trim() || "mayflower";
const ROOT = resolve(import.meta.dir, "../../../..");
const CLI = resolve(ROOT, "dist/index.js");
const CASE_TIMEOUT_MS = 10 * 60_000;

async function profile(): Promise<Profile> {
  const config = await loadConfig();
  const resolved = resolveSweeperProfile(config, PROFILE_NAME) ?? getActiveProfile(config, PROFILE_NAME);
  if (!resolved) throw new Error(`Live E2E profile ${PROFILE_NAME} is not configured.`);
  if (resolveDeploymentType(resolved) !== "cloud") throw new Error("Digest/flow live E2E requires a Cloud profile.");
  return resolved;
}

async function cli(args: string[], env: Record<string, string> = {}) {
  const child = Bun.spawn([process.execPath, CLI, ...args, "--profile", PROFILE_NAME], {
    cwd: ROOT,
    env: { ...process.env, FLAG_AUDIT: "true", ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, exitCode };
}

async function cliJson<T = any>(args: string[], env: Record<string, string> = {}): Promise<T> {
  const result = await cli([...args, "--json"], env);
  if (result.exitCode !== 0) {
    let message = result.stderr.trim();
    try {
      message = JSON.parse(result.stdout).error?.message ?? message;
    } catch {
      // keep stderr
    }
    throw new Error(`CLI ${args.slice(0, 3).join(" ")} failed (${result.exitCode}): ${message}`);
  }
  return JSON.parse(result.stdout) as T;
}

/** Search indexes lag writes: retry until `check` holds. */
async function eventually<T>(read: () => Promise<T>, check: (value: T) => boolean, label: string): Promise<T> {
  let last: T | undefined;
  for (let attempt = 0; attempt < 30; attempt++) {
    last = await read();
    if (check(last)) return last;
    await Bun.sleep(3000);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function transitionToCategory(jira: JiraClient, key: string, category: "indeterminate" | "done"): Promise<void> {
  const transitions = await jira.getTransitions(key);
  const target = transitions.find((t) => t.to.statusCategory?.key === category);
  if (!target) throw new Error(`No transition into category ${category} for ${key}`);
  await jira.transitionIssue(key, { transition: { id: target.id } });
}

describe.skipIf(!RUN).serial("digest, flow metrics and audit jira live (Bundle B)", () => {
  it("digest sees new issues, a mention and comments; flow, aging, cfd and audit see the issues", async () => {
    const prof = await profile();
    const jira = new JiraClient(prof);
    const confluence = new ConfluenceClient(prof);
    const ports = { confluence: createConfluencePort(prof), jira: createJiraPort(prof) };
    await withE2eResources(ports, async (tracker) => {
      const me = await jira.getCurrentUser();
      const confMe = await confluence.getCurrentUser();

      // A: in progress. B: in progress, then done. C: stays to do. A and C assigned to me.
      const a = await tracker.createIssue("digest-flow-a");
      const b = await tracker.createIssue("digest-flow-b");
      const c = await tracker.createIssue("digest-flow-c");
      if (!me.accountId) throw new Error("The E2E account has no Jira accountId.");
      await jira.assignIssue(a.key, { accountId: me.accountId });
      await jira.assignIssue(c.key, { accountId: me.accountId });
      await transitionToCategory(jira, a.key, "indeterminate");
      await transitionToCategory(jira, b.key, "indeterminate");
      await transitionToCategory(jira, b.key, "done");

      // A DOCSY page mentioning me, with a footer and an inline comment.
      const page = await tracker.createPage("digest-flow", {
        storage: `<p>Review needed by <ac:link><ri:user ri:account-id="${confMe.accountId}" /></ac:link> on the anchor text.</p>`,
      });
      const footer = await cliJson(["wiki", "page", "comments", "add", "--id", page.id, "Footer remark"]);
      const inline = await cliJson(["wiki", "page", "comments", "add-inline", "--id", page.id, "--selection", "anchor text", "Inline remark"]);

      const keys = [a.key, b.key, c.key];
      const digest = await eventually(
        () => cliJson(["digest", "--since", "30m", "--include-own", "--no-mark"]),
        (d) =>
          keys.every((k) => d.jira.changed.some((i: { key: string }) => i.key === k)) &&
          d.confluence.comments.some((x: { id: string }) => x.id === String(footer.comment.id)) &&
          d.confluence.openInline.some((x: { id: string }) => x.id === String(inline.comment.id)),
        "digest search index"
      );
      // The account has more open work than one section shows: run the digest's own
      // "waiting" query narrowed to the three issues.
      const waitingJql = String(digest.queries["jira.waiting"]).replace(/ ORDER BY .*$/, "");
      const waiting = (await jira.search(`${waitingJql} AND key in (${[a.key, b.key, c.key].join(", ")})`, { fields: ["summary"] })).issues
        .map((i) => i.key)
        .sort();
      expect(waiting).toEqual([a.key, c.key].sort());
      const changedA = digest.jira.changed.find((i: { key: string }) => i.key === a.key);
      expect(changedA.changes.some((ch: { field: string; you: boolean }) => ch.field === "status" && ch.you)).toBe(true);
      // A self-mention is not always indexed as a mention; the page is then listed under your pages.
      const mentioned = [...digest.confluence.mentions, ...digest.confluence.myPagesEdited].some((p: { id: string }) => p.id === page.id);
      expect(mentioned).toBe(true);

      // Without --include-own, the user's own comments and edits are filtered out.
      const filtered = await cliJson(["digest", "--since", "30m", "--no-mark"]);
      expect(filtered.confluence.comments.some((x: { id: string }) => x.id === String(footer.comment.id))).toBe(false);
      expect(filtered.jira.changed.some((i: { key: string }) => i.key === a.key)).toBe(false);

      // The marker: --no-mark leaves it alone; a default run in a copied HOME creates it.
      const stateFile = join(homedir(), ".atlcli", "profiles", PROFILE_NAME, "digest-state.json");
      const before = await readFile(stateFile, "utf8").catch(() => undefined);
      await cliJson(["digest", "--since", "30m", "--no-mark"]);
      expect(await readFile(stateFile, "utf8").catch(() => undefined)).toBe(before);
      const tempHome = await mkdtemp(join(tmpdir(), "atlcli-digest-e2e-"));
      try {
        await mkdir(join(tempHome, ".atlcli"), { recursive: true });
        await cp(join(homedir(), ".atlcli", "config.json"), join(tempHome, ".atlcli", "config.json"));
        await cliJson(["digest"], { HOME: tempHome, USERPROFILE: tempHome });
        const state = JSON.parse(await readFile(join(tempHome, ".atlcli", "profiles", PROFILE_NAME, "digest-state.json"), "utf8"));
        expect(state.schemaVersion).toBe(2);
        expect(state.jira?.lastRunAt ?? state.confluence?.lastRunAt).toBeTruthy();
      } finally {
        await rm(tempHome, { recursive: true, force: true });
      }

      // Flow metrics over exactly these three issues.
      const jql = `project = ${E2E_PROJECT_KEY} AND key in (${keys.join(", ")})`;
      const flow = await eventually(
        () => cliJson(["jira", "analyze", "flow", "--jql", jql, "--since", "1d"]),
        (f) => f.metrics.cycleTime.count === 1,
        "flow search index"
      );
      expect(flow.diagnostics.skippedWip).toBe(0);
      expect(flow.metrics.wip.count).toBe(1);
      expect(flow.metrics.completed.map((x: { key: string }) => x.key)).toEqual([b.key]);
      const aging = await cli(["jira", "analyze", "aging", "--jql", jql, "--since", "1d", "--csv"]);
      expect(aging.stdout).toContain(`${a.key},`);
      const cfd = await cliJson(["jira", "analyze", "cfd", "--jql", jql, "--since", "1d", "--group-by", "category"]);
      const today = cfd.days[cfd.days.length - 1].counts as Record<string, number>;
      expect(Object.values(today).reduce((n, v) => n + v, 0)).toBe(3);

      // audit jira: A becomes unassigned work in progress.
      await jira.assignIssue(a.key, null);
      const audit = await eventually(
        () => cliJson(["audit", "jira", "--jql", jql, "--checks", "unassigned-wip,hygiene"]),
        (r) => r.findings.some((f: { rule: string; key: string }) => f.rule === "unassigned-wip" && f.key === a.key),
        "audit search index"
      );
      const versions = await jira.getProjectVersions(E2E_PROJECT_KEY);
      const doneWithoutVersion = audit.findings.some((f: { rule: string; key: string }) => f.rule === "done-without-version" && f.key === b.key);
      expect(doneWithoutVersion).toBe(versions.length > 0);

      // Optional: --summarize with a real key.
      if (process.env.ANTHROPIC_API_KEY) {
        const summarized = await cliJson(["digest", "--since", "30m", "--summarize", "--no-mark", "--include-own"]);
        expect(summarized.summary?.length ?? 0).toBeGreaterThan(0);
      }
    });
  }, CASE_TIMEOUT_MS);
});
