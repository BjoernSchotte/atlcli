import { expect, test } from "bun:test";
import { readFile, rm, stat } from "node:fs/promises";
import { resolve } from "node:path";

const packageRoot = resolve(import.meta.dir, "..");
const workspaceRoot = resolve(packageRoot, "../..");
const fixture = resolve(packageRoot, "fixtures/starlight");

async function run(command: string[], cwd: string): Promise<string> {
  const process = Bun.spawn(command, { cwd, stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]);
  expect(exitCode, stderr).toBe(0);
  return stdout;
}

test("a Starlight consumer presents ExportBlock document bodies with static search assets", async () => {
  await run(["bun", "run", "build", "--filter=@atlcli/export-blocks-astro"], workspaceRoot);
  await run(["bun", "run", "build", "--filter=@atlcli/web-publish-starlight"], workspaceRoot);
  await rm(resolve(fixture, ".astro"), { recursive: true, force: true });
  const output = await run(["bun", "run", "build"], fixture);
  expect(output).toContain("1 page(s) built");

  const html = await readFile(resolve(fixture, "dist/index.html"), "utf8");
  expect(html).toContain('data-atlcli-starlight-slot="main-content"');
  expect(html).toContain('data-atlcli-block="callout"');
  expect(html).toContain('data-atlcli-code-renderer="starlight-expressive-code"');
  expect(html).toContain("data-code=\"const source = &#x27;ExportBlock[]&#x27;;\"");
  expect(html).toContain("This body was published from ExportBlock[], not Markdown.");
  expect(html).toContain("sidebar-pane");
  expect(html).toContain("Release notes");
  expect(html).toContain("pagefind");
  expect(html).not.toContain("exportBlockKind");
  expect(await stat(resolve(fixture, "dist/pagefind/pagefind.js"))).toBeDefined();
}, 30_000);
