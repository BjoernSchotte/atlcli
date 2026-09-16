/**
 * The disk cache (WP3.1, WP3.2, WP3.6).
 *
 * ## Why this is sound
 *
 * Confluence page versions are monotonic and a published version is immutable.
 * So `(pageId, version)` is a content-addressed key: an entry is either correct
 * or absent, never stale. Invalidation therefore belongs entirely to the tree
 * index — when it learns a page moved from version 12 to 13, version 12's row
 * simply stops being asked for. Nothing in this file has to reason about
 * freshness.
 *
 * ## Why it is a bounded LRU
 *
 * The cache is not a mirror (plan section 1b, rule 4). It may be deleted at any
 * moment with no loss of function, and it must never grow without limit.
 * Eviction runs **while** writing rather than afterwards, so the ceiling is a
 * ceiling rather than a high-water mark, and attachment blobs count against the
 * same budget as bodies — one number the user can reason about.
 *
 * ## Why the path carries profile and account
 *
 * Two profiles pointed at the same cache directory must not be able to read
 * each other's content. Confluence filters visibility per caller, and a shared
 * cache would undo that in the one place the server cannot see. So the database
 * always lives at `<cacheDir>/<profile>/<accountId>/<siteHash>.db` and the path
 * construction is not optional.
 */
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface BodyCacheOptions {
  /** Absolute path of the SQLite file. See {@link resolveCachePaths}. */
  dbPath: string;
  /** Directory holding attachment blobs, beside the database. */
  blobDir: string;
  /** Ceiling in bytes for bodies plus blobs together. */
  maxBytes: number;
  now: () => number;
}

export interface CachedBody {
  pageId: string;
  version: number;
  markdown: string;
  storageHash: string;
  fetchedAt: number;
}

export interface CachedAttachment {
  attachmentId: string;
  pageId: string;
  filename: string;
  mediaType: string;
  size: number;
  version: number;
  blobPath: string;
}

