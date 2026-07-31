/**
 * Async macro-resolution pass (spec 004, T1.7).
 *
 * Runs between `storageToBlocks` and the DOCX/PDF engines. It resolves every
 * block macro and paragraph-local ADF inline extension through the staged
 * fallback chain, takes ownership of the decoder's pending note, and splices
 * the replacement back at the source position — regardless of which instance's
 * port call settles first.
 */
import type {
  ExportBlock,
  ExportNote,
  ExportNoteCode,
  InlineNode,
  StorageToBlocksResult,
} from "@atlcli/confluence";
import type {
  AttachmentLookupPort,
  AttachmentMeta,
  ConfluenceContentPort,
  ExportViewPort,
  JiraIssuePort,
  JiraIssueRef,
  MacroExportContext,
  MacroInstance,
  MacroRenderer,
  MacroRendererRegistry,
  MacroRenderResult,
  MacroWebRenderModelDescriptorV1,
} from "./types.js";
import { isAbortError, isPortError, portError } from "./types.js";

/**
 * The unknown-macro block shape renderers receive. Exported (spec 009 T4.2
 * closure classification): it is transitively reachable from the frozen
 * registry surface, so it must be a nameable part of the contract.
 */
export type UnknownBlock = Extract<ExportBlock, { type: "unknown" }>;

/**
 * Trusted resolution metadata for a block macro. This is an observation hook,
 * not another source representation: it contains only the closed registry
 * descriptor and macro name. Content remains available only through the normal
 * resolved block result, so an observer cannot accidentally become a second
 * source-payload transport.
 */
export interface MacroResolutionTraceV1 {
  readonly macroName: string;
  readonly sourcePage?: UnknownBlock["sourcePage"];
  readonly outcome: "rendered" | "fallback";
  readonly rendererId?: string;
  readonly rendererRequiresLivePort?: boolean;
  readonly webRenderModel?: MacroWebRenderModelDescriptorV1;
}

type InlineExtensionNode = Extract<InlineNode, { type: "text" }> & {
  adfExtension: NonNullable<Extract<InlineNode, { type: "text" }>["adfExtension"]>;
};

/** Walker note codes the resolver takes ownership of (positional pairing). */
const WALKER_MACRO_CODES = new Set(["unknown-macro", "macro-not-rendered"]);
const INLINE_EXTENSION_PENDING_CODE = "inline-extension-not-rendered";

/** Terminal outcome note codes this pass emits. */
export const MACRO_RENDERED_VIA = "macro-rendered-via";
export const MACRO_DEGRADED = "macro-degraded";
export const MACRO_SKIPPED_BY_CONFIG = "macro-skipped-by-config";

const DEFAULT_CONCURRENCY = 4;
const DEFAULT_RATE_LIMIT_MS = 30_000;

/** Internal marker distinguishing a deadline abort from a real port failure. */
class DeadlineError extends Error {
  constructor() {
    super("Macro resolution deadline exceeded.");
    this.name = "DeadlineError";
  }
}

interface Resolution {
  /** Blocks to splice in place of the unknown block (may be the block itself). */
  replacement: ExportBlock[];
  /** Notes replacing the walker's paired note, in order. */
  notes: ExportNote[];
  outcome: "rendered" | "fallback";
  renderer?: MacroRenderer;
}

interface InlineResolution {
  /** Inline nodes to splice at the exact source run position. */
  replacement: InlineNode[];
  /** Notes replacing the decoder's paired pending note, in order. */
  notes: ExportNote[];
}

/**
 * Resolve every `unknown` macro block and paragraph-local ADF inline extension
 * in `input.blocks` through the registry's fallback chain. Returns a new block
 * tree and a reconciled note list.
 */
