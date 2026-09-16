/**
 * The `ConfluenceVfs` implementation.
 *
 * Grows across work packages: WP2 gives it `resolve`, `stat` and `readdir`;
 * WP3 adds `readFile`; WP4 the convenience directories; WP5 the write path.
 * What stays constant is the contract — every method takes an absolute VFS
 * path and throws {@link VfsError}.
 *
 * Rule 2 of the demand principle is enforced right here: `stat` and `readdir`
 * answer from the tree index and **never** call `getPage`. `stat` therefore
 * reports an estimated size until a real read has measured one, and says so
 * through `VfsStat.sizeEstimated`.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  BodyCache,
  identityPathFor,
  recallIdentity,
  rememberIdentity,
  resolveCachePaths,
} from "./body-cache.js";
import {
  INDEX_FILE,
  RESERVED_NAMES,
  formatDirName,
  parseName,
  splitParent,
  normalizePath,
  titleFromName,
} from "./path-mapper.js";
import type { ResolvedVfsOptions, VfsOptions } from "./options.js";
import { resolveVfsOptions } from "./options.js";
import { mapClientError } from "./errors.js";
import { PageStore } from "./page-store.js";
import { AuditLog } from "./audit-log.js";
import { ConflictStore } from "./conflict-store.js";
import { assertWritable, type ModeGuard } from "./mode.js";
import { parseVfsFrontmatter } from "./page-store.js";
import { PathResolver, isContainer, type MissingLeaf, type Resolved } from "./resolver.js";
import { VirtualDirs } from "./virtual-dirs.js";
import { WriteBack } from "./write-back.js";
import { TreeIndex, type TreeNode } from "./tree-index.js";
import { VfsError, type VfsDirent, type VfsNode, type VfsStat } from "./types.js";
import type { ConfluenceVfs, VfsWriteResult } from "./vfs.js";

/** Everything the factory resolved that the core needs but cannot derive. */
export interface VfsRuntime {
  accountId: string;
  displayName: string;
  instanceUrl: string;
  cacheDir: string;
  dbPath: string;
  blobDir: string;
  conflictDir: string;
  /** Where the tree snapshot lives, so `--offline` can still list. */
  snapshotPath: string;
}

/**
 * What `stat` reports for a body it has never read.
 *
 * A zero would make `cat` and `PROPFIND` treat the page as empty, and a real
 * number would cost a request per entry. This is deliberately a round,
 * obviously-synthetic figure, and `sizeEstimated` marks it as a guess.
 */
const ESTIMATED_BODY_BYTES = 4096;

const DIR_MODE = 0o040755;
const FILE_MODE = 0o100644;
const RO_FILE_MODE = 0o100444;
const LINK_MODE = 0o120777;

export class ConfluenceVfsImpl implements ConfluenceVfs {
  readonly index: TreeIndex;
  readonly cache: BodyCache | undefined;
  readonly runtime: VfsRuntime | undefined;
  private readonly store: PageStore | undefined;
  private readonly virtual: VirtualDirs | undefined;
  private readonly writeBack: WriteBack | undefined;
  readonly conflicts: ConflictStore | undefined;
  readonly audit: AuditLog | undefined;
  private readonly resolver: PathResolver;

  constructor(
    private readonly opts: ResolvedVfsOptions,
    runtime?: VfsRuntime,
    cache?: BodyCache,
  ) {
    this.index = new TreeIndex({
      client: opts.client,
      ttlMs: opts.treeTtlMs,
      concurrency: opts.concurrency,
      offline: opts.offline,
      logger: opts.logger,
      now: opts.now,
      sleep: opts.sleep,
      spaces: opts.spaces,
    });
    this.resolver = new PathResolver(this.index);
    this.runtime = runtime;
    this.cache = cache;
    if (runtime && cache) {
      this.store = new PageStore({
        client: opts.client,
        cache,
        index: this.index,
        instanceUrl: runtime.instanceUrl,
        offline: opts.offline,
        concurrency: opts.concurrency,
        prefetchMaxPages: opts.prefetchMaxPages,
        logger: opts.logger,
        sleep: opts.sleep,
      });
      this.virtual = new VirtualDirs({
        client: opts.client,
        index: this.index,
        cache,
        instanceUrl: runtime.instanceUrl,
        profile: opts.profile,
        offline: opts.offline,
        logger: opts.logger,
        now: opts.now,
        sleep: opts.sleep,
        readQueryHints: () => this.readQueryHints(),
        writeQueryHints: (queries) => this.writeQueryHints(queries),
      });
      this.conflicts = new ConflictStore(runtime.conflictDir);
      this.audit = new AuditLog(
        join(runtime.cacheDir, "vfs-audit.jsonl"),
        opts.profile,
        runtime.accountId,
        opts.now,
      );
      this.writeBack = new WriteBack({
        client: opts.client,
        index: this.index,
        cache,
        conflicts: this.conflicts,
        audit: this.audit,
        guard: this.guard,
        instanceUrl: runtime.instanceUrl,
        logger: opts.logger,
        now: opts.now,
        sleep: opts.sleep,
        coalesceMs: opts.coalesceMs,
        schedule: opts.schedule,
      });
      this.restoreSnapshot();
    }
  }

