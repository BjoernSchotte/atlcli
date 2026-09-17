/**
 * The partial, demand-driven page tree (WP2.3–2.6).
 *
 * This module is where the demand principle (plan section 1b) lives or dies.
 * Two rules it must never break:
 *
 *  1. **One directory, one request.** `loadChildren(id)` fetches exactly that
 *     level. A branch nobody entered is never fetched — not on a listing, not
 *     on a revalidation, not as a "while we're here" optimisation.
 *  2. **No bodies, ever.** Nothing in this file calls `getPage`. The index
 *     carries titles, versions, parents and positions; bodies belong to the
 *     body cache and only a real read creates one.
 *
 * `children` is `"unloaded"` until someone asks, which is what makes rule 1
 * checkable: a node that was never entered still reads `"unloaded"` afterwards,
 * and `tree-index.test.ts` asserts exactly that.
 *
 * ## Why level-by-level rather than one `descendants` pass
 *
 * The plan's first draft loaded a whole space at depth ten on the first
 * listing, and section 12 already records that as a correction. The client
 * settles it anyway: `getPageDescendants` fixes its depth at exactly 1 and
 * throws otherwise, so a "whole subtree in one request" call does not exist.
 * A recursive walk costs one request per *visited* directory, which is the
 * price the demand principle is willing to pay.
 */
import type { ConfluenceSpace, FolderChild } from "@atlcli/confluence";
import { createInOrderLimiter } from "@atlcli/confluence";
import type { VfsClient } from "./client-port.js";
import { mapClientError, withRateLimitRetry } from "./errors.js";
import type { VfsLogger } from "./options.js";
import { VfsError } from "./types.js";

/** Content types the VFS renders as pages with bodies. */
export const BODY_TYPES = new Set(["page"]);

/** One node of the partial tree. */
export interface TreeNode {
  id: string;
  title: string;
  /** Raw Confluence type: `page`, `folder`, `whiteboard`, `database`, `embed`. */
  type: string;
  parentId: string | null;
  spaceKey: string;
  version: number | undefined;
  lastModified: string | undefined;
  position: number | null;
  /** Child IDs in `childPosition` order, or `"unloaded"` if nobody asked yet. */
  children: string[] | "unloaded";
  /** When `children` was filled, for the per-node TTL. */
  childrenLoadedAt: number | undefined;
  /** When this node's own metadata was last revalidated. */
  metaCheckedAt: number | undefined;
}

export interface TreeIndexOptions {
  client: VfsClient;
  /** Per-node TTL in milliseconds. */
  ttlMs: number;
  concurrency: number;
  offline: boolean;
  logger: VfsLogger;
  now: () => number;
  /** Injectable sleep for the rate-limit band. */
  sleep?: (ms: number) => Promise<void>;
  /** Restrict visible spaces; undefined means every space the user can see. */
  spaces?: string[] | undefined;
}

interface SpaceEntry {
  space: ConfluenceSpace;
  homepageId: string | null;
  homepageLoaded?: boolean;
  loadedAt: number;
  rootIds?: string[];
  rootsLoadedAt?: number;
}

function offlineMiss(what: string): VfsError {
  return new VfsError(
    "ENOENT",
    `${what} is not in the cache and --offline forbids a request. Retry without --offline`,
  );
}

export class TreeIndex {
  private readonly opts: TreeIndexOptions;
  private readonly nodes = new Map<string, TreeNode>();
  private readonly spaces = new Map<string, SpaceEntry>();
  private spaceListLoadedAt: number | undefined;
  private readonly limit: <T>(task: () => Promise<T>) => Promise<T>;
  /** De-duplicates concurrent loads of the same directory. */
  private readonly inFlight = new Map<string, Promise<TreeNode[]>>();

  constructor(options: TreeIndexOptions) {
    this.opts = options;
    this.limit = createInOrderLimiter(Math.max(1, options.concurrency));
  }

  // ------------------------------------------------------------------ state

  /** Does the index know this ID? The confirmation `resolveNameToId` needs. */
  knowsId(id: string): boolean {
    return this.nodes.has(id);
  }

  node(id: string): TreeNode | undefined {
    return this.nodes.get(id);
  }

  /** Every node currently loaded. Used by `getAllPaths` and the invariant tests. */
  loadedNodes(): TreeNode[] {
    return [...this.nodes.values()];
  }

  /** True when this directory has never been listed. The rule-1 assertion. */
  isUnloaded(id: string): boolean {
    return this.nodes.get(id)?.children === "unloaded";
  }

