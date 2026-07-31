import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const workspaceRoot = resolve(import.meta.dir, "../../..");
const fixtureDirectory = resolve(import.meta.dir, "../fixtures/astro-consumer");

async function run(command: string[], cwd: string): Promise<{ stdout: string; stderr: string }> {
  const process = Bun.spawn(command, { cwd, stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]);
  expect(exitCode, stderr).toBe(0);
  return { stdout, stderr };
}

test("Astro consumer harness loads structured pages and emits a private inventory", async () => {
  await run(["bun", "run", "build", "--filter=@atlcli/web-publish-astro"], workspaceRoot);
  const result = await run(["bun", "run", "build"], fixtureDirectory);
  expect(result.stdout).toContain("loaded 1 structured publication page(s)");

  const html = await readFile(resolve(fixtureDirectory, "dist/publish/guide/index.html"), "utf8");
  expect(html).toContain('data-atlcli-source-id="guide"');
  expect(html).toContain("Structured blocks: 1");
  expect(html).not.toContain("bundle.json");
  const inventory = JSON.parse(
    await readFile(resolve(fixtureDirectory, "../evidence/build-inventory.json"), "utf8"),
  ) as { outputRoot: string; pages: string[]; output: Array<{ path: string }> };
  expect(inventory.outputRoot).toBe("<private>");
  expect(inventory.pages).toEqual(["publish/guide/"]);
  expect(inventory.output).toHaveLength(1);
  expect(inventory.output[0]).toMatchObject({ path: "publish/guide/index.html" });
});