  /** The single source of truth for what this filesystem may change. */
  get guard(): ModeGuard {
    return { mode: this.opts.mode, allowDelete: this.opts.allowDelete };
  }

  /** The `.search/` hint list. Disposable by design (decision 8). */
  private readQueryHints(): string[] {
    if (!this.runtime) return [];
    try {
      const parsed = JSON.parse(
        readFileSync(join(this.runtime.cacheDir, "search-hints.json"), "utf8"),
      ) as unknown;
      return Array.isArray(parsed) ? parsed.filter((q): q is string => typeof q === "string") : [];
    } catch {
      return [];
    }
  }

  private writeQueryHints(queries: string[]): void {
    if (!this.runtime) return;
    try {
      mkdirSync(this.runtime.cacheDir, { recursive: true });
      writeFileSync(join(this.runtime.cacheDir, "search-hints.json"), JSON.stringify(queries));
    } catch {
      // Losing the hint list is explicitly acceptable.
    }
  }

  private requireVirtual(): VirtualDirs {
    if (!this.virtual) {
      throw new VfsError(
        "EINVAL",
        "This filesystem was built without a cache; use ConfluenceVfsImpl.open()",
      );
    }
    return this.virtual;
  }

  /**
   * Open a filesystem: resolve the account, place the cache, hydrate the
   * offline snapshot.
   *
   * Asynchronous because the cache path *must* carry the account ID — a shared
   * cache would let one profile read what another profile's token returned —
   * and that costs one `getCurrentUser` call.
   */
  static async open(options: VfsOptions): Promise<ConfluenceVfsImpl> {
    const opts = resolveVfsOptions(options);
    const instanceUrl = opts.client.getInstanceUrl();
    const identity = opts.offline
      ? recallIdentity(identityPathFor(opts.cacheDir, opts.profile, instanceUrl))
      : await opts.client.getCurrentUser();
    if (!identity) {
      throw new VfsError(
        "ENOENT",
        `No cached session for profile '${opts.profile}' at ${instanceUrl}. ` +
          `--offline cannot look the account up without a request; run the command once without it first`,
      );
    }
    const paths = resolveCachePaths({
      cacheDir: opts.cacheDir,
      profile: opts.profile,
      accountId: identity.accountId,
      instanceUrl,
    });
    const runtime: VfsRuntime = {
      accountId: identity.accountId,
      displayName: identity.displayName,
      instanceUrl,
      cacheDir: opts.cacheDir,
      dbPath: paths.dbPath,
      blobDir: paths.blobDir,
      conflictDir: paths.conflictDir,
      snapshotPath: join(paths.dir, "tree-snapshot.json"),
    };
    if (!opts.offline) rememberIdentity(paths.identityPath, identity);
    const cache = new BodyCache({
      dbPath: paths.dbPath,
      blobDir: paths.blobDir,
      maxBytes: opts.cacheMaxMb * 1024 * 1024,
      now: opts.now,
    });
    return new ConfluenceVfsImpl(opts, runtime, cache);
  }

  /** Persists the tree so `--offline` can list without any request (WP3.5). */
  saveSnapshot(): void {
    if (!this.runtime) return;
    try {
      mkdirSync(join(this.runtime.snapshotPath, ".."), { recursive: true });
      writeFileSync(this.runtime.snapshotPath, JSON.stringify(this.index.snapshot()));
    } catch (error) {
      // A snapshot is an optimisation, never a correctness requirement.
      this.opts.logger.debug("could not write the tree snapshot", { error: String(error) });
    }
  }

  private restoreSnapshot(): void {
    if (!this.runtime || !existsSync(this.runtime.snapshotPath)) return;
    try {
      const raw = JSON.parse(readFileSync(this.runtime.snapshotPath, "utf8")) as {
        nodes?: unknown;
        spaces?: unknown;
      };
      if (Array.isArray(raw.nodes) && Array.isArray(raw.spaces)) {
        this.index.hydrate({ nodes: raw.nodes as never, spaces: raw.spaces as never });
      }
    } catch (error) {
      this.opts.logger.debug("could not read the tree snapshot", { error: String(error) });
    }
  }

  /** Sends pending coalesced writes, persists the tree, closes the cache. */
  async close(): Promise<void> {
    await this.writeBack?.flush();
    this.saveSnapshot();
    this.cache?.close();
  }

