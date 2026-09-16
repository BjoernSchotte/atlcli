/**
 * In-memory Confluence used by every VFS unit test (WP1.6).
 *
 * It models the four behaviours the VFS actually has to get right:
 *
 *  - **Hierarchy**, including folders and non-page children, so path mapping
 *    and the tree index have something to walk.
 *  - **Versions**, monotonic and immutable, because that is what makes the body
 *    cache sound.
 *  - **Visibility**, as a set of hidden IDs that answer 404 exactly the way
 *    Confluence does — never 403, so the fake cannot accidentally teach the VFS
 *    to leak existence.
 *  - **Failure injection** for 409 and 429, the two statuses the write path and
 *    the prefetch budget are built around.
 *
 * It also **counts requests**. Most of the demand-principle tests (section 1b of
 * the plan) are assertions about `callsTo("getPage")` rather than about output.
 */
import type {
  AttachmentInfo,
  ConfluenceFolder,
  ConfluenceDetailedSearchResults,
  ConfluencePage,
  ConfluenceSearchResult,
  ConfluenceSpace,
  FolderChild,
  LabelInfo,
  PageChangeInfo,
  PageComments,
  SearchResults,
} from "@atlcli/confluence";
import type { DeploymentType } from "@atlcli/core";
import type { VfsClient } from "../client-port.js";

/** How a caller describes a page to {@link FakeConfluenceClient}. */
export interface FakePageSeed {
  id: string;
  title: string;
  /** Storage-format body. Folders and non-page children ignore it. */
  storage?: string;
  parentId?: string | null;
  spaceKey: string;
  version?: number;
  lastModified?: string;
  labels?: string[];
  /** `"page"` by default; `"folder"`, `"whiteboard"`, `"database"`, `"embed"`. */
  type?: string;
  /** Sort order among its siblings, as `direct-children` reports it. */
  position?: number;
  status?: string;
}

export interface FakeSpaceSeed {
  id: string;
  key: string;
  name: string;
  type?: "global" | "personal";
  /** Page ID of the space home page. */
  homepageId?: string;
}

export interface FakeAttachmentSeed {
  id: string;
  pageId: string;
  filename: string;
  mediaType?: string;
  bytes: Uint8Array;
  version?: number;
  modified?: string;
}

/** A programmed failure, consumed `times` times then forgotten. */
export interface FakeFailure {
  method: string;
  status: number;
  times: number;
  /** Only fail when the first argument (usually an ID) matches. */
  match?: string;
  retryAfterMs?: number;
  message?: string;
}

export interface FakeClientOptions {
  deploymentType?: DeploymentType;
  instanceUrl?: string;
  accountId?: string;
  displayName?: string;
  /** IDs the authenticated user cannot see. They answer 404 everywhere. */
  hiddenIds?: Iterable<string>;
  /** Largest page of results any list endpoint returns. Default 250. */
  pageSize?: number;
}

/** What Confluence's REST client throws, shaped so `httpStatusOf` finds it. */
export class FakeHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "FakeHttpError";
  }
}

interface FakePageState extends FakePageSeed {
  version: number;
  storage: string;
  type: string;
  /** Every version ever written, keyed by version number. */
  history: Map<number, { storage: string; title: string; when: string }>;
  trashed: boolean;
}

let syntheticId = 700_000_000;
function nextId(): string {
  syntheticId += 1;
  return String(syntheticId);
}

export class FakeConfluenceClient implements VfsClient {
  readonly deploymentType: DeploymentType;
  private readonly instanceUrl: string;
  private readonly accountId: string;
  private readonly displayName: string;
  private readonly pageSize: number;

  private spaces = new Map<string, ConfluenceSpace & { homepageId?: string }>();
  private pages = new Map<string, FakePageState>();
  private attachments = new Map<string, FakeAttachmentSeed & { mediaType: string; version: number }>();
  private comments = new Map<string, PageComments>();

