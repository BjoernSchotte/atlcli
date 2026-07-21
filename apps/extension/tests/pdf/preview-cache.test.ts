import { beforeEach, describe, expect, it } from "bun:test";
import { IDBFactory } from "fake-indexeddb";
import {
  PREVIEW_CACHE_MAX_AGE_MS,
  PREVIEW_CACHE_MAX_BYTES,
  clearPreview,
  getPreviewEntry,
  getReusableExportBytes,
  hashPreviewSettings,
  hashTreeVersions,
  matchesRequest,
  previewCacheKey,
  putPreview,
  stableStringify,
  type PreviewCacheKeyParts,
} from "../../utils/pdf/preview-cache.js";

let factory: IDBFactory;

beforeEach(() => {
  factory = new IDBFactory();
});

const parts: PreviewCacheKeyParts = {
  sourceIdentity: "https://x.atlassian.net/wiki/p/1|1|3|page|1|labels:none",
  settingsHash: "s".repeat(64),
  treeVersionHash: "t".repeat(64),
};

function put(overrides: Partial<Parameters<typeof putPreview>[0]> = {}) {
  return putPreview(
    {
      ...parts,
      pdf: new Uint8Array([0x25, 0x50, 0x44, 0x46]),
      filename: "doc.pdf",
      truncated: false,
      includedChapters: 1,
      totalChapters: 1,
      ...overrides,
    },
    factory
  );
}

describe("preview cache key composition", () => {
  it("stableStringify is insertion-order independent", () => {
    expect(stableStringify({ a: 1, b: { d: 4, c: 3 } })).toBe(
      stableStringify({ b: { c: 3, d: 4 }, a: 1 })
    );
    expect(stableStringify({ a: 1, b: undefined })).toBe(stableStringify({ a: 1 }));
  });

  it("hashes different settings to different keys", async () => {
    const a = await hashPreviewSettings({ pageSize: "A4", watermark: null });
    const b = await hashPreviewSettings({ pageSize: "Letter", watermark: null });
    expect(a).not.toBe(b);
    expect(a).toHaveLength(64);
  });

  /**
   * The carried-forward defect (wave 1): `sourceIdentity` carries only the ROOT
   * page's version, so a child page edited between two exports would leave the
   * key unchanged — and this cache persists in IndexedDB *and* feeds Download.
   */
  it("changes the tree hash when a CHILD page's version changes", async () => {
    const before = await hashTreeVersions([
      { id: "root", version: 3 },
      { id: "child", version: 1 },
    ]);
    const after = await hashTreeVersions([
      { id: "root", version: 3 },
      { id: "child", version: 2 },
    ]);
    expect(before).not.toBe(after);
  });

  it("is independent of tree walk order", async () => {
    const a = await hashTreeVersions([
      { id: "root", version: 3 },
      { id: "child", version: 1 },
    ]);
    const b = await hashTreeVersions([
      { id: "child", version: 1 },
      { id: "root", version: 3 },
    ]);
    expect(a).toBe(b);
  });

  it("distinguishes an unknown version from a concrete one", async () => {
    const unknown = await hashTreeVersions([{ id: "a", version: null }]);
    const known = await hashTreeVersions([{ id: "a", version: 1 }]);
    expect(unknown).not.toBe(known);
  });

  it("changes the cache key when any of the three parts changes", () => {
    const base = previewCacheKey(parts);
    expect(previewCacheKey({ ...parts, sourceIdentity: "other" })).not.toBe(base);
    expect(previewCacheKey({ ...parts, settingsHash: "x".repeat(64) })).not.toBe(base);
    expect(previewCacheKey({ ...parts, treeVersionHash: "x".repeat(64) })).not.toBe(base);
  });

  it("matchesRequest compares all three parts", () => {
    const entry = {
      ...parts,
      key: previewCacheKey(parts),
      truncated: false,
      includedChapters: 1,
      totalChapters: 1,
      filename: "d.pdf",
      byteLength: 4,
      createdAt: 0,
    };
    expect(matchesRequest(entry, parts)).toBe(true);
    expect(matchesRequest(entry, { ...parts, treeVersionHash: "z".repeat(64) })).toBe(false);
  });
});

describe("preview cache storage", () => {
  it("round-trips the most recent preview", async () => {
    await put();
    const hit = await getPreviewEntry(parts, { factory });
    expect(hit?.entry.filename).toBe("doc.pdf");
    expect(await hit!.bytes.asUint8Array()).toEqual(new Uint8Array([0x25, 0x50, 0x44, 0x46]));
  });

  it("returns nothing for a request whose key differs", async () => {
    await put();
    expect(
      await getPreviewEntry({ ...parts, treeVersionHash: "z".repeat(64) }, { factory })
    ).toBeUndefined();
  });

  it("is single-slot: a second preview replaces the first", async () => {
    await put();
    await put({
      sourceIdentity: "other",
      pdf: new Uint8Array([9]),
      filename: "other.pdf",
    });
    expect(await getPreviewEntry(parts, { factory })).toBeUndefined();
    const hit = await getPreviewEntry({ ...parts, sourceIdentity: "other" }, { factory });
    expect(hit?.entry.filename).toBe("other.pdf");
  });

  /**
   * The rule that stops a cut-off PDF being shipped as the export: a truncated
   * preview is a *prefix of the document*, and it looks complete once opened.
   */
  it("Download must NOT reuse a truncated entry, but the viewer may read it", async () => {
    await put({ truncated: true, includedChapters: 5, totalChapters: 40 });
    expect(await getReusableExportBytes(parts, { factory })).toBeUndefined();
    const viewerHit = await getPreviewEntry(parts, { factory });
    expect(viewerHit?.entry.truncated).toBe(true);
    expect(viewerHit?.entry.totalChapters).toBe(40);
  });

  it("Download reuses a complete entry", async () => {
    await put({ truncated: false });
    const hit = await getReusableExportBytes(parts, { factory });
    expect(hit?.entry.truncated).toBe(false);
    expect(hit?.bytes.size).toBe(4);
  });

  it("expires an entry older than the job horizon and drops it from storage", async () => {
    await put({ createdAt: 0 });
    expect(
      await getPreviewEntry(parts, { factory, now: PREVIEW_CACHE_MAX_AGE_MS + 1 })
    ).toBeUndefined();
    // The stale row is gone, not merely hidden.
    expect(await getPreviewEntry(parts, { factory, now: 0 })).toBeUndefined();
  });

  it("refuses a document larger than the per-job byte budget", async () => {
    await expect(
      put({ pdf: new Uint8Array(PREVIEW_CACHE_MAX_BYTES + 1) })
    ).rejects.toThrow(/cache limit/);
  });

  it("clearPreview empties the slot", async () => {
    await put();
    await clearPreview(factory);
    expect(await getPreviewEntry(parts, { factory })).toBeUndefined();
  });
});
