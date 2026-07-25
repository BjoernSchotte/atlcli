/**
 * Regression: `jira issue attachments` and `jira issue attachment download`
 * were documented (docs/jira/attachments.md) but never wired into the CLI
 * (issue #8). `handleIssue()` fell through to `default:`, printed the help text
 * and exited 0 — so in a script the missing command looked like a successful
 * no-op rather than an error.
 *
 * These tests drive the real CLI in its own process (the handlers call
 * `process.exit`) against a local Bun HTTP server standing in for Jira — no
 * fetch mocking, per repo rules.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../index.ts", import.meta.url));
const ISSUE = "ATLCLI-1";
const PROFILE = "mayflower";

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const LOG_BYTES = new TextEncoder().encode("boom\n");

type Fixture = {
  id: string;
  filename: string;
  size: number;
  mimeType: string;
  bytes: Uint8Array;
};

/**
 * Two attachments deliberately share `screenshot.png`: Jira does not enforce
 * unique names on an issue, and the download must not let one silently
 * overwrite the other.
 */
let attachments: Fixture[] = [];
/** Attachment ids the CLI asked the server to delete. */
let deleted: string[] = [];

let server: ReturnType<typeof Bun.serve>;
let home: string;

const meta = (a: Fixture) => ({
  id: a.id,
  filename: a.filename,
  author: { accountId: "acc-1", displayName: "Alice", emailAddress: "alice@example.com" },
  created: "2026-01-14T10:00:00.000+0000",
  size: a.size,
  mimeType: a.mimeType,
  content: `${server.url.origin}/rest/api/2/attachment/content/${a.id}`,
});

beforeAll(async () => {
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const { pathname } = new URL(req.url);

      // Non-cloud base URL ⇒ the client talks v2.
      if (req.method === "GET" && pathname === `/rest/api/2/issue/${ISSUE}`) {
        return Response.json({
          id: "10000",
          key: ISSUE,
          fields: { attachment: attachments.map(meta) },
        });
      }

      const content = /^\/rest\/api\/2\/attachment\/content\/(\d+)$/.exec(pathname);
      if (req.method === "GET" && content) {
        const found = attachments.find((a) => a.id === content[1]);
        if (!found) return new Response("not found", { status: 404 });
        return new Response(Uint8Array.from(found.bytes), {
          headers: { "content-type": found.mimeType },
        });
      }

      const single = /^\/rest\/api\/2\/attachment\/(\d+)$/.exec(pathname);
      if (single) {
        const found = attachments.find((a) => a.id === single[1]);
        if (req.method === "DELETE") {
          if (!found) return new Response("not found", { status: 404 });
          deleted.push(single[1]);
          return new Response(null, { status: 204 });
        }
        if (req.method === "GET") {
          if (!found) {
            return new Response(JSON.stringify({ errorMessages: ["Attachment not found"] }), {
              status: 404,
              headers: { "content-type": "application/json" },
            });
          }
          return Response.json(meta(found));
        }
      }

      return new Response(JSON.stringify({ message: `stub: no route for ${pathname}` }), {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    },
  });

  home = await mkdtemp(join(tmpdir(), "atlcli-jira-attachments-"));
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
});

afterAll(async () => {
  server?.stop(true);
  if (home) await rm(home, { recursive: true, force: true });
});

beforeEach(async () => {
  attachments = [
    { id: "10001", filename: "screenshot.png", size: 250880, mimeType: "image/png", bytes: PNG_BYTES },
    { id: "10002", filename: "debug.log", size: 12288, mimeType: "text/plain", bytes: LOG_BYTES },
  ];
  deleted = [];
  await rm(join(home, "out"), { recursive: true, force: true });
});

