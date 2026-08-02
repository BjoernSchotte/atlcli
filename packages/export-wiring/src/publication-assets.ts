import { assertSafeSvg, decodeSvgSource } from "@atlcli/confluence";
import {
  decodeImageInfo,
  isSvg,
  parseSvgSize,
  sha256Hex,
} from "@atlcli/export-media";
import type { ExternalAssetFetcher } from "@atlcli/export-macros";
import {
  validatePublicationOutputPathV1,
  type PublicationAssetEntryV1,
  type PublicationAssetPolicyV1,
} from "@atlcli/web-publish";

export type PublicationAssetSourceV1 =
  | { kind: "attachment"; pageId: string; filename: string }
  | { kind: "external"; url: string; filename: string };

export interface PublicationAssetRequestV1 {
  assetId: string;
  source: PublicationAssetSourceV1;
}

/** Credentialed attachment acquisition remains a host-owned, injected port. */
export interface PublicationAttachmentAssetPortV1 {
  fetchAttachment(
    request: { pageId: string; filename: string; maxBytes: number; signal?: AbortSignal },
  ): Promise<{ bytes: Uint8Array; mediaType?: string }>;
}

export interface PublicationAssetMaterializationDepsV1 {
  attachmentPort?: PublicationAttachmentAssetPortV1;
  /** Must be the existing policy-wrapped, credentials-omitting external fetcher. */
  externalFetcher?: ExternalAssetFetcher;
}

export interface MaterializedPublicationAssetV1 {
  entry: PublicationAssetEntryV1;
  bytes: Uint8Array;
}

export type PublicationAssetMaterializationErrorCodeV1 =
  | "invalid-request"
  | "missing-fetch-port"
  | "too-large"
  | "unsupported-media"
  | "mime-mismatch"
  | "unsafe-svg"
  | "svg-node-budget"
  | "image-pixel-budget";

export type PublicationAssetDeduplicationErrorCodeV1 =
  | "duplicate-asset-id"
  | "invalid-materialized-asset"
  | "digest-conflict";

export class PublicationAssetDeduplicationErrorV1 extends Error {
  constructor(
    public readonly code: PublicationAssetDeduplicationErrorCodeV1,
    message: string,
  ) {
    super(message);
    this.name = "PublicationAssetDeduplicationErrorV1";
  }
}

export class PublicationAssetMaterializationErrorV1 extends Error {
  constructor(
    public readonly code: PublicationAssetMaterializationErrorCodeV1,
    message: string,
  ) {
    super(message);
    this.name = "PublicationAssetMaterializationErrorV1";
  }
}

function fail(code: PublicationAssetMaterializationErrorCodeV1, message: string): never {
  throw new PublicationAssetMaterializationErrorV1(code, message);
}

function dedupFail(code: PublicationAssetDeduplicationErrorCodeV1, message: string): never {
  throw new PublicationAssetDeduplicationErrorV1(code, message);
}

function normalizeDeclaredMediaType(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const normalized = value.split(";", 1)[0]?.trim().toLowerCase();
  return normalized || undefined;
}

function supportedDeclaredTypeMatches(declared: string | undefined, actual: string): boolean {
  if (declared === undefined) return true;
  if (actual === "image/jpeg") return declared === "image/jpeg" || declared === "image/jpg";
  return declared === actual;
}

function assertAssetId(value: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value)) {
    fail("invalid-request", "publication assetId must be a safe non-empty identifier");
  }
}

