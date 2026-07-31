import {
  composeChapters,
  confluenceTreeSource,
  escapeCqlValue,
  fetchExportTree,
  type ComposeOptions,
  type ExportBlock,
  type ExportNode,
  type ExportNote,
  type ExportScope,
  type ExportTreeBodyStoreV1,
  type ExportTreePlanV1,
  type PageBodyToBlocksOptions,
  type TreeSource,
  type TreeSourceClient,
  type TreeSourceSummary,
  type TreeSourceVersion,
} from "@atlcli/confluence";
import type { ExportSourceV1 } from "@atlcli/export-jobs";
import {
  rootSnapshotFromPlanV1,
  validateConfluenceSourcePlanCheckpointOptionsV1,
  validatePersistedConfluenceSourcePlanV1,
  type ConfluenceSourcePlanCheckpointOptionsV1,
  type ConfluenceSourcePlanCheckpointV1,
  type PersistedConfluenceSourcePlanV1,
} from "./confluence-source-plan-checkpoint.js";

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

/**
 * Bind the shared source resolver to a Confluence client without choosing an
 * export representation here. The client owns the ADF-primary/Storage-primary
 * deployment policy used by `getExportPageDetailsWithMedia()`.
 */
export function confluenceSourceResolverPortFromClientV1(
  client: TreeSourceClient,
): ConfluenceSourceResolverPortV1 {
  return {
    createTreeSource: () => confluenceTreeSource(client),
    async resolveContentKey(value, context) {
      const urlId = value.startsWith("http://") || value.startsWith("https://")
        ? value.match(/pages\/(\d+)/)?.[1] ?? value.match(/[?&]pageId=(\d+)/)?.[1]
        : undefined;
      if (urlId) return { id: urlId };
      const separator = value.indexOf(":");
      if (separator <= 0 || separator === value.length - 1) {
        throw new TypeError(
          "A Confluence content key must use SPACE:Title syntax or contain a page id.",
        );
      }
      const spaceKey = value.slice(0, separator);
      const title = value.slice(separator + 1);
      const cql =
        `type=page AND space="${escapeCqlValue(spaceKey)}" ` +
        `AND title="${escapeCqlValue(title)}"`;
      const matches = await client.searchPages(cql, 2, {
        signal: context.signal,
      });
      context.signal.throwIfAborted();
      if (matches.length !== 1) {
        throw new Error(
          matches.length === 0
            ? "The Confluence content key did not resolve to a page."
            : "The Confluence content key is ambiguous.",
        );
      }
      return { id: matches[0]!.id };
    },
  };
}

export interface ResolveConfluenceSourceOptionsV1 {
  exporter: "pdf" | "word" | "web";
  port: ConfluenceSourceResolverPortV1;
  signal: AbortSignal;
  resolveExternalUrl?: NonNullable<ComposeOptions["resolveExternalUrl"]>;
  /** Job-safe aggregate progress; page titles and body data are excluded. */
  onProgress?: (progress: ConfluenceSourceProgressV1) => void;
  /** Classify a host error without retaining its message or original cause. */
  classifyError?: (error: unknown) => ConfluenceSourceFailureKindV1;
  bodyOptions?: Omit<PageBodyToBlocksOptions, "exporter" | "pageContext">;
  /** Optional durable pre-body plan owned by the claimed export-job host. */
  sourcePlanCheckpoint?: ConfluenceSourcePlanCheckpointOptionsV1;
  /** Optional durable normalized-body spool owned by the claimed job host. */
  bodyStore?: ExportTreeBodyStoreV1;
}

export type ConfluenceSourceFailureKindV1 =
  | "authentication"
  | "not-found"
  | "unknown";

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
 * The ordered, decoded Confluence page graph before document composition.
 *
 * Nodes preserve page/folder hierarchy and per-page blocks while raw ADF and
 * Storage bodies remain confined to `fetchExportTree()`. Publication builders
 * consume this boundary instead of reverse-engineering a chapterized document.
 */
export interface ResolvedConfluencePageGraphV1 {
  scope: ExportScope;
  nodes: readonly ExportNode[];
  sourceNotes: readonly ExportNote[];
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
    super("A pinned Confluence page version is no longer available.");
    this.name = "ConfluenceSourceVersionMismatchError";
  }
}

/** Stable, body-free boundary error suitable for durable job summaries. */
export class ConfluenceSourceResolutionError extends Error {
  readonly code = "confluence-source-resolution-failed" as const;
  readonly sourceFailureKind: ConfluenceSourceFailureKindV1;