  /** Drops everything. The cache is disposable by design. */
  clear(): void {
    this.nodes.clear();
    this.spaces.clear();
    this.spaceListLoadedAt = undefined;
  }

  /** Seeds the index from a persisted snapshot so `--offline` can list. */
  hydrate(snapshot: { nodes: TreeNode[]; spaces: SpaceEntry[] }): void {
    for (const node of snapshot.nodes) this.nodes.set(node.id, node);
    for (const entry of snapshot.spaces) this.spaces.set(entry.space.key, entry);
  }

  snapshot(): { nodes: TreeNode[]; spaces: SpaceEntry[] } {
    return { nodes: this.loadedNodes(), spaces: [...this.spaces.values()] };
  }

  // ----------------------------------------------------------------- spaces

  async listSpaces(): Promise<ConfluenceSpace[]> {
    const fresh =
      this.spaceListLoadedAt !== undefined &&
      this.opts.now() - this.spaceListLoadedAt < this.opts.ttlMs;
    if (!fresh && !this.opts.offline) {
      const listed = await this.request(() => this.opts.client.listSpaces(250));
      this.spaceListLoadedAt = this.opts.now();
      for (const space of listed) {
        const existing = this.spaces.get(space.key);
        this.spaces.set(space.key, {
          ...existing,
          space,
          homepageId: existing?.homepageId ?? null,
          loadedAt: this.opts.now(),
        });
      }
    }
    const all = [...this.spaces.values()].map((entry) => entry.space);
    const allowed = this.opts.spaces;
    // The allow-list is a *visibility* filter over what Confluence already
    // returned, never a way to see more.
    return allowed === undefined
      ? all
      : all.filter((space) => allowed.includes(space.key));
  }

  /** Space metadata, TTL-cached. Throws `ENOENT` for a key the user cannot see. */
  async getSpace(key: string): Promise<ConfluenceSpace> {
    if (this.opts.spaces !== undefined && !this.opts.spaces.includes(key)) {
      throw new VfsError("ENOENT", `No such space: ${key}`, { path: `/${key}` });
    }
    const cached = this.spaces.get(key);
    if (cached && this.opts.now() - cached.loadedAt < this.opts.ttlMs) return cached.space;
    if (this.opts.offline) {
      if (cached) return cached.space;
      throw offlineMiss(`Space ${key}`);
    }
    const space = await this.request(() => this.opts.client.getSpace(key), `/${key}`);
    if (space.key !== key) {
      throw new VfsError("EINVAL", `Space key '${key}' resolves to '${space.key}'; use --space ${space.key}`, {
        path: `/${key}`,
      });
    }
    this.spaces.set(key, {
      ...cached,
      space,
      homepageId: cached?.homepageId ?? null,
      loadedAt: this.opts.now(),
    });
    return space;
  }

  /**
   * The page whose body is the space's `_index.md`.
   *
   * Cached separately from the space record because it is a second request and
   * almost every path into a space needs it.
   */
  async getHomepageId(key: string): Promise<string | null> {
    const cached = this.spaces.get(key);
    if (cached?.homepageLoaded || cached?.homepageId) return cached.homepageId;
    if (this.opts.offline) {
      if (cached) return cached.homepageId;
      throw offlineMiss(`Space ${key}`);
    }
    const space = await this.getSpace(key);
    const homepageId = await this.request(
      () => this.opts.client.getSpaceHomepageId(key),
      `/${key}`,
    );
    this.spaces.set(key, { ...this.spaces.get(key), space, homepageId, homepageLoaded: true, loadedAt: this.opts.now() });
    if (homepageId) {
      this.upsert({
        id: homepageId,
        title: space.name,
        type: "page",
        parentId: null,
        spaceKey: key,
        position: null,
      });
    }
    return homepageId;
  }

  // ------------------------------------------------------------- one level

