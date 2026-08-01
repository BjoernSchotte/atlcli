import { expect, test } from "bun:test";
import type { PublicationBuildRequestV1 } from "@atlcli/web-publish";
import { createAstroStaticPublicationManifestV1 } from "./manifest.js";

const request = {
  bundle: {
    bundleDigest: "bundle", pages: [{ sourceId: "guide", path: "pages/guide.json", pageDigest: "page" }],
    routes: [{ sourceId: "guide", route: "/guide/", state: "active" }], assets: [],
  },
  project: { builder: { base: "/docs", outputProfile: "directory" }, analytics: { provider: "none" }, search: { languages: ["en"] }, editLink: { provider: "none" } },
  projectDigest: "project", configDigest: "config", lockfileDigest: "lock",
} as unknown as PublicationBuildRequestV1;

test("creates a digest-bound manifest only from exact page inventory records", async () => {
  const manifest = await createAstroStaticPublicationManifestV1({
    request,
    inventory: { schema: "atlcli.astro-build-inventory/1", bundleDigest: "bundle", pages: [{ kind: "page", sourceId: "guide", route: "/guide/", pathname: "publish/guide/" }], output: [{ path: "publish/guide/index.html", sha256: "a".repeat(64), byteLength: 7 }, { path: "pagefind/index.js", sha256: "b".repeat(64), byteLength: 3 }] },
    builderVersion: "1.0.0", astroVersion: "7.1.6", experience: { id: "test", version: "1", digest: "x" },
  });
  expect(manifest.pages).toEqual([{ sourceId: "guide", route: "/guide/", outputPath: "publish/guide/index.html", sha256: "a".repeat(64), byteLength: 7 }]);
  expect(manifest.search.files).toHaveLength(1);
  expect(manifest.buildDigest).toMatch(/^[a-f0-9]{64}$/u);
  await expect(createAstroStaticPublicationManifestV1({
    request,
    inventory: { schema: "atlcli.astro-build-inventory/1", bundleDigest: "wrong", pages: [], output: [] },
    builderVersion: "1", astroVersion: "7", experience: { id: "test", version: "1", digest: "x" },
  })).rejects.toThrow("does not belong");
  await expect(createAstroStaticPublicationManifestV1({
    request,
    inventory: {
      schema: "atlcli.astro-build-inventory/1", bundleDigest: "bundle",
      pages: [{ kind: "page", sourceId: "guide", route: "/guide/", pathname: "publish/guide/" }],
      output: [{ path: "publish/guide/index.html", sha256: "a".repeat(64), byteLength: 7 }, { path: "private/source.json", sha256: "b".repeat(64), byteLength: 3 }],
    },
    builderVersion: "1", astroVersion: "7", experience: { id: "test", version: "1", digest: "x" },
  })).rejects.toThrow("unexplained output path");
  await expect(createAstroStaticPublicationManifestV1({
    request,
    inventory: {
      schema: "atlcli.astro-build-inventory/1", bundleDigest: "bundle",
      pages: [{ kind: "page", sourceId: "guide", route: "/different/", pathname: "publish/guide/" }],
      output: [{ path: "publish/guide/index.html", sha256: "a".repeat(64), byteLength: 7 }],
    },
    builderVersion: "1", astroVersion: "7", experience: { id: "test", version: "1", digest: "x" },
  })).rejects.toThrow("does not match publication page");
});

test("accepts planned label landing output but rejects an unexplained landing source", async () => {
  const options = {
    request,
    inventory: {
      schema: "atlcli.astro-build-inventory/1" as const,
      bundleDigest: "bundle",
      pages: [{ kind: "page" as const, sourceId: "guide", route: "/guide/", pathname: "publish/guide/" }],
      labelLandings: [{
        kind: "label" as const,
        label: "Guides",
        slug: "guides",
        route: "/topics/guides/",
        sourceIds: ["guide"],
        pathname: "publish/topics/guides/",
      }],
      output: [
        { path: "publish/guide/index.html", sha256: "a".repeat(64), byteLength: 7 },
        { path: "publish/topics/guides/index.html", sha256: "b".repeat(64), byteLength: 9 },
      ],
    },
    builderVersion: "1.0.0",
    astroVersion: "7.1.6",
    experience: { id: "test", version: "1", digest: "x" },
  };
  await expect(createAstroStaticPublicationManifestV1(options)).resolves.toMatchObject({
    pages: [{ sourceId: "guide", outputPath: "publish/guide/index.html" }],
  });
  await expect(createAstroStaticPublicationManifestV1({
    ...options,
    inventory: {
      ...options.inventory,
      labelLandings: [{ ...options.inventory.labelLandings[0]!, sourceIds: ["unknown"] }],
    },
  })).rejects.toThrow("references unknown page");
});

test("accepts only explicitly inventoried trusted project pages", async () => {
  const options = {
    request,
    inventory: {
      schema: "atlcli.astro-build-inventory/1" as const,
      bundleDigest: "bundle",
      pages: [{ kind: "page" as const, sourceId: "guide", route: "/guide/", pathname: "publish/guide/" }],
      projectPages: [{ kind: "project" as const, pathname: "404/" }, { kind: "project" as const, pathname: "" }],
      output: [
        { path: "publish/guide/index.html", sha256: "a".repeat(64), byteLength: 7 },
        { path: "404/index.html", sha256: "b".repeat(64), byteLength: 9 },
        { path: "index.html", sha256: "e".repeat(64), byteLength: 9 },
      ],
    },
    builderVersion: "1.0.0",
    astroVersion: "7.1.6",
    experience: { id: "test", version: "1", digest: "x" },
  };
  await expect(createAstroStaticPublicationManifestV1(options)).resolves.toMatchObject({
    pages: [{ sourceId: "guide" }],
  });
  await expect(createAstroStaticPublicationManifestV1({
    ...options,
    inventory: { ...options.inventory, projectPages: [{ kind: "project" as const, pathname: "404/" }, { kind: "project" as const, pathname: "404/" }] },
  })).rejects.toThrow("duplicate trusted project output");
  await expect(createAstroStaticPublicationManifestV1({
    ...options,
    inventory: { ...options.inventory, output: [options.inventory.output[0]!, { path: "404.html", sha256: "c".repeat(64), byteLength: 9 }, { path: "favicon.svg", sha256: "d".repeat(64), byteLength: 9 }] },
  })).resolves.toMatchObject({ pages: [{ sourceId: "guide" }] });
});