  /** IDs the caller may not see. Reads answer 404, listings omit them. */
  readonly hiddenIds = new Set<string>();
  /** Every call, in order, as `method` plus its stringified first argument. */
  readonly calls: { method: string; arg: string }[] = [];
  private failures: FakeFailure[] = [];
  private clock = Date.parse("2026-09-16T09:00:00.000Z");

  constructor(options: FakeClientOptions = {}) {
    this.deploymentType = options.deploymentType ?? "cloud";
    this.instanceUrl = options.instanceUrl ?? "https://example.atlassian.net/wiki";
    this.accountId = options.accountId ?? "acct-001";
    this.displayName = options.displayName ?? "Test User";
    this.pageSize = options.pageSize ?? 250;
    for (const id of options.hiddenIds ?? []) this.hiddenIds.add(id);
  }

  // ---------------------------------------------------------------- seeding

  seedSpace(seed: FakeSpaceSeed): this {
    this.spaces.set(seed.key, {
      id: seed.id,
      key: seed.key,
      name: seed.name,
      type: seed.type ?? "global",
      status: "current",
      homepageId: seed.homepageId,
      url: `${this.instanceUrl}/spaces/${seed.key}`,
    });
    return this;
  }

  seedPage(seed: FakePageSeed): this {
    const version = seed.version ?? 1;
    const storage = seed.storage ?? "";
    const when = seed.lastModified ?? new Date(this.clock).toISOString();
    this.pages.set(seed.id, {
      ...seed,
      type: seed.type ?? "page",
      version,
      storage,
      parentId: seed.parentId ?? null,
      lastModified: when,
      history: new Map([[version, { storage, title: seed.title, when }]]),
      trashed: false,
    });
    return this;
  }

  /** Seeds `count` pages under one parent, for the 5,000-page load tests. */
  seedPages(
    count: number,
    template: (index: number) => FakePageSeed,
  ): this {
    for (let index = 0; index < count; index++) this.seedPage(template(index));
    return this;
  }

  seedAttachment(seed: FakeAttachmentSeed): this {
    this.attachments.set(seed.id, {
      ...seed,
      mediaType: seed.mediaType ?? "application/octet-stream",
      version: seed.version ?? 1,
    });
    return this;
  }

  seedComments(pageId: string, comments: PageComments): this {
    this.comments.set(pageId, comments);
    return this;
  }

  /** Programs the next `times` calls to `method` to fail with `status`. */
  failNext(failure: FakeFailure): this {
    this.failures.push({ ...failure });
    return this;
  }

  /** Simulates an out-of-band edit: bumps the server version behind our back. */
  bumpVersion(pageId: string, storage?: string): number {
    const page = this.mustPage(pageId);
    page.version += 1;
    if (storage !== undefined) page.storage = storage;
    this.clock += 60_000;
    page.lastModified = new Date(this.clock).toISOString();
    page.history.set(page.version, {
      storage: page.storage,
      title: page.title,
      when: page.lastModified,
    });
    return page.version;
  }

  // ------------------------------------------------------------ inspection

  callsTo(method: string): number {
    return this.calls.filter((c) => c.method === method).length;
  }

  get requestCount(): number {
    return this.calls.length;
  }

  resetCalls(): void {
    this.calls.length = 0;
  }

  /** Page state, for assertions about what a write actually did. */
  peekPage(pageId: string): FakePageState | undefined {
    return this.pages.get(pageId);
  }

  // --------------------------------------------------------------- plumbing

  private record(method: string, arg: unknown): void {
    this.calls.push({ method, arg: typeof arg === "string" ? arg : JSON.stringify(arg ?? null) });
    const index = this.failures.findIndex(
      (f) => f.method === method && (f.match === undefined || f.match === String(arg)),
    );
    if (index < 0) return;
    const failure = this.failures[index]!;
    failure.times -= 1;
    if (failure.times <= 0) this.failures.splice(index, 1);
    throw new FakeHttpError(
      failure.status,
      failure.message ?? `Confluence API error (${failure.status}): injected by the fake`,
      failure.retryAfterMs,
    );
  }

  private visible(id: string): boolean {
    return !this.hiddenIds.has(id);
  }

