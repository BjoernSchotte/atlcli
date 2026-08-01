import type { PublicationPageV1 } from "./contracts.js";

/** A SHA-256 digest over every input that can affect a reusable cache value. */
export type PublicationCacheKeyV1 = string;

/**
 * Binary cache material is deliberately separate from its future bundle path.
 * A cache is derived, mutable state; only a validated immutable bundle assigns
 * public output paths and asset identifiers.
 */
export interface PublicationCachedAssetV1 {
  cacheKey: PublicationCacheKeyV1;
  mediaType: string;
  sha256: string;
  bytes: Uint8Array;
}

/**
 * Narrow mutable cache port. Implementations may evict a value at any time;
 * callers must always be able to recompute it from the authoritative source.
 * No raw ADF, Storage XHTML, credentials, request headers, or source URLs are
 * accepted by this contract.
 */
export interface PublicationCacheStoreV1 {
  readPage(cacheKey: PublicationCacheKeyV1): Promise<PublicationPageV1 | undefined>;
  writePage(cacheKey: PublicationCacheKeyV1, page: PublicationPageV1): Promise<void>;
  readAsset(cacheKey: PublicationCacheKeyV1): Promise<PublicationCachedAssetV1 | undefined>;
  writeAsset(asset: PublicationCachedAssetV1): Promise<void>;
}

/** The cache key format prevents user-controlled path fragments at every store. */
export function assertPublicationCacheKeyV1(cacheKey: PublicationCacheKeyV1): void {
  if (!/^[a-f0-9]{64}$/u.test(cacheKey)) {
    throw new TypeError("publication cache keys must be lowercase SHA-256 digests");
  }
}
