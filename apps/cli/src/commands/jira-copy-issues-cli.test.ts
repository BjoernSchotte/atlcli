/**
 * `jira project copy-issues` flag handling through the real CLI. Planning
 * itself is covered by builtin-scripts/copy-issues.test.ts.
 */
import { describe, expect, it } from "bun:test";
import { fileURLToPath } from "node:url";
import source from "../builtin-scripts/copy-issues.script" with { type: "text" };

const CLI = fileURLToPath(new URL("../index.ts", import.meta.url));

async function run(args: string[]) {
  const proc = Bun.spawn([process.execPath, "--conditions=development", "run", CLI, "jira", "project", "copy-issues", ...args], {
    env: { ...process.env, ATLCLI_DISABLE_UPDATE_CHECK: "1" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { stdout, stderr, exitCode };
}

describe("jira project copy-issues", () => {
  it("prints the built-in script", async () => {
    const { stdout, exitCode } = await run(["--print-script"]);
    expect(exitCode).toBe(0);
    expect(stdout).toBe(source);
  }, 30_000);

  it.each([
    [["--from", "SUP"], "--to <project> is required"],
    [["--to", "DEV"], "Pass --from <project>"],
    [["--from", "DEV", "--to", "DEV"], "same project"],
    [["--from", "sup", "--to", "DEV"], "project key"],
    [["--jql", "project = SUP ORDER BY key", "--to", "DEV"], "ORDER BY"],
    [["--from", "SUP", "--to", "DEV", "--replace", "novalue"], "find:replace"],
    [["--from", "SUP", "--to", "DEV", "--fields", "a b;c"], "--fields"],
  ])("rejects %j", async (args, message) => {
    const { stderr, stdout, exitCode } = await run(args as string[]);
    expect(exitCode).not.toBe(0);
    expect(stderr + stdout).toContain(message);
  }, 30_000);
});