  private mustPage(id: string): FakePageState {
    const page = this.pages.get(id);
    // A hidden or trashed page is indistinguishable from a missing one, which
    // is exactly the guarantee WP2.7 tests.
    if (!page || page.trashed || !this.visible(id)) {
      throw new FakeHttpError(404, `Confluence API error (404): no content with id ${id}`);
    }
    return page;
  }

  private toPage(page: FakePageState): ConfluencePage {
    return {
      id: page.id,
      title: page.title,
      version: page.version,
      spaceKey: page.spaceKey,
      parentId: page.parentId ?? null,
      url: `${this.instanceUrl}/spaces/${page.spaceKey}/pages/${page.id}`,
    };
  }

  private childrenOf(parentId: string): FakePageState[] {
    return [...this.pages.values()]
      .filter((p) => p.parentId === parentId && !p.trashed && this.visible(p.id))
      .sort((a, b) => (a.position ?? 0) - (b.position ?? 0) || a.id.localeCompare(b.id));
  }

  private toChild(page: FakePageState): FolderChild {
    return {
      id: page.id,
      title: page.title,
      type: page.type,
      status: page.status ?? "current",
      parentId: page.parentId ?? null,
      spaceId: this.spaces.get(page.spaceKey)?.id,
      position: page.position ?? null,
      url: `${this.instanceUrl}/spaces/${page.spaceKey}/pages/${page.id}`,
    };
  }

  // ------------------------------------------------------------- VfsClient

  getInstanceUrl(): string {
    return this.instanceUrl;
  }

  async getCurrentUser(): Promise<{ accountId: string; displayName: string; email?: string }> {
    this.record("getCurrentUser", "");
    return { accountId: this.accountId, displayName: this.displayName };
  }

  async listSpaces(limit = 25): Promise<ConfluenceSpace[]> {
    this.record("listSpaces", String(limit));
    return [...this.spaces.values()]
      .filter((s) => this.visible(s.id))
      .slice(0, limit)
      .map(({ homepageId: _homepageId, ...space }) => space);
  }

  async getSpace(key: string): Promise<ConfluenceSpace> {
    this.record("getSpace", key);
    const space = this.spaces.get(key);
    if (!space || !this.visible(space.id)) {
      throw new FakeHttpError(404, `Confluence API error (404): no space ${key}`);
    }
    const { homepageId: _homepageId, ...rest } = space;
    return rest;
  }

  async getSpaceHomepageId(spaceKey: string): Promise<string | null> {
    this.record("getSpaceHomepageId", spaceKey);
    const space = this.spaces.get(spaceKey);
    if (!space) throw new FakeHttpError(404, `Confluence API error (404): no space ${spaceKey}`);
    return space.homepageId ?? null;
  }

  async getPageDirectChildren(
    pageId: string,
    options: { limit?: number } = {},
  ): Promise<FolderChild[]> {
    this.record("getPageDirectChildren", pageId);
    if (this.mustPage(pageId).type !== "page") {
      throw new FakeHttpError(404, "Confluence API error (404): not a page");
    }
    return this.childrenOf(pageId)
      .slice(0, options.limit ?? this.pageSize)
      .map((p) => this.toChild(p));
  }

  async getChildren(
    pageId: string,
    options: { limit?: number } = {},
  ): Promise<ConfluenceSearchResult[]> {
    // The Data Center v1 path. Same data, different shape.
    this.record("getChildren", pageId);
    this.mustPage(pageId);
    return this.childrenOf(pageId)
      .slice(0, options.limit ?? this.pageSize)
      .map((p) => ({
        id: p.id,
        title: p.title,
        spaceKey: p.spaceKey,
        version: p.version,
        lastModified: p.lastModified,
        type: p.type,
      }));
  }

  async getAncestors(pageId: string): Promise<{ id: string; title: string }[]> {
    this.record("getAncestors", pageId);
    const page = this.mustPage(pageId);
    const chain: { id: string; title: string }[] = [];
    let current = page.parentId ? this.pages.get(page.parentId) : undefined;
    while (current) {
      chain.unshift({ id: current.id, title: current.title });
      current = current.parentId ? this.pages.get(current.parentId) : undefined;
    }
    return chain;
  }