  /** Sends pending coalesced writes without closing. */
  async flush(): Promise<void> {
    await this.writeBack?.flush();
  }

  private requireWriteBack(): WriteBack {
    if (!this.writeBack) {
      throw new VfsError(
        "EINVAL",
        "This filesystem was built without a cache; use ConfluenceVfsImpl.open()",
      );
    }
    return this.writeBack;
  }

  /** Fills the body cache for many pages at once, within the prefetch budget. */
  async prefetch(
    ids: string[],
    options: { budget?: number; reason?: string } = {},
  ): Promise<{ fetched: number; fromCache: number }> {
    return this.requireStore().prefetchBodies(ids, options);
  }

  private requireStore(): PageStore {
    if (!this.store) {
      throw new VfsError(
        "EINVAL",
        "This filesystem was built without a cache; use ConfluenceVfsImpl.open()",
      );
    }
    return this.store;
  }

  // ------------------------------------------------------------- resolution

  async resolve(path: string): Promise<VfsNode> {
    const resolved = await this.resolver.resolve(path);
    return this.toNode(resolved as Resolved, path);
  }

  /** Internal: the tagged form, which the write path needs. */
  async resolveTagged(path: string, allowMissingLeaf = false): Promise<Resolved | { kind: "missing"; parent: Resolved; name: string; path: string }> {
    return this.resolver.resolve(path, { allowMissingLeaf });
  }

  // ------------------------------------------------------------------ stat

  async stat(path: string): Promise<VfsStat> {
    const resolved = (await this.resolver.resolve(path)) as Resolved;
    if (resolved.kind === "attachment" && this.virtual) {
      // Attachment size and mtime come from the listing metadata, so `ls -l`
      // over a directory of large files still downloads nothing.
      const meta = await this.virtual.attachmentMeta(resolved.node, resolved.filename, path);
      return {
        kind: "attachment",
        isDirectory: false,
        isFile: true,
        isSymbolicLink: false,
        size: meta.size,
        sizeEstimated: false,
        mtime: meta.mtime,
        mode: FILE_MODE,
        id: meta.id,
        version: meta.version,
      };
    }
    if (resolved.kind === "by-id-link" && this.virtual) {
      // Addressing a page by id must work even for a branch the index has not
      // walked, so this may cost one lookup.
      await this.virtual.loadNode(resolved.id, resolved.spaceKey, path);
    }
    return this.statOf(resolved);
  }

  private statOf(resolved: Resolved): VfsStat {
    const dir = (id: string, mtime: Date, kind: VfsStat["kind"]): VfsStat => ({
      kind,
      isDirectory: true,
      isFile: false,
      isSymbolicLink: false,
      size: 0,
      sizeEstimated: false,
      mtime,
      mode: DIR_MODE,
      id,
    });
    const file = (
      id: string,
      mtime: Date,
      kind: VfsStat["kind"],
      options: { size?: number; readOnly?: boolean; version?: number } = {},
    ): VfsStat => ({
      kind,
      isDirectory: false,
      isFile: true,
      isSymbolicLink: false,
      size: options.size ?? ESTIMATED_BODY_BYTES,
      sizeEstimated: options.size === undefined,
      mtime,
      mode: options.readOnly ? RO_FILE_MODE : FILE_MODE,
      id,
      ...(options.version !== undefined ? { version: options.version } : {}),
    });
    const link = (id: string, mtime: Date): VfsStat => ({
      kind: "symlink",
      isDirectory: false,
      isFile: false,
      isSymbolicLink: true,
      size: 0,
      sizeEstimated: false,
      mtime,
      mode: LINK_MODE,
      id,
    });

    const epoch = new Date(this.opts.now());

    switch (resolved.kind) {
      case "root":
        return dir("root", epoch, "virtual-dir");
      case "space":
        return dir(resolved.spaceKey, epoch, "space");
      case "container":
        return dir(resolved.node.id, mtimeOf(resolved.node, epoch), resolved.node.type === "folder" ? "folder" : "page");
      case "body":
        return file(resolved.node.id, mtimeOf(resolved.node, epoch), "page", {
          version: resolved.node.version,
        });
      case "non-page":
        return file(resolved.node.id, mtimeOf(resolved.node, epoch), "virtual-file", {
          readOnly: true,
        });
      case "me-json":
      case "space-json":
        return file(resolved.kind, epoch, "virtual-file", { readOnly: true });
      case "attachments-dir":
        return dir(`${resolved.node.id}/_attachments`, mtimeOf(resolved.node, epoch), "virtual-dir");
      case "attachment":
        return file(`${resolved.node.id}/${resolved.filename}`, mtimeOf(resolved.node, epoch), "attachment");
      case "versions-dir":
        return dir(`${resolved.node.id}/.versions`, mtimeOf(resolved.node, epoch), "virtual-dir");
      case "version-file":
        return file(`${resolved.node.id}@${resolved.version}`, mtimeOf(resolved.node, epoch), "virtual-file", {
          readOnly: true,
          version: resolved.version,
        });
      case "comments-file":
        return file(`${resolved.node.id}/.comments`, mtimeOf(resolved.node, epoch), "virtual-file", {
          readOnly: true,
        });
      case "conflict-file":
        return file(`${resolved.node.id}.conflict`, mtimeOf(resolved.node, epoch), "virtual-file");
      case "by-id-dir":
      case "labels-dir":
      case "label-dir":
      case "recent-dir":
      case "recent-window":
      case "search-dir":
      case "search-query":
        return dir(`${resolved.spaceKey}/${resolved.kind}`, epoch, "virtual-dir");
      case "search-readme":
      case "by-id-readme":
      case "labels-readme":
        return file(`${resolved.spaceKey}/${resolved.kind}`, epoch, "virtual-file", {
          readOnly: true,
        });
      case "by-id-link":
        return link(resolved.id, epoch);
      case "label-link":
      case "recent-link":
      case "search-link":
        // The link's identity is the page it points at, so an adapter can build
        // an ETag from it without following the link first.
        return link(parseName(resolved.name).idCandidate ?? resolved.name, epoch);
    }
  }