  /** Cloud roots are a separate metadata-only level, beside homepage children. */
  async loadRootPages(key: string): Promise<TreeNode[]> {
    if (this.opts.client.deploymentType !== "cloud") return [];
    await this.getSpace(key);
    const entry = this.spaces.get(key)!;
    const cached = () => (entry.rootIds ?? []).map(id => this.nodes.get(id)).filter((node): node is TreeNode =>
      !!node && node.parentId === null && node.spaceKey === key && node.id !== entry.homepageId);
    if (this.opts.offline || (entry.rootsLoadedAt !== undefined && this.opts.now() - entry.rootsLoadedAt < this.opts.ttlMs)) return cached();
    const flight = `space:${key}`;
    const pending = this.inFlight.get(flight);
    if (pending) return pending;
    const task = this.request(() => this.opts.client.getSpaceRootPages(entry.space), `/${key}`).then(pages => {
      for (const page of pages) {
        if (page.spaceKey !== key || page.parentId != null) throw new VfsError("EINVAL", "Invalid space-root metadata");
      }
      const ids = pages.map(page => page.id);
      for (const id of entry.rootIds ?? []) {
        const node = this.nodes.get(id);
        if (!ids.includes(id) && node?.parentId === null && node.spaceKey === key && id !== entry.homepageId) this.forget(id);
      }
      for (const page of pages) this.upsert({ ...page, type: "page", parentId: null, spaceKey: key, metaCheckedAt: this.opts.now() });
      entry.rootIds = ids;
      entry.rootsLoadedAt = this.opts.now();
      return cached();
    }).finally(() => this.inFlight.delete(flight));
    this.inFlight.set(flight, task);
    return task;
  }

  /**
   * Load exactly one directory level.
   *
   * Returns cached children while the per-node TTL holds; concurrent callers
   * share one in-flight request, so `ls` in two shells is still one request.
   */
  async loadChildren(id: string, options: { force?: boolean } = {}): Promise<TreeNode[]> {
    const node = this.nodes.get(id);
    const fresh =
      !options.force &&
      node !== undefined &&
      node.children !== "unloaded" &&
      node.childrenLoadedAt !== undefined &&
      this.opts.now() - node.childrenLoadedAt < this.opts.ttlMs;
    if (fresh) return this.childNodes(node!);

    if (this.opts.offline) {
      if (node && node.children !== "unloaded") return this.childNodes(node);
      throw offlineMiss(`The children of ${id}`);
    }

    const pending = this.inFlight.get(id);
    if (pending) return pending;

    const task = this.fetchChildren(id).finally(() => this.inFlight.delete(id));
    this.inFlight.set(id, task);
    return task;
  }

  private async fetchChildren(id: string): Promise<TreeNode[]> {
    const parent = this.nodes.get(id);
    const spaceKey = parent?.spaceKey ?? "";
    const children =
      this.opts.client.deploymentType === "data-center"
        ? await this.fetchChildrenDataCenter(id, spaceKey)
        : await this.fetchChildrenCloud(id, spaceKey);

    const ids: string[] = [];
    for (const child of children) {
      this.upsert(child);
      ids.push(child.id);
    }
    // Children a previous listing knew about but this one does not: dropped,
    // so a page deleted on the server disappears from `ls` on the next listing.
    const previous = parent?.children;
    if (Array.isArray(previous)) {
      for (const goneId of previous) {
        if (!ids.includes(goneId)) this.forget(goneId);
      }
    }
    this.upsert({
      id,
      title: parent?.title ?? "",
      type: parent?.type ?? "page",
      parentId: parent?.parentId ?? null,
      spaceKey,
      version: parent?.version,
      lastModified: parent?.lastModified,
      position: parent?.position ?? null,
      children: ids,
      childrenLoadedAt: this.opts.now(),
    });
    return ids.map((childId) => this.nodes.get(childId)!);
  }

  private async fetchChildrenCloud(id: string, spaceKey: string): Promise<TreeNode[]> {
    const listed = await this.request(
      () => this.nodes.get(id)?.type === "folder"
        ? this.opts.client.getFolderChildren(id, { limit: 250 })
        : this.opts.client.getPageDirectChildren(id, { limit: 250 }),
      undefined,
    );
    return listed.filter(isListable).map((child) => this.fromFolderChild(child, id, spaceKey));
  }

  /**
   * Data Center has no v2 hierarchy endpoint, so children come from CQL
   * (`parent=<id> AND type=page`). That is pages only: folders, whiteboards
   * and databases do not exist on Data Center, so nothing is lost.
   */
  private async fetchChildrenDataCenter(id: string, spaceKey: string): Promise<TreeNode[]> {
    const listed = await this.request(
      () => this.opts.client.getChildren(id, { limit: 250 }),
      undefined,
    );
    return listed.map((child, index) => ({
      id: child.id,
      title: child.title,
      type: child.type ?? "page",
      parentId: id,
      spaceKey: child.spaceKey ?? spaceKey,
      version: child.version,
      lastModified: child.lastModified,
      position: index,
      children: "unloaded" as const,
      childrenLoadedAt: undefined,
      metaCheckedAt: this.opts.now(),
    }));
  }

