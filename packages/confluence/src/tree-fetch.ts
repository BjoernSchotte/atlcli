/**
 * Scope orchestration: ordered tree fetch (spec 002, Cluster A / T1.1–T1.2).
 *
 * `fetchExportTree` walks a page tree / space in **document (pre-order) order**,
 * prunes by label, and fetches page bodies through an in-order-delivery
 * concurrency pool, producing an `ExportNode[]` that `composeChapters` (a later
 * round) turns into one chapterized document. It talks to a `TreeSource` **port**
 * — never `ConfluenceClient` directly — so further hosts (extension session
 * fetch, folder 010) reuse the logic unchanged. `confluenceTreeSource(client)`
 * is the Node adapter that maps the port 1:1 onto the existing client.
 *
 * Isomorphic: no `node:`/`bun:` specifiers — only the representation-neutral
 * body dispatcher and shared limiter/scope helpers.
 */
import {
  canonicalExportNoteCode,
  StorageParseError,
  type ExportBlock,
  type ExportNote,
} from "./export-blocks.js";
import { AdfValidationError } from "./adf-types.js";
import {
  createAdfAnnotationResolver,
  createAdfMediaAttachmentResolver,
  type AdfMediaAttachment,
} from "./adf-to-blocks.js";
import type { InlineComment } from "./client.js";
import type { PageAttachmentMediaTermination } from "./client.js";
import { pageBodyToBlocks } from "./page-body-to-blocks.js";
import type {
  BlocksResult,
  ConfluenceExportPageDetails,
  ExportPageSource,
  PageBody,
  PageBodyToBlocksOptions,
} from "./page-body.js";
import {
  normalizeLabelFilter,
  type ExportScope,
  type LabelFilter,
  validateExportScope,
} from "./export-scope.js";
import { escapeCqlValue } from "./client.js";

// ---------------------------------------------------------------------------
// Port
// ---------------------------------------------------------------------------

/** Context threaded through every port method — carries the abort signal. */
export interface TreeFetchContext {
  signal?: AbortSignal;
}

/** A reference to a node whose *children* are being requested. */
export interface TreeNodeRef {
  id: string;
  kind: "page" | "folder";
}

export interface TreeSourcePageMetadata {
  id: string;
  title: string;
  version?: number;
  labels?: string[];
  spaceKey?: string;
  /** Exact v2 `fileId` metadata, prefetched only when the ADF references media. */
  mediaAttachments?: AdfMediaAttachment[];
  mediaAttachmentsComplete?: boolean;
  mediaAttachmentsTermination?: PageAttachmentMediaTermination;
  unresolvedMediaFileIds?: string[];
  inlineComments?: InlineComment[];
  inlineCommentsComplete?: boolean;
}

/**
 * A page fetched via {@link TreeSource.getPage}.
 *
 * New sources provide an explicitly selected representation-neutral
 * `exportSource`. The Storage-only member remains accepted during the host
 * migration window so existing third-party/test ports keep compiling.
 */
export type TreeSourcePage = TreeSourcePageMetadata &
  (
    | { exportSource: ExportPageSource; storage?: string }
    | { storage: string; exportSource?: undefined }
  );

/** A lightweight version snapshot via {@link TreeSource.getPageVersion}. */
export interface TreeSourceVersion {
  version?: number;
  title: string;
}

/**
 * One child returned by {@link TreeSource.getChildren}.
 *
 * `kind` is total over the three traversal outcomes: `"page"`/`"folder"` are
 * descended, `"unsupported"` (whiteboard/database/embed — anything the source
 * reports beyond the two traversable kinds) is reported and skipped, never cast
 * into a page/folder shape. `position` carries the real UI position when the
 * listing endpoint reports one (page-under-page), else `null` (folders, and
 * page-under-folder children — sorted by title as a stable fallback).
 * `observedVersion` carries the page's version.number when the listing endpoint
 * already reports it (page-under-page via `getChildrenWithPosition`), else
 * `undefined` (page-under-folder — `fetchExportTree` backfills via
 * {@link TreeSource.getPageVersion}).
 */
export interface TreeChild {
  id: string;
  title: string;
  kind: "page" | "folder" | "unsupported";
  unsupportedKind?: string;
  position: number | null;
  observedVersion?: number;
}

/**
 * The port `fetchExportTree` fetches through. Implemented by
 * {@link confluenceTreeSource} (Node) and by in-memory sources in tests — an
 * in-memory implementation is a legitimate port, not an API mock.
 */
export interface TreeSource {
  getPage(id: string, context: TreeFetchContext): Promise<TreeSourcePage>;
  getChildren(nodeRef: TreeNodeRef, context: TreeFetchContext): Promise<TreeChild[]>;
  /** Lightweight version snapshot (no body) for the ordering-walk version check. */
  getPageVersion(id: string, context: TreeFetchContext): Promise<TreeSourceVersion>;
  /** Resolve a space's homepage id; `null` when the space has no classic homepage. */
  getSpaceHomepageId(spaceKey: string, context: TreeFetchContext): Promise<string | null>;
  /** Optional CQL label lookup used by the label filter (returns matching ids). */
  searchPages?(cql: string, context: TreeFetchContext): Promise<Array<{ id: string }>>;
}

// ---------------------------------------------------------------------------
// Node model
// ---------------------------------------------------------------------------

/** A page node: carries walked blocks and per-page notes. */
export interface ExportPageNode {
  kind: "page";
  pageId: string;
  title: string;
  /** Raw tree depth (root = 0), before any label reparenting. */
  depth: number;
  /** Depth after label-filter reparenting; what `composeChapters` uses. */
  effectiveDepth: number;
  parentId: string | null;
  position: number | null;
  blocks: ExportBlock[];
  notes: ExportNote[];
  meta: {
    version?: number;
    observedVersion?: number;
    labels: string[];
    spaceKey?: string;
  };
  /** True when this is a placeholder chapter (partial-mode unreadable page). */
  placeholder?: boolean;
}

/** A folder node: structure without a body → a chapter heading, no content. */
export interface ExportFolderNode {
  kind: "folder";
  folderId: string;
  title: string;
  depth: number;
  effectiveDepth: number;
  parentId: string | null;
  position: number | null;
}

/** Discriminated union total over `kind`; `composeChapters` switches exhaustively. */
export type ExportNode = ExportPageNode | ExportFolderNode;

/** The common id of any node, regardless of kind. */
export function nodeId(node: ExportNode): string {
  return node.kind === "page" ? node.pageId : node.folderId;
}

// ---------------------------------------------------------------------------
// Options / result / progress
// ---------------------------------------------------------------------------

/** Progress callback payload, one per fetched page body. */
export interface TreeFetchProgress {
  fetched: number;
  total: number | null;
  currentTitle: string;
}

/**
 * Completeness policy — a closed contract, not a per-caller re-litigation.
 * `strict` (default) aborts on any of the four completeness codes; `partial`
 * downgrades each to a note, sets `complete: false`, and renders a placeholder.
 */
export type CompletenessMode = "strict" | "partial";

/** Stable, lightweight identity for one body slot in the discovered manifest. */
export interface ExportTreeBodyManifestEntryV1 {
  ordinal: number;
  key: string;
  pageId: string;
  title: string;
}

/** Serializable normalized result; raw storage XHTML is deliberately absent. */
export type ExportTreeBodyResultV1 =
  | {
      ok: false;
      pageId: string;
      title: string;
      /** Present once a representation-bound body read started. */
      source?: {
        representation: PageBody["representation"];
        degraded: false;
      };
      failure: {
        code: CompletenessCode;
        affected: ReadonlyArray<{ id: string; title: string }>;
        detail?: string;
      };
    }
  | {
      ok: true;
      pageId: string;
      title: string;
      /** Body-free source telemetry retained across durable recovery. */
      source: {
        representation: PageBody["representation"];
        degraded: boolean;
      };
      blocks: ExportBlock[];
      notes: ExportNote[];
      meta: {
        version?: number;
        labels: string[];
        spaceKey?: string;
      };
    };

