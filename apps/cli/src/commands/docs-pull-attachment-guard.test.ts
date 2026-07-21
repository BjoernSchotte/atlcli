/**
 * Regression: `docs pull` used to overwrite locally modified ATTACHMENTS with
 * no warning and without `--force`.
 *
 * `--force` was read once (the markdown skip guard) and never consulted by the
 * attachment download block, which called writeFile unconditionally. A user who
 * edited a pulled attachment lost those bytes on the next pull, while `docs
 * status` reported the tree as "synced" right beforehand.
 *
 * Everything runs through the real CLI against a real Bun HTTP server standing
 * in for the Confluence REST API - no fetch mocking, no Atlassian traffic, and
 * a sandboxed HOME so the developer's own ~/.atlcli/config.json is never read.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../index.ts", import.meta.url));
const PAGE_ID = "77001";
const ATTACHMENT_ID = "att77001";
const ATTACHMENT_NAME = "handbook.pdf";
const DOWNLOAD_PATH = `/download/attachments/${PAGE_ID}/${ATTACHMENT_NAME}`;

/** Remote attachment bytes the stub serves; deliberately not 13 bytes long. */
const REMOTE_BYTES = new Uint8Array(Buffer.from("%PDF-1.7 remote attachment payload ".repeat(64)));
/** What the user "edits" the file to locally. */
const LOCAL_BYTES = new Uint8Array(Buffer.from("locally edited"));
/** A second remote revision, used to force a both-sides-changed conflict. */
const REMOTE_BYTES_V2 = new Uint8Array(Buffer.from("%PDF-1.7 SECOND remote revision ".repeat(48)));

/** Bytes the stub currently serves for the attachment download. */
let servedBytes = REMOTE_BYTES;

const PAGE = {
  id: PAGE_ID,
  type: "page",
  title: "Attachment Guard Fixture",
  space: { key: "DOCSY" },
  version: { number: 4, when: "2026-07-19T00:00:00.000Z" },
  ancestors: [],
  history: {
    createdDate: "2026-07-18T00:00:00.000Z",
    createdBy: { accountId: "acc-1", displayName: "Fixture Author" },
    lastUpdated: { when: "2026-07-19T00:00:00.000Z", by: { accountId: "acc-1", displayName: "Fixture Author" } },
  },
  metadata: { labels: { results: [] }, properties: {} },
  body: { storage: { value: "<p>Body with an attachment.</p>", representation: "storage" } },
  _links: { base: "http://stub.invalid", webui: `/pages/${PAGE_ID}` },
};

const ATTACHMENTS = {
  results: [
    {
      id: ATTACHMENT_ID,
      type: "attachment",
      title: ATTACHMENT_NAME,
      version: { number: 2, when: "2026-07-19T00:00:00.000Z" },
      extensions: { mediaType: "application/pdf", fileSize: REMOTE_BYTES.byteLength },
      metadata: { mediaType: "application/pdf" },
      _links: { download: DOWNLOAD_PATH },
    },
  ],
  size: 1,
};

let server: ReturnType<typeof Bun.serve>;
let home: string;
let tree: string;

/** Requests the stub could not answer - surfaced in failure messages. */
let unmatched: string[] = [];
/** Any non-GET request would mean the test wrote to "Confluence". */
let writes: string[] = [];

const attachmentPath = () => join(tree, `${slug()}.attachments`, ATTACHMENT_NAME);
const slug = () => "attachment-guard-fixture";