  private fromFolderChild(child: FolderChild, parentId: string, spaceKey: string): TreeNode {
    const existing = this.nodes.get(child.id);
    return {
      id: child.id,
      title: child.title,
      type: child.type,
      parentId: child.parentId ?? parentId,
      spaceKey,
      version: existing?.version,
      lastModified: existing?.lastModified,
      position: child.position ?? null,
      children: existing?.children ?? "unloaded",
      childrenLoadedAt: existing?.childrenLoadedAt,
      // Cloud hierarchy listings carry no version, so cannot refresh its TTL.
      metaCheckedAt: existing?.metaCheckedAt,
    };
  }

  private childNodes(node: TreeNode): TreeNode[] {
    if (node.children === "unloaded") return [];
    return node.children
      .map((id) => this.nodes.get(id))
      .filter((child): child is TreeNode => child !== undefined);
  }

  // ------------------------------------------------------- recursive walks

  /**
   * Walk a subtree level by level, for `find`, `tree`, `ls -R` and recursive
   * `grep` (WP2.4).
   *
   * Never called from a plain `readdir`. `maxNodes` is a hard stop that keeps
   * an accidental `find /` from walking a whole site; hitting it is an error,
   * not a silent truncation, because a truncated `find` reads as "not there".
   */
  async loadSubtree(
    rootId: string,
    options: { maxDepth?: number; maxNodes?: number; shouldVisit?: (node: TreeNode) => boolean; force?: boolean } = {},
  ): Promise<TreeNode[]> {
    const maxDepth = options.maxDepth ?? Infinity;
    const maxNodes = options.maxNodes ?? 5000;
    const collected: TreeNode[] = [];
    const root = this.nodes.get(rootId);
    if (root && options.shouldVisit?.(root) === false) return [];
    const visited = new Set([rootId]);
    let frontier = [rootId];

    for (let depth = 0; depth < maxDepth && frontier.length > 0; depth++) {
      const levels = await Promise.all(
        frontier.map((id) => this.limit(() => this.loadChildren(id, { force: options.force ?? false }))),
      );
      const next: string[] = [];
      for (const level of levels) {
        for (const child of level) {
          if (visited.has(child.id) || options.shouldVisit?.(child) === false) continue;
          visited.add(child.id);
          collected.push(child);
          if (collected.length > maxNodes) {
            throw new VfsError(
              "EINVAL",
              `Refusing to walk more than ${maxNodes} nodes below ${rootId}. Narrow the path, or raise the limit deliberately`,
            );
          }
          // Only containers are worth another request.
          if (child.type === "page" || child.type === "folder") next.push(child.id);
        }
      }
      frontier = next;
    }
    await this.revalidatePages([rootId, ...collected.map((node) => node.id)]);
    return collected.map((node) => this.nodes.get(node.id)!);
  }

  /** Refresh only requested stale page versions; hierarchy listings carry no Cloud versions. */
  async revalidatePages(ids: readonly string[]): Promise<void> {
    const stale = [...new Set(ids)].map((id) => this.nodes.get(id)).filter((node): node is TreeNode =>
      node !== undefined && node.type === "page" && node.version !== undefined &&
      (node.metaCheckedAt === undefined || this.opts.now() - node.metaCheckedAt >= this.opts.ttlMs),
    );
    if (!this.opts.offline && stale.length > 0) {
      if (this.opts.client.deploymentType === "cloud") {
        const versions = await this.request(() => this.opts.client.getPageVersions(stale.map((node) => node.id)));
        for (const node of stale) {
          const info = versions.get(node.id);
          if (!info) throw new VfsError("ENOENT", `Page ${node.id} disappeared while refreshing search metadata; retry the search`);
          Object.assign(node, { version: info.version, title: info.title, lastModified: info.lastModified, metaCheckedAt: this.opts.now() });
        }
      } else {
        // DC has no body-free version endpoint. Fetch stale requested bodies.
        for (const node of stale) {
          node.version = undefined;
          node.metaCheckedAt = this.opts.now();
        }
      }
    }
  }

  // -------------------------------------------------------- revalidation

