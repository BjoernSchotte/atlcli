/**
 * Writing pages back (WP5.1–5.3, 5.9).
 *
 * ## The version dance
 *
 * Confluence's update endpoint takes `version.number` and demands exactly
 * `current + 1`. So every write is a compare-and-swap whose comparand is the
 * version the *reader* saw. Two things can go wrong, and both are the same
 * thing seen at different moments:
 *
 *  - The frontmatter's version is already behind what the index knows. Caught
 *    before the request.
 *  - The server moved between our check and our `PUT`. Caught as a 409.
 *
 * Both take the same route: refetch, three-way merge against the base we
 * cached, and retry when the merge is clean. Only a merge with real conflicts
 * fails — and it fails *loudly*, with the work preserved on disk (WP5.2), never
 * by discarding the edit and never by overwriting the other person's.
 *
 * ## Coalescing
 *
 * WebDAV clients and editors write a file in several chunks: `LOCK`, a partial
 * `PUT`, another `PUT`, `UNLOCK`. Treating each as a page update would burn a
 * version per keystroke-flush and make conflicts out of one person's own
 * typing. So writes to the same path inside a short window are merged into one
 * update, and `flush()` at the end of a session drains whatever is pending.
 */
import { threeWayMerge } from "@atlcli/confluence/internal";
import type { VfsClient } from "./client-port.js";
import { AuditLog } from "./audit-log.js";
import { BodyCache, hashStorage } from "./body-cache.js";
import { ConflictStore } from "./conflict-store.js";
import { mapClientError, withRateLimitRetry } from "./errors.js";
import { assertWritable, type ModeGuard } from "./mode.js";
import type { VfsLogger } from "./options.js";
import { parseVfsFrontmatter, renderPageMarkdown, toStorage } from "./page-store.js";
import { titleFromName } from "./path-mapper.js";
import type { TreeIndex, TreeNode } from "./tree-index.js";
import { VfsError } from "./types.js";
import type { VfsWriteResult } from "./vfs.js";

export interface WriteBackOptions {
  client: VfsClient;
  index: TreeIndex;
  cache: BodyCache;
  conflicts: ConflictStore;
  audit: AuditLog;
  guard: ModeGuard;
  instanceUrl: string;
  logger: VfsLogger;
  now: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Milliseconds of quiet before a coalesced write is sent. 0 disables it. */
  coalesceMs: number;
  /** Schedules the coalesced flush; injectable so tests need no real timer. */
  schedule?: (fn: () => void, ms: number) => void;
}

interface PendingWrite {
  path: string;
  node: TreeNode;
  content: string;
  resolve: (result: VfsWriteResult) => void;
  reject: (error: unknown) => void;
  waiters: { resolve: (result: VfsWriteResult) => void; reject: (error: unknown) => void }[];
  scheduled: boolean;
  dueAt: number;
}

export class WriteBack {
  private readonly pending = new Map<string, PendingWrite>();
  private readonly running = new Map<string, Promise<void>>();
  /** Pages already warned about, so one session does not repeat itself. */
  private readonly warnedLossy = new Set<string>();

  constructor(private readonly opts: WriteBackOptions) {}

  /**
   * Update an existing page.
   *
   * With coalescing on, this resolves when the *batched* write lands, so a
   * caller still learns the resulting version — it just may be shared with the
   * writes that arrived alongside it.
   */
  async updatePage(node: TreeNode, path: string, content: string): Promise<VfsWriteResult> {
    assertWritable(this.opts.guard, "update", path);
    if (this.opts.coalesceMs <= 0) {
      const previous = this.running.get(node.id) ?? Promise.resolve();
      const result = previous.then(() => this.performUpdate(this.opts.index.node(node.id) ?? node, path, content));
      const finished = result.then(() => {}, () => {}).finally(() => {
        if (this.running.get(node.id) === finished) this.running.delete(node.id);
      });
      this.running.set(node.id, finished);
      return result;
    }
    return new Promise<VfsWriteResult>((resolve, reject) => {
      // Aliases of one page share the same publication queue.
      const existing = this.pending.get(node.id);
      if (existing) {
        // Later content wins; earlier waiters still get the result.
        existing.content = content;
        existing.dueAt = this.opts.now() + this.opts.coalesceMs;
        existing.waiters.push({ resolve, reject });
        return;
      }
      const entry: PendingWrite = {
        path,
        node,
        content,
        resolve,
        reject,
        waiters: [],
        scheduled: false,
        dueAt: this.opts.now() + this.opts.coalesceMs,
      };
      this.pending.set(node.id, entry);
      this.schedule(entry);
    });
  }

