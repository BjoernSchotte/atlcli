import { expect, test } from "bun:test";
import { readFile, stat } from "node:fs/promises";
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
  expect(html).toContain("Content-Security-Policy");
  expect(html).toContain('script-src \'self\'');
  expect(html).toContain('connect-src \'none\'');
  expect(html).not.toContain("<style");
  expect(html).toContain('<script type="module" src="/_astro/');
  expect(html).not.toContain('<script type="module">');
  expect(html).toContain("<caption><span>Example table</span></caption>");
  expect(html).toContain('data-atlcli-caption data-kind="code"');
  expect(html).toContain('data-atlcli-caption data-kind="figure"');
  expect(html).toContain('input type="checkbox" checked disabled');
  expect(html).toContain('data-atlcli-status data-color="green"');
  expect(html).toContain('href="https://example.test/guide"');
  expect(html).toContain("&lt;not-html-executed /&gt;");
  expect(html).not.toContain("<not-html-executed");
  expect(html).toContain('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;');
  expect(html).toContain('data-atlcli-link-unresolved');
  expect(html).toContain('data-atlcli-asset-unresolved');
  expect(html).toContain("Datasource card");
  expect(html).not.toContain("javascript:alert(1)");
  expect(html).not.toContain("background:url(https://evil.test/x)");
  expect(html).not.toContain("data:image/svg+xml");
  expect(html).not.toContain("opaque-datasource-secret");
  expect(html).not.toContain('accountId="private"');
  expect(html).toContain('data-atlcli-block="chart"');
  expect(html).toContain("Published pages");
  expect(html).toContain('role="img"');
  expect(html).toContain('data-atlcli-chart-island="enabled"');
  expect(html).toContain('data-atlcli-chart-renderer="tanstack-v0.3"');
  const asset = html.match(/src="\/_astro\/([^\"]+)"/)?.[1];
  expect(asset).toBeDefined();
  expect((await stat(resolve(fixture, "dist/_astro", asset!))).size).toBeLessThanOrEqual(100 * 1024);
  expect(html).not.toContain("defineChart");
}, 20_000);
