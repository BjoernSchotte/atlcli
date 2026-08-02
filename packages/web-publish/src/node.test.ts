import { afterEach, describe, expect, test } from "bun:test";
import { lstat, mkdir, mkdtemp, readFile, readdir, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  PublicationPageV1,
  PublicationRefreshPlanV1,
  PublicationSourceSnapshotV1,
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
  sweepNodePublicationRetentionV1,
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

async function revisedPublicationRequest(
  request: Awaited<ReturnType<typeof publicationFixture>>,
  revision: string,
  previousBundleDigest: string,
) {
  const previousPage = request.pages[0]!;
  const pageDraft: PublicationPageV1 = {
    ...previousPage,
    sourceVersion: revision,
    title: `Guide ${revision}`,
    blocks: [{ type: "paragraph", content: [{ type: "text", text: `Normalized revision ${revision}` }] }],
    pageDigest: "pending",
  };
  const page = { ...pageDraft, pageDigest: await digestPublicationPageV1(pageDraft) };
  const sourceSnapshot: PublicationSourceSnapshotV1 = {
    ...request.refreshPlan.sourceSnapshot,
    sourceDigest: `source-digest-${revision}`,
    pages: request.refreshPlan.sourceSnapshot.pages.map((source) => ({
      ...source,
      sourceVersion: revision,
      title: `Guide ${revision}`,
      contentDigest: `content-digest-${revision}`,
    })),
  };
  const planDraft: PublicationRefreshPlanV1 = {
    schema: "atlcli.publication-refresh-plan/1",
    previousBundleDigest,
    sourceSnapshot,
    changes: [{ kind: "content-change", sourceId: "guide", previousDigest: "content-digest", nextDigest: `content-digest-${revision}` }],
    complete: true,
    issues: [],
    planDigest: "pending",
  };
  return {
    ...request,
    refreshPlan: { ...planDraft, planDigest: await digestPublicationRefreshPlanV1(planDraft) },
    pages: [page],
    expectedActiveBundleDigest: previousBundleDigest,
  };
}

function buildManifest(buildDigest: string, bundleDigest: string): object {
  return {
    schema: "atlcli.static-publication-manifest/1",
    bundleDigest,
    builder: { id: "astro-static", version: "1.0.0", astroVersion: "7.1.6" },
    projectDigest: "project-digest",
    configDigest: "config-digest",
    lockfileDigest: "lockfile-digest",
    base: "/",
    outputProfile: "directory",
    pages: [],
    assets: [],
    experience: { id: "test", version: "1.0.0", digest: "experience-digest" },
    search: { provider: "pagefind", digest: "search-digest", files: [], languages: [], indexedSourceIds: [] },
    seo: { digest: "seo-digest" },
    analytics: { provider: "none" },
    editLinks: { provider: "none", includedSourceIds: [], omittedSourceIds: [] },
    removedOwnedPaths: [],
    verification: { valid: true, checkedPages: 0, checkedAssets: 0, issues: [] },
    buildDigest,
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

  test("allows authoritative rewrites to recover corrupt derived cache entries", async () => {
    const { root } = await fixture();
    const workspaceDirectory = join(root, "workspace");
    const store = createNodePublicationCacheStoreV1({ workspaceDirectory });
    await store.writePage(PAGE_KEY, cachedPage);
    const pagePath = join(workspaceDirectory, "cache", "pages", `${PAGE_KEY}.json`);
    await writeFile(pagePath, "not-json");
    await expect(store.readPage(PAGE_KEY)).rejects.toMatchObject({ code: "corrupt" });
    await store.writePage(PAGE_KEY, cachedPage);
    expect(await store.readPage(PAGE_KEY)).toEqual(cachedPage);

    const asset = {
      cacheKey: ASSET_KEY,
      mediaType: "image/png",
      sha256: "c".repeat(64),
      bytes: new Uint8Array([137, 80, 78, 71]),
    };
    await store.writeAsset(asset);
    await writeFile(join(workspaceDirectory, "cache", "assets", ASSET_KEY, "metadata.json"), "not-json");
    await expect(store.readAsset(ASSET_KEY)).rejects.toMatchObject({ code: "corrupt" });
    await store.writeAsset(asset);
    expect(await store.readAsset(ASSET_KEY)).toEqual(asset);
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

  test("surfaces the bounded refresh-plan validation path without echoing source values", async () => {
    const { root } = await fixture();
    const request = await publicationFixture(root);
    await expect(materializeNodePublicationBundleV1({
      ...request,
      refreshPlan: { ...request.refreshPlan, complete: "yes" as never },
    })).rejects.toThrow("publication refresh plan violates its schema ($.complete: expected a boolean)");
  });

  test("serializes concurrent activation and fences the stale writer at the active pointer", async () => {
    const { root } = await fixture();
    const request = await publicationFixture(root);
    const active = await materializeNodePublicationBundleV1(request);
    const [secondRequest, thirdRequest] = await Promise.all([
      revisedPublicationRequest(request, "2", active.bundle.bundleDigest),
      revisedPublicationRequest(request, "3", active.bundle.bundleDigest),
    ]);
    const results = await Promise.allSettled([
      materializeNodePublicationBundleV1(secondRequest),
      materializeNodePublicationBundleV1(thirdRequest),
    ]);
    const successes = results.filter((result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof materializeNodePublicationBundleV1>>> =>
      result.status === "fulfilled",
    );
    const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    expect(successes).toHaveLength(1);
    expect(failures).toHaveLength(1);
    expect(failures[0]!.reason).toMatchObject({ code: "active-bundle-mismatch" });
    expect(JSON.parse(await readFile(join(request.workspaceDirectory, "current.json"), "utf8"))).toMatchObject({
      bundleDigest: successes[0]!.value.bundle.bundleDigest,
    });
    await expect(materializeNodePublicationBundleV1({ ...request, activationLockTimeoutMs: 1 }))
      .rejects.toMatchObject({ code: "active-bundle-mismatch" });
  });

  test("reclaims an expired activation lease before mutating the active pointer", async () => {
    const { root } = await fixture();
    const request = await publicationFixture(root);
    const lockDirectory = join(request.workspaceDirectory, "locks", "activation.lock");
    await mkdir(lockDirectory, { recursive: true });
    await writeFile(join(lockDirectory, "owner.json"), JSON.stringify({
      schema: "atlcli.publication-activation-lock/1",
      nonce: "00000000-0000-4000-8000-000000000000",
      acquiredAt: 0,
      expiresAt: 1,
    }));
    const result = await materializeNodePublicationBundleV1(request);
    expect(result.activated).toBe(true);
    await expect(lstat(lockDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("times out behind a fresh activation lease without activating a candidate", async () => {
    const { root } = await fixture();
    const request = await publicationFixture(root);
    const lockDirectory = join(request.workspaceDirectory, "locks", "activation.lock");
    await mkdir(lockDirectory, { recursive: true });
    const now = Date.now();
    await writeFile(join(lockDirectory, "owner.json"), JSON.stringify({
      schema: "atlcli.publication-activation-lock/1",
      nonce: "00000000-0000-4000-8000-000000000000",
      acquiredAt: now,
      expiresAt: now + 60_000,
    }));
    await expect(materializeNodePublicationBundleV1({ ...request, activationLockTimeoutMs: 1 }))
      .rejects.toMatchObject({ code: "activation-lock-timeout" });
    await expect(lstat(join(request.workspaceDirectory, "current.json"))).rejects.toMatchObject({ code: "ENOENT" });
    await writeFile(join(lockDirectory, "owner.json"), JSON.stringify({
      schema: "atlcli.publication-activation-lock/1",
      nonce: "00000000-0000-4000-8000-000000000000",
      acquiredAt: 0,
      expiresAt: 1,
    }));
    const recovered = await materializeNodePublicationBundleV1(request);
    expect(JSON.parse(await readFile(join(request.workspaceDirectory, "current.json"), "utf8")))
      .toMatchObject({ bundleDigest: recovered.bundle.bundleDigest });
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

  test("collects only manifest-verified unreachable bundles while retained builds keep their bundle reachable", async () => {
    const { root } = await fixture();
    const request = await publicationFixture(root);
    const first = await materializeNodePublicationBundleV1(request);
    const second = await materializeNodePublicationBundleV1(await revisedPublicationRequest(
      request,
      "2",
      first.bundle.bundleDigest,
    ));
    const third = await materializeNodePublicationBundleV1(await revisedPublicationRequest(
      request,
      "3",
      second.bundle.bundleDigest,
    ));
    await utimes(first.bundleDirectory, 1, 1);
    await utimes(second.bundleDirectory, 2, 2);
    await utimes(third.bundleDirectory, 3, 3);
    const unownedDirectory = join(request.workspaceDirectory, "bundles", "operator-notes");
    await mkdir(unownedDirectory);
    await writeFile(join(unownedDirectory, "README.txt"), "not an atlcli bundle");

    const buildDigest = "f".repeat(64);
    const buildDirectory = join(request.workspaceDirectory, "builds", buildDigest);
    await mkdir(buildDirectory, { recursive: true });
    await writeFile(join(buildDirectory, "manifest.json"), JSON.stringify(buildManifest(buildDigest, first.bundle.bundleDigest)));
    await utimes(buildDirectory, 4, 4);
    const obsoleteBuildDigest = "e".repeat(64);
    const obsoleteBuildDirectory = join(request.workspaceDirectory, "builds", obsoleteBuildDigest);
    await mkdir(obsoleteBuildDirectory, { recursive: true });
    await writeFile(
      join(obsoleteBuildDirectory, "manifest.json"),
      JSON.stringify(buildManifest(obsoleteBuildDigest, second.bundle.bundleDigest)),
    );
    await utimes(obsoleteBuildDirectory, 2.5, 2.5);

    const result = await sweepNodePublicationRetentionV1({
      workspaceDirectory: request.workspaceDirectory,
      retention: { bundles: 1, builds: 1, graceSeconds: 0 },
      now: 10_000,
    });
    expect(result).toEqual({
      retainedBundleDigests: [first.bundle.bundleDigest, third.bundle.bundleDigest].sort(),
      retainedBuildDigests: [buildDigest],
      removedBundleDigests: [second.bundle.bundleDigest],
      removedBuildDigests: [obsoleteBuildDigest],
    });
    expect((await readdir(join(request.workspaceDirectory, "bundles"))).sort()).toEqual([
      first.bundle.bundleDigest,
      "operator-notes",
      third.bundle.bundleDigest,
    ].sort());
    expect(JSON.parse(await readFile(join(request.workspaceDirectory, "current.json"), "utf8"))).toMatchObject({
      bundleDigest: third.bundle.bundleDigest,
    });
  });

  test("does not remove anything when a digest-named manifest is corrupt or grace has not elapsed", async () => {
    const { root } = await fixture();
    const request = await publicationFixture(root);
    const first = await materializeNodePublicationBundleV1(request);
    const second = await materializeNodePublicationBundleV1(await revisedPublicationRequest(
      request,
      "2",
      first.bundle.bundleDigest,
    ));
    await utimes(first.bundleDirectory, 1, 1);
    await utimes(second.bundleDirectory, 2, 2);
    const noGraceExpiry = await sweepNodePublicationRetentionV1({
      workspaceDirectory: request.workspaceDirectory,
      retention: { bundles: 1, builds: 1, graceSeconds: 100 },
      now: 10_000,
    });
    expect(noGraceExpiry.removedBundleDigests).toEqual([]);

    await writeFile(join(second.bundleDirectory, "publication.json"), "not-json");
    await expect(sweepNodePublicationRetentionV1({
      workspaceDirectory: request.workspaceDirectory,
      retention: { bundles: 1, builds: 1, graceSeconds: 0 },
      now: 10_000,
    })).rejects.toMatchObject({ code: "corrupt-existing-bundle" });
    expect((await lstat(first.bundleDirectory)).isDirectory()).toBe(true);
  });
});
