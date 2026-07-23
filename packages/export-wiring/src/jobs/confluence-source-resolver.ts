import {
  composeChapters,
  fetchExportTree,
  type ComposeOptions,
  type ExportBlock,
  type ExportNote,
  type ExportScope,
  type PageBodyToBlocksOptions,
  type TreeSource,
  type TreeSourceSummary,
  type TreeSourceVersion,
} from "@atlcli/confluence";
import type { ExportSourceV1 } from "@atlcli/export-jobs";

/** Metadata-only context supplied to host source ports. */
export interface ConfluenceSourceReadContextV1 {
  siteOrigin: string;
  signal: AbortSignal;
}

/**
 * Host capabilities required by the representation-neutral job resolver.
 *
 * The host constructs the `TreeSource` with its own authentication and
 * deployment policy. ADF-primary versus Storage-primary therefore remains a
 * deployment decision and never enters the durable request contract.
 */
export interface ConfluenceSourceResolverPortV1 {
  createTreeSource(context: ConfluenceSourceReadContextV1): TreeSource;
  /** Resolve a CLI/user-facing content key without reading a page body. */
  resolveContentKey?(
    value: string,
    context: ConfluenceSourceReadContextV1,
  ): Promise<{ id: string }>;
}

export interface ResolveConfluenceSourceOptionsV1 {
  exporter: "pdf" | "word";
  port: ConfluenceSourceResolverPortV1;
  signal: AbortSignal;
  resolveExternalUrl?: NonNullable<ComposeOptions["resolveExternalUrl"]>;
  /** Job-safe aggregate progress; page titles and body data are excluded. */
  onProgress?: (progress: ConfluenceSourceProgressV1) => void;
  bodyOptions?: Omit<PageBodyToBlocksOptions, "exporter" | "pageContext">;
}

export interface ConfluenceSourceProgressV1 {
  fetched: number;
  total: number | null;
}

export interface ResolvedConfluenceSourcePageV1 {
  id: string;
  title: string;
  version?: number;
  spaceKey?: string;
  notes: readonly ExportNote[];
}

/**
 * One transient, engine-neutral source resolution result.
 *
 * It deliberately contains decoded blocks but no raw ADF/Storage source. The
 * same value can be mapped into both PDF and TypeScript-DOCX `resolveInput`
 * callbacks before their representation-agnostic ready-to-render checkpoint.
 */
export interface ResolvedConfluenceSourceV1 {
  blocks: ExportBlock[];
  sourceNotes: ExportNote[];
  complete: boolean;
  root: {
    id: string;
    title: string;
    version?: number;
    spaceKey?: string;
  };
  pages: readonly ResolvedConfluenceSourcePageV1[];
  pageCount: number;
  sourceSummary: TreeSourceSummary;
  chapterAnchorById?: ReadonlyMap<string, string>;
}

/** Body-free error raised when a durable page-version pin no longer matches. */
export class ConfluenceSourceVersionMismatchError extends Error {
  constructor(
    public readonly pageId: string,
    public readonly expectedVersion: number,
    public readonly observedVersion: number | undefined,
  ) {
    super(`The pinned Confluence page version is no longer available for page ${pageId}.`);
    this.name = "ConfluenceSourceVersionMismatchError";
  }
}

/** Stable, body-free boundary error suitable for durable job summaries. */
export class ConfluenceSourceResolutionError extends Error {
  readonly code = "confluence-source-resolution-failed" as const;

  constructor() {
    super("The Confluence export source could not be resolved.");
    this.name = "ConfluenceSourceResolutionError";
  }
}

function throwIfAborted(signal: AbortSignal): void {
  signal.throwIfAborted();
}

