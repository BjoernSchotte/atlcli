import { expect, test } from "bun:test";
import { access, readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";

test("is a Starlight-free Astro render-kit package with an isolated chart runtime", async () => {
  const packageRoot = resolve(import.meta.dir, "..");
  const manifest = JSON.parse(await readFile(resolve(packageRoot, "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
    atlcli?: { publish?: string };
    exports?: Record<string, unknown>;
  };
  expect(manifest.atlcli?.publish).toBe("public-0.x");
  expect(manifest.peerDependencies?.astro).toBe(">=7.1.6 <8");
  expect(manifest.dependencies).toEqual({
    "@atlcli/export-blocks": "workspace:*",
    "@atlcli/export-charts-tanstack": "workspace:*",
    "@tanstack/charts": "0.3.1",
    "d3-scale": "4.0.2",
  });
  expect(manifest.exports).toMatchObject({
    "./fixtures": { default: "./dist/fixtures.js" },
    "./components/Caption.astro": "./dist/components/Caption.astro",
  });
  const source = await readFile(resolve(packageRoot, "src/index.ts"), "utf8");
  expect(source).not.toContain("starlight");
  expect(source).not.toContain("@atlcli/confluence");
  expect(source).not.toContain("@atlcli/web-publish");
  await expect(access(resolve(packageRoot, "src/components/ExportDocument.astro"))).resolves.toBeNull();
  await expect(access(resolve(packageRoot, "src/styles.css"))).resolves.toBeNull();
});

test("render-kit sources expose no implicit acquisition, network, or raw-html sink", async () => {
  const packageRoot = resolve(import.meta.dir, "..");
  const sourceDirectory = resolve(packageRoot, "src");
  async function sourcesAt(directory: string): Promise<Array<{ file: string; source: string }>> {
    const entries = await readdir(directory, { withFileTypes: true });
    return (await Promise.all(entries.map(async (entry) => entry.isDirectory()
      ? sourcesAt(resolve(directory, entry.name))
      : entry.name.endsWith(".test.ts") ? []
      : [{
          file: resolve(directory, entry.name),
          source: await readFile(resolve(directory, entry.name), "utf8"),
        }],
    ))).flat();
  }
  const sources = await sourcesAt(sourceDirectory);
  const trustedChartComponent = resolve(sourceDirectory, "components/ChartBlock.astro");
  const rawHtmlSinks = sources.filter(({ source }) => source.includes("set:html"));
  expect(rawHtmlSinks.map(({ file }) => file)).toEqual([trustedChartComponent]);
  expect(rawHtmlSinks[0]?.source).toContain("This is the only trusted markup seam");
  expect(rawHtmlSinks[0]?.source).toContain("renderTanStackChartSvgV1");
  expect(rawHtmlSinks[0]?.source).toContain("provider HTML never reaches set:html");
  for (const { file, source } of sources) {
    expect(source).not.toContain("fetch(");
    if (file !== trustedChartComponent) expect(source).not.toContain("set:html");
    expect(source).not.toContain("@atlcli/confluence");
    expect(source).not.toContain("from \"node:");
  }
});

test("render-kit has no publishing, host, or runtime-service dependency", async () => {
  const packageRoot = resolve(import.meta.dir, "..");
  const manifest = JSON.parse(await readFile(resolve(packageRoot, "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
    exports?: Record<string, unknown>;
  };
  const dependencyNames = Object.keys({ ...manifest.dependencies, ...manifest.peerDependencies });
  for (const forbidden of ["starlight", "confluence", "pagefind", "web-publish", "auth", "analytics", "service-worker", "workbox", "deployment"]) {
    expect(dependencyNames.some((name) => name.toLowerCase().includes(forbidden))).toBeFalse();
  }
  const source = (await (async function readAll(directory: string): Promise<string> {
    const entries = await readdir(directory, { withFileTypes: true });
    return (await Promise.all(entries.map((entry) => entry.isDirectory()
      ? readAll(resolve(directory, entry.name))
      : entry.name.endsWith(".test.ts") ? ""
      : readFile(resolve(directory, entry.name), "utf8"),
    ))).join("\n");
  })(resolve(packageRoot, "src"))).toLowerCase();
  for (const forbidden of [
    "@atlcli/confluence", "@atlcli/web-publish", "@atlcli/web-publish-astro", "starlight",
    "pagefind", "serviceworker", "service-worker", "caches.", "analytics", "editlink",
    "from \"node:", "from 'node:",
  ]) expect(source).not.toContain(forbidden);
  expect(manifest.exports).not.toHaveProperty("./adf");
  expect(JSON.stringify(manifest.exports)).not.toContain("AdfDocument");
});

test("documents versioned theme variables and semantic hooks instead of generated DOM classes", async () => {
  const packageRoot = resolve(import.meta.dir, "..");
  const [stylesheet, readme] = await Promise.all([
    readFile(resolve(packageRoot, "src/styles.css"), "utf8"),
    readFile(resolve(packageRoot, "README.md"), "utf8"),
  ]);
  for (const hook of ["data-atlcli-document", "data-atlcli-block", "data-atlcli-caption", "data-atlcli-status", "data-atlcli-asset-unresolved"]) {
    expect(readme).toContain(hook);
  }
  for (const variable of ["--atlcli-content-foreground", "--atlcli-content-muted", "--atlcli-content-border", "--atlcli-content-surface", "--atlcli-content-code-background"]) {
    expect(stylesheet).toContain(variable);
    expect(readme).toContain(variable);
  }
});