export async function resolveMacroBlocks(
  input: StorageToBlocksResult,
  registry: MacroRendererRegistry,
  ctx: MacroExportContext,
  opts?: {
    live?: boolean;
    contextFor?: (page: UnknownBlock["sourcePage"]) => MacroExportContext;
    /** Stamped onto every per-instance context so the diagram renderer picks
     *  the SVG (pdf) vs. PNG (docx) preview correctly. */
    targetEngine?: "docx" | "pdf" | "web";
    /**
     * Called in source order after every block-macro resolution. Consumers
     * such as web publishing can retain closed renderer provenance without
     * re-parsing source or inspecting opaque ports.
     */
    onResolvedMacro?: (trace: MacroResolutionTraceV1) => void;
  }
): Promise<StorageToBlocksResult> {
  const live = opts?.live !== false;
  const targetEngine = opts?.targetEngine;

  // 1. Collect unknown blocks in pre-order (identity-based, so splicing is
  //    order-preserving regardless of settle order).
  const instances: UnknownBlock[] = [];
  collectUnknown(input.blocks, instances);

  // 2. Positional pairing: the i-th walker macro-note pairs with the i-th
  //    unknown block. Pairing is over the FILTERED subsequence, so unrelated
  //    notes interleaved between macro notes never shift the alignment.
  const walkerNoteIndices: number[] = [];
  input.notes.forEach((n, idx) => {
    if (WALKER_MACRO_CODES.has(n.code)) walkerNoteIndices.push(idx);
  });

  // 3. Shared cross-instance state: dedup cache + circuit breaker.
  const shared: SharedState = {
    dedup: new Map(),
    openServices: new Map(),
    now: ctx.budget?.now ?? (() => Date.now()),
    deadlineAt:
      ctx.budget?.deadlineMs !== undefined
        ? (ctx.budget.now ?? (() => Date.now()))() + ctx.budget.deadlineMs
        : undefined,
  };

  // 4. Resolve block instances through a concurrency-limited pool.
  const baseCtx: MacroExportContext = { ...ctx, documentBlocks: input.blocks };
  const limit = Math.max(1, ctx.budget?.concurrency ?? DEFAULT_CONCURRENCY);
  const resolutions = new Map<UnknownBlock, Resolution>();
  await runPool(instances, limit, async (block) => {
    if (ctx.signal?.aborted) throw new DOMException("Macro resolution aborted.", "AbortError");
    const instanceCtx = buildInstanceCtx(block, baseCtx, opts?.contextFor, shared, targetEngine);
    resolutions.set(block, await resolveInstance(block, registry, instanceCtx, live, shared));
  });

  // Invoke trace observers after the concurrent work has completed so their
  // order is source order, not port-response order. The payload deliberately
  // exposes neither MacroInstance parameters nor raw export_view HTML.
  if (opts?.onResolvedMacro) {
    for (const block of instances) {
      const resolution = resolutions.get(block);
      if (!resolution) continue;
      opts.onResolvedMacro({
        macroName: block.macroName,
        ...(block.sourcePage === undefined ? {} : { sourcePage: block.sourcePage }),
        outcome: resolution.outcome,
        ...(resolution.renderer === undefined
          ? {}
          : {
              rendererId: resolution.renderer.id,
              rendererRequiresLivePort: resolution.renderer.requiresLivePort,
              ...(resolution.renderer.webRenderModel === undefined
                ? {}
                : { webRenderModel: resolution.renderer.webRenderModel }),
            }),
      });
    }
  }

  // 5. Rebuild the tree, replacing each unknown block by identity.
  let blocks = rebuild(input.blocks, resolutions);

  // 6. Reconcile notes: replace each paired walker note with the instance's
  //    terminal note(s); append terminals for any unpaired instance.
  let notes = reconcileNotes(input.notes, walkerNoteIndices, instances, resolutions);

  // 7. Resolve paragraph-local ADF extensions only after block macros. This
  //    means an inline extension inside a retained macro body is resolved when
  //    that body is visible, while one inside superseded body content causes no
  //    needless platform call.
  const inlineInstances: InlineExtensionNode[] = [];
  collectInlineExtensions(blocks, inlineInstances);
  if (inlineInstances.length > 0) {
    const inlineResolutions = new Map<InlineExtensionNode, InlineResolution>();
    const inlineBaseCtx: MacroExportContext = { ...ctx, documentBlocks: blocks };
    await runPool(inlineInstances, limit, async (node) => {
      if (ctx.signal?.aborted) {
        throw new DOMException("Macro resolution aborted.", "AbortError");
      }
      const instanceCtx = buildSourceCtx(
        node.sourcePage,
        inlineBaseCtx,
        opts?.contextFor,
        shared,
        targetEngine,
      );
      inlineResolutions.set(
        node,
        await resolveInlineInstance(node, registry, instanceCtx, live, shared),
      );
    });
    blocks = rebuildInlineExtensions(blocks, inlineResolutions);
    notes = reconcileInlineNotes(notes, inlineInstances, inlineResolutions);
  }

  return { blocks, notes };
}

