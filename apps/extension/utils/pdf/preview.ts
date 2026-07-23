/**
 * PDF preview pipeline (spec 010 T5.3).
 *
 * The preview is **not a second renderer**. It is the export pipeline with
 * three substitutions, and nothing else:
 *
 *   1. the output sink captures bytes instead of triggering a download,
 *   2. the compile port is tagged `kind: "preview"` so the offscreen queue can
 *      yield to an export and coalesce debounced churn
 *      (`utils/pdf/compiler-host.ts`), and
 *   3. for tree/space scopes the *input* is truncated before composition.
 *
 * Keeping the pipeline identical is the whole feature: the cached preview bytes
 * are reused by Download (`preview-cache.ts`), so "what you preview is what you
 * download" has to be literally true, not approximately.
 *
 * ## Truncation is scope-dependent, and the label is not "pages"
 *
 * `scope: page` compiles the **whole** document. That is the case
 * [CONFCLOUD-84742](https://jira.atlassian.com/browse/CONFCLOUD-84742) actually
 * describes — "does my report look right?" — and a partial preview of a single
 * page answers nothing.
 *
 * `tree`/`space` truncate to the first N **chapters**. Truncation happens on
 * the fetched `ExportNode[]` *before* `composeChapters`, not on the composed
 * block list and never on the compiled PDF: one node is exactly one chapter, so
 * the count is exact by construction, while a block-level split would have to
 * guess where a chapter starts (a source page may contain its own `pageBreak`
 * macro) and a PDF-level split would need a new dependency.
 *
 * The UI must say "first N chapters", never "first N pages": `pageCount` exists
 * only after compiling and validating (`validatePdfOutput`), and one dense
 * source page can compile to many PDF pages. That asymmetry is also why the
 * chapter budget alone is not enough — {@link PreviewBudget} carries a block
 * and asset-byte backstop so a single pathological chapter still bounds the
 * compile.
 */
import {
  nodeId,
  type ExportBlock,
  type ExportNode,
  type ExportNote,
  type ExportScope,
  type LabelFilter,
} from "@atlcli/confluence/browser";
import {
  runPdfExport as runNeutralPdfExport,
  type PdfAssetResolver,
  type PdfBytesHandle,
  type PdfCompilePort,
  type PdfExportMetadata,
  type PdfExportReport,
  type PdfOutputSink,
  type PdfProfile,
  type PdfTemplateSettings,
  type PdfThemeOptions,
} from "@atlcli/pdf/browser";
import type { LoadedPage } from "../read-path.js";
import { exportScopeIdentity } from "../scope-state.js";
import { resolveExportComposition } from "../confluence/export-composition.js";
import { extensionPdfCompilePort } from "./compile-port.js";
import { isPreviewSupersededError } from "./compiler-host.js";
import {
  hashPreviewSettings,
  hashTreeVersions,
  type PreviewCacheKeyParts,
} from "./preview-cache.js";
import {
  runPdfExport as runExtensionPdfExport,
  type PdfExportPhase,
  type RunPdfMacroOptions,
} from "./run-export.js";

export { isPreviewSupersededError };

/** How much of a tree/space document a preview is allowed to compile. */
export interface PreviewBudget {
  /** Chapters (= `ExportNode`s) included. The number the UI names. */
  maxChapters: number;
  /**
   * Backstop: total top-level blocks across the included chapters. One chapter
   * with a 900-row table counts as "1" against `maxChapters` but would blow the
   * compile budget on its own.
   */
  maxBlocks: number;
  /**
   * Backstop: estimated asset bytes across the included chapters. Estimated,
   * not measured — the exact figure only exists after the assets are fetched,
   * which is most of the cost this bound exists to avoid.
   */
  maxAssetBytes: number;
}

export const DEFAULT_PREVIEW_BUDGET: PreviewBudget = {
  maxChapters: 5,
  maxBlocks: 600,
  maxAssetBytes: 16 * 1024 * 1024,
};

/**
 * Assumed bytes for one image reference when nothing better is known.
 *
 * Callers that hold real attachment metadata (`LoadedPage.attachments[].size`)
 * should pass {@link PreviewTruncationOptions.estimateNodeAssetBytes} instead;
 * this default only has to be the right order of magnitude for a *bound*.
 */
export const ASSUMED_IMAGE_BYTES = 512 * 1024;

