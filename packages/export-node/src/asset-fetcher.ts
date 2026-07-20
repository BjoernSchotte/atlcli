/**
 * Token-auth asset fetching with a verified on-disk byte cache (spec 009,
 * batteries-included Node consumer).
 *
 * Extracted verbatim from the CLI (`apps/cli/src/commands/export-internals.ts`)
 * so external Node hosts get the exact same attachment resolution the CLI's
 * DOCX/PDF exports use — the CLI now imports from here instead of owning a
 * private copy.
 */
import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { AttachmentInfo } from "@atlcli/confluence";

const ASSET_CACHE_MAGIC = "atlcli-asset-v1";
const ASSET_CACHE_HEADER_RE = /^atlcli-asset-v1 ([0-9a-f]{64}) (\d+)$/;
const ASSET_CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

let cachePruned = false;

function encodeAssetCacheEntry(bytes: Uint8Array): Uint8Array {
  const checksum = createHash("sha256").update(bytes).digest("hex");
  const header = new TextEncoder().encode(`${ASSET_CACHE_MAGIC} ${checksum} ${bytes.byteLength}\n`);
  const encoded = new Uint8Array(header.byteLength + bytes.byteLength);
  encoded.set(header);
  encoded.set(bytes, header.byteLength);
  return encoded;
}

function decodeAssetCacheEntry(encoded: Uint8Array): Uint8Array | null {
  const newline = encoded.indexOf(0x0a);
  // The fixed-format header is 84 bytes today. Keep a small upper bound so a
  // corrupt binary file never gets decoded into an unbounded string.
  if (newline < 0 || newline > 128) return null;
  const header = new TextDecoder().decode(encoded.subarray(0, newline));
  const match = header.match(ASSET_CACHE_HEADER_RE);
  if (!match) return null;
  const payload = encoded.subarray(newline + 1);
  if (payload.byteLength === 0 || payload.byteLength !== Number(match[2])) return null;
  const checksum = createHash("sha256").update(payload).digest("hex");
  return checksum === match[1] ? payload : null;
}

function assetCachePath(baseUrl: string, key: string, cacheDir: string): string {
  const hash = createHash("sha256").update(`${baseUrl}\n${key}`).digest("hex").slice(0, 32);
  return join(cacheDir, `${hash}.bin`);
}

function pruneAssetCacheOnce(dir: string): void {
  if (cachePruned) return;
  cachePruned = true;
  void (async () => {
    try {
      const now = Date.now();
      for (const name of await readdir(dir)) {
        try {
          const path = join(dir, name);
          const s = await stat(path);
          // Orphaned temp files are only reaped after a grace period so a
          // concurrent export's in-flight write is never yanked away.
          const maxAge = name.endsWith(".tmp") ? 60_000 : ASSET_CACHE_MAX_AGE_MS;
          if (now - s.mtimeMs > maxAge) await unlink(path);
        } catch {
          // Ignore individual entries.
        }
      }
    } catch {
      // Best-effort eviction.
    }
  })();
}

export interface AssetByteCache {
  pathFor(key: string): string;
  getOrLoad(key: string, load: () => Promise<Uint8Array>): Promise<Uint8Array>;
}

/** Disk cache for immutable export assets (default: `~/.atlcli/cache/assets`). */
export function createAssetByteCache(
  baseUrl: string,
  cacheDir = join(homedir(), ".atlcli", "cache", "assets")
): AssetByteCache {
  const pathFor = (key: string): string => assetCachePath(baseUrl, key, cacheDir);
  return {
    pathFor,
    async getOrLoad(key, load) {
      const cachePath = pathFor(key);
      try {
        // Cache contents can be private Confluence attachments. Repair legacy
        // permissions opportunistically on every hit.
        await chmod(dirname(cachePath), 0o700).catch(() => {});
        const cached = new Uint8Array(await readFile(cachePath));
        await chmod(cachePath, 0o600).catch(() => {});
        const decoded = decodeAssetCacheEntry(cached);
        if (decoded) return decoded;
      } catch {
        // Cache miss; fall through to the authoritative loader.
      }

      const bytes = await load();
      try {
        const dir = dirname(cachePath);
        await mkdir(dir, { recursive: true, mode: 0o700 });
        await chmod(dir, 0o700);
        const tmp = `${cachePath}.${process.pid.toString(36)}${Math.random().toString(36).slice(2)}.tmp`;
        await writeFile(tmp, encodeAssetCacheEntry(bytes), { mode: 0o600 });
        await chmod(tmp, 0o600);
        await rename(tmp, cachePath);
        await chmod(cachePath, 0o600);
        pruneAssetCacheOnce(dir);
      } catch {
        // Cache writes are best-effort and never fail an export.
      }
      return bytes;
    },
  };
}

/** The subset of `ConfluenceClient` the token asset adapter needs. */
export interface AssetClient {
  listAttachments(pageId: string): Promise<AttachmentInfo[]>;
  downloadAttachment(
    attachment: AttachmentInfo | { downloadUrl: string },
    options?: { signal?: AbortSignal }
  ): Promise<Uint8Array>;
}

/** Token-auth asset adapter with two immutable cache-key paths (regression-tested). */
export function tokenAssetFetcher(client: AssetClient, cache: Pick<AssetByteCache, "getOrLoad">): {
  fetch(ref: { url: string; pageId?: string; filename?: string }, context?: { signal?: AbortSignal }): Promise<Uint8Array>;
} {
  const listings = new Map<string, Promise<AttachmentInfo[]>>();
  const download = async (
    ref: { url: string; pageId?: string; filename?: string },
    cacheAttachment = true,
    signal?: AbortSignal
  ): Promise<Uint8Array> => {
    if (/^https?:\/\//i.test(ref.url)) {
      // Thread the abort signal so a mid-export Ctrl-C stops external image
      // downloads, not just orchestration (spec 002 cancellation).
      const res = await fetch(ref.url, signal ? { signal } : {});
      if (!res.ok) throw new Error(`image download failed (${res.status}) for ${ref.url}`);
      return new Uint8Array(await res.arrayBuffer());
    }
    if (ref.pageId && ref.filename) {
      let listing = listings.get(ref.pageId);
      if (!listing) {
        listing = client.listAttachments(ref.pageId);
        listings.set(ref.pageId, listing);
      }
      const attachment = (await listing).find((a) => a.filename === ref.filename);
      if (!attachment) throw new Error(`attachment "${ref.filename}" not found on page ${ref.pageId}`);
      if (!cacheAttachment) return client.downloadAttachment(attachment, { signal });
      return cache.getOrLoad(`attachment:${attachment.id}:v${attachment.version}`, () =>
        client.downloadAttachment(attachment, { signal })
      );
    }
    return client.downloadAttachment({ downloadUrl: ref.url }, { signal });
  };

  return {
    async fetch(ref, context) {
      const signal = context?.signal;
      if (ref.url.startsWith("/download/") && /[?&](version|modificationDate)=/.test(ref.url)) {
        // The immutable URL entry provides the repeat-export no-listing win.
        // Bypass the inner id+version cache on a miss to avoid storing the same
        // custom-logo bytes under two hashes.
        return cache.getOrLoad(`url:${ref.url}`, () => download(ref, false, signal));
      }
      return download(ref, true, signal);
    },
  };
}
