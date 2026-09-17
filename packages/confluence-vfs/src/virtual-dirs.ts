/**
 * The convenience directories (WP4).
 *
 * Everything here is a *view*, never a copy: `.labels/`, `.recent/` and
 * `.search/` list symlinks into `.by-id/`, so a page has exactly one home in
 * the tree however many views point at it.
 *
 * ## Lazy resolution, and why `.labels/` joined `.search/`
 *
 * Decision 8 makes `.search/<cql>/` resolve on access with no registration
 * step: state is never a prerequisite for correctness, so losing the list of
 * recent queries costs nothing. `.labels/` works the same way, for a blunter
 * reason — **Confluence has no endpoint that lists the labels used in a
 * space.** `GET /space/{key}/label` returns labels *of the space object*, and
 * the only way to enumerate page labels is to walk every page, which rule 1
 * forbids. So `.labels/` lists the labels the VFS has actually seen, and
 * `.labels/<anything>/` resolves regardless of whether it was listed.
 * Recorded as deviation D5.
 */
import type { PageComments } from "@atlcli/confluence";
import type { VfsClient } from "./client-port.js";
import { BodyCache } from "./body-cache.js";
import { mapClientError, withRateLimitRetry } from "./errors.js";
import { VFS_DEFAULTS, type VfsLogger } from "./options.js";
import { formatDirName, vfsSlug } from "./path-mapper.js";
import { RECENT_WINDOWS, type RecentWindow } from "./resolver.js";
import type { TreeIndex, TreeNode } from "./tree-index.js";
import { VfsError, type VfsDirent } from "./types.js";

/** Newest first, and never more than this many (the plan's cap). */
export const MAX_VERSIONS_LISTED = 50;

/** How many recent `.search/` queries the hint list remembers. */
export const MAX_REMEMBERED_QUERIES = 20;

export interface VirtualDirsOptions {
  client: VfsClient;
  index: TreeIndex;
  cache: BodyCache;
  instanceUrl: string;
  profile: string;
  offline: boolean;
  metadataTtlMs?: number;
  logger: VfsLogger;
  now: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Persists the `.search/` hint list. Losing it is harmless by design. */
  readQueryHints: () => string[];
  writeQueryHints: (queries: string[]) => void;
}

function fileEntry(name: string): VfsDirent {
  return { name, kind: "virtual-file", isDirectory: false, isFile: true, isSymbolicLink: false };
}

function dirEntry(name: string): VfsDirent {
  return { name, kind: "virtual-dir", isDirectory: true, isFile: false, isSymbolicLink: false };
}

function linkEntry(name: string): VfsDirent {
  return { name, kind: "symlink", isDirectory: false, isFile: false, isSymbolicLink: true };
}

type CachedListing<T> = { expires: number; result: Promise<T> };

export class VirtualDirs {
  private readonly attachmentListings = new Map<string, CachedListing<Awaited<ReturnType<VfsClient["listAttachments"]>>>>();
  private readonly commentListings = new Map<string, CachedListing<PageComments>>();

  constructor(private readonly opts: VirtualDirsOptions) {}

  invalidateAttachments(pageId: string): void {
    this.attachmentListings.delete(pageId);
  }

  private listAttachments(pageId: string, path?: string) {
    return this.cachedListing(this.attachmentListings, pageId,
      () => this.request(() => this.opts.client.listAttachments(pageId), path));
  }

  private cachedListing<T>(listings: Map<string, CachedListing<T>>, pageId: string, load: () => Promise<T>): Promise<T> {
    const cached = listings.get(pageId);
    if (cached && this.opts.now() < cached.expires) return cached.result;
    listings.delete(pageId);
    // Bound session listings; attachment bytes still use the existing blob cache.
    if (listings.size >= 256) {
      listings.delete(listings.keys().next().value!);
    }
    const entry = {
      expires: Infinity,
      result: load(),
    };
    listings.set(pageId, entry);
    void entry.result.then(() => {
      entry.expires = this.opts.now() + (this.opts.metadataTtlMs ?? VFS_DEFAULTS.treeTtlMs);
    }, () => {
      if (listings.get(pageId) === entry) listings.delete(pageId);
    });
    return entry.result;
  }

  // ------------------------------------------------------------ WP4.1 json