/**
 * Optional durable body sink used by queued exports. Direct callers omit it
 * and retain the existing in-memory result API.
 */
export interface ExportTreeBodyStoreV1 {
  /** Persist or authenticate the lightweight discovery manifest. */
  prepare(
    entries: readonly ExportTreeBodyManifestEntryV1[],
    context: { signal: AbortSignal },
  ): Promise<void>;
  /** Return a previously committed normalized slot during recovery. */
  load(
    entry: ExportTreeBodyManifestEntryV1,
    context: { signal: AbortSignal },
  ): Promise<ExportTreeBodyResultV1 | undefined>;
  /** Commit one normalized slot before it becomes visible to composition. */
  commit(
    entry: ExportTreeBodyManifestEntryV1,
    result: ExportTreeBodyResultV1,
    context: { signal: AbortSignal },
  ): Promise<void>;
}

export interface TreeFetchOptions {
  labels?: LabelFilter;
  maxPages?: number;
  maxFolders?: number;
  concurrency?: number;
  /** Processing plus ready slots; defaults to eight and must cover concurrency. */
  maxResultSlots?: number;
  /** Durable queued-export sink; omitted by legacy/direct callers. */
  bodyStore?: ExportTreeBodyStoreV1;
  completenessMode?: CompletenessMode;
  signal?: AbortSignal;
  onProgress?: (progress: TreeFetchProgress) => void;
  /** Common representation-neutral decoder options; page provenance is owned here. */
  bodyOptions?: Omit<PageBodyToBlocksOptions, "pageContext">;
  /**
   * A validated, body-free plan recovered from durable job storage. When
   * present, discovery/label reads are skipped and only the pinned page bodies
   * are fetched.
   */
  preparedPlan?: ExportTreePlanV1;
  /**
   * Called after discovery/filtering and before the first page body read. A
   * background host can atomically persist the plan and publish its ref here.
   */
  onPlanPrepared?: (plan: ExportTreePlanV1) => void | Promise<void>;
  /**
   * Called after a recovered plan passes all scope/policy/budget validation and
   * before its first page body read.
   */
  onPlanRecovered?: (plan: ExportTreePlanV1) => void | Promise<void>;
  /** Maximum serialized size accepted for a durable body-free plan. */
  maxPlanBytes?: number;
}

export type ExportTreePlanNodeV1 =
  | {
      kind: "page";
      pageId: string;
      title: string;
      depth: number;
      effectiveDepth: number;
      parentId: string | null;
      position: number | null;
      observedVersion?: number;
    }
  | {
      kind: "folder";
      folderId: string;
      title: string;
      depth: number;
      effectiveDepth: number;
      parentId: string | null;
      position: number | null;
    };

/**
 * Durable pre-body snapshot for one ordered tree export.
 *
 * It contains identifiers, titles, ordering metadata, version pins and
 * bounded diagnostics, but never ADF, Storage, decoded blocks or attachments.
 */
export interface ExportTreePlanV1 {
  schema: "atlcli.export-tree-plan/1";
  scope: ExportScope;
  policy: {
    labels?: LabelFilter;
    completenessMode: CompletenessMode;
    maxPages: number;
    maxFolders: number;
  };
  rootId: string;
  includeRoot: boolean;
  nodes: readonly ExportTreePlanNodeV1[];
  notes: readonly ExportNote[];
  complete: boolean;
}

export interface TreeSourceSummary {
  /** Pages whose version-bound body source was read, including parse failures. */
  pagesRead: number;
  representations: Readonly<Record<PageBody["representation"], number>>;
  /** Successfully decoded pages that emitted one or more degradation notes. */
  degradedPages: number;
}

export interface FetchExportTreeResult {
  nodes: readonly ExportNode[];
  notes: ExportNote[];
  /** False when partial mode downgraded a completeness failure; true otherwise. */
  complete: boolean;
  /** Aggregate only: raw ADF/Storage bodies never leave the body-fetch jobs. */
  sourceSummary: TreeSourceSummary;
}

/** Raised before body IO when a recovered tree plan is corrupt or foreign. */
export class ExportTreePlanError extends Error {
  readonly code = "export-tree-plan-invalid" as const;

  constructor(message: string) {
    super(message);
    this.name = "ExportTreePlanError";
  }
}

const DEFAULT_MAX_PAGES = 500;
const DEFAULT_MAX_FOLDERS = 200;
const DEFAULT_CONCURRENCY = 4;
const DEFAULT_MAX_PLAN_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_RESULT_SLOTS = 8;
const CQL_ID_CHUNK = 100;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** The four typed completeness codes (strict-mode aborts, partial-mode notes). */
export type CompletenessCode =
  | "page-unreadable"
  | "subtree-unreadable"
  | "page-ambiguous-404"
  | "page-version-changed";

/** Thrown in `strict` mode when a completeness failure is detected. */
export class ExportCompletenessError extends Error {
  constructor(
    public readonly code: CompletenessCode,
    public readonly affected: ReadonlyArray<{ id: string; title: string }>,
    message?: string
  ) {
    super(
      message ??
        `Export aborted (${code}): ${affected
          .map((a) => `${a.title} (${a.id})`)
          .join(", ")}. Re-run with --completeness partial to downgrade to notes.`
    );
    this.name = "ExportCompletenessError";
  }
}

/** Thrown when a hard traversal limit (maxPages/maxFolders) is exceeded. */
export class TreeLimitExceededError extends Error {
  constructor(
    public readonly code: "max-pages" | "max-folders",
    public readonly limit: number,
    message?: string
  ) {
    super(
      message ??
        (code === "max-pages"
          ? `Export exceeds the maximum of ${limit} pages. Narrow the scope with --max-depth or label filters, or raise --max-pages.`
          : `Export exceeds the maximum of ${limit} folders. Narrow the scope with --max-depth, or raise --max-folders.`)
    );
    this.name = "TreeLimitExceededError";
  }
}

/** Thrown when a label filter cannot be honored or leaves nothing to export. */
export class LabelFilterError extends Error {
  constructor(
    public readonly code: "empty-include-result" | "labels-unavailable",
    message: string
  ) {
    super(message);
    this.name = "LabelFilterError";
  }
}

/** Thrown when a space scope resolves to a space with no classic homepage. */
export class SpaceHomepageError extends Error {
  constructor(public readonly spaceKey: string) {
    super(
      `Space "${spaceKey}" has no classic homepage to use as the export root ` +
        `(folder-only space root). Export a specific page tree with --scope tree instead.`
    );
    this.name = "SpaceHomepageError";
  }
}

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

/** Extract an HTTP status from a thrown error (`.status` or `(NNN)` in message). */
function errorStatus(error: unknown): number | undefined {
  if (error && typeof error === "object" && "status" in error) {
    const status = (error as { status?: unknown }).status;
    if (typeof status === "number") return status;
  }
  const message = error instanceof Error ? error.message : String(error);
  const match = message.match(/\((\d{3})\)/);
  return match ? Number.parseInt(match[1]!, 10) : undefined;
}

function isUnreadable(status: number | undefined): boolean {
  return status === 401 || status === 403;
}
function isAmbiguous404(status: number | undefined): boolean {
  return status === 404;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  signal?.throwIfAborted();
}

// ---------------------------------------------------------------------------
// Label filter (pure decision logic)
// ---------------------------------------------------------------------------