async function runCli(
  args: string[],
  cwd: string = home
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
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
      cwd,
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

describe("jira issue attachments", () => {
  it("lists the attachments instead of printing the issue help", async () => {
    const { stdout, exitCode } = await runCli(["jira", "issue", "attachments", ISSUE]);

    expect(exitCode).toBe(0);
    // The bug: this used to be the `jira issue` help text, exit code 0.
    expect(stdout).not.toContain("atlcli jira issue <command>");
    expect(stdout).toContain("ID");
    expect(stdout).toContain("screenshot.png");
    expect(stdout).toContain("245 KB");
    expect(stdout).toContain("debug.log");
    expect(stdout).toContain("2026-01-14");
  }, 30_000);

  it("accepts --key as well as the positional key", async () => {
    const { stdout, exitCode } = await runCli([
      "jira",
      "issue",
      "attachments",
      "--key",
      ISSUE,
    ]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("screenshot.png");
  }, 30_000);

  it("emits the documented --json shape", async () => {
    const { stdout, exitCode } = await runCli(["jira", "issue", "attachments", ISSUE, "--json"]);

    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.schemaVersion).toBe("1");
    expect(parsed.issue).toBe(ISSUE);
    expect(parsed.total).toBe(2);
    expect(parsed.attachments[0]).toMatchObject({
      id: "10001",
      filename: "screenshot.png",
      size: 250880,
      mimeType: "image/png",
      author: { displayName: "Alice", email: "alice@example.com" },
    });
    expect(parsed.attachments[0].content).toContain("/attachment/content/10001");
  }, 30_000);

  it("says so when an issue has no attachments", async () => {
    attachments = [];
    const { stdout, exitCode } = await runCli(["jira", "issue", "attachments", ISSUE]);
    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/no attachments/i);
  }, 30_000);

  it("fails without an issue key", async () => {
    const { stdout, exitCode } = await runCli(["jira", "issue", "attachments", "--json"]);
    expect(exitCode).not.toBe(0);
    expect(JSON.parse(stdout).error.code).toBe("ATLCLI_ERR_USAGE");
  }, 30_000);
});

describe("jira issue attachment download", () => {
  it("downloads by attachment id", async () => {
    const { stdout, exitCode } = await runCli([
      "jira",
      "issue",
      "attachment",
      "download",
      "10001",
      "-o",
      join(home, "out") + "/",
    ]);

    expect(exitCode).toBe(0);
    expect(stdout).toContain("screenshot.png");
    const written = await readFile(join(home, "out", "screenshot.png"));
    expect(new Uint8Array(written)).toEqual(PNG_BYTES);
  }, 30_000);

  it("downloads by issue key and filename", async () => {
    await mkdir(join(home, "out"), { recursive: true });
    const { exitCode } = await runCli([
      "jira",
      "issue",
      "attachment",
      "download",
      ISSUE,
      "debug.log",
      // An existing directory is written *into*, no trailing slash needed.
      "--output",
      join(home, "out"),
    ]);

    expect(exitCode).toBe(0);
    expect(await readFile(join(home, "out", "debug.log"), "utf8")).toBe("boom\n");
  }, 30_000);

  it("writes to the working directory when -o is omitted", async () => {
    const cwd = join(home, "out");
    await mkdir(cwd, { recursive: true });

    const { exitCode } = await runCli(
      ["jira", "issue", "attachment", "download", "10001"],
      cwd
    );

    expect(exitCode).toBe(0);
    const written = await readFile(join(cwd, "screenshot.png"));
    expect(new Uint8Array(written)).toEqual(PNG_BYTES);
  }, 30_000);

  it("creates the output directory when it does not exist", async () => {
    const { exitCode } = await runCli([
      "jira",
      "issue",
      "attachment",
      "download",
      "10001",
      "-o",
      join(home, "out", "nested", "deeper") + "/",
    ]);
    expect(exitCode).toBe(0);
    const written = await readFile(join(home, "out", "nested", "deeper", "screenshot.png"));
    expect(new Uint8Array(written)).toEqual(PNG_BYTES);
  }, 30_000);

  it("treats a plain -o path as the target filename for a single download", async () => {
    // Neither an existing directory nor a trailing separator ⇒ it names the file.
    const { exitCode } = await runCli([
      "jira",
      "issue",
      "attachment",
      "download",
      "10001",
      "-o",
      join(home, "out", "renamed.png"),
    ]);
    expect(exitCode).toBe(0);
    const written = await readFile(join(home, "out", "renamed.png"));
    expect(new Uint8Array(written)).toEqual(PNG_BYTES);
  }, 30_000);

  it("downloads every attachment sharing a filename, disambiguated by id", async () => {
    attachments.push({
      id: "10003",
      filename: "screenshot.png",
      size: 5,
      mimeType: "image/png",
      bytes: LOG_BYTES,
    });

    const { stdout, exitCode } = await runCli([
      "jira",
      "issue",
      "attachment",
      "download",
      ISSUE,
      "screenshot.png",
      "-o",
      join(home, "out") + "/",
      "--json",
    ]);

    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.total).toBe(2);
    // Neither file overwrote the other.
    const first = await readFile(join(home, "out", "screenshot.10001.png"));
    const second = await readFile(join(home, "out", "screenshot.10003.png"));
    expect(new Uint8Array(first)).toEqual(PNG_BYTES);
    expect(new Uint8Array(second)).toEqual(LOG_BYTES);
  }, 30_000);

  it("refuses to clobber an existing file without --overwrite", async () => {
    await mkdir(join(home, "out"), { recursive: true });
    await writeFile(join(home, "out", "screenshot.png"), "keep me");

    const { stdout, exitCode } = await runCli([
      "jira",
      "issue",
      "attachment",
      "download",
      "10001",
      "-o",
      join(home, "out") + "/",
      "--json",
    ]);

    expect(exitCode).not.toBe(0);
    expect(JSON.parse(stdout).error.code).toBe("ATLCLI_ERR_IO");
    expect(await readFile(join(home, "out", "screenshot.png"), "utf8")).toBe("keep me");
  }, 30_000);

  it("replaces the file with --overwrite", async () => {
    await mkdir(join(home, "out"), { recursive: true });
    await writeFile(join(home, "out", "screenshot.png"), "stale");

    const { exitCode } = await runCli([
      "jira",
      "issue",
      "attachment",
      "download",
      "10001",
      "-o",
      join(home, "out") + "/",
      "--overwrite",
    ]);

    expect(exitCode).toBe(0);
    const written = await readFile(join(home, "out", "screenshot.png"));
    expect(new Uint8Array(written)).toEqual(PNG_BYTES);
  }, 30_000);

  it("writes a filename that tried to escape the output directory into it", async () => {
    // The name is uploader-controlled; it must not steer the write.
    attachments = [
      {
        id: "10009",
        filename: "../../escaped.txt",
        size: 5,
        mimeType: "text/plain",
        bytes: LOG_BYTES,
      },
    ];

    const { exitCode } = await runCli([
      "jira",
      "issue",
      "attachment",
      "download",
      "10009",
      "-o",
      join(home, "out") + "/",
    ]);

    expect(exitCode).toBe(0);
    expect(await readFile(join(home, "out", "escaped.txt"), "utf8")).toBe("boom\n");
  }, 30_000);

  it("reports an unknown filename on the issue", async () => {
    const { stdout, exitCode } = await runCli([
      "jira",
      "issue",
      "attachment",
      "download",
      ISSUE,
      "nope.txt",
      "--json",
    ]);

    expect(exitCode).not.toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.error.code).toBe("ATLCLI_ERR_VALIDATION");
    expect(parsed.error.details.available).toContain("screenshot.png");
  }, 30_000);

  it("rejects a lone issue key with a usage error", async () => {
    const { stdout, exitCode } = await runCli([
      "jira",
      "issue",
      "attachment",
      "download",
      ISSUE,
      "--json",
    ]);
    expect(exitCode).not.toBe(0);
    expect(JSON.parse(stdout).error.code).toBe("ATLCLI_ERR_USAGE");
  }, 30_000);
});