  async spaceJson(spaceKey: string): Promise<string> {
    const space = await this.opts.index.getSpace(spaceKey);
    const homepageId = await this.opts.index.getHomepageId(spaceKey);
    return `${JSON.stringify(
      {
        id: space.id,
        key: space.key,
        name: space.name,
        type: space.type,
        status: space.status,
        homepageId,
        url: space.url ?? `${this.opts.instanceUrl}/spaces/${space.key}`,
      },
      null,
      2,
    )}\n`;
  }

  async meJson(identity: { accountId: string; displayName: string }): Promise<string> {
    return `${JSON.stringify(
      {
        accountId: identity.accountId,
        displayName: identity.displayName,
        profile: this.opts.profile,
        deployment: this.opts.client.deploymentType,
        instanceUrl: this.opts.instanceUrl,
        note: "Everything in this filesystem is exactly what this account can see; Confluence filters server-side.",
      },
      null,
      2,
    )}\n`;
  }

  // ----------------------------------------------------- WP4.2 attachments

  /**
   * List attachments without downloading a byte.
   *
   * Size and modification time come from the metadata, so `ls -l` on a
   * directory of gigabyte PDFs costs one request and no transfer.
   */
  async attachmentsReaddir(node: TreeNode): Promise<VfsDirent[]> {
    const attachments = await this.listAttachments(node.id);
    return attachments.map((attachment) => ({
      name: attachment.filename,
      id: attachment.id,
      kind: "attachment" as const,
      isDirectory: false,
      isFile: true,
      isSymbolicLink: false,
    }));
  }

  /** Metadata for one attachment, for `stat`; still no download. */
  async attachmentMeta(
    node: TreeNode,
    filename: string,
    path: string,
  ): Promise<{ id: string; size: number; mediaType: string; version: number; mtime: Date }> {
    const attachments = await this.listAttachments(node.id, path);
    const found = attachments.find((attachment) => attachment.filename === filename);
    if (!found) throw new VfsError("ENOENT", `No such attachment: ${path}`, { path });
    return {
      id: found.id,
      size: found.fileSize,
      mediaType: found.mediaType,
      version: found.version,
      mtime: found.modified ? new Date(found.modified) : new Date(this.opts.now()),
    };
  }

  /** Downloads on a real read only, then serves from the blob cache. */
  async attachmentBytes(node: TreeNode, filename: string, path: string): Promise<Uint8Array> {
    const attachments = await this.listAttachments(node.id, path);
    const found = attachments.find((attachment) => attachment.filename === filename);
    if (!found) throw new VfsError("ENOENT", `No such attachment: ${path}`, { path });

    const cached = this.opts.cache.getAttachment(found.id, found.version);
    if (cached) return this.opts.cache.readAttachmentBytes(cached);
    if (this.opts.offline) {
      throw new VfsError(
        "ENOENT",
        `${path} is not in the cache and --offline forbids a request`,
        { path },
      );
    }

    const bytes = await this.request(() => this.opts.client.downloadAttachment(found), path);
    this.opts.cache.putAttachment({
      attachmentId: found.id,
      pageId: node.id,
      filename: found.filename,
      mediaType: found.mediaType,
      version: found.version,
      bytes,
    });
    return bytes;
  }

  // -------------------------------------------------------- WP4.3 versions

  async versionsReaddir(node: TreeNode): Promise<VfsDirent[]> {
    const current = await this.currentVersion(node);
    const count = Math.min(current, MAX_VERSIONS_LISTED);
    const entries: VfsDirent[] = [];
    for (let offset = 0; offset < count; offset++) {
      entries.push(fileEntry(`${current - offset}.md`));
    }
    return entries;
  }

  /**
   * The page's current version number, without fetching a body.
   *
   * A hierarchy listing carries no version on Cloud, so a page that was listed
   * but never read has none in the index. `getPageVersions` answers that for
   * one id and costs no body — which is what lets `.versions/` be a listing
   * rather than a read.
   */
  private async currentVersion(node: TreeNode): Promise<number> {
    if (node.version !== undefined) return node.version;
    if (this.opts.offline) return 1;
    if (this.opts.client.deploymentType !== "cloud") {
      // Data Center listings already carry the version; if this one did not,
      // there is no body-free probe to fall back to.
      return 1;
    }
    const versions = await this.request(() => this.opts.client.getPageVersions([node.id]));
    const info = versions.get(node.id);
    if (!info) return node.version ?? 1;
    this.opts.index.upsert({
      id: node.id,
      version: info.version,
      lastModified: info.lastModified,
    });
    return info.version;
  }