interface SharedState {
  dedup: Map<string, Promise<unknown>>;
  /** service → time (ms) the breaker opened; presence = open. */
  openServices: Map<string, number>;
  now: () => number;
  deadlineAt?: number;
}

// ---------------------------------------------------------------------------
// Per-instance resolution
// ---------------------------------------------------------------------------

async function resolveInstance(
  block: UnknownBlock,
  registry: MacroRendererRegistry,
  ctx: MacroExportContext,
  live: boolean,
  shared: SharedState
): Promise<Resolution> {
  const name = block.macroName.toLowerCase();
  const framedBody = block.extensionFrames?.flatMap((frame) => frame.content);
  const m: MacroInstance = {
    name,
    params: block.params ?? [],
    ...(block.body
      ? { body: block.body }
      : framedBody
        ? { body: framedBody }
        : {}),
    ...(block.plainBody !== undefined ? { plainBody: block.plainBody } : {}),
    ...(block.macroId !== undefined ? { macroId: block.macroId } : {}),
    ...(block.adfExtension !== undefined ? { adfExtension: block.adfExtension } : {}),
  };

  // Deadline check up front: a past-due instance degrades to skipped-by-config
  // without running the chain (never blocks the export).
  if (shared.deadlineAt !== undefined && shared.now() > shared.deadlineAt) {
    return floor(block, m, MACRO_SKIPPED_BY_CONFIG, "info", "Skipped: macro-resolution deadline exceeded.", []);
  }

  const skipNotes: ExportNote[] = [];
  let suppressedLive = false;

  for (const renderer of registry.renderers) {
    if (!rendererMatches(renderer, name)) continue;
    if (renderer.requiresLivePort && !live) {
      suppressedLive = true;
      continue; // never call a live renderer under --no-live-macros
    }
    let result: MacroRenderResult;
    try {
      result = await renderer.render(m, ctx);
    } catch (err) {
      if (isAbortError(err)) throw err;
      if (err instanceof DeadlineError) {
        return floor(block, m, MACRO_SKIPPED_BY_CONFIG, "info", "Skipped: macro-resolution deadline exceeded.", skipNotes);
      }
      // A tagged rate-limited error already recorded the open service in the
      // port wrapper. Any thrown port error falls through to the next stage.
      if (isPortError(err)) {
        skipNotes.push({
          level: "warning",
          code: MACRO_DEGRADED,
          message: `${block.macroName}: ${describePortError(err)}`,
          macroName: block.macroName,
        });
        continue;
      }
      // Untagged throw → treat as invalid-response, fall through.
      skipNotes.push({
        level: "warning",
        code: MACRO_DEGRADED,
        message: `${block.macroName}: renderer "${renderer.id}" failed (${
          err instanceof Error ? err.message : String(err)
        }).`,
        macroName: block.macroName,
      });
      continue;
    }

    if (shared.deadlineAt !== undefined && shared.now() > shared.deadlineAt) {
      return floor(
        block,
        m,
        MACRO_SKIPPED_BY_CONFIG,
        "info",
        "Skipped: macro-resolution deadline exceeded.",
        skipNotes,
      );
    }

    if (result.kind === "blocks") {
      const notes: ExportNote[] = [];
      const rendererNotes = result.notes ?? [];
      if (rendererNotes.length > 0) {
        notes.push(...rendererNotes);
      } else {
        notes.push({
          level: "info",
          code: MACRO_RENDERED_VIA,
          message: `The "${block.macroName}" macro was rendered by the "${renderer.id}" renderer.`,
          macroName: block.macroName,
        });
      }
      // Promote bodyNotes only when the rendered content derives from the body.
      if (result.bodyConsumed && block.bodyNotes) notes.push(...block.bodyNotes);
      return {
        replacement: result.blocks,
        notes,
        outcome: "rendered",
        renderer,
      };
    }

    // skip → collect its notes and fall through to the next stage.
    if (result.notes) skipNotes.push(...result.notes);
  }

  // Fell through every stage → placeholder floor.
  if (suppressedLive) {
    return floor(
      block,
      m,
      MACRO_SKIPPED_BY_CONFIG,
      "info",
      `The "${block.macroName}" macro was not resolved live (dynamic macro resolution disabled); a placeholder was emitted.`,
      skipNotes
    );
  }
  return floor(
    block,
    m,
    MACRO_DEGRADED,
    "warning",
    `The "${block.macroName}" macro could not be rendered; a placeholder was emitted.`,
    skipNotes
  );
}