/** Options for {@link applyLabelFilter}. */
export interface ApplyLabelFilterOptions {
  /**
   * The id of the export root **present in `nodes`** that the root-bypass rule
   * protects. Three states:
   * - a string: that node (and only that node) is immune to the label filter
   *   (`root-filter-bypassed` note when it would have been removed);
   * - `null`: NO node gets the immunity — the caller removed the true root by
   *   explicit request (`includeRoot: false`), so the top-level survivors are
   *   ordinary siblings, not "the root" (a first-positioned sibling must not be
   *   accidentally immunized against an exclude — that would ship a body the
   *   user explicitly excluded);
   * - omitted: the first node is assumed to be the root (single-root pre-order
   *   list, the common standalone-call shape).
   */
  rootId?: string | null;
}

/** Composite node key, same scheme as the walk's cycle guard ("kind:id"). */
function nodeKey(node: ExportNode): string {
  return `${node.kind}:${nodeId(node)}`;
}

/**
 * Apply a label filter to an ordered node list. **Pure** functional core —
 * takes the nodes, a map of node id → its labels, and the filter; returns the
 * surviving, reparented nodes plus notes. `fetchExportTree` runs this *before*
 * body fetch so pruned pages are never loaded.
 *
 * Semantics (see PLAN.md Root & filter):
 * - `exclude` (OR): a node with any exclude label is removed. `prune-subtree`
 *   removes its descendants too; `page-only` reparents survivors.
 * - `include` (OR, page-only): a node with no include label is removed and its
 *   surviving children reparented. Folders (no labels) never match include.
 * - The export **root** is never removed by a label filter — kept as structure
 *   with a `root-filter-bypassed` note. Which node is the root comes from
 *   {@link ApplyLabelFilterOptions.rootId}; when the caller already removed the
 *   root via `includeRoot: false` it passes `rootId: null` and no node is
 *   immunized.
 * - Removed nodes' surviving children reparent to the nearest surviving ancestor
 *   with `effectiveDepth = ancestor.effectiveDepth + 1` (0 if none survives).
 * - An `include` that matches no node → {@link LabelFilterError}.
 *
 * Internal bookkeeping is keyed on the composite `"kind:id"` key (same scheme
 * as the traversal cycle guard) so a page and a folder sharing an underlying
 * content id can never alias each other's removal/reparenting state.
 */
export function applyLabelFilter(
  nodes: readonly ExportNode[],
  labelsById: ReadonlyMap<string, readonly string[]>,
  filter: LabelFilter,
  options: ApplyLabelFilterOptions = {}
): { nodes: ExportNode[]; notes: ExportNote[] } {
  const normalized = normalizeLabelFilter(filter);
  const notes: ExportNote[] = [];
  if (!normalized || nodes.length === 0) {
    return { nodes: nodes.map((n) => ({ ...n })), notes };
  }
  const include = normalized.include;
  const exclude = normalized.exclude;
  const excludeMode = normalized.excludeMode ?? "prune-subtree";

  // Which node (if any) is protected by the root-bypass rule. `null` means the
  // caller removed the true root by explicit request — no protection for the
  // remaining top-level siblings.
  const rootId: string | null =
    options.rootId === undefined ? nodeId(nodes[0]!) : options.rootId;

  // Composite-key bookkeeping ("kind:id", the cycle guard's scheme). `parentId`
  // references are raw ids, so keep a raw-id → key map for ancestor hops.
  const keyByRawId = new Map<string, string>();
  for (const node of nodes) {
    const raw = nodeId(node);
    if (!keyByRawId.has(raw)) keyByRawId.set(raw, nodeKey(node));
  }
  const parentKeyByKey = new Map<string, string | null>();
  const rawIdByKey = new Map<string, string>();
  for (const node of nodes) {
    const key = nodeKey(node);
    rawIdByKey.set(key, nodeId(node));
    parentKeyByKey.set(
      key,
      node.parentId === null ? null : (keyByRawId.get(node.parentId) ?? null)
    );
  }

  const matches = (id: string, list: string[] | undefined): boolean => {
    if (!list || list.length === 0) return false;
    const labels = labelsById.get(id) ?? [];
    return labels.some((label) => list.includes(label));
  };

  const removed = new Set<string>();
  const pruneRoots = new Set<string>();
  let includeMatchCount = 0;

  for (const node of nodes) {
    const id = nodeId(node);
    const key = nodeKey(node);
    const isRoot = rootId !== null && id === rootId;
    if (include && matches(id, include)) includeMatchCount += 1;

    let remove = false;
    let prune = false;
    if (exclude && matches(id, exclude)) {
      remove = true;
      if (excludeMode === "prune-subtree") prune = true;
    }
    if (include && !matches(id, include)) {
      remove = true; // include is page-only, never prunes the subtree
    }
    if (remove && isRoot) {
      // The root is never removed by a label filter — keep it as structure.
      notes.push({
        level: "info",
        code: "root-filter-bypassed",
        message: `The export root "${node.title}" would be excluded by the label filter but was kept as structure (a tree/space export with no top-level chapter reads as broken).`,
      });
      remove = false;
      prune = false;
    }
    if (remove) removed.add(key);
    if (prune) pruneRoots.add(key);
  }

  // Expand prune-subtree removals to all descendants: a node is removed when any
  // ancestor is a prune root (the prune roots themselves are already removed).
  if (pruneRoots.size > 0) {
    for (const node of nodes) {
      let ancestorKey = parentKeyByKey.get(nodeKey(node)) ?? null;
      while (ancestorKey !== null) {
        if (pruneRoots.has(ancestorKey)) {
          removed.add(nodeKey(node));
          break;
        }
        ancestorKey = parentKeyByKey.get(ancestorKey) ?? null;
      }
    }
  }

  if (include && includeMatchCount === 0) {
    throw new LabelFilterError(
      "empty-include-result",
      `No page matched the include label filter (${include.join(", ")}); nothing to export.`
    );
  }

  // Build surviving nodes with reparenting + effectiveDepth (pre-order ensures
  // an ancestor's effectiveDepth is computed before its descendants').
  const surviving = new Set<string>();
  for (const node of nodes) {
    if (!removed.has(nodeKey(node))) surviving.add(nodeKey(node));
  }
  const effectiveDepthByKey = new Map<string, number>();
  const out: ExportNode[] = [];
  let removedPageCount = 0;
  for (const node of nodes) {
    const key = nodeKey(node);
    if (!surviving.has(key)) {
      if (node.kind === "page") removedPageCount += 1;
      continue;
    }
    let ancestorKey = parentKeyByKey.get(key) ?? null;
    while (ancestorKey !== null && !surviving.has(ancestorKey)) {
      ancestorKey = parentKeyByKey.get(ancestorKey) ?? null;
    }
    const effectiveDepth =
      ancestorKey === null ? 0 : (effectiveDepthByKey.get(ancestorKey) ?? 0) + 1;
    effectiveDepthByKey.set(key, effectiveDepth);
    out.push({
      ...node,
      parentId: ancestorKey === null ? null : (rawIdByKey.get(ancestorKey) ?? null),
      effectiveDepth,
    });
  }

  if (removedPageCount > 0) {
    notes.push({
      level: "info",
      code: "label-filtered",
      message: `${removedPageCount} page${removedPageCount === 1 ? "" : "s"} omitted by the label filter.`,
    });
  }

  return { nodes: out, notes };
}

// ---------------------------------------------------------------------------
// Ordering walk + fetch
// ---------------------------------------------------------------------------

/** Comparator matching `getChildrenWithPosition`: positions first, then title. */
function compareChildren(a: TreeChild, b: TreeChild): number {
  if (a.position !== null && b.position !== null) return a.position - b.position;
  if (a.position !== null) return -1;
  if (b.position !== null) return 1;
  return a.title.localeCompare(b.title);
}

