import { expect, test } from "bun:test";
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

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

async function packPackage(name: string, destination: string): Promise<string> {
  const packageDirectory = resolve(workspaceRoot, "packages", name);
  await run(["bun", "pm", "pack", "--destination", destination], packageDirectory);
  const tarballs = (await readdir(destination)).filter((entry) => entry.endsWith(".tgz"));
  expect(tarballs).toHaveLength(1);
  return join(destination, tarballs[0]!);
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

test("packed integration builds a clean Astro project with fetch disabled", async () => {
  const root = await mkdtemp(join(tmpdir(), "atlcli-web-publish-astro-packed-"));
  const tarballDirectory = join(root, "tarballs");
  const consumerDirectory = join(root, "consumer");
  try {
    await run(["bun", "run", "build", "--filter=@atlcli/web-publish-astro"], workspaceRoot);
    const [exportBlocks, webPublish, webPublishAstro] = await Promise.all([
      packPackage("export-blocks", join(tarballDirectory, "export-blocks")),
      packPackage("web-publish", join(tarballDirectory, "web-publish")),
      packPackage("web-publish-astro", join(tarballDirectory, "web-publish-astro")),
    ]);
    await cp(fixtureDirectory, consumerDirectory, {
      recursive: true,
      filter: (source) => !source.includes("/dist") && !source.includes("/evidence"),
    });
    await writeFile(join(consumerDirectory, "package.json"), JSON.stringify({
      name: "packed-astro-publication-consumer",
      private: true,
      type: "module",
      scripts: { build: "astro build" },
      dependencies: {
        "@atlcli/web-publish-astro": `file:${webPublishAstro}`,
        astro: "7.1.6",
      },
      overrides: {
        "@atlcli/export-blocks": `file:${exportBlocks}`,
        "@atlcli/web-publish": `file:${webPublish}`,
      },
    }, null, 2));
    await writeFile(join(consumerDirectory, "block-network.mjs"), [
      "globalThis.fetch = async () => { throw new Error('network access is forbidden during static publication build'); };",
    ].join("\n"));
    await writeFile(join(consumerDirectory, "assert-packed.mjs"), [
      "const resolved = import.meta.resolve('@atlcli/web-publish-astro');",
      "if (!resolved.includes('/node_modules/')) throw new Error(`expected installed package, received ${resolved}`);",
    ].join("\n"));
    await run(["bun", "install", "--offline"], consumerDirectory);
    await run(["bun", "assert-packed.mjs"], consumerDirectory);
    const result = await run(
      ["bun", "run", "--preload", "./block-network.mjs", "build"],
      consumerDirectory,
    );
    expect(result.stdout).toContain("1 page(s) built");
    const html = await readFile(join(consumerDirectory, "dist/publish/guide/index.html"), "utf8");
    expect(html).toContain("Structured blocks: 1");
    expect(html).not.toContain("bundle.json");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 120_000);
