import type { PublicationPageV1 } from "./contracts.js";
import { digestPublicationJsonV1 } from "./digests.js";

/** A SHA-256 digest over every input that can affect a reusable cache value. */
export type PublicationCacheKeyV1 = string;

/**
 * Every source and derived input that can change a normalized publication page.
 * This is intentionally more specific than a Confluence page version: assets,
 * macro results, and route/navigation policy can change while the body version
 * remains unchanged.
 */
export interface PublicationPageCacheKeyInputV1 {
  sourceId: string;
  sourceVersion: string;
  sourceRepresentation: "atlas_doc_format" | "storage";
  sourcePolicyDigest: string;
  decoderSchemaVersion: string;
  exportBlockSchemaVersion: string;
  macroCatalogVersion: string;
  webTargetVersion: string;
  macroPolicyDigest: string;
  /** Digest of frozen live inputs; a no-live page uses an explicit sentinel. */
  macroDependencyDigest: string;
  assetMetadataDigest: string;
  routeLinkPolicyDigest: string;
  navigationDependencyDigest: string;
}

function assertCacheKeyInput(input: PublicationPageCacheKeyInputV1): void {
  const entries = Object.entries(input);
  for (const [key, value] of entries) {
    if (typeof value !== "string" || !value.trim()) {
      throw new TypeError(`publication page cache key input '${key}' must be non-empty`);
    }
  }
}

/**
 * Derive the only page-cache lookup key. A changed input always produces a new
 * key, so an obsolete cache entry cannot be reused merely because a page's
 * Confluence version happens to match.
 */
export async function digestPublicationPageCacheKeyV1(
  input: PublicationPageCacheKeyInputV1,
): Promise<PublicationCacheKeyV1> {
  assertCacheKeyInput(input);
  return digestPublicationJsonV1({ schema: "atlcli.publication-page-cache-key/1", ...input });
}

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
