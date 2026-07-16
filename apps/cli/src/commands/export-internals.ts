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

/** Internal disk cache for immutable export assets. Not exported from the CLI package barrel. */
export function createAssetByteCache(
  baseUrl: string,
  cacheDir = join(homedir(), ".atlcli", "cache", "assets")
): {
  pathFor(key: string): string;
  getOrLoad(key: string, load: () => Promise<Uint8Array>): Promise<Uint8Array>;
} {
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

interface AssetByteCache {
  getOrLoad(key: string, load: () => Promise<Uint8Array>): Promise<Uint8Array>;
}

interface AssetClient {
  listAttachments(pageId: string): Promise<AttachmentInfo[]>;
  downloadAttachment(attachment: AttachmentInfo | { downloadUrl: string }): Promise<Uint8Array>;
}

/** Token-auth asset adapter, kept here so its two immutable cache-key paths are regression-testable. */
export function tokenAssetFetcher(client: AssetClient, cache: AssetByteCache): {
  fetch(ref: { url: string; pageId?: string; filename?: string }): Promise<Uint8Array>;
} {
  const listings = new Map<string, Promise<AttachmentInfo[]>>();
  const download = async (
    ref: { url: string; pageId?: string; filename?: string },
    cacheAttachment = true
  ): Promise<Uint8Array> => {
    if (/^https?:\/\//i.test(ref.url)) {
      const res = await fetch(ref.url);
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
      if (!cacheAttachment) return client.downloadAttachment(attachment);
      return cache.getOrLoad(`attachment:${attachment.id}:v${attachment.version}`, () =>
        client.downloadAttachment(attachment)
      );
    }
    return client.downloadAttachment({ downloadUrl: ref.url });
  };

  return {
    async fetch(ref) {
      if (ref.url.startsWith("/download/") && /[?&](version|modificationDate)=/.test(ref.url)) {
        // The immutable URL entry provides the repeat-export no-listing win.
        // Bypass the inner id+version cache on a miss to avoid storing the same
        // custom-logo bytes under two hashes.
        return cache.getOrLoad(`url:${ref.url}`, () => download(ref, false));
      }
      return download(ref);
    },
  };
}

/** Cheap, conservative gate before loading the resvg wasm and bundled fonts. */
export function mightContainMermaid(storage: string): boolean {
  return /<ac:parameter\b[^>]*\bac:name\s*=\s*["']language["'][^>]*>\s*mermaid\s*<\/ac:parameter\s*>/i.test(
    storage
  );
}

/** Start only the page-key-dependent requests named by the local template scan. */
export function prestartPageDependentDeps(input: {
  pagePromise: Promise<{ spaceKey?: string }>;
  templateDeps: ReadonlySet<string>;
  embedImages: boolean;
  getSpaceWithIcon: (spaceKey: string) => Promise<unknown>;
  getSpaceHomepageStorage: (spaceKey: string) => Promise<unknown>;
}): void {
  const prefetch = input.pagePromise.then((details) => {
    const key = details.spaceKey;
    if (!key) return;
    if (
      input.templateDeps.has("space") ||
      (input.embedImages && input.templateDeps.has("spaceLogo"))
    ) {
      input.getSpaceWithIcon(key).catch(() => {});
    }
    if (input.templateDeps.has("spaceHomepage")) {
      input.getSpaceHomepageStorage(key).catch(() => {});
    }
  });
  // The engine still awaits the original page promise and reports that error.
  // This derived optimization branch must never become an unhandled rejection.
  prefetch.catch(() => {});
}