/**
 * Placeholder floor: keep the original unknown block (its preserved
 * body/plainBody is rendered by the engine serializers) and promote its
 * `bodyNotes`, since the body content is now visible.
 */
function floor(
  block: UnknownBlock,
  _m: MacroInstance,
  code: ExportNoteCode,
  level: "info" | "warning",
  message: string,
  skipNotes: ExportNote[]
): Resolution {
  const alreadyHasTerminalOutcome = skipNotes.some(
    (note) => note.code === code && note.macroName === block.macroName
  );
  const notes: ExportNote[] = [
    ...skipNotes,
    ...(
      alreadyHasTerminalOutcome
        ? []
        : [{ level, code, message, macroName: block.macroName } satisfies ExportNote]
    ),
  ];
  if (block.bodyNotes) notes.push(...block.bodyNotes);
  return { replacement: [block], notes, outcome: "fallback" };
}

async function resolveInlineInstance(
  node: InlineExtensionNode,
  registry: MacroRendererRegistry,
  ctx: MacroExportContext,
  live: boolean,
  shared: SharedState,
): Promise<InlineResolution> {
  const name = node.adfExtension.extensionKey.toLowerCase();
  const instance: MacroInstance = {
    name,
    params: node.extensionParams ?? [],
    adfExtension: node.adfExtension,
  };

  if (shared.deadlineAt !== undefined && shared.now() > shared.deadlineAt) {
    return inlineFloor(
      node,
      MACRO_SKIPPED_BY_CONFIG,
      "info",
      "Skipped: macro-resolution deadline exceeded.",
      [],
    );
  }

  const renderer = registry.renderers.find((candidate) => candidate.macros.includes("*"));
  if (!renderer) {
    return inlineFloor(
      node,
      MACRO_DEGRADED,
      "warning",
      `The "${name}" inline extension has no platform export renderer; its visible fallback was retained.`,
      [],
    );
  }
  if (renderer.requiresLivePort && !live) {
    return inlineFloor(
      node,
      MACRO_SKIPPED_BY_CONFIG,
      "info",
      `The "${name}" inline extension was not resolved live (dynamic macro resolution disabled); its visible fallback was retained.`,
      [],
    );
  }

  let result: MacroRenderResult;
  try {
    result = await renderer.render(instance, ctx);
  } catch (err) {
    if (isAbortError(err)) throw err;
    if (err instanceof DeadlineError) {
      return inlineFloor(
        node,
        MACRO_SKIPPED_BY_CONFIG,
        "info",
        "Skipped: macro-resolution deadline exceeded.",
        [],
      );
    }
    const message = isPortError(err)
      ? describePortError(err)
      : `renderer "${renderer.id}" failed (${err instanceof Error ? err.message : String(err)})`;
    return inlineFloor(
      node,
      MACRO_DEGRADED,
      "warning",
      `${name}: ${message}.`,
      [],
    );
  }

  if (shared.deadlineAt !== undefined && shared.now() > shared.deadlineAt) {
    return inlineFloor(
      node,
      MACRO_SKIPPED_BY_CONFIG,
      "info",
      "Skipped: macro-resolution deadline exceeded.",
      [],
    );
  }

  if (result.kind === "blocks") {
    const replacement = paragraphLocalInline(result.blocks, node.fragments);
    if (replacement) {
      const resultNotes = result.notes ?? [{
        level: "info",
        code: MACRO_RENDERED_VIA,
        message: `The "${name}" inline extension was rendered by the "${renderer.id}" renderer.`,
        macroName: name,
      }];
      return { replacement, notes: resultNotes };
    }
    const conversionNotes = (result.notes ?? []).filter(
      (note) => note.code !== MACRO_RENDERED_VIA,
    );
    return inlineFloor(
      node,
      MACRO_DEGRADED,
      "warning",
      `The "${name}" inline extension returned block-level platform output; its paragraph-local fallback was retained.`,
      conversionNotes,
    );
  }

  return inlineFloor(
    node,
    MACRO_DEGRADED,
    "warning",
    `The "${name}" inline extension could not be rendered; its visible fallback was retained.`,
    result.notes ?? [],
  );
}

