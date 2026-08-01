import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PublicationPageV1 } from "./contracts.js";
import {
  createNodePublicationCacheStoreV1,
  PublicationCacheStoreErrorV1,
  PublicationFileReadErrorV1,
  readBoundedPublicationJsonV1,
} from "./node.js";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await import("node:fs/promises").then(({ rm }) => rm(root, { recursive: true, force: true }));
  }
});

async function fixture(): Promise<{ root: string; file: string }> {
  const root = await mkdtemp(join(tmpdir(), "atlcli-web-publish-"));
  roots.push(root);
  const file = join(root, "publication.json");
  await writeFile(file, '{"schema":"fixture"}', { mode: 0o600 });
  return { root, file };
}

const cachedPage = {
  schema: "atlcli.publication-page/1",
  sourceId: "cached-page",
  sourceVersion: "1",
  title: "Cached page",
  position: 0,
  depth: 0,
  route: "/cached-page/",
  blocks: [{ type: "paragraph", content: [{ type: "text", text: "Cached content" }] }],
  notes: [],
  labels: [],
  links: [],
  assetIds: [],
  renderDependencies: [],
  pageDigest: "cached-page-digest",
} as const satisfies PublicationPageV1;

const PAGE_KEY = "a".repeat(64);
const ASSET_KEY = "b".repeat(64);

describe("@atlcli/web-publish/node bounded JSON reader", () => {
  test("reads a regular bounded JSON file", async () => {
    const { file } = await fixture();
    expect(await readBoundedPublicationJsonV1(file, { maxBytes: 1_024 }))
      .toEqual({ schema: "fixture" });
  });

  test("rejects oversized and symlink inputs before parsing", async () => {
    const { root, file } = await fixture();
    await expect(readBoundedPublicationJsonV1(file, { maxBytes: 4 }))
      .rejects.toBeInstanceOf(PublicationFileReadErrorV1);
    const link = join(root, "linked.json");
    await symlink(file, link);
    await expect(readBoundedPublicationJsonV1(link))
      .rejects.toMatchObject({ kind: "symlink" });
  });

  test("rejects invalid byte budgets", async () => {
    const { file } = await fixture();
    await expect(readBoundedPublicationJsonV1(file, { maxBytes: 0 }))
      .rejects.toBeInstanceOf(RangeError);
  });
});

describe("@atlcli/web-publish/node cache store", () => {
  test("round-trips bounded normalized pages and binary assets under digest-only paths", async () => {
    const { root } = await fixture();
    const store = createNodePublicationCacheStoreV1({ workspaceDirectory: join(root, "workspace") });

    await store.writePage(PAGE_KEY, cachedPage);
    await store.writeAsset({
      cacheKey: ASSET_KEY,
      mediaType: "image/png",
      sha256: "c".repeat(64),
      bytes: new Uint8Array([137, 80, 78, 71]),
    });

    expect(await store.readPage(PAGE_KEY)).toEqual(cachedPage);
    const asset = await store.readAsset(ASSET_KEY);
    expect(asset).toEqual({
      cacheKey: ASSET_KEY,
      mediaType: "image/png",
      sha256: "c".repeat(64),
      bytes: new Uint8Array([137, 80, 78, 71]),
    });
    asset?.bytes.fill(0);
    expect((await store.readAsset(ASSET_KEY))?.bytes).toEqual(new Uint8Array([137, 80, 78, 71]));
    expect(await store.readPage("d".repeat(64))).toBeUndefined();
    expect(await store.readAsset("d".repeat(64))).toBeUndefined();
  });

  test("rejects path-like keys, oversized values, and cache symlink entries", async () => {
    const { root } = await fixture();
    const workspaceDirectory = join(root, "workspace");
    const cacheDirectory = join(workspaceDirectory, "cache");
    const store = createNodePublicationCacheStoreV1({
      workspaceDirectory,
      maxPageBytes: 32,
      maxAssetBytes: 3,
    });
    await expect(store.writePage("../not-a-key", cachedPage)).rejects.toThrow("SHA-256");
    await expect(store.writePage(PAGE_KEY, cachedPage)).rejects.toMatchObject({ code: "too-large" });
    await expect(store.writeAsset({
      cacheKey: ASSET_KEY,
      mediaType: "image/png",
      sha256: "c".repeat(64),
      bytes: new Uint8Array([1, 2, 3, 4]),
    })).rejects.toMatchObject({ code: "too-large" });

    const regularStore = createNodePublicationCacheStoreV1({ workspaceDirectory });
    await regularStore.writePage(PAGE_KEY, cachedPage);
    const pagePath = join(cacheDirectory, "pages", `${PAGE_KEY}.json`);
    const replacement = join(root, "replacement.json");
    await writeFile(replacement, JSON.stringify(cachedPage));
    await import("node:fs/promises").then(({ unlink }) => unlink(pagePath));
    await symlink(replacement, pagePath);
    await expect(regularStore.readPage(PAGE_KEY)).rejects.toBeInstanceOf(PublicationCacheStoreErrorV1);
  });
});
