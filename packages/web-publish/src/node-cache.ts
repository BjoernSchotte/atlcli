import {
  lstat,
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import {
  assertPublicationCacheKeyV1,
  type PublicationCachedAssetV1,
  type PublicationCacheKeyV1,
  type PublicationCacheStoreV1,
} from "./cache.js";
import type { PublicationPageV1 } from "./contracts.js";
import { parsePublicationPageV1 } from "./schema.js";

export const DEFAULT_PUBLICATION_CACHE_PAGE_BYTES_V1 = 16 * 1024 * 1024;
export const DEFAULT_PUBLICATION_CACHE_ASSET_BYTES_V1 = 128 * 1024 * 1024;

export interface NodePublicationCacheStoreOptionsV1 {
  /** Absolute publication workspace; this store owns only its `cache/` child. */
  workspaceDirectory: string;
  maxPageBytes?: number;
  maxAssetBytes?: number;
}

export type PublicationCacheStoreErrorCodeV1 =
  | "invalid-options"
  | "unsafe-path"
  | "not-regular-file"
  | "too-large"
  | "corrupt";

export class PublicationCacheStoreErrorV1 extends Error {
  constructor(
    public readonly code: PublicationCacheStoreErrorCodeV1,
    message: string,
  ) {
    super(message);
    this.name = "PublicationCacheStoreErrorV1";
  }
}

interface StoredAssetMetadataV1 {
  schema: "atlcli.publication-cache-asset/1";
  cacheKey: string;
  mediaType: string;
  sha256: string;
  byteLength: number;
}

function fail(code: PublicationCacheStoreErrorCodeV1, message: string): never {
  throw new PublicationCacheStoreErrorV1(code, message);
}

function boundedLimit(value: number | undefined, fallback: number, label: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1) {
    fail("invalid-options", `${label} must be a positive safe integer`);
  }
  return resolved;
}

function validateAsset(asset: PublicationCachedAssetV1, maxBytes: number): void {
  assertPublicationCacheKeyV1(asset.cacheKey);
  if (typeof asset.mediaType !== "string" || !asset.mediaType.trim()) {
    fail("corrupt", "publication cached asset mediaType must be non-empty");
  }
  if (!/^[a-f0-9]{64}$/u.test(asset.sha256)) {
    fail("corrupt", "publication cached asset sha256 must be a lowercase SHA-256 digest");
  }
  if (!(asset.bytes instanceof Uint8Array)) {
    fail("corrupt", "publication cached asset bytes must be Uint8Array");
  }
  if (asset.bytes.byteLength > maxBytes) {
    fail("too-large", "publication cached asset exceeds the configured byte limit");
  }
}

function assertInside(root: string, candidate: string): string {
  const absolute = resolve(candidate);
  const pathRelative = relative(root, absolute);
  if (pathRelative === "" || pathRelative.startsWith("..") || isAbsolute(pathRelative)) {
    return fail("unsafe-path", "publication cache path escapes its configured directory");
  }
  return absolute;
}

async function ensureDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const details = await lstat(path);
  if (details.isSymbolicLink() || !details.isDirectory()) {
    fail("unsafe-path", "publication cache directory must be a real directory, not a symlink");
  }
}

