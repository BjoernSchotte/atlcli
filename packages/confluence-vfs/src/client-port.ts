/**
 * The slice of `ConfluenceClient` the VFS core is allowed to use.
 *
 * ## Why a port rather than the class
 *
 * WP1.4 in the plan types `VfsOptions.client` as `ConfluenceClient`. That is
 * what callers pass, and `client-port.test.ts` proves the real client still
 * satisfies this interface — but the *core* depends on the interface, for two
 * reasons the plan itself demands:
 *
 *  1. WP1.6 asks for a `FakeConfluenceClient` that "is the basis of every unit
 *     test". `ConfluenceClient` is a 5,000-line concrete class; a fake that had
 *     to extend it would drag in HTTP, retries and TLS.
 *  2. The list below *is* the VFS's API surface against Confluence. Keeping it
 *     in one file makes "which endpoints does the filesystem touch?" — a WP9.1
 *     security-review question — answerable by reading forty lines.
 *
 * Adding a method here is a deliberate act. Every addition widens what the
 * filesystem can do to a tenant.
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

export interface VfsClient {
  /** Cloud or Data Center; decides which tree traversal the index uses. */
  readonly deploymentType: DeploymentType;
  getInstanceUrl(): string;
  getRequestStats?(): { requests: number; rateLimits: number };

  // --- identity -----------------------------------------------------------
  getCurrentUser(options?: {
    signal?: AbortSignal;
  }): Promise<{ accountId: string; displayName: string; email?: string }>;

  // --- spaces -------------------------------------------------------------
  listSpaces(limit?: number): Promise<ConfluenceSpace[]>;
  getSpace(key: string, options?: { signal?: AbortSignal }): Promise<ConfluenceSpace>;
  getSpaceHomepageId(
    spaceKey: string,
    options?: { signal?: AbortSignal },
  ): Promise<string | null>;

  // --- hierarchy (read) ---------------------------------------------------
  getPageDirectChildren(
    pageId: string,
    options?: { limit?: number; signal?: AbortSignal },
  ): Promise<FolderChild[]>;
  // `getPageDescendants` is deliberately absent. The real client fixes its
  // depth at exactly 1 (it throws a RangeError otherwise), so it returns the
  // same thing as `direct-children` and buys the VFS nothing. Recursive walks
  // go level by level through `getPageDirectChildren`, which is what rule 1 of
  // the demand principle wants anyway.
  getChildren(
    pageId: string,
    options?: { limit?: number },
  ): Promise<ConfluenceSearchResult[]>;
  /** Ancestors root-first, so `.by-id/` can name a canonical path. */
  getAncestors(pageId: string): Promise<{ id: string; title: string }[]>;
  getFolder(folderId: string): Promise<ConfluenceFolder>;
  getFolderChildren(
    folderId: string,
    options?: { limit?: number; signal?: AbortSignal },
  ): Promise<FolderChild[]>;

  // --- bodies and versions ------------------------------------------------
  getPageMetadata(id: string, options?: { signal?: AbortSignal }): Promise<ConfluencePage>;
  getPage(
    id: string,
    options?: { signal?: AbortSignal },
  ): Promise<ConfluencePage & { storage: string }>;
  getPageAtVersion(
    pageId: string,
    version: number,
    options?: { signal?: AbortSignal },
  ): Promise<ConfluencePage & { storage: string }>;
  /**
   * Bulk bodies, up to 250 per request: the capped prefetch's engine.
   * Cloud only — it throws on Data Center, so callers there fall back to
   * per-page `getPage`.
   */
  getPagesBulk(
    ids: readonly string[],
    options?: { signal?: AbortSignal },
  ): Promise<(ConfluencePage & { storage: string })[]>;
  /** Body-free bulk metadata: the tree index's revalidation probe. */
  getPageVersions(
    ids: readonly string[],
    options?: { signal?: AbortSignal },
  ): Promise<Map<string, PageChangeInfo>>;

  // --- search -------------------------------------------------------------
  searchDetailed(cql: string, options?: {
    limit?: number;
    cursor?: string;
    contentStatuses?: string[];
    signal?: AbortSignal;
  }): Promise<ConfluenceDetailedSearchResults>;
  search(
    cql: string,
    options?: {
      limit?: number;
      start?: number;
      excerpt?: boolean;
      detail?: "minimal" | "standard" | "full";
      signal?: AbortSignal;
    },
  ): Promise<SearchResults>;
  searchPages(
    cql: string,
    limit?: number,
    options?: { signal?: AbortSignal },
  ): Promise<ConfluenceSearchResult[]>;

  // --- labels and comments ------------------------------------------------
  getLabels(pageId: string): Promise<LabelInfo[]>;
  getPagesByLabel(
    label: string,
    options?: { spaceKey?: string; limit?: number },
  ): Promise<PageChangeInfo[]>;
  getAllComments(pageId: string, options?: { limit?: number }): Promise<PageComments>;

  // --- attachments --------------------------------------------------------
  getAttachment(id: string): Promise<AttachmentInfo>;
  listAttachments(
    pageId: string,
    options?: { limit?: number; signal?: AbortSignal },
  ): Promise<AttachmentInfo[]>;
  downloadAttachment(
    attachment: AttachmentInfo | { downloadUrl: string },
    options?: { signal?: AbortSignal },
  ): Promise<Uint8Array>;
  uploadAttachment(params: {
    pageId: string;
    filename: string;
    data: Uint8Array;
    mimeType?: string;
    comment?: string;
  }): Promise<AttachmentInfo>;
  updateAttachment(params: {
    attachmentId: string;
    pageId: string;
    filename?: string;
    data: Uint8Array;
    mimeType?: string;
    comment?: string;
  }): Promise<AttachmentInfo>;
  deleteAttachment(attachmentId: string): Promise<void>;

  // --- writes -------------------------------------------------------------
  // Note what is absent and must stay absent: any purge endpoint. `deletePage`
  // is Confluence's trash, and the VFS offers nothing beyond it (plan §9).
  createPage(params: {
    spaceKey: string;
    title: string;
    storage: string;
    parentId?: string;
  }): Promise<ConfluencePage>;
  updatePage(params: {
    id: string;
    title: string;
    storage: string;
    version: number;
  }): Promise<ConfluencePage>;
  movePage(pageId: string, newParentId: string): Promise<ConfluencePage>;
  movePageToPosition(
    pageId: string,
    position: "before" | "after" | "append",
    targetId: string,
  ): Promise<ConfluencePage>;
  movePageToFolder(pageId: string, folderId: string): Promise<ConfluencePage>;
  copyPage(params: {
    sourceId: string;
    targetSpaceKey?: string;
    newTitle?: string;
    parentId?: string;
  }): Promise<ConfluencePage>;
  deletePage(pageId: string): Promise<void>;
}
