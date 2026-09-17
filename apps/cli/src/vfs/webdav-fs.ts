/**
 * `webdav-server` FileSystem over the Confluence VFS (WP7.1–7.3b).
 *
 * The second frontend, and the reason the core has no just-bash in it. Like
 * `just-bash-fs.ts`, this is a translation layer and nothing more: WebDAV's
 * callback style and HTTP status codes in, the core's promise-and-`VfsError`
 * API out.
 *
 * ## What is different from the shell adapter
 *
 * A mounted volume is *chatty and unsupervised*. The Finder issues two to five
 * times the requests a shell does, and — worse — a search indexer or an
 * antivirus scanner will happily walk the whole volume on its own. That is
 * exactly the whole-space copy section 1b forbids, arriving through no user
 * action at all. So this file carries three defences the shell does not need:
 *
 *  1. **Fast 404s for client droppings.** AppleDouble files, `.DS_Store`,
 *     `desktop.ini` and friends are refused without touching the backend.
 *  2. **Spotlight exclusions are *served*, not refused** (WP7.3b).
 *     `.metadata_never_index` has to *exist* for Spotlight to skip a volume;
 *     404ing it is what invites the sweep. They live in {@link RootFileSystem},
 *     mounted at the volume root.
 *  3. **A sweep detector.** More than a threshold of distinct file reads in a
 *     short window, none preceded by a listing of their directory, is reported
 *     as a probable indexer run.
 *
 * ## One filesystem per space
 *
 * Each space is mounted at its own path (`/DOCSY`), with a small
 * {@link RootFileSystem} at `/`. That is webdav-server's supported topology and
 * it is not a stylistic choice: a `PROPFIND` on the volume root of a *single*
 * filesystem mounted at `/` returns only the root itself, however correct that
 * filesystem's `readDir` is — the server composes the root listing from its
 * mount table. Mounting per space makes `ls` at the mountpoint show the spaces,
 * which is the first thing anyone does after mounting.
 */
import { Readable, Writable } from "node:stream";
import { v2 as webdav } from "webdav-server";
import {
  isVfsError,
  isWritable,
  VfsError,
  type ConfluenceVfsImpl,
  type VfsErrorCode,
} from "@atlcli/confluence-vfs";

import { INDEXER_SHIELDS, isClientDropping, isIndexerShield, isShieldDirectory } from "./mount-client-probes.js";
export { isClientDropping, isIndexerShield, isShieldDirectory } from "./mount-client-probes.js";

/**
 * POSIX code to the webdav-server error the request layer understands.
 *
 * **This maps to the library's error *singletons*, not to status numbers.**
 * `setCodeFromError` compares errors by identity against a fixed table and
 * falls back to 500 for anything else — so returning an `HTTPError` carrying a
 * 403, which looks like the obvious thing to do, produces a 500. Every refusal
 * this filesystem makes has to come back as one of these objects or the client
 * is told the server is broken when it was merely told "no".
 */
const WEBDAV_ERROR_FOR: Record<VfsErrorCode, Error> = {
  ENOENT: webdav.Errors.ResourceNotFound,
  EACCES: webdav.Errors.Forbidden,
  EROFS: webdav.Errors.Forbidden,
  EISDIR: webdav.Errors.WrongParentTypeForCreation,
  ENOTDIR: webdav.Errors.WrongParentTypeForCreation,
  EEXIST: webdav.Errors.ResourceAlreadyExists,
  // A conflicting write is the closest thing WebDAV has to "someone else
  // changed this", which is exactly what EBUSY means here.
  EBUSY: webdav.Errors.ResourceAlreadyExists,
  ENOTEMPTY: webdav.Errors.ResourceAlreadyExists,
  EINVAL: webdav.Errors.IllegalArguments,
  ENOSPC: webdav.Errors.InsufficientStorage,
  EAGAIN: webdav.Errors.InsufficientStorage,
};

/** The HTTP status each code ends up as, for documentation and tests. */
export const HTTP_STATUS_FOR: Record<VfsErrorCode, number> = {
  ENOENT: 404,
  EACCES: 403,
  EROFS: 403,
  EISDIR: 409,
  ENOTDIR: 409,
  EEXIST: 409,
  EBUSY: 409,
  ENOTEMPTY: 409,
  EINVAL: 403,
  ENOSPC: 507,
  EAGAIN: 507,
};