  // --------------------------------------------------------------- readdir

  async readdir(path: string): Promise<VfsDirent[]> {
    const resolved = (await this.resolver.resolve(path)) as Resolved;
    switch (resolved.kind) {
      case "root":
        return this.readdirRoot();
      case "space":
        return this.readdirSpace(resolved.spaceKey, resolved.homepageId);
      case "container":
        return this.readdirContainer(resolved.node);
      case "attachments-dir":
      case "versions-dir":
      case "by-id-dir":
      case "labels-dir":
      case "label-dir":
      case "recent-dir":
      case "recent-window":
      case "search-dir":
      case "search-query":
        return this.readdirVirtual(resolved, path);
      default:
        throw new VfsError("ENOTDIR", `Not a directory: ${path}`, { path });
    }
  }

  private async readdirRoot(): Promise<VfsDirent[]> {
    const spaces = await this.index.listSpaces();
    const entries: VfsDirent[] = spaces.map((space) => ({
      name: space.key,
      kind: "space" as const,
      isDirectory: true,
      isFile: false,
      isSymbolicLink: false,
    }));
    entries.push(virtualFileEntry(".me.json"));
    return entries;
  }

  private async readdirSpace(spaceKey: string, homepageId: string | null): Promise<VfsDirent[]> {
    const entries: VfsDirent[] = [virtualFileEntry("_space.json")];
    if (homepageId) {
      entries.push({
        name: INDEX_FILE,
        kind: "page",
        isDirectory: false,
        isFile: true,
        isSymbolicLink: false,
      });
      for (const child of await this.index.loadChildren(homepageId)) {
        entries.push(direntFor(child));
      }
    }
    for (const name of [".by-id", ".labels", ".recent", ".search"]) {
      entries.push(virtualDirEntry(name));
    }
    return entries;
  }

  private async readdirContainer(node: TreeNode): Promise<VfsDirent[]> {
    const entries: VfsDirent[] = [];
    if (node.type === "page") {
      entries.push({
        name: INDEX_FILE,
        kind: "page",
        isDirectory: false,
        isFile: true,
        isSymbolicLink: false,
      });
    } else {
      // A Confluence folder has no body, so its `_index.md` is metadata only
      // and read-only (WP5.4).
      entries.push({
        name: INDEX_FILE,
        kind: "virtual-file",
        isDirectory: false,
        isFile: true,
        isSymbolicLink: false,
      });
    }
    for (const child of await this.index.loadChildren(node.id)) {
      entries.push(direntFor(child));
    }
    if (node.type === "page") {
      entries.push(virtualDirEntry("_attachments"));
      entries.push(virtualDirEntry(".versions"));
      entries.push(virtualFileEntry(".comments.md"));
    }
    return entries;
  }

  private async readdirVirtual(resolved: Resolved, path: string): Promise<VfsDirent[]> {
    const virtual = this.requireVirtual();
    switch (resolved.kind) {
      case "attachments-dir":
        return virtual.attachmentsReaddir(resolved.node);
      case "versions-dir":
        return virtual.versionsReaddir(resolved.node);
      case "by-id-dir":
        return virtual.byIdReaddir();
      case "labels-dir":
        return virtual.labelsReaddir(resolved.spaceKey);
      case "label-dir":
        return virtual.labelReaddir(resolved.spaceKey, resolved.label);
      case "recent-dir":
        return virtual.recentReaddir();
      case "recent-window":
        return virtual.recentWindowReaddir(resolved.spaceKey, resolved.window);
      case "search-dir":
        return virtual.searchReaddir();
      case "search-query":
        return virtual.searchQueryReaddir(resolved.spaceKey, resolved.query);
      default:
        throw new VfsError("ENOTDIR", `Not a directory: ${path}`, { path });
    }
  }