export type PreviewTruncationReason = "none" | "chapters" | "blocks" | "assetBytes";

export interface PreviewTruncationPlan {
  /** The nodes to compose. Identical array contents when nothing was cut. */
  nodes: ExportNode[];
  truncated: boolean;
  includedChapters: number;
  totalChapters: number;
  reason: PreviewTruncationReason;
}

export interface PreviewTruncationOptions {
  budget?: Partial<PreviewBudget>;
  /** Estimated asset bytes for one node. Defaults to image refs × {@link ASSUMED_IMAGE_BYTES}. */
  estimateNodeAssetBytes?: (node: ExportNode) => number;
}

/** Count image-ish blocks recursively — the default asset-byte estimator's input. */
export function countImageRefs(blocks: readonly ExportBlock[]): number {
  let count = 0;
  const walk = (list: readonly ExportBlock[]): void => {
    for (const block of list) {
      switch (block.type) {
        case "image":
          count += 1;
          break;
        case "callout":
        case "expand":
        case "blockquote":
          walk(block.content);
          break;
        case "orientation":
          walk(block.content);
          break;
        case "list":
          for (const item of block.items) walk(item.content);
          break;
        case "layout":
          for (const column of block.columns) walk(column.content);
          break;
        case "table":
          for (const row of block.rows) {
            for (const cell of row.cells) walk(cell.content);
          }
          break;
        case "unknown":
          if (block.body) walk(block.body);
          break;
        default:
          break;
      }
    }
  };
  walk(blocks);
  return count;
}

function defaultNodeAssetBytes(node: ExportNode): number {
  return node.kind === "page" ? countImageRefs(node.blocks) * ASSUMED_IMAGE_BYTES : 0;
}

function nodeBlockCount(node: ExportNode): number {
  return node.kind === "page" ? node.blocks.length : 0;
}

/**
 * Decide how much of a fetched tree a preview compiles.
 *
 * Pure. `scope: page` is returned untouched — see the module comment. For
 * tree/space the first chapter is **always** included even when it alone
 * exceeds a backstop: a preview of nothing is worse than a preview of one
 * oversized chapter, and the compile timeout (which now scales with page count)
 * is the remaining guard.
 */
export function planPreviewTruncation(
  nodes: readonly ExportNode[],
  scope: ExportScope,
  options: PreviewTruncationOptions = {}
): PreviewTruncationPlan {
  const total = nodes.length;
  if (scope.kind === "page") {
    return {
      nodes: [...nodes],
      truncated: false,
      includedChapters: total,
      totalChapters: total,
      reason: "none",
    };
  }

  const budget = { ...DEFAULT_PREVIEW_BUDGET, ...options.budget };
  const estimate = options.estimateNodeAssetBytes ?? defaultNodeAssetBytes;

  const included: ExportNode[] = [];
  let blocks = 0;
  let assetBytes = 0;
  let reason: PreviewTruncationReason = "none";

  for (const node of nodes) {
    if (included.length >= Math.max(1, budget.maxChapters)) {
      reason = "chapters";
      break;
    }
    const nextBlocks = blocks + nodeBlockCount(node);
    const nextAssetBytes = assetBytes + estimate(node);
    if (included.length > 0 && nextBlocks > budget.maxBlocks) {
      reason = "blocks";
      break;
    }
    if (included.length > 0 && nextAssetBytes > budget.maxAssetBytes) {
      reason = "assetBytes";
      break;
    }
    included.push(node);
    blocks = nextBlocks;
    assetBytes = nextAssetBytes;
  }

  const truncated = included.length < total;
  return {
    nodes: included,
    truncated,
    includedChapters: included.length,
    totalChapters: total,
    // A budget that stopped the walk exactly at the last node did not truncate.
    reason: truncated ? reason : "none",
  };
}

/** Per-node version fingerprint input — see `preview-cache.ts` for why. */
export interface PreviewNodeVersion {
  id: string;
  version: number | null;
}

/**
 * The identity of every node in a resolved tree, for the preview cache key.
 *
 * `sourceIdentity` carries only the *root* page's version, so a child page
 * edited between two exports would not change it. A panel-lifetime cache can
 * live with that (bodies are refetched each run); the preview cache persists in
 * IndexedDB and feeds Download, so it cannot.
 */