function withRootSnapshot(
  source: TreeSource,
  rootId: string,
  snapshot: TreeSourceVersion,
): TreeSource {
  const wrapped: TreeSource = {
    getPage: (id, context) => source.getPage(id, context),
    getPageVersion: (id, context) =>
      id === rootId ? Promise.resolve(snapshot) : source.getPageVersion(id, context),
    getChildren: (node, context) => source.getChildren(node, context),
    getSpaceHomepageId: (spaceKey, context) => source.getSpaceHomepageId(spaceKey, context),
  };
  if (source.searchPages) {
    wrapped.searchPages = (cql, context) => source.searchPages!(cql, context);
  }
  return wrapped;
}

async function resolveScope(
  source: ExportSourceV1,
  port: ConfluenceSourceResolverPortV1,
  context: ConfluenceSourceReadContextV1,
): Promise<{ scope: ExportScope; rootId?: string; expectedVersion?: number }> {
  if (source.locator.kind === "space-key") {
    if (source.scope.kind !== "space") {
      throw new TypeError("A Confluence space-key locator requires a space scope.");
    }
    return { scope: { kind: "space", spaceKey: source.locator.spaceKey } };
  }

  if (source.scope.kind === "space") {
    throw new TypeError("A Confluence space scope requires a space-key locator.");
  }

  let rootId: string;
  let expectedVersion: number | undefined;
  if (source.locator.kind === "page-id") {
    rootId = source.locator.id;
    expectedVersion = source.locator.version;
  } else {
    if (!port.resolveContentKey) {
      throw new TypeError("This export host cannot resolve Confluence content-key locators.");
    }
    throwIfAborted(context.signal);
    rootId = (await port.resolveContentKey(source.locator.value, context)).id;
    throwIfAborted(context.signal);
  }

  const scope: ExportScope = source.scope.kind === "page"
    ? { kind: "page", pageId: rootId }
    : {
        kind: "tree",
        rootPageId: rootId,
        ...(source.scope.includeRoot !== undefined
          ? { includeRoot: source.scope.includeRoot }
          : {}),
        ...(source.scope.maxDepth !== undefined ? { maxDepth: source.scope.maxDepth } : {}),
      };
  return {
    scope,
    rootId,
    ...(expectedVersion !== undefined ? { expectedVersion } : {}),
  };
}

/**
 * Fetch, validate, decode, and compose one durable Confluence source request.
 *
 * Raw page representations live only inside `TreeSource.getPage()` and the
 * bounded decoder slot in `fetchExportTree()`. The returned diagnostics are
 * aggregate metadata plus decoder notes; no source body is copied into job
 * progress, errors, or checkpoints by this seam.
 */