async function readRegularFile(path: string, maxBytes: number): Promise<Uint8Array | undefined> {
  try {
    const details = await lstat(path);
    if (details.isSymbolicLink() || !details.isFile()) {
      fail("not-regular-file", "publication cache entry must be a regular non-symlink file");
    }
    if (details.size > maxBytes) {
      fail("too-large", "publication cache entry exceeds the configured byte limit");
    }
    const bytes = await readFile(path);
    if (bytes.byteLength > maxBytes) {
      fail("too-large", "publication cache entry exceeded the configured byte limit while reading");
    }
    return bytes;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function writeAtomic(path: string, bytes: Uint8Array): Promise<void> {
  const temp = `${path}.${randomUUID()}.tmp`;
  await writeFile(temp, bytes, { mode: 0o600, flag: "wx" });
  try {
    await rename(temp, path);
  } catch (error) {
    await unlink(temp).catch(() => undefined);
    throw error;
  }
}

function parseStoredAssetMetadata(value: unknown, cacheKey: string): StoredAssetMetadataV1 {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return fail("corrupt", "publication cached asset metadata must be an object");
  }
  const candidate = value as Record<string, unknown>;
  const byteLength = candidate.byteLength;
  if (
    candidate.schema !== "atlcli.publication-cache-asset/1" ||
    candidate.cacheKey !== cacheKey ||
    typeof candidate.mediaType !== "string" || !candidate.mediaType.trim() ||
    typeof candidate.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(candidate.sha256) ||
    typeof byteLength !== "number" || !Number.isSafeInteger(byteLength) || byteLength < 0
  ) {
    return fail("corrupt", "publication cached asset metadata is invalid");
  }
  return {
    schema: "atlcli.publication-cache-asset/1",
    cacheKey,
    mediaType: candidate.mediaType,
    sha256: candidate.sha256,
    byteLength,
  };
}

/**
 * Create the default durable cache store. It is intentionally rooted at an
 * explicit publication workspace supplied by its owner. The store derives and
 * owns only `<workspace>/cache`, never discovers, deletes, or treats a cache
 * hit as source authority.
 */
export function createNodePublicationCacheStoreV1(
  options: NodePublicationCacheStoreOptionsV1,
): PublicationCacheStoreV1 {
  if (!isAbsolute(options.workspaceDirectory)) {
    fail("invalid-options", "publication workspaceDirectory must be absolute");
  }
  const workspaceDirectory = resolve(options.workspaceDirectory);
  const root = assertInside(workspaceDirectory, join(workspaceDirectory, "cache"));
  const maxPageBytes = boundedLimit(options.maxPageBytes, DEFAULT_PUBLICATION_CACHE_PAGE_BYTES_V1, "maxPageBytes");
  const maxAssetBytes = boundedLimit(options.maxAssetBytes, DEFAULT_PUBLICATION_CACHE_ASSET_BYTES_V1, "maxAssetBytes");
  const pagesDirectory = assertInside(root, join(root, "pages"));
  const assetsDirectory = assertInside(root, join(root, "assets"));

  const pagePath = (cacheKey: PublicationCacheKeyV1): string => {
    assertPublicationCacheKeyV1(cacheKey);
    return assertInside(pagesDirectory, join(pagesDirectory, `${cacheKey}.json`));
  };
  const assetDirectory = (cacheKey: PublicationCacheKeyV1): string => {
    assertPublicationCacheKeyV1(cacheKey);
    return assertInside(assetsDirectory, join(assetsDirectory, cacheKey));
  };

  const store: PublicationCacheStoreV1 = {
    async readPage(cacheKey) {
      const path = pagePath(cacheKey);
      const bytes = await readRegularFile(path, maxPageBytes);
      if (bytes === undefined) return undefined;
      try {
        return parsePublicationPageV1(JSON.parse(new TextDecoder().decode(bytes)));
      } catch (error) {
        if (error instanceof PublicationCacheStoreErrorV1) throw error;
        throw new PublicationCacheStoreErrorV1("corrupt", "publication cached page is invalid JSON or violates its schema");
      }
    },
    async writePage(cacheKey, page) {
      assertPublicationCacheKeyV1(cacheKey);
      const parsed = parsePublicationPageV1(page);
      const bytes = new TextEncoder().encode(JSON.stringify(parsed));
      if (bytes.byteLength > maxPageBytes) {
        fail("too-large", "publication cached page exceeds the configured byte limit");
      }
      await ensureDirectory(root);
      await ensureDirectory(pagesDirectory);
      await writeAtomic(pagePath(cacheKey), bytes);
    },
    async readAsset(cacheKey) {
      const directory = assetDirectory(cacheKey);
      const metadataBytes = await readRegularFile(assertInside(directory, join(directory, "metadata.json")), maxPageBytes);
      if (metadataBytes === undefined) return undefined;
      let metadata: StoredAssetMetadataV1;
      try {
        metadata = parseStoredAssetMetadata(JSON.parse(new TextDecoder().decode(metadataBytes)), cacheKey);
      } catch (error) {
        if (error instanceof PublicationCacheStoreErrorV1) throw error;
        throw new PublicationCacheStoreErrorV1("corrupt", "publication cached asset metadata is invalid JSON");
      }
      if (metadata.byteLength > maxAssetBytes) {
        fail("too-large", "publication cached asset metadata exceeds the configured byte limit");
      }
      const bytes = await readRegularFile(assertInside(directory, join(directory, "bytes")), maxAssetBytes);
      if (bytes === undefined || bytes.byteLength !== metadata.byteLength) {
        fail("corrupt", "publication cached asset bytes are missing or have an unexpected length");
      }
      return { cacheKey, mediaType: metadata.mediaType, sha256: metadata.sha256, bytes: new Uint8Array(bytes) };
    },
    async writeAsset(asset) {
      validateAsset(asset, maxAssetBytes);
      const directory = assetDirectory(asset.cacheKey);
      await ensureDirectory(root);
      await ensureDirectory(assetsDirectory);
      await ensureDirectory(directory);
      const metadata: StoredAssetMetadataV1 = {
        schema: "atlcli.publication-cache-asset/1",
        cacheKey: asset.cacheKey,
        mediaType: asset.mediaType,
        sha256: asset.sha256,
        byteLength: asset.bytes.byteLength,
      };
      await writeAtomic(assertInside(directory, join(directory, "bytes")), asset.bytes);
      await writeAtomic(
        assertInside(directory, join(directory, "metadata.json")),
        new TextEncoder().encode(JSON.stringify(metadata)),
      );
    },
  };
  return Object.freeze(store);
}