export interface CacheStats {
  bodies: number;
  attachments: number;
  bytes: number;
  maxBytes: number;
  oldestFetchedAt: number | undefined;
  newestFetchedAt: number | undefined;
  hits: number;
  misses: number;
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS schema_info (
    version INTEGER PRIMARY KEY,
    migrated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- (page_id, version) is content-addressed: rows are immutable once written.
  CREATE TABLE IF NOT EXISTS bodies (
    page_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    markdown TEXT NOT NULL,
    storage_hash TEXT NOT NULL,
    bytes INTEGER NOT NULL,
    fetched_at INTEGER NOT NULL,
    accessed_at INTEGER NOT NULL,
    PRIMARY KEY (page_id, version)
  );
  CREATE INDEX IF NOT EXISTS bodies_accessed ON bodies (accessed_at);

  CREATE TABLE IF NOT EXISTS attachments (
    attachment_id TEXT PRIMARY KEY,
    page_id TEXT NOT NULL,
    filename TEXT NOT NULL,
    media_type TEXT NOT NULL,
    bytes INTEGER NOT NULL,
    version INTEGER NOT NULL,
    blob_path TEXT NOT NULL,
    fetched_at INTEGER NOT NULL,
    accessed_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS attachments_accessed ON attachments (accessed_at);
  CREATE INDEX IF NOT EXISTS attachments_page ON attachments (page_id);
`;

const SCHEMA_VERSION = 1;

/**
 * Where the cache lives for one profile against one site.
 *
 * The site hash keeps two tenants of the same profile name apart, and the
 * account ID keeps two users of the same profile apart. Neither is decoration:
 * dropping either would let one caller read content the other's token returned.
 */
export function resolveCachePaths(params: {
  cacheDir: string;
  profile: string;
  accountId: string;
  instanceUrl: string;
}): {
  dir: string;
  dbPath: string;
  blobDir: string;
  conflictDir: string;
  identityPath: string;
} {
  const siteHash = siteHashOf(params.instanceUrl);
  const dir = join(params.cacheDir, sanitize(params.profile), sanitize(params.accountId));
  return {
    dir,
    dbPath: join(dir, `${siteHash}.db`),
    blobDir: join(dir, `${siteHash}-blobs`),
    conflictDir: join(params.cacheDir, "conflicts"),
    identityPath: identityPathFor(params.cacheDir, params.profile, params.instanceUrl),
  };
}

export function siteHashOf(instanceUrl: string): string {
  return createHash("sha256").update(instanceUrl.toLowerCase()).digest("hex").slice(0, 16);
}

/**
 * Where the account ID of the last online session for this profile and site is
 * remembered.
 *
 * `--offline` needs the account ID to find its cache, and finding out costs a
 * request — the one thing offline mode must not make. So an online open records
 * it here, and an offline open reads it back. It is a **pointer**, not content:
 * deleting it costs one online session, never correctness, and it holds no
 * token.
 */
export function identityPathFor(
  cacheDir: string,
  profile: string,
  instanceUrl: string,
): string {
  return join(cacheDir, sanitize(profile), `identity-${siteHashOf(instanceUrl)}.json`);
}

export function rememberIdentity(
  identityPath: string,
  identity: { accountId: string; displayName: string },
): void {
  try {
    mkdirSync(dirname(identityPath), { recursive: true });
    writeFileSync(identityPath, JSON.stringify(identity));
  } catch {
    // Best effort: the next offline session simply has to run online once.
  }
}

export function recallIdentity(
  identityPath: string,
): { accountId: string; displayName: string } | undefined {
  try {
    const raw = JSON.parse(readFileSync(identityPath, "utf8")) as Record<string, unknown>;
    if (typeof raw.accountId === "string" && typeof raw.displayName === "string") {
      return { accountId: raw.accountId, displayName: raw.displayName };
    }
  } catch {
    // Absent or unreadable: treated as "never been online here".
  }
  return undefined;
}

/** Keeps a profile or account name from escaping its directory. */
function sanitize(segment: string): string {
  const cleaned = segment.replace(/[^A-Za-z0-9._-]+/g, "_");
  return cleaned === "" || cleaned === "." || cleaned === ".." ? "_" : cleaned;
}

/**
 * Storage-format hash, insensitive to formatting.
 *
 * Whitespace *between* tags carries no meaning in Confluence storage, and the
 * Markdown converter re-emits it differently (one element per line) than
 * Confluence stores it (no separators). Hashing the raw text would therefore
 * report every page as changed, which is useless for the one thing this hash is
 * for: deciding whether a Markdown round trip lost anything real.
 */
export function hashStorage(storage: string): string {
  return createHash("sha256").update(normalizeStorage(storage)).digest("hex");
}

export function normalizeStorage(storage: string): string {
  return storage.replace(/>\s+</g, "><").trim();
}

export class BodyCache {
  private readonly db: Database;
  private readonly opts: BodyCacheOptions;
  private hits = 0;
  private misses = 0;

  constructor(options: BodyCacheOptions) {
    this.opts = options;
    mkdirSync(dirname(options.dbPath), { recursive: true });
    mkdirSync(options.blobDir, { recursive: true });
    this.db = new Database(options.dbPath, { create: true });
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec(SCHEMA);
    this.db.run("INSERT OR IGNORE INTO schema_info (version) VALUES (?)", [SCHEMA_VERSION]);
  }

  close(): void {
    this.db.close();
  }

  // ------------------------------------------------------------------ bodies

  /** A hit only when the version matches exactly. */
  getBody(pageId: string, version: number): CachedBody | undefined {
    const row = this.db
      .query<
        {
          page_id: string;
          version: number;
          markdown: string;
          storage_hash: string;
          fetched_at: number;
        },
        [string, number]
      >("SELECT page_id, version, markdown, storage_hash, fetched_at FROM bodies WHERE page_id = ? AND version = ?")
      .get(pageId, version);
    if (!row) {
      this.misses += 1;
      return undefined;
    }
    this.hits += 1;
    this.db.run("UPDATE bodies SET accessed_at = ? WHERE page_id = ? AND version = ?", [
      this.opts.now(),
      pageId,
      version,
    ]);
    return {
      pageId: row.page_id,
      version: row.version,
      markdown: row.markdown,
      storageHash: row.storage_hash,
      fetchedAt: row.fetched_at,
    };
  }

  /**
   * Store one body, evicting first so the ceiling is never exceeded.
   *
   * A body larger than the whole budget is **not** cached: storing it would
   * evict everything else and then still not fit. It is returned to the caller
   * either way, so the only cost is that it is re-fetched next time.
   */
  putBody(body: { pageId: string; version: number; markdown: string; storageHash: string }): void {
    const bytes = Buffer.byteLength(body.markdown, "utf8");
    if (bytes > this.opts.maxBytes) return;
    this.evictFor(bytes, { keepPageId: body.pageId, keepVersion: body.version });
    const now = this.opts.now();
    this.db.run(
      `INSERT INTO bodies (page_id, version, markdown, storage_hash, bytes, fetched_at, accessed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (page_id, version) DO UPDATE SET accessed_at = excluded.accessed_at`,
      [body.pageId, body.version, body.markdown, body.storageHash, bytes, now, now],
    );
  }

  /** Drops every version of one page. Used after a delete. */
  forgetPage(pageId: string): void {
    this.db.run("DELETE FROM bodies WHERE page_id = ?", [pageId]);
    for (const row of this.db
      .query<{ blob_path: string }, [string]>("SELECT blob_path FROM attachments WHERE page_id = ?")
      .all(pageId)) {
      rmSync(row.blob_path, { force: true });
    }
    this.db.run("DELETE FROM attachments WHERE page_id = ?", [pageId]);
  }

  // ------------------------------------------------------------ attachments

  getAttachment(attachmentId: string, version: number): CachedAttachment | undefined {
    const row = this.db
      .query<
        {
          attachment_id: string;
          page_id: string;
          filename: string;
          media_type: string;
          bytes: number;
          version: number;
          blob_path: string;
        },
        [string, number]
      >(
        `SELECT attachment_id, page_id, filename, media_type, bytes, version, blob_path
         FROM attachments WHERE attachment_id = ? AND version = ?`,
      )
      .get(attachmentId, version);
    if (!row || !existsSync(row.blob_path)) {
      this.misses += 1;
      return undefined;
    }
    this.hits += 1;
    this.db.run("UPDATE attachments SET accessed_at = ? WHERE attachment_id = ?", [
      this.opts.now(),
      attachmentId,
    ]);
    return {
      attachmentId: row.attachment_id,
      pageId: row.page_id,
      filename: row.filename,
      mediaType: row.media_type,
      size: row.bytes,
      version: row.version,
      blobPath: row.blob_path,
    };
  }

  readAttachmentBytes(cached: CachedAttachment): Uint8Array {
    return new Uint8Array(readFileSync(cached.blobPath));
  }

  /** Writes a blob and its row, evicting first. Returns false when it cannot fit. */
  putAttachment(meta: {
    attachmentId: string;
    pageId: string;
    filename: string;
    mediaType: string;
    version: number;
    bytes: Uint8Array;
  }): CachedAttachment | undefined {
    const size = meta.bytes.byteLength;
    if (size > this.opts.maxBytes) return undefined;
    this.evictFor(size, { keepAttachmentId: meta.attachmentId });
    const blobPath = join(this.opts.blobDir, `${meta.attachmentId}-${meta.version}.bin`);
    writeFileSync(blobPath, meta.bytes);
    const now = this.opts.now();
    this.db.run(
      `INSERT INTO attachments
         (attachment_id, page_id, filename, media_type, bytes, version, blob_path, fetched_at, accessed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (attachment_id) DO UPDATE SET
         bytes = excluded.bytes, version = excluded.version, blob_path = excluded.blob_path,
         fetched_at = excluded.fetched_at, accessed_at = excluded.accessed_at`,
      [
        meta.attachmentId,
        meta.pageId,
        meta.filename,
        meta.mediaType,
        size,
        meta.version,
        blobPath,
        now,
        now,
      ],
    );
    return {
      attachmentId: meta.attachmentId,
      pageId: meta.pageId,
      filename: meta.filename,
      mediaType: meta.mediaType,
      size,
      version: meta.version,
      blobPath,
    };
  }

  // -------------------------------------------------------------- eviction

  usedBytes(): number {
    const bodies =
      this.db.query<{ total: number | null }, []>("SELECT SUM(bytes) AS total FROM bodies").get()
        ?.total ?? 0;
    const blobs =
      this.db
        .query<{ total: number | null }, []>("SELECT SUM(bytes) AS total FROM attachments")
        .get()?.total ?? 0;
    return bodies + blobs;
  }

  /**
   * Evict least-recently-accessed entries until `incoming` bytes fit.
   *
   * Bodies and blobs are evicted from one merged list ordered by access time,
   * so a large blob cannot starve bodies just by being in a different table.
   * The `keep*` guards stop an in-flight write from evicting itself.
   */
  private evictFor(
    incoming: number,
    keep: { keepPageId?: string; keepVersion?: number; keepAttachmentId?: string } = {},
  ): void {
    let used = this.usedBytes();
    if (used + incoming <= this.opts.maxBytes) return;

    const candidates = [
      ...this.db
        .query<
          { kind: string; a: string; b: number; bytes: number; accessed_at: number; blob: string | null },
          []
        >(
          `SELECT 'body' AS kind, page_id AS a, version AS b, bytes, accessed_at, NULL AS blob FROM bodies
           UNION ALL
           SELECT 'attachment' AS kind, attachment_id AS a, version AS b, bytes, accessed_at, blob_path AS blob FROM attachments
           ORDER BY accessed_at ASC`,
        )
        .all(),
    ];

    for (const row of candidates) {
      if (used + incoming <= this.opts.maxBytes) break;
      if (row.kind === "body") {
        if (row.a === keep.keepPageId && row.b === keep.keepVersion) continue;
        this.db.run("DELETE FROM bodies WHERE page_id = ? AND version = ?", [row.a, row.b]);
      } else {
        if (row.a === keep.keepAttachmentId) continue;
        if (row.blob) rmSync(row.blob, { force: true });
        this.db.run("DELETE FROM attachments WHERE attachment_id = ?", [row.a]);
      }
      used -= row.bytes;
    }
  }

  // ----------------------------------------------------------------- stats

  stats(): CacheStats {
    const bodies =
      this.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM bodies").get()?.n ?? 0;
    const attachments =
      this.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM attachments").get()?.n ?? 0;
    const range = this.db
      .query<{ oldest: number | null; newest: number | null }, []>(
        `SELECT MIN(fetched_at) AS oldest, MAX(fetched_at) AS newest FROM (
           SELECT fetched_at FROM bodies UNION ALL SELECT fetched_at FROM attachments
         )`,
      )
      .get();
    return {
      bodies,
      attachments,
      bytes: this.usedBytes(),
      maxBytes: this.opts.maxBytes,
      oldestFetchedAt: range?.oldest ?? undefined,
      newestFetchedAt: range?.newest ?? undefined,
      hits: this.hits,
      misses: this.misses,
    };
  }

  /** Empties the cache. Safe at any time: nothing here is a source of truth. */
  clear(options: { spaceKeyPageIds?: string[] } = {}): void {
    if (options.spaceKeyPageIds) {
      for (const pageId of options.spaceKeyPageIds) this.forgetPage(pageId);
      return;
    }
    for (const row of this.db
      .query<{ blob_path: string }, []>("SELECT blob_path FROM attachments")
      .all()) {
      rmSync(row.blob_path, { force: true });
    }
    this.db.run("DELETE FROM bodies");
    this.db.run("DELETE FROM attachments");
  }

  /** Bytes the blob directory actually occupies, for the stats command. */
  blobBytesOnDisk(): number {
    let total = 0;
    for (const row of this.db
      .query<{ blob_path: string }, []>("SELECT blob_path FROM attachments")
      .all()) {
      try {
        total += statSync(row.blob_path).size;
      } catch {
        // A blob removed underneath us simply contributes nothing.
      }
    }
    return total;
  }
}
