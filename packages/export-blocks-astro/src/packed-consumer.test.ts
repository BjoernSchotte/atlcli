import { expect, test } from "bun:test";
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const workspaceRoot = resolve(import.meta.dir, "../../..");
const fixtureDirectory = resolve(workspaceRoot, "packages/export-blocks-astro/fixtures/plain-astro");

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

async function packPackage(name: "export-blocks" | "export-blocks-astro" | "export-charts-tanstack", destination: string): Promise<string> {
  await run(["bun", "pm", "pack", "--destination", destination], join(workspaceRoot, "packages", name));
  const tarballs = (await readdir(destination)).filter((entry) => entry.endsWith(".tgz"));
  expect(tarballs).toHaveLength(1);
  return join(destination, tarballs[0]!);
}

test("a network-disabled, packed plain-Astro consumer keeps overrides and static fallbacks", async () => {
  const root = await mkdtemp(join(tmpdir(), "atlcli-export-blocks-astro-packed-"));
  const tarballs = join(root, "tarballs");
  const consumer = join(root, "consumer");
  try {
    await run(["bun", "run", "build", "--filter=@atlcli/export-blocks-astro"], workspaceRoot);
    const [exportBlocks, exportBlocksAstro, exportChartsTanStack] = await Promise.all([
      packPackage("export-blocks", join(tarballs, "export-blocks")),
      packPackage("export-blocks-astro", join(tarballs, "export-blocks-astro")),
      packPackage("export-charts-tanstack", join(tarballs, "export-charts-tanstack")),
    ]);
    await cp(fixtureDirectory, consumer, {
      recursive: true,
      filter: (source) => !source.includes("/dist"),
    });
    const pagePath = join(consumer, "src/pages/index.astro");
    const page = await readFile(pagePath, "utf8");
    await writeFile(pagePath, page
      .replace('import { chartWorldClassBlocksV1 } from "@atlcli/export-fixtures";', 'import { EXPORT_BLOCKS_ASTRO_CHART_SHAPES_FIXTURE_V1 } from "@atlcli/export-blocks-astro/fixtures";')
      .replace("const WORLD_CLASS_CHART_BLOCKS_V1 = chartWorldClassBlocksV1();", "const WORLD_CLASS_CHART_BLOCKS_V1 = EXPORT_BLOCKS_ASTRO_CHART_SHAPES_FIXTURE_V1;"));
    await writeFile(join(consumer, "package.json"), JSON.stringify({
      name: "packed-export-blocks-astro-consumer",
      private: true,
      type: "module",
      scripts: { build: "astro build" },
      dependencies: {
        "@atlcli/export-blocks": `file:${exportBlocks}`,
        "@atlcli/export-blocks-astro": `file:${exportBlocksAstro}`,
        "@atlcli/export-charts-tanstack": `file:${exportChartsTanStack}`,
        astro: "7.1.6",
      },
      overrides: {
        "@atlcli/export-blocks": `file:${exportBlocks}`,
        "@atlcli/export-charts-tanstack": `file:${exportChartsTanStack}`,
      },
    }, null, 2));
    await writeFile(join(consumer, "block-network.mjs"), "globalThis.fetch = async () => { throw new Error('network access is forbidden'); };\n");
    await writeFile(join(consumer, "assert-packed.mjs"), [
      "import { existsSync } from 'node:fs';",
      "const value = import.meta.resolve('@atlcli/export-blocks-astro');",
      "if (!value.includes('/node_modules/')) throw new Error('expected a packed install');",
      "for (const name of ['@atlcli/web-publish', '@atlcli/web-publish-astro', '@atlcli/web-publish-starlight', '@atlcli/confluence', 'pagefind']) {",
      "  if (existsSync(new URL(`node_modules/${name}/`, import.meta.url))) throw new Error(`forbidden render-kit dependency: ${name}`);",
      "}",
    ].join("\n"));
    await run(["bun", "install", "--offline"], consumer);
    await run(["bun", "assert-packed.mjs"], consumer);
    const output = await run(["bun", "run", "--preload", "./block-network.mjs", "build"], consumer);
    expect(output).toContain("1 page(s) built");
    const html = await readFile(join(consumer, "dist/index.html"), "utf8");
    expect(html).toContain("data-fixture-trusted-override");
    expect(html).toContain('data-atlcli-chart-island="enabled"');
    expect(html).toContain('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 120_000);
