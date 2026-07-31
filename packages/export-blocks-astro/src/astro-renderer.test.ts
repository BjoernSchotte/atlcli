import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const packageRoot = resolve(import.meta.dir, "..");
const fixture = resolve(packageRoot, "fixtures/plain-astro");

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

test("plain Astro consumer renders every normalized discriminator without raw HTML execution", async () => {
  await run(["bun", "run", "build", "--filter=@atlcli/export-blocks-astro"], resolve(packageRoot, "../.."));
  const output = await run(["bun", "run", "build"], fixture);
  expect(output).toContain("1 page(s) built");
  const html = await readFile(resolve(fixture, "dist/index.html"), "utf8");
  for (const kind of [
    "heading", "paragraph", "smart-card", "code", "callout", "expand", "list", "layout",
    "table", "image", "media-fallback", "blockquote", "divider", "page-break", "orientation",
    "anchor", "unknown",
  ]) expect(html).toContain(`data-atlcli-block=\"${kind}\"`);
  expect(html).toContain('src="/assets/diagram.svg"');
  expect(html).toContain("<caption><span>Example table</span></caption>");
  expect(html).toContain('data-atlcli-caption data-kind="code"');
  expect(html).toContain('data-atlcli-caption data-kind="figure"');
  expect(html).toContain('input type="checkbox" checked disabled');
  expect(html).toContain('data-atlcli-status data-color="green"');
  expect(html).toContain('href="https://example.test/guide"');
  expect(html).toContain("&lt;not-html-executed /&gt;");
  expect(html).not.toContain("<not-html-executed");
  expect(html).not.toContain("<script");
}, 20_000);