export function previewNodeVersions(nodes: readonly ExportNode[]): PreviewNodeVersion[] {
  return nodes.map((node) => ({
    id: nodeId(node),
    version: node.kind === "page" ? (node.meta.version ?? node.meta.observedVersion ?? null) : null,
  }));
}

/**
 * Build the preview cache key for a request.
 *
 * **One builder for both sides.** The viewer writes the entry and Download
 * reads it; if the two composed the key differently, Download would either miss
 * every hit (harmless but pointless) or — far worse — match on a key that
 * ignores something the bytes depend on. Everything that changes the compiled
 * bytes must go in exactly once, here:
 *
 *   - `sourceIdentity`: the page identity the export path already uses
 *     (`pageUrl|id|version`) **plus** `exportScopeIdentity(scope, labels)`, so a
 *     tree export can never collide with a single-page one;
 *   - the resolved settings;
 *   - every node's version, not only the root's (see `preview-cache.ts`).
 */
export async function previewCacheParts(input: {
  pageUrl: string;
  page: { id: string; version?: number };
  scope: ExportScope;
  labels?: LabelFilter;
  settings?: unknown;
  /** Resolved tree nodes. Omit for `scope: page` — the root page stands alone. */
  nodes?: readonly ExportNode[];
  /** Precomputed equivalent used when the tree walk lives inside the runner. */
  nodeVersions?: readonly PreviewNodeVersion[];
}): Promise<PreviewCacheKeyParts> {
  const versions = input.nodeVersions
    ? [...input.nodeVersions]
    : input.nodes
      ? previewNodeVersions(input.nodes)
      : [{ id: input.page.id, version: input.page.version ?? null }];
  const [settingsHash, treeVersionHash] = await Promise.all([
    hashPreviewSettings(input.settings ?? null),
    hashTreeVersions(versions),
  ]);
  return {
    sourceIdentity:
      `${input.pageUrl}|${input.page.id}|${input.page.version ?? ""}` +
      `|${exportScopeIdentity(input.scope, input.labels)}`,
    settingsHash,
    treeVersionHash,
  };
}

/** A sink that keeps the compiled bytes instead of downloading them. */
export interface CapturedPdfOutput {
  sink: PdfOutputSink;
  /** The emitted handle, or `undefined` when the run never reached `emitting`. */
  readonly bytes: PdfBytesHandle | undefined;
  readonly filename: string | undefined;
}

export function capturePdfOutput(): CapturedPdfOutput {
  let bytes: PdfBytesHandle | undefined;
  let filename: string | undefined;
  return {
    sink: {
      async emit(name, handle) {
        filename = name;
        bytes = handle;
      },
    },
    get bytes() {
      return bytes;
    },
    get filename() {
      return filename;
    },
  };
}

export type PdfPreviewStatus = "ready" | "superseded";

export interface PdfPreviewResult {
  status: PdfPreviewStatus;
  /** Present only for `status: "ready"`. */
  bytes?: PdfBytesHandle;
  report?: PdfExportReport;
  filename?: string;
  truncated: boolean;
  includedChapters: number;
  totalChapters: number;
  reason: PreviewTruncationReason;
  /** Full resolved scope fingerprint used by the persistent preview cache. */
  nodeVersions?: PreviewNodeVersion[];
}

/**
 * A preview of the currently loaded single page — the CONFCLOUD-84742 case.
 *
 * Delegates to the extension's own `runPdfExport` rather than re-implementing
 * its composition (mentions, metadata, the session asset resolver): byte parity
 * with Download is the point of the cache, and a second copy of the pipeline
 * would drift out of parity the first time either side changed.
 */
export interface PdfPagePreviewInput {
  page: LoadedPage;
  pageUrl: string;
  settings?: PdfTemplateSettings;
  macros?: RunPdfMacroOptions;
  theme?: PdfThemeOptions;
  profile?: PdfProfile;
  signal?: AbortSignal;
  onPhase?: (phase: PdfExportPhase) => void;
}

/** Scope-aware preview request from the Publishing Studio. */
export interface PdfScopedPreviewInput extends PdfPagePreviewInput {
  scope?: ExportScope;
  labels?: LabelFilter;
}

/**
 * A preview of an already-composed (and already-truncated) document — the
 * tree/space case.
 *
 * Takes blocks rather than a scope because composition belongs to the caller
 * that fetched the tree; {@link planPreviewTruncation} is the piece this module
 * contributes to that flow.
 */
