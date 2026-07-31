import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import {
  atlcliPublishingIntegration,
  publicationRoutePathV1,
} from "./integration.js";
import { readPublicationBundlePagesV1 } from "./loader.js";

test("declares Astro as a peer, never a bundled runtime dependency", async () => {
  const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as {
    dependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
  };
  expect(manifest.peerDependencies?.astro).toBe(">=7.1.6 <8");
  expect(manifest.dependencies?.astro).toBeUndefined();
});

const page = {
  schema: "atlcli.publication-page/1",
  sourceId: "guide",
  sourceVersion: "1",
  title: "Guide",
  position: 0,
  depth: 0,
  route: "/guide/",
  blocks: [{ type: "paragraph", content: [{ type: "text", text: "Guide" }] }],
  notes: [],
  labels: [],
  links: [],
  assetIds: [],
  renderDependencies: [],
  pageDigest: "page-digest",
};

function bundle(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: "atlcli.publication-bundle/1",
    bundleDigest: "bundle-digest",
    createdBy: { name: "atlcli", version: "0.1.0" },
    sourceSnapshot: {
      sourceDigest: "source-digest",
      complete: true,
      deletionAuthority: "complete-scan",
      rootIds: ["guide"],
      pages: [{
        sourceId: "guide",
        sourceVersion: "1",
        representation: "atlas_doc_format",
        position: 0,
        depth: 0,
        title: "Guide",
        contentDigest: "content-digest",
        metadataDigest: "metadata-digest",
        assetMetadataDigest: "asset-metadata-digest",
        state: "included",
      }],
    },
    sourcePolicyDigest: "policy-digest",
    complete: true,
    rootIds: ["guide"],
    pages: [{ sourceId: "guide", path: "pages/guide.json", pageDigest: "page-digest" }],
    routes: [{ sourceId: "guide", route: "/guide/", state: "active", assignedBy: "generated", previousRoutes: [] }],
    assets: [],
    issues: [],
    ...overrides,
  };
}

async function fixture(bundleValue = bundle()): Promise<{ root: string; bundlePath: string }> {
  const root = await mkdtemp(join(tmpdir(), "atlcli-web-publish-astro-"));
  await mkdir(join(root, "pages"));
  await writeFile(join(root, "pages", "guide.json"), JSON.stringify(page));
  const bundlePath = join(root, "bundle.json");
  await writeFile(bundlePath, JSON.stringify(bundleValue));
  return { root, bundlePath };
}

test("reads only complete, referenced structured page documents", async () => {
  const { root, bundlePath } = await fixture();
  try {
    await expect(readPublicationBundlePagesV1({ bundlePath })).resolves.toMatchObject({
      bundle: { bundleDigest: "bundle-digest" },
      pages: [{ sourceId: "guide", blocks: page.blocks }],
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects partial bundles and paths outside the immutable bundle directory", async () => {
  const partial = await fixture(bundle({ complete: false }));
  try {
    await expect(readPublicationBundlePagesV1({ bundlePath: partial.bundlePath })).rejects.toThrow("complete bundle");
  } finally {
    await rm(partial.root, { recursive: true, force: true });
  }

  const escaped = await fixture(bundle({
    pages: [{ sourceId: "guide", path: "../outside.json", pageDigest: "page-digest" }],
  }));
  try {
    await expect(readPublicationBundlePagesV1({ bundlePath: escaped.bundlePath })).rejects.toThrow("escapes bundle directory");
  } finally {
    await rm(escaped.root, { recursive: true, force: true });
  }
});

test("uses only static Astro hooks, detects collisions, and writes private inventory", async () => {
  const { root, bundlePath } = await fixture();
  const output = join(root, "dist");
  const manifest = join(root, "private", "inventory.json");
  await mkdir(output);
  await writeFile(join(output, "index.html"), "<main>Guide</main>");
  const integration = atlcliPublishingIntegration({ bundlePath, manifestPath: manifest, routePrefix: "/publish" });
  try {
    expect(publicationRoutePathV1("/", "/publish")).toBe("/publish");
    expect(publicationRoutePathV1("/guide/", "/publish")).toBe("/publish/guide");
    expect(() => integration.hooks["astro:config:done"]({ config: { output: "server" } })).toThrow("static output");
    await expect(integration.hooks["astro:routes:resolved"]({
      routes: [{ pathname: "/publish/guide" }],
    })).rejects.toThrow("route collision");
    await integration.hooks["astro:routes:resolved"]({ routes: [{ pathname: "/handwritten" }] });
    await integration.hooks["astro:build:done"]({
      dir: pathToFileURL(`${output}/`),
      pages: [{ pathname: "/publish/guide" }],
    });
    const value = JSON.parse(await readFile(manifest, "utf8")) as {
      outputRoot: string;
      pages: string[];
      output: Array<{ path: string; byteLength: number; sha256: string }>;
    };
    expect(value.outputRoot).toBe("<private>");
    expect(value.pages).toEqual(["/publish/guide"]);
    expect(value.output).toEqual([{ path: "index.html", byteLength: 18, sha256: expect.any(String) }]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