function normalizedScopeKey(scope: ExportScope): string {
  try {
    validateExportScope(scope);
    switch (scope.kind) {
      case "page":
        return JSON.stringify(["page", scope.pageId]);
      case "tree":
        if (scope.includeRoot !== undefined && typeof scope.includeRoot !== "boolean") {
          throw new TypeError("invalid includeRoot");
        }
        return JSON.stringify([
          "tree",
          scope.rootPageId,
          scope.includeRoot ?? true,
          scope.maxDepth ?? null,
        ]);
      case "space":
        return JSON.stringify(["space", scope.spaceKey]);
    }
  } catch {
    throw new ExportTreePlanError("Recovered export tree plan contains an invalid scope.");
  }
}

function clonePlanScope(scope: ExportScope): ExportScope {
  switch (scope.kind) {
    case "page":
      return { kind: "page", pageId: scope.pageId };
    case "tree":
      return {
        kind: "tree",
        rootPageId: scope.rootPageId,
        ...(scope.includeRoot !== undefined ? { includeRoot: scope.includeRoot } : {}),
        ...(scope.maxDepth !== undefined ? { maxDepth: scope.maxDepth } : {}),
      };
    case "space":
      return { kind: "space", spaceKey: scope.spaceKey };
  }
}

function normalizedLabelKey(filter: LabelFilter | undefined): string {
  const normalized = normalizeLabelFilter(filter);
  return JSON.stringify({
    include: [...(normalized?.include ?? [])].sort(),
    exclude: [...(normalized?.exclude ?? [])].sort(),
    excludeMode: normalized?.excludeMode ?? null,
  });
}

function clonePlanLabels(filter: LabelFilter | undefined): LabelFilter | undefined {
  const normalized = normalizeLabelFilter(filter);
  if (!normalized) return undefined;
  return {
    ...(normalized.include ? { include: [...normalized.include].sort() } : {}),
    ...(normalized.exclude ? { exclude: [...normalized.exclude].sort() } : {}),
    ...(normalized.excludeMode ? { excludeMode: normalized.excludeMode } : {}),
  };
}

function clonePlanNote(note: ExportNote): ExportNote {
  return {
    level: note.level,
    code: note.code,
    message: note.message,
    ...(note.macroName !== undefined ? { macroName: note.macroName } : {}),
    ...(note.source
      ? {
          source: {
            ...(note.source.pageId !== undefined ? { pageId: note.source.pageId } : {}),
            ...(note.source.pageTitle !== undefined ? { pageTitle: note.source.pageTitle } : {}),
            ...(note.source.pageUrl !== undefined ? { pageUrl: note.source.pageUrl } : {}),
            ...(note.source.blockPath !== undefined ? { blockPath: note.source.blockPath } : {}),
            ...(note.source.assetName !== undefined ? { assetName: note.source.assetName } : {}),
          },
        }
      : {}),
  };
}

function createTreePlan(
  scope: ExportScope,
  rootId: string,
  includeRoot: boolean,
  nodes: readonly ExportNode[],
  notes: readonly ExportNote[],
  complete: boolean,
  policy: {
    labels?: LabelFilter;
    completenessMode: CompletenessMode;
    maxPages: number;
    maxFolders: number;
  },
): ExportTreePlanV1 {
  const labels = clonePlanLabels(policy.labels);
  return {
    schema: "atlcli.export-tree-plan/1",
    scope: clonePlanScope(scope),
    policy: {
      ...(labels ? { labels } : {}),
      completenessMode: policy.completenessMode,
      maxPages: policy.maxPages,
      maxFolders: policy.maxFolders,
    },
    rootId,
    includeRoot,
    nodes: nodes.map((node): ExportTreePlanNodeV1 =>
      node.kind === "page"
        ? {
            kind: "page",
            pageId: node.pageId,
            title: node.title,
            depth: node.depth,
            effectiveDepth: node.effectiveDepth,
            parentId: node.parentId,
            position: node.position,
            ...(node.meta.observedVersion !== undefined
              ? { observedVersion: node.meta.observedVersion }
              : {}),
          }
        : {
            kind: "folder",
            folderId: node.folderId,
            title: node.title,
            depth: node.depth,
            effectiveDepth: node.effectiveDepth,
            parentId: node.parentId,
            position: node.position,
          },
    ),
    notes: notes.map(clonePlanNote),
    complete,
  };
}

function assertPlanInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ExportTreePlanError(`${label} must be a non-negative safe integer.`);
  }
}

function assertPlanByteBudget(plan: ExportTreePlanV1, maxPlanBytes: number): void {
  if (!Number.isSafeInteger(maxPlanBytes) || maxPlanBytes < 1) {
    throw new ExportTreePlanError("maxPlanBytes must be a positive safe integer.");
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(plan);
  } catch {
    throw new ExportTreePlanError("Recovered export tree plan is not serializable.");
  }
  if (new TextEncoder().encode(serialized).byteLength > maxPlanBytes) {
    throw new ExportTreePlanError("Export tree plan exceeds the durable byte budget.");
  }
}

function restoreTreePlan(
  plan: ExportTreePlanV1,
  scope: ExportScope,
  expected: {
    labels?: LabelFilter;
    completenessMode: CompletenessMode;
    maxPages: number;
    maxFolders: number;
  },
): { rootId: string; includeRoot: boolean; nodes: ExportNode[]; notes: ExportNote[]; complete: boolean } {
  if (plan.schema !== "atlcli.export-tree-plan/1") {
    throw new ExportTreePlanError("Unsupported export tree plan schema.");
  }
  if (normalizedScopeKey(plan.scope) !== normalizedScopeKey(scope)) {
    throw new ExportTreePlanError("Recovered export tree plan does not match the requested scope.");
  }
  if (
    !plan.policy ||
    typeof plan.policy !== "object" ||
    plan.policy.completenessMode !== expected.completenessMode ||
    plan.policy.maxPages !== expected.maxPages ||
    plan.policy.maxFolders !== expected.maxFolders ||
    normalizedLabelKey(plan.policy.labels) !== normalizedLabelKey(expected.labels)
  ) {
    throw new ExportTreePlanError("Recovered export tree plan policy does not match the request.");
  }
  if (typeof plan.rootId !== "string" || plan.rootId.trim().length === 0) {
    throw new ExportTreePlanError("Recovered export tree plan has no root id.");
  }
  if (
    (scope.kind === "page" && plan.rootId !== scope.pageId) ||
    (scope.kind === "tree" && plan.rootId !== scope.rootPageId)
  ) {
    throw new ExportTreePlanError("Recovered export tree plan root does not match the request.");
  }
  const expectedIncludeRoot = scope.kind === "tree" ? (scope.includeRoot ?? true) : true;
  if (plan.includeRoot !== expectedIncludeRoot || typeof plan.complete !== "boolean") {
    throw new ExportTreePlanError("Recovered export tree plan flags do not match the request.");
  }
  if (!Array.isArray(plan.nodes) || !Array.isArray(plan.notes)) {
    throw new ExportTreePlanError("Recovered export tree plan collections are invalid.");
  }

  let pages = 0;
  let folders = 0;
  const seen = new Set<string>();
  const nodes = plan.nodes.map((node): ExportNode => {
    if (!node || typeof node !== "object") {
      throw new ExportTreePlanError("Recovered export tree plan contains an invalid node.");
    }
    const id = node.kind === "page" ? node.pageId : node.kind === "folder" ? node.folderId : undefined;
    if (typeof id !== "string" || id.trim().length === 0 || typeof node.title !== "string") {
      throw new ExportTreePlanError("Recovered export tree plan contains invalid node identity.");
    }
    const key = `${node.kind}:${id}`;
    if (seen.has(key)) throw new ExportTreePlanError("Recovered export tree plan contains duplicate nodes.");
    seen.add(key);
    assertPlanInteger(node.depth, "node.depth");
    assertPlanInteger(node.effectiveDepth, "node.effectiveDepth");
    if (node.parentId !== null && typeof node.parentId !== "string") {
      throw new ExportTreePlanError("Recovered export tree plan contains an invalid parent id.");
    }
    if (node.position !== null) assertPlanInteger(node.position, "node.position");

    if (node.kind === "page") {
      pages += 1;
      if (pages > expected.maxPages) {
        throw new ExportTreePlanError("Recovered export tree plan exceeds the page limit.");
      }
      if (
        node.observedVersion !== undefined &&
        (!Number.isSafeInteger(node.observedVersion) || node.observedVersion < 1)
      ) {
        throw new ExportTreePlanError("Recovered export tree plan contains an invalid page version.");
      }
      return {
        kind: "page",
        pageId: node.pageId,
        title: node.title,
        depth: node.depth,
        effectiveDepth: node.effectiveDepth,
        parentId: node.parentId,
        position: node.position,
        blocks: [],
        notes: [],
        meta: {
          labels: [],
          ...(node.observedVersion !== undefined
            ? { observedVersion: node.observedVersion }
            : {}),
        },
      };
    }

    folders += 1;
    if (folders > expected.maxFolders) {
      throw new ExportTreePlanError("Recovered export tree plan exceeds the folder limit.");
    }
    return {
      kind: "folder",
      folderId: node.folderId,
      title: node.title,
      depth: node.depth,
      effectiveDepth: node.effectiveDepth,
      parentId: node.parentId,
      position: node.position,
    };
  });

  const notes = plan.notes.map((note) => {
    const source = note?.source;
    if (
      !note ||
      typeof note !== "object" ||
      (note.level !== "info" && note.level !== "warning") ||
      typeof note.code !== "string" ||
      canonicalExportNoteCode(note.code) === undefined ||
      typeof note.message !== "string" ||
      (note.macroName !== undefined && typeof note.macroName !== "string") ||
      (source !== undefined &&
        (typeof source !== "object" || source === null ||
          [source.pageId, source.pageTitle, source.pageUrl, source.blockPath, source.assetName]
            .some((value) => value !== undefined && typeof value !== "string")))
    ) {
      throw new ExportTreePlanError("Recovered export tree plan contains an invalid note.");
    }
    return clonePlanNote(note);
  });
  return { rootId: plan.rootId, includeRoot: plan.includeRoot, nodes, notes, complete: plan.complete };
}