export function httpErrorFor(error: unknown): Error {
  if (isVfsError(error)) return WEBDAV_ERROR_FOR[error.code] ?? webdav.Errors.IllegalArguments;
  return error instanceof Error ? error : new Error(String(error));
}

export interface SweepReport {
  reads: number;
  windowMs: number;
}

/**
 * Notices a client reading many distinct files without having listed their
 * directories first — the signature of an indexer, not of a person.
 */
export class SweepDetector {
  private readonly reads: number[] = [];
  private readonly listedDirs = new Set<string>();
  private reported = false;

  constructor(
    private readonly threshold = 50,
    private readonly windowMs = 10_000,
    private readonly onSweep: (report: SweepReport) => void = () => {},
    private readonly now: () => number = () => Date.now(),
  ) {}

  noteListing(directory: string): void {
    this.listedDirs.add(directory);
  }

  noteRead(directory: string): void {
    // A read from a directory the client listed first is ordinary browsing.
    if (this.listedDirs.has(directory)) return;
    const at = this.now();
    this.reads.push(at);
    while (this.reads.length > 0 && at - this.reads[0]! > this.windowMs) this.reads.shift();
    if (this.reads.length >= this.threshold && !this.reported) {
      this.reported = true;
      this.onSweep({ reads: this.reads.length, windowMs: this.windowMs });
    }
  }

  get suspected(): boolean {
    return this.reported;
  }
}

export interface ConfluenceWebdavOptions {
  vfs: ConfluenceVfsImpl;
  /** The space this filesystem serves; it is mounted at `/<spaceKey>`. */
  spaceKey: string;
  onSweep?: (report: SweepReport) => void;
  /** Shared across the per-space filesystems, so one sweep is one report. */
  sweepDetector?: SweepDetector;
}

/**
 * The WebDAV view of the VFS.
 *
 * Every method is one `try`/`catch` around a core call plus a translation. The
 * interesting decisions are in the guards above, not here.
 */
export class ConfluenceWebdavFileSystem extends webdav.FileSystem {
  readonly sweepDetector: SweepDetector;
  private readonly locks = new Map<string, webdav.LocalLockManager>();
  private readonly properties = new Map<string, webdav.LocalPropertyManager>();
  // macOS editors save to a sibling first, then MOVE it over the original.
  // These are local drafts, never Confluence pages. Retain drafts on failure.
  private readonly drafts = new Map<string, { bytes: Buffer; modified: number; directory?: boolean }>();
  private readonly pendingBackups = new Map<string, string>();

  private isDraft(path: webdav.Path): boolean {
    return path.toString().split("/").some((part) => /\.sb-[a-zA-Z0-9_-]+$/.test(part));
  }

  constructor(private readonly options: ConfluenceWebdavOptions) {
    super(new ConfluenceWebdavSerializer());
    this.sweepDetector =
      options.sweepDetector ?? new SweepDetector(50, 10_000, options.onSweep);
  }

  /**
   * Paths arrive relative to this filesystem's mount, so the space key goes
   * back on. `/architecture-62.../_index.md` under the `/DOCSY` mount is
   * `/DOCSY/architecture-62.../_index.md` to the core.
   */
  private vfsPath(path: webdav.Path): string {
    const relative = path.toString();
    return relative === "/" ? `/${this.options.spaceKey}` : `/${this.options.spaceKey}${relative}`;
  }

  private lastSegment(path: webdav.Path): string {
    const segments = path.toString().split("/").filter(Boolean);
    return segments[segments.length - 1] ?? "";
  }

  private parentOf(path: webdav.Path): string {
    const segments = path.toString().split("/").filter(Boolean);
    segments.pop();
    return `/${segments.join("/")}`;
  }

  protected _lockManager(
    path: webdav.Path,
    _ctx: webdav.LockManagerInfo,
    callback: webdav.ReturnCallback<webdav.ILockManager>,
  ): void {
    // Locks live in memory for the life of the mount. The Finder mounts a
    // volume read-only unless LOCK works, so this is not optional.
    const key = this.vfsPath(path);
    let manager = this.locks.get(key);
    if (!manager) {
      manager = new webdav.LocalLockManager();
      this.locks.set(key, manager);
    }
    callback(undefined, manager);
  }

