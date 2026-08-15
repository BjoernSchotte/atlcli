/**
 * Regression: `docs push --validate` validated the wrong thing.
 *
 * The flag was gated on `&& atlcliDir` and always called
 * `validateDirectory(atlcliDir, …)`, ignoring the file/directory argument. So
 * outside an initialized tree `--validate --strict` printed nothing at all and
 * pushed anyway, and inside one it could abort a clean file because some other
 * file in the tree had errors.
 *
 * Runs the real CLI against a real Bun HTTP server (no fetch mocking) with a
 * sandboxed HOME, so no Atlassian instance is involved.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../index.ts", import.meta.url));
const PAGE_ID = "88002";

/** Two hard errors: a broken relative link and an unclosed macro. */
const TWO_ERRORS = `# Broken

See [the missing page](./does-not-exist.md).

:::info
Never closed.
`;

const CLEAN = `# Clean

Nothing wrong here.
`;

const PAGE = {
  id: PAGE_ID,
  type: "page",
  title: "Validate Target Fixture",
  space: { key: "DOCSY" },
  version: { number: 7 },
  ancestors: [],
  metadata: { labels: { results: [] }, properties: {} },
  body: { storage: { value: "<p>remote</p>", representation: "storage" } },
  _links: { base: "http://stub.invalid", webui: `/pages/${PAGE_ID}` },
};

let server: ReturnType<typeof Bun.serve>;
let home: string;
let work: string;
/** Every request the CLI made, so "did it reach the API?" is assertable. */
let requests: string[] = [];

beforeAll(async () => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const { pathname } = new URL(req.url);
      requests.push(`${req.method} ${pathname}`);

      if (pathname === `/rest/api/content/${PAGE_ID}`) {
        if (req.method === "PUT") {
          const body = (await req.json()) as { title?: string; version?: { number?: number } };
          return Response.json({
            ...PAGE,
            title: body.title ?? PAGE.title,
            version: { number: body.version?.number ?? 8 },
          });
        }
        return Response.json(PAGE);
      }

      return new Response(JSON.stringify({ message: `stub: no route for ${pathname}` }), {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    },
  });

  home = await mkdtemp(join(tmpdir(), "atlcli-validate-home-"));
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
  if (work) await rm(work, { recursive: true, force: true });
});

async function runCli(args: string[], cwd = work): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn([process.execPath, "--conditions=development", "run", CLI, ...args], {
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
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
}

beforeEach(async () => {
  if (work) await rm(work, { recursive: true, force: true });
  work = await mkdtemp(join(tmpdir(), "atlcli-validate-work-"));
  requests = [];
});

describe("docs push --validate outside an initialized tree", () => {
  it("validates the named file instead of silently doing nothing", async () => {
    await writeFile(join(work, "page.md"), TWO_ERRORS);

    const push = await runCli(["wiki", "docs", "push", "page.md", "--validate", "--strict"]);

    // The regression: this used to print no validation output whatsoever and
    // go straight to the API call.
    expect(`${push.stdout}${push.stderr}`).toMatch(/LINK_FILE_NOT_FOUND/);
    expect(`${push.stdout}${push.stderr}`).toMatch(/MACRO_UNCLOSED/);
    expect(push.stdout).toMatch(/2 errors/);
    expect(push.exitCode).not.toBe(0);

    // And it must abort before touching the API.
    expect(requests).toEqual([]);
  }, 60_000);

  it("lets a clean file through", async () => {
    await writeFile(join(work, "page.md"), CLEAN);

    const push = await runCli(["wiki", "docs", "push", "page.md", "--validate"]);

    expect(push.exitCode, `${push.stdout}${push.stderr}`).toBe(0);
    expect(`${push.stdout}${push.stderr}`).not.toMatch(/Validation failed/);
  }, 60_000);
});

describe("docs push --validate inside an initialized tree", () => {
  beforeEach(async () => {
    const init = await runCli(["wiki", "docs", "init", ".", "--page-id", PAGE_ID, "--space", "DOCSY"]);
    expect(init.exitCode, init.stderr).toBe(0);
    requests = [];
  });

  it("does not abort a clean file because a different file has errors", async () => {
    await writeFile(join(work, "broken.md"), TWO_ERRORS);
    await writeFile(
      join(work, "clean.md"),
      `---\natlcli:\n  id: "${PAGE_ID}"\n  title: "Validate Target Fixture"\n---\n\n${CLEAN}`
    );

    const push = await runCli(["wiki", "docs", "push", "clean.md", "--validate"]);

    expect(push.exitCode, `${push.stdout}${push.stderr}`).toBe(0);
    expect(`${push.stdout}${push.stderr}`).not.toMatch(/Validation failed/);
    // The unrelated file must not even appear in the report.
    expect(push.stdout).not.toMatch(/broken\.md/);
    // The push really happened (validation did not swallow it).
    expect(requests).toContain(`PUT /rest/api/content/${PAGE_ID}`);
  }, 60_000);

  it("still catches errors when the whole directory is the push target", async () => {
    await writeFile(join(work, "broken.md"), TWO_ERRORS);

    const push = await runCli(["wiki", "docs", "push", ".", "--validate"]);

    expect(push.exitCode).not.toBe(0);
    expect(push.stdout).toMatch(/broken\.md/);
    expect(`${push.stdout}${push.stderr}`).toMatch(/Validation failed/);
  }, 60_000);

  it("still catches errors in the file actually being pushed", async () => {
    await writeFile(join(work, "broken.md"), TWO_ERRORS);

    const push = await runCli(["wiki", "docs", "push", "broken.md", "--validate"]);

    expect(push.exitCode).not.toBe(0);
    expect(push.stdout).toMatch(/broken\.md/);
    expect(requests).toEqual([]);
  }, 60_000);
});