/**
 * Fetch an ordered export tree for a scope.
 *
 * Phase 1 (sequential): pre-order DFS discovers every node, captures positions
 * and version snapshots, and enforces cycle/depth/count guards.
 * Phase 2 (pure): the label filter prunes + reparents *before* any body fetch.
 * Phase 3 (bounded): surviving page bodies are fetched through a deterministic
 * sliding window and walked into blocks. Queued hosts may commit each normalized
 * slot to a durable body store before composition; direct callers retain the
 * same in-memory result contract.
 */
export async function fetchExportTree(
  source: TreeSource,
  scope: ExportScope,
  opts: TreeFetchOptions = {}
): Promise<FetchExportTreeResult> {
  const signal = opts.signal;
  const context: TreeFetchContext = { signal };
  const maxPages = opts.maxPages ?? DEFAULT_MAX_PAGES;
  const maxFolders = opts.maxFolders ?? DEFAULT_MAX_FOLDERS;
  const concurrency = opts.concurrency ?? DEFAULT_CONCURRENCY;
  const maxPlanBytes = opts.maxPlanBytes ?? DEFAULT_MAX_PLAN_BYTES;
  const maxResultSlots = opts.maxResultSlots ?? DEFAULT_MAX_RESULT_SLOTS;
  const mode: CompletenessMode = opts.completenessMode ?? "strict";
  const filter = normalizeLabelFilter(opts.labels);
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
    throw new RangeError("Tree fetch concurrency must be a positive safe integer.");
  }
  if (!Number.isSafeInteger(maxResultSlots) || maxResultSlots < concurrency) {
    throw new RangeError(
      "Tree fetch maxResultSlots must be a safe integer greater than or equal to concurrency.",
    );
  }

  const treeNotes: ExportNote[] = [];
  let complete = true;
  if (opts.preparedPlan) assertPlanByteBudget(opts.preparedPlan, maxPlanBytes);
  const recoveredPlan = opts.preparedPlan
    ? restoreTreePlan(opts.preparedPlan, scope, {
        ...(filter ? { labels: filter } : {}),
        completenessMode: mode,
        maxPages,
        maxFolders,
      })
    : undefined;
  if (recoveredPlan) {
    treeNotes.push(...recoveredPlan.notes);
    complete = recoveredPlan.complete;
  }

  // Resolve the scope root + includeRoot.
  let rootId: string;
  let includeRoot = true;
  let maxDepth: number | undefined;
  if (recoveredPlan) {
    rootId = recoveredPlan.rootId;
    includeRoot = recoveredPlan.includeRoot;
    maxDepth = scope.kind === "tree" ? scope.maxDepth : scope.kind === "page" ? 0 : undefined;
  } else if (scope.kind === "page") {
    rootId = scope.pageId;
    // A page scope is exactly one page — never descend into children.
    maxDepth = 0;
  } else if (scope.kind === "tree") {
    rootId = scope.rootPageId;
    includeRoot = scope.includeRoot ?? true;
    maxDepth = scope.maxDepth;
  } else {
    const resolved = await source.getSpaceHomepageId(scope.spaceKey, context);
    if (!resolved) throw new SpaceHomepageError(scope.spaceKey);
    rootId = resolved;
  }

  // ---- Phase 1: ordering walk ----
  const planned: ExportNode[] = recoveredPlan?.nodes ?? [];
  const visited = new Set<string>();
  let pageCount = 0;
  let folderCount = 0;

  const partialComplete = (): void => {
    complete = false;
  };

  const walk = async (
    ref: TreeNodeRef,
    depth: number,
    parentId: string | null,
    position: number | null,
    knownTitle: string | undefined,
    observedVersion: number | undefined
  ): Promise<void> => {
    throwIfAborted(signal);
    const key = `${ref.kind}:${ref.id}`;
    if (visited.has(key)) {
      treeNotes.push({
        level: "warning",
        code: "tree-cycle",
        message: `Cycle detected at ${ref.kind} ${ref.id}; the repeated node was skipped.`,
      });
      return;
    }
    visited.add(key);

    if (ref.kind === "page") {
      pageCount += 1;
      if (pageCount > maxPages) throw new TreeLimitExceededError("max-pages", maxPages);
    } else {
      folderCount += 1;
      if (folderCount > maxFolders) throw new TreeLimitExceededError("max-folders", maxFolders);
    }

    // Build the node. For page nodes without a version/title yet (scope root or
    // page-under-folder children), backfill a lightweight snapshot now so the
    // page-version-changed check is enforceable for every node kind.
    if (ref.kind === "page") {
      let title = knownTitle;
      let version = observedVersion;
      if (title === undefined || version === undefined) {
        const snapshot = await source.getPageVersion(ref.id, context);
        if (title === undefined) title = snapshot.title;
        if (version === undefined) version = snapshot.version;
      }
      planned.push({
        kind: "page",
        pageId: ref.id,
        title: title ?? ref.id,
        depth,
        effectiveDepth: depth,
        parentId,
        position,
        blocks: [],
        notes: [],
        meta: { observedVersion: version, labels: [] },
      });
    } else {
      planned.push({
        kind: "folder",
        folderId: ref.id,
        title: knownTitle ?? ref.id,
        depth,
        effectiveDepth: depth,
        parentId,
        position,
      });
    }

    // Depth cut: do not descend below maxDepth (root = depth 0).
    if (maxDepth !== undefined && depth >= maxDepth) return;

    // Discover children. A 401/403 here is a subtree-unreadable completeness event.
    let children: TreeChild[];
    try {
      children = await source.getChildren({ id: ref.id, kind: ref.kind }, context);
    } catch (error) {
      throwIfAborted(signal);
      const status = errorStatus(error);
      if (isUnreadable(status)) {
        const affected = [{ id: ref.id, title: knownTitle ?? ref.id }];
        if (mode === "strict") throw new ExportCompletenessError("subtree-unreadable", affected);
        treeNotes.push({
          level: "warning",
          code: "subtree-unreadable",
          message: `Children of "${knownTitle ?? ref.id}" (${ref.id}) could not be read (${status}); the subtree was omitted.`,
        });
        partialComplete();
        return;
      }
      throw error;
    }

    const sorted = [...children].sort(compareChildren);
    for (const child of sorted) {
      throwIfAborted(signal);
      if (child.kind === "unsupported") {
        treeNotes.push({
          // `warning`, not `info`: content the user asked for is being DROPPED
          // from the export. Once note levels drive issue severity (and with it
          // `--strict`'s exit code), classifying a silent content loss as
          // informational is exactly the false negative `--strict` exists to
          // prevent. Contrast `label-filtered`, which is info because the user
          // explicitly asked for that exclusion.
          level: "warning",
          code: "unsupported-child-type",
          message: `Child "${child.title}" (${child.id}) is an unsupported type "${child.unsupportedKind ?? "unknown"}" and was skipped.`,
        });
        continue;
      }
      if (child.kind === "folder") {
        treeNotes.push({
          level: "info",
          code: "folder-position-unknown",
          message: `Folder "${child.title}" (${child.id}) has no UI position; ordered by title.`,
        });
      }
      await walk(
        { id: child.id, kind: child.kind },
        depth + 1,
        ref.id,
        child.position,
        child.title,
        child.observedVersion
      );
    }
  };

  if (!recoveredPlan && includeRoot) {
    await walk({ id: rootId, kind: "page" }, 0, null, null, undefined, undefined);
  } else if (!recoveredPlan) {
    // Root excluded by explicit request: discover the root's children as the
    // top-level nodes (each becomes its own level-1 chapter). Seed the root's
    // composite key into the cycle guard even though the root is never emitted —
    // otherwise a (buggy/adversarial) source with a cycle back to the root would
    // re-list the root's children once and emit a duplicate node before the
    // guard fires.
    visited.add(`page:${rootId}`);
    throwIfAborted(signal);
    let children: TreeChild[];
    try {
      children = await source.getChildren({ id: rootId, kind: "page" }, context);
    } catch (error) {
      const status = errorStatus(error);
      if (isUnreadable(status)) {
        const affected = [{ id: rootId, title: rootId }];
        if (mode === "strict") throw new ExportCompletenessError("subtree-unreadable", affected);
        treeNotes.push({
          level: "warning",
          code: "subtree-unreadable",
          message: `Children of the export root (${rootId}) could not be read (${status}).`,
        });
        partialComplete();
        children = [];
      } else {
        throw error;
      }
    }
    for (const child of [...children].sort(compareChildren)) {
      if (child.kind === "unsupported") {
        treeNotes.push({
          // `warning`, not `info`: content the user asked for is being DROPPED
          // from the export. Once note levels drive issue severity (and with it
          // `--strict`'s exit code), classifying a silent content loss as
          // informational is exactly the false negative `--strict` exists to
          // prevent. Contrast `label-filtered`, which is info because the user
          // explicitly asked for that exclusion.
          level: "warning",
          code: "unsupported-child-type",
          message: `Child "${child.title}" (${child.id}) is an unsupported type "${child.unsupportedKind ?? "unknown"}" and was skipped.`,
        });
        continue;
      }
      if (child.kind === "folder") {
        treeNotes.push({
          level: "info",
          code: "folder-position-unknown",
          message: `Folder "${child.title}" (${child.id}) has no UI position; ordered by title.`,
        });
      }
      await walk(
        { id: child.id, kind: child.kind },
        0,
        null,
        child.position,
        child.title,
        child.observedVersion
      );
    }
  }

  // ---- Phase 2: label filter (before body fetch) ----
  let nodes: ExportNode[] = planned;
  if (!recoveredPlan && filter) {
    if (opts.onPlanPrepared && !source.searchPages) {
      throw new ExportTreePlanError(
        "Durable tree planning requires metadata-only label lookup before body reads.",
      );
    }
    const labelsById = await resolveLabels(source, nodes, filter, context);
    // Root-bypass immunity applies only when the true root is actually in the
    // node list. With `includeRoot: false` the root was removed by explicit
    // request — the surviving top-level siblings are ordinary nodes and MUST
    // remain excludable (rootId: null disables the bypass entirely).
    const filtered = applyLabelFilter(nodes, labelsById, filter, {
      rootId: includeRoot ? rootId : null,
    });
    nodes = filtered.nodes;
    treeNotes.push(...filtered.notes);
  }

  if (!recoveredPlan && opts.onPlanPrepared) {
    const plan = createTreePlan(scope, rootId, includeRoot, nodes, treeNotes, complete, {
      ...(filter ? { labels: filter } : {}),
      completenessMode: mode,
      maxPages,
      maxFolders,
    });
    assertPlanByteBudget(plan, maxPlanBytes);
    await opts.onPlanPrepared(plan);
    throwIfAborted(signal);
  }
  if (recoveredPlan && opts.onPlanRecovered) {
    await opts.onPlanRecovered(opts.preparedPlan!);
    throwIfAborted(signal);
  }

  // ---- Phase 3: bounded body window (page nodes only, in pre-order slots) ----
  const pageNodes = nodes.filter((n): n is ExportPageNode => n.kind === "page");
  const total = pageNodes.length;
  let fetched = 0;
  const manifestEntries: ExportTreeBodyManifestEntryV1[] = pageNodes.map(
    (node, ordinal) => ({
      ordinal,
      pageId: node.pageId,
      title: node.title,
      key: JSON.stringify([
        node.pageId,
        node.title,
        node.meta.observedVersion ?? null,
        node.depth,
        node.effectiveDepth,
        node.parentId,
        node.position,
      ]),
    }),
  );

  const bodyController = new AbortController();
  const abortBodies = (): void => bodyController.abort(signal?.reason);
  if (signal?.aborted) abortBodies();
  else signal?.addEventListener("abort", abortBodies, { once: true });
  const bodyContext: TreeFetchContext = { signal: bodyController.signal };

  type BodyOutcome =
    | {
        ordinal: number;
        result: ExportTreeBodyResultV1;
        recovered: boolean;
      }
    | { ordinal: number; error: unknown };

  const representationCounts: Record<PageBody["representation"], number> = {
    atlas_doc_format: 0,
    storage: 0,
  };
  let pagesRead = 0;
  let degradedPages = 0;

  const recordSource = (result: ExportTreeBodyResultV1): void => {
    if (!result.source) return;
    representationCounts[result.source.representation] += 1;
    pagesRead += 1;
    if (result.source.degraded) degradedPages += 1;
  };

  const applySuccess = (
    node: ExportPageNode,
    result: Extract<ExportTreeBodyResultV1, { ok: true }>,
  ): void => {
    if (result.pageId !== node.pageId || result.title !== node.title) {
      throw new Error("Tree body result identity does not match its manifest slot.");
    }
    node.blocks = result.blocks;
    node.notes = result.notes;
    node.meta.version = result.meta.version;
    node.meta.labels = result.meta.labels;
    node.meta.spaceKey = result.meta.spaceKey;
  };

  const applyPartialFailure = (
    node: ExportPageNode,
    result: Extract<ExportTreeBodyResultV1, { ok: false }>,
  ): void => {
    node.placeholder = true;
    node.blocks = [
      {
        type: "paragraph",
        content: [
          {
            type: "text",
            text: `[Content unavailable: ${node.title} (${result.failure.code})]`,
          },
        ],
      },
    ];
    treeNotes.push({
      level: "warning",
      code: result.failure.code,
      message:
        `${result.failure.affected.map((affected) => `${affected.title} (${affected.id})`).join(", ")} could not be exported ` +
        `(${result.failure.code}${result.failure.detail ? `: ${result.failure.detail}` : ""}); a placeholder chapter was rendered.`,
    });
    partialComplete();
  };

  const processBody = async (ordinal: number): Promise<BodyOutcome> => {
    const node = pageNodes[ordinal]!;
    const entry = manifestEntries[ordinal]!;
    try {
      throwIfAborted(bodyController.signal);
      const recovered = await opts.bodyStore?.load(entry, {
        signal: bodyController.signal,
      });
      if (recovered) return { ordinal, result: recovered, recovered: true };

      let page: TreeSourcePage;
      try {
        page = await source.getPage(node.pageId, bodyContext);
      } catch (error) {
        throwIfAborted(bodyController.signal);
        const status = errorStatus(error);
        const affected = [{ id: node.pageId, title: node.title }];
        if (isUnreadable(status) || isAmbiguous404(status)) {
          return {
            ordinal,
            recovered: false,
            result: {
              ok: false,
              pageId: node.pageId,
              title: node.title,
              failure: {
                code: isUnreadable(status)
                  ? "page-unreadable"
                  : "page-ambiguous-404",
                affected,
              },
            },
          };
        }
        throw error;
      }

      const exportSource: ExportPageSource = page.exportSource ?? {
        primary: { representation: "storage", value: page.storage },
        ...(page.version !== undefined ? { sourceVersion: page.version } : {}),
      };
      const bodyVersion = exportSource.sourceVersion ?? page.version;
      if (
        node.meta.observedVersion !== undefined &&
        bodyVersion !== undefined &&
        bodyVersion !== node.meta.observedVersion
      ) {
        return {
          ordinal,
          recovered: false,
          result: {
            ok: false,
            pageId: node.pageId,
            title: node.title,
            failure: {
              code: "page-version-changed",
              affected: [{ id: node.pageId, title: node.title }],
            },
            source: {
              representation: exportSource.primary.representation,
              degraded: false,
            },
          },
        };
      }

      let decoded: BlocksResult;
      try {
        decoded = pageBodyToBlocks(exportSource, {
          ...opts.bodyOptions,
          resolveMediaAttachment:
            createAdfMediaAttachmentResolver(page.mediaAttachments) ??
            opts.bodyOptions?.resolveMediaAttachment,
          resolveAnnotation:
            createAdfAnnotationResolver(page.inlineComments) ??
            opts.bodyOptions?.resolveAnnotation,
          annotationCommentsComplete:
            page.inlineCommentsComplete ?? opts.bodyOptions?.annotationCommentsComplete,
          pageContext: {
            id: node.pageId,
            title: node.title,
            ...(bodyVersion !== undefined ? { version: bodyVersion } : {}),
            ...(page.spaceKey !== undefined ? { spaceKey: page.spaceKey } : {}),
          },
        });
      } catch (error) {
        // A page whose selected body blows a validation/parse budget is
        // UNREADABLE, not fatal
        // to the run (spec 011). Left uncaught this rejected the job, and the
        // rejection scan below re-throws it — so one pathological page aborted
        // the entire tree export. Routing it through the existing completeness
        // path means strict mode still aborts (the user asked for completeness)
        // while partial mode renders a placeholder chapter and keeps going,
        // which is exactly what the budget's own docs promise.
        if (!(error instanceof StorageParseError) && !(error instanceof AdfValidationError)) {
          throw error;
        }
        throwIfAborted(bodyController.signal);
        const representation = exportSource.primary.representation;
        const detail = error instanceof StorageParseError
          ? `storage exceeded the parse budget: ${error.kind}`
          : `ADF validation failed: ${error.code}`;
        return {
          ordinal,
          recovered: false,
          result: {
            ok: false,
            pageId: node.pageId,
            title: node.title,
            failure: {
              code: "page-unreadable",
              affected: [{ id: node.pageId, title: node.title }],
              detail,
            },
            source: { representation, degraded: false },
          },
        };
      }
      return {
        ordinal,
        recovered: false,
        result: {
          ok: true,
          pageId: node.pageId,
          title: node.title,
          source: {
            representation:
              decoded.representation ?? exportSource.primary.representation,
            degraded: decoded.degraded === true,
          },
          blocks: decoded.blocks,
          notes: decoded.notes,
          meta: {
            ...(bodyVersion === undefined ? {} : { version: bodyVersion }),
            labels: page.labels ?? [],
            ...(page.spaceKey === undefined ? {} : { spaceKey: page.spaceKey }),
          },
        },
      };
    } catch (error) {
      return { ordinal, error };
    }
  };

  const active = new Map<number, Promise<BodyOutcome>>();
  const ready = new Map<number, BodyOutcome>();
  let nextStart = 0;
  let nextCommit = 0;
  const startBodies = (): void => {
    while (
      nextStart < total &&
      active.size < concurrency &&
      active.size + ready.size < maxResultSlots
    ) {
      const ordinal = nextStart;
      nextStart += 1;
      active.set(ordinal, processBody(ordinal));
    }
  };

  try {
    await opts.bodyStore?.prepare(manifestEntries, {
      signal: bodyController.signal,
    });
    while (nextCommit < total) {
      throwIfAborted(bodyController.signal);
      startBodies();
      const current = ready.get(nextCommit);
      if (!current) {
        if (active.size === 0) {
          throw new Error("Tree body window made no progress.");
        }
        const settled = await Promise.race(active.values());
        active.delete(settled.ordinal);
        ready.set(settled.ordinal, settled);
        continue;
      }
      if ("error" in current) throw current.error;

      const node = pageNodes[nextCommit]!;
      if (!current.result.ok && mode === "strict") {
        throw new ExportCompletenessError(
          current.result.failure.code,
          current.result.failure.affected,
        );
      }
      if (opts.bodyStore && !current.recovered) {
        await opts.bodyStore.commit(
          manifestEntries[nextCommit]!,
          current.result,
          { signal: bodyController.signal },
        );
      }
      if (current.result.ok) {
        fetched += 1;
        opts.onProgress?.({
          fetched,
          total,
          currentTitle: current.result.title,
        });
      }
      if (!opts.bodyStore) {
        recordSource(current.result);
        if (current.result.ok) applySuccess(node, current.result);
        else applyPartialFailure(node, current.result);
      }
      ready.delete(nextCommit);
      nextCommit += 1;
    }

    if (opts.bodyStore) {
      for (const [ordinal, entry] of manifestEntries.entries()) {
        throwIfAborted(bodyController.signal);
        const result = await opts.bodyStore.load(entry, {
          signal: bodyController.signal,
        });
        if (!result) {
          throw new Error(`Tree body store lost committed slot ${ordinal}.`);
        }
        recordSource(result);
        if (result.ok) applySuccess(pageNodes[ordinal]!, result);
        else applyPartialFailure(pageNodes[ordinal]!, result);
      }
    }
  } catch (error) {
    bodyController.abort(error);
    await Promise.all(active.values());
    throw error;
  } finally {
    signal?.removeEventListener("abort", abortBodies);
  }

  return {
    nodes,
    notes: treeNotes,
    complete,
    sourceSummary: {
      pagesRead,
      representations: representationCounts,
      degradedPages,
    },
  };
}

