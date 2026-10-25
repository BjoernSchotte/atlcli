/**
 * Live E2E for spec jira-content-workflows (Bundle A): markdown content in
 * Jira, `wiki page tasks-to-issues`, `jira version notes` / `sprint review`.
 *
 * Skipped during ordinary tests. Run the checked-in command:
 *
 *   bun run test:e2e:jira-content
 *
 * It drives the built CLI against Jira project ATLCLI and Confluence space
 * DOCSY only, reads results back through independent clients, and deletes
 * every owned issue, page and version in `finally`. `sprint review` needs a
 * board with sprints, which ATLCLI does not have: set
 * ATLCLI_E2E_SPRINT_ID to a sprint you may read to include its dry run.
 * No response body, tenant URL or credential is written to disk.
 */
import { describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildAuthHeader, getActiveProfile, loadConfig, resolveDeploymentType, type Profile } from "@atlcli/core";
import { ConfluenceClient, extractPageTasks, markdownToStorage } from "@atlcli/confluence";
import { JiraClient, type AdfDocument } from "@atlcli/jira";
import { resolveSweeperProfile } from "./cleanup.js";
import { createConfluencePort, createJiraPort } from "./rest-ports.js";
import {
  E2E_PROJECT_KEY,
  E2E_RUN_ID_PROPERTY,
  E2E_SPACE_KEY,
  makeE2eTitle,
  withE2eResources,
  type E2ePorts,
  type E2eResourceTracker,
} from "./resources.js";

const RUN = process.env.ATLCLI_JIRA_CONTENT_E2E === "1";
const PROFILE_NAME = process.env.ATLCLI_E2E_PROFILE?.trim() || "mayflower";
const SPRINT_ID = process.env.ATLCLI_E2E_SPRINT_ID?.trim();
const ROOT = resolve(import.meta.dir, "../../../..");
const CLI = resolve(ROOT, "dist/index.js");
const CASE_TIMEOUT_MS = 10 * 60_000;
const TASKS_LEDGER_KEY = "atlcli.tasks-to-issues";
const REPORT_PROPERTY_KEY = "atlcli.jira-report";

/** Every row of the markdown ↔ ADF mapping that round-trips unchanged. */
const ROUNDTRIP_MARKDOWN = `## Steps to reproduce

Text with **bold**, *italic*, ~~struck~~, \`code\` and a [link](https://example.com/a).

1. First
2. Second
   - nested bullet

- [ ] open task
- [x] done task

\`\`\`ts
const answer = 42;
\`\`\`

> quoted line

| Name | Value |
| --- | --- |
| a | 1 |

---

:::info
Panel body
:::

Due {date:2026-12-01}, see {jira:ATLCLI-1}.`;

interface Cli {
  stdout: string;
  stderr: string;
  exitCode: number;
}

let cachedProfile: Profile | undefined;
async function profile(): Promise<Profile> {
  if (cachedProfile) return cachedProfile;
  const config = await loadConfig();
  const resolved = resolveSweeperProfile(config, PROFILE_NAME) ?? getActiveProfile(config, PROFILE_NAME);
  if (!resolved) throw new Error(`Live E2E profile ${PROFILE_NAME} is not configured.`);
  if (resolveDeploymentType(resolved) !== "cloud") throw new Error("Jira content live E2E requires a Cloud profile.");
  cachedProfile = resolved;
  return resolved;
}

