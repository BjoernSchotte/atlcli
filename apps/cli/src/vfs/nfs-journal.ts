import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface StagedNfsFile {
  id: string;
  path: string;
  bytes: Uint8Array;
  baseVersion: number;
  revision: number;
  publishedRevision: number;
  error: string | null;
}
export interface NfsPublishIntent {
  id: string;
  bytes: Uint8Array;
  baseVersion: number;
  revision: number;
}

/** Non-evictable local stable storage. Separate from the disposable VFS cache. */
export class NfsJournal {
  private readonly db: Database;
  constructor(path: string, scope: string, private readonly maxBytes = 256 * 1024 * 1024,
    private readonly maxFileBytes = 64 * 1024 * 1024) {
    if (!scope || !Number.isSafeInteger(maxBytes) || maxBytes < 1 ||
      !Number.isSafeInteger(maxFileBytes) || maxFileBytes < 1) throw new Error("Invalid NFS journal limits or scope");
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new Database(path, { create: true });
    try {
      chmodSync(path, 0o600);
      const version = this.db.query<{ user_version: number }, []>("PRAGMA user_version").get()!.user_version;
      if (version !== 0 && version !== 1) throw new Error("Unsupported NFS journal schema version");
      this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA fullfsync=ON; PRAGMA busy_timeout=5000;");
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
        PRAGMA foreign_keys=ON;
        PRAGMA user_version=1;
      `);
      this.db.transaction(() => {
        this.db.run("INSERT OR IGNORE INTO identity VALUES (1, ?)", [scope]);
        const stored = this.db.query<{ scope: string }, []>("SELECT scope FROM identity WHERE singleton=1").get();
        if (stored?.scope !== scope) throw new Error("NFS journal belongs to another profile/export identity");
      }).immediate();
    } catch (error) { this.db.close(); throw error; }
  }

  close(): void { this.db.close(); }

  get(id: string): StagedNfsFile | null {
    return this.db.query<StagedNfsFile, [string]>("SELECT * FROM files WHERE id=?").get(id);
  }

  pending(): StagedNfsFile[] {
    return this.db.query<StagedNfsFile, []>("SELECT * FROM files WHERE revision>publishedRevision ORDER BY id").all();
  }

  /** Admission preserves an existing recovered byte image; it never overwrites it. */
  admit(id: string, path: string, bytes: Uint8Array, baseVersion: number): StagedNfsFile {
    if (!id || !path.startsWith("/") || !Number.isSafeInteger(baseVersion) || baseVersion < 0) throw new Error("Invalid NFS journal file");
    return this.db.transaction(() => {
      const existing = this.get(id);
      if (existing) return existing;
      this.checkQuota(bytes.byteLength);
      this.db.run("INSERT INTO files VALUES (?, ?, ?, ?, 0, 0, NULL)", [id, path, bytes, baseVersion]);
      return this.get(id)!;
    }).immediate();
  }

  private checkQuota(additional: number): void {
    const used = this.db.query<{ size: number }, []>(
      "SELECT (SELECT COALESCE(SUM(length(bytes)),0) FROM files)+(SELECT COALESCE(SUM(length(bytes)),0) FROM intents) AS size",
    ).get()!.size;
    if (additional > this.maxFileBytes || used + additional > this.maxBytes) throw new Error("NFS journal quota exceeded");
  }

  private change(id: string, size: (oldSize: number) => number, update: (bytes: Uint8Array) => void): StagedNfsFile {
    return this.db.transaction(() => {
      const old = this.get(id);
      if (!old) throw new Error("Unknown NFS journal file");
      const length = size(old.bytes.byteLength);
      if (!Number.isSafeInteger(length) || length < 0 || length > this.maxFileBytes) throw new Error("Invalid NFS journal file size");
      this.checkQuota(length - old.bytes.byteLength);
      const bytes = new Uint8Array(length);
      bytes.set(old.bytes.subarray(0, length));
      update(bytes);
      this.db.run("UPDATE files SET bytes=?, revision=revision+1, error=NULL WHERE id=?", [bytes, id]);
      return this.get(id)!;
    }).immediate();
  }

  write(id: string, offset: number, bytes: Uint8Array): StagedNfsFile {
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > this.maxFileBytes - bytes.byteLength) throw new Error("Invalid NFS write range");
    if (bytes.byteLength === 0) {
      const file = this.get(id);
      if (!file) throw new Error("Unknown NFS journal file");
      return file;
    }
    return this.change(id, (old) => Math.max(old, offset + bytes.byteLength), (target) => target.set(bytes, offset));
  }

  truncate(id: string, size: number): StagedNfsFile {
    return this.change(id, () => size, () => {});
  }

  /** Persist the exact snapshot before sending a remote mutation. Replay this intent after a lost reply. */
  beginPublish(id: string): NfsPublishIntent | null {
    return this.db.transaction(() => {
      const intent = this.db.query<NfsPublishIntent, [string]>("SELECT * FROM intents WHERE id=?").get(id);
      if (intent) return intent;
      const file = this.get(id);
      if (!file || file.revision === file.publishedRevision) return null;
      this.checkQuota(file.bytes.byteLength);
      this.db.run("INSERT INTO intents VALUES (?, ?, ?, ?)", [id, file.bytes, file.baseVersion, file.revision]);
      return this.db.query<NfsPublishIntent, [string]>("SELECT * FROM intents WHERE id=?").get(id);
    }).immediate();
  }

  /** Completing R must leave bytes from a newer R+1 untouched and still pending. */
  completePublish(id: string, revision: number, remoteVersion: number): void {
    if (!Number.isSafeInteger(remoteVersion) || remoteVersion < 1) throw new Error("Invalid remote version");
    this.db.transaction(() => {
      const intent = this.db.query<NfsPublishIntent, [string]>("SELECT * FROM intents WHERE id=?").get(id);
      if (!intent || intent.revision !== revision || remoteVersion <= intent.baseVersion) throw new Error("Stale NFS publication result");
      this.db.run("UPDATE files SET baseVersion=?, publishedRevision=?, error=NULL WHERE id=?", [remoteVersion, revision, id]);
      this.db.run("DELETE FROM intents WHERE id=?", [id]);
    }).immediate();
  }

  /** Store a safe error code only. Failed intents/bytes remain recoverable. */
  failPublish(id: string, code: string): void {
    if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(code)) throw new Error("Invalid publication error code");
    this.db.run("UPDATE files SET error=? WHERE id=?", [code, id]);
  }
}
