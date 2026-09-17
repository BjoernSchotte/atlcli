/**
 * Bodies: fetch, convert, cache, prefetch (WP3.3–3.5).
 *
 * This is the only module that turns a page into text, and the only one that
 * is *allowed* to create a cache entry. `ls`, `stat` and `PROPFIND` never
 * reach it — that is rule 2 of the demand principle, and keeping the code in
 * one file is what makes the rule auditable.
 *
 * ## Frontmatter
 *
 * The repository's existing block — a nested `atlcli:` mapping carrying `id`,
 * `title` and `type` — is what `docs pull` writes and what `parseFrontmatter`
 * reads, and section 7 of the plan matches it. The VFS emits the same block
 * with its extra fields appended, so a file keeps its meaning if it is moved
 * between a `docs pull` directory and the VFS. `parseFrontmatter` ignores keys
 * it does not know, so the addition is backwards compatible in both
 * directions, which `page-store.test.ts` pins.
 */
import { markdownToStorage, storageToMarkdown } from "@atlcli/confluence/internal";
import { AsyncLocalStorage } from "node:async_hooks";
import { createInOrderLimiter } from "@atlcli/confluence";
import type { VfsClient } from "./client-port.js";
import { BodyCache, hashStorage } from "./body-cache.js";
import { mapClientError, withRateLimitRetry } from "./errors.js";
import type { VfsLogger } from "./options.js";
import type { TreeIndex, TreeNode } from "./tree-index.js";
import { VfsError } from "./types.js";

/** The VFS fields that ride alongside the repository's flat frontmatter. */
export interface VfsFrontmatter {
  id: string;
  title: string;
  version?: number;
  parentId?: string;
  labels?: string[];
  lastModified?: string;
  url?: string;
}

export interface PageStoreOptions {
  client: VfsClient;
  cache: BodyCache;
  index: TreeIndex;
  instanceUrl: string;
  offline: boolean;
  concurrency: number;
  /** Hard ceiling for one prefetch call (demand principle, rule 3). */
  prefetchMaxPages: number;
  logger: VfsLogger;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * The `atlcli:` frontmatter block, in the repository's existing shape.
 *
 * Values are emitted as JSON scalars, which are valid YAML double-quoted
 * scalars and therefore safe for a title containing a colon, a quote or a
 * leading `#` — the shapes that break a naive serializer.
 */
export function renderFrontmatter(frontmatter: VfsFrontmatter): string {
  const lines = ["---", "atlcli:"];
  lines.push(`  id: ${JSON.stringify(frontmatter.id)}`);
  lines.push(`  title: ${JSON.stringify(frontmatter.title)}`);
  if (frontmatter.version !== undefined) lines.push(`  version: ${frontmatter.version}`);
  if (frontmatter.parentId) lines.push(`  parentId: ${JSON.stringify(frontmatter.parentId)}`);
  if (frontmatter.labels && frontmatter.labels.length > 0) {
    lines.push(`  labels: [${frontmatter.labels.map((l) => JSON.stringify(l)).join(", ")}]`);
  }
  if (frontmatter.lastModified) {
    lines.push(`  lastModified: ${JSON.stringify(frontmatter.lastModified)}`);
  }
  if (frontmatter.url) lines.push(`  url: ${JSON.stringify(frontmatter.url)}`);
  lines.push("---", "");
  return lines.join("\n");
}

/**
 * Reads back what {@link renderFrontmatter} wrote, plus the fields the rest of
 * the repository writes.
 *
 * Deliberately line-based rather than a YAML parse: the write path has to cope
 * with whatever an editor or a `sed` left behind, and a strict parser would
 * turn a stray indent into a failed save.
 */
export function parseVfsFrontmatter(markdown: string): {
  frontmatter: Partial<VfsFrontmatter>;
  body: string;
} {
  const match = /^---\n([\s\S]*?)\n---\n?/.exec(markdown);
  if (!match) return { frontmatter: {}, body: markdown };
  const frontmatter: Partial<VfsFrontmatter> = {};
  for (const line of match[1]!.split("\n")) {
    const pair = /^\s+([A-Za-z]+):\s*(.*)$/.exec(line);
    if (!pair) continue;
    const [, key, rawValue] = pair;
    const value = unquote(rawValue!.trim());
    switch (key) {
      case "id":
        frontmatter.id = value;
        break;
      case "title":
        frontmatter.title = value;
        break;
      case "version": {
        const parsed = Number(value);
        if (Number.isInteger(parsed) && parsed > 0) frontmatter.version = parsed;
        break;
      }
      case "parentId":
        frontmatter.parentId = value;
        break;
      case "lastModified":
        frontmatter.lastModified = value;
        break;
      case "url":
        frontmatter.url = value;
        break;
      case "labels":
        frontmatter.labels = value
          .replace(/^\[|\]$/g, "")
          .split(",")
          .map((entry) => unquote(entry.trim()))
          .filter(Boolean);
        break;
      default:
        break;
    }
  }
  return { frontmatter, body: markdown.slice(match[0].length) };
}

function unquote(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    try {
      return JSON.parse(value.replace(/^'|'$/g, '"')) as string;
    } catch {
      return value.slice(1, -1);
    }
  }
  return value;
}