  protected _propertyManager(
    path: webdav.Path,
    _ctx: webdav.PropertyManagerInfo,
    callback: webdav.ReturnCallback<webdav.IPropertyManager>,
  ): void {
    const key = this.vfsPath(path);
    let manager = this.properties.get(key);
    if (!manager) {
      manager = new webdav.LocalPropertyManager();
      this.properties.set(key, manager);
    }
    callback(undefined, manager);
  }

  protected _fastExistCheck(
    _ctx: webdav.RequestContext,
    path: webdav.Path,
    callback: (exists: boolean) => void,
  ): void {
    if (this.pendingBackups.has(path.toString())) { callback(false); return; }
    const name = this.lastSegment(path);
    if (this.isDraft(path)) {
      callback(this.drafts.has(path.toString()));
      return;
    }
    if (isClientDropping(name)) {
      callback(false);
      return;
    }
    if (isIndexerShield(name) || isShieldDirectory(name)) {
      callback(true);
      return;
    }
    this.options.vfs
      .stat(this.vfsPath(path))
      .then(() => callback(true))
      .catch(() => callback(false));
  }

  protected _type(
    path: webdav.Path,
    _ctx: webdav.TypeInfo,
    callback: webdav.ReturnCallback<webdav.ResourceType>,
  ): void {
    if (this.pendingBackups.has(path.toString())) { callback(webdav.Errors.ResourceNotFound); return; }
    const name = this.lastSegment(path);
    if (this.isDraft(path)) {
      const draft = this.drafts.get(path.toString());
      callback(draft ? undefined : webdav.Errors.ResourceNotFound,
        draft?.directory ? webdav.ResourceType.Directory : webdav.ResourceType.File);
      return;
    }
    if (isClientDropping(name)) {
      callback(webdav.Errors.ResourceNotFound);
      return;
    }
    if (isIndexerShield(name)) {
      callback(undefined, webdav.ResourceType.File);
      return;
    }
    if (isShieldDirectory(name)) {
      callback(undefined, webdav.ResourceType.Directory);
      return;
    }
    this.options.vfs
      .stat(this.vfsPath(path))
      .then((stat) =>
        callback(
          undefined,
          stat.isDirectory ? webdav.ResourceType.Directory : webdav.ResourceType.File,
        ),
      )
      .catch((error: unknown) => callback(httpErrorFor(error)));
  }

  protected _readDir(
    path: webdav.Path,
    _ctx: webdav.ReadDirInfo,
    callback: webdav.ReturnCallback<string[]>,
  ): void {
    if (this.isDraft(path)) {
      const draft = this.drafts.get(path.toString());
      if (!draft) { callback(webdav.Errors.ResourceNotFound); return; }
      if (!draft.directory) { callback(webdav.Errors.WrongParentTypeForCreation); return; }
      const prefix = `${path.toString()}/`;
      callback(undefined, [...this.drafts.keys()].filter((key) =>
        key.startsWith(prefix) && !key.slice(prefix.length).includes("/"))
        .map((key) => key.slice(prefix.length)));
      return;
    }
    const target = this.vfsPath(path);
    if (isShieldDirectory(this.lastSegment(path))) {
      callback(undefined, []);
      return;
    }
    this.sweepDetector.noteListing(target);
    this.options.vfs
      .readdir(target)
      .then((entries) => callback(undefined, entries
        .filter((entry) => !this.pendingBackups.has(`${path.toString().replace(/\/$/, "")}/${entry.name}`))
        .map((entry) => entry.name)
        .concat(target.replace(/\/$/, "") === `/${this.options.spaceKey}` ? [...INDEXER_SHIELDS] : [])))
      .catch((error: unknown) => callback(httpErrorFor(error)));
  }

  /**
   * DAV consumers cache inode sizes from PROPFIND before opening a file.
   * Estimates truncate cold reads in davfs2, even when GET sends an exact
   * Content-Length. Hydrate only unknown file lengths; directory/attachment
   * metadata remains cheap. The shell's stat contract stays demand-driven.
   */
  protected _size(
    path: webdav.Path,
    ctx: webdav.SizeInfo,
    callback: webdav.ReturnCallback<number>,
  ): void {
    if (this.isDraft(path)) {
      const draft = this.drafts.get(path.toString());
      if (!draft) callback(webdav.Errors.ResourceNotFound);
      else callback(undefined, draft.bytes.byteLength);
      return;
    }
    if (isIndexerShield(this.lastSegment(path))) {
      callback(undefined, 0);
      return;
    }
    const target = this.vfsPath(path);
    // Only an HTTP-driven context carries the request; an internal one does
    // not, so internal metadata probes may keep the core estimate.
    const request = (ctx.context as { request?: { method?: string } } | undefined)?.request;
    const method = (request?.method ?? "").toUpperCase();
    if (method === "GET" || method === "HEAD") {
      this.options.vfs
        .readFileBytes(target)
        .then((bytes) => callback(undefined, bytes.byteLength))
        .catch((error: unknown) => callback(httpErrorFor(error)));
      return;
    }
    this.options.vfs
      .stat(target)
      .then(async (stat) => callback(undefined,
        method === "PROPFIND" && stat.isFile && stat.sizeEstimated
          ? (await this.options.vfs.readFileBytes(target)).byteLength
          : stat.size))
      .catch((error: unknown) => callback(httpErrorFor(error)));
  }

