import { expect, test } from "bun:test";
import { readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import type { PublicationBuildRequestV1 } from "@atlcli/web-publish";
import { createAstroStaticPublicationBuilderV1 } from "./builder.js";

const fixtureDirectory = resolve(import.meta.dir, "../fixtures/astro-consumer");
const inventoryPath = resolve(fixtureDirectory, "../evidence/build-inventory.json");
const outputDirectory = resolve(fixtureDirectory, "dist");

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
    const html = await readFile(resolve(outputDirectory, "publish/guide/index.html"), "utf8");
    expect(html).toContain('data-atlcli-source-id="guide"');
    expect(await readFile(resolve(outputDirectory, "assets/f0dad327e22e8cddc2e8057cf16d9b16ea6e36e87d31f46ee4d5943c69609c4f/fixture.txt"), "utf8"))
      .toBe("fixture asset\n");

    await expect(builder([process.execPath, "-e", "process.exit(0)"])).rejects.toThrow("ENOENT");
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