/** Markdown plus the frontmatter header, exactly as a reader sees it. */
export function renderPageMarkdown(
  node: TreeNode,
  storage: string,
  instanceUrl: string,
  labels?: string[],
): string {
  const frontmatter: VfsFrontmatter = {
    id: node.id,
    title: node.title,
    ...(node.version !== undefined ? { version: node.version } : {}),
    ...(node.parentId ? { parentId: node.parentId } : {}),
    ...(labels && labels.length > 0 ? { labels } : {}),
    ...(node.lastModified ? { lastModified: node.lastModified } : {}),
    url: `${instanceUrl}/spaces/${node.spaceKey}/pages/${node.id}`,
  };
  return `${renderFrontmatter(frontmatter)}\n${storageToMarkdown(storage).trim()}\n`;
}

/** The inverse, for the write path. Frontmatter never reaches Confluence. */
export function toStorage(markdown: string): string {
  return markdownToStorage(markdown);
}

export class PageStore {
  private readonly bodyBudget = new AsyncLocalStorage<{ remaining: number }>();

  constructor(private readonly opts: PageStoreOptions) {}

  /** Bound all cold-body reads in one search, including refetches after eviction. */
  withBodyBudget<T>(budget: number, task: () => Promise<T>): Promise<T> {
    if (!Number.isSafeInteger(budget) || budget < 0) {
      return Promise.reject(new VfsError("EINVAL", "The page-body budget must be a non-negative integer"));
    }
    return this.bodyBudget.run({ remaining: budget }, task);
  }

  private reserveBodyDownloads(count: number, reserve = true): void {
    const budget = this.bodyBudget.getStore();
    if (!budget) return;
    if (count > budget.remaining) {
      throw new VfsError("EINVAL", `${count} cold page bodies required, but only ${budget.remaining} remain in this operation's prefetch limit. ` +
        "Narrow the path or raise --prefetch-max; increase vfs.cacheMaxMb if prefetched bodies were evicted");
    }
    if (reserve) budget.remaining -= count;
  }

  /**
   * Read one page's Markdown.
   *
   * A cache hit needs an exact version match, and the version comes from the
   * tree index. When the index has no version yet — the page was listed but
   * never read — the fetch is unconditional, which is correct: there is
   * nothing to match against.
   */
  async readBody(node: TreeNode, path: string): Promise<string> {
    // Direct reads may never revisit a directory listing. Reuse the bounded,
    // body-free metadata refresh before trusting an old cached version.
    await this.opts.index.revalidatePages([node.id]);
    node = this.opts.index.node(node.id) ?? node;
    if (node.version !== undefined) {
      const hit = this.opts.cache.getBody(node.id, node.version);
      if (hit) return hit.markdown;
    }
    if (this.opts.offline) {
      throw new VfsError(
        "ENOENT",
        `${path} is not in the cache and --offline forbids a request. Retry without --offline`,
        { path },
      );
    }

    this.reserveBodyDownloads(1);
    const page = await this.request(() => this.opts.client.getPage(node.id), path);
    const version = page.version ?? node.version ?? 1;
    // The read is also the cheapest revalidation we get: trust what came back.
    this.opts.index.upsert({
      id: node.id,
      title: page.title,
      version,
      ...(page.lastModified === undefined ? {} : { lastModified: page.lastModified }),
      parentId: page.parentId ?? node.parentId,
    });
    const refreshed = this.opts.index.node(node.id) ?? node;
    const markdown = renderPageMarkdown(refreshed, page.storage, this.opts.instanceUrl);
    this.opts.cache.putBody({
      pageId: node.id,
      version,
      markdown,
      storageHash: hashStorage(page.storage),
    });
    return markdown;
  }