  protected _lastModifiedDate(
    path: webdav.Path,
    _ctx: webdav.LastModifiedDateInfo,
    callback: webdav.ReturnCallback<number>,
  ): void {
    if (this.isDraft(path)) {
      const draft = this.drafts.get(path.toString());
      if (!draft) callback(webdav.Errors.ResourceNotFound);
      else callback(undefined, draft.modified);
      return;
    }
    if (isIndexerShield(this.lastSegment(path))) {
      callback(undefined, 0);
      return;
    }
    this.options.vfs
      .stat(this.vfsPath(path))
      .then((stat) => callback(undefined, stat.mtime.getTime()))
      .catch((error: unknown) => callback(httpErrorFor(error)));
  }

  protected _creationDate(
    path: webdav.Path,
    ctx: webdav.CreationDateInfo,
    callback: webdav.ReturnCallback<number>,
  ): void {
    this._lastModifiedDate(path, ctx as never, callback);
  }

  /**
   * ETag from page id and version.
   *
   * Both are already in the index, so this costs nothing — and it gives
   * `If-Match` real meaning: a conditional PUT that fails is the same stale
   * write the core's conflict path handles.
   */
  protected _etag(
    path: webdav.Path,
    _ctx: webdav.ETagInfo,
    callback: webdav.ReturnCallback<string>,
  ): void {
    if (this.isDraft(path)) {
      const draft = this.drafts.get(path.toString());
      if (!draft) callback(webdav.Errors.ResourceNotFound);
      else callback(undefined, `"draft-${draft.modified}-${draft.bytes.byteLength}"`);
      return;
    }
    if (isIndexerShield(this.lastSegment(path))) {
      callback(undefined, '"indexer-shield"');
      return;
    }
    this.options.vfs
      .stat(this.vfsPath(path))
      .then((stat) => callback(undefined, `"${stat.id}-${stat.version ?? 0}"`))
      .catch((error: unknown) => callback(httpErrorFor(error)));
  }

  protected _mimeType(
    path: webdav.Path,
    _ctx: webdav.MimeTypeInfo,
    callback: webdav.ReturnCallback<string>,
  ): void {
    const name = this.lastSegment(path);
    if (name.endsWith(".md")) callback(undefined, "text/markdown");
    else if (name.endsWith(".json")) callback(undefined, "application/json");
    else callback(undefined, "application/octet-stream");
  }

  protected _openReadStream(
    path: webdav.Path,
    _ctx: webdav.OpenReadStreamInfo,
    callback: webdav.ReturnCallback<Readable>,
  ): void {
    if (this.isDraft(path)) {
      const draft = this.drafts.get(path.toString());
      if (!draft) callback(webdav.Errors.ResourceNotFound);
      else if (draft.directory) callback(webdav.Errors.WrongParentTypeForCreation);
      else callback(undefined, Readable.from([draft.bytes]));
      return;
    }
    const name = this.lastSegment(path);
    if (isIndexerShield(name)) {
      callback(undefined, Readable.from([Buffer.alloc(0)]));
      return;
    }
    if (isClientDropping(name)) {
      callback(webdav.Errors.ResourceNotFound);
      return;
    }
    this.sweepDetector.noteRead(this.parentOf(path));
    this.options.vfs
      .readFileBytes(this.vfsPath(path))
      .then((bytes) => callback(undefined, Readable.from([Buffer.from(bytes)])))
      .catch((error: unknown) => callback(httpErrorFor(error)));
  }

