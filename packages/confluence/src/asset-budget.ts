/**
 * Shared asset-budget contract (spec 002, Engine integration).
 *
 * A tree/space export can pull in far more image bytes than a single page. Both
 * engines (DOCX zip surgery, PDF Typst VFS) must bound total embedded-asset
 * memory the SAME way — same caps, same content-dedup, same fatal-on-breach
 * behavior, same offender list — so an image-heavy export fails early and
 * actionably in one place rather than "succeeding" with silently dropped images
 * in one engine and a hard error in the other.
 *
 * This is that one contract: {@link AssetBudget} accounts bytes, deduplicates by
 * content BEFORE counting against the total cap, and throws
 * {@link AssetBudgetExceededError} (carrying the offender list + suggestions) the
 * moment a *new* asset would push the running total past the cap. Per-file size
 * limits stay in each engine's own decode path (they are per-image warnings, not
 * a fatal scope-level error); the total cap here is the fatal one.
 *
 * Content hash: an isomorphic (no `node:crypto`, no async `crypto.subtle`)
 * FNV-1a-plus-length bucket key with byte-equality verification on collision —
 * the same precedent both engines already use for asset dedup
 * (`packages/docx/src/image.ts`, `packages/pdf/src/prepare.ts`). Byte
 * verification makes the (rare) hash collision harmless, so the dedup decision
 * is exact regardless of the hash function. A real SHA-256 would force the whole
 * synchronous asset-accounting path async for no correctness gain.
 *
 * Isomorphic: no `node:`/`bun:` specifiers — only `Uint8Array`/`Map`.
 */

/** Total embedded-asset byte cap shared by both engines (50 MiB). */
export const ASSET_MAX_TOTAL_BYTES = 50 * 1024 * 1024;

/** Per-file embedded-asset byte cap shared by both engines (25 MiB). */
export const ASSET_MAX_BYTES = 25 * 1024 * 1024;

/** One asset that counted against the budget, for the breach offender list. */
export interface AssetBudgetOffender {
  /** Attachment filename or external URL (whatever the engine knows). */
  filename: string;
  /** Owning page id when known (multi-page export). Title resolution is a host concern. */
  pageId?: string;
  /** Size of this asset's bytes. */
  sizeBytes: number;
}

/** Metadata an engine supplies when accounting one asset. */
export interface AssetBudgetMeta {
  filename: string;
  pageId?: string;
}

/** Round bytes to a human MB string for messages. */
function mb(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Fatal, scope-level budget breach. Thrown by {@link AssetBudget.account} the
 * moment a new asset would exceed the total cap — both engines let it propagate
 * out of the export (aborting before any output is committed) rather than
 * degrading to a per-image warning.
 */
export class AssetBudgetExceededError extends Error {
  constructor(
    /** All counted assets plus the breaching one, sorted largest-first. */
    public readonly offenders: readonly AssetBudgetOffender[],
    /** The would-be running total that breached the cap. */
    public readonly totalBytes: number,
    /** The cap that was exceeded. */
    public readonly limitBytes: number
  ) {
    super(
      `Export aborted: embedded images total ${mb(totalBytes)}, over the ${mb(limitBytes)} limit. ` +
        `Largest: ${offenders
          .slice(0, 5)
          .map((o) => `"${o.filename}"${o.pageId ? ` (page ${o.pageId})` : ""} ${mb(o.sizeBytes)}`)
          .join(", ")}. ` +
        `Narrow the export with --max-depth or a label filter, or re-run with --no-images.`
    );
    this.name = "AssetBudgetExceededError";
  }
}

/** FNV-1a (32-bit) plus length → a bucket key; byte-equality verifies members. */
function contentHash(bytes: Uint8Array): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i += 1) {
    hash ^= bytes[i]!;
    hash = Math.imul(hash, 0x01000193);
  }
  return `${(hash >>> 0).toString(16)}:${bytes.length}`;
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let i = 0; i < left.byteLength; i += 1) {
    if (left[i] !== right[i]) return false;
  }
  return true;
}

export interface AssetBudgetOptions {
  /** Total-byte cap (defaults to {@link ASSET_MAX_TOTAL_BYTES}). */
  maxTotalBytes?: number;
}

/**
 * Running total of embedded-asset bytes with content dedup and a fatal cap.
 * Construct once per export; call {@link account} per fetched asset before
 * embedding it.
 */
export class AssetBudget {
  private readonly maxTotalBytes: number;
  private total = 0;
  /** content-hash bucket → members (byte-verified so collisions are exact). */
  private readonly buckets = new Map<string, Uint8Array[]>();
  /** Every distinct asset that counted, in first-seen order (offender source). */
  private readonly counted: AssetBudgetOffender[] = [];

  constructor(options: AssetBudgetOptions = {}) {
    this.maxTotalBytes = options.maxTotalBytes ?? ASSET_MAX_TOTAL_BYTES;
  }

  /** Total bytes counted so far (deduped). */
  get totalBytes(): number {
    return this.total;
  }

  /**
   * Account one asset. Deduplicates by content FIRST — a byte-identical asset
   * seen before returns `{ deduped: true }` and does NOT count again. A new
   * asset that would push the running total past the cap throws
   * {@link AssetBudgetExceededError} (with the offender list) BEFORE it is
   * counted, so the caller can abort before committing any output.
   */
  account(bytes: Uint8Array, meta: AssetBudgetMeta): { deduped: boolean } {
    const key = contentHash(bytes);
    const bucket = this.buckets.get(key);
    if (bucket) {
      for (const member of bucket) {
        if (sameBytes(member, bytes)) return { deduped: true };
      }
    }
    const size = bytes.byteLength;
    if (this.total + size > this.maxTotalBytes) {
      const offenders = [
        ...this.counted,
        { filename: meta.filename, sizeBytes: size, ...(meta.pageId ? { pageId: meta.pageId } : {}) },
      ].sort((a, b) => b.sizeBytes - a.sizeBytes || a.filename.localeCompare(b.filename));
      throw new AssetBudgetExceededError(offenders, this.total + size, this.maxTotalBytes);
    }
    if (bucket) bucket.push(bytes);
    else this.buckets.set(key, [bytes]);
    this.total += size;
    this.counted.push({
      filename: meta.filename,
      sizeBytes: size,
      ...(meta.pageId ? { pageId: meta.pageId } : {}),
    });
    return { deduped: false };
  }
}