  // -------------------------------------------------------- WP4.4 comments

  /** Footer and inline comments as one Markdown document. Read-only. */
  async commentsMarkdown(node: TreeNode, path: string): Promise<string> {
    const comments = await this.cachedListing(this.commentListings, node.id,
      () => this.request(() => this.opts.client.getAllComments(node.id), path));
    return renderComments(node, comments);
  }

  // ----------------------------------------------------------- WP4.5 by-id

  /**
   * `.by-id/` lists nothing.
   *
   * Enumerating every page of a space to populate it is exactly the mirror this
   * filesystem refuses to be. The directory exists so that `/SPACE/.by-id/<id>.md`
   * resolves for *any* id the user can see, which is what an agent holding only
   * a page id needs.
   */
  byIdReaddir(): VfsDirent[] {
    return [fileEntry("README")];
  }

  byIdReadme(spaceKey: string): string {
    return [
      `# ${spaceKey}/.by-id`,
      "",
      "Address any page by its Confluence id, with no listing step:",
      "",
      `    cat /${spaceKey}/.by-id/623869955.md`,
      "",
      "Each entry is a symlink to the page's canonical path, so `readlink` tells",
      "you where the page actually lives in the tree.",
      "",
      "The directory itself lists nothing on purpose: enumerating every page of a",
      "space is the whole-space copy this filesystem is designed not to make.",
      "",
    ].join("\n");
  }

  /** Recover an existing folder handle without enumerating unrelated branches. */
  async folderPath(id: string, spaceKey: string): Promise<string> {
    if (!/^[0-9]+$/.test(id)) throw new VfsError("EINVAL", "Invalid folder ID");
    if (this.opts.offline) throw new VfsError("ENOENT", "Folder relocation requires online metadata");
    const space = await this.opts.index.getSpace(spaceKey);
    const folder = await this.request(() => this.opts.client.getFolder(id));
    // Confluence v1 space IDs may be numbers; v2 folder IDs are strings.
    if (folder.id !== id || !folder.spaceId || !space.id || String(folder.spaceId) !== String(space.id)) {
      throw new VfsError("ENOENT", "Folder is outside selected space");
    }
    const ancestors = await this.request(() => this.opts.client.getAncestors(id));
    if (ancestors.length > 256 || new Set([id, ...ancestors.map(node => node.id)]).size !== ancestors.length + 1 ||
        ancestors.some(node => !/^[0-9]+$/.test(node.id))) {
      throw new VfsError("EINVAL", "Invalid folder ancestry");
    }
    if ((ancestors.at(-1)?.id ?? null) !== folder.parentId) {
      throw new VfsError("EAGAIN", "Folder moved while resolving its path; retry");
    }
    const homepage = await this.opts.index.getHomepageId(spaceKey);
    return `/${[spaceKey, ...ancestors.filter(node => node.id !== homepage)
      .map(node => formatDirName(node.title, node.id)), formatDirName(folder.title, id)].join("/")}`;
  }

  /** The canonical path of a page, for `readlink`. */
  async canonicalPath(id: string, spaceKey: string, path: string): Promise<string> {
    const node = await this.loadNode(id, spaceKey, path);
    const segments = this.segmentsFromIndex(node, spaceKey);
    if (segments) return `/${[spaceKey, ...segments].join("/")}`;

    // The index has not walked down to this page, so ask Confluence directly.
    // One request, and only for an explicit `.by-id` address.
    const target = node;
    const ancestors = await this.request(() => this.opts.client.getAncestors(id), path);
    const homepageId = await this.opts.index.getHomepageId(spaceKey);
    const chain = ancestors
      .filter((ancestor) => ancestor.id !== homepageId)
      .map((ancestor) => `${vfsSlug(ancestor.title)}-${ancestor.id}`);
    return `/${[spaceKey, ...chain, formatDirName(target.title, target.id)].join("/")}`;
  }