beforeAll(async () => {
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const { pathname } = new URL(req.url);
      if (req.method !== "GET") writes.push(`${req.method} ${pathname}`);

      // Data-center shape (bearer auth => no /wiki prefix).
      if (pathname === `/rest/api/content/${PAGE_ID}`) return Response.json(PAGE);
      if (pathname === `/rest/api/content/${PAGE_ID}/child/attachment`) return Response.json(ATTACHMENTS);
      if (pathname === DOWNLOAD_PATH) {
        return new Response(servedBytes, { headers: { "content-type": "application/pdf" } });
      }

      // Folder discovery (v2 API) is best-effort in pull and tolerates 404s.
      unmatched.push(`${req.method} ${pathname}`);
      return new Response(JSON.stringify({ message: `stub: no route for ${pathname}` }), {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    },
  });

  home = await mkdtemp(join(tmpdir(), "atlcli-att-home-"));
  await mkdir(join(home, ".atlcli"), { recursive: true });
  await writeFile(
    join(home, ".atlcli", "config.json"),
    JSON.stringify({
      currentProfile: "stub",
      profiles: {
        stub: {
          name: "stub",
          baseUrl: server.url.origin,
          deploymentType: "data-center",
          auth: { type: "bearer" },
          space: "DOCSY",
        },
      },
    })
  );
});

afterAll(async () => {
  server?.stop(true);
  if (home) await rm(home, { recursive: true, force: true });
  if (tree) await rm(tree, { recursive: true, force: true });
});