async function resolveConfluenceSourceUnsafeV1(
  sourceRequest: ExportSourceV1,
  options: ResolveConfluenceSourceOptionsV1,
): Promise<ResolvedConfluenceSourceV1> {
  throwIfAborted(options.signal);
  const context: ConfluenceSourceReadContextV1 = {
    siteOrigin: sourceRequest.siteOrigin,
    signal: options.signal,
  };
  const resolved = await resolveScope(sourceRequest, options.port, context);
  throwIfAborted(options.signal);

  let treeSource = options.port.createTreeSource(context);
  let rootSnapshot: TreeSourceVersion | undefined;
  if (resolved.rootId !== undefined) {
    rootSnapshot = await treeSource.getPageVersion(resolved.rootId, {
      signal: options.signal,
    });
    throwIfAborted(options.signal);
    if (
      resolved.expectedVersion !== undefined &&
      rootSnapshot.version !== resolved.expectedVersion
    ) {
      throw new ConfluenceSourceVersionMismatchError(
        resolved.rootId,
        resolved.expectedVersion,
        rootSnapshot.version,
      );
    }
    // Reuse the exact snapshot during discovery. The body decoder later checks
    // its representation version against this snapshot, closing the read race.
    treeSource = withRootSnapshot(treeSource, resolved.rootId, rootSnapshot);
  }

  const fetched = await fetchExportTree(treeSource, resolved.scope, {
    ...(sourceRequest.labels ? { labels: sourceRequest.labels } : {}),
    ...(sourceRequest.completenessMode
      ? { completenessMode: sourceRequest.completenessMode }
      : {}),
    ...(sourceRequest.maxPages !== undefined ? { maxPages: sourceRequest.maxPages } : {}),
    bodyOptions: {
      ...options.bodyOptions,
      exporter: options.exporter,
    },
    signal: options.signal,
    ...(options.onProgress
      ? {
          onProgress: (progress: { fetched: number; total: number | null }) =>
            options.onProgress!({ fetched: progress.fetched, total: progress.total }),
        }
      : {}),
  });
  throwIfAborted(options.signal);

  const pages: ResolvedConfluenceSourcePageV1[] = fetched.nodes.flatMap((node) =>
    node.kind === "page"
      ? [{
          id: node.pageId,
          title: node.title,
          ...(node.meta.version !== undefined ? { version: node.meta.version } : {}),
          ...(node.meta.spaceKey !== undefined ? { spaceKey: node.meta.spaceKey } : {}),
          notes: node.notes,
        }]
      : [],
  );
  const pageNotes = pages.flatMap((page) => page.notes);

  if (resolved.scope.kind === "page") {
    const pageNode = fetched.nodes.find((node) => node.kind === "page");
    if (!pageNode || pageNode.kind !== "page") {
      throw new Error("The Confluence page source resolved without a page node.");
    }
    return {
      blocks: pageNode.blocks,
      sourceNotes: [...fetched.notes, ...pageNotes],
      complete: fetched.complete,
      root: {
        id: pageNode.pageId,
        title: pageNode.title,
        ...(pageNode.meta.version !== undefined ? { version: pageNode.meta.version } : {}),
        ...(pageNode.meta.spaceKey !== undefined ? { spaceKey: pageNode.meta.spaceKey } : {}),
      },
      pages,
      pageCount: pages.length,
      sourceSummary: fetched.sourceSummary,
    };
  }

  const composed = composeChapters(fetched.nodes, {
    ...(options.resolveExternalUrl ? { resolveExternalUrl: options.resolveExternalUrl } : {}),
  });
  const firstPage = pages[0];
  const root = resolved.rootId !== undefined && rootSnapshot
    ? {
        id: resolved.rootId,
        title: rootSnapshot.title,
        ...(rootSnapshot.version !== undefined ? { version: rootSnapshot.version } : {}),
        ...(firstPage?.id === resolved.rootId && firstPage.spaceKey !== undefined
          ? { spaceKey: firstPage.spaceKey }
          : {}),
      }
    : firstPage
      ? {
          id: firstPage.id,
          title: firstPage.title,
          ...(firstPage.version !== undefined ? { version: firstPage.version } : {}),
          ...(firstPage.spaceKey !== undefined ? { spaceKey: firstPage.spaceKey } : {}),
        }
      : undefined;
  if (!root) throw new Error("The Confluence tree source resolved without a root page.");

  return {
    blocks: composed.blocks,
    sourceNotes: [...fetched.notes, ...pageNotes, ...composed.notes],
    complete: fetched.complete,
    root,
    pages,
    pageCount: pages.length,
    sourceSummary: fetched.sourceSummary,
    chapterAnchorById: composed.chapterAnchorById,
  };
}

export async function resolveConfluenceSourceV1(
  sourceRequest: ExportSourceV1,
  options: ResolveConfluenceSourceOptionsV1,
): Promise<ResolvedConfluenceSourceV1> {
  try {
    return await resolveConfluenceSourceUnsafeV1(sourceRequest, options);
  } catch (error) {
    if (options.signal.aborted) {
      throw options.signal.reason ?? error;
    }
    if (error instanceof ConfluenceSourceVersionMismatchError) throw error;
    // The underlying error remains intentionally outside this durable-facing
    // value. Client/parser messages can contain titles, URLs, or source
    // fragments and must not become a persisted job error summary.
    throw new ConfluenceSourceResolutionError();
  }
}