  private schedule(entry: PendingWrite): void {
    if (entry.scheduled) return;
    entry.scheduled = true;
    const schedule = this.opts.schedule ?? ((fn, ms) => void setTimeout(fn, ms).unref?.());
    schedule(() => {
      entry.scheduled = false;
      if (this.pending.get(entry.node.id) === entry) void this.drain(entry.node.id);
    }, Math.max(0, entry.dueAt - this.opts.now()));
  }

  /** Sends every pending coalesced write. Called at the end of a session. */
  async flush(): Promise<void> {
    while (this.pending.size || this.running.size) {
      await Promise.all([...new Set([...this.pending.keys(), ...this.running.keys()])]
        .map(id => this.drain(id, true)));
    }
  }

  get pendingCount(): number {
    return new Set([...this.pending.keys(), ...this.running.keys()]).size;
  }

  private drain(id: string, force = false): Promise<void> {
    const running = this.running.get(id);
    if (running) return running.then(() => this.drain(id, force));
    const entry = this.pending.get(id);
    if (!entry) return Promise.resolve();
    if (!force && entry.dueAt > this.opts.now()) {
      this.schedule(entry);
      return Promise.resolve();
    }
    this.pending.delete(id);
    const node = this.opts.index.node(id) ?? entry.node;
    const task = this.performUpdate(node, entry.path, entry.content).then(result => {
      entry.resolve(result);
      for (const waiter of entry.waiters) waiter.resolve(result);
    }, error => {
      entry.reject(error);
      for (const waiter of entry.waiters) waiter.reject(error);
    }).finally(() => { this.running.delete(id); });
    this.running.set(id, task);
    return task;
  }

  // ------------------------------------------------------------- the update

  private async performUpdate(
    node: TreeNode,
    path: string,
    content: string,
  ): Promise<VfsWriteResult> {
    const { frontmatter, body } = parseVfsFrontmatter(content);
    const title = frontmatter.title?.trim() || node.title;
    const basedOn = frontmatter.version ?? node.version;

    this.warnIfLossy(node, path, basedOn);

    try {
      const result = await this.attemptUpdate(node, path, body, title, basedOn);
      this.opts.audit.record({
        op: "update",
        path,
        pageId: node.id,
        fromVersion: basedOn,
        toVersion: result.version,
        result: "ok",
      });
      return result;
    } catch (error) {
      this.opts.audit.record({
        op: "update",
        path,
        pageId: node.id,
        fromVersion: basedOn,
        result: "error",
        errorCode: error instanceof VfsError ? error.code : "EINVAL",
      });
      throw error;
    }
  }

  /**
   * Warn when this page does not survive the Markdown round trip (WP5.11).
   *
   * The check is a property of the *page*, not of the edit: take the Markdown
   * the reader was served, convert it straight back to storage, and compare
   * against the storage hash recorded when it was fetched. A difference means
   * the page holds something Markdown cannot express — a macro without an
   * equivalent, an unusual layout — and saving it will drop that.
   *
   * Saying so is the point. Silently flattening a macro is the failure this
   * whole plan keeps refusing: the write appears to succeed and the loss is
   * discovered weeks later by whoever relied on the macro.
   */
  private warnIfLossy(node: TreeNode, path: string, basedOn: number | undefined): void {
    if (basedOn === undefined || this.warnedLossy.has(node.id)) return;
    const served = this.opts.cache.getBody(node.id, basedOn);
    if (!served) return;
    const reconverted = hashStorage(toStorage(parseVfsFrontmatter(served.markdown).body));
    if (reconverted === served.storageHash) return;
    this.warnedLossy.add(node.id);
    this.opts.logger.warn(
      `${path}: this page does not round-trip through Markdown. Saving it will drop whatever ` +
        `the converter cannot express (typically a macro without a Markdown equivalent). ` +
        `Check the page in Confluence after saving.`,
      { pageId: node.id, version: basedOn },
    );
  }