function paragraphLocalInline(
  blocks: ExportBlock[],
  fragments: InlineExtensionNode["fragments"],
): InlineNode[] | undefined {
  if (blocks.length !== 1 || blocks[0]?.type !== "paragraph" || blocks[0].content.length === 0) {
    return undefined;
  }
  const content = blocks[0].content;
  const transferredFragments = fragments ?? [];
  let attached = false;
  const attach = (nodes: InlineNode[]): InlineNode[] =>
    nodes.map((item): InlineNode => {
      if (attached) return item;
      if (item.type === "text" && item.text.length > 0) {
        attached = true;
        return transferredFragments.length > 0
          ? {
              ...item,
              fragments: [...(item.fragments ?? []), ...transferredFragments],
            }
          : item;
      }
      if (item.type === "link") return { ...item, content: attach(item.content) };
      return item;
    });
  const retained = attach(content);
  return attached ? retained : undefined;
}

function inlineFloor(
  node: InlineExtensionNode,
  code: ExportNoteCode,
  level: "info" | "warning",
  message: string,
  priorNotes: ExportNote[],
): InlineResolution {
  const alreadyHasTerminalOutcome = priorNotes.some(
    (note) =>
      note.code === code
      && note.macroName?.toLowerCase() === node.adfExtension.extensionKey.toLowerCase(),
  );
  return {
    replacement: [node],
    notes: [
      ...priorNotes,
      ...(
        alreadyHasTerminalOutcome
          ? []
          : [{
              level,
              code,
              message,
              macroName: node.adfExtension.extensionKey,
            } satisfies ExportNote]
      ),
    ],
  };
}

function rendererMatches(renderer: MacroRenderer, name: string): boolean {
  for (const m of renderer.macros) {
    if (m === "*" || m.toLowerCase() === name) return true;
  }
  return false;
}

function describePortError(err: { kind: string; message: string; service?: string }): string {
  switch (err.kind) {
    case "permission":
      return `skipped (no permission): ${err.message}`;
    case "not-found":
      return `skipped (not found): ${err.message}`;
    case "rate-limited":
      return `skipped (${err.service ?? "service"} rate-limited): ${err.message}`;
    case "network":
      return `skipped (network error): ${err.message}`;
    default:
      return `skipped (invalid response): ${err.message}`;
  }
}

// ---------------------------------------------------------------------------
// Port wrapping: dedup + circuit breaker + signal/deadline
// ---------------------------------------------------------------------------

function buildInstanceCtx(
  block: UnknownBlock,
  base: MacroExportContext,
  contextFor: ((page: UnknownBlock["sourcePage"]) => MacroExportContext) | undefined,
  shared: SharedState,
  targetEngine: "docx" | "pdf" | "web" | undefined
): MacroExportContext {
  return buildSourceCtx(
    block.sourcePage,
    base,
    contextFor,
    shared,
    targetEngine,
  );
}

function buildSourceCtx(
  sourcePage: UnknownBlock["sourcePage"],
  base: MacroExportContext,
  contextFor: ((page: UnknownBlock["sourcePage"]) => MacroExportContext) | undefined,
  shared: SharedState,
  targetEngine: "docx" | "pdf" | "web" | undefined,
): MacroExportContext {
  // Cross-plan sync point with 002: resolve each macro against its own source
  // page. `contextFor` (when supplied) yields a fresh ports/context bundle for
  // that page; otherwise fall back to the shared context (single-page export).
  const raw = sourcePage && contextFor ? contextFor(sourcePage) : base;
  const wrapped = wrapPorts(raw, shared, base.documentBlocks);
  if (targetEngine) wrapped.flags = { ...wrapped.flags, targetEngine };
  return wrapped;
}

