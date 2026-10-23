/**
 * Regression: `docs diff` right after `docs pull` reported changes. It compared
 * the raw converted remote page with the file pull wrote, which pull had
 * normalized and whose attachment references it had rewritten to
 * `./<page>.attachments/…`. It also checks that a Server/Data Center mention
 * pulls with the user's name, brackets included, and diffs clean.
 *
 * Real CLI against a Bun HTTP server standing in for Confluence; sandboxed HOME.
 */
import { afterAll, beforeAll, expect, it } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../index.ts", import.meta.url));
const PAGE_ID = "79001";
const SLUG = "diff-fixture";
const DOWNLOAD_PATH = `/download/attachments/${PAGE_ID}/diagram.png`;
const STORAGE = [
  '<p>Owner: <ac:link><ri:user ri:userkey="key-1" /></ac:link></p>',
  '<p><ac:image><ri:attachment ri:filename="diagram.png" /></ac:image></p>',
].join("");

const PAGE = {
  id: PAGE_ID,
  type: "page",
  title: "Diff Fixture",
  space: { key: "DOCSY" },
  version: { number: 2, when: "2026-10-20T00:00:00.000Z" },
  ancestors: [],
  history: {
    createdDate: "2026-10-19T00:00:00.000Z",
    createdBy: { accountId: "acc-1", displayName: "Fixture Author" },
    lastUpdated: { when: "2026-10-20T00:00:00.000Z", by: { accountId: "acc-1", displayName: "Fixture Author" } },
  },
  metadata: { labels: { results: [] }, properties: {} },
  body: { storage: { value: STORAGE, representation: "storage" } },
  _links: { base: "http://stub.invalid", webui: `/pages/${PAGE_ID}` },
};

const ATTACHMENTS = {
  results: [
    {
      id: "att79001",
      type: "attachment",
      title: "diagram.png",
      version: { number: 1, when: "2026-10-20T00:00:00.000Z" },
      extensions: { mediaType: "image/png", fileSize: 4 },
      metadata: { mediaType: "image/png" },
      _links: { download: DOWNLOAD_PATH },
    },
  ],
  size: 1,
};

let server: ReturnType<typeof Bun.serve>;
let home: string;
let tree: string;

beforeAll(async () => {
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === `/rest/api/content/${PAGE_ID}`) return Response.json(PAGE);
      if (url.pathname === `/rest/api/content/${PAGE_ID}/child/attachment`) return Response.json(ATTACHMENTS);
      if (url.pathname === DOWNLOAD_PATH) return new Response(new Uint8Array([1, 2, 3, 4]));
      if (url.pathname === "/rest/api/user" && url.searchParams.get("key") === "key-1") {
        return Response.json({ userKey: "key-1", displayName: "Max Muster [extern]" });
      }
      return Response.json({ message: `stub: no route for ${url.pathname}` }, { status: 404 });
    },
  });
  home = await mkdtemp(join(tmpdir(), "atlcli-diff-home-"));
  tree = await mkdtemp(join(tmpdir(), "atlcli-diff-tree-"));
  await mkdir(join(home, ".atlcli"), { recursive: true });
  await writeFile(
    join(home, ".atlcli", "config.json"),
    JSON.stringify({
      currentProfile: "stub",
      profiles: {
        stub: { name: "stub", baseUrl: server.url.origin, deploymentType: "data-center", auth: { type: "bearer" }, space: "DOCSY" },
      },
    })
  );
});

afterAll(async () => {
  server?.stop(true);
  await rm(home, { recursive: true, force: true });
  await rm(tree, { recursive: true, force: true });
});

async function runCli(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn([process.execPath, "--conditions=development", "run", CLI, ...args], {
    cwd: tree,
    env: { ...process.env, HOME: home, USERPROFILE: home, ATLCLI_API_TOKEN: "stub-token", ATLCLI_DISABLE_UPDATE_CHECK: "1" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { stdout, stderr, exitCode };
}

it("docs diff reports no changes right after docs pull", async () => {
  expect((await runCli(["wiki", "docs", "init", ".", "--page-id", PAGE_ID, "--space", "DOCSY"])).exitCode).toBe(0);
  const pull = await runCli(["wiki", "docs", "pull", "--skip-user-check"]);
  expect(pull.exitCode, `${pull.stdout}${pull.stderr}`).toBe(0);

  const file = join(tree, `${SLUG}.md`);
  const local = await readFile(file, "utf8");
  expect(local).toContain("@[Max Muster \\[extern\\]](userkey:key-1)");
  expect(local).toContain(`./${SLUG}.attachments/diagram.png`);

  const diff = await runCli(["wiki", "docs", "diff", file, "--json"]);
  expect(diff.exitCode, diff.stderr).toBe(0);
  const parsed = JSON.parse(diff.stdout);
  expect(parsed.unified, parsed.unified).toBeDefined();
  if (parsed.hasChanges) throw new Error(`unexpected diff:\n${parsed.unified}`);
}, 90_000);