  // -------------------------------------------------------------- readFile

  async readFile(path: string): Promise<string> {
    const resolved = (await this.resolver.resolve(path)) as Resolved;
    switch (resolved.kind) {
      case "body":
        return this.requireStore().readBody(resolved.node, path);
      case "version-file":
        return this.requireStore().readVersion(resolved.node, resolved.version, path);
      case "non-page":
        return this.renderNonPage(resolved.node);
      case "comments-file":
        return this.requireVirtual().commentsMarkdown(resolved.node, path);
      case "space-json":
        return this.requireVirtual().spaceJson(resolved.spaceKey);
      case "me-json":
        return this.requireVirtual().meJson({
          accountId: this.runtime?.accountId ?? "unknown",
          displayName: this.runtime?.displayName ?? "unknown",
        });
      case "search-readme":
        return this.requireVirtual().searchReadme(resolved.spaceKey);
      case "by-id-readme":
        return this.requireVirtual().byIdReadme(resolved.spaceKey);
      case "labels-readme":
        return this.requireVirtual().labelsReadme(resolved.spaceKey);
      case "attachment":
        return new TextDecoder().decode(await this.readFileBytes(path));
      case "by-id-link":
      case "label-link":
      case "recent-link":
      case "search-link":
        // Reading through a symlink is transparent, as it is on a real
        // filesystem: `cat .labels/runbook/x-1.md` reads the page.
        return this.readFile(await this.readlink(path));
      case "container":
      case "space":
      case "root":
        throw new VfsError("EISDIR", `Is a directory: ${path}`, { path });
      default:
        break;
    }
    throw new VfsError("EISDIR", `Is a directory: ${path}`, { path });
  }

  async readFileBytes(path: string): Promise<Uint8Array> {
    const resolved = (await this.resolver.resolve(path)) as Resolved;
    if (resolved.kind === "attachment") {
      return this.requireVirtual().attachmentBytes(resolved.node, resolved.filename, path);
    }
    return new TextEncoder().encode(await this.readFile(path));
  }

  /**
   * A whiteboard, database or embed: a link, not content.
   *
   * The VFS cannot render these and will not pretend to. The stub says what the
   * object is and where to open it, which is the honest answer.
   */
  private renderNonPage(node: TreeNode): string {
    return `${JSON.stringify(
      {
        id: node.id,
        title: node.title,
        type: node.type,
        spaceKey: node.spaceKey,
        url: this.runtime
          ? `${this.runtime.instanceUrl}/spaces/${node.spaceKey}/${node.type}s/${node.id}`
          : undefined,
        note: `atlcli renders ${node.type}s as a link only; open the URL to view or edit it.`,
      },
      null,
      2,
    )}\n`;
  }

  // ------------------------------------------------------------- the writes

  /**
   * Create or update a page.
   *
   * A path that resolves to an existing body is an update; one that does not is
   * a create, which is how `echo > new-page.md` works. Everything else — a
   * version file, a comments file, a label link — is structurally read-only and
   * says so with `EROFS`, whatever the mode.
   */
  async writeFile(path: string, content: string | Uint8Array): Promise<VfsWriteResult> {
    const text = typeof content === "string" ? content : new TextDecoder().decode(content);
    const resolved = await this.resolver.resolve(path, { allowMissingLeaf: true });

    if (resolved.kind === "missing") {
      return this.createFromMissing(resolved, path, text);
    }
    switch (resolved.kind) {
      case "body": {
        if (resolved.node.type === "folder") {
          // A Confluence folder has no body, so there is nothing to write into.
          throw new VfsError(
            "EROFS",
            `${path} belongs to a Confluence folder, which has no body. Folders carry a title only`,
            { path },
          );
        }
        return this.requireWriteBack().updatePage(resolved.node, path, text);
      }
      case "attachment": {
        assertWritable(this.guard, "upload-attachment", path);
        return this.writeAttachment(resolved.node, resolved.filename, path, content);
      }
      case "container":
      case "space":
      case "root":
        throw new VfsError("EISDIR", `Is a directory: ${path}`, { path });
      default:
        throw new VfsError(
          "EROFS",
          `${path} is a generated view and cannot be written`,
          { path },
        );
    }
  }