function wrapPorts(
  ctx: MacroExportContext,
  shared: SharedState,
  documentBlocks: readonly ExportBlock[] | undefined
): MacroExportContext {
  const siteId = ctx.siteId ?? "";
  // Circuit-breaker key is service + site (consistent with the dedup key's
  // siteId): a rate-limited Jira on site A must not short-circuit a healthy
  // Jira on site B in a multi-profile/multi-site export.
  const breakerKey = (service: string): string => `${service}|${siteId}`;
  const guard = (service: string, key: string, fn: () => Promise<unknown>): Promise<unknown> => {
    if (ctx.signal?.aborted) {
      return Promise.reject(new DOMException("Macro resolution aborted.", "AbortError"));
    }
    if (shared.deadlineAt !== undefined && shared.now() > shared.deadlineAt) {
      return Promise.reject(new DeadlineError());
    }
    if (shared.openServices.has(breakerKey(service))) {
      return Promise.reject(
        portError("rate-limited", `${service} is rate-limited; skipping further calls.`, { service })
      );
    }
    const cached = shared.dedup.get(key);
    if (cached) return cached;
    const p = (async () => {
      try {
        return await fn();
      } catch (err) {
        if (isPortError(err) && err.kind === "rate-limited") {
          const svc = breakerKey(err.service ?? service);
          if (!shared.openServices.has(svc)) shared.openServices.set(svc, shared.now());
        }
        throw err;
      }
    })();
    shared.dedup.set(key, p);
    return p;
  };

  const wrapped: MacroExportContext = { ...ctx };
  if (documentBlocks !== undefined && wrapped.documentBlocks === undefined) {
    wrapped.documentBlocks = documentBlocks;
  }

  if (ctx.jira) {
    const jira = ctx.jira;
    const wrappedJira: JiraIssuePort = {
      getIssue: (key) =>
        guard("jira", stableKey({ port: "jira", method: "getIssue", siteId, key }), () =>
          jira.getIssue(key)
        ) as Promise<JiraIssueRef>,
      searchJql: (jql, o) =>
        guard(
          "jira",
          stableKey({
            port: "jira",
            method: "searchJql",
            siteId,
            jql,
            columns: [...o.columns].sort(),
            maximumIssues: o.maximumIssues,
          }),
          () => jira.searchJql(jql, o)
        ) as Promise<JiraIssueRef[]>,
    };
    wrapped.jira = wrappedJira;
  }

  if (ctx.confluence) {
    const c = ctx.confluence;
    const wrappedC: ConfluenceContentPort = {
      getPageStorage: (title, spaceKey) =>
        guard(
          "confluence",
          stableKey({ port: "confluence", method: "getPageStorage", siteId, title, spaceKey }),
          () => c.getPageStorage(title, spaceKey)
        ) as ReturnType<ConfluenceContentPort["getPageStorage"]>,
      getChildren: (pageId, o) =>
        guard(
          "confluence",
          stableKey({ port: "confluence", method: "getChildren", siteId, pageId, limit: o?.limit }),
          () => c.getChildren(pageId, o)
        ) as ReturnType<ConfluenceContentPort["getChildren"]>,
      searchCql: (cql, o) =>
        guard(
          "confluence",
          stableKey({ port: "confluence", method: "searchCql", siteId, cql, limit: o?.limit }),
          () => c.searchCql(cql, o)
        ) as ReturnType<ConfluenceContentPort["searchCql"]>,
    };
    if (c.getPageStorageById) {
      wrappedC.getPageStorageById = (id) =>
        guard(
          "confluence",
          stableKey({ port: "confluence", method: "getPageStorageById", siteId, id }),
          () => c.getPageStorageById!(id)
        ) as ReturnType<NonNullable<ConfluenceContentPort["getPageStorageById"]>>;
    }
    // Optional methods must be re-attached EXPLICITLY. This wrapper REBUILDS the
    // port instead of proxying it, so any method it does not name disappears —
    // and a renderer that feature-detects one (the Confluence list checks for
    // `searchContent`) then degrades on a host that does implement it.
    if (c.searchContent) {
      wrappedC.searchContent = (cql, o) =>
        guard(
          "confluence",
          stableKey({
            port: "confluence",
            method: "searchContent",
            siteId,
            cql,
            maximumResults: o.maximumResults,
            contentStatuses: o.contentStatuses ? [...o.contentStatuses].sort() : undefined,
          }),
          () => c.searchContent!(cql, o)
        ) as ReturnType<NonNullable<ConfluenceContentPort["searchContent"]>>;
    }
    wrapped.confluence = wrappedC;
  }

  if (ctx.exportView) {
    const ev = ctx.exportView;
    const wrappedEv: ExportViewPort = {
      renderMacroHtml: (pageId, macroId, pageVersion) =>
        guard(
          "exportView",
          stableKey({
            port: "exportView",
            method: "renderMacroHtml",
            siteId,
            pageId,
            macroId,
            pageVersion,
          }),
          () => ev.renderMacroHtml(pageId, macroId, pageVersion)
        ) as ReturnType<ExportViewPort["renderMacroHtml"]>,
    };
    wrapped.exportView = wrappedEv;
  }

  if (ctx.attachments) {
    const a = ctx.attachments;
    const wrappedA: AttachmentLookupPort = {
      lookup: (pageId, filename) =>
        guard(
          "confluence",
          stableKey({ port: "confluence", method: "attachmentLookup", siteId, pageId, filename }),
          () => a.lookup(pageId, filename)
        ) as Promise<AttachmentMeta | undefined>,
    };
    wrapped.attachments = wrappedA;
  }

  return wrapped;
}