  constructor(sourceFailureKind: ConfluenceSourceFailureKindV1 = "unknown") {
    super("The Confluence export source could not be resolved.");
    this.name = "ConfluenceSourceResolutionError";
    this.sourceFailureKind = sourceFailureKind;
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

function scopeFromPreparedPlan(
  source: ExportSourceV1,
  plan: ExportTreePlanV1,
): { scope: ExportScope; rootId?: string; expectedVersion?: number } {
  if (source.locator.kind === "space-key") {
    if (
      source.scope.kind !== "space" ||
      plan.scope.kind !== "space" ||
      plan.scope.spaceKey !== source.locator.spaceKey
    ) {
      throw new TypeError("The recovered source plan does not match the requested space.");
    }
    return { scope: plan.scope, rootId: plan.rootId };
  }
  if (source.scope.kind === "space" || plan.scope.kind === "space") {
    throw new TypeError("The recovered source plan has an incompatible scope.");
  }
  if (
    source.scope.kind === "page" &&
    plan.scope.kind !== "page"
  ) {
    throw new TypeError("The recovered source plan is not a page scope.");
  }
  if (
    source.scope.kind === "tree" &&
    (plan.scope.kind !== "tree" ||
      (plan.scope.includeRoot ?? true) !== (source.scope.includeRoot ?? true) ||
      plan.scope.maxDepth !== source.scope.maxDepth)
  ) {
    throw new TypeError("The recovered source plan is not the requested tree scope.");
  }
  if (
    source.locator.kind === "page-id" &&
    plan.rootId !== source.locator.id
  ) {
    throw new TypeError("The recovered source plan root does not match the page locator.");
  }
  return {
    scope: plan.scope,
    rootId: plan.rootId,
    ...(source.locator.kind === "page-id" && source.locator.version !== undefined
      ? { expectedVersion: source.locator.version }
      : {}),
  };
}

async function resolveScope(
  source: ExportSourceV1,
  port: ConfluenceSourceResolverPortV1,
  context: ConfluenceSourceReadContextV1,
  preparedPlan?: ExportTreePlanV1,
): Promise<{ scope: ExportScope; rootId?: string; expectedVersion?: number }> {
  if (preparedPlan) return scopeFromPreparedPlan(source, preparedPlan);
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
 * Fetch, validate, and decode one durable Confluence source request.
 *
 * Raw page representations live only inside `TreeSource.getPage()` and the
 * bounded decoder slot in `fetchExportTree()`. The returned diagnostics are
 * aggregate metadata plus decoder notes; no source body is copied into job
 * progress, errors, or checkpoints by this seam.
 */
async function resolveConfluencePageGraphUnsafeV1(
  sourceRequest: ExportSourceV1,
  options: ResolveConfluenceSourceOptionsV1,
): Promise<ResolvedConfluencePageGraphV1> {
  throwIfAborted(options.signal);
  let persistedPlan: PersistedConfluenceSourcePlanV1 | undefined;
  if (options.sourcePlanCheckpoint) {
    const checkpoint = validateConfluenceSourcePlanCheckpointOptionsV1(
      options.sourcePlanCheckpoint,
    );
    persistedPlan = await checkpoint.store.load(
      {
        jobId: checkpoint.jobId,
        requestKey: checkpoint.requestKey,
        sourcePolicyKey: checkpoint.sourcePolicyKey,
      },
      { signal: options.signal },
    );
    throwIfAborted(options.signal);
    if (persistedPlan) {
      persistedPlan = validatePersistedConfluenceSourcePlanV1(persistedPlan, {
        jobId: checkpoint.jobId,
        requestKey: checkpoint.requestKey,
        sourcePolicyKey: checkpoint.sourcePolicyKey,
        leaseEpoch: checkpoint.leaseEpoch,
      });
    }
  }
  const context: ConfluenceSourceReadContextV1 = {
    siteOrigin: sourceRequest.siteOrigin,
    signal: options.signal,
  };
  const resolved = await resolveScope(
    sourceRequest,
    options.port,
    context,
    persistedPlan?.checkpoint.plan,
  );
  throwIfAborted(options.signal);

  let treeSource = options.port.createTreeSource(context);
  let rootSnapshot: TreeSourceVersion | undefined = persistedPlan
    ? {
        title: persistedPlan.checkpoint.root.title,
        ...(persistedPlan.checkpoint.root.version !== undefined
          ? { version: persistedPlan.checkpoint.root.version }
          : {}),
      }
    : undefined;
  if (persistedPlan) {
    if (
      resolved.expectedVersion !== undefined &&
      rootSnapshot?.version !== resolved.expectedVersion
    ) {
      throw new ConfluenceSourceVersionMismatchError(
        resolved.rootId!,
        resolved.expectedVersion,
        rootSnapshot?.version,
      );
    }
  } else if (resolved.rootId !== undefined) {
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
  if (persistedPlan && resolved.rootId !== undefined && rootSnapshot) {
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
    ...(options.bodyStore ? { bodyStore: options.bodyStore } : {}),
    signal: options.signal,
    ...(persistedPlan
      ? {
          preparedPlan: persistedPlan.checkpoint.plan,
          onPlanRecovered: async () => {
            const checkpointOptions = options.sourcePlanCheckpoint!;
            if (
              checkpointOptions.recoveryHeadRef === undefined
              || checkpointOptions.recoveryHeadRef === persistedPlan!.ref
            ) {
              await checkpointOptions.publishCheckpointRef(
                persistedPlan!.ref,
                { signal: options.signal },
              );
            }
            throwIfAborted(options.signal);
          },
        }
      : options.sourcePlanCheckpoint
        ? {
            onPlanPrepared: async (plan: ExportTreePlanV1) => {
              const root = rootSnapshot ?? rootSnapshotFromPlanV1(plan);
              rootSnapshot = root;
              const checkpointOptions = options.sourcePlanCheckpoint!;
              const checkpoint: ConfluenceSourcePlanCheckpointV1 = {
                schema: "atlcli.confluence-source-plan-checkpoint/1",
                jobId: checkpointOptions.jobId,
                requestKey: checkpointOptions.requestKey,
                sourcePolicyKey: checkpointOptions.sourcePolicyKey,
                committedLeaseEpoch: checkpointOptions.leaseEpoch,
                root: {
                  id: plan.rootId,
                  title: root.title,
                  ...(root.version !== undefined ? { version: root.version } : {}),
                },
                plan,
              };
              const ref = await checkpointOptions.store.commit(checkpoint, {
                leaseEpoch: checkpointOptions.leaseEpoch,
                signal: options.signal,
              });
              throwIfAborted(options.signal);
              if (typeof ref !== "string" || ref.trim().length === 0) {
                throw new Error("The source plan store returned an empty ref.");
              }
              await checkpointOptions.publishCheckpointRef(ref, {
                signal: options.signal,
              });
              throwIfAborted(options.signal);
            },
          }
        : {}),
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
  const sourceNotes = [...fetched.notes, ...pageNotes];

  if (resolved.scope.kind === "page") {
    const pageNode = fetched.nodes.find((node) => node.kind === "page");
    if (!pageNode || pageNode.kind !== "page") {
      throw new Error("The Confluence page source resolved without a page node.");
    }
    return {
      scope: resolved.scope,
      nodes: fetched.nodes,
      sourceNotes,
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
    scope: resolved.scope,
    nodes: fetched.nodes,
    sourceNotes,
    complete: fetched.complete,
    root,
    pages,
    pageCount: pages.length,
    sourceSummary: fetched.sourceSummary,
  };
}

function composeResolvedConfluencePageGraphV1(
  graph: ResolvedConfluencePageGraphV1,
  options: ResolveConfluenceSourceOptionsV1,
): ResolvedConfluenceSourceV1 {
  if (graph.scope.kind === "page") {
    const pageNode = graph.nodes.find((node) => node.kind === "page");
    if (!pageNode || pageNode.kind !== "page") {
      throw new Error("The Confluence page source resolved without a page node.");
    }
    return {
      blocks: pageNode.blocks,
      sourceNotes: [...graph.sourceNotes],
      complete: graph.complete,
      root: graph.root,
      pages: graph.pages,
      pageCount: graph.pageCount,
      sourceSummary: graph.sourceSummary,
    };
  }

  const composed = composeChapters(graph.nodes, {
    ...(options.resolveExternalUrl ? { resolveExternalUrl: options.resolveExternalUrl } : {}),
  });
  return {
    blocks: composed.blocks,
    sourceNotes: [...graph.sourceNotes, ...composed.notes],
    complete: graph.complete,
    root: graph.root,
    pages: graph.pages,
    pageCount: graph.pageCount,
    sourceSummary: graph.sourceSummary,
    chapterAnchorById: composed.chapterAnchorById,
  };
}

function throwConfluenceSourceResolutionFailureV1(
  error: unknown,
  options: ResolveConfluenceSourceOptionsV1,
): never {
  if (options.signal.aborted) {
    throw options.signal.reason ?? error;
  }
  if (error instanceof ConfluenceSourceVersionMismatchError) throw error;
  // The underlying error remains intentionally outside this durable-facing
  // value. Client/parser messages can contain titles, URLs, or source
  // fragments and must not become a persisted job error summary.
  throw new ConfluenceSourceResolutionError(
    options.classifyError?.(error) ?? "unknown",
  );
}

/**
 * Resolve the existing ordered page/folder graph exactly once, before document
 * composition. The returned value contains normalized blocks but never raw
 * ADF or Storage source.
 */
export async function resolveConfluencePageGraphV1(
  sourceRequest: ExportSourceV1,
  options: ResolveConfluenceSourceOptionsV1,
): Promise<ResolvedConfluencePageGraphV1> {
  try {
    return await resolveConfluencePageGraphUnsafeV1(sourceRequest, options);
  } catch (error) {
    return throwConfluenceSourceResolutionFailureV1(error, options);
  }
}

/**
 * Compatibility document resolver. Tree and space results are composed from
 * the same pre-compose graph returned by `resolveConfluencePageGraphV1()`;
 * discovery and body reads are never repeated.
 */
export async function resolveConfluenceSourceV1(
  sourceRequest: ExportSourceV1,
  options: ResolveConfluenceSourceOptionsV1,
): Promise<ResolvedConfluenceSourceV1> {
  try {
    const graph = await resolveConfluencePageGraphUnsafeV1(sourceRequest, options);
    return composeResolvedConfluencePageGraphV1(graph, options);
  } catch (error) {
    return throwConfluenceSourceResolutionFailureV1(error, options);
  }
}