  /**
   * Refresh the metadata of one directory's already-loaded children (WP2.5).
   *
   * Body-free: one `getPageVersions` probe over the IDs *this* directory holds.
   * A branch nobody entered contributes no IDs and therefore costs nothing,
   * which is the property `tree-index.test.ts` pins.
   */
  async revalidate(id: string): Promise<void> {
    if (this.opts.offline) return;
    const node = this.nodes.get(id);
    if (!node || node.children === "unloaded") return;
    if (
      node.childrenLoadedAt !== undefined &&
      this.opts.now() - node.childrenLoadedAt < this.opts.ttlMs
    ) {
      return;
    }

    const ids = node.children;
    // Data Center has no bulk version endpoint — `getPageVersions` is Cloud v2
    // only and throws a TypeError anywhere else. Its v1 children listing
    // already carries `version` and `lastModified`, so one forced re-listing
    // does the whole job there, and costs one request rather than two.
    if (this.opts.client.deploymentType !== "cloud") {
      await this.loadChildren(id, { force: true });
      return;
    }
    if (ids.length > 0) {
      const versions = await this.request(() => this.opts.client.getPageVersions(ids));
      for (const childId of ids) {
        const info = versions.get(childId);
        const child = this.nodes.get(childId);
        if (!child) continue;
        if (!info) {
          // Gone from the server: deleted, trashed, moved away, or now hidden.
          this.forget(childId);
          continue;
        }
        child.version = info.version;
        child.lastModified = info.lastModified;
        child.title = info.title;
        child.metaCheckedAt = this.opts.now();
      }
    }
    // A structural change (a new child, a move into this directory) is only
    // visible through a fresh listing, so take one and reset the TTL.
    await this.loadChildren(id, { force: true });
  }

  /** True when this directory's listing has aged past the TTL. */
  isStale(id: string): boolean {
    const node = this.nodes.get(id);
    if (!node || node.children === "unloaded" || node.childrenLoadedAt === undefined) return true;
    return this.opts.now() - node.childrenLoadedAt >= this.opts.ttlMs;
  }

  // ------------------------------------------------------------- mutation

  /** Records or merges a node. The one write path into `nodes`. */
  upsert(partial: Partial<TreeNode> & { id: string }): TreeNode {
    const existing = this.nodes.get(partial.id);
    const merged: TreeNode = {
      id: partial.id,
      title: partial.title ?? existing?.title ?? "",
      type: partial.type ?? existing?.type ?? "page",
      parentId: partial.parentId !== undefined ? partial.parentId : (existing?.parentId ?? null),
      spaceKey: partial.spaceKey || existing?.spaceKey || "",
      version: partial.version ?? existing?.version,
      lastModified: partial.lastModified ?? existing?.lastModified,
      position: partial.position !== undefined ? partial.position : (existing?.position ?? null),
      children: partial.children ?? existing?.children ?? "unloaded",
      childrenLoadedAt: partial.childrenLoadedAt ?? existing?.childrenLoadedAt,
      metaCheckedAt: partial.metaCheckedAt ?? existing?.metaCheckedAt ?? this.opts.now(),
    };
    if (existing?.parentId && existing.parentId !== merged.parentId) {
      const previousParent = this.nodes.get(existing.parentId);
      if (previousParent && Array.isArray(previousParent.children)) {
        previousParent.children = previousParent.children.filter((id) => id !== merged.id);
      }
    }
    this.nodes.set(merged.id, merged);
    return merged;
  }

  /** Removes a node and everything under it. Used after a delete or a move. */
  forget(id: string): void {
    const node = this.nodes.get(id);
    if (!node) return;
    if (Array.isArray(node.children)) {
      for (const childId of node.children) this.forget(childId);
    }
    this.nodes.delete(id);
    const parent = node.parentId ? this.nodes.get(node.parentId) : undefined;
    if (parent && Array.isArray(parent.children)) {
      parent.children = parent.children.filter((childId) => childId !== id);
    }
  }

  /** Attaches a newly created page so the next listing shows it without a fetch. */
  attachChild(parentId: string, child: Partial<TreeNode> & { id: string }): TreeNode {
    const node = this.upsert({ ...child, parentId });
    const parent = this.nodes.get(parentId);
    if (parent && Array.isArray(parent.children) && !parent.children.includes(child.id)) {
      parent.children.push(child.id);
    }
    return node;
  }

  // ------------------------------------------------------------- plumbing

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

/**
 * Drafts and archived pages appear in hierarchy listings but 404 on a direct
 * read, so they are dropped here rather than becoming broken files.
 */
function isListable(child: FolderChild): boolean {
  return child.status === undefined || child.status === "current";
}