function stableKey(obj: Record<string, unknown>): string {
  const keys = Object.keys(obj).sort();
  return JSON.stringify(keys.map((k) => [k, obj[k]]));
}

// ---------------------------------------------------------------------------
// Tree walking
// ---------------------------------------------------------------------------

function collectUnknown(blocks: ExportBlock[], out: UnknownBlock[]): void {
  for (const b of blocks) {
    switch (b.type) {
      case "unknown":
        // Unsupported ADF wrappers already have their complete static fallback
        // contract. They are not macros and must never enter a live registry
        // lookup merely because they reuse the body-bearing unknown block.
        if (!b.unsupportedAdf) out.push(b);
        break;
      case "callout":
      case "expand":
      case "blockquote":
      case "orientation":
        collectUnknown(b.content, out);
        break;
      case "list":
        for (const item of b.items) collectUnknown(item.content, out);
        break;
      case "layout":
        for (const column of b.columns) collectUnknown(column.content, out);
        break;
      case "table":
        for (const row of b.rows) for (const cell of row.cells) collectUnknown(cell.content, out);
        break;
      default:
        break;
    }
  }
}

function collectInlineExtensions(
  blocks: ExportBlock[],
  out: InlineExtensionNode[],
): void {
  const visitInline = (nodes: InlineNode[]): void => {
    for (const node of nodes) {
      if (isInlineExtensionNode(node)) out.push(node);
      if (node.type === "link") visitInline(node.content);
    }
  };
  const visitCaption = (caption: { content: InlineNode[] } | undefined): void => {
    if (caption) visitInline(caption.content);
  };

  for (const block of blocks) {
    switch (block.type) {
      case "heading":
      case "paragraph":
        visitInline(block.content);
        break;
      case "callout":
      case "expand":
      case "blockquote":
      case "orientation":
        collectInlineExtensions(block.content, out);
        break;
      case "list":
        for (const item of block.items) collectInlineExtensions(item.content, out);
        break;
      case "layout":
        for (const column of block.columns) collectInlineExtensions(column.content, out);
        break;
      case "table":
        for (const row of block.rows) {
          for (const cell of row.cells) collectInlineExtensions(cell.content, out);
        }
        visitCaption(block.caption);
        break;
      case "codeBlock":
      case "image":
      case "mediaFallback":
        visitCaption(block.caption);
        break;
      case "unknown":
        if (block.body) collectInlineExtensions(block.body, out);
        break;
      default:
        break;
    }
  }
}

function isInlineExtensionNode(node: InlineNode): node is InlineExtensionNode {
  return node.type === "text" && node.adfExtension !== undefined;
}

function rebuild(blocks: ExportBlock[], resolutions: Map<UnknownBlock, Resolution>): ExportBlock[] {
  const out: ExportBlock[] = [];
  for (const b of blocks) {
    switch (b.type) {
      case "unknown": {
        const r = resolutions.get(b);
        if (r) out.push(...r.replacement);
        else out.push(b);
        break;
      }
      case "callout":
      case "expand":
        out.push({ ...b, content: rebuild(b.content, resolutions) });
        break;
      case "blockquote":
        out.push({ ...b, content: rebuild(b.content, resolutions) });
        break;
      case "orientation":
        out.push({ ...b, content: rebuild(b.content, resolutions) });
        break;
      case "list":
        out.push({
          ...b,
          items: b.items.map((item) => ({ ...item, content: rebuild(item.content, resolutions) })),
        });
        break;
      case "layout":
        out.push({
          ...b,
          columns: b.columns.map((column) => ({
            ...column,
            content: rebuild(column.content, resolutions),
          })),
        });
        break;
      case "table":
        out.push({
          ...b,
          rows: b.rows.map((row) => ({
            ...row,
            cells: row.cells.map((cell) => ({ ...cell, content: rebuild(cell.content, resolutions) })),
          })),
        });
        break;
      default:
        out.push(b);
        break;
    }
  }
  return out;
}

