/**
 * Real-process coverage for the page-diff CLI shell and the Data Center
 * Storage semantic pipeline.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../index.ts", import.meta.url));
const PAGE_ID = "88421";
const CURRENT_VERSION = 4;

type ObservedRequest = { method: string; pathname: string };
type CloudMode = "success" | "fallback" | "malformed" | "mismatch" | "denied" | "rate-limit" | "server-error";

function page(version: number, text: string): Record<string, unknown> {
  return {
    id: PAGE_ID,
    type: "page",
    title: "Page Diff CLI Fixture",
    space: { key: "DOCSY" },
    version: { number: version },
    ancestors: [],
    body: { storage: { value: `<p>${text}</p>`, representation: "storage" } },
  };
}

function historical(version: number, text: string): Record<string, unknown> {
  return { number: version, content: page(version, text) };
}

const versionText: Record<number, string> = {
  1: "First content",
  2: "Second content",
  3: "Third content",
  4: "Current content",
};

let server: ReturnType<typeof Bun.serve>;
let home: string;
let cwd: string;
let requests: ObservedRequest[] = [];
let requestUrls: string[] = [];
let cloudMode: CloudMode = "success";

beforeAll(async () => {
  server = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      requests.push({ method: request.method, pathname: url.pathname });
      requestUrls.push(url.toString());

      if (request.method === "GET" && url.pathname === `/wiki/api/v2/pages/${PAGE_ID}`) {
        const version = Number(url.searchParams.get("version"));
        if (cloudMode === "fallback") {
          return Response.json(
            { message: "body-format atlas_doc_format is unsupported" },
            { status: 400 },
          );
        }
        if (cloudMode === "denied") return Response.json({ message: "denied" }, { status: 403 });
        if (cloudMode === "rate-limit") return Response.json({ message: "slow down" }, { status: 429 });
        if (cloudMode === "server-error") return Response.json({ message: "failed" }, { status: 500 });
        const responseVersion = cloudMode === "mismatch" ? version + 1 : version;
        const value = cloudMode === "malformed"
          ? "not-json"
          : JSON.stringify({
              version: 1,
              type: "doc",
              content: [{
                type: "paragraph",
                content: [{ type: "text", text: versionText[version] ?? `Version ${version}` }],
              }],
            });
        return Response.json({
          id: PAGE_ID,
          title: "Page Diff CLI Fixture",
          version: { number: responseVersion },
          body: { atlas_doc_format: { representation: "atlas_doc_format", value } },
        });
      }
      const cloudHistory = url.pathname.match(
        new RegExp(`^/wiki/rest/api/content/${PAGE_ID}/version/(\\d+)$`),
      );
      if (request.method === "GET" && cloudHistory) {
        const version = Number(cloudHistory[1]);
        const text = versionText[version];
        if (text !== undefined) return Response.json(historical(version, text));
      }

      if (request.method === "GET" && url.pathname === `/rest/api/content/${PAGE_ID}`) {
        return Response.json(page(CURRENT_VERSION, versionText[CURRENT_VERSION]!));
      }
      const match = url.pathname.match(
        new RegExp(`^/rest/api/content/${PAGE_ID}/version/(\\d+)$`),
      );
      if (request.method === "GET" && match) {
        const version = Number(match[1]);
        const text = versionText[version];
        if (text !== undefined) return Response.json(historical(version, text));
      }

      return new Response(JSON.stringify({ message: `stub: no route for ${url.pathname}` }), {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    },
  });

  home = await mkdtemp(join(tmpdir(), "atlcli-page-diff-shell-home-"));
  cwd = await mkdtemp(join(tmpdir(), "atlcli-page-diff-shell-cwd-"));
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
        cloud: {
          name: "cloud",
          baseUrl: server.url.origin,
          deploymentType: "cloud",
          auth: { type: "apiToken", email: "fixture@example.invalid" },
          space: "DOCSY",
        },
      },
      logging: { level: "off", global: false, project: false },
    }),
  );
});

beforeEach(() => {
  requests = [];
  requestUrls = [];
  cloudMode = "success";
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
  options: { noColorEnvironment?: boolean } = {},
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const env: Record<string, string | undefined> = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    ATLCLI_API_TOKEN: "stub-token",
    ATLCLI_DISABLE_UPDATE_CHECK: "1",
  };
  delete env.NO_COLOR;
  if (options.noColorEnvironment) env.NO_COLOR = "";

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
    { cwd, env, stdout: "pipe", stderr: "pipe" },
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(processResult.stdout).text(),
    new Response(processResult.stderr).text(),
    processResult.exited,
  ]);
  return { stdout, stderr, exitCode };
}

function parseJson(stdout: string): Record<string, unknown> {
  return JSON.parse(stdout) as Record<string, unknown>;
}

describe("wiki page diff CLI shell", () => {
  it("treats --from as a current-target comparison", async () => {
    const result = await runPageDiff(["--id", PAGE_ID, "--from", "2", "--format", "unified"]);

    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Comparing version 2 → 4");
    expect(result.stdout).toContain("-Second content");
    expect(result.stdout).toContain("+Current content");
    expect(requests).toEqual([
      { method: "GET", pathname: `/rest/api/content/${PAGE_ID}` },
      { method: "GET", pathname: `/rest/api/content/${PAGE_ID}/version/2` },
    ]);
  }, 30_000);

  it("compares two exact versions without a moving-current read", async () => {
    const result = await runPageDiff([
      "--id", PAGE_ID, "--from", "2", "--to", "3", "--json",
    ]);

    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stderr).toBe("");
    expect(parseJson(result.stdout)).toMatchObject({
      schemaVersion: "1",
      pageId: PAGE_ID,
      oldVersion: 2,
      newVersion: 3,
      hasChanges: true,
      additions: 1,
      deletions: 1,
    });
    expect(requests).toEqual([
      { method: "GET", pathname: `/rest/api/content/${PAGE_ID}/version/2` },
      { method: "GET", pathname: `/rest/api/content/${PAGE_ID}/version/3` },
    ]);
  }, 30_000);

  it("preserves requested direction for reverse comparisons", async () => {
    const result = await runPageDiff([
      "--id", PAGE_ID, "--from", "3", "--to", "2", "--no-color",
    ]);

    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toContain("Comparing version 3 → 2");
    expect(result.stdout).toContain("-Third content");
    expect(result.stdout).toContain("+Second content");
    expect(result.stdout).not.toContain("\u001b[");
    expect(requests).toEqual([
      { method: "GET", pathname: `/rest/api/content/${PAGE_ID}/version/3` },
      { method: "GET", pathname: `/rest/api/content/${PAGE_ID}/version/2` },
    ]);
  }, 30_000);

  it("reports an exact-version no-op after only one immutable read", async () => {
    const result = await runPageDiff([
      "--id", PAGE_ID, "--from", "2", "--to", "2",
    ]);

    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toBe("No changes between version 2 and version 2.\n");
    expect(requests).toEqual([
      { method: "GET", pathname: `/rest/api/content/${PAGE_ID}/version/2` },
    ]);
  }, 30_000);

  it("supports unified context and both color opt-out mechanisms", async () => {
    const flagResult = await runPageDiff([
      "--id", PAGE_ID, "--from", "2", "--to", "3", "--context", "0", "--no-color",
    ]);
    const environmentResult = await runPageDiff(
      ["--id", PAGE_ID, "--from", "2", "--to", "3"],
      { noColorEnvironment: true },
    );

    expect(flagResult.exitCode, flagResult.stderr).toBe(0);
    expect(environmentResult.exitCode, environmentResult.stderr).toBe(0);
    expect(flagResult.stdout).not.toContain("\u001b[");
    expect(environmentResult.stdout).not.toContain("\u001b[");
    expect(flagResult.stdout).toContain("@@");
    expect(requests).toHaveLength(4);
  }, 30_000);

  it("treats text as an output-compatible explicit alias for unified", async () => {
    const unified = await runPageDiff([
      "--id", PAGE_ID, "--from", "2", "--to", "3", "--format", "unified", "--no-color",
    ]);
    const text = await runPageDiff([
      "--id", PAGE_ID, "--from", "2", "--to", "3", "--format", "text", "--no-color",
    ]);

    expect(unified.exitCode, unified.stderr).toBe(0);
    expect(text.exitCode, text.stderr).toBe(0);
    expect(text.stdout).toBe(unified.stdout);
  }, 30_000);

  it("renders word changes for terminal review without changing the patch", async () => {
    const terminal = await runPageDiff([
      "--id", PAGE_ID, "--from", "2", "--to", "3", "--format", "text",
      "--word-diff", "--no-color",
    ]);
    const json = await runPageDiff([
      "--id", PAGE_ID, "--from", "2", "--to", "3", "--format", "text",
      "--word-diff", "--json",
    ]);

    expect(terminal.exitCode, terminal.stderr).toBe(0);
    expect(terminal.stderr).toBe("");
    expect(terminal.stdout).toContain("~ [-Second-]{+Third+} content");
    expect(terminal.stdout).not.toContain("\u001b[");

    expect(json.exitCode, json.stderr).toBe(0);
    const parsed = parseJson(json.stdout);
    expect(parsed.wordDiff).toContain("~ [-Second-]{+Third+} content");
    expect(parsed.unified).toContain("-Second content");
    expect(parsed.unified).toContain("+Third content");
    expect(json.stdout).not.toContain("\u001b[");
  }, 30_000);

  const usageCases: Array<{ args: string[]; message: string }> = [
    {
      args: ["--id", PAGE_ID, "--format", "side-by-side"],
      message: "--format must be 'unified', 'text', or 'semantic'.",
    },
    {
      args: ["--id", PAGE_ID, "--version", "2", "--from", "1"],
      message: "--version cannot be combined with --from or --to.",
    },
    {
      args: ["--id", PAGE_ID, "--version", "2", "--to", "3"],
      message: "--version cannot be combined with --from or --to.",
    },
    {
      args: ["--id", PAGE_ID, "--to", "3"],
      message: "--to requires --from.",
    },
    {
      args: ["--id", PAGE_ID, "--from", "1.5"],
      message: "--from must be a positive integer.",
    },
    {
      args: ["--id", PAGE_ID, "--from", "9007199254740992"],
      message: "--from exceeds the supported integer range.",
    },
    {
      args: ["--id", PAGE_ID, "--context=-1"],
      message: "--context must be a non-negative integer.",
    },
    {
      args: ["--id", PAGE_ID, "--context=9007199254740992"],
      message: "--context exceeds the supported integer range.",
    },
    {
      args: ["--id", PAGE_ID, "--format", "semantic", "--context", "3"],
      message: "--context is only supported with --format unified or text.",
    },
    {
      args: ["--id", PAGE_ID, "--format", "semantic", "--word-diff"],
      message: "--word-diff is only supported with --format unified or text.",
    },
    {
      args: ["--id", PAGE_ID, "--word-diff=true"],
      message: "--word-diff does not accept a value.",
    },
    {
      args: ["--id", PAGE_ID, "--no-color=true"],
      message: "--no-color does not accept a value.",
    },
    {
      args: ["--id", PAGE_ID, "--from", "1", "--from", "2"],
      message: "--from may only be specified once.",
    },
  ];

  for (const { args, message } of usageCases) {
    it(`fails closed before I/O: ${message}`, async () => {
      const result = await runPageDiff(args);

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe(`${message}\n`);
      expect(requests).toEqual([]);
    }, 30_000);
  }

  it("emits one semantic ChangeSet JSON document and a readable DC terminal diff", async () => {
    const json = await runPageDiff([
      "--id", PAGE_ID, "--from", "2", "--to", "3", "--format", "semantic", "--json",
    ]);
    const terminal = await runPageDiff([
      "--id", PAGE_ID, "--from", "2", "--to", "3", "--format", "semantic", "--no-color",
    ]);

    expect(json.exitCode, json.stderr).toBe(0);
    expect(json.stderr).toBe("");
    const parsed = parseJson(json.stdout);
    expect(json.stdout).toBe(`${JSON.stringify(parsed, null, 2)}\n`);
    expect(parsed).toMatchObject({
      schemaVersion: "1",
      changeSet: {
        schema: "atlcli.change-set/1",
        baseline: { revision: "2", representation: "storage", deployment: "data-center" },
        target: { revision: "3", representation: "storage", deployment: "data-center" },
        summary: { noOp: false },
        limits: { truncated: false },
      },
    });
    expect(json.stdout).not.toContain("\u001b[");

    expect(terminal.exitCode, terminal.stderr).toBe(0);
    expect(terminal.stderr).toBe("");
    expect(terminal.stdout).toContain(
      "Wiki page \"Page Diff CLI Fixture\" — version 2 → 3 (Data Center, Storage)",
    );
    expect(terminal.stdout).toContain("~ Changed Text: “Second content” → “Third content”");
    expect(terminal.stdout).toContain("Summary:");
    expect(terminal.stdout).toContain("Coverage: complete");
    expect(terminal.stdout).not.toContain("content[");
    expect(terminal.stdout).not.toContain('"attributes"');
    expect(terminal.stdout).not.toContain("\u001b[");
    expect(requests.map((request) => `${request.method} ${request.pathname}`).sort()).toEqual([
      `GET /rest/api/content/${PAGE_ID}/version/2`,
      `GET /rest/api/content/${PAGE_ID}/version/2`,
      `GET /rest/api/content/${PAGE_ID}/version/3`,
      `GET /rest/api/content/${PAGE_ID}/version/3`,
    ]);
    expect(requests.some((request) => request.pathname.includes("/api/v2/"))).toBe(false);
  }, 30_000);

  it("uses one exact semantic source for an equal-version no-op", async () => {
    const result = await runPageDiff([
      "--id", PAGE_ID, "--from", "2", "--to", "2", "--format", "semantic", "--json",
    ]);

    expect(result.exitCode, result.stderr).toBe(0);
    expect(parseJson(result.stdout)).toMatchObject({
      changeSet: { summary: { noOp: true }, operations: [] },
    });
    expect(requests).toEqual([
      { method: "GET", pathname: `/rest/api/content/${PAGE_ID}/version/2` },
    ]);
  }, 30_000);

  it("uses exact-version Cloud ADF plus Storage sidecars", async () => {
    const result = await runPageDiff([
      "--profile", "cloud", "--id", PAGE_ID, "--from", "2", "--to", "3",
      "--format", "semantic", "--json",
    ]);

    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stderr).toBe("");
    expect(parseJson(result.stdout)).toMatchObject({
      changeSet: {
        baseline: { revision: "2", representation: "atlas_doc_format", acquisition: "rest-v2" },
        target: { revision: "3", representation: "atlas_doc_format", acquisition: "rest-v2" },
        summary: { noOp: false },
      },
    });
    expect(requests).toHaveLength(4);
    expect(requests.filter((request) => request.pathname.includes("/api/v2/"))).toHaveLength(2);
    for (const version of [2, 3]) {
      const requestUrl = requestUrls.find((value) => {
        const url = new URL(value);
        return url.pathname.includes("/api/v2/") && url.searchParams.get("version") === String(version);
      });
      expect(requestUrl).toBeDefined();
      expect(new URL(requestUrl!).searchParams.get("body-format")).toBe("atlas_doc_format");
    }
  }, 30_000);

  it("falls back both Cloud sides to exact Storage with visible provenance", async () => {
    cloudMode = "fallback";
    const result = await runPageDiff([
      "--profile", "cloud", "--id", PAGE_ID, "--from", "2", "--to", "3",
      "--format", "semantic", "--json",
    ]);

    expect(result.exitCode, result.stderr).toBe(0);
    expect(parseJson(result.stdout)).toMatchObject({
      changeSet: {
        baseline: { representation: "storage", acquisition: "rest-v1" },
        target: { representation: "storage", acquisition: "rest-v1" },
        completeness: {
          diagnostics: [{
            code: "source-fallback",
            severity: "warning",
            message: "Historical Cloud ADF was unavailable; both versions use exact Storage.",
            path: [],
          }],
        },
      },
    });
    expect(requests).toHaveLength(4);
  }, 30_000);

  for (const mode of ["malformed", "mismatch", "denied", "rate-limit", "server-error"] as const) {
    it(`fails closed for Cloud ${mode} without emitting a ChangeSet`, async () => {
      cloudMode = mode;
      const result = await runPageDiff([
        "--profile", "cloud", "--id", PAGE_ID, "--from", "2", "--to", "3",
        "--format", "semantic", "--json",
      ]);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toBe("");
      const parsed = parseJson(result.stdout);
      expect(parsed).toHaveProperty("error");
      expect(parsed).not.toHaveProperty("changeSet");
      expect(result.stdout).not.toContain("Second content");
      expect(result.stdout).not.toContain("Third content");
      expect(requests.every((request) => request.method === "GET")).toBe(true);
    }, 30_000);
  }
});