  private async createFromMissing(
    missing: MissingLeaf,
    path: string,
    text: string,
  ): Promise<VfsWriteResult> {
    const parent = missing.parent;
    if (parent.kind !== "container" && parent.kind !== "space") {
      throw new VfsError("EROFS", `Cannot create ${path} here`, { path });
    }
    assertNotReserved(missing.name, path);

    const { spaceKey, parentNode, parentIsFolder } = await this.containerOf(parent, path);
    const result = await this.requireWriteBack().createPage({
      parent: parentNode,
      spaceKey,
      name: missing.name,
      path,
      content: text,
      parentIsFolder,
    });
    // The canonical name carries the new id; report it so a caller does not go
    // on addressing a name that only exists as a session alias.
    const node = this.index.node(result.pageId);
    const canonical = node
      ? `${splitParent(normalizePath(path)).parent}/${formatDirName(node.title, node.id)}.md`.replace(
          "//",
          "/",
        )
      : path;
    this.opts.logger.info("created page", { path: canonical, pageId: result.pageId });
    return { ...result, path: canonical };
  }

  private async containerOf(
    parent: Resolved,
    path: string,
  ): Promise<{ spaceKey: string; parentNode: TreeNode; parentIsFolder: boolean }> {
    if (parent.kind === "space") {
      const homepageId = parent.homepageId;
      const node = homepageId ? this.index.node(homepageId) : undefined;
      if (!node) throw new VfsError("ENOENT", `Space ${parent.spaceKey} has no home page`, { path });
      return { spaceKey: parent.spaceKey, parentNode: node, parentIsFolder: false };
    }
    if (parent.kind === "container") {
      return {
        spaceKey: parent.node.spaceKey,
        parentNode: parent.node,
        parentIsFolder: parent.node.type === "folder",
      };
    }
    throw new VfsError("EROFS", `Cannot create anything under ${path}`, { path });
  }

  private async writeAttachment(
    node: TreeNode,
    filename: string,
    path: string,
    content: string | Uint8Array,
  ): Promise<VfsWriteResult> {
    const bytes =
      typeof content === "string" ? new TextEncoder().encode(content) : new Uint8Array(content);
    const existing = (await this.opts.client.listAttachments(node.id)).find(
      (attachment) => attachment.filename === filename,
    );
    try {
      const saved = existing
        ? await this.opts.client.updateAttachment({
            attachmentId: existing.id,
            pageId: node.id,
            data: bytes,
          })
        : await this.opts.client.uploadAttachment({
            pageId: node.id,
            filename,
            data: bytes,
          });
      this.audit?.record({
        op: "upload-attachment",
        path,
        pageId: node.id,
        toVersion: saved.version,
        result: "ok",
      });
      return { path, pageId: node.id, version: saved.version, created: !existing };
    } catch (error) {
      const mapped = mapClientError(error, path);
      this.audit?.record({
        op: "upload-attachment",
        path,
        pageId: node.id,
        result: "error",
        errorCode: mapped.code,
      });
      throw mapped;
    }
  }

  /**
   * `mkdir` always creates a page with an empty body (decision 7).
   *
   * Never a Confluence folder: the folder API is Cloud-only, and a folder has
   * no body — so `_index.md` inside one would have to be unwritable, which is
   * a worse surprise than a directory that happens to be a page.
   */
  async mkdir(path: string): Promise<VfsWriteResult> {
    const resolved = await this.resolver.resolve(path, { allowMissingLeaf: true });
    if (resolved.kind !== "missing") {
      throw new VfsError("EEXIST", `Already exists: ${path}`, { path });
    }
    assertWritable(this.guard, "mkdir", path);
    assertNotReserved(resolved.name, path);

    const { spaceKey, parentNode, parentIsFolder } = await this.containerOf(resolved.parent, path);
    const result = await this.requireWriteBack().createPage({
      parent: parentNode,
      spaceKey,
      name: resolved.name,
      path,
      content: "",
      parentIsFolder,
    });
    this.audit?.record({ op: "mkdir", path, pageId: result.pageId, result: "ok" });
    return result;
  }