  /** Reads one historic version. Immutable, so it is cached forever. */
  async readVersion(node: TreeNode, version: number, path: string): Promise<string> {
    const hit = this.opts.cache.getBody(node.id, version);
    if (hit) return hit.markdown;
    if (this.opts.offline) {
      throw new VfsError(
        "ENOENT",
        `Version ${version} of ${path} is not in the cache and --offline forbids a request`,
        { path },
      );
    }
    this.reserveBodyDownloads(1);
    const page = await this.request(
      () => this.opts.client.getPageAtVersion(node.id, version),
      path,
    );
    const markdown = renderPageMarkdown(
      { ...node, title: page.title, version, lastModified: page.lastModified },
      page.storage,
      this.opts.instanceUrl,
    );
    this.opts.cache.putBody({
      pageId: node.id,
      version,
      markdown,
      storageHash: hashStorage(page.storage),
    });
    return markdown;
  }

  /**
   * Fill the cache for many pages at once (WP3.4).
   *
   * **The budget is checked before anything is fetched.** Exceeding it aborts
   * with nothing downloaded rather than stopping halfway, because a partial
   * prefetch is indistinguishable from a complete one to the caller that asked
   * — and `grep` reading a partial cache reports a partial result, which is the
   * silent-wrong-answer failure mode this plan keeps refusing.
   */
  async prefetchBodies(
    ids: string[],
    options: { budget?: number; reason?: string } = {},
  ): Promise<{ fetched: number; fromCache: number }> {
    const budget = options.budget ?? this.opts.prefetchMaxPages;

    const wanted: string[] = [];
    let fromCache = 0;
    for (const id of new Set(ids)) {
      const node = this.opts.index.node(id);
      if (!node || node.type !== "page") continue;
      if (node.version !== undefined && this.opts.cache.getBody(id, node.version)) {
        fromCache += 1;
        continue;
      }
      wanted.push(id);
    }

    if (wanted.length > budget) {
      throw new VfsError(
        "EINVAL",
        `${options.reason ?? "This operation"} needs ${wanted.length} page bodies, over the ${budget}-page prefetch limit. ` +
          `Narrow the path, or raise it with --prefetch-max (config vfs.prefetchMaxPages)`,
      );
    }
    if (wanted.length === 0) return { fetched: 0, fromCache };
    if (this.opts.offline) {
      throw new VfsError(
        "ENOENT",
        `${wanted.length} page bodies are not in the cache and --offline forbids a request`,
      );
    }

    // Data Center has no bulk body endpoint, so it pays per page there.
    if (this.opts.client.deploymentType !== "cloud") {
      this.reserveBodyDownloads(wanted.length, false);
      return { fetched: await this.prefetchOneByOne(wanted), fromCache };
    }

    this.reserveBodyDownloads(wanted.length);
    const CHUNK = 250;
    const chunks: string[][] = [];
    for (let start = 0; start < wanted.length; start += CHUNK) {
      chunks.push(wanted.slice(start, start + CHUNK));
    }
    const limit = createInOrderLimiter(Math.max(1, this.opts.concurrency));
    let fetched = 0;
    const results = await Promise.all(
      chunks.map((chunk) => limit(() => this.request(() => this.opts.client.getPagesBulk(chunk)))),
    );
    const received = new Set(results.flat().map((page) => page.id));
    const missing = wanted.filter((id) => !received.has(id));
    if (missing.length > 0) {
      throw new VfsError("ENOENT", `Bulk fetch omitted ${missing.length} requested page bodies; retry the search`);
    }
    for (const pages of results) {
      for (const page of pages) {
        const version = page.version ?? 1;
        this.opts.index.upsert({ id: page.id, title: page.title, version,
          ...(page.lastModified === undefined ? {} : { lastModified: page.lastModified }),
          ...(page.parentId === undefined ? {} : { parentId: page.parentId }) });
        const node = this.opts.index.node(page.id);
        if (!node) continue;
        this.opts.cache.putBody({
          pageId: page.id,
          version,
          markdown: renderPageMarkdown(node, page.storage, this.opts.instanceUrl),
          storageHash: hashStorage(page.storage),
        });
        fetched += 1;
      }
    }
    return { fetched, fromCache };
  }

  private async prefetchOneByOne(ids: string[]): Promise<number> {
    const limit = createInOrderLimiter(Math.max(1, this.opts.concurrency));
    let fetched = 0;
    await Promise.all(
      ids.map((id) =>
        limit(async () => {
          const node = this.opts.index.node(id);
          if (!node) return;
          await this.readBody(node, `/${node.spaceKey}/${node.id}`);
          fetched += 1;
        }),
      ),
    );
    return fetched;
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
