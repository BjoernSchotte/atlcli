/**
 * Regression: several `wiki docs` subcommands wrote MORE THAN ONE JSON document
 * to stdout under `--json`, so `JSON.parse(stdout)` threw for scripted callers.
 *
 *   - `docs pull --json` printed the markdown skip notice through an unguarded
 *     output(), which JSON-stringifies a bare string: stdout became
 *     `"Skipping foo.md (local modifications, use --force)"` followed by the
 *     real result object.
 *   - `docs check --json` printed the report document and then called fail(),
 *     which prints a second `{"error": ...}` document. Same for
 *     `docs push --validate --json`, which additionally emitted the
 *     human-readable report as a JSON string.
 *   - `docs resolve --json` emitted one or two bare human-readable strings and
 *     never a structured document at all.
 *
 * Every assertion below parses the WHOLE of stdout as a single document - that
 * is the contract, and a per-line parse would pass against the bug.
 *
 * Runs the real CLI against a local Bun HTTP server standing in for the
 * Confluence REST API: no fetch mocking, no Atlassian traffic, and a sandboxed
 * HOME so the developer's own ~/.atlcli/config.json is never read.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../index.ts", import.meta.url));
const PAGE_ID = "88101";
/** `docs pull` slugifies the page title into the on-disk filename. */
const PAGE_SLUG = "json-contract-fixture";

/** Two hard errors: a broken relative link and an unclosed macro. */
const TWO_ERRORS = `# Broken

See [the missing page](./does-not-exist.md).

:::info
Never closed.
`;

const PAGE = {
  id: PAGE_ID,
  type: "page",
  title: "JSON Contract Fixture",
  space: { key: "DOCSY" },
  version: { number: 3, when: "2026-07-20T00:00:00.000Z" },
  ancestors: [],
  history: {
    createdDate: "2026-07-19T00:00:00.000Z",
    createdBy: { accountId: "acc-1", displayName: "Fixture Author" },
    lastUpdated: { when: "2026-07-20T00:00:00.000Z", by: { accountId: "acc-1", displayName: "Fixture Author" } },
  },
  metadata: { labels: { results: [] }, properties: {} },
  body: { storage: { value: "<p>Remote body.</p>", representation: "storage" } },
  _links: { base: "http://stub.invalid", webui: `/pages/${PAGE_ID}` },
};

let server: ReturnType<typeof Bun.serve>;
let home: string;
let tree: string;
/** Any non-GET request would mean the test wrote to "Confluence". */
let writes: string[] = [];

const pagePath = () => join(tree, `${PAGE_SLUG}.md`);

beforeAll(async () => {
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const { pathname } = new URL(req.url);
      if (req.method !== "GET") writes.push(`${req.method} ${pathname}`);

      // Data-center shape (bearer auth => no /wiki prefix).
      if (pathname === `/rest/api/content/${PAGE_ID}`) return Response.json(PAGE);
      if (pathname === `/rest/api/content/${PAGE_ID}/child/attachment`) {
        return Response.json({ results: [], size: 0 });
      }

      // Folder/comment discovery is best-effort in pull and tolerates 404s.
      return new Response(JSON.stringify({ message: `stub: no route for ${pathname}` }), {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    },
  });

  home = await mkdtemp(join(tmpdir(), "atlcli-jsondoc-home-"));
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

async function runCli(args: string[], cwd = tree): Promise<{ stdout: string; stderr: string; exitCode: number }> {
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

/**
 * The assertion this whole file exists for: the ENTIRE stdout must be one JSON
 * document. A second document (or a stray stringified log line) makes
 * JSON.parse throw, exactly as it does for a scripted consumer.
 */
function parseSingleDocument(stdout: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`stdout is not a single JSON document (${reason}).\n--- stdout ---\n${stdout}`);
  }
  // A bare `"Skipping ..."` string parses fine on its own, so reject it too:
  // the contract is a result object, not whatever human line came out first.
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`stdout parsed to a ${typeof parsed}, expected an object.\n--- stdout ---\n${stdout}`);
  }
  return parsed as Record<string, unknown>;
}