  private async attemptUpdate(
    node: TreeNode,
    path: string,
    body: string,
    title: string,
    basedOn: number | undefined,
  ): Promise<VfsWriteResult> {
    const serverVersion = node.version;
    const stale = basedOn !== undefined && serverVersion !== undefined && basedOn < serverVersion;

    if (stale) {
      return this.mergeAndRetry(node, path, body, title, basedOn, serverVersion!);
    }

    // Repeated editor PUTs of the same saved image need no new wiki version.
    // Compare storage as well as title: Markdown equality can hide lossy macros.
    const storage = toStorage(body);
    if (serverVersion !== undefined && title === node.title &&
        this.opts.cache.getBody(node.id, serverVersion)?.storageHash === hashStorage(storage)) {
      return { path, pageId: node.id, version: serverVersion, created: false };
    }

    const nextVersion = (serverVersion ?? basedOn ?? 0) + 1;
    try {
      const updated = await this.request(
        () =>
          this.opts.client.updatePage({
            id: node.id,
            title,
            storage,
            version: nextVersion,
          }),
        path,
      );
      return this.commit(node, path, body, title, updated.version ?? nextVersion);
    } catch (error) {
      if (!(error instanceof VfsError) || error.code !== "EBUSY") throw error;
      // The server moved underneath us between the check and the PUT.
      const fresh = await this.refetch(node, path);
      return this.mergeAndRetry(node, path, body, title, basedOn ?? serverVersion, fresh.version);
    }
  }

  /**
   * Refetch, merge, retry once.
   *
   * The merge base is the cached body at the version the edit was based on.
   * Without it there is no three-way merge to do, and guessing would mean
   * silently choosing a winner — so a missing base is a conflict, not a
   * coin toss.
   */
  private async mergeAndRetry(
    node: TreeNode,
    path: string,
    body: string,
    title: string,
    basedOn: number | undefined,
    serverVersion: number,
  ): Promise<VfsWriteResult> {
    const fresh = await this.refetch(node, path);
    // A successful PUT can lose its reply; the client's retry then gets 409.
    // Compare storage, not lossy Markdown, before creating another version.
    if (fresh.title === title && fresh.storage.trim() === toStorage(body).trim()) {
      return { path, pageId: node.id, version: fresh.version, created: false };
    }
    const base =
      basedOn !== undefined ? this.opts.cache.getBody(node.id, basedOn)?.markdown : undefined;
    const theirs = parseVfsFrontmatter(fresh.markdown).body;

    if (base === undefined) {
      throw this.conflict(node, path, body, theirs, basedOn ?? 0, serverVersion, {
        reason: "the version this edit was based on is no longer in the cache",
      });
    }

    const merged = threeWayMerge(parseVfsFrontmatter(base).body, body, theirs);
    if (!merged.success) {
      throw this.conflict(node, path, merged.content, theirs, basedOn ?? 0, fresh.version, {
        reason: `${merged.conflictCount} conflicting region(s)`,
      });
    }

    const updated = await this.request(
      () =>
        this.opts.client.updatePage({
          id: node.id,
          title,
          storage: toStorage(merged.content),
          version: fresh.version + 1,
        }),
      path,
    );
    return this.commit(node, path, merged.content, title, updated.version ?? fresh.version + 1);
  }

  private conflict(
    node: TreeNode,
    path: string,
    content: string,
    theirs: string,
    baseVersion: number,
    serverVersion: number,
    context: { reason: string },
  ): VfsError {
    const record = this.opts.conflicts.record({
      pageId: node.id,
      path,
      baseVersion,
      serverVersion,
      createdAt: new Date(this.opts.now()).toISOString(),
      origin: "wiki-vfs",
      content,
    });
    this.opts.audit.record({
      op: "conflict",
      path,
      pageId: node.id,
      fromVersion: baseVersion,
      toVersion: serverVersion,
      result: "error",
      errorCode: "EBUSY",
    });
    void theirs;
    return new VfsError(
      "EBUSY",
      `${path} changed on the server (version ${serverVersion}) and the merge did not apply: ${context.reason}. ` +
        `Your version is kept at ${record.file}; see 'atlcli wiki vfs conflicts'`,
      { path },
    );
  }

  private async refetch(
    node: TreeNode,
    path: string,
  ): Promise<{ version: number; markdown: string; title: string; storage: string }> {
    const page = await this.request(() => this.opts.client.getPage(node.id), path);
    const version = page.version ?? 1;
    const refreshed = this.opts.index.upsert({
      id: node.id,
      title: page.title,
      version,
      parentId: page.parentId ?? node.parentId,
    });
    const markdown = renderPageMarkdown(refreshed, page.storage, this.opts.instanceUrl);
    this.opts.cache.putBody({
      pageId: node.id,
      version,
      markdown,
      storageHash: hashStorage(page.storage),
    });
    return { version, markdown, title: page.title, storage: page.storage };
  }

