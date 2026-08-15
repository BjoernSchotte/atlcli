/**
 * Regression: `jira issue attach` (issue #90) documented a positional issue
 * key, several files per call and `--comment`, none of which it implemented.
 * `attach PROJ-123 a.png` failed with `File not found: PROJ-123`, a glob
 * uploaded its first match and dropped the rest without a word, and `--comment`
 * was read by no one.
 *
 * Like the #8 tests next door, these drive the real CLI in its own process (the
 * handlers call `process.exit`) against a local Bun HTTP server standing in for
 * Jira — no fetch mocking, per repo rules.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../index.ts", import.meta.url));
const ISSUE = "ATLCLI-1";
const PROFILE = "mayflower";

/** Uploads the stub server accepted, in order. */
let uploaded: Array<{ filename: string; size: number }> = [];
/** Comment texts the stub server accepted. */
let comments: string[] = [];
/** Filenames the server rejects with a 500, to exercise partial failure. */
let rejectFilenames: string[] = [];

let server: ReturnType<typeof Bun.serve>;
let home: string;
let files: string;
let nextId = 20001;

beforeAll(async () => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const { pathname } = new URL(req.url);

      // Non-cloud base URL ⇒ the client talks v2.
      if (req.method === "POST" && pathname === `/rest/api/2/issue/${ISSUE}/attachments`) {
        const form = await req.formData();
        const file = form.get("file");
        if (!(file instanceof Blob)) return new Response("no file", { status: 400 });
        const filename = (file as File).name;
        if (rejectFilenames.includes(filename)) {
          return new Response("upload rejected", { status: 500 });
        }
        const size = file.size;
        uploaded.push({ filename, size });
        const id = String(nextId++);
        return Response.json([
          {
            id,
            filename,
            author: { accountId: "acc-1", displayName: "Alice" },
            created: "2026-07-25T10:00:00.000+0000",
            size,
            mimeType: "application/octet-stream",
            content: `${server.url.origin}/rest/api/2/attachment/content/${id}`,
          },
        ]);
      }

      if (req.method === "POST" && pathname === `/rest/api/2/issue/${ISSUE}/comment`) {
        const body = (await req.json()) as {
          body?: { content?: Array<{ content?: Array<{ text?: string }> }> };
        };
        const text = body.body?.content?.[0]?.content?.[0]?.text ?? "";
        comments.push(text);
        return Response.json({ id: "30001", body: body.body });
      }

      return new Response(JSON.stringify({ message: `stub: no route for ${pathname}` }), {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    },
  });

  home = await mkdtemp(join(tmpdir(), "atlcli-jira-attach-"));
  await mkdir(join(home, ".atlcli"), { recursive: true });
  await writeFile(
    join(home, ".atlcli", "config.json"),
    JSON.stringify(
      {
        currentProfile: PROFILE,
        profiles: {
          [PROFILE]: {
            name: PROFILE,
            baseUrl: server.url.origin,
            deploymentType: "data-center",
            auth: { type: "bearer" },
          },
        },
      },
      null,
      2
    )
  );

  files = join(home, "files");
  await mkdir(files, { recursive: true });
  await writeFile(join(files, "a.png"), "aaaa");
  await writeFile(join(files, "b.pdf"), "bbbbbb");
  await writeFile(join(files, "logs.zip"), "cc");
  await writeFile(join(files, "boom.bin"), "dd");
});

afterAll(async () => {
  server?.stop(true);
  if (home) await rm(home, { recursive: true, force: true });
});

beforeEach(() => {
  uploaded = [];
  comments = [];
  rejectFilenames = [];
});

async function runCli(args: string[]): Promise<{
  stdout: string;
  stderr: string;
  exitCode: number;
}> {
  const proc = Bun.spawn(
    [
      process.execPath,
      // Workspace packages only resolve to src/ under this condition.
      "--conditions=development",
      "run",
      CLI,
      ...args,
    ],
    {
      cwd: files,
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        ATLCLI_API_TOKEN: "stub-token",
        ATLCLI_DISABLE_UPDATE_CHECK: "1",
      },
      stdout: "pipe",
      stderr: "pipe",
    }
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
}