  /** Records a page the index has not walked to, so `stat` can answer. */
  async loadNode(id: string, spaceKey: string, path: string): Promise<TreeNode> {
    const known = this.opts.index.node(id);
    if (known) {
      if (known.spaceKey !== spaceKey || known.type !== "page") {
        throw new VfsError("ENOENT", `No such page: ${path}`, { path });
      }
      await this.opts.index.revalidatePages([id]);
      return known;
    }
    if (this.opts.offline) {
      throw new VfsError("ENOENT", `${path} is not in the cache and --offline forbids a request`, {
        path,
      });
    }
    const page = await this.request(() => this.opts.client.getPageMetadata(id), path);
    if (page.spaceKey !== spaceKey) {
      throw new VfsError("ENOENT", `No such page: ${path}`, { path });
    }
    const node = this.opts.index.upsert({
      id: page.id,
      title: page.title,
      type: "page",
      spaceKey: page.spaceKey ?? spaceKey,
      version: page.version ?? 1,
      metaCheckedAt: this.opts.now(),
      parentId: page.parentId ?? null,
    });
    return node;
  }

  private segmentsFromIndex(node: TreeNode, spaceKey: string): string[] | undefined {
    void spaceKey;
    const segments: string[] = [];
    let current: TreeNode | undefined = node;
    // A cycle would only come from a corrupt index, but an infinite loop inside
    // a filesystem call is the worst way to find that out.
    const seen = new Set<string>();
    while (current) {
      if (seen.has(current.id)) return undefined;
      seen.add(current.id);
      if (current.parentId === null) break;
      segments.unshift(formatDirName(current.title, current.id));
      const parent: TreeNode | undefined = this.opts.index.node(current.parentId!);
      if (!parent) return undefined;
      current = parent;
    }
    return segments;
  }

  // ---------------------------------------------------------- WP4.6 labels

  labelsReaddir(spaceKey: string): VfsDirent[] {
    const seen = new Set<string>();
    for (const node of this.opts.index.loadedNodes()) {
      if (node.spaceKey !== spaceKey) continue;
      for (const label of this.labelsOf(node)) seen.add(label);
    }
    return [fileEntry("README"), ...[...seen].sort().map((label) => dirEntry(label))];
  }

  labelsReadme(spaceKey: string): string {
    return [
      `# ${spaceKey}/.labels`,
      "",
      "Every label resolves on access, listed or not:",
      "",
      `    ls /${spaceKey}/.labels/runbook/`,
      "",
      "The listing above shows only the labels this session has already seen,",
      "because Confluence has no endpoint that enumerates the labels used in a",
      "space — the only way to collect them is to read every page, which this",
      "filesystem will not do. A label missing from the listing still works.",
      "",
      "Entries are symlinks into `.by-id/`, so a page appears once in the tree",
      "however many labels point at it.",
      "",
    ].join("\n");
  }

  private labelsOf(node: TreeNode): string[] {
    const version = node.version;
    if (version === undefined) return [];
    const cached = this.opts.cache.getBody(node.id, version);
    if (!cached) return [];
    const match = /^\s+labels:\s*\[(.*)\]\s*$/m.exec(cached.markdown);
    if (!match) return [];
    return match[1]!
      .split(",")
      .map((entry) => entry.trim().replace(/^"|"$/g, ""))
      .filter(Boolean);
  }

  async labelReaddir(spaceKey: string, label: string): Promise<VfsDirent[]> {
    const pages = await this.request(() =>
      this.opts.client.getPagesByLabel(label, { spaceKey, limit: 250 }),
    );
    for (const page of pages) {
      this.opts.index.upsert({
        id: page.id,
        title: page.title,
        version: page.version,
        lastModified: page.lastModified,
        spaceKey,
      });
    }
    return pages.map((page) => linkEntry(`${vfsSlug(page.title)}-${page.id}.md`));
  }

  // ---------------------------------------------------------- WP4.7 recent

  recentReaddir(): VfsDirent[] {
    return RECENT_WINDOWS.map((window) => dirEntry(window));
  }

  async recentWindowReaddir(spaceKey: string, window: RecentWindow): Promise<VfsDirent[]> {
    const cql = `space = "${spaceKey}" AND type = page AND lastmodified >= now("-${window}")`;
    return this.searchToLinks(cql, spaceKey);
  }

  // ---------------------------------------------------------- WP4.8 search

  searchReaddir(): VfsDirent[] {
    const hints = this.opts.readQueryHints();
    return [fileEntry("README"), ...hints.map((query) => dirEntry(query))];
  }