/** Fresh tree with the fixture page pulled and tracked. */
async function freshTree(): Promise<void> {
  if (tree) await rm(tree, { recursive: true, force: true });
  tree = await mkdtemp(join(tmpdir(), "atlcli-jsondoc-tree-"));
  writes = [];

  const init = await runCli(["wiki", "docs", "init", ".", "--page-id", PAGE_ID, "--space", "DOCSY"]);
  expect(init.exitCode, init.stderr).toBe(0);

  const pull = await runCli(["wiki", "docs", "pull", "--skip-user-check"]);
  expect(pull.exitCode, `${pull.stdout}${pull.stderr}`).toBe(0);
  expect(await readFile(pagePath(), "utf8")).toContain("Remote body.");
}

describe("docs pull --json: one document even when a file is skipped", () => {
  beforeEach(async () => {
    await freshTree();
    // Local edit => the "local modifications, use --force" skip path.
    await writeFile(pagePath(), `${await readFile(pagePath(), "utf8")}\n\nLocal edit.\n`);
  });

  it("emits a single parseable document reporting the skip", async () => {
    const pull = await runCli(["wiki", "docs", "pull", "--skip-user-check", "--json"]);
    expect(pull.exitCode, `${pull.stdout}${pull.stderr}`).toBe(0);

    const parsed = parseSingleDocument(pull.stdout);
    expect(parsed.schemaVersion).toBe("1");
    const results = parsed.results as Record<string, number>;
    expect(results.skipped).toBe(1);
    expect(results.pulled).toBe(0);

    // The human line must not have leaked into the JSON stream in any form.
    expect(pull.stdout).not.toContain("local modifications, use --force");
    expect(writes).toEqual([]);
  }, 60_000);

  it("still prints the skip notice in human mode", async () => {
    const pull = await runCli(["wiki", "docs", "pull", "--skip-user-check"]);
    expect(pull.exitCode, `${pull.stdout}${pull.stderr}`).toBe(0);
    expect(pull.stdout).toMatch(/Skipping .*\(local modifications, use --force\)/);
  }, 60_000);
});

describe("docs check --json: one document, pass or fail", () => {
  let checkDir: string;

  beforeEach(async () => {
    checkDir = await mkdtemp(join(tmpdir(), "atlcli-jsondoc-check-"));
  });

  it("folds the failure into the report instead of printing a second document", async () => {
    await writeFile(join(checkDir, "broken.md"), TWO_ERRORS);

    const check = await runCli(["wiki", "docs", "check", "."], checkDir);
    expect(check.exitCode).toBe(1); // sanity: the fixture really does fail

    const json = await runCli(["wiki", "docs", "check", ".", "--json"], checkDir);
    expect(json.exitCode).toBe(1);

    const parsed = parseSingleDocument(json.stdout);
    expect(parsed.schemaVersion).toBe("1");
    expect(parsed.passed).toBe(false);
    expect(parsed.totalErrors).toBe(2);
    expect(parsed.filesWithIssues).toBe(1);
    expect(parsed.error).toEqual({
      code: "ATLCLI_ERR_VALIDATION",
      message: "Validation failed",
      details: {},
    });

    // The human report must not be in the JSON stream.
    expect(json.stdout).not.toContain("Summary:");
  }, 60_000);

  it("reports no error field when validation passes", async () => {
    await writeFile(join(checkDir, "fine.md"), "# Fine\n\nNothing wrong here.\n");

    const json = await runCli(["wiki", "docs", "check", ".", "--json"], checkDir);
    expect(json.exitCode, json.stderr).toBe(0);

    const parsed = parseSingleDocument(json.stdout);
    expect(parsed.passed).toBe(true);
    expect(parsed.totalErrors).toBe(0);
    expect(parsed.error).toBeUndefined();
  }, 60_000);

  it("still emits one document when --strict turns warnings into a failure", async () => {
    // A subdirectory of pages without an index.md is a warning, not an error:
    // passed stays true while the process exits 1.
    await mkdir(join(checkDir, "guides"), { recursive: true });
    await writeFile(join(checkDir, "guides", "one.md"), "# One\n\nFine.\n");

    const json = await runCli(["wiki", "docs", "check", ".", "--json", "--strict"], checkDir);
    expect(json.exitCode).toBe(1);

    const parsed = parseSingleDocument(json.stdout);
    expect(parsed.passed).toBe(true);
    expect(parsed.totalErrors).toBe(0);
    expect(parsed.totalWarnings).toBeGreaterThan(0);
    expect((parsed.error as Record<string, string>).message).toBe(
      "Validation failed (strict mode: warnings are errors)"
    );
  }, 60_000);

  it("emits one error-only document when there is nothing to validate", async () => {
    // `check` refuses to pass an empty tree (a CI gate that validated nothing).
    // That failure happens before the report exists, so the document carries
    // only `error` - and it must still be exactly one document.
    const json = await runCli(["wiki", "docs", "check", ".", "--json"], checkDir);
    expect(json.exitCode).toBe(1);

    const parsed = parseSingleDocument(json.stdout);
    const error = parsed.error as Record<string, unknown>;
    expect(error.code).toBe("ATLCLI_ERR_USAGE");
    expect(error.message).toContain("nothing was validated");
    expect((error.details as Record<string, unknown>).filesChecked).toBe(0);
  }, 60_000);

  it("does not emit an error field without --strict when only warnings exist", async () => {
    await mkdir(join(checkDir, "guides"), { recursive: true });
    await writeFile(join(checkDir, "guides", "one.md"), "# One\n\nFine.\n");

    const json = await runCli(["wiki", "docs", "check", ".", "--json"], checkDir);
    expect(json.exitCode, json.stderr).toBe(0);

    const parsed = parseSingleDocument(json.stdout);
    expect(parsed.totalWarnings).toBeGreaterThan(0);
    expect(parsed.error).toBeUndefined();
  }, 60_000);
});