  async getFolder(folderId: string): Promise<ConfluenceFolder> {
    this.record("getFolder", folderId);
    const folder = this.mustPage(folderId);
    return {
      id: folder.id,
      title: folder.title,
      spaceId: this.spaces.get(folder.spaceKey)?.id ?? "",
      parentId: folder.parentId ?? null,
    };
  }

  async getFolderChildren(
    folderId: string,
    options: { limit?: number } = {},
  ): Promise<FolderChild[]> {
    this.record("getFolderChildren", folderId);
    if (this.mustPage(folderId).type !== "folder") {
      throw new FakeHttpError(404, "Confluence API error (404): not a folder");
    }
    return this.childrenOf(folderId)
      .slice(0, options.limit ?? this.pageSize)
      .map((p) => this.toChild(p));
  }

  async getPageMetadata(id: string): Promise<ConfluencePage> {
    this.record("getPageMetadata", id);
    return this.toPage(this.mustPage(id));
  }

  async getPage(id: string): Promise<ConfluencePage & { storage: string }> {
    this.record("getPage", id);
    const page = this.mustPage(id);
    return { ...this.toPage(page), storage: page.storage };
  }

  async getPageAtVersion(
    pageId: string,
    version: number,
  ): Promise<ConfluencePage & { storage: string }> {
    this.record("getPageAtVersion", `${pageId}@${version}`);
    const page = this.mustPage(pageId);
    const historic = page.history.get(version);
    if (!historic) {
      throw new FakeHttpError(404, `Confluence API error (404): no version ${version} of ${pageId}`);
    }
    return { ...this.toPage(page), version, title: historic.title, storage: historic.storage };
  }

  async getPagesBulk(
    ids: readonly string[],
  ): Promise<(ConfluencePage & { storage: string })[]> {
    this.record("getPagesBulk", ids.join(","));
    if (this.deploymentType !== "cloud") {
      throw new TypeError("Bulk page body fetches require Confluence Cloud REST v2.");
    }
    const out: (ConfluencePage & { storage: string })[] = [];
    for (const id of [...new Set(ids)]) {
      const page = this.pages.get(id);
      // A page the caller cannot see is absent, never an error.
      if (!page || page.trashed || !this.visible(id)) continue;
      out.push({ ...this.toPage(page), storage: page.storage });
    }
    return out;
  }

  async getPageVersions(ids: readonly string[]): Promise<Map<string, PageChangeInfo>> {
    this.record("getPageVersions", ids.join(","));
    // Matches the real client, which refuses outside Cloud v2. Without this the
    // fake would let a Data Center regression pass unnoticed.
    if (this.deploymentType !== "cloud") {
      throw new TypeError("Bulk page-version snapshots require Confluence Cloud REST v2.");
    }
    const out = new Map<string, PageChangeInfo>();
    for (const id of ids) {
      const page = this.pages.get(id);
      // Body-free probe: a page that vanished is simply absent from the map.
      if (!page || page.trashed || !this.visible(id)) continue;
      out.set(id, {
        id,
        title: page.title,
        version: page.version,
        lastModified: page.lastModified,
        spaceKey: page.spaceKey,
      });
    }
    return out;
  }

  async search(
    cql: string,
    options: { limit?: number; start?: number } = {},
  ): Promise<SearchResults> {
    this.record("search", cql);
    const results = this.runCql(cql);
    const start = options.start ?? 0;
    const limit = options.limit ?? 25;
    const window = results.slice(start, start + limit);
    return {
      results: window,
      start,
      limit,
      size: window.length,
      totalSize: results.length,
      hasMore: start + window.length < results.length,
    };
  }

