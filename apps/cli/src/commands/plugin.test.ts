import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const cliPath = join(import.meta.dir, "..", "index.ts");
let testHome: string | null = null;

async function runCli(...args: string[]): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
}> {
  if (!testHome) {
    testHome = await mkdtemp(join(tmpdir(), "atlcli-plugin-command-test-"));
  }

  const proc = Bun.spawn(
    [process.execPath, "--conditions=development", "run", cliPath, ...args],
    {
      cwd: testHome,
      env: {
        ...process.env,
        HOME: testHome,
        USERPROFILE: testHome,
        ATLCLI_DISABLE_UPDATE_CHECK: "1",
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  return { exitCode, stdout, stderr };
}

afterEach(async () => {
  if (testHome) {
    await rm(testHome, { recursive: true, force: true });
    testHome = null;
  }
});

describe("plugin command", () => {
  test(
    "enables and disables the bundled git plugin on a fresh install",
    async () => {
      const initialList = await runCli("plugin", "list");
      expect(initialList.exitCode).toBe(0);
      expect(initialList.stdout).toContain("git@1.0.0 (disabled)");
      expect(initialList.stdout).toContain("Source: builtin (builtin:git)");

      const enabled = await runCli("plugin", "enable", "git");
      expect(enabled).toEqual({
        exitCode: 0,
        stdout: "Enabled plugin: git\n",
        stderr: "",
      });

      const config = JSON.parse(
        await readFile(join(testHome!, ".atlcli", "plugins.json"), "utf-8"),
      );
      expect(config.plugins).toContainEqual({
        name: "git",
        version: "1.0.0",
        source: "builtin",
        location: "builtin:git",
        enabled: true,
      });

      const command = await runCli("git", "hook", "status");
      expect(command).toEqual({
        exitCode: 0,
        stdout: "Status: Not a git repository\n",
        stderr: "",
      });

      const enabledList = await runCli("plugin", "list");
      expect(enabledList.exitCode).toBe(0);
      expect(enabledList.stdout).toContain("git@1.0.0 (enabled)");

      const disabled = await runCli("plugin", "disable", "git");
      expect(disabled).toEqual({
        exitCode: 0,
        stdout: "Disabled plugin: git\n",
        stderr: "",
      });

      const disabledList = await runCli("plugin", "list");
      expect(disabledList.exitCode).toBe(0);
      expect(disabledList.stdout).toContain("git@1.0.0 (disabled)");
    },
    30_000,
  );
});