// ---------------------------------------------------------------------------
// Label resolution (imperative shell around the pure applyLabelFilter)
// ---------------------------------------------------------------------------

/**
 * Build the `labelsById` map the pure {@link applyLabelFilter} consumes.
 *
 * Primary path: batch CQL via `source.searchPages` — one query per filter list,
 * ids chunked at 100, every literal escaped via `escapeCqlValue`. Only page ids
 * are queried (folders have no labels). The synthesized map carries exactly the
 * filter-relevant labels per matched id, which reproduces the filter decision
 * without a per-page fetch (the "filtered pages are never loaded" invariant).
 *
 * Fallback (no `searchPages`): `getPage` labels — this DOES load bodies, so the
 * cost/privacy guarantee is traded for working without a search port. Fails
 * closed if neither path is available.
 */
async function resolveLabels(
  source: TreeSource,
  nodes: readonly ExportNode[],
  filter: LabelFilter,
  context: TreeFetchContext
): Promise<Map<string, string[]>> {
  const normalized = normalizeLabelFilter(filter)!;
  const pageIds = nodes.filter((n) => n.kind === "page").map((n) => nodeId(n));
  const labelsById = new Map<string, string[]>();

  if (source.searchPages) {
    const queryLabelSet = async (labels: string[]): Promise<Set<string>> => {
      const matched = new Set<string>();
      for (let i = 0; i < pageIds.length; i += CQL_ID_CHUNK) {
        const chunk = pageIds.slice(i, i + CQL_ID_CHUNK);
        const idList = chunk.map((id) => `"${escapeCqlValue(id)}"`).join(",");
        const labelList = labels.map((l) => `"${escapeCqlValue(l)}"`).join(",");
        const cql = `id in (${idList}) and label in (${labelList})`;
        const results = await source.searchPages!(cql, context);
        for (const r of results) matched.add(r.id);
      }
      return matched;
    };

    if (normalized.exclude) {
      const excludedIds = await queryLabelSet(normalized.exclude);
      for (const id of excludedIds) {
        labelsById.set(id, [...(labelsById.get(id) ?? []), ...normalized.exclude]);
      }
    }
    if (normalized.include) {
      const includedIds = await queryLabelSet(normalized.include);
      for (const id of includedIds) {
        labelsById.set(id, [...(labelsById.get(id) ?? []), ...normalized.include]);
      }
    }
    return labelsById;
  }

  // Fallback: getPage labels (loads bodies — documented cost/privacy trade-off).
  // This is only reached when the port has no searchPages; getPage is required
  // by the port and always labels-capable in our adapters, so there is no
  // silent third "neither" case, but guard anyway.
  if (typeof source.getPage !== "function") {
    throw new LabelFilterError(
      "labels-unavailable",
      "Label filtering was requested but the tree source exposes neither searchPages nor a labels-capable getPage."
    );
  }
  for (const id of pageIds) {
    const page = await source.getPage(id, context);
    labelsById.set(id, page.labels ?? []);
  }
  return labelsById;
}

