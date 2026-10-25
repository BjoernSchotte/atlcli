/** `wiki page copy` help and flag checks through the real CLI (no site needed). */
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { fileURLToPath } from "node:url";
import source from "../builtin-scripts/copy-pages.script" with { type: "text" };

// Spawns the CLI; loaded CI runners need more than Bun's 5 s per test.
setDefaultTimeout(60_000);

const CLI = fileURLToPath(new URL("../index.ts", import.meta.url));

async function run(args: string[]) {
  const proc = Bun.spawn([process.execPath, "--conditions=development", "run", CLI, "wiki", "page", ...args], {
    env: { ...process.env, ATLCLI_DISABLE_UPDATE_CHECK: "1" },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { stdout, stderr, exitCode };
}

describe("wiki page copy", () => {
  test("documents tree and template flags", async () => {
    const { stdout } = await run(["--help"]);
    for (const flag of ["--tree", "--no-attachments", "--vars-file", "--now", "--strict", "--apply"]) expect(stdout).toContain(flag);
  }, 30_000);

  test("prints the built-in tree script", async () => {
    const { stdout, exitCode } = await run(["copy", "--print-script"]);
    expect(exitCode).toBe(0);
    expect(stdout).toBe(source);
  }, 30_000);

  test.each([
    [["copy"], "--id is required"],
    [["copy", "--id", "abc"], "page id"],
    [["copy", "--id", "1", "--now", "soon"], "--now"],
  ])("rejects %j", async (args, message) => {
    const { stdout, stderr, exitCode } = await run(args as string[]);
    expect(exitCode).not.toBe(0);
    expect(stdout + stderr).toContain(message);
  }, 30_000);
});
