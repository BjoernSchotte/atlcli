import { expect, test } from "bun:test";
import { access, readFile } from "node:fs/promises";
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
    "@tanstack/charts": "0.3.1",
    "d3-scale": "4.0.2",
  });
  expect(manifest.exports).toMatchObject({ "./fixtures": { default: "./dist/fixtures.js" } });
  const source = await readFile(resolve(packageRoot, "src/index.ts"), "utf8");
  expect(source).not.toContain("starlight");
  expect(source).not.toContain("@atlcli/confluence");
  expect(source).not.toContain("@atlcli/web-publish");
  await expect(access(resolve(packageRoot, "src/components/ExportDocument.astro"))).resolves.toBeNull();
  await expect(access(resolve(packageRoot, "src/styles.css"))).resolves.toBeNull();
});

test("render-kit sources expose no implicit acquisition, network, or raw-html sink", async () => {
  const packageRoot = resolve(import.meta.dir, "..");
  const sources = await Promise.all([
    "src/index.ts", "src/contracts.ts", "src/components/ExportDocument.astro",
    "src/components/Block.astro", "src/components/Inline.astro", "src/components/InlineNode.astro",
    "src/components/InteractiveChart.astro", "src/components/chart-island-client.ts", "src/security.ts",
  ].map((path) => readFile(resolve(packageRoot, path), "utf8")));
  for (const source of sources) {
    expect(source).not.toContain("fetch(");
    expect(source).not.toContain("set:html");
    expect(source).not.toContain("@atlcli/confluence");
    expect(source).not.toContain("from \"node:");
  }
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