export interface PdfComposedPreviewInput {
  blocks: ExportBlock[];
  sourceNotes?: ExportNote[];
  metadata: PdfExportMetadata;
  filename: string;
  assets: PdfAssetResolver;
  settings?: PdfTemplateSettings;
  theme?: PdfThemeOptions;
  profile?: PdfProfile;
  signal?: AbortSignal;
  /** From {@link planPreviewTruncation} — reported back verbatim, never inferred. */
  truncation: PreviewTruncationPlan;
  /** `false` when composition dropped unreadable pages (partial mode). */
  complete?: boolean;
}

export interface PdfPreviewDeps {
  now: () => number;
  /** Builds the compile port. Overridden in tests; always `kind: "preview"`. */
  createCompilePort: (options: {
    sourceIdentity: string;
    onQueued: () => void;
    onCompiling: () => void;
  }) => PdfCompilePort;
  /** The extension's export runner, injected so the page path stays testable. */
  runExport: typeof runExtensionPdfExport;
}

const defaultDeps: PdfPreviewDeps = {
  now: () => Date.now(),
  createCompilePort: (options) => extensionPdfCompilePort({ ...options, kind: "preview" }),
  runExport: runExtensionPdfExport,
};

const UNTRUNCATED: PreviewTruncationPlan = {
  nodes: [],
  truncated: false,
  includedChapters: 1,
  totalChapters: 1,
  reason: "none",
};

/** Preview of the loaded page (whole document, never truncated). */
export async function runPagePdfPreview(
  input: PdfPagePreviewInput,
  overrides: Partial<PdfPreviewDeps> = {}
): Promise<PdfPreviewResult> {
  const deps = { ...defaultDeps, ...overrides };
  const captured = capturePdfOutput();
  try {
    const report = await deps.runExport(
      {
        page: input.page,
        pageUrl: input.pageUrl,
        settings: input.settings,
        macros: input.macros,
        theme: input.theme,
        profile: input.profile,
        signal: input.signal,
        onPhase: input.onPhase,
      },
      { output: captured.sink, createCompilePort: deps.createCompilePort, now: deps.now }
    );
    return {
      status: "ready",
      bytes: captured.bytes,
      report,
      filename: captured.filename,
      truncated: false,
      includedChapters: UNTRUNCATED.includedChapters,
      totalChapters: UNTRUNCATED.totalChapters,
      reason: "none",
    };
  } catch (error) {
    if (isPreviewSupersededError(error)) return supersededResult(UNTRUNCATED);
    throw error;
  }
}

/**
 * Preview the Studio's selected scope through the same host pipeline as
 * Download. Tree/space scopes fetch the complete shared tree, then compose only
 * the bounded chapter prefix; page scope stays on the cheap loaded-page path.
 */
export async function runScopedPdfPreview(
  input: PdfScopedPreviewInput,
  overrides: Partial<PdfPreviewDeps> = {}
): Promise<PdfPreviewResult> {
  const scope: ExportScope = input.scope ?? {
    kind: "page",
    pageId: input.page.details.id,
  };
  if (scope.kind === "page") return runPagePdfPreview(input, overrides);

  const deps = { ...defaultDeps, ...overrides };
  const captured = capturePdfOutput();
  let truncation: PreviewTruncationPlan | undefined;
  let nodeVersions: PreviewNodeVersion[] | undefined;

  try {
    const report = await deps.runExport(
      {
        page: input.page,
        pageUrl: input.pageUrl,
        scope,
        ...(input.labels ? { labels: input.labels } : {}),
        settings: input.settings,
        macros: input.macros,
        theme: input.theme,
        profile: input.profile,
        signal: input.signal,
        onPhase: input.onPhase,
      },
      {
        output: captured.sink,
        createCompilePort: deps.createCompilePort,
        now: deps.now,
        resolveComposition: async (compositionInput, compositionOverrides) =>
          resolveExportComposition(
            {
              ...compositionInput,
              selectNodes(nodes) {
                nodeVersions = previewNodeVersions(nodes);
                truncation = planPreviewTruncation(nodes, scope);
                return truncation.nodes;
              },
            },
            compositionOverrides
          ),
      }
    );
    const resolvedPlan =
      truncation ??
      ({
        nodes: [],
        truncated: false,
        includedChapters: 0,
        totalChapters: 0,
        reason: "none",
      } satisfies PreviewTruncationPlan);
    return {
      status: "ready",
      bytes: captured.bytes,
      report,
      filename: captured.filename,
      truncated: resolvedPlan.truncated,
      includedChapters: resolvedPlan.includedChapters,
      totalChapters: resolvedPlan.totalChapters,
      reason: resolvedPlan.reason,
      ...(nodeVersions ? { nodeVersions } : {}),
    };
  } catch (error) {
    const plan =
      truncation ??
      ({
        nodes: [],
        truncated: false,
        includedChapters: 0,
        totalChapters: 0,
        reason: "none",
      } satisfies PreviewTruncationPlan);
    if (isPreviewSupersededError(error)) return supersededResult(plan);
    throw error;
  }
}

