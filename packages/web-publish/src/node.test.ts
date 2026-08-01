import { afterEach, describe, expect, test } from "bun:test";
import { lstat, mkdtemp, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  PublicationPageV1,
  PublicationRefreshPlanV1,
} from "./contracts.js";
import {
  digestPublicationPageV1,
  digestPublicationRefreshPlanV1,
} from "./digests.js";
import {
  createNodePublicationCacheStoreV1,
  materializeNodePublicationBundleV1,
  NodePublicationBundleErrorV1,
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

async function sha256(bytes: Uint8Array): Promise<string> {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", buffer));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function publicationFixture(root: string) {
  const pageDraft = {
    schema: "atlcli.publication-page/1",
    sourceId: "guide",
    sourceVersion: "1",
    title: "Guide",
    position: 0,
    depth: 0,
    route: "/guide/",
    blocks: [{ type: "paragraph", content: [{ type: "text", text: "Safe normalized content" }] }],
    notes: [],
    labels: [],
    links: [{ referenceId: "logo", kind: "asset" as const, assetId: "logo" }],
    assetIds: ["logo"],
    renderDependencies: [],
    pageDigest: "pending",
  } as const satisfies PublicationPageV1;
  const page: PublicationPageV1 = {
    ...pageDraft,
    pageDigest: await digestPublicationPageV1(pageDraft),
  };
  const sourceSnapshot = {
    sourceDigest: "source-digest",
    complete: true,
    deletionAuthority: "complete-scan" as const,
    rootIds: ["guide"],
    pages: [{
      sourceId: "guide",
      sourceVersion: "1",
      representation: "atlas_doc_format" as const,
      position: 0,
      depth: 0,
      title: "Guide",
      contentDigest: "content-digest",
      metadataDigest: "metadata-digest",
      assetMetadataDigest: "asset-metadata-digest",
      macroDependencyDigest: "no-live-dependencies",
      state: "included" as const,
    }],
  };
  const planDraft = {
    schema: "atlcli.publication-refresh-plan/1",
    sourceSnapshot,
    changes: [{ kind: "add" as const, sourceId: "guide", nextDigest: "content-digest" }],
    complete: true,
    issues: [],
    planDigest: "pending",
  } as const satisfies PublicationRefreshPlanV1;
  const refreshPlan: PublicationRefreshPlanV1 = {
    ...planDraft,
    planDigest: await digestPublicationRefreshPlanV1(planDraft),
  };
  const assetBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const assetSha256 = await sha256(assetBytes);
  return {
    workspaceDirectory: join(root, "workspace"),
    refreshPlan,
    createdBy: { name: "atlcli" as const, version: "0.1.0-test" },
    sourcePolicyDigest: "a".repeat(64),
    rootIds: ["guide"],
    pages: [page],
    routes: [{ sourceId: "guide", route: "/guide/", state: "active" as const, assignedBy: "generated" as const, previousRoutes: [] }],
    assets: [{
      entry: {
        assetId: "logo",
        path: `assets/${assetSha256}/logo.png`,
        sha256: assetSha256,
        byteLength: assetBytes.byteLength,
        mediaType: "image/png",
        disposition: "inline" as const,
        downloadName: "logo.png",
      },
      bytes: assetBytes,
    }],
    assetPolicy: { maxAssetBytes: 1_024, maxTotalBytes: 2_048 },
  };
}

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

describe("@atlcli/web-publish/node immutable bundle activation", () => {
  test("validates a complete plan, stages content-addressed files, and atomically activates only the verified bundle", async () => {
    const { root } = await fixture();
    const request = await publicationFixture(root);
    const result = await materializeNodePublicationBundleV1(request);

    expect(result.activated).toBe(true);
    expect(result.bundle.bundleDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(result.bundle.complete).toBe(true);
    expect(result.bundle.pages).toEqual([{
      sourceId: "guide",
      path: `pages/${request.pages[0]!.pageDigest}.json`,
      pageDigest: request.pages[0]!.pageDigest,
    }]);
    expect(await lstat(result.bundleDirectory)).toMatchObject({ isDirectory: expect.any(Function) });
    expect((await lstat(result.bundleDirectory)).isSymbolicLink()).toBe(false);
    expect(JSON.parse(await readFile(join(request.workspaceDirectory, "current.json"), "utf8"))).toEqual({
      schema: "atlcli.publication-current/1",
      bundleDigest: result.bundle.bundleDigest,
    });
    const storedPage = await readFile(join(result.bundleDirectory, result.bundle.pages[0]!.path), "utf8");
    expect(storedPage).toContain("Safe normalized content");
    expect(storedPage).not.toContain("export_view");
    expect([...await readFile(join(result.bundleDirectory, result.bundle.assets[0]!.path))])
      .toEqual([...request.assets[0]!.bytes]);

    const repeat = await materializeNodePublicationBundleV1({
      ...request,
      expectedActiveBundleDigest: result.bundle.bundleDigest,
    });
    expect(repeat.bundleDirectory).toBe(result.bundleDirectory);
  });

  test("rejects incomplete, corrupt, and cancelled candidates without changing the last active pointer", async () => {
    const { root } = await fixture();
    const request = await publicationFixture(root);
    const active = await materializeNodePublicationBundleV1(request);
    const currentPath = join(request.workspaceDirectory, "current.json");
    const before = await readFile(currentPath, "utf8");

    const partialDraft = { ...request.refreshPlan, complete: false, planDigest: "pending" };
    const partial = { ...partialDraft, planDigest: await digestPublicationRefreshPlanV1(partialDraft) };
    await expect(materializeNodePublicationBundleV1({
      ...request,
      refreshPlan: partial,
      expectedActiveBundleDigest: active.bundle.bundleDigest,
    })).rejects.toMatchObject({ code: "incomplete-refresh-plan" });
    await expect(materializeNodePublicationBundleV1({
      ...request,
      assets: [{ ...request.assets[0]!, bytes: new Uint8Array([1, 2, 3]) }],
      expectedActiveBundleDigest: active.bundle.bundleDigest,
    })).rejects.toMatchObject({ code: "invalid-asset" });
    const controller = new AbortController();
    controller.abort();
    await expect(materializeNodePublicationBundleV1({
      ...request,
      expectedActiveBundleDigest: active.bundle.bundleDigest,
      signal: controller.signal,
    })).rejects.toMatchObject({ code: "aborted" });
    expect(await readFile(currentPath, "utf8")).toBe(before);
  });

  test("writes identical content-addressed asset bytes once while retaining per-asset download names", async () => {
    const { root } = await fixture();
    const request = await publicationFixture(root);
    const originalPage = request.pages[0]!;
    const pageDraft: PublicationPageV1 = {
      ...originalPage,
      links: [
        { referenceId: "logo", kind: "asset", assetId: "logo" },
        { referenceId: "logo-copy", kind: "asset", assetId: "logo-copy" },
      ],
      assetIds: ["logo", "logo-copy"],
      pageDigest: "pending",
    };
    const page = { ...pageDraft, pageDigest: await digestPublicationPageV1(pageDraft) };
    const duplicate = {
      entry: {
        ...request.assets[0]!.entry,
        assetId: "logo-copy",
        path: `assets/${request.assets[0]!.entry.sha256}/download-copy.png`,
        downloadName: "download-copy.png",
      },
      bytes: new Uint8Array(request.assets[0]!.bytes),
    };
    const result = await materializeNodePublicationBundleV1({
      ...request,
      pages: [page],
      assets: [request.assets[0]!, duplicate],
    });

    expect(result.bundle.assets.map((asset) => [asset.assetId, asset.path, asset.downloadName])).toEqual([
      ["logo", `assets/${request.assets[0]!.entry.sha256}/download-copy.png`, "logo.png"],
      ["logo-copy", `assets/${request.assets[0]!.entry.sha256}/download-copy.png`, "download-copy.png"],
    ]);
    expect(await readdir(join(result.bundleDirectory, "assets", request.assets[0]!.entry.sha256))).toEqual([
      "download-copy.png",
    ]);
  });

  test("fails closed on a symlinked project-owned bundle directory", async () => {
    const { root } = await fixture();
    const request = await publicationFixture(root);
    await writeFile(join(root, "outside"), "not a bundle directory");
    await import("node:fs/promises").then(({ mkdir }) => mkdir(request.workspaceDirectory, { recursive: true }));
    await symlink(join(root, "outside"), join(request.workspaceDirectory, "bundles"));
    await expect(materializeNodePublicationBundleV1(request)).rejects.toBeInstanceOf(NodePublicationBundleErrorV1);
    await expect(materializeNodePublicationBundleV1(request)).rejects.toMatchObject({ code: "unsafe-path" });
  });
});
