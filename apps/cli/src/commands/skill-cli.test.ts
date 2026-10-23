/**
 * `atlcli skill` through the real entry point: dispatch, the global `--help`
 * routing and the root help live in `index.ts`, which runs `main()` on import
 * and can only be exercised as a process.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SKILL_FILES } from "../skill-files.js";
import { skillHelp } from "./skill.js";

let home: string;

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), "atlcli-skill-cli-home-"));
});

afterAll(async () => {
  if (home) await rm(home, { recursive: true, force: true });
});

async function runCli(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn(["bun", "--conditions=development", "run", "apps/cli/src/index.ts", ...args, "--no-log"], {
    cwd: new URL("../../../..", import.meta.url).pathname,
    stdout: "pipe",
    stderr: "pipe",
    // `main()` loads plugins and config from the home directory before it
    // dispatches; an empty home keeps the developer's own setup out of the run.
    env: { ...process.env, HOME: home, USERPROFILE: home, ATLCLI_DISABLE_UPDATE_CHECK: "1" },
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
}

describe("atlcli skill from the command line", () => {
  test("prints SKILL.md", async () => {
    const result = await runCli(["skill"]);
    expect(result.stdout).toBe(SKILL_FILES[0]!.content);
    expect(result.exitCode).toBe(0);
  }, 30_000);

  test("prints the command help for --help", async () => {
    const result = await runCli(["skill", "--help"]);
    expect(result.stdout).toBe(`${skillHelp()}\n`);
  }, 30_000);

  test("lists the command in the root help", async () => {
    const result = await runCli(["--help"]);
    expect(result.stdout).toContain("\n  skill        Print or install the agent skill\n");
  }, 30_000);

  test("--json and --list are switches, so they never swallow the path", async () => {
    const json = await runCli(["skill", "--json", "references/safety.md"]);
    expect(json.exitCode).toBe(0);
    expect(JSON.parse(json.stdout).path).toBe("references/safety.md");

    const list = await runCli(["skill", "--list", "references/safety.md"]);
    expect(list.exitCode).toBe(1);
    expect(list.stderr).toContain("Use only one of <path>, --list and --install");
  }, 30_000);

  test("fails with a structured usage error for an unknown file", async () => {
    const result = await runCli(["skill", "references/nope.md", "--json"]);
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout).error.code).toBe("ATLCLI_ERR_USAGE");
  }, 30_000);
});