// ---------------------------------------------------------------------------
// Node adapter
// ---------------------------------------------------------------------------

/** The subset of `ConfluenceClient` the adapter needs (keeps this isomorphic). */
export interface TreeSourceClient {
  getExportPageDetailsWithMedia?(
    id: string,
    options?: { signal?: AbortSignal }
  ): Promise<ConfluenceExportPageDetails>;
  getExportPageDetails?(
    id: string,
    options?: { signal?: AbortSignal }
  ): Promise<ConfluenceExportPageDetails>;
  getPageDetails(
    id: string,
    options?: { signal?: AbortSignal }
  ): Promise<{ id: string; title: string; storage: string; version?: number; labels?: string[]; spaceKey?: string }>;
  getPageVersion(
    id: string,
    options?: { signal?: AbortSignal }
  ): Promise<{ title: string; version: number }>;
  getChildrenWithPosition(
    parentId: string,
    options?: { signal?: AbortSignal }
  ): Promise<Array<{ id: string; title: string; version?: number; position: number | null }>>;
  getPageDirectChildren(
    pageId: string,
    options?: { signal?: AbortSignal }
  ): Promise<Array<{ id: string; title: string; type: string }>>;
  getFolderChildren(
    folderId: string,
    options?: { signal?: AbortSignal }
  ): Promise<Array<{ id: string; title: string; type: string }>>;
  getSpaceHomepageId(
    spaceKey: string,
    options?: { signal?: AbortSignal }
  ): Promise<string | null>;
  searchPages(
    cql: string,
    limit?: number,
    options?: { signal?: AbortSignal }
  ): Promise<Array<{ id: string }>>;
}