describe("jira issue attach", () => {
  it("takes the issue key positionally", async () => {
    // The bug: `PROJ-123` was read as the file path → "File not found: ATLCLI-1".
    const { stdout, stderr, exitCode } = await runCli(["jira", "issue", "attach", ISSUE, "a.png"]);

    expect(stderr).not.toContain("File not found");
    expect(exitCode).toBe(0);
    expect(uploaded).toEqual([{ filename: "a.png", size: 4 }]);
    expect(stdout).toContain("Attached a.png");
  }, 30_000);

  it("still accepts --key", async () => {
    const { exitCode } = await runCli(["jira", "issue", "attach", "--key", ISSUE, "a.png"]);

    expect(exitCode).toBe(0);
    expect(uploaded).toEqual([{ filename: "a.png", size: 4 }]);
  }, 30_000);

  it("uploads every file instead of silently dropping all but the first", async () => {
    const { exitCode } = await runCli([
      "jira",
      "issue",
      "attach",
      ISSUE,
      "a.png",
      "b.pdf",
      "logs.zip",
    ]);

    expect(exitCode).toBe(0);
    expect(uploaded.map((u) => u.filename)).toEqual(["a.png", "b.pdf", "logs.zip"]);
  }, 30_000);

  it("lists every upload in --json", async () => {
    const { stdout, exitCode } = await runCli([
      "jira",
      "issue",
      "attach",
      ISSUE,
      "a.png",
      "b.pdf",
      "--json",
    ]);

    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.schemaVersion).toBe("1");
    expect(parsed.issue).toBe(ISSUE);
    expect(parsed.total).toBe(2);
    expect(parsed.attached.map((a: { filename: string }) => a.filename)).toEqual([
      "a.png",
      "b.pdf",
    ]);
    expect(parsed.attached[0]).toMatchObject({ path: "a.png", size: 4 });
  }, 30_000);

  it("posts --comment after the upload", async () => {
    const { stdout, exitCode } = await runCli([
      "jira",
      "issue",
      "attach",
      ISSUE,
      "a.png",
      "--comment",
      "Error logs from production",
      "--json",
    ]);

    expect(exitCode).toBe(0);
    // The bug: the flag was never read, so the comment never appeared.
    expect(comments).toEqual(["Error logs from production"]);
    expect(JSON.parse(stdout).comment).toEqual({ id: "30001" });
  }, 30_000);

  it("rejects --comment without text rather than ignoring it", async () => {
    const { stdout, exitCode } = await runCli([
      "jira",
      "issue",
      "attach",
      ISSUE,
      "a.png",
      "--comment",
      "--json",
    ]);

    expect(exitCode).not.toBe(0);
    expect(JSON.parse(stdout).error.code).toBe("ATLCLI_ERR_USAGE");
    expect(uploaded).toEqual([]);
  }, 30_000);

  it("uploads the healthy files and exits non-zero on a partial failure", async () => {
    rejectFilenames = ["boom.bin"];
    const { stdout, exitCode } = await runCli([
      "jira",
      "issue",
      "attach",
      ISSUE,
      "a.png",
      "boom.bin",
      "b.pdf",
      "--json",
    ]);

    expect(exitCode).not.toBe(0);
    expect(uploaded.map((u) => u.filename)).toEqual(["a.png", "b.pdf"]);
    const parsed = JSON.parse(stdout);
    expect(parsed.total).toBe(2);
    expect(parsed.failed).toHaveLength(1);
    expect(parsed.failed[0].path).toBe("boom.bin");
  }, 60_000);

  it("checks every file up front, so nothing uploads when one path is wrong", async () => {
    const { stdout, exitCode } = await runCli([
      "jira",
      "issue",
      "attach",
      ISSUE,
      "a.png",
      "nope.txt",
      "--json",
    ]);

    expect(exitCode).not.toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.error.code).toBe("ATLCLI_ERR_USAGE");
    expect(parsed.error.details.files).toEqual(["nope.txt"]);
    expect(uploaded).toEqual([]);
  }, 30_000);

  it("says the key is missing instead of blaming the file", async () => {
    const { stdout, exitCode } = await runCli(["jira", "issue", "attach", "a.png", "--json"]);

    expect(exitCode).not.toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.error.code).toBe("ATLCLI_ERR_USAGE");
    expect(parsed.error.message).toContain("is not an issue key");
  }, 30_000);

  it("fails when no file is given", async () => {
    const { stdout, exitCode } = await runCli(["jira", "issue", "attach", ISSUE, "--json"]);

    expect(exitCode).not.toBe(0);
    expect(JSON.parse(stdout).error.code).toBe("ATLCLI_ERR_USAGE");
  }, 30_000);
});