describe("jira issue attachment delete", () => {
  it("requires --confirm", async () => {
    const { stdout, exitCode } = await runCli([
      "jira",
      "issue",
      "attachment",
      "delete",
      "10001",
      "--json",
    ]);

    expect(exitCode).not.toBe(0);
    expect(JSON.parse(stdout).error.code).toBe("ATLCLI_ERR_USAGE");
    expect(deleted).toEqual([]);
  }, 30_000);

  it("deletes by id with --confirm", async () => {
    const { stdout, exitCode } = await runCli([
      "jira",
      "issue",
      "attachment",
      "delete",
      "10001",
      "--confirm",
      "--json",
    ]);

    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout).deleted).toEqual([{ id: "10001", filename: "screenshot.png" }]);
    expect(deleted).toEqual(["10001"]);
  }, 30_000);

  it("deletes by issue key and filename", async () => {
    const { exitCode } = await runCli([
      "jira",
      "issue",
      "attachment",
      "delete",
      ISSUE,
      "debug.log",
      "--confirm",
    ]);

    expect(exitCode).toBe(0);
    expect(deleted).toEqual(["10002"]);
  }, 30_000);
});

describe("unknown jira subcommands", () => {
  it("fails instead of printing help with exit 0", async () => {
    // What masked issue #8: a documented-but-missing command exited 0.
    const { stdout, exitCode } = await runCli(["jira", "issue", "attachmnets", ISSUE, "--json"]);

    expect(exitCode).not.toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.error.code).toBe("ATLCLI_ERR_USAGE");
    expect(parsed.error.details.subcommand).toBe("attachmnets");
  }, 30_000);

  it("still prints help with exit 0 for a bare command", async () => {
    const { stdout, exitCode } = await runCli(["jira", "issue"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("atlcli jira issue <command>");
    expect(stdout).toContain("attachments <key>");
  }, 30_000);

  it("prints the attachment help for a bare `attachment`", async () => {
    const { stdout, exitCode } = await runCli(["jira", "issue", "attachment"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("atlcli jira issue attachment <command>");
  }, 30_000);
});