/**
 * Node adapter: maps the {@link TreeSource} port 1:1 onto a `ConfluenceClient`.
 *
 * `getChildren` first discovers child *kinds* via `getPageDirectChildren` (a
 * page parent) — the only call that reports mixed page/folder/whiteboard
 * children in one round-trip — then re-fetches real positions for page children
 * via `getChildrenWithPosition`, and recurses folder children via
 * `getFolderChildren` (a folder parent). Anything outside page/folder is mapped
 * honestly to `kind: "unsupported"` with the raw type, never cast into a page.
 */
export function confluenceTreeSource(client: TreeSourceClient): TreeSource {
  const classifyKind = (type: string): "page" | "folder" | "unsupported" =>
    type === "page" ? "page" : type === "folder" ? "folder" : "unsupported";

  return {
    async getPage(id, context) {
      const exportRead = client.getExportPageDetailsWithMedia ?? client.getExportPageDetails;
      if (exportRead) {
        const page = await exportRead.call(client, id, { signal: context.signal });
        return {
          id: page.id,
          title: page.title,
          storage: page.storage,
          exportSource: page.exportSource,
          version: page.version,
          labels: page.labels,
          spaceKey: page.spaceKey,
          mediaAttachments: page.mediaAttachments,
          mediaAttachmentsComplete: page.mediaAttachmentsComplete,
          mediaAttachmentsTermination: page.mediaAttachmentsTermination,
          unresolvedMediaFileIds: page.unresolvedMediaFileIds,
          inlineComments: page.inlineComments,
          inlineCommentsComplete: page.inlineCommentsComplete,
        };
      }
      const page = await client.getPageDetails(id, { signal: context.signal });
      return {
        id: page.id,
        title: page.title,
        storage: page.storage,
        version: page.version,
        labels: page.labels,
        spaceKey: page.spaceKey,
      };
    },

    async getPageVersion(id, context) {
      const v = await client.getPageVersion(id, { signal: context.signal });
      return { version: v.version, title: v.title };
    },

    async getChildren(nodeRef, context) {
      if (nodeRef.kind === "folder") {
        const children = await client.getFolderChildren(nodeRef.id, { signal: context.signal });
        return children.map((child) => ({
          id: child.id,
          title: child.title,
          kind: classifyKind(child.type),
          ...(classifyKind(child.type) === "unsupported" ? { unsupportedKind: child.type } : {}),
          // getFolderChildren carries no position/version field.
          position: null,
        }));
      }

      // Page parent: discover kinds, then re-fetch page positions/versions.
      const discovered = await client.getPageDirectChildren(nodeRef.id, { signal: context.signal });
      const positioned = await client.getChildrenWithPosition(nodeRef.id, { signal: context.signal });
      const byId = new Map(positioned.map((p) => [p.id, p]));

      return discovered.map((child): TreeChild => {
        const kind = classifyKind(child.type);
        if (kind === "page") {
          const pos = byId.get(child.id);
          return {
            id: child.id,
            title: child.title,
            kind: "page",
            position: pos?.position ?? null,
            observedVersion: pos?.version,
          };
        }
        if (kind === "folder") {
          return { id: child.id, title: child.title, kind: "folder", position: null };
        }
        return {
          id: child.id,
          title: child.title,
          kind: "unsupported",
          unsupportedKind: child.type,
          position: null,
        };
      });
    },

    async getSpaceHomepageId(spaceKey, context) {
      return client.getSpaceHomepageId(spaceKey, { signal: context.signal });
    },

    async searchPages(cql, context) {
      return client.searchPages(cql, undefined, { signal: context.signal });
    },
  };
}