async function runCli(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn([process.execPath, "--conditions=development", "run", CLI, ...args], {
    cwd: tree,
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      ATLCLI_API_TOKEN: "stub-token",
      ATLCLI_DISABLE_UPDATE_CHECK: "1",
    },
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

/** Pull once into a fresh tree so the attachment and its base hash exist. */
async function freshTreeWithAttachment(): Promise<void> {
  tree = await mkdtemp(join(tmpdir(), "atlcli-att-tree-"));
  unmatched = [];
  writes = [];
  servedBytes = REMOTE_BYTES;

  const init = await runCli(["wiki", "docs", "init", ".", "--page-id", PAGE_ID, "--space", "DOCSY"]);
  expect(init.exitCode, init.stderr).toBe(0);

  const pull = await runCli(["wiki", "docs", "pull", "--skip-user-check"]);
  expect(pull.exitCode, `${pull.stdout}${pull.stderr}`).toBe(0);
  expect(new Uint8Array(await readFile(attachmentPath()))).toEqual(REMOTE_BYTES);
}

describe("docs pull: attachments honour --force like markdown does", () => {
  beforeEach(async () => {
    if (tree) await rm(tree, { recursive: true, force: true });
    await freshTreeWithAttachment();
  });

  it("does NOT overwrite a locally modified attachment without --force", async () => {
    await writeFile(attachmentPath(), LOCAL_BYTES);

    const pull = await runCli(["wiki", "docs", "pull", "--skip-user-check"]);
    expect(pull.exitCode, `${pull.stdout}${pull.stderr}`).toBe(0);

    // The regression itself: the local bytes must still be there, byte for byte.
    const after = new Uint8Array(await readFile(attachmentPath()));
    expect(after).toEqual(LOCAL_BYTES);
    expect(after.byteLength).toBe(LOCAL_BYTES.byteLength);

    // And it must say so, the way the markdown half does.
    expect(pull.stdout).toMatch(/Skipping .*handbook\.pdf \(local modifications, use --force\)/);
    expect(writes).toEqual([]);
  }, 60_000);

  it("reports the skip in the JSON result", async () => {
    await writeFile(attachmentPath(), LOCAL_BYTES);

    const pull = await runCli(["wiki", "docs", "pull", "--skip-user-check", "--json"]);
    expect(pull.exitCode, `${pull.stdout}${pull.stderr}`).toBe(0);

    const parsed = JSON.parse(pull.stdout);
    expect(parsed.results.attachmentsSkipped).toBe(1);
    expect(parsed.results.attachments ?? 0).toBe(0);
    expect(new Uint8Array(await readFile(attachmentPath()))).toEqual(LOCAL_BYTES);
  }, 60_000);

  it("DOES replace the local bytes when --force is given", async () => {
    await writeFile(attachmentPath(), LOCAL_BYTES);

    const pull = await runCli(["wiki", "docs", "pull", "--skip-user-check", "--force"]);
    expect(pull.exitCode, `${pull.stdout}${pull.stderr}`).toBe(0);

    const after = new Uint8Array(await readFile(attachmentPath()));
    expect(after).toEqual(REMOTE_BYTES);
    expect(after.byteLength).toBe(REMOTE_BYTES.byteLength);
  }, 60_000);

  it("keeps the modification signal after a skipped pull (state is not re-based)", async () => {
    await writeFile(attachmentPath(), LOCAL_BYTES);

    const pull = await runCli(["wiki", "docs", "pull", "--skip-user-check"]);
    expect(pull.exitCode, `${pull.stdout}${pull.stderr}`).toBe(0);

    // Skipping must NOT refresh the attachment's stored hashes from disk: that
    // would promote the local edit to the new base and quietly make the file
    // eligible for overwriting on the next pull.
    const status = await runCli(["wiki", "docs", "status", "--json"]);
    const parsed = JSON.parse(status.stdout);
    expect(parsed.attachmentStats.localModified).toBe(1);
    expect(parsed.attachmentStats.synced).toBe(0);
  }, 60_000);

  it("still downloads an untouched attachment (the guard is not a blanket skip)", async () => {
    const pull = await runCli(["wiki", "docs", "pull", "--skip-user-check", "--json"]);
    expect(pull.exitCode, `${pull.stdout}${pull.stderr}`).toBe(0);

    const parsed = JSON.parse(pull.stdout);
    expect(parsed.results.attachments).toBe(1);
    expect(parsed.results.attachmentsSkipped ?? 0).toBe(0);
  }, 60_000);
});

describe("docs pull: attachment conflicts keep the local bytes", () => {
  beforeEach(async () => {
    if (tree) await rm(tree, { recursive: true, force: true });
    await freshTreeWithAttachment();
  });

  it("saves the remote revision alongside instead of overwriting", async () => {
    await writeFile(attachmentPath(), LOCAL_BYTES);
    servedBytes = REMOTE_BYTES_V2; // remote moved on too

    const pull = await runCli(["wiki", "docs", "pull", "--skip-user-check", "--json"]);
    expect(pull.exitCode, `${pull.stdout}${pull.stderr}`).toBe(0);

    expect(new Uint8Array(await readFile(attachmentPath()))).toEqual(LOCAL_BYTES);
    const conflictCopy = join(tree, `${slug()}.attachments`, "handbook-conflict.pdf");
    expect(new Uint8Array(await readFile(conflictCopy))).toEqual(REMOTE_BYTES_V2);
    expect(JSON.parse(pull.stdout).results.attachmentsConflicted).toBe(1);

    // The conflict must survive in state, not be re-based to "synced".
    const status = await runCli(["wiki", "docs", "status", "--json"]);
    expect(JSON.parse(status.stdout).attachmentStats.conflict).toBe(1);
  }, 60_000);
});

describe("docs status: a modified attachment is not reported as synced", () => {
  beforeEach(async () => {
    if (tree) await rm(tree, { recursive: true, force: true });
    await freshTreeWithAttachment();
  });

  it("counts the modified attachment and lists it under Modified", async () => {
    await writeFile(attachmentPath(), LOCAL_BYTES);

    const status = await runCli(["wiki", "docs", "status", "--json"]);
    expect(status.exitCode, status.stderr).toBe(0);

    const parsed = JSON.parse(status.stdout);
    // The markdown file really is untouched - that part was never wrong.
    expect(parsed.stats.synced).toBe(1);
    // What was wrong: nothing anywhere said the attachment had local edits.
    expect(parsed.attachmentStats.localModified).toBe(1);
    expect(parsed.attachmentStats.synced).toBe(0);
    expect(parsed.modified.some((m: { file: string }) => m.file.endsWith(ATTACHMENT_NAME))).toBe(true);
  }, 60_000);

  it("reports a clean attachment as synced", async () => {
    const status = await runCli(["wiki", "docs", "status", "--json"]);
    const parsed = JSON.parse(status.stdout);
    expect(parsed.attachmentStats.synced).toBe(1);
    expect(parsed.attachmentStats.localModified).toBe(0);
    expect(parsed.attachmentStats.missing).toBe(0);
  }, 60_000);
});
