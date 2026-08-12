import { describe, expect, test } from "bun:test";

async function runCli(args: string[]): Promise<{
  stdout: string;
  stderr: string;
  exitCode: number;
}> {
  const proc = Bun.spawn(
    [
      "bun",
      "--conditions=development",
      "run",
      "apps/cli/src/index.ts",
      ...args,
      "--no-log",
    ],
    {
      cwd: new URL("../../..", import.meta.url).pathname,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, ATLCLI_DISABLE_UPDATE_CHECK: "1" },
    },
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
}

describe("release-info command", () => {
  test("reports versioned source-build provenance as an object", async () => {
    const result = await runCli(["release-info", "--json"]);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual({
      schema: "atlcli.release-info/v1",
      version: "dev",
      channel: "source",
      sourceSha: "unknown",
      buildId: "source",
      releaseTag: null,
      homebrewVersion: null,
    });
  });

  test("keeps version --json backward-compatible as a JSON string", async () => {
    const result = await runCli(["version", "--json"]);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    const parsed = JSON.parse(result.stdout);
    expect(typeof parsed).toBe("string");
    expect(parsed).toContain("atlcli vdev");
  });
});