/** Preview of a composed tree/space document, truncated by the caller's plan. */
export async function runComposedPdfPreview(
  input: PdfComposedPreviewInput,
  overrides: Partial<PdfPreviewDeps> = {}
): Promise<PdfPreviewResult> {
  const deps = { ...defaultDeps, ...overrides };
  const captured = capturePdfOutput();
  const compiler = deps.createCompilePort({
    sourceIdentity: input.metadata.title,
    onQueued: () => undefined,
    onCompiling: () => undefined,
  });
  try {
    const report = await runNeutralPdfExport(
      {
        blocks: input.blocks,
        sourceNotes: input.sourceNotes,
        metadata: input.metadata,
        settings: input.settings,
        theme: input.theme,
        profile: input.profile,
        filename: input.filename,
        signal: input.signal,
        // A truncated preview is by definition not the whole document; saying
        // so in the report is what keeps the "complete" flag honest.
        complete: input.complete !== false && !input.truncation.truncated,
      },
      { assets: input.assets, compiler, output: captured.sink, now: deps.now }
    );
    return {
      status: "ready",
      bytes: captured.bytes,
      report,
      filename: captured.filename,
      truncated: input.truncation.truncated,
      includedChapters: input.truncation.includedChapters,
      totalChapters: input.truncation.totalChapters,
      reason: input.truncation.reason,
    };
  } catch (error) {
    if (isPreviewSupersededError(error)) return supersededResult(input.truncation);
    throw error;
  }
}

function supersededResult(plan: PreviewTruncationPlan): PdfPreviewResult {
  return {
    status: "superseded",
    truncated: plan.truncated,
    includedChapters: plan.includedChapters,
    totalChapters: plan.totalChapters,
    reason: plan.reason,
  };
}

// ---------------------------------------------------------------------------
// Debounce / coalescing
// ---------------------------------------------------------------------------

/**
 * Quiet period before a settings/scope change triggers a recompile.
 *
 * The scheduler only decides *when* to ask; superseding the previous request is
 * the compiler host's job (`kind: "preview"` coalescing), never `pdf:cancel` —
 * that path terminates the worker and drops the memoized Typst compiler with
 * it, so every debounced tweak would pay a cold wasm+font init.
 */
export const PREVIEW_DEBOUNCE_MS = 400;

export interface PreviewScheduler {
  /** Ask for a run after the quiet period; a later ask replaces an earlier one. */
  request(run: () => void): void;
  /** Run the pending request immediately (an explicit "Preview now" click). */
  flush(): void;
  /** Drop the pending request (unmount, or the user turned auto-preview off). */
  cancel(): void;
  readonly pending: boolean;
}

export function createPreviewScheduler(options: {
  delayMs?: number;
  schedule?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clear?: (id: ReturnType<typeof setTimeout>) => void;
} = {}): PreviewScheduler {
  const delayMs = options.delayMs ?? PREVIEW_DEBOUNCE_MS;
  const schedule = options.schedule ?? ((fn, ms) => setTimeout(fn, ms));
  const clear = options.clear ?? ((id) => clearTimeout(id));

  let timer: ReturnType<typeof setTimeout> | null = null;
  let queued: (() => void) | null = null;

  const stop = (): void => {
    if (timer !== null) clear(timer);
    timer = null;
  };

  return {
    request(run: () => void): void {
      stop();
      queued = run;
      timer = schedule(() => {
        timer = null;
        const fn = queued;
        queued = null;
        fn?.();
      }, delayMs);
    },
    flush(): void {
      stop();
      const fn = queued;
      queued = null;
      fn?.();
    },
    cancel(): void {
      stop();
      queued = null;
    },
    get pending(): boolean {
      return queued !== null;
    },
  };
}
