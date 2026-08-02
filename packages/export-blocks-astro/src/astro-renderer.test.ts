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
  expect(html).toContain('data-atlcli-image-mode="astro-responsive"');
  expect(html).toContain('srcset="/assets/diagram.svg 320w, /assets/diagram.svg 960w"');
  expect(html).toContain('sizes="(max-width: 60rem) 100vw, 60rem"');
  expect(html).toContain('data-atlcli-original-download');
  expect(html).toContain("Content-Security-Policy");
  expect(html).toContain('<meta charset="utf-8">');
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
  expect(html).toContain("Synthetic security escaping proof");
  expect(html).toContain("They are not publication content.");
  expect(html).toContain("Synthetic datasource-card fallback");
  expect(html).toContain("Synthetic unsafe link (must remain inert)");
  expect(html).not.toContain("javascript:alert(1)");
  expect(html).not.toContain("background:url(https://evil.test/x)");
  expect(html).not.toContain("data:image/svg+xml");
  expect(html).not.toContain("javascript:alert(1)");
  expect(html).not.toContain("evil.test/private.svg");
  expect(html).not.toContain("opaque-datasource-secret");
  expect(html).not.toContain('accountId="private"');
  expect(html).toContain("data-fixture-trusted-override");
  expect(html).toContain('dir="rtl"');
  expect(html).toContain('data-atlcli-block="chart"');
  expect(html).toContain('data-atlcli-chart-kind="bar"');
  expect(html).toContain('aria-label="Normalized chart data"');
  expect(html).toContain('data-atlcli-chart-data-display="hidden"');
  expect(html).toContain("Published pages");
  expect(html).toContain('role="img"');
  expect(html).toContain('data-atlcli-chart-island="enabled"');
  expect(html).toContain('data-atlcli-chart-island="static"');
  expect(html).toContain('data-atlcli-chart-renderer="tanstack-v0.3"');
  expect(html).toContain('data-atlcli-chart-capability="tanstack-v0.3/bar"');
  expect(html).toContain('data-atlcli-chart-diagnostics="true"');
  expect(html).toContain('data-atlcli-chart-budget-fallback');
  expect(html).toContain("Static chart visual unavailable within the configured resource budget.");
  expect(html).toContain("The static chart exceeded its scene-nodes budget");
  expect(html).toContain("One malformed source row was skipped.");
  for (const kind of [
    "pie", "bar", "line", "area", "xyArea", "xyBar", "xyLine", "xyStep",
    "xyStepArea", "scatter", "timeSeries", "gantt",
  ]) expect(html).toContain(`data-atlcli-chart-kind="${kind}"`);
  expect(html).toContain('data-atlcli-chart-legend');
  expect(html).toContain('data-atlcli-chart-adapter="tanstack-v0.3/all-static"');
  expect(html).toContain('data-atlcli-chart-visual="tanstack-svg"');
  expect(html).toContain('aria-label="Portfolio allocation scrollable chart visual" tabindex="0"');
  expect(html).toContain('data-atlcli-chart-kind="pie"');
  expect(html).toContain('class="ts-chart__arc"');
  expect(html).toContain('class="ts-chart__line"');
  expect(html).toContain('class="ts-chart__area"');
  expect(html).toContain('class="ts-chart__dot"');
  expect(html).toContain('data-atlcli-chart-kind="xyBar"');
  expect(html).toContain('data-atlcli-chart-kind="gantt"');
  expect(html).toContain('class="ts-chart__arrow"');
  expect(html).toContain("Quarterly variance");
  expect(html).toContain("2026-01-01");
  expect(html).toContain("65%");
  expect(html).toContain("&lt;/text&gt;&lt;script&gt;alert(3)&lt;/script&gt;");
  expect(html).not.toContain("</text><script>alert(3)</script>");
  expect(html).not.toContain("<foreignObject>");
  expect(html).toContain("Hostile &quot;&gt;&lt;img src=x onerror=alert(2)&gt;");
  expect(html).not.toContain('\"><img src=x onerror=alert(2)>');
  const asset = html.match(/src="\/_astro\/([^\"]+)"/)?.[1];
  expect(asset).toBeDefined();
  expect((await stat(resolve(fixture, "dist/_astro", asset!))).size).toBeLessThanOrEqual(100 * 1024);
  expect(html).not.toContain("defineChart");
  const stylesheet = html.match(/href="\/_astro\/([^\"]+\.css)"/)?.[1];
  expect(stylesheet).toBeDefined();
  const css = await readFile(resolve(fixture, "dist/_astro", stylesheet!), "utf8");
  expect(css).toContain("--atlcli-content-foreground:#172b4d");
  expect(css).toContain("[data-atlcli-chart-visual] svg{min-width:40rem}");
  expect(css).toContain("@media print");
  const golden = JSON.parse(await readFile(resolve(fixture, "semantic-golden.json"), "utf8")) as {
    blockTypes: string[];
    trustedHeadingOverride: boolean;
    rtlDocument: boolean;
    staticChartFallback: boolean;
    hostileValuesInert: boolean;
  };
  const semantic = {
    blockTypes: [...new Set(Array.from(html.matchAll(/data-atlcli-block="([^"]+)"/g), (match) => match[1]!))].sort(),
    trustedHeadingOverride: html.includes("data-fixture-trusted-override"),
    rtlDocument: html.includes('dir="rtl"'),
    staticChartFallback: html.includes('data-atlcli-chart-island="enabled"') && html.includes('role="img"'),
    hostileValuesInert: !html.includes("javascript:alert(1)") && !html.includes("data:image/svg+xml"),
  };
  expect(semantic).toEqual({ ...golden, blockTypes: [...golden.blockTypes].sort() });
}, 20_000);
