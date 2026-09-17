import { VfsError } from "@atlcli/confluence-vfs";
import { Database, type Statement, type SQLQueryBindings } from "bun:sqlite";
import fs, { chmodSync, mkdirSync, realpathSync } from "node:fs";
import { dirname, posix, resolve, join } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { isNfsPageDirectory, isNfsPageDraft } from "./mount-client-probes.js";

export interface StagedNfsFile {
  id: string;
  path: string;
  bytes: Uint8Array;
  baseVersion: number;
  revision: number;
  publishedRevision: number;
  error: string | null;
}
export interface LocalNfsEntry extends StagedNfsFile {
  kind: "file" | "directory";
}
export interface NfsPublishIntent {
  id: string;
  bytes: Uint8Array;
  baseVersion: number;
  revision: number;
}

export interface NfsCreateIntent extends NfsPublishIntent {
  path: string;
  spaceKey: string;
  parentId: string;
  pageId: string | null;
  version: number | null;
}

export interface NfsMoveIntent {
  id: string;
  kind: "page" | "folder";
  source: string;
  target: string;
  spaceKey: string;
  sourceParentId: string;
  sourceTitle: string | null;
  targetParentId: string;
  title: string;
  completed: number;
}

export interface NfsWriteStatus {
  pendingPages: number;
  failedPages: number;
  displacedPages: number;
  localEntries: number;
  unresolvedPublications: number;
}

/** Stable across remounts; exact identity components are hashed, never used as path segments. */
export function nfsJournalLocation(identity: {
  cacheDir: string; profile: string; accountId: string; instanceUrl: string; spaces: readonly string[];
}): { path: string; scope: string } {
  for (const value of [identity.cacheDir, identity.profile, identity.accountId, identity.instanceUrl]) {
    if (!value || value.includes("\0")) throw new Error("Invalid NFS journal identity");
  }
  const site = new URL(identity.instanceUrl);
  if (!["https:", "http:"].includes(site.protocol) || site.username || site.password || site.search || site.hash) {
    throw new Error("Invalid NFS journal site");
  }
  if (!identity.spaces.length || identity.spaces.some(space => !space || /[\/\0]/.test(space) || space === "." || space === "..")) {
    throw new Error("Invalid NFS journal export");
  }
  const scope = JSON.stringify([1, identity.profile, identity.accountId, site.href.replace(/\/+$/, ""),
    [...new Set(identity.spaces)].sort()]);
  const key = createHash("sha256").update(scope).digest("hex");
  return { path: join(resolve(identity.cacheDir), "nfs-journals", `${key}.sqlite`), scope };
}