  /**
   * Buffer the whole body, then write once.
   *
   * A page update is a single versioned `PUT` against Confluence; streaming it
   * through in pieces would either burn a version per chunk or need a second
   * buffering layer anyway. The core's write coalescing then merges the several
   * `PUT`s an editor makes into one update.
   */
  protected _openWriteStream(
    path: webdav.Path,
    _ctx: webdav.OpenWriteStreamInfo,
    callback: webdav.ReturnCallback<Writable>,
  ): void {
    const target = this.vfsPath(path);
    const name = this.lastSegment(path);
    if (isClientDropping(name) || isIndexerShield(name)) {
      // Accept and discard: a client writing its own droppings must not see an
      // error, and they are not ours to store.
      callback(undefined, new Writable({ write: (_c, _e, done) => done() }));
      return;
    }

    // Refuse before buffering: a read-only mount should answer 403 on the
    // request rather than accept the body and fail at the end of the stream,
    // where webdav-server can only report a 500.
    if (!isWritable(this.options.vfs.guard, "update")) {
      callback(
        httpErrorFor(
          new VfsError(
            "EROFS",
            `Read-only filesystem: cannot write ${target}. Mount with --mode rw to allow writes`,
            { path: target },
          ),
        ),
      );
      return;
    }

    const chunks: Buffer[] = [];
    const staging = this.isDraft(path);
    let length = 0;
    const stream = new Writable({
      write(chunk, _encoding, done) {
        length += chunk.length;
        if (staging && length > 64 * 1024 * 1024) {
          done(webdav.Errors.InsufficientStorage);
          return;
        }
        chunks.push(Buffer.from(chunk));
        done();
      },
      final: (done) => {
        if (this.isDraft(path)) {
          const otherBytes = [...this.drafts.entries()].reduce((sum, [key, draft]) =>
            sum + (key === path.toString() ? 0 : draft.bytes.byteLength), 0);
          if (otherBytes + length > 64 * 1024 * 1024) return done(webdav.Errors.InsufficientStorage);
          this.drafts.set(path.toString(), { bytes: Buffer.concat(chunks), modified: Date.now() });
          done();
          return;
        }
        this.options.vfs
          .writeFile(target, new Uint8Array(Buffer.concat(chunks)))
          .then(() => done())
          .catch((error: unknown) => done(httpErrorFor(error)));
      },
    });
    callback(undefined, stream);
  }

  protected _create(
    path: webdav.Path,
    ctx: webdav.CreateInfo,
    callback: webdav.SimpleCallback,
  ): void {
    const target = this.vfsPath(path);
    const name = this.lastSegment(path);
    if (isClientDropping(name) || isIndexerShield(name)) {
      callback();
      return;
    }
    if (!isWritable(this.options.vfs.guard, "mkdir")) {
      callback(
        httpErrorFor(
          new VfsError("EROFS", `Read-only filesystem: cannot create ${target}`, { path: target }),
        ),
      );
      return;
    }
    if (this.isDraft(path)) {
      this.drafts.set(path.toString(), { bytes: Buffer.alloc(0), modified: Date.now(), directory: ctx.type.isDirectory });
      callback();
      return;
    }
    const created =
      ctx.type.isDirectory
        ? this.options.vfs.mkdir(target)
        : this.options.vfs.writeFile(target, "");
    created.then(() => callback()).catch((error: unknown) => callback(httpErrorFor(error)));
  }

  protected _delete(
    path: webdav.Path,
    ctx: webdav.DeleteInfo,
    callback: webdav.SimpleCallback,
  ): void {
    const name = this.lastSegment(path);
    if (this.isDraft(path)) {
      for (const key of this.drafts.keys()) {
        if (key === path.toString() || key.startsWith(`${path.toString()}/`)) this.drafts.delete(key);
      }
      for (const [original, backup] of this.pendingBackups) {
        if (backup === path.toString() || backup.startsWith(`${path.toString()}/`)) this.pendingBackups.delete(original);
      }
      callback();
      return;
    }
    if (isClientDropping(name) || isIndexerShield(name)) {
      callback();
      return;
    }
    this.options.vfs
      .rm(this.vfsPath(path), { recursive: ctx.depth !== 0 })
      .then(() => callback())
      .catch((error: unknown) => callback(httpErrorFor(error)));
  }

