/**
 * Regression: `--dir` was read by push/watch/status but NOT by pull or check,
 * even though the `docs` help preamble tells users to "pass an explicit
 * path/--dir when running from elsewhere".
 *
 * Measured from a neutral cwd, `docs check --dir /tree` reported "Checking 0
 * files... 0 errors" and exited 0 while `docs check /tree` found 2 errors - a
 * CI gate that passes by validating nothing. `pull` read an undocumented
 * `--out` instead and pulled into the cwd.
 *
 * Every case here runs from a cwd that is NOT the tree; a test run from inside
 * the tree passes today and proves nothing.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../index.ts", import.meta.url));
const PAGE_ID = "99003";

/** Two hard errors: a broken relative link and an unclosed macro. */
const TWO_ERRORS = `# Broken

See [the missing page](./does-not-exist.md).

:::info
Never closed.
`;

const PAGE = {
  id: PAGE_ID,
  type: "page",
  title: "Dir Flag Fixture",
  space: { key: "DOCSY" },
  version: { number: 2 },
  ancestors: [],
  metadata: { labels: { results: [] }, properties: {} },
  body: { storage: { value: "<p>Pulled through --dir.</p>", representation: "storage" } },
  _links: { base: "http://stub.invalid", webui: `/pages/${PAGE_ID}` },
};

let server: ReturnType<typeof Bun.serve>;
let home: string;
/** The initialized tree under test. */
let tree: string;
/** An unrelated working directory the CLI is invoked from. */
let elsewhere: string;

beforeAll(async () => {
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const { pathname } = new URL(req.url);
      if (pathname === `/rest/api/content/${PAGE_ID}`) return Response.json(PAGE);
      if (pathname === `/rest/api/content/${PAGE_ID}/child/attachment`) {
        return Response.json({ results: [], size: 0 });
      }
      return new Response(JSON.stringify({ message: `stub: no route for ${pathname}` }), {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    },
  });

  home = await mkdtemp(join(tmpdir(), "atlcli-dirflag-home-"));
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
  for (const dir of [home, tree, elsewhere]) {
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

/** Always invoked from `elsewhere` - never from inside the tree. */
async function runCli(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn([process.execPath, "--conditions=development", "run", CLI, ...args], {
    cwd: elsewhere,
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

/**
 * `check --json` prints the report and then, on failure, a separate error
 * document. Parse the first one.
 */
function firstJsonDoc(stdout: string): any {
  const end = stdout.indexOf("\n}\n");
  return JSON.parse(end === -1 ? stdout : stdout.slice(0, end + 2));
}

beforeEach(async () => {
  if (tree) await rm(tree, { recursive: true, force: true });
  if (elsewhere) await rm(elsewhere, { recursive: true, force: true });
  tree = await mkdtemp(join(tmpdir(), "atlcli-dirflag-tree-"));
  elsewhere = await mkdtemp(join(tmpdir(), "atlcli-dirflag-cwd-"));
});

describe("docs check --dir from an unrelated cwd", () => {
  it("validates the named tree and exits non-zero on its errors", async () => {
    await writeFile(join(tree, "broken.md"), TWO_ERRORS);

    const viaDir = await runCli(["wiki", "docs", "check", "--dir", tree, "--json"]);

    // The regression: this used to report 0 files checked and exit 0.
    expect(viaDir.exitCode).not.toBe(0);
    const parsed = firstJsonDoc(viaDir.stdout);
    expect(parsed.filesChecked).toBe(1);
    expect(parsed.totalErrors).toBe(2);
    expect(parsed.passed).toBe(false);
  }, 60_000);

  it("matches the positional-path spelling exactly", async () => {
    await writeFile(join(tree, "broken.md"), TWO_ERRORS);

    const viaDir = await runCli(["wiki", "docs", "check", "--dir", tree, "--json"]);
    const viaPositional = await runCli(["wiki", "docs", "check", tree, "--json"]);

    expect(viaDir.exitCode).toBe(viaPositional.exitCode);
    expect(firstJsonDoc(viaDir.stdout)).toEqual(firstJsonDoc(viaPositional.stdout));
  }, 60_000);

  it("refuses to report success when it validated nothing", async () => {
    // No markdown anywhere: the empty cwd, the classic silent-green CI case.
    const check = await runCli(["wiki", "docs", "check"]);

    expect(check.exitCode).not.toBe(0);
    expect(`${check.stdout}${check.stderr}`).toMatch(/nothing was validated/);
  }, 60_000);

  it("fails loudly on a path that does not exist", async () => {
    const check = await runCli(["wiki", "docs", "check", "--dir", join(tree, "nope")]);

    expect(check.exitCode).not.toBe(0);
    expect(`${check.stdout}${check.stderr}`).toMatch(/Path not found/);
  }, 60_000);
});

describe("docs pull --dir from an unrelated cwd", () => {
  beforeEach(async () => {
    const init = await runCli(["wiki", "docs", "init", tree, "--page-id", PAGE_ID, "--space", "DOCSY"]);
    expect(init.exitCode, init.stderr).toBe(0);
  });

  it("pulls into the named tree, not into the cwd", async () => {
    const pull = await runCli(["wiki", "docs", "pull", "--dir", tree, "--skip-user-check", "--json"]);
    expect(pull.exitCode, `${pull.stdout}${pull.stderr}`).toBe(0);

    const parsed = JSON.parse(pull.stdout);
    expect(parsed.results.outDir).toBe(tree);
    expect(parsed.results.pulled).toBe(1);

    expect(existsSync(join(tree, "dir-flag-fixture.md"))).toBe(true);
    // The regression: without --dir support the pull landed in the cwd and
    // auto-initialized a second .atlcli there.
    expect(existsSync(join(elsewhere, "dir-flag-fixture.md"))).toBe(false);
    expect(existsSync(join(elsewhere, ".atlcli"))).toBe(false);
  }, 60_000);

  it("keeps --out working as the legacy alias", async () => {
    const pull = await runCli(["wiki", "docs", "pull", "--out", tree, "--skip-user-check", "--json"]);
    expect(pull.exitCode, `${pull.stdout}${pull.stderr}`).toBe(0);
    expect(JSON.parse(pull.stdout).results.outDir).toBe(tree);
    expect(existsSync(join(elsewhere, ".atlcli"))).toBe(false);
  }, 60_000);
});