  searchReadme(spaceKey: string): string {
    return [
      `# ${spaceKey}/.search`,
      "",
      "A directory name here is a CQL fragment. It resolves on access — there is",
      "no registration step and no `mkdir` to run first:",
      "",
      `    ls '/${spaceKey}/.search/text ~ "kubernetes"'`,
      `    ls '/${spaceKey}/.search/label = "runbook" AND type = page'`,
      "",
      `\`space = "${spaceKey}"\` is added for you, so a query never reaches another space.`,
      "",
      "## What the listing above shows",
      "",
      "Only the last few queries this session used, as a convenience. The list is",
      "disposable: losing it changes nothing, because resolution never consults it.",
      "",
      "## Limitation",
      "",
      "A directory name cannot contain `/`, so a query needing one — a date, a URL —",
      "cannot be written as a path. Use the `cql` command inside `atlcli wiki sh`",
      "instead, which takes the query as an argument:",
      "",
      `    cql 'space = "${spaceKey}" AND created >= "2026/01/01"'`,
      "",
    ].join("\n");
  }

  async searchQueryReaddir(spaceKey: string, query: string): Promise<VfsDirent[]> {
    if (query.includes("/")) {
      throw new VfsError(
        "EINVAL",
        `A search directory name cannot contain '/', and this query does: ${query}. ` +
          `Use the 'cql' command instead, which takes the query as an argument`,
      );
    }
    this.rememberQuery(query);
    return this.searchToLinks(`space = "${spaceKey}" AND (${query})`, spaceKey);
  }

  /** Adds a query to the disposable hint list. */
  rememberQuery(query: string): void {
    try {
      const hints = this.opts.readQueryHints().filter((entry) => entry !== query);
      hints.unshift(query);
      this.opts.writeQueryHints(hints.slice(0, MAX_REMEMBERED_QUERIES));
    } catch {
      // The hint list is disposable; failing to write it must never fail a read.
    }
  }

  forgetQuery(query: string): void {
    try {
      this.opts.writeQueryHints(this.opts.readQueryHints().filter((entry) => entry !== query));
    } catch {
      // As above.
    }
  }

  private async searchToLinks(cql: string, spaceKey: string): Promise<VfsDirent[]> {
    const results = await this.request(() => this.opts.client.searchPages(cql, 250));
    for (const result of results) {
      this.opts.index.upsert({
        id: result.id,
        title: result.title,
        version: result.version,
        lastModified: result.lastModified,
        spaceKey,
      });
    }
    return results.map((result) => linkEntry(`${vfsSlug(result.title)}-${result.id}.md`));
  }

  // -------------------------------------------------------------- plumbing

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

/** Footer and inline comments as one readable document. */
export function renderComments(node: TreeNode, comments: PageComments): string {
  const lines: string[] = [`# Comments on ${node.title}`, ""];

  const renderOne = (
    comment: {
      author: { displayName?: string };
      created: string;
      body: string;
      status: string;
      replies?: unknown[];
    },
    depth: number,
    selection?: string,
  ): void => {
    const indent = "  ".repeat(depth);
    const author = comment.author?.displayName ?? "Unknown";
    const state = comment.status === "resolved" ? " _(resolved)_" : "";
    lines.push(`${indent}- **${author}**, ${comment.created}${state}`);
    if (selection) lines.push(`${indent}  > ${selection}`);
    for (const line of stripHtml(comment.body).split("\n")) {
      if (line.trim()) lines.push(`${indent}  ${line.trim()}`);
    }
    for (const reply of (comment.replies ?? []) as typeof comment[]) {
      renderOne(reply, depth + 1);
    }
  };

  lines.push("## Footer comments", "");
  if (comments.footerComments.length === 0) lines.push("_None._", "");
  for (const comment of comments.footerComments) renderOne(comment, 0);

  lines.push("", "## Inline comments", "");
  if (comments.inlineComments.length === 0) lines.push("_None._", "");
  for (const comment of comments.inlineComments) {
    renderOne(comment, 0, comment.textSelection);
  }

  lines.push("");
  return lines.join("\n");
}

/**
 * Comment bodies are storage-format HTML.
 *
 * A full storage-to-Markdown pass would be heavier than a comment thread
 * deserves and would drag macro handling into a read-only view, so this strips
 * tags and decodes the handful of entities that actually appear.
 */
function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .trim();
}