  /**
   * Retitle, reparent, or move across spaces, depending on what changed.
   *
   * The id suffix is part of the page's identity, not of its name, so a rename
   * that tries to change it is `EINVAL` rather than a silent no-op on a
   * different page.
   */
  async rename(from: string, to: string): Promise<void> {
    const source = (await this.resolver.resolve(from)) as Resolved;
    if (source.kind !== "container" && source.kind !== "body") {
      throw new VfsError("EROFS", `${from} is a generated view and cannot be renamed`, {
        path: from,
      });
    }
    const node = source.node;
    const target = splitParent(normalizePath(to));
    const parsedTarget = parseName(target.name);

    if (parsedTarget.idCandidate !== undefined && parsedTarget.idCandidate !== node.id) {
      throw new VfsError(
        "EINVAL",
        `A rename cannot change the id suffix: ${from} is page ${node.id}, but ${to} names ${parsedTarget.idCandidate}`,
        { path: to },
      );
    }

    const destination = await this.resolver.resolve(target.parent);
    const { spaceKey, parentNode } = await this.containerOf(destination as Resolved, to);
    const sameParent = parentNode.id === node.parentId;
    const newTitle = parsedTarget.idCandidate
      ? titleFromName(parsedTarget.slugCandidate)
      : titleFromName(parsedTarget.stem);

    try {
      if (!sameParent) {
        assertWritable(this.guard, "move", from);
        if (spaceKey !== node.spaceKey) {
          // Cross-space moves go through the v1 positional endpoint, which is
          // the only one that accepts a target in another space.
          await this.opts.client.movePageToPosition(node.id, "append", parentNode.id);
        } else if (parentNode.type === "folder") {
          await this.opts.client.movePageToFolder(node.id, parentNode.id);
        } else {
          await this.opts.client.movePage(node.id, parentNode.id);
        }
        this.index.forget(node.id);
        this.index.attachChild(parentNode.id, {
          id: node.id,
          title: node.title,
          type: node.type,
          spaceKey,
          version: node.version,
        });
        this.audit?.record({ op: "move", path: from, target: to, pageId: node.id, result: "ok" });
      }

      // Confluence has no separate rename: a title change is an update, so it
      // costs a version like any other edit.
      const current = this.index.node(node.id) ?? node;
      if (newTitle && newTitle !== current.title) {
        assertWritable(this.guard, "rename", from);
        const page = await this.opts.client.getPage(node.id);
        await this.opts.client.updatePage({
          id: node.id,
          title: newTitle,
          storage: page.storage,
          version: (page.version ?? current.version ?? 1) + 1,
        });
        this.index.upsert({ id: node.id, title: newTitle, version: (page.version ?? 1) + 1 });
        this.audit?.record({
          op: "rename",
          path: from,
          target: to,
          pageId: node.id,
          result: "ok",
        });
      }
    } catch (error) {
      const mapped = mapClientError(error, from);
      this.audit?.record({
        op: sameParent ? "rename" : "move",
        path: from,
        target: to,
        pageId: node.id,
        result: "error",
        errorCode: mapped.code,
      });
      throw mapped;
    }
  }

  /**
   * Move a page to the trash. Never a purge — the VFS calls no purge endpoint.
   *
   * A directory needs the recursive flag, because Confluence takes the children
   * with it and a caller who asked to remove one page should not lose a subtree
   * by accident.
   */
  async rm(path: string, options: { recursive?: boolean } = {}): Promise<void> {
    const resolved = (await this.resolver.resolve(path)) as Resolved;

    if (resolved.kind === "conflict-file") {
      // Local only: touches no Confluence content, so it is allowed in ro mode
      // and without --allow-delete (decision 9).
      this.conflicts?.discardAllFor(resolved.node.id);
      return;
    }
    if (resolved.kind === "attachment") {
      assertWritable(this.guard, "delete-attachment", path);
      const found = (await this.opts.client.listAttachments(resolved.node.id)).find(
        (attachment) => attachment.filename === resolved.filename,
      );
      if (!found) throw new VfsError("ENOENT", `No such attachment: ${path}`, { path });
      await this.opts.client.deleteAttachment(found.id);
      this.audit?.record({
        op: "delete-attachment",
        path,
        pageId: resolved.node.id,
        result: "ok",
      });
      return;
    }
    if (resolved.kind !== "container" && resolved.kind !== "body") {
      throw new VfsError("EROFS", `${path} is a generated view and cannot be deleted`, { path });
    }

    const node = resolved.node;
    assertWritable(this.guard, "delete", path);

    if (resolved.kind === "container" && !options.recursive) {
      const children = await this.index.loadChildren(node.id);
      if (children.length > 0) {
        throw new VfsError(
          "ENOTEMPTY",
          `${path} has ${children.length} child page(s). Deleting it sends them to the trash too; pass -r to confirm`,
          { path },
        );
      }
    }

    try {
      await this.opts.client.deletePage(node.id);
      this.cache?.forgetPage(node.id);
      this.index.forget(node.id);
      this.audit?.record({
        op: "delete",
        path,
        pageId: node.id,
        fromVersion: node.version,
        result: "ok",
      });
    } catch (error) {
      const mapped = mapClientError(error, path);
      this.audit?.record({
        op: "delete",
        path,
        pageId: node.id,
        result: "error",
        errorCode: mapped.code,
      });
      throw mapped;
    }
  }

