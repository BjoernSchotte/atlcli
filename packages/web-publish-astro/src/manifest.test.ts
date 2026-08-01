import { expect, test } from "bun:test";
import type { PublicationBuildRequestV1 } from "@atlcli/web-publish";
import { createAstroStaticPublicationManifestV1 } from "./manifest.js";

const request = {
  bundle: { bundleDigest: "bundle", pages: [{ sourceId: "guide", path: "pages/guide.json", pageDigest: "page" }], assets: [] },
  project: { builder: { base: "/docs", outputProfile: "directory" }, analytics: { provider: "none" }, search: { languages: ["en"] }, editLink: { provider: "none" } },
  projectDigest: "project", configDigest: "config", lockfileDigest: "lock",
} as unknown as PublicationBuildRequestV1;

test("creates a digest-bound manifest only from exact page inventory records", async () => {
  const manifest = await createAstroStaticPublicationManifestV1({
    request,
    inventory: { schema: "atlcli.astro-build-inventory/1", bundleDigest: "bundle", pages: [{ sourceId: "guide", route: "/guide/", pathname: "publish/guide/" }], output: [{ path: "publish/guide/index.html", sha256: "a", byteLength: 7 }, { path: "pagefind/index.js", sha256: "b", byteLength: 3 }] },
    builderVersion: "1.0.0", astroVersion: "7.1.6", experience: { id: "test", version: "1", digest: "x" },
  });
  expect(manifest.pages).toEqual([{ sourceId: "guide", route: "/guide/", outputPath: "publish/guide/index.html", sha256: "a", byteLength: 7 }]);
  expect(manifest.search.files).toHaveLength(1);
  expect(manifest.buildDigest).toMatch(/^[a-f0-9]{64}$/u);
  await expect(createAstroStaticPublicationManifestV1({
    request,
    inventory: { schema: "atlcli.astro-build-inventory/1", bundleDigest: "wrong", pages: [], output: [] },
    builderVersion: "1", astroVersion: "7", experience: { id: "test", version: "1", digest: "x" },
  })).rejects.toThrow("does not belong");
});