  protected _move(
    pathFrom: webdav.Path,
    pathTo: webdav.Path,
    _ctx: webdav.MoveInfo,
    callback: webdav.ReturnCallback<boolean>,
  ): void {
    if (this.isDraft(pathFrom)) {
      const draft = this.drafts.get(pathFrom.toString());
      if (!draft) { callback(webdav.Errors.ResourceNotFound); return; }
      if (draft.directory) { callback(webdav.Errors.WrongParentTypeForCreation); return; }
      if (this.isDraft(pathTo)) {
        this.drafts.set(pathTo.toString(), draft);
        this.drafts.delete(pathFrom.toString());
        callback(undefined, true);
        return;
      }
      this.options.vfs.writeFile(this.vfsPath(pathTo), draft.bytes)
        .then(() => this.options.vfs.flush())
        .then(() => {
          this.drafts.delete(pathFrom.toString());
          this.pendingBackups.delete(pathTo.toString());
          callback(undefined, true);
        })
        .catch((error: unknown) => {
          this.pendingBackups.delete(pathTo.toString());
          callback(httpErrorFor(error));
        });
      return;
    }
    if (this.isDraft(pathTo)) {
      if (!isWritable(this.options.vfs.guard, "update")) { callback(webdav.Errors.Forbidden); return; }
      // TextEdit first MOVEs the original into its backup area. Snapshot it
      // locally; the remote page must keep its ID until the replacement commits.
      this.options.vfs.readFileBytes(this.vfsPath(pathFrom)).then((bytes) => {
        const otherBytes = [...this.drafts.entries()].reduce((sum, [key, draft]) =>
          sum + (key === pathTo.toString() ? 0 : draft.bytes.byteLength), 0);
        if (otherBytes + bytes.byteLength > 64 * 1024 * 1024) {
          callback(webdav.Errors.InsufficientStorage);
          return;
        }
        this.drafts.set(pathTo.toString(), { bytes: Buffer.from(bytes), modified: Date.now() });
        // Present a real move to the desktop client while preserving remote ID.
        // Its subsequent Overwrite:F replacement can now create this path.
        this.pendingBackups.set(pathFrom.toString(), pathTo.toString());
        callback(undefined, true);
      }).catch((error: unknown) => callback(httpErrorFor(error)));
      return;
    }
    this.options.vfs
      .rename(this.vfsPath(pathFrom), this.vfsPath(pathTo))
      .then(() => callback(undefined, true))
      .catch((error: unknown) => callback(httpErrorFor(error)));
  }

  protected _rename(
    pathFrom: webdav.Path,
    newName: string,
    _ctx: webdav.RenameInfo,
    callback: webdav.ReturnCallback<boolean>,
  ): void {
    const parent = this.parentOf(pathFrom);
    const target = parent === "/" ? `/${newName}` : `${parent}/${newName}`;
    this._move(pathFrom, new webdav.Path(target), { ..._ctx, overwrite: true }, callback);
  }

  protected _copy(
    pathFrom: webdav.Path,
    pathTo: webdav.Path,
    _ctx: webdav.CopyInfo,
    callback: webdav.ReturnCallback<boolean>,
  ): void {
    this.options.vfs
      .copy(this.vfsPath(pathFrom), this.vfsPath(pathTo))
      .then(() => callback(undefined, true))
      .catch((error: unknown) => callback(httpErrorFor(error)));
  }
}

/**
 * Serialization is refused on purpose.
 *
 * `webdav-server` can persist a filesystem's state to disk. Ours is a *view*
 * of a live tenant plus a disposable cache, so a serialized copy would be both
 * stale and an unbounded duplicate of content the user may no longer be allowed
 * to see.
 */
class ConfluenceWebdavSerializer implements webdav.FileSystemSerializer {
  uid(): string {
    return "atlcli-confluence-vfs@1";
  }

  serialize(_fs: webdav.FileSystem, callback: webdav.ReturnCallback<unknown>): void {
    callback(new Error("The Confluence filesystem is a live view and is not serializable"));
  }

  unserialize(_serialized: unknown, callback: webdav.ReturnCallback<webdav.FileSystem>): void {
    callback(new Error("The Confluence filesystem is a live view and is not serializable"));
  }
}


/**
 * The volume root (WP7.3b).
 *
 * It holds nothing of Confluence's: `.me.json`, which says whose view this is,
 * and the Spotlight exclusions, which have to **exist** for macOS to leave the
 * volume alone. The space filesystems mount beneath it and webdav-server adds
 * them to this listing itself.
 */
export class RootFileSystem extends webdav.FileSystem {
  private readonly locks = new Map<string, webdav.LocalLockManager>();
  private readonly properties = new Map<string, webdav.LocalPropertyManager>();