  async copy(from: string, to: string): Promise<VfsWriteResult> {
    const source = (await this.resolver.resolve(from)) as Resolved;
    if (source.kind !== "container" && source.kind !== "body") {
      throw new VfsError("EROFS", `${from} is a generated view and cannot be copied`, {
        path: from,
      });
    }
    assertWritable(this.guard, "copy", to);

    const target = splitParent(normalizePath(to));
    const destination = await this.resolver.resolve(target.parent);
    const { spaceKey, parentNode } = await this.containerOf(destination as Resolved, to);
    const parsed = parseName(target.name);
    const newTitle = titleFromName(parsed.idCandidate ? parsed.slugCandidate : parsed.stem);

    try {
      const copied = await this.opts.client.copyPage({
        sourceId: source.node.id,
        targetSpaceKey: spaceKey,
        newTitle,
        parentId: parentNode.id,
      });
      this.index.attachChild(parentNode.id, {
        id: copied.id,
        title: copied.title,
        type: "page",
        spaceKey,
        version: copied.version ?? 1,
      });
      this.audit?.record({ op: "copy", path: from, target: to, pageId: copied.id, result: "ok" });
      return { path: to, pageId: copied.id, version: copied.version ?? 1, created: true };
    } catch (error) {
      const mapped = mapClientError(error, from);
      this.audit?.record({
        op: "copy",
        path: from,
        target: to,
        result: "error",
        errorCode: mapped.code,
      });
      throw mapped;
    }
  }

  /**
   * Symlink targets.
   *
   * `.by-id/<id>.md` points at the page's canonical path. The view directories
   * point back through `.by-id/`, which always resolves and needs no ancestor
   * walk — so a page keeps exactly one home in the tree however many labels,
   * searches or recency windows list it.
   */
  async readlink(path: string): Promise<string> {
    const resolved = (await this.resolver.resolve(path)) as Resolved;
    switch (resolved.kind) {
      case "by-id-link": {
        const canonical = await this.requireVirtual().canonicalPath(
          resolved.id,
          resolved.spaceKey,
          path,
        );
        return `${canonical}/${INDEX_FILE}`;
      }
      case "label-link":
      case "recent-link":
      case "search-link": {
        const id = parseName(resolved.name).idCandidate;
        if (!id) throw new VfsError("ENOENT", `No such link: ${path}`, { path });
        return `/${resolved.spaceKey}/.by-id/${id}.md`;
      }
      default:
        throw new VfsError("EINVAL", `Not a symlink: ${path}`, { path });
    }
  }

  // -------------------------------------------------------------- plumbing

  private toNode(resolved: Resolved, path: string): VfsNode {
    const stat = this.statOf(resolved);
    const node = "node" in resolved ? resolved.node : undefined;
    const { name } = path === "/" ? { name: "/" } : splitParent(normalizePath(path));
    return {
      kind: stat.kind,
      id: stat.id,
      title: node?.title ?? name,
      slug: node ? formatDirName(node.title, node.id) : name,
      ...(node?.version !== undefined ? { version: node.version } : {}),
      ...(node?.parentId ? { parentId: node.parentId } : {}),
      ...(node?.spaceKey ? { spaceKey: node.spaceKey } : {}),
      mtime: stat.mtime,
      ...(stat.sizeEstimated ? {} : { size: stat.size }),
      ...(stat.mode === RO_FILE_MODE ? { readOnly: true } : {}),
    };
  }
}

function mtimeOf(node: TreeNode, fallback: Date): Date {
  const parsed = node.lastModified ? Date.parse(node.lastModified) : Number.NaN;
  return Number.isNaN(parsed) ? fallback : new Date(parsed);
}

function direntFor(node: TreeNode): VfsDirent {
  if (isContainer(node)) {
    return {
      name: formatDirName(node.title, node.id),
      kind: node.type === "folder" ? "folder" : "page",
      isDirectory: true,
      isFile: false,
      isSymbolicLink: false,
    };
  }
  // Whiteboards, databases and embeds: a read-only JSON stub carrying a link.
  return {
    name: `${formatDirName(node.title, node.id)}.${node.type}.json`,
    kind: "virtual-file",
    isDirectory: false,
    isFile: true,
    isSymbolicLink: false,
  };
}

function virtualDirEntry(name: string): VfsDirent {
  return { name, kind: "virtual-dir", isDirectory: true, isFile: false, isSymbolicLink: false };
}

function virtualFileEntry(name: string): VfsDirent {
  return { name, kind: "virtual-file", isDirectory: false, isFile: true, isSymbolicLink: false };
}

/** Guard used by the write path: a page may never shadow a name the VFS owns. */
export function assertNotReserved(name: string, path: string): void {
  if (RESERVED_NAMES.has(name)) {
    throw new VfsError("EEXIST", `${name} is reserved by the filesystem`, { path });
  }
}