describe("docs push --validate --json: one document when validation aborts the push", () => {
  beforeEach(async () => {
    await freshTree();
    await writeFile(join(tree, "broken.md"), TWO_ERRORS);
  });

  it("emits only the error document, with the report in details", async () => {
    const push = await runCli(["wiki", "docs", "push", ".", "--validate", "--json"]);
    expect(push.exitCode).toBe(1);

    const parsed = parseSingleDocument(push.stdout);
    const error = parsed.error as Record<string, unknown>;
    expect(error.code).toBe("ATLCLI_ERR_VALIDATION");
    expect(error.message).toBe("Validation failed - push aborted");

    // Machine-readable issues replace the stringified human report.
    const details = error.details as Record<string, unknown>;
    expect(details.totalErrors).toBe(2);
    expect((details.files as unknown[]).length).toBe(1);

    expect(push.stdout).not.toContain("Summary:");
    expect(writes).toEqual([]);
  }, 60_000);
});

describe("docs resolve --json: one document, structured", () => {
  const META = {
    id: PAGE_ID,
    title: "JSON Contract Fixture",
    spaceKey: "DOCSY",
    version: 3,
    lastSyncedAt: "2026-07-20T00:00:00.000Z",
    localHash: "local",
    remoteHash: "remote",
    baseHash: "base",
    syncState: "conflict",
  };

  beforeEach(async () => {
    await freshTree();
    await writeFile(`${pagePath()}.meta.json`, JSON.stringify(META));
  });

  it("returns an object, not a bare string, when there is nothing to resolve", async () => {
    const resolve = await runCli(["wiki", "docs", "resolve", pagePath(), "--json"]);
    expect(resolve.exitCode, `${resolve.stdout}${resolve.stderr}`).toBe(0);

    const parsed = parseSingleDocument(resolve.stdout);
    expect(parsed.resolved).toBe(false);
    expect(parsed.staleConflict).toBe(true);
  }, 60_000);

  it("emits one document (not two lines) after a successful resolve", async () => {
    await writeFile(
      pagePath(),
      "# Conflicted\n\n<<<<<<< LOCAL\nmine\n=======\ntheirs\n>>>>>>> REMOTE\n"
    );

    const resolve = await runCli(["wiki", "docs", "resolve", pagePath(), "--accept", "local", "--json"]);
    expect(resolve.exitCode, `${resolve.stdout}${resolve.stderr}`).toBe(0);

    const parsed = parseSingleDocument(resolve.stdout);
    expect(parsed.resolved).toBe(true);
    expect(parsed.accept).toBe("local");

    const after = await readFile(pagePath(), "utf8");
    expect(after).toContain("mine");
    expect(after).not.toContain("<<<<<<< LOCAL");
  }, 60_000);
});