  /** Updates the index and the cache so the next read is a hit, not a fetch. */
  private commit(
    node: TreeNode,
    path: string,
    body: string,
    title: string,
    version: number,
  ): VfsWriteResult {
    const refreshed = this.opts.index.upsert({
      id: node.id,
      title,
      version,
      lastModified: new Date(this.opts.now()).toISOString(),
    });
    // Cache what a reader would get back, which is the storage round-tripped
    // rather than the Markdown as written: that is what the next read compares
    // against, and pretending otherwise would hide a lossy conversion until
    // much later.
    const storage = toStorage(body);
    this.opts.cache.putBody({
      pageId: node.id,
      version,
      markdown: renderPageMarkdown(refreshed, storage, this.opts.instanceUrl),
      storageHash: hashStorage(storage),
    });
    return { path, pageId: node.id, version, created: false };
  }

  // ------------------------------------------------------------ new pages

  /**
   * Create a page from a write to a name that does not exist (WP5.3).
   *
   * The title comes from frontmatter when the writer supplied one, otherwise
   * from the file name. After the `POST` the file's canonical name carries the
   * new id, and the caller is told so — the name it used stays an alias for the
   * session, because a script that wrote `new-page.md` will read it back by
   * that name.
   */
  async createPage(params: {
    parent: TreeNode;
    spaceKey: string;
    name: string;
    path: string;
    content: string;
    parentIsFolder: boolean;
    creationToken?: string;
  }): Promise<VfsWriteResult> {
    assertWritable(this.opts.guard, "create", params.path);
    const { frontmatter, body } = parseVfsFrontmatter(params.content);
    const title = frontmatter.title?.trim() || titleFromName(params.name);

    try {
      const created = await this.request(
        () =>
          this.opts.client.createPage({
            spaceKey: params.spaceKey,
            title,
            storage: toStorage(body),
            parentId: params.parent.id,
            ...(params.creationToken ? { properties: { "atlcli-vfs-creation": { token: params.creationToken } } } : {}),
          }),
        params.path,
      );
      // A page created under a folder has to be moved there explicitly: the
      // create endpoint takes a page parent, not a folder.
      if (params.parentIsFolder) {
        await this.request(
          () => this.opts.client.movePageToFolder(created.id, params.parent.id),
          params.path,
        );
      }
      const node = this.opts.index.attachChild(params.parent.id, {
        id: created.id,
        title,
        type: "page",
        spaceKey: params.spaceKey,
        version: created.version ?? 1,
        lastModified: new Date(this.opts.now()).toISOString(),
      });
      const storage = toStorage(body);
      this.opts.cache.putBody({
        pageId: created.id,
        version: node.version ?? 1,
        markdown: renderPageMarkdown(node, storage, this.opts.instanceUrl),
        storageHash: hashStorage(storage),
      });
      this.opts.audit.record({
        op: "create",
        path: params.path,
        pageId: created.id,
        toVersion: node.version,
        result: "ok",
      });
      return { path: params.path, pageId: created.id, version: node.version ?? 1, created: true };
    } catch (error) {
      const mapped = mapClientError(error, params.path);
      this.opts.audit.record({
        op: "create",
        path: params.path,
        result: "error",
        errorCode: mapped.code,
      });
      // Confluence enforces one title per space and reports the clash as a
      // 400. As a filesystem that is EEXIST, which is what a caller can act on.
      // The original message lives on the cause, since `request` already mapped it.
      const original = mapped.cause instanceof Error ? mapped.cause.message : String(mapped.cause);
      if (mapped.status === 400 && /already exists/i.test(original)) {
        throw new VfsError(
          "EEXIST",
          `A page titled "${title}" already exists in ${params.spaceKey}`,
          { path: params.path },
        );
      }
      throw mapped;
    }
  }

  private async request<T>(task: () => Promise<T>, path?: string): Promise<T> {
    try {
      return await withRateLimitRetry(task, {
        ...(this.opts.sleep ? { sleep: this.opts.sleep } : {}),
        onWait: (waitMs) =>
          this.opts.logger.warn("confluence rate limit, waiting", { waitMs, path }),
      });
    } catch (error) {
      throw mapClientError(error, path);
    }
  }
}