function rebuildInlineExtensions(
  blocks: ExportBlock[],
  resolutions: Map<InlineExtensionNode, InlineResolution>,
): ExportBlock[] {
  const inline = (nodes: InlineNode[]): InlineNode[] => {
    const out: InlineNode[] = [];
    for (const node of nodes) {
      if (isInlineExtensionNode(node)) {
        const resolution = resolutions.get(node);
        out.push(...(resolution?.replacement ?? [node]));
      } else if (node.type === "link") {
        out.push({ ...node, content: inline(node.content) });
      } else {
        out.push(node);
      }
    }
    return out;
  };
  const caption = <T extends { content: InlineNode[] }>(value: T): T => ({
    ...value,
    content: inline(value.content),
  });

  return blocks.map((block): ExportBlock => {
    switch (block.type) {
      case "heading":
      case "paragraph":
        return { ...block, content: inline(block.content) };
      case "callout":
      case "expand":
      case "blockquote":
      case "orientation":
        return { ...block, content: rebuildInlineExtensions(block.content, resolutions) };
      case "list":
        return {
          ...block,
          items: block.items.map((item) => ({
            ...item,
            content: rebuildInlineExtensions(item.content, resolutions),
          })),
        };
      case "layout":
        return {
          ...block,
          columns: block.columns.map((column) => ({
            ...column,
            content: rebuildInlineExtensions(column.content, resolutions),
          })),
        };
      case "table":
        return {
          ...block,
          rows: block.rows.map((row) => ({
            ...row,
            cells: row.cells.map((cell) => ({
              ...cell,
              content: rebuildInlineExtensions(cell.content, resolutions),
            })),
          })),
          ...(block.caption ? { caption: caption(block.caption) } : {}),
        };
      case "codeBlock":
      case "image":
      case "mediaFallback":
        return block.caption ? { ...block, caption: caption(block.caption) } : block;
      case "unknown":
        return block.body
          ? { ...block, body: rebuildInlineExtensions(block.body, resolutions) }
          : block;
      default:
        return block;
    }
  });
}

function reconcileNotes(
  original: ExportNote[],
  walkerNoteIndices: number[],
  instances: UnknownBlock[],
  resolutions: Map<UnknownBlock, Resolution>
): ExportNote[] {
  // Map: original note index → replacement notes (the paired instance's terminal notes).
  const replacements = new Map<number, ExportNote[]>();
  const pairedCount = Math.min(walkerNoteIndices.length, instances.length);
  for (let i = 0; i < pairedCount; i++) {
    const noteIdx = walkerNoteIndices[i];
    const res = resolutions.get(instances[i]);
    replacements.set(noteIdx, res?.notes ?? []);
  }

  const out: ExportNote[] = [];
  original.forEach((n, idx) => {
    if (replacements.has(idx)) {
      out.push(...replacements.get(idx)!);
    } else {
      out.push(n);
    }
  });

  // Any instance beyond the paired count (no walker note) appends its terminal notes.
  for (let i = pairedCount; i < instances.length; i++) {
    const res = resolutions.get(instances[i]);
    if (res) out.push(...res.notes);
  }
  return out;
}

function reconcileInlineNotes(
  original: ExportNote[],
  instances: InlineExtensionNode[],
  resolutions: Map<InlineExtensionNode, InlineResolution>,
): ExportNote[] {
  const pendingIndices: number[] = [];
  original.forEach((note, index) => {
    if (note.code === INLINE_EXTENSION_PENDING_CODE) pendingIndices.push(index);
  });

  const replacements = new Map<number, ExportNote[]>();
  const pairedCount = Math.min(pendingIndices.length, instances.length);
  for (let index = 0; index < pairedCount; index++) {
    const originalIndex = pendingIndices[index]!;
    const source = original[originalIndex]?.source;
    const resolution = resolutions.get(instances[index]!);
    replacements.set(
      originalIndex,
      (resolution?.notes ?? []).map((note) =>
        source && !note.source ? { ...note, source } : note
      ),
    );
  }

  const out: ExportNote[] = [];
  original.forEach((note, index) => {
    if (replacements.has(index)) out.push(...replacements.get(index)!);
    else out.push(note);
  });
  for (let index = pairedCount; index < instances.length; index++) {
    const resolution = resolutions.get(instances[index]!);
    if (resolution) out.push(...resolution.notes);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Concurrency pool
// ---------------------------------------------------------------------------

async function runPool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const workers: Promise<void>[] = [];
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      await fn(items[i]);
    }
  };
  const n = Math.min(limit, items.length);
  for (let i = 0; i < n; i++) workers.push(worker());
  await Promise.all(workers);
}
