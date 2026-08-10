/**
 * Characterize the legacy `wiki page diff` contract before the semantic diff
 * work changes any command behavior. These tests intentionally run the real
 * CLI against a local Data Center-shaped HTTP stub: stdout, exit codes, REST
 * routing, and the absence of writes are all part of the compatibility seam.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../index.ts", import.meta.url));
const PAGE_ID = "77101";
const CURRENT_VERSION = 4;
const LEGACY_UNIFIED_DIFF =
  "Index: Version 3\n" +
  "===================================================================\n" +
  "--- Version 3\t\n" +
  "+++ Version 3\t\n" +
  "@@ -1,1 +1,1 @@\n" +
  "-Previous content\n" +
  "+New content\n";
const LEGACY_COLORED_DIFF =
  "Index: Version 3\n" +
  "===================================================================\n" +
  "\u001b[36m--- Version 3\t\u001b[0m\n" +
  "\u001b[36m+++ Version 3\t\u001b[0m\n" +
  "\u001b[36m@@ -1,1 +1,1 @@\u001b[0m\n" +
  "\u001b[31m-Previous content\u001b[0m\n" +
  "\u001b[32m+New content\u001b[0m\n";

type ObservedRequest = {
  method: string;
  pathname: string;
};

const currentPage = {
  id: PAGE_ID,
  type: "page",
  title: "Legacy Diff Fixture",
  space: { key: "DOCSY" },
  version: { number: CURRENT_VERSION },
  ancestors: [],
  body: {
    storage: {
      value: "<p>New content</p>",
      representation: "storage",
    },
  },
};

function historicalVersion(version: number, body: string): Record<string, unknown> {
  return {
    number: version,
    content: {
      id: PAGE_ID,
      type: "page",
      title: "Legacy Diff Fixture",
      space: { key: "DOCSY" },
      version: { number: version },
      ancestors: [],
      body: { storage: { value: body, representation: "storage" } },
    },
  };
}

let server: ReturnType<typeof Bun.serve>;
let home: string;
let cwd: string;
let requests: ObservedRequest[] = [];

beforeAll(async () => {
  server = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      requests.push({ method: request.method, pathname: url.pathname });

      if (request.method === "GET" && url.pathname === `/rest/api/content/${PAGE_ID}`) {
        return Response.json(currentPage);
      }
      if (request.method === "GET" && url.pathname === `/rest/api/content/${PAGE_ID}/version/2`) {
        return Response.json(historicalVersion(2, "<p>Old content</p>"));
      }
      if (request.method === "GET" && url.pathname === `/rest/api/content/${PAGE_ID}/version/3`) {
        return Response.json(historicalVersion(3, "<p>Previous content</p>"));
      }

      return new Response(JSON.stringify({ message: `stub: no route for ${url.pathname}` }), {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    },
  });

  home = await mkdtemp(join(tmpdir(), "atlcli-page-diff-home-"));
  cwd = await mkdtemp(join(tmpdir(), "atlcli-page-diff-cwd-"));
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
      logging: { level: "off", global: false, project: false },
    }),
  );
});

beforeEach(() => {
  requests = [];
});

afterEach(() => {
  expect(requests.every((request) => request.method === "GET")).toBe(true);
});

afterAll(async () => {
  server?.stop(true);
  if (home) await rm(home, { recursive: true, force: true });
  if (cwd) await rm(cwd, { recursive: true, force: true });
});

async function runPageDiff(
  args: string[],
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const env: Record<string, string | undefined> = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    ATLCLI_API_TOKEN: "stub-token",
    ATLCLI_DISABLE_UPDATE_CHECK: "1",
  };
  delete env.NO_COLOR;
  const processResult = Bun.spawn(
    [
      process.execPath,
      "--conditions=development",
      "run",
      CLI,
      "wiki",
      "page",
      "diff",
      ...args,
      "--no-log",
    ],
    {
      cwd,
      env,
      stdout: "pipe",
      stderr: "pipe",
    },
  );

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(processResult.stdout).text(),
    new Response(processResult.stderr).text(),
    processResult.exited,
  ]);
  return { stdout, stderr, exitCode };
}

function parseSingleJsonDocument(stdout: string): Record<string, unknown> {
  const parsed = JSON.parse(stdout) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new TypeError("Expected stdout to contain one JSON object.");
  }
  return parsed as Record<string, unknown>;
}

describe("wiki page diff legacy compatibility", () => {
  it("pins the reachable unified terminal output, which defaults to the previous version", async () => {
    const result = await runPageDiff(["--id", PAGE_ID]);

    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe(
      "\nDiff for \"Legacy Diff Fixture\"\n" +
      "Comparing version 3 → 4\n" +
      "+1, -1 line(s) changed\n\n" +
      LEGACY_COLORED_DIFF +
      "\n",
    );
    expect(requests).toEqual([
      { method: "GET", pathname: `/rest/api/content/${PAGE_ID}` },
      { method: "GET", pathname: `/rest/api/content/${PAGE_ID}/version/3` },
    ]);
  }, 30_000);

  it("pins the reachable legacy JSON shape as exactly one stdout document", async () => {
    const result = await runPageDiff(["--id", PAGE_ID, "--json"]);

    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stderr).toBe("");
    const parsed = parseSingleJsonDocument(result.stdout);
    expect(parsed).toEqual({
      schemaVersion: "1",
      pageId: PAGE_ID,
      title: "Legacy Diff Fixture",
      oldVersion: 3,
      newVersion: CURRENT_VERSION,
      hasChanges: true,
      additions: 1,
      deletions: 1,
      unified: LEGACY_UNIFIED_DIFF,
    });
    expect(result.stdout).toBe(`${JSON.stringify(parsed, null, 2)}\n`);
    expect(result.stdout).not.toContain("\u001b[");
  }, 30_000);

  it("keeps the command-local --version alias reachable in terminal and JSON modes", async () => {
    const terminal = await runPageDiff(["--id", PAGE_ID, "--version", "2"]);
    const json = await runPageDiff(["--id", PAGE_ID, "--version", "2", "--json"]);

    expect(terminal.exitCode, terminal.stderr).toBe(0);
    expect(terminal.stderr).toBe("");
    expect(terminal.stdout).toContain("Comparing version 2 → 4");
    expect(terminal.stdout).toContain("-Old content");
    expect(terminal.stdout).toContain("+New content");

    expect(json.exitCode, json.stderr).toBe(0);
    expect(json.stderr).toBe("");
    const parsed = parseSingleJsonDocument(json.stdout);
    expect(parsed).toMatchObject({
      schemaVersion: "1",
      pageId: PAGE_ID,
      oldVersion: 2,
      newVersion: CURRENT_VERSION,
      hasChanges: true,
    });
    expect(json.stdout).toBe(`${JSON.stringify(parsed, null, 2)}\n`);
    expect(json.stdout).not.toContain("\u001b[");
    expect(requests).toEqual([
      { method: "GET", pathname: `/rest/api/content/${PAGE_ID}` },
      { method: "GET", pathname: `/rest/api/content/${PAGE_ID}/version/2` },
      { method: "GET", pathname: `/rest/api/content/${PAGE_ID}` },
      { method: "GET", pathname: `/rest/api/content/${PAGE_ID}/version/2` },
    ]);
  }, 30_000);

  it("reports a missing --id as one JSON error document without making a request", async () => {
    const result = await runPageDiff(["--json"]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe("");
    const parsed = parseSingleJsonDocument(result.stdout);
    expect(parsed).toEqual({
      error: {
        code: "ATLCLI_ERR_USAGE",
        message: "--id is required.",
        details: {},
      },
    });
    expect(result.stdout).toBe(`${JSON.stringify(parsed, null, 2)}\n`);
    expect(requests).toEqual([]);
  }, 30_000);

  for (const version of ["0", "not-a-number"]) {
    it(`rejects invalid command-local --version value ${version}`, async () => {
      const result = await runPageDiff(["--id", PAGE_ID, "--version", version]);

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe("--version must be a positive number.\n");
      expect(requests).toEqual([]);
    }, 30_000);
  }

  it("surfaces an invalid page id as an API error without attempting a version read", async () => {
    const result = await runPageDiff(["--id", "unknown-page"]);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Confluence API error (404)");
    expect(requests).toEqual([
      { method: "GET", pathname: "/rest/api/content/unknown-page" },
    ]);
  }, 30_000);
});
