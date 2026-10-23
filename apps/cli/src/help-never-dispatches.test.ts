/**
 * Regression #270: `--help` on a verb of the jira, auth, config, flag, log,
 * plugin or completion groups ran the verb. Real CLI against a stand-in server
 * that records every request; a sandboxed HOME whose config must not change.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("./index.ts", import.meta.url));
let server: ReturnType<typeof Bun.serve>;
let home: string;
let config: string;
const requests: string[] = [];

beforeAll(async () => {
  server = Bun.serve({
    port: 0,
    fetch(req) {
      requests.push(`${req.method} ${new URL(req.url).pathname}`);
      return Response.json({});
    },
  });
  home = await mkdtemp(join(tmpdir(), "atlcli-help-home-"));
  await mkdir(join(home, ".atlcli"), { recursive: true });
  config = join(home, ".atlcli", "config.json");
  await writeFile(
    config,
    JSON.stringify({
      currentProfile: "stub",
      profiles: { stub: { name: "stub", baseUrl: server.url.origin, deploymentType: "data-center", auth: { type: "bearer" } } },
    })
  );
});

afterAll(async () => {
  server?.stop(true);
  await rm(home, { recursive: true, force: true });
});

const CASES: Array<[string[], string]> = [
  [["jira", "watchers", "PROJ-1", "--help", "--json"], "atlcli jira"],
  [["jira", "watch", "PROJ-1", "--help"], "atlcli jira"],
  [["jira", "search", "--help"], "atlcli jira"],
  [["jira", "issue", "delete", "--key", "PROJ-1", "--confirm", "--help"], "jira issue"],
  [["jira", "issue", "attachment", "download", "PROJ-1", "x.txt", "--help"], "download <issue-key> <filename>"],
  [["auth", "logout", "stub", "--help"], "Manage authentication profiles"],
  [["config", "set", "defaults.space", "X", "--help"], "config"],
  [["flag", "set", "audit", "true", "--help"], "flag"],
  [["log", "clear", "--help"], "Clear old log files"],
  [["plugin", "install", "./nowhere", "--help"], "plugin"],
  [["completion", "zsh", "--help"], "completion"],
  [["audit", "jira", "--help"], "Usage: atlcli audit jira"],
  [["audit", "wiki", "--help"], "Usage: atlcli audit wiki"],
];

test.each(CASES)("%p prints help and runs nothing", async (args, helpText) => {
  const before = await readFile(config, "utf8");
  const proc = Bun.spawn([process.execPath, "--conditions=development", "run", CLI, ...args], {
    env: { ...process.env, HOME: home, USERPROFILE: home, ATLCLI_API_TOKEN: "stub-token", ATLCLI_DISABLE_UPDATE_CHECK: "1" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  expect(exitCode, stderr).toBe(0);
  // Under --json the help is text on stderr; stdout carries no extra JSON document (#301).
  expect(args.includes("--json") ? stderr : stdout).toContain(helpText);
  if (args.includes("--json")) expect(stdout).toBe("");
  expect(stdout).not.toContain("#compdef");
  expect(requests).toEqual([]);
  expect(await readFile(config, "utf8")).toBe(before);
}, 30_000);