function safeFilename(filename: string, extension: string): string {
  const leaf = filename.split(/[\\/]/u).at(-1)?.normalize("NFKC") ?? "";
  const stem = leaf
    .replace(/[^A-Za-z0-9._-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .replace(/^\.+|\.+$/gu, "")
    .slice(0, 100);
  const fallback = "asset";
  const base = stem || fallback;
  const suffix = `.${extension}`;
  const normalized = base.toLowerCase();
  if (normalized.endsWith(suffix) || (extension === "jpeg" && normalized.endsWith(".jpg"))) {
    return base;
  }
  return `${base}${suffix}`;
}

function svgNodeCount(source: string): number {
  return source.match(/<\s*[A-Za-z_][\w:.-]*\b/gu)?.length ?? 0;
}

function assertRasterBudget(
  width: number,
  height: number,
  policy: PublicationAssetPolicyV1,
): void {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || width * height > policy.maxImagePixels) {
    fail("image-pixel-budget", "publication asset exceeds the configured image pixel budget");
  }
}

function materializeFetchedPublicationAssetV1(
  request: PublicationAssetRequestV1,
  fetched: { bytes: Uint8Array; mediaType?: string },
  policy: PublicationAssetPolicyV1,
): MaterializedPublicationAssetV1 {
  assertAssetId(request.assetId);
  if (!(fetched.bytes instanceof Uint8Array)) {
    fail("invalid-request", "publication asset fetch must return Uint8Array bytes");
  }
  if (fetched.bytes.byteLength > policy.maxAssetBytes) {
    fail("too-large", "publication asset exceeds the configured byte budget");
  }

  let bytes = new Uint8Array(fetched.bytes);
  let mediaType: string;
  let extension: string;
  if (isSvg(bytes)) {
    let source: string;
    try {
      source = decodeSvgSource(bytes);
      assertSafeSvg(source);
    } catch (error) {
      throw new PublicationAssetMaterializationErrorV1(
        "unsafe-svg",
        `publication SVG asset is unsafe: ${error instanceof Error ? error.message : "unknown validation error"}`,
      );
    }
    if (svgNodeCount(source) > policy.maxSvgNodes) {
      fail("svg-node-budget", "publication SVG exceeds the configured node budget");
    }
    const size = parseSvgSize(source);
    if (size === null) fail("unsupported-media", "publication SVG has no usable intrinsic dimensions");
    assertRasterBudget(size.widthPx, size.heightPx, policy);
    // The exact UTF-8 source that passed the scanner is what gets bundled.
    bytes = new TextEncoder().encode(source);
    mediaType = "image/svg+xml";
    extension = "svg";
  } else {
    const info = decodeImageInfo(bytes);
    if (info === null) fail("unsupported-media", "publication assets must be PNG, JPEG, GIF, or safe SVG");
    assertRasterBudget(info.width, info.height, policy);
    mediaType = info.mime;
    extension = info.ext;
  }
  if (!supportedDeclaredTypeMatches(normalizeDeclaredMediaType(fetched.mediaType), mediaType)) {
    fail("mime-mismatch", `publication asset media type does not match its bytes (${mediaType})`);
  }
  if (bytes.byteLength > policy.maxAssetBytes) {
    fail("too-large", "normalized publication asset exceeds the configured byte budget");
  }
  const sha256 = sha256Hex(bytes);
  const filename = safeFilename(request.source.filename, extension);
  return {
    entry: {
      assetId: request.assetId,
      path: `assets/${sha256}/${filename}`,
      sha256,
      byteLength: bytes.byteLength,
      mediaType,
      disposition: "inline",
      downloadName: filename,
    },
    bytes,
  };
}

function materializedFilename(asset: MaterializedPublicationAssetV1): string {
  let path: string;
  try {
    path = validatePublicationOutputPathV1(asset.entry.path);
  } catch {
    return dedupFail("invalid-materialized-asset", "materialized publication asset has an unsafe path");
  }
  const segments = path.split("/");
  const filename = segments.at(-1);
  if (
    segments.length !== 3 ||
    segments[0] !== "assets" ||
    segments[1] !== asset.entry.sha256 ||
    filename === undefined ||
    filename.length === 0
  ) {
    return dedupFail("invalid-materialized-asset", "materialized publication asset is not content-addressed");
  }
  const downloadName = asset.entry.downloadName ?? filename;
  try {
    validatePublicationOutputPathV1(`assets/${asset.entry.sha256}/${downloadName}`);
  } catch {
    return dedupFail("invalid-materialized-asset", "materialized publication asset has an unsafe download name");
  }
  return downloadName;
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

/**
 * Coalesce validated individual materializations into content-addressed bundle
 * entries. Equal bytes are written once at a deterministic path while every
 * logical asset keeps a separately safe `downloadName` for future download
 * links. Acquisition itself remains intentionally outside this pure batch step.
 */
export function deduplicateMaterializedPublicationAssetsV1(
  assets: readonly MaterializedPublicationAssetV1[],
): readonly MaterializedPublicationAssetV1[] {
  const byAssetId = new Set<string>();
  const groups = new Map<string, { canonicalFilename: string; bytes: Uint8Array; mediaType: string }>();
  for (const asset of assets) {
    if (byAssetId.has(asset.entry.assetId)) {
      dedupFail("duplicate-asset-id", `duplicate materialized publication asset '${asset.entry.assetId}'`);
    }
    byAssetId.add(asset.entry.assetId);
    const filename = materializedFilename(asset);
    const existing = groups.get(asset.entry.sha256);
    if (existing === undefined) {
      groups.set(asset.entry.sha256, {
        canonicalFilename: filename,
        bytes: asset.bytes,
        mediaType: asset.entry.mediaType,
      });
      continue;
    }
    if (existing.mediaType !== asset.entry.mediaType || !sameBytes(existing.bytes, asset.bytes)) {
      dedupFail("digest-conflict", "same publication asset digest must identify equal bytes and media type");
    }
    if (filename.localeCompare(existing.canonicalFilename) < 0) {
      existing.canonicalFilename = filename;
    }
  }
  return assets.map((asset) => {
    const group = groups.get(asset.entry.sha256);
    if (group === undefined) throw new Error("unreachable publication asset deduplication group");
    const downloadName = materializedFilename(asset);
    return {
      entry: {
        ...asset.entry,
        path: `assets/${asset.entry.sha256}/${group.canonicalFilename}`,
        downloadName,
      },
      bytes: new Uint8Array(asset.bytes),
    };
  });
}

/**
 * Fetch through the source-specific trust boundary and materialize a static,
 * content-addressed image. The result contains no source URL, credentials, or
 * attachment page identity, so it is safe to place in an immutable bundle.
 */
export async function fetchAndMaterializePublicationAssetV1(
  request: PublicationAssetRequestV1,
  policy: PublicationAssetPolicyV1,
  deps: PublicationAssetMaterializationDepsV1,
  signal?: AbortSignal,
): Promise<MaterializedPublicationAssetV1> {
  let fetched: { bytes: Uint8Array; mediaType?: string };
  if (request.source.kind === "attachment") {
    if (deps.attachmentPort === undefined) {
      fail("missing-fetch-port", "publication attachment asset requires an attachment port");
    }
    fetched = await deps.attachmentPort.fetchAttachment({
      pageId: request.source.pageId,
      filename: request.source.filename,
      maxBytes: policy.maxAssetBytes,
      ...(signal === undefined ? {} : { signal }),
    });
  } else {
    if (deps.externalFetcher === undefined) {
      fail("missing-fetch-port", "publication external asset requires the policy-wrapped external fetcher");
    }
    fetched = await deps.externalFetcher.fetch(request.source.url, {
      maxBytes: policy.maxAssetBytes,
      ...(signal === undefined ? {} : { signal }),
    });
  }
  return materializeFetchedPublicationAssetV1(request, fetched, policy);
}