  async searchDetailed(cql: string, options: { limit?: number; cursor?: string } = {}): Promise<ConfluenceDetailedSearchResults> {
    this.record("searchDetailed", cql);
    const scope = /^type = page AND \((.*?)\) AND \(/.exec(cql);
    const spaces = scope ? [...scope[1]!.matchAll(/space = "([^"\\]*)"/g)].map((match) => match[1]!) : undefined;
    const results = this.runCql(scope ? cql.slice(scope[0].length) : cql)
      .filter((row) => !spaces || (row.type === "page" && spaces.includes(row.spaceKey ?? "")));
    const start = Number(options.cursor ?? 0);
    const limit = options.limit ?? 25;
    return {
      results: results.slice(start, start + limit).map((row) => ({
        ...row,
        excerpt: (this.pages.get(row.id)?.storage ?? "").replace(/<[^>]*>/g, "").slice(0, 240),
      })),
      totalSize: results.length,
      ...(start + limit < results.length ? { nextLink: String(start + limit) } : {}),
    };
  }

  async searchPages(cql: string, limit = 25): Promise<ConfluenceSearchResult[]> {
    this.record("searchPages", cql);
    return this.runCql(cql).slice(0, limit);
  }

  /**
   * A deliberately small CQL subset: `space`, `type`, `id`, `text ~`,
   * `label` and `lastmodified >=`. It matches `text ~` on **whole words**,
   * because that is the real behaviour decision 12's guard exists to survive.
   */
  private runCql(cql: string): ConfluenceSearchResult[] {
    const spaceMatch = /space\s*=\s*"?([A-Za-z0-9_-]+)"?/i.exec(cql);
    const typeMatch = /type\s*=\s*"?([a-z]+)"?/i.exec(cql);
    const idMatch = /\bid\s*=\s*"?(\d+)"?/i.exec(cql);
    const textMatch = /text\s*~\s*"([^"]*)"/i.exec(cql);
    const labelMatch = /label\s*=\s*"?([^"\s)]+)"?/i.exec(cql);
    const sinceMatch = /lastmodified\s*>=\s*now\("-(\d+)([dhm])"\)/i.exec(cql);

    let since: number | undefined;
    if (sinceMatch) {
      const amount = Number(sinceMatch[1]);
      const unit = sinceMatch[2];
      const ms = unit === "d" ? 86_400_000 : unit === "h" ? 3_600_000 : 60_000;
      since = this.clock - amount * ms;
    }

    const needle = textMatch?.[1]?.toLowerCase();
    const wildcard = needle?.endsWith("*") ?? false;
    const bare = wildcard ? needle!.slice(0, -1) : needle;

    return [...this.pages.values()]
      .filter((page) => {
        if (page.trashed || !this.visible(page.id)) return false;
        if (spaceMatch && page.spaceKey !== spaceMatch[1]) return false;
        if (typeMatch && page.type !== typeMatch[1]) return false;
        if (idMatch && page.id !== idMatch[1]) return false;
        if (labelMatch && !(page.labels ?? []).includes(labelMatch[1]!)) return false;
        if (since !== undefined && Date.parse(page.lastModified ?? "") < since) return false;
        if (bare !== undefined) {
          const haystack = `${page.title} ${page.storage}`.toLowerCase();
          const words = haystack.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
          const hit = wildcard
            ? words.some((w) => w.startsWith(bare))
            : words.includes(bare);
          if (!hit) return false;
        }
        return true;
      })
      .map((page) => ({
        id: page.id,
        title: page.title,
        spaceKey: page.spaceKey,
        version: page.version,
        lastModified: page.lastModified,
        type: page.type,
        labels: page.labels,
        url: `${this.instanceUrl}/spaces/${page.spaceKey}/pages/${page.id}`,
      }));
  }

  async getLabels(pageId: string): Promise<LabelInfo[]> {
    this.record("getLabels", pageId);
    const page = this.mustPage(pageId);
    return (page.labels ?? []).map((name, index) => ({
      prefix: "global",
      name,
      id: `label-${pageId}-${index}`,
    }));
  }

  async getPagesByLabel(
    label: string,
    options: { spaceKey?: string; limit?: number } = {},
  ): Promise<PageChangeInfo[]> {
    this.record("getPagesByLabel", label);
    return [...this.pages.values()]
      .filter(
        (page) =>
          !page.trashed &&
          this.visible(page.id) &&
          (page.labels ?? []).includes(label) &&
          (options.spaceKey === undefined || page.spaceKey === options.spaceKey),
      )
      .slice(0, options.limit ?? this.pageSize)
      .map((page) => ({
        id: page.id,
        title: page.title,
        version: page.version,
        lastModified: page.lastModified,
        spaceKey: page.spaceKey,
      }));
  }

  async getAllComments(pageId: string): Promise<PageComments> {
    this.record("getAllComments", pageId);
    this.mustPage(pageId);
    return (
      this.comments.get(pageId) ?? {
        pageId,
        lastSynced: new Date(this.clock).toISOString(),
        footerComments: [],
        inlineComments: [],
      }
    );
  }

  async listAttachments(pageId: string): Promise<AttachmentInfo[]> {
    this.record("listAttachments", pageId);
    this.mustPage(pageId);
    return [...this.attachments.values()]
      .filter((a) => a.pageId === pageId)
      .map((a) => this.toAttachmentInfo(a));
  }

  private toAttachmentInfo(a: FakeAttachmentSeed & { mediaType: string; version: number }): AttachmentInfo {
    return {
      id: a.id,
      filename: a.filename,
      mediaType: a.mediaType,
      fileSize: a.bytes.byteLength,
      version: a.version,
      modified: a.modified ?? new Date(this.clock).toISOString(),
      pageId: a.pageId,
      downloadUrl: `/download/attachments/${a.pageId}/${encodeURIComponent(a.filename)}`,
    };
  }

  async downloadAttachment(
    attachment: AttachmentInfo | { downloadUrl: string },
  ): Promise<Uint8Array> {
    const id = "id" in attachment ? attachment.id : attachment.downloadUrl;
    this.record("downloadAttachment", id);
    const found =
      this.attachments.get(id) ??
      [...this.attachments.values()].find(
        (a) => this.toAttachmentInfo(a).downloadUrl === attachment.downloadUrl,
      );
    if (!found) throw new FakeHttpError(404, `Confluence API error (404): no attachment ${id}`);
    return found.bytes;
  }

  async uploadAttachment(params: {
    pageId: string;
    filename: string;
    data: Uint8Array;
    mimeType?: string;
  }): Promise<AttachmentInfo> {
    this.record("uploadAttachment", `${params.pageId}/${params.filename}`);
    this.mustPage(params.pageId);
    const existing = [...this.attachments.values()].find(
      (a) => a.pageId === params.pageId && a.filename === params.filename,
    );
    if (existing) {
      throw new FakeHttpError(
        400,
        `Confluence API error (400): attachment ${params.filename} already exists`,
      );
    }
    const seed = {
      id: nextId(),
      pageId: params.pageId,
      filename: params.filename,
      bytes: params.data,
      mediaType: params.mimeType ?? "application/octet-stream",
      version: 1,
    };
    this.attachments.set(seed.id, seed);
    return this.toAttachmentInfo(seed);
  }

  async updateAttachment(params: {
    attachmentId: string;
    pageId: string;
    filename?: string;
    data: Uint8Array;
    mimeType?: string;
  }): Promise<AttachmentInfo> {
    this.record("updateAttachment", params.attachmentId);
    const existing = this.attachments.get(params.attachmentId);
    if (!existing) {
      throw new FakeHttpError(404, `Confluence API error (404): no attachment ${params.attachmentId}`);
    }
    existing.bytes = params.data;
    existing.version += 1;
    if (params.filename) existing.filename = params.filename;
    if (params.mimeType) existing.mediaType = params.mimeType;
    return this.toAttachmentInfo(existing);
  }

  async deleteAttachment(attachmentId: string): Promise<void> {
    this.record("deleteAttachment", attachmentId);
    if (!this.attachments.delete(attachmentId)) {
      throw new FakeHttpError(404, `Confluence API error (404): no attachment ${attachmentId}`);
    }
  }

  async createPage(params: {
    spaceKey: string;
    title: string;
    storage: string;
    parentId?: string;
  }): Promise<ConfluencePage> {
    this.record("createPage", `${params.spaceKey}/${params.title}`);
    const clash = [...this.pages.values()].find(
      (p) => !p.trashed && p.spaceKey === params.spaceKey && p.title === params.title,
    );
    // Confluence enforces title uniqueness per space, and answers 400.
    if (clash) {
      throw new FakeHttpError(
        400,
        `Confluence API error (400): a page titled "${params.title}" already exists in ${params.spaceKey}`,
      );
    }
    const id = nextId();
    this.clock += 1000;
    this.seedPage({
      id,
      title: params.title,
      storage: params.storage,
      spaceKey: params.spaceKey,
      parentId: params.parentId ?? null,
      version: 1,
      lastModified: new Date(this.clock).toISOString(),
    });
    return this.toPage(this.pages.get(id)!);
  }

  async updatePage(params: {
    id: string;
    title: string;
    storage: string;
    version: number;
  }): Promise<ConfluencePage> {
    this.record("updatePage", params.id);
    const page = this.mustPage(params.id);
    // This is the real 409: Confluence requires version = current + 1.
    if (params.version !== page.version + 1) {
      throw new FakeHttpError(
        409,
        `Confluence API error (409): version must be ${page.version + 1}, got ${params.version}`,
      );
    }
    page.version = params.version;
    page.title = params.title;
    page.storage = params.storage;
    this.clock += 1000;
    page.lastModified = new Date(this.clock).toISOString();
    page.history.set(page.version, {
      storage: page.storage,
      title: page.title,
      when: page.lastModified,
    });
    return this.toPage(page);
  }

  async movePage(pageId: string, newParentId: string): Promise<ConfluencePage> {
    this.record("movePage", `${pageId}->${newParentId}`);
    const page = this.mustPage(pageId);
    const parent = this.mustPage(newParentId);
    page.parentId = newParentId;
    page.spaceKey = parent.spaceKey;
    return this.toPage(page);
  }

  async movePageToPosition(
    pageId: string,
    position: "before" | "after" | "append",
    targetId: string,
  ): Promise<ConfluencePage> {
    this.record("movePageToPosition", `${pageId}/${position}/${targetId}`);
    const page = this.mustPage(pageId);
    const target = this.mustPage(targetId);
    if (position === "append") {
      page.parentId = targetId;
      page.spaceKey = target.spaceKey;
    } else {
      page.parentId = target.parentId ?? null;
      page.spaceKey = target.spaceKey;
      page.position = (target.position ?? 0) + (position === "before" ? -1 : 1);
    }
    return this.toPage(page);
  }

  async movePageToFolder(pageId: string, folderId: string): Promise<ConfluencePage> {
    this.record("movePageToFolder", `${pageId}->${folderId}`);
    const page = this.mustPage(pageId);
    const folder = this.mustPage(folderId);
    page.parentId = folderId;
    page.spaceKey = folder.spaceKey;
    return this.toPage(page);
  }

  async copyPage(params: {
    sourceId: string;
    targetSpaceKey?: string;
    newTitle?: string;
    parentId?: string;
  }): Promise<ConfluencePage> {
    this.record("copyPage", params.sourceId);
    const source = this.mustPage(params.sourceId);
    return this.createPage({
      spaceKey: params.targetSpaceKey ?? source.spaceKey,
      title: params.newTitle ?? `${source.title} (copy)`,
      storage: source.storage,
      parentId: params.parentId ?? source.parentId ?? undefined,
    });
  }

  async deletePage(pageId: string): Promise<void> {
    this.record("deletePage", pageId);
    const page = this.mustPage(pageId);
    // Trash, never purge: the page and its descendants stay in `pages` with
    // `trashed: true`, so a test can prove nothing was actually destroyed.
    const trash = (id: string): void => {
      const target = this.pages.get(id);
      if (!target) return;
      target.trashed = true;
      for (const child of [...this.pages.values()].filter((p) => p.parentId === id)) {
        trash(child.id);
      }
    };
    trash(page.id);
  }

  /** True when the page is in the trash rather than gone. Purge never happens. */
  isTrashed(pageId: string): boolean {
    return this.pages.get(pageId)?.trashed ?? false;
  }
}
