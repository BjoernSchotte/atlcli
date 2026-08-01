import { beforeAll, expect, test } from "bun:test";
import { lstat, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { PublicationBuildRequestV1 } from "@atlcli/web-publish";
import { createAstroStaticPublicationBuilderV1 } from "./builder.js";

const fixtureDirectory = resolve(import.meta.dir, "../fixtures/astro-consumer");
const inventoryPath = resolve(fixtureDirectory, "../evidence/build-inventory.json");
const outputDirectory = resolve(fixtureDirectory, "dist");
const workspaceRoot = resolve(import.meta.dir, "../../..");

beforeAll(async () => {
  // The builder intentionally invokes the fixture's normal Astro process,
  // which resolves the package's production export. Build that package here so
  // this unit lane remains self-contained when CI starts from a clean checkout
  // instead of relying on another job's ignored dist/ output.
  const child = Bun.spawn(["bun", "run", "build", "--filter=@atlcli/web-publish-astro"], {
    cwd: workspaceRoot,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stderr] = await Promise.all([
    child.exited,
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) throw new Error(`web-publish-astro package build failed: ${stderr}`);
});

const request = {
  bundle: {
    bundleDigest: "bundle-digest",
    complete: true,
    pages: [{ sourceId: "guide", path: "pages/guide.json", pageDigest: "guide-page" }],
    routes: [{ sourceId: "guide", route: "/guide/", state: "active" }],
    assets: [{
      assetId: "fixture-asset",
      path: "assets/f0dad327e22e8cddc2e8057cf16d9b16ea6e36e87d31f46ee4d5943c69609c4f/fixture.txt",
      sha256: "f0dad327e22e8cddc2e8057cf16d9b16ea6e36e87d31f46ee4d5943c69609c4f",
      byteLength: 14,
      mediaType: "text/plain",
    }],
  },
  project: {
    builder: {
      builder: "astro-static",
      projectDir: fixtureDirectory,
      outputProfile: "directory",
      base: "/docs",
      buildCommand: ["bun", "run", "build"],
    },
    analytics: { provider: "none" },
    search: { languages: ["en"] },
    editLink: { provider: "none" },
  },
  projectDigest: "project-digest",
  configDigest: "config-digest",
  lockfileDigest: "lockfile-digest",
} as unknown as PublicationBuildRequestV1;

function builder(command = request.project.builder.buildCommand) {
  return createAstroStaticPublicationBuilderV1({
    version: "0.1.0-test",
    astroVersion: "7.1.6",
    inventoryPath,
    outputDirectory,
    experience: { id: "test.experience", version: "1", digest: "experience-digest" },
  }).build({
    ...request,
    project: { ...request.project, builder: { ...request.project.builder, buildCommand: command } },
  });
}

test("builder runs the trusted Astro project and consumes only its fresh private inventory", async () => {
  try {
    const result = await builder();
    expect(result.outputDirectory).toBe(outputDirectory);
    expect(result.manifest.builder).toEqual({ id: "astro-static", version: "0.1.0-test", astroVersion: "7.1.6" });
    expect(result.manifest.pages).toEqual([{
      sourceId: "guide",
      route: "/guide/",
      outputPath: "publish/guide/index.html",
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      byteLength: expect.any(Number),
    }]);
    expect(result.manifest).toMatchObject({
      bundleDigest: "bundle-digest",
      builder: { id: "astro-static", astroVersion: "7.1.6" },
      projectDigest: "project-digest",
      configDigest: "config-digest",
      lockfileDigest: "lockfile-digest",
      experience: { id: "test.experience" },
      search: { provider: "pagefind", files: expect.arrayContaining([expect.objectContaining({ path: "pagefind/pagefind.js" })]), languages: ["en"] },
      seo: { digest: expect.stringMatching(/^[a-f0-9]{64}$/u) },
      analytics: { provider: "none" },
      editLinks: { provider: "none", includedSourceIds: [], omittedSourceIds: ["guide"] },
      verification: { valid: true, checkedPages: 1 },
      buildDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
    const html = await readFile(resolve(outputDirectory, "publish/guide/index.html"), "utf8");
    expect(html).toContain('data-atlcli-source-id="guide"');
    expect(await readFile(resolve(outputDirectory, "assets/f0dad327e22e8cddc2e8057cf16d9b16ea6e36e87d31f46ee4d5943c69609c4f/fixture.txt"), "utf8"))
      .toBe("fixture asset\n");

    await expect(builder([process.execPath, "-e", "process.exit(0)"])).rejects.toThrow("ENOENT");
    expect(await readFile(resolve(outputDirectory, "publish/guide/index.html"), "utf8")).toContain("data-atlcli-source-id=\"guide\"");
  } finally {
    await rm(inventoryPath, { force: true });
  }
}, 30_000);

test("cold and warm builds of one immutable bundle produce equivalent semantic manifests", async () => {
  try {
    const cold = await builder();
    const warm = await builder();
    expect(warm.manifest).toEqual(cold.manifest);
  } finally {
    await rm(inventoryPath, { force: true });
  }
}, 60_000);

test("restores the last valid output when a fresh Astro inventory is corrupt", async () => {
  try {
    const first = await builder();
    const outputBefore = await readFile(resolve(outputDirectory, "publish/guide/index.html"), "utf8");
    const inventoryBefore = await readFile(inventoryPath, "utf8");
    const corruptCommand = [
      process.execPath,
      "-e",
      `require("node:fs").writeFileSync(${JSON.stringify(inventoryPath)}, "not-json")`,
    ] as const;
    await expect(builder(corruptCommand)).rejects.toThrow(/JSON Parse error/u);
    expect(await readFile(resolve(outputDirectory, "publish/guide/index.html"), "utf8")).toBe(outputBefore);
    expect(await readFile(inventoryPath, "utf8")).toBe(inventoryBefore);
    expect(first.manifest.verification.valid).toBe(true);
  } finally {
    await rm(inventoryPath, { force: true });
  }
}, 30_000);

test("fails closed on a symlinked output target without touching its referent", async () => {
  const outside = resolve(fixtureDirectory, "../builder-outside");
  try {
    await builder();
    await rm(outside, { recursive: true, force: true });
    await writeFile(outside, "outside output");
    await rm(outputDirectory, { recursive: true, force: true });
    await symlink(outside, outputDirectory);
    await expect(builder()).rejects.toThrow("outputDirectory must be a real directory");
    expect((await lstat(outputDirectory)).isSymbolicLink()).toBe(true);
    expect(await readFile(outside, "utf8")).toBe("outside output");
  } finally {
    await rm(outputDirectory, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
    await rm(inventoryPath, { force: true });
  }
}, 30_000);