/** Non-evictable local stable storage. Separate from the disposable VFS cache. */
export class NfsJournal {
  private readonly db: Database;
  // Fixed SQL templates only. Bun's bounded query cache leaves overflow
  // statements unowned; retain and finalize every journal statement ourselves.
  private readonly queries = new Map<string, Statement>();
  private query<T = unknown, Params extends SQLQueryBindings[] = SQLQueryBindings[]>(sql: string): Statement<T, Params> {
    let statement = this.queries.get(sql);
    if (!statement) { statement = this.db.prepare(sql); this.queries.set(sql, statement); }
    return statement as Statement<T, Params>;
  }
  /** Actual database ceiling; recovered larger databases are never truncated. */
  readonly databaseLimitBytes: number;
  constructor(path: string, scope: string, private readonly maxBytes = 256 * 1024 * 1024,
    private readonly maxFileBytes = 64 * 1024 * 1024, private readonly maxFiles = 4096,
    maxDatabaseBytes = 2 * maxBytes + 8192 * maxFiles + 1024 * 1024) {
    if (!scope || !Number.isSafeInteger(maxBytes) || maxBytes < 1 ||
      !Number.isSafeInteger(maxFileBytes) || maxFileBytes < 1 ||
      !Number.isSafeInteger(maxFiles) || maxFiles < 1 ||
      !Number.isSafeInteger(maxDatabaseBytes) || maxDatabaseBytes < 65536 || maxDatabaseBytes > 1024 ** 4) throw new Error("Invalid NFS journal limits or scope");
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new Database(path, { create: true });
    try {
      // SQLite owns the cross-process lock and releases it even after SIGKILL.
      // Retain it between transactions: two publishers must never share a journal.
      this.db.exec("PRAGMA locking_mode=EXCLUSIVE");
      this.db.exec("BEGIN EXCLUSIVE");
      this.db.exec("COMMIT");
      chmodSync(path, 0o600);
      const version = this.query<{ user_version: number }, []>("PRAGMA user_version").get()!.user_version;
      if (!Number.isInteger(version) || version < 0 || version > 16) throw new Error("Unsupported NFS journal schema version");
      this.db.exec("PRAGMA busy_timeout=5000;");
      // No concurrent reader/writer throughput is needed here. Rollback mode
      // avoids WAL growth pinned by readers. Exclusive mode retains the rollback
      // file; truncate it after each transaction instead of retaining its peak size.
      const mode = this.query<{ journal_mode: string }, []>("PRAGMA journal_mode=DELETE").get()!.journal_mode;
      if (mode !== "delete") throw new Error("Cannot enable bounded NFS rollback journal");
      this.db.exec("PRAGMA synchronous=EXTRA; PRAGMA fullfsync=ON; PRAGMA journal_size_limit=0;");
      const pageSize = this.query<{ page_size: number }, []>("PRAGMA page_size").get()!.page_size;
      const pages = this.query<{ max_page_count: number }, []>(
        `PRAGMA max_page_count=${Math.floor(maxDatabaseBytes / pageSize)}`,
      ).get()!.max_page_count;
      this.databaseLimitBytes = pages * pageSize;
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS identity (singleton INTEGER PRIMARY KEY CHECK(singleton=1), scope TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS files (
          id TEXT PRIMARY KEY, path TEXT NOT NULL, bytes BLOB NOT NULL,
          baseVersion INTEGER NOT NULL, revision INTEGER NOT NULL,
          publishedRevision INTEGER NOT NULL, error TEXT
        );
        CREATE TABLE IF NOT EXISTS intents (
          id TEXT PRIMARY KEY REFERENCES files(id), bytes BLOB NOT NULL,
          baseVersion INTEGER NOT NULL, revision INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS bases (id TEXT PRIMARY KEY REFERENCES files(id), bytes BLOB NOT NULL);
        PRAGMA foreign_keys=ON;
        CREATE TABLE IF NOT EXISTS locals (id TEXT PRIMARY KEY REFERENCES files(id), path TEXT NOT NULL UNIQUE, verifier TEXT);

      `);
      this.db.transaction(() => {
        const columns = this.query<{ name: string }, []>("PRAGMA table_info(locals)").all();
        if (!columns.some(column => column.name === "verifier")) this.db.exec("ALTER TABLE locals ADD COLUMN verifier TEXT");
        if (!columns.some(column => column.name === "originId")) this.db.exec("ALTER TABLE locals ADD COLUMN originId TEXT");
        if (!columns.some(column => column.name === "kind")) this.db.exec("ALTER TABLE locals ADD COLUMN kind TEXT NOT NULL DEFAULT 'file' CHECK(kind IN ('file','directory'))");
        this.db.exec(`CREATE TABLE IF NOT EXISTS attributes (id TEXT PRIMARY KEY REFERENCES files(id), mode INTEGER NOT NULL, atime INTEGER, mtime INTEGER); CREATE TABLE IF NOT EXISTS displaced (id TEXT PRIMARY KEY REFERENCES files(id), path TEXT NOT NULL UNIQUE); CREATE TABLE IF NOT EXISTS page_verifiers (id TEXT PRIMARY KEY REFERENCES files(id), verifier TEXT NOT NULL); CREATE TABLE IF NOT EXISTS creations (
          id TEXT PRIMARY KEY REFERENCES files(id), path TEXT NOT NULL,
          spaceKey TEXT NOT NULL, parentId TEXT NOT NULL, pageId TEXT UNIQUE, version INTEGER,
          CHECK ((pageId IS NULL AND version IS NULL) OR (pageId IS NOT NULL AND version > 0))
        ); CREATE TABLE IF NOT EXISTS promotions (localId TEXT PRIMARY KEY, path TEXT NOT NULL UNIQUE, pageId TEXT NOT NULL UNIQUE REFERENCES files(id)); CREATE TABLE IF NOT EXISTS trash (id TEXT PRIMARY KEY REFERENCES files(id), path TEXT NOT NULL, spaceKey TEXT NOT NULL, completed INTEGER NOT NULL DEFAULT 0 CHECK(completed IN (0,1))); CREATE TABLE IF NOT EXISTS moves (id TEXT PRIMARY KEY, source TEXT NOT NULL UNIQUE,
          target TEXT NOT NULL UNIQUE, spaceKey TEXT NOT NULL, sourceParentId TEXT NOT NULL,
          targetParentId TEXT NOT NULL, title TEXT NOT NULL, completed INTEGER NOT NULL DEFAULT 0 CHECK(completed IN (0,1)));
          PRAGMA user_version=16;`);
        const promotionColumns = this.query<{ name: string }, []>("PRAGMA table_info(promotions)").all();
        if (!promotionColumns.some(column => column.name === "directoryId")) this.db.exec("ALTER TABLE promotions ADD COLUMN directoryId TEXT REFERENCES files(id)");
        this.db.exec("CREATE UNIQUE INDEX IF NOT EXISTS promotion_directory ON promotions(directoryId)");
        const moveColumns = this.db.prepare<{ name: string }, []>("PRAGMA table_info(moves)");
        let moveColumnNames: string[];
        try { moveColumnNames = moveColumns.all().map(column => column.name); }
        finally { moveColumns.finalize(); }
        if (!moveColumnNames.includes("kind")) this.db.exec("ALTER TABLE moves ADD COLUMN kind TEXT NOT NULL DEFAULT 'page' CHECK(kind IN ('page','folder'))");
        if (!moveColumnNames.includes("sourceTitle")) this.db.exec("ALTER TABLE moves ADD COLUMN sourceTitle TEXT");
        this.db.run("INSERT OR IGNORE INTO identity VALUES (1, ?)", [scope]);
        const stored = this.query<{ scope: string }, []>("SELECT scope FROM identity WHERE singleton=1").get();
        if (stored?.scope !== scope) throw new Error("NFS journal belongs to another profile/export identity");
      }).immediate();
      // SQLite syncs its own directory, not newly created ancestor entries.
      // Also repeat on reopen: a previous startup may have failed halfway here.
      for (let directory = realpathSync(dirname(path)); ; directory = dirname(directory)) {
        const fd = fs.openSync(directory, "r");
        try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
        if (dirname(directory) === directory) break;
      }
    } catch (error) { this.close(); throw error; }
  }

  close(): void {
    for (const statement of this.queries.values()) statement.finalize();
    this.queries.clear();
    this.db.close(true);
  }

  /** Counts only; never materializes page bodies or exposes tenant paths. */
  writeStatus(): NfsWriteStatus {
    const counts = this.db.prepare<NfsWriteStatus, []>(`SELECT
      (SELECT count(*) FROM files WHERE revision>publishedRevision AND id NOT IN (SELECT id FROM locals) AND id NOT IN (SELECT id FROM displaced)) AS pendingPages,
      (SELECT count(*) FROM files WHERE error IS NOT NULL AND revision>publishedRevision AND id NOT IN (SELECT id FROM locals)) AS failedPages,
      (SELECT count(*) FROM displaced) AS displacedPages,
      (SELECT count(*) FROM locals) AS localEntries,
      (SELECT count(*) FROM intents)+(SELECT count(*) FROM trash WHERE completed=0)+(SELECT count(*) FROM moves WHERE completed=0) AS unresolvedPublications`);
    let status: NfsWriteStatus;
    try { status = counts.get()!; } finally { counts.finalize(); }
    const statement = this.db.prepare<{ path: string; error: string | null }, []>(`SELECT locals.path,files.error
      FROM locals JOIN files USING(id) WHERE kind='file' AND originId IS NULL`);
    try {
      for (const draft of statement.all()) {
        if (!this.isPageDraft(draft.path)) continue;
        status.pendingPages++;
        if (draft.error !== null) status.failedPages++;
      }
    } finally { statement.finalize(); }
    return status;
  }

  get(id: string): StagedNfsFile | null {
    return this.query<StagedNfsFile, [string]>("SELECT * FROM files WHERE id=?").get(id);
  }

  pending(): StagedNfsFile[] {
    return this.query<StagedNfsFile, []>("SELECT * FROM files WHERE revision>publishedRevision AND id NOT IN (SELECT id FROM locals) AND id NOT IN (SELECT id FROM displaced) ORDER BY id").all();
  }

  isBackup(id: string): boolean {
    return !!this.query("SELECT id FROM locals WHERE id=? AND originId IS NOT NULL").get(id);
  }

  localFileIds(directory?: string): string[] {
    return this.query<{ id: string }, [string | null]>(
      "SELECT id FROM locals WHERE kind='file' AND (?1 IS NULL OR substr(path,1,length(?1))=?1)",
    ).all(directory === undefined ? null : `${directory}/`).map(row => row.id);
  }

  isPageDraft(path: string): boolean {
    if (!isNfsPageDirectory(posix.dirname(path))) return false;
    return isNfsPageDraft(path) || (posix.basename(path) === "_index.md" &&
      this.local(posix.dirname(path))?.kind === "directory");
  }

  pendingIds(): string[] {
    return this.query<{ id: string }, []>("SELECT id FROM files WHERE revision>publishedRevision AND id NOT IN (SELECT id FROM locals) AND id NOT IN (SELECT id FROM displaced) ORDER BY id").all().map(file => file.id);
  }

  private localPath(path: string): void {
    if (!path.startsWith("/") || path === "/" || path.includes("\0") ||
      posix.normalize(path) !== path || path.endsWith("/") || Buffer.byteLength(path) > 4096) {
      throw new VfsError("EINVAL", "Invalid local NFS path");
    }
  }

  local(path: string): LocalNfsEntry | null {
    return this.query<LocalNfsEntry, [string]>(
      "SELECT files.*,locals.kind FROM files JOIN locals USING(id) WHERE locals.path=?",
    ).get(path);
  }

  /** Local entries survive restart; the publisher selects eligible Markdown drafts. */
  createLocal(path: string, verifier?: string): LocalNfsEntry {
    return this.createLocalEntry(path, "file", verifier);
  }

  createRegularLocal(path: string, guarded: boolean, values: { mode?: number; size?: number }): LocalNfsEntry {
    return this.db.transaction(() => {
      const existing = this.local(path);
      if (existing && guarded) throw new VfsError("EEXIST", "Local NFS file exists");
      if (existing?.kind === "directory") throw new VfsError("EISDIR", "Cannot create over directory");
      const file = existing ?? this.createLocal(path);
      if (!existing) this.setAttributes(file.id, { mode: values.mode ?? 0o644 });
      if (values.size !== undefined) this.truncate(file.id, values.size);
      return this.local(path)!;
    }).immediate();
  }

  createLocalDirectory(path: string, mode = 0o755): LocalNfsEntry {
    return this.db.transaction(() => {
      const entry = this.createLocalEntry(path, "directory");
      this.setAttributes(entry.id, { mode });
      return entry;
    }).immediate();
  }

  /** Persist both identities before acknowledging an ordinary page-directory MKDIR. */
  createPageDirectory(path: string, mode = 0o755): LocalNfsEntry {
    return this.db.transaction(() => {
      const directory = this.createLocalDirectory(path, mode);
      const body = this.createLocal(`${path}/_index.md`);
      this.setAttributes(body.id, { mode: 0o644 });
      return directory;
    }).immediate();
  }

  private checkLocalParents(path: string): void {
    this.assertNoMove(path);
    for (let parent = posix.dirname(path); parent !== "/"; parent = posix.dirname(parent)) {
      const reserved = this.db.prepare("SELECT id FROM trash WHERE path=?");
      try {
        if (reserved.get(`${parent}/_index.md`)) throw new VfsError("EBUSY", "Parent is reserved for trash");
      } finally { reserved.finalize(); }
      if (this.local(parent)?.kind === "file") throw new VfsError("ENOTDIR", "Local parent is a file");
    }
  }

  private createLocalEntry(path: string, kind: LocalNfsEntry["kind"], verifier?: string): LocalNfsEntry {
    this.localPath(path);
    if (verifier !== undefined && !/^[0-9a-f]{16}$/.test(verifier)) throw new VfsError("EINVAL", "Invalid exclusive CREATE verifier");
    return this.db.transaction(() => {
      this.checkLocalParents(path);
      const existing = this.local(path);
      if (existing) {
        const stored = this.query<{ verifier: string | null }, [string]>("SELECT verifier FROM locals WHERE id=?").get(existing.id);
        if (kind === "file" && existing.kind === "file" && verifier !== undefined && stored?.verifier === verifier) return existing;
        throw new VfsError("EEXIST", "Local NFS file exists");
      }
      if (this.hasLocalDescendants(path)) throw new VfsError("EEXIST", "Local descendants already exist");
      const file = this.admit(`local:${randomUUID()}`, path, new Uint8Array(), 0);
      this.db.run("INSERT INTO locals (id,path,verifier,kind) VALUES (?, ?, ?, ?)", [file.id, path, verifier ?? null, kind]);
      return this.local(path)!;
    }).immediate();
  }

  localEntries(directory: string): LocalNfsEntry[] {
    const prefix = directory === "/" ? "/" : `${directory}/`;
    return this.query<LocalNfsEntry, [string, string]>(
      "SELECT files.*,locals.kind FROM files JOIN locals USING(id) WHERE substr(locals.path,1,length(?1))=?1 AND instr(substr(locals.path,length(?2)+1),'/')=0 ORDER BY locals.path",
    ).all(prefix, prefix);
  }

  private hasLocalDescendants(path: string): boolean {
    return !!this.query("SELECT id FROM locals WHERE substr(path,1,length(?1))=?1 LIMIT 1").get(`${path}/`);
  }

  private assertNoCreation(path: string): void {
    if (this.query("SELECT id FROM creations WHERE path=?1 OR substr(path,1,length(?1)+1)=?1||'/' LIMIT 1").get(path)) {
      throw new VfsError("EBUSY", "Creation result must be reconciled before moving or removing its local source");
    }
  }

  removeLocal(path: string, directory = false): void {
    this.db.transaction(() => {
      this.assertNoCreation(path);
      this.assertNoMove(path);
      const file = this.local(path);
      if (!file) throw new VfsError("ENOENT", "Local NFS file not found");
      if (directory !== (file.kind === "directory")) throw new VfsError(directory ? "ENOTDIR" : "EISDIR", "Local entry type mismatch");
      if (file.kind === "directory" && this.hasLocalDescendants(path)) throw new VfsError("ENOTEMPTY", "Local directory is not empty");
      this.db.run("DELETE FROM locals WHERE id=?", [file.id]);
      this.db.run("DELETE FROM attributes WHERE id=?", [file.id]);
      this.db.run("DELETE FROM files WHERE id=?", [file.id]);
    }).immediate();
  }

  renameLocal(source: string, target: string): void {
    this.localPath(target);
    this.db.transaction(() => {
      const file = this.local(source);
      if (!file) throw new VfsError("ENOENT", "Local NFS file not found");
      if (source === target) return;
      this.assertNoCreation(source);
      this.assertNoMove(source);
      this.checkLocalParents(target);
      if (target.startsWith(`${source}/`)) throw new VfsError("EINVAL", "Cannot move a directory into itself");
      const replaced = this.local(target);
      if (replaced) this.removeLocal(target, file.kind === "directory");
      const descendants = file.kind === "directory" ? this.query<{ id: string; path: string }, [string]>(
        "SELECT id,path FROM locals WHERE substr(path,1,length(?1))=?1 ORDER BY path",
      ).all(`${source}/`) : [];
      const moved = [file, ...descendants].map(entry => ({ id: entry.id, path: target + entry.path.slice(source.length) }));
      for (const entry of moved) this.localPath(entry.path);
      for (const entry of moved) {
        this.db.run("UPDATE locals SET path=? WHERE id=?", [entry.path, entry.id]);
        this.db.run("UPDATE files SET path=? WHERE id=?", [entry.path, entry.id]);
      }
    }).immediate();
  }

  exclusivePageReplay(path: string, verifier: string): StagedNfsFile | null {
    return this.query<StagedNfsFile, [string, string]>(
      "SELECT files.* FROM files JOIN page_verifiers USING(id) WHERE files.path=? AND verifier=?",
    ).get(path, verifier);
  }

  restoreCreated(path: string, values: { mode?: number; size?: number }, verifier?: string): StagedNfsFile {
    return this.db.transaction(() => {
      const page = this.displaced(path);
      if (!page) throw new VfsError("ENOENT", "No page reservation");
      if (verifier === undefined) this.createRegularLocal(path, true, values);
      else this.createLocal(path, verifier);
      const restored = this.replaceLocal(path, page.id);
      if (verifier !== undefined) this.db.run("INSERT INTO page_verifiers VALUES (?, ?)", [page.id, verifier]);
      return restored;
    }).immediate();
  }

  /** Reserved original path of a page moved aside during an editor save. */
  displaced(path: string): StagedNfsFile | null {
    return this.query<StagedNfsFile, [string]>(
      "SELECT files.* FROM files JOIN displaced USING(id) WHERE displaced.path=?",
    ).get(path);
  }

  /** Preserve a local backup and reserve the page identity without publishing a rename. */
  backupPage(pageId: string, target: string, source?: string): LocalNfsEntry {
    this.localPath(target);
    return this.db.transaction(() => {
      this.assertNotTrashing(pageId);
      const page = this.get(pageId);
      if (!page || this.local(page.path)?.id === pageId) throw new VfsError("EINVAL", "Backup source must be an admitted page");
      const original = source ?? page.path;
      this.localPath(original);
      if (target === original || target.startsWith(`${original}/`)) throw new VfsError("EINVAL", "Invalid backup destination");
      if (this.query("SELECT id FROM displaced WHERE id=?").get(pageId)) throw new VfsError("EBUSY", "Page already moved aside");
      if (this.displaced(target)) throw new VfsError("EBUSY", "Backup destination is a reserved page path");
      if (this.local(target)) this.removeLocal(target);
      const backup = this.createLocal(target);
      this.write(backup.id, 0, page.bytes);
      this.db.run("UPDATE locals SET originId=? WHERE id=?", [pageId, backup.id]);
      const attributes = this.attributes(pageId);
      if (attributes) this.db.run("INSERT INTO attributes VALUES (?, ?, ?, ?)", [backup.id, attributes.mode, attributes.atime, attributes.mtime]);
      this.db.run("DELETE FROM page_verifiers WHERE id=?", [pageId]);
      this.db.run("UPDATE files SET path=? WHERE id=?", [original, pageId]);
      this.db.run("INSERT INTO displaced VALUES (?, ?)", [pageId, original]);
      return this.local(target)!;
    }).immediate();
  }

  /** Atomic byte replacement; retain page identity, base and any in-flight intent. */
  replaceLocal(source: string, pageId: string): StagedNfsFile {
    return this.db.transaction(() => {
      const local = this.local(source);
      const page = this.get(pageId);
      if (!local || !page) throw new VfsError("ENOENT", "NFS replacement source or page not found");
      if (local.kind === "directory") throw new VfsError("EISDIR", "Cannot replace page bytes with a directory");
      if (this.query("SELECT id FROM locals WHERE id=?").get(pageId)) {
        throw new VfsError("EINVAL", "Replacement target must be an admitted page");
      }
      // Delete inside the same transaction first, so a rename needs no second
      // copy of the source in the logical quota. Rollback retains both images.
      const attributes = this.attributes(local.id) ?? { mode: 0o644, atime: null, mtime: null };
      this.removeLocal(source);
      this.db.run("INSERT OR REPLACE INTO attributes VALUES (?, ?, ?, ?)", [pageId, attributes.mode, attributes.atime, attributes.mtime]);
      const replaced = this.change(pageId, () => local.bytes.byteLength, (bytes) => bytes.set(local.bytes));
      this.db.run("DELETE FROM displaced WHERE id=?", [pageId]);
      this.db.run("DELETE FROM page_verifiers WHERE id=?", [pageId]);
      return replaced;
    }).immediate();
  }

  attributes(id: string): { mode: number; atime: number | null; mtime: number | null } | null {
    return this.query<{ mode: number; atime: number | null; mtime: number | null }, [string]>(
      "SELECT mode,atime,mtime FROM attributes WHERE id=?",
    ).get(id);
  }

  setAttributes(id: string, values: { mode?: number; atime?: number; mtime?: number }): void {
    for (const [key, value] of Object.entries(values)) {
      if (!Number.isSafeInteger(value) || value! < 0 || value! > (key === "mode" ? 0o777 : 0xffffffff * 1000 + 999)) {
        throw new VfsError("EINVAL", "Invalid NFS attributes");
      }
    }
    this.db.transaction(() => {
      this.assertNotTrashing(id);
      const staged = this.get(id);
      if (staged) this.assertNoMove(staged.path);
      if (!this.get(id)) throw new VfsError("ENOENT", "Unknown NFS file");
      const old = this.attributes(id) ?? { mode: 0o644, atime: null, mtime: null };
      const next = { ...old, ...values };
      this.db.run("INSERT OR REPLACE INTO attributes VALUES (?, ?, ?, ?)", [id, next.mode, next.atime, next.mtime]);
    }).immediate();
  }

  /** Admission preserves an existing recovered byte image; it never overwrites it. */
  admit(id: string, path: string, bytes: Uint8Array, baseVersion: number): StagedNfsFile {
    if (!id || id.includes("\0") || Buffer.byteLength(id) > 256 || !path.startsWith("/") ||
      path.includes("\0") || Buffer.byteLength(path) > 4096 || !Number.isSafeInteger(baseVersion) || baseVersion < 0) throw new Error("Invalid NFS journal file");
    return this.db.transaction(() => {
      const existing = this.get(id);
      if (existing) return existing;
      if (this.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM files").get()!.count >= this.maxFiles) {
        throw new VfsError("ENOSPC", "NFS journal file-count quota exceeded");
      }
      this.checkQuota(bytes.byteLength);
      this.db.run("INSERT INTO files VALUES (?, ?, ?, ?, 0, 0, NULL)", [id, path, bytes, baseVersion]);
      return this.get(id)!;
    }).immediate();
  }

  private checkQuota(additional: number): void {
    const used = this.query<{ size: number }, []>(
      "SELECT (SELECT COALESCE(SUM(length(bytes)),0) FROM files)+(SELECT COALESCE(SUM(length(bytes)),0) FROM intents)+(SELECT COALESCE(SUM(length(bytes)),0) FROM bases) AS size",
    ).get()!.size;
    if (additional > this.maxFileBytes || used + additional > this.maxBytes) throw new VfsError("ENOSPC", "NFS journal quota exceeded");
  }

  /** Refresh only clean pages; retain the editor's previous source for conflict merging. */
  refreshClean(id: string, path: string, bytes: Uint8Array, version: number, revision: number, refreshMetadata = false): StagedNfsFile {
    if (!Number.isSafeInteger(version) || version < 1 || bytes.byteLength > this.maxFileBytes) throw new VfsError("EINVAL", "Invalid refreshed page");
    this.localPath(path);
    return this.db.transaction(() => {
      const old = this.get(id);
      if (!old) throw new VfsError("ENOENT", "Unknown staged page");
      if (this.trashIntent(id) || old.revision !== revision || old.revision !== old.publishedRevision || version < old.baseVersion ||
          (version === old.baseVersion && (!refreshMetadata || Buffer.compare(bytes, old.bytes) === 0)) ||
          this.query("SELECT id FROM intents WHERE id=? UNION ALL SELECT id FROM locals WHERE id=? UNION ALL SELECT id FROM displaced WHERE id=?").get(id, id, id)) return old;
      const source = this.publishedSource(id);
      this.checkQuota(bytes.byteLength - old.bytes.byteLength + (source ? 0 : old.bytes.byteLength));
      if (!source) this.db.run("INSERT INTO bases VALUES (?, ?)", [id, old.bytes]);
      this.db.run("UPDATE files SET path=?,bytes=?,baseVersion=?,revision=revision+1,publishedRevision=publishedRevision+1,error=NULL WHERE id=?", [path, bytes, version, id]);
      this.db.run("UPDATE attributes SET mtime=NULL WHERE id=?", [id]);
      return this.get(id)!;
    }).immediate();
  }

  private assertFile(id: string): void {
    this.assertNotTrashing(id);
    const file = this.get(id);
    if (file) this.assertNoMove(file.path);
    if (this.query("SELECT id FROM locals WHERE id=? AND kind='directory'").get(id)) {
      throw new VfsError("EISDIR", "Cannot write a directory");
    }
  }

  private change(id: string, size: (oldSize: number) => number, update: (bytes: Uint8Array) => void): StagedNfsFile {
    return this.db.transaction(() => {
      this.assertFile(id);
      const old = this.get(id);
      if (!old) throw new Error("Unknown NFS journal file");
      const length = size(old.bytes.byteLength);
      if (!Number.isSafeInteger(length) || length < 0 || length > this.maxFileBytes) throw new VfsError("EINVAL", "Invalid NFS journal file size");
      this.checkQuota(length - old.bytes.byteLength);
      const bytes = new Uint8Array(length);
      bytes.set(old.bytes.subarray(0, length));
      update(bytes);
      // Replayed stable writes must not schedule another remote publication.
      if (Buffer.compare(bytes, old.bytes) === 0) return old;
      this.db.run("UPDATE files SET bytes=?, revision=revision+1 WHERE id=?", [bytes, id]);
      this.db.run("UPDATE attributes SET mtime=MAX(COALESCE(mtime,0)+1,?) WHERE id=?", [Date.now(), id]);
      return this.get(id)!;
    }).immediate();
  }

  write(id: string, offset: number, bytes: Uint8Array): StagedNfsFile {
    const promotion = this.promotion(id);
    if (promotion?.directory) throw new VfsError("EISDIR", "Cannot write a directory");
    id = promotion?.pageId ?? id;
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > this.maxFileBytes - bytes.byteLength) throw new VfsError("EINVAL", "Invalid NFS write range");
    this.assertFile(id);
    if (bytes.byteLength === 0) {
      const file = this.get(id);
      if (!file) throw new Error("Unknown NFS journal file");
      return file;
    }
    return this.change(id, (old) => Math.max(old, offset + bytes.byteLength), (target) => target.set(bytes, offset));
  }

  truncate(id: string, size: number): StagedNfsFile {
    const promotion = this.promotion(id);
    if (promotion?.directory) throw new VfsError("EISDIR", "Cannot truncate a directory");
    return this.change(promotion?.pageId ?? id, () => size, () => {});
  }

  createIntent(id: string): NfsCreateIntent | null {
    return this.query<NfsCreateIntent, [string]>(
      "SELECT intents.*,creations.path,spaceKey,parentId,pageId,version FROM creations JOIN intents USING(id) WHERE id=?",
    ).get(id);
  }

  /** Freeze one creation attempt before POST. Existing intents must be reconciled, never sent again blindly. */
  beginCreate(id: string, path: string, spaceKey: string, parentId: string, revision: number): NfsCreateIntent | null {
    this.localPath(path);
    if (!spaceKey || /[\/\0]/.test(spaceKey) || !/^[0-9]+$/.test(parentId) ||
        path.split("/")[1] !== spaceKey) throw new VfsError("EINVAL", "Invalid creation target");
    return this.db.transaction(() => {
      const existing = this.createIntent(id);
      if (existing) {
        if (existing.path !== path || existing.spaceKey !== spaceKey || existing.parentId !== parentId) {
          throw new VfsError("EBUSY", "Creation target already frozen");
        }
        return existing;
      }
      const local = this.local(path);
      if (!local || local.id !== id || local.kind !== "file") throw new VfsError("EINVAL", "Creation requires a local file");
      if (local.revision !== revision) return null;
      if (this.publishIntent(id)) throw new VfsError("EBUSY", "Publication already pending");
      this.checkQuota(local.bytes.byteLength);
      this.db.run("INSERT INTO intents VALUES (?, ?, ?, ?)", [id, local.bytes, 0, revision]);
      this.db.run("INSERT INTO creations VALUES (?, ?, ?, ?, NULL, NULL)", [id, path, spaceKey, parentId]);
      return this.createIntent(id)!;
    }).immediate();
  }

  promotion(idOrPath: string, directory = false): { localId: string; path: string; pageId: string; directory?: true } | null {
    const row = this.query<{ localId: string; path: string; pageId: string; directoryId: string | null }, [string]>(
      "SELECT * FROM promotions WHERE localId=?1 OR path=?1 OR pageId=?1 OR directoryId=?1 OR (directoryId IS NOT NULL AND substr(path,1,length(path)-10)=?1)",
    ).get(idOrPath);
    if (!row) return null;
    if (row.directoryId && (directory || row.directoryId === idOrPath || posix.dirname(row.path) === idOrPath)) {
      return { localId: row.directoryId, path: posix.dirname(row.path), pageId: row.pageId, directory: true };
    }
    return directory ? null : { localId: row.localId, path: row.path, pageId: row.pageId };
  }

  /** Atomically turn a confirmed local creation into an ID-bound page, retaining newer bytes. */
  promoteCreated(id: string, canonicalPath: string): StagedNfsFile {
    this.localPath(canonicalPath);
    return this.db.transaction(() => {
      const promoted = this.promotion(id);
      if (promoted) return this.get(promoted.pageId)!;
      const intent = this.createIntent(id);
      if (!intent?.pageId || !intent.version) throw new VfsError("EBUSY", "Creation has no confirmed remote result");
      if (canonicalPath.split("/")[1] !== intent.spaceKey) throw new VfsError("EACCES", "Created page is outside its export");
      const file = this.get(id)!;
      const directory = posix.basename(intent.path) === "_index.md" ? this.local(posix.dirname(intent.path)) : null;
      if (directory && (directory.kind !== "directory" || posix.basename(canonicalPath) !== "_index.md")) {
        throw new VfsError("EINVAL", "Page-directory promotion requires its canonical body path");
      }
      if (this.get(intent.pageId)) throw new VfsError("EBUSY", "Created page is already staged");
      this.db.run("INSERT INTO files VALUES (?, ?, ?, ?, ?, ?, NULL)", [intent.pageId, canonicalPath, file.bytes, intent.version, file.revision, intent.revision]);
      this.db.run("INSERT INTO bases VALUES (?, ?)", [intent.pageId, intent.bytes]);
      this.db.run("UPDATE attributes SET id=? WHERE id=?", [intent.pageId, id]);
      this.db.run("INSERT INTO page_verifiers SELECT ?,verifier FROM locals WHERE id=? AND verifier IS NOT NULL", [intent.pageId, id]);
      this.db.run("INSERT INTO promotions(localId,path,pageId,directoryId) VALUES (?, ?, ?, ?)", [id, intent.path, intent.pageId, directory?.id ?? null]);
      if (directory) {
        const prefix = `${directory.path}/`;
        if (this.query("SELECT id FROM creations WHERE id<>?1 AND substr(path,1,length(?2))=?2 LIMIT 1").get(id, prefix)) {
          throw new VfsError("EBUSY", "Child creation must be reconciled before promoting its parent");
        }
        const descendants = this.query<{ id: string; path: string }, [string, string]>(
          "SELECT id,path FROM locals WHERE id<>?1 AND substr(path,1,length(?2))=?2 ORDER BY path",
        ).all(id, prefix);
        const target = posix.dirname(canonicalPath);
        for (const child of descendants) {
          const path = target + child.path.slice(directory.path.length);
          this.localPath(path);
          this.db.run("UPDATE locals SET path=? WHERE id=?", [path, child.id]);
          this.db.run("UPDATE files SET path=? WHERE id=?", [path, child.id]);
        }
        this.db.run("DELETE FROM locals WHERE id=?", [directory.id]);
        // Keep the small directory row and its attributes separate from the body.
        this.db.run("UPDATE files SET path=? WHERE id=?", [target, directory.id]);
      }
      this.db.run("DELETE FROM creations WHERE id=?", [id]);
      this.db.run("DELETE FROM intents WHERE id=?", [id]);
      this.db.run("DELETE FROM locals WHERE id=?", [id]);
      this.db.run("DELETE FROM files WHERE id=?", [id]);
      return this.get(intent.pageId)!;
    }).immediate();
  }

  /** Persist a confirmed POST result independently of namespace promotion. */
  recordCreated(id: string, revision: number, pageId: string, version: number): void {
    if (!/^[0-9]+$/.test(pageId) || !Number.isSafeInteger(version) || version < 1) throw new VfsError("EINVAL", "Invalid creation result");
    this.db.transaction(() => {
      const intent = this.createIntent(id);
      if (!intent || intent.revision !== revision ||
          (intent.pageId !== null && (intent.pageId !== pageId || intent.version !== version))) {
        throw new VfsError("EBUSY", "Stale or conflicting creation result");
      }
      this.db.run("UPDATE creations SET pageId=?,version=? WHERE id=?", [pageId, version, id]);
    }).immediate();
  }

  moveIntent(source: string): NfsMoveIntent | null {
    return this.query<NfsMoveIntent, [string]>("SELECT * FROM moves WHERE source=?").get(source);
  }

  pendingMoves(): NfsMoveIntent[] {
    return this.query<NfsMoveIntent, []>("SELECT * FROM moves WHERE completed=0").all();
  }

  beginMove(move: Omit<NfsMoveIntent, "completed">): void {
    this.localPath(move.source); this.localPath(move.target);
    if (!["page", "folder"].includes(move.kind) || ![move.id, move.sourceParentId, move.targetParentId].every(id => /^[0-9]+$/.test(id)) ||
        move.source.split("/")[1] !== move.spaceKey || move.target.split("/")[1] !== move.spaceKey ||
        (posix.basename(move.source) !== posix.basename(move.target) &&
          move.kind !== "page") || move.target.startsWith(`${move.source}/`)) {
      throw new VfsError("EINVAL", "Invalid page reparent intent");
    }
    this.db.transaction(() => {
      const previous = this.moveIntent(move.source);
      if (previous) {
        if (Object.entries(move).some(([key, value]) => previous[key as keyof NfsMoveIntent] !== value)) {
          throw new VfsError("EBUSY", "Move target already frozen");
        }
        return;
      }
      this.db.run("DELETE FROM moves WHERE completed=1 AND id=?", [move.id]);
      if (this.query<{ count: number }, []>("SELECT count(*) AS count FROM moves").get()!.count >= this.maxFiles) {
        throw new VfsError("ENOSPC", "Move journal capacity exceeded");
      }
      for (const path of new Set([move.source, move.target, posix.join(posix.dirname(move.target), posix.basename(move.source))])) {
        if (this.local(path) || this.hasLocalDescendants(path) || this.query(
          "SELECT id FROM files WHERE (path=?1 OR substr(path,1,length(?1)+1)=?1||'/') AND (revision>publishedRevision OR id IN (SELECT id FROM intents) OR id IN (SELECT id FROM displaced) OR id IN (SELECT id FROM trash)) LIMIT 1",
        ).get(path)) throw new VfsError("EBUSY", "Move contains pending editor data");
        this.assertNoMove(path);
      }
      this.db.run("INSERT INTO moves(id,source,target,spaceKey,sourceParentId,targetParentId,title,kind,sourceTitle) VALUES (?,?,?,?,?,?,?,?,?)",
        [move.id, move.source, move.target, move.spaceKey, move.sourceParentId, move.targetParentId, move.title, move.kind, move.sourceTitle]);
    }).immediate();
  }

  /** Pending outcomes reserve both trees until positively reconciled. */
  assertNoMove(path: string): void {
    // ponytail: scan the bounded pending move set; index prefixes if concurrent recovery becomes large.
    for (const move of this.pendingMoves()) {
      for (const tree of [move.source, move.target, posix.join(posix.dirname(move.target), posix.basename(move.source))]) {
        if (path === tree || path.startsWith(`${tree}/`) || tree.startsWith(`${path}/`)) {
          throw new VfsError("EBUSY", "Move outcome requires reconciliation");
        }
      }
    }
  }

  completeMove(source: string): void {
    this.db.transaction(() => {
      const move = this.moveIntent(source);
      if (!move) throw new VfsError("ENOENT", "Unknown move intent");
      if (move.completed) return;
      for (const previous of new Set([move.source, posix.join(posix.dirname(move.target), posix.basename(move.source))])) {
        this.db.run("UPDATE files SET path=?2||substr(path,length(?1)+1) WHERE substr(path,1,length(?1)+1)=?1||'/'", [previous, move.target]);
        this.db.run("UPDATE promotions SET path=?2||substr(path,length(?1)+1) WHERE substr(path,1,length(?1)+1)=?1||'/'", [previous, move.target]);
      }
      this.db.run("UPDATE moves SET completed=1 WHERE source=?", [source]);
    }).immediate();
  }

  trashIntent(id: string): { id: string; path: string; spaceKey: string; completed: number } | null {
    const statement = this.db.prepare<{ id: string; path: string; spaceKey: string; completed: number }, [string]>(
      "SELECT * FROM trash WHERE id=?");
    try { return statement.get(id); } finally { statement.finalize(); }
  }

  /** Freeze a clean page before DELETE; even no-op writes must then fail. */
  beginTrash(id: string, path: string, spaceKey: string): void {
    this.localPath(path);
    if (!/^[0-9]+$/.test(id) || !spaceKey || path.split("/")[1] !== spaceKey) throw new VfsError("EINVAL", "Invalid trash identity");
    this.db.transaction(() => {
      this.assertNoMove(path);
      const previous = this.trashIntent(id);
      if (previous) {
        if (previous.path !== path || previous.spaceKey !== spaceKey) throw new VfsError("EBUSY", "Trash target already frozen");
        return;
      }
      const file = this.get(id);
      if (!file) throw new VfsError("ENOENT", "Trash requires an admitted page");
      if (posix.basename(path) === "_index.md" && this.hasLocalDescendants(posix.dirname(path))) {
        throw new VfsError("EBUSY", "Page contains local editor data");
      }
      if (file.path.split("/")[1] !== spaceKey || file.revision !== file.publishedRevision ||
          this.query("SELECT id FROM intents WHERE id=?1 UNION ALL SELECT id FROM displaced WHERE id=?1 UNION ALL SELECT id FROM locals WHERE id=?1").get(id)) {
        throw new VfsError("EBUSY", "Page has unpublished data or a different export");
      }
      this.db.run("INSERT INTO trash(id,path,spaceKey) VALUES (?,?,?)", [id, path, spaceKey]);
    }).immediate();
  }

  pendingTrashIds(): string[] {
    const statement = this.db.prepare<{ id: string }, []>("SELECT id FROM trash WHERE completed=0");
    try { return statement.all().map(row => row.id); } finally { statement.finalize(); }
  }

  completeTrash(id: string): void {
    this.db.transaction(() => {
      if (!this.trashIntent(id)) throw new VfsError("ENOENT", "Unknown trash intent");
      this.db.run("UPDATE trash SET completed=1 WHERE id=?", [id]);
      // Retire the name, not the recoverable image or its tombstone.
      const directory = this.promotion(id, true);
      this.db.run("DELETE FROM promotions WHERE pageId=?", [id]);
      if (directory) {
        this.db.run("DELETE FROM attributes WHERE id=?", [directory.localId]);
        this.db.run("DELETE FROM files WHERE id=?", [directory.localId]);
      }
      this.db.run("DELETE FROM page_verifiers WHERE id=?", [id]);
    }).immediate();
  }

  private assertNotTrashing(id: string): void {
    if (this.trashIntent(id)) throw new VfsError("EBUSY", "Page is reserved for trash; reconcile before modifying it");
  }

  publishIntent(id: string): NfsPublishIntent | null {
    return this.query<NfsPublishIntent, [string]>("SELECT * FROM intents WHERE id=?").get(id);
  }

  /** Persist the exact snapshot before sending a remote mutation. Replay this intent after a lost reply. */
  beginPublish(id: string, revision?: number): NfsPublishIntent | null {
    return this.db.transaction(() => {
      this.assertNotTrashing(id);
      const staged = this.get(id);
      if (staged) this.assertNoMove(staged.path);
      if (this.query("SELECT id FROM locals WHERE id=? UNION ALL SELECT id FROM displaced WHERE id=?").get(id, id)) return null;
      const intent = this.publishIntent(id);
      if (intent) return intent;
      const file = this.get(id);
      if (!file || file.revision === file.publishedRevision) return null;
      if (revision !== undefined && file.revision !== revision) return null;
      this.checkQuota(file.bytes.byteLength);
      this.db.run("INSERT INTO intents VALUES (?, ?, ?, ?)", [id, file.bytes, file.baseVersion, file.revision]);
      return this.query<NfsPublishIntent, [string]>("SELECT * FROM intents WHERE id=?").get(id);
    }).immediate();
  }

  /** Source image of the last completed publication, for rebasing later edits. */
  publishedSource(id: string): Uint8Array | null {
    return this.query<{ bytes: Uint8Array }, [string]>("SELECT bytes FROM bases WHERE id=?").get(id)?.bytes ?? null;
  }

  /** Completing R must leave bytes from a newer R+1 untouched and still pending. */
  completePublish(id: string, revision: number, remoteVersion: number): void {
    if (this.createIntent(id)) throw new VfsError("EBUSY", "Creation requires namespace promotion");
    if (!Number.isSafeInteger(remoteVersion) || remoteVersion < 1) throw new Error("Invalid remote version");
    this.db.transaction(() => {
      const intent = this.query<NfsPublishIntent, [string]>("SELECT * FROM intents WHERE id=?").get(id);
      if (!intent || intent.revision !== revision || remoteVersion < intent.baseVersion) throw new Error("Stale NFS publication result");
      this.db.run("UPDATE files SET baseVersion=?, publishedRevision=?, error=NULL WHERE id=?", [remoteVersion, revision, id]);
      this.db.run("INSERT OR REPLACE INTO bases SELECT id, bytes FROM intents WHERE id=?", [id]);
      this.db.run("DELETE FROM intents WHERE id=?", [id]);
    }).immediate();
  }

  /** Store a safe error code only. Failed intents/bytes remain recoverable. */
  failPublish(id: string, code: string): void {
    if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(code)) throw new Error("Invalid publication error code");
    this.db.run("UPDATE files SET error=? WHERE id=?", [code, id]);
  }
}