async function cli(args: string[], options: { stdin?: string; env?: Record<string, string> } = {}): Promise<Cli> {
  const child = Bun.spawn([process.execPath, CLI, ...args, "--profile", PROFILE_NAME], {
    cwd: ROOT,
    env: { ...process.env, ...options.env },
    stdin: options.stdin === undefined ? "ignore" : new Blob([options.stdin]),
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

/** Run with --json and parse; a failure throws only the CLI's own message, never raw stdout. */
async function cliJson<T = any>(args: string[], options: { stdin?: string; env?: Record<string, string> } = {}): Promise<T> {
  const result = await cli([...args, "--json"], options);
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

/** Jira search is eventually consistent: retry until `check` holds. */
async function eventually<T>(read: () => Promise<T>, check: (value: T) => boolean, label: string): Promise<T> {
  let last: T | undefined;
  for (let attempt = 0; attempt < 20; attempt++) {
    last = await read();
    if (check(last)) return last;
    await Bun.sleep(3000);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function ports(): Promise<E2ePorts & { jiraClient: JiraClient; confluenceClient: ConfluenceClient }> {
  const p = await profile();
  return {
    confluence: createConfluencePort(p),
    jira: createJiraPort(p),
    jiraClient: new JiraClient(p),
    confluenceClient: new ConfluenceClient(p),
  };
}

/** Track an issue the CLI created and stamp the ownership marker so the sweeper can find it too. */
async function adoptIssue(tracker: E2eResourceTracker, jira: E2ePorts["jira"], key: string): Promise<void> {
  tracker.trackIssue(key);
  await jira!.setIssueProperty(key, E2E_RUN_ID_PROPERTY, tracker.runId);
}

async function adoptPage(tracker: E2eResourceTracker, confluence: E2ePorts["confluence"], id: string): Promise<void> {
  tracker.trackPage(id);
  await confluence!.setPageProperty(id, E2E_RUN_ID_PROPERTY, tracker.runId);
}

function stripFrontBlock(markdown: string): string {
  return markdown.replace(/^---\n[\s\S]*?\n---\n\n?/, "").trim();
}

async function transitionToCategory(jira: JiraClient, key: string, category: "done" | "new"): Promise<void> {
  const transitions = await jira.getTransitions(key);
  const target = transitions.find((t) => t.to.statusCategory?.key === category);
  if (!target) throw new Error(`No transition into category ${category} for ${key}`);
  await jira.transitionIssue(key, { transition: { id: target.id } });
}

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "atlcli-jira-content-e2e-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe.skipIf(!RUN).serial("jira content workflows live (Bundle A)", () => {
  it("A1: markdown descriptions round-trip; comments, history, unlink, pagination, page links", async () => {
    const { jiraClient, ...p } = await ports();
    await withE2eResources(p, async (tracker) => {
      // Create through the CLI from a file, read back as markdown.
      const summary = makeE2eTitle("jira-content");
      const created = await withTempDir(async (dir) => {
        const file = join(dir, "description.md");
        await writeFile(file, ROUNDTRIP_MARKDOWN);
        return cliJson(["jira", "issue", "create", "--project", E2E_PROJECT_KEY, "--type", "Task", "--summary", summary, "--description-file", file]);
      });
      const key: string = created.issue.key;
      await adoptIssue(tracker, p.jira, key);

      const asMarkdown = await cli(["jira", "issue", "get", "--key", key, "--format", "markdown"]);
      expect(asMarkdown.exitCode).toBe(0);
      expect(asMarkdown.stdout).toContain(`key: ${key}`);
      expect(stripFrontBlock(asMarkdown.stdout)).toBe(ROUNDTRIP_MARKDOWN);

      // get --format markdown → edit → update --description-file - keeps the header out.
      await cliJson(["jira", "issue", "update", "--key", key, "--description-file", "-"], {
        stdin: asMarkdown.stdout.replace("quoted line", "edited quote"),
      });
      const edited = await cliJson(["jira", "issue", "get", "--key", key]);
      expect(edited.issue.descriptionMarkdown).toBe(ROUNDTRIP_MARKDOWN.replace("quoted line", "edited quote"));

      // Comments CRUD in markdown.
      const added = await cliJson(["jira", "issue", "comments", "add", "--key", key, "--body", "First **comment**"]);
      const commentId: string = added.comment.id;
      await cliJson(["jira", "issue", "comments", "edit", "--key", key, "--id", commentId, "--body", "Edited *comment*"]);
      const listed = await cliJson(["jira", "issue", "comments", "list", "--key", key]);
      expect(listed.comments.map((c: { body: string }) => c.body)).toEqual(["Edited *comment*"]);
      await cliJson(["jira", "issue", "comments", "delete", "--key", key, "--id", commentId, "--confirm"]);
      expect((await cliJson(["jira", "issue", "comments", "list", "--key", key])).total).toBe(0);

      // History shows a summary change.
      const renamed = makeE2eTitle("jira-content", new Date(Date.now() + 1000));
      await cliJson(["jira", "issue", "update", "--key", key, "--summary", renamed]);
      const history = await cliJson(["jira", "issue", "history", "--key", key, "--field", "summary"]);
      expect(history.history[0]).toMatchObject({ field: "summary", from: summary, to: renamed });

      // Link two issues, unlink by key pair.
      const other = await tracker.createIssue("jira-content-link");
      await cliJson(["jira", "issue", "link", "--from", key, "--to", other.key, "--type", "Relates"]);
      const unlinked = await cliJson(["jira", "issue", "unlink", "--from", key, "--to", other.key, "--confirm"]);
      expect(unlinked.unlinked).toMatchObject({ from: key, to: other.key });
      const links = (await jiraClient.getIssue(key, { fields: ["issuelinks"] })).fields.issuelinks ?? [];
      expect(links).toHaveLength(0);

      // Search paginates past --limit.
      const third = await tracker.createIssue("jira-content-page", { now: new Date(Date.now() + 2000) });
      const jql = `project = ${E2E_PROJECT_KEY} AND key in (${key}, ${other.key}, ${third.key})`;
      // Wait until the index has all three; a full page carries a next token even when nothing follows.
      const all = await eventually(
        () => cliJson(["jira", "search", "--jql", jql, "--all-results"]),
        (r) => r.issues.length === 3,
        "search index"
      );
      expect(all.hasMore).toBe(false);
      const page = await cliJson(["jira", "search", "--jql", jql, "--limit", "2"]);
      expect(page.issues).toHaveLength(2);
      expect(page.hasMore).toBe(true);
      expect(page.nextPageToken).toBeTruthy();

      // Link a Confluence page with a comment; the comment renders as a real link.
      const docPage = await tracker.createPage("jira-content-linked");
      await cliJson(["jira", "issue", "link-page", "--key", key, "--page", docPage.id, "--comment", "Spec page"]);
      const pages = await cliJson(["jira", "issue", "pages", "--key", key]);
      expect(JSON.stringify(pages)).toContain(docPage.id);
      const comments = await cliJson(["jira", "issue", "comments", "list", "--key", key]);
      expect(comments.comments[0].body).not.toContain("|");
      expect(comments.comments[0].body).toContain(`](`);
    });
  }, CASE_TIMEOUT_MS);

  it("A1: a Jira-made image (media node) survives a markdown edit", async () => {
    const { jiraClient, ...p } = await ports();
    const prof = await profile();
    const base = prof.baseUrl.replace(/\/+$/, "");
    const headers = { Authorization: buildAuthHeader(prof), Accept: "application/json" };
    await withE2eResources(p, async (tracker) => {
      const { key } = await tracker.createIssue("jira-content-media");
      // A 1×1 PNG, attached, then referenced from wiki markup through API v2: Jira itself builds the media node.
      const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
      const form = new FormData();
      form.append("file", new Blob([png], { type: "image/png" }), "dot.png");
      const upload = await fetch(`${base}/rest/api/3/issue/${key}/attachments`, {
        method: "POST",
        headers: { Authorization: headers.Authorization, "X-Atlassian-Token": "no-check" },
        body: form,
      });
      expect(upload.ok).toBe(true);
      const put = await fetch(`${base}/rest/api/2/issue/${key}`, {
        method: "PUT",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ fields: { description: "Before the image.\n\n!dot.png|thumbnail!\n\nAfter the image." } }),
      });
      expect(put.ok).toBe(true);

      const mediaOf = async () => {
        const doc = (await jiraClient.getIssue(key, { fields: ["description"] })).fields.description as AdfDocument;
        return JSON.stringify(doc.content.find((n) => n.type === "mediaSingle"));
      };
      const before = await mediaOf();
      expect(before).toContain('"type":"file"');

      const markdown = await cli(["jira", "issue", "get", "--key", key, "--format", "markdown"]);
      expect(markdown.stdout).toContain("<!--adf:");
      await cliJson(["jira", "issue", "update", "--key", key, "--description-file", "-"], {
        stdin: markdown.stdout.replace("After the image.", "After the **edited** image."),
      });
      expect(await mediaOf()).toBe(before);
      const after = await cliJson(["jira", "issue", "get", "--key", key]);
      expect(after.issue.descriptionMarkdown).toContain("After the **edited** image.");
    });
  }, CASE_TIMEOUT_MS);

  it("A1: CSV import with --map-field and multiline cells; bulk edit by --issues", async () => {
    const { jiraClient, ...p } = await ports();
    await withE2eResources(p, async (tracker) => {
      const summaries = [makeE2eTitle("jira-import"), makeE2eTitle("jira-import", new Date(Date.now() + 1000))];
      const csv = [
        "Title,Kind,Body,labels",
        `${summaries[0]},Task,"First line with **bold**\n\n- item one\n- item two","e2e-x,e2e-y"`,
        `${summaries[1]},Task,"Quote ""inside"" a cell",e2e-z`,
        "",
      ].join("\n");
      const result = await withTempDir(async (dir) => {
        const file = join(dir, "issues.csv");
        await writeFile(file, csv);
        return cliJson([
          "jira", "import", "--file", file, "--project", E2E_PROJECT_KEY,
          "--map-field", "Title=summary", "--map-field", "Kind=issuetype", "--map-field", "Body=description",
        ]);
      });
      const keys: string[] = result.issues.filter((i: { key?: string }) => i.key).map((i: { key: string }) => i.key);
      for (const key of keys) await adoptIssue(tracker, p.jira, key);
      expect(result).toMatchObject({ created: 2, failed: 0 });
      expect(keys).toHaveLength(2);

      const first = await cliJson(["jira", "issue", "get", "--key", keys[0]!]);
      expect(first.issue.summary ?? first.issue.fields?.summary).toBe(summaries[0]);
      expect(first.issue.descriptionMarkdown).toBe("First line with **bold**\n\n- item one\n- item two");
      const second = await cliJson(["jira", "issue", "get", "--key", keys[1]!]);
      expect(second.issue.descriptionMarkdown).toBe('Quote "inside" a cell');
      expect((await jiraClient.getIssue(keys[0]!, { fields: ["labels"] })).fields.labels?.sort()).toEqual(["e2e-x", "e2e-y"]);

      // bulk edit --set labels=a,b on an explicit key list replaces all labels.
      const bulk = await cliJson(["jira", "bulk", "edit", "--issues", keys.join(","), "--set", "labels=e2e-a,e2e-b"]);
      expect(bulk.result.failed ?? 0).toBe(0);
      for (const key of keys) {
        expect((await jiraClient.getIssue(key, { fields: ["labels"] })).fields.labels?.sort()).toEqual(["e2e-a", "e2e-b"]);
      }
    });
  }, CASE_TIMEOUT_MS);

  it("A2: tasks-to-issues is idempotent across reruns and docs pull/push, and --sync follows Jira", async () => {
    const { jiraClient, confluenceClient, ...p } = await ports();
    const me = await jiraClient.getCurrentUser();
    await withE2eResources(p, async (tracker) => {
      const linked = await tracker.createIssue("jira-tasks-linked");
      const taskTitle = makeE2eTitle("jira-tasks");
      const markdown = [
        `- [ ] ${taskTitle} @[${me.displayName}](${me.accountId}) {date:2026-12-01}`,
        `- [x] ${makeE2eTitle("jira-tasks-done")}`,
        `- [ ] {jira:${linked.key}} already tracked`,
      ].join("\n");
      const page = await tracker.createPage("jira-tasks-page", { storage: markdownToStorage(markdown) });
      const versionOf = async () => (await confluenceClient.getPage(page.id)).version;
      const tasksOf = async () => extractPageTasks((await confluenceClient.getPage(page.id)).storage);
      const run = (...extra: string[]) =>
        cliJson(["wiki", "page", "tasks-to-issues", "--id", page.id, "--project", E2E_PROJECT_KEY, ...extra]);

      const v0 = await versionOf();
      const dry = await run();
      expect(dry.summary).toMatchObject({ create: 1, skipped: 2, created: 0 });
      expect(await versionOf()).toBe(v0);

      const real = await run("--confirm");
      expect(real.summary).toMatchObject({ create: 1, created: 1, failed: 0 });
      const key: string = real.created[0].key;
      await adoptIssue(tracker, p.jira, key);

      const issue = await jiraClient.getIssue(key, { fields: ["summary", "assignee", "duedate"] });
      expect(issue.fields.summary).toBe(taskTitle);
      expect(issue.fields.assignee?.accountId).toBe(me.accountId);
      expect(issue.fields.duedate).toBe("2026-12-01");
      expect(JSON.stringify(await cliJson(["jira", "issue", "pages", "--key", key]))).toContain(page.id);
      expect((await tasksOf())[0]!.linkedIssueKeys).toContain(key);
      expect(await confluenceClient.getPagePropertyByKey(page.id, TASKS_LEDGER_KEY)).toMatchObject({ v: 1, issues: { [key]: {} } });

      expect((await run("--confirm")).summary.created).toBe(0);

      // A docs pull → edit → push round trip must not lose the markers.
      await withTempDir(async (dir) => {
        await cliJson(["wiki", "docs", "init", dir, "--page-id", page.id]);
        await cliJson(["wiki", "docs", "pull", dir]);
        const files = await Array.fromAsync(new Bun.Glob("**/*.md").scan({ cwd: dir }));
        expect(files).toHaveLength(1);
        const file = join(dir, files[0]!);
        await writeFile(file, `${await readFile(file, "utf8")}\nEdited locally.\n`);
        await cliJson(["wiki", "docs", "push", dir]);
      });
      expect((await run("--confirm")).summary.created).toBe(0);

      // --sync: done ticks, reopen unticks, no change leaves the page alone.
      const sync = () => cliJson(["wiki", "page", "tasks-to-issues", "--id", page.id, "--sync", "--confirm"]);
      const taskStatus = async () => (await tasksOf()).find((t) => t.linkedIssueKeys.includes(key))!.status;
      await transitionToCategory(jiraClient, key, "done");
      expect((await sync()).summary.statusChanges).toBe(1);
      expect(await taskStatus()).toBe("complete");
      await transitionToCategory(jiraClient, key, "new");
      expect((await sync()).summary.statusChanges).toBe(1);
      expect(await taskStatus()).toBe("incomplete");
      const v1 = await versionOf();
      expect((await sync()).summary.statusChanges).toBe(0);
      expect(await versionOf()).toBe(v1);
    });
  }, CASE_TIMEOUT_MS);

  it("A3: version notes create/unchanged/update, by epic, custom template, conflict, PDF and DOCX export", async () => {
    const { jiraClient, confluenceClient, ...p } = await ports();
    const project = await jiraClient.getProject(E2E_PROJECT_KEY);
    const version = await jiraClient.createVersion({ projectId: project.id, name: makeE2eTitle("jira-notes-version") });
    try {
      await withE2eResources(p, async (tracker) => {
        const epic = await tracker.createIssue("jira-notes-epic", { issueType: "Epic" });
        const a = await tracker.createIssue("jira-notes-a");
        const b = await tracker.createIssue("jira-notes-b", { now: new Date(Date.now() + 1000) });
        for (const key of [a.key, b.key]) {
          await jiraClient.updateIssue(key, { fields: { fixVersions: [{ id: version.id }], parent: { key: epic.key } } as never });
        }
        await transitionToCategory(jiraClient, a.key, "done");
        const notes = (title: string, ...extra: string[]) =>
          cliJson(["jira", "version", "notes", version.id, "--space", E2E_SPACE_KEY, "--title", title, ...extra]);

        // Data reaches the report through JQL; wait until the index has both issues.
        const title = makeE2eTitle("jira-notes");
        const dry = await eventually(() => notes(title, "--dry-run"), (r) => r.issues === 2, "version issues indexed");
        expect(dry).toMatchObject({ dryRun: true, action: "create" });
        expect(dry.markdown).toContain(a.summary);

        const created = await notes(title);
        await adoptPage(tracker, p.confluence, created.pageId);
        expect(created.action).toBe("create");
        expect(await confluenceClient.getPagePropertyByKey(created.pageId, REPORT_PROPERTY_KEY)).toMatchObject({ kind: "release", sourceId: version.id });
        expect((await notes(title)).action).toBe("unchanged");

        await jiraClient.updateIssue(b.key, { fields: { summary: makeE2eTitle("jira-notes-b", new Date(Date.now() + 5000)) } });
        const updated = await eventually(() => notes(title), (r) => r.action === "update", "changed issue indexed");
        expect(updated.version).toBe(created.version + 1);

        // Grouped by epic.
        const byEpic = await notes(makeE2eTitle("jira-notes-epic", new Date(Date.now() + 1000)), "--group-by", "epic");
        await adoptPage(tracker, p.confluence, byEpic.pageId);
        expect((await confluenceClient.getPage(byEpic.pageId)).storage).toContain(epic.summary);

        // A user template with a loop over the data model and a --var.
        await withTempDir(async (templates) => {
          // ATLCLI_TEMPLATES_DIR/global holds global-level templates.
          await mkdir(join(templates, "global"));
          await writeFile(
            join(templates, "global", "e2e-notes.md"),
            "---\nname: e2e-notes\ndescription: E2E\n---\nOwner: {{owner}}\n\n{% for issue in issues %}\n- {{ issue.key }} {% if issue.done %}done{% else %}open{% endif %}\n{% endfor %}\n"
          );
          const custom = await cliJson(
            ["jira", "version", "notes", version.id, "--space", E2E_SPACE_KEY, "--title", makeE2eTitle("jira-notes-custom"), "--template", "e2e-notes", "--var", "owner=E2E Team", "--dry-run"],
            { env: { ATLCLI_TEMPLATES_DIR: templates } }
          );
          expect(custom.template).toMatchObject({ name: "e2e-notes" });
          expect(custom.markdown).toContain("Owner: E2E Team");
          expect(custom.markdown).toContain(`- ${a.key} done`);
          expect(custom.markdown).toContain(`- ${b.key} open`);
        });

        // A same-title page atlcli did not create is refused, then taken over with --force.
        const foreign = await tracker.createPage("jira-notes-foreign", { now: new Date(Date.now() + 3000) });
        const refused = await cli(["jira", "version", "notes", version.id, "--space", E2E_SPACE_KEY, "--title", foreign.title, "--json"]);
        expect(refused.exitCode).not.toBe(0);
        expect(refused.stdout + refused.stderr).toContain("--force");
        const forced = await notes(foreign.title, "--force");
        expect(forced).toMatchObject({ action: "update", pageId: foreign.id });

        // Export the existing page (unchanged) to PDF and DOCX.
        await withTempDir(async (dir) => {
          for (const ext of ["pdf", "docx"]) {
            const out = join(dir, `notes.${ext}`);
            const run = await cli(["jira", "version", "notes", version.id, "--space", E2E_SPACE_KEY, "--title", title, "--export", out]);
            expect(run.exitCode).toBe(0);
            expect((await stat(out)).size).toBeGreaterThan(1000);
          }
        });
      });
    } finally {
      await jiraClient.deleteVersion(version.id);
    }
  }, CASE_TIMEOUT_MS);

  it.skipIf(!SPRINT_ID)("A3: sprint review renders a dry run for an existing sprint", async () => {
    const review = await cliJson(["jira", "sprint", "review", SPRINT_ID!, "--space", E2E_SPACE_KEY, "--dry-run"]);
    expect(review).toMatchObject({ dryRun: true });
    expect(review.markdown.length).toBeGreaterThan(0);
  }, CASE_TIMEOUT_MS);
});