  constructor(private readonly vfs: ConfluenceVfsImpl) {
    super(new ConfluenceWebdavSerializer());
  }

  private name(path: webdav.Path): string {
    const segments = path.toString().split("/").filter(Boolean);
    return segments[segments.length - 1] ?? "";
  }

  protected _lockManager(
    path: webdav.Path,
    _ctx: webdav.LockManagerInfo,
    callback: webdav.ReturnCallback<webdav.ILockManager>,
  ): void {
    const key = path.toString();
    let manager = this.locks.get(key);
    if (!manager) {
      manager = new webdav.LocalLockManager();
      this.locks.set(key, manager);
    }
    callback(undefined, manager);
  }

  protected _propertyManager(
    path: webdav.Path,
    _ctx: webdav.PropertyManagerInfo,
    callback: webdav.ReturnCallback<webdav.IPropertyManager>,
  ): void {
    const key = path.toString();
    let manager = this.properties.get(key);
    if (!manager) {
      manager = new webdav.LocalPropertyManager();
      this.properties.set(key, manager);
    }
    callback(undefined, manager);
  }

  protected _fastExistCheck(
    _ctx: webdav.RequestContext,
    path: webdav.Path,
    callback: (exists: boolean) => void,
  ): void {
    const name = this.name(path);
    callback(name === "" || name === ".me.json" || isIndexerShield(name));
  }

  protected _type(
    path: webdav.Path,
    _ctx: webdav.TypeInfo,
    callback: webdav.ReturnCallback<webdav.ResourceType>,
  ): void {
    const name = this.name(path);
    if (name === "") callback(undefined, webdav.ResourceType.Directory);
    else if (name === ".me.json" || isIndexerShield(name)) {
      callback(undefined, webdav.ResourceType.File);
    } else callback(webdav.Errors.ResourceNotFound);
  }

  protected _readDir(
    _path: webdav.Path,
    _ctx: webdav.ReadDirInfo,
    callback: webdav.ReturnCallback<string[]>,
  ): void {
    callback(undefined, [".me.json", ...INDEXER_SHIELDS]);
  }

  protected _size(
    path: webdav.Path,
    _ctx: webdav.SizeInfo,
    callback: webdav.ReturnCallback<number>,
  ): void {
    if (this.name(path) !== ".me.json") {
      callback(undefined, 0);
      return;
    }
    this.vfs
      .readFile("/.me.json")
      .then((text) => callback(undefined, Buffer.byteLength(text, "utf8")))
      .catch((error: unknown) => callback(httpErrorFor(error)));
  }

  protected _lastModifiedDate(
    _path: webdav.Path,
    _ctx: webdav.LastModifiedDateInfo,
    callback: webdav.ReturnCallback<number>,
  ): void {
    callback(undefined, Date.now());
  }

  protected _mimeType(
    path: webdav.Path,
    _ctx: webdav.MimeTypeInfo,
    callback: webdav.ReturnCallback<string>,
  ): void {
    callback(undefined, this.name(path) === ".me.json" ? "application/json" : "text/plain");
  }

  protected _openReadStream(
    path: webdav.Path,
    _ctx: webdav.OpenReadStreamInfo,
    callback: webdav.ReturnCallback<Readable>,
  ): void {
    if (this.name(path) !== ".me.json") {
      callback(undefined, Readable.from([Buffer.alloc(0)]));
      return;
    }
    this.vfs
      .readFile("/.me.json")
      .then((text) => callback(undefined, Readable.from([Buffer.from(text, "utf8")])))
      .catch((error: unknown) => callback(httpErrorFor(error)));
  }

  protected _openWriteStream(
    _path: webdav.Path,
    _ctx: webdav.OpenWriteStreamInfo,
    callback: webdav.ReturnCallback<Writable>,
  ): void {
    // Everything here is generated; a client writing to it is writing to a
    // dropping of its own, so accept and discard rather than erroring.
    callback(undefined, new Writable({ write: (_c, _e, done) => done() }));
  }

  protected _create(
    _path: webdav.Path,
    _ctx: webdav.CreateInfo,
    callback: webdav.SimpleCallback,
  ): void {
    callback();
  }

  protected _delete(
    _path: webdav.Path,
    _ctx: webdav.DeleteInfo,
    callback: webdav.SimpleCallback,
  ): void {
    callback();
  }
}
