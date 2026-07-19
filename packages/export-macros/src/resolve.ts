/**
 * Async macro-resolution pass (spec 004, T1.7).
 *
 * Runs between `storageToBlocks` and the DOCX/PDF engines. For every `unknown`
 * block it walks the staged fallback chain (renderer → catch-all → placeholder
 * floor), takes outcome ownership of the walker's `unknown-macro`/
 * `macro-not-rendered` note, and splices the replacement blocks back at the
 * instance's original document position — regardless of which instance's port
 * call settles first.
 */
import type { ExportBlock, ExportNote, StorageToBlocksResult } from "@atlcli/confluence";
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
} from "./types.js";
import { isAbortError, isPortError, portError } from "./types.js";

type UnknownBlock = Extract<ExportBlock, { type: "unknown" }>;

/** Walker note codes the resolver takes ownership of (positional pairing). */
const WALKER_MACRO_CODES = new Set(["unknown-macro", "macro-not-rendered"]);

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
}

/**
 * Resolve every `unknown` macro block in `input.blocks` through the registry's
 * fallback chain. Returns a new block tree and a reconciled note list.
 */
export async function resolveMacroBlocks(
  input: StorageToBlocksResult,
  registry: MacroRendererRegistry,
  ctx: MacroExportContext,
  opts?: { live?: boolean; contextFor?: (page: UnknownBlock["sourcePage"]) => MacroExportContext }
): Promise<StorageToBlocksResult> {
  const live = opts?.live !== false;

  // 1. Collect unknown blocks in pre-order (identity-based, so splicing is
  //    order-preserving regardless of settle order).
  const instances: UnknownBlock[] = [];
  collectUnknown(input.blocks, instances);
  if (instances.length === 0) {
    return { blocks: input.blocks, notes: [...input.notes] };
  }

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

  // 4. Resolve instances through a concurrency-limited pool.
  const baseCtx: MacroExportContext = { ...ctx, documentBlocks: input.blocks };
  const limit = Math.max(1, ctx.budget?.concurrency ?? DEFAULT_CONCURRENCY);
  const resolutions = new Map<UnknownBlock, Resolution>();
  await runPool(instances, limit, async (block) => {
    if (ctx.signal?.aborted) throw new DOMException("Macro resolution aborted.", "AbortError");
    const instanceCtx = buildInstanceCtx(block, baseCtx, opts?.contextFor, shared);
    resolutions.set(block, await resolveInstance(block, registry, instanceCtx, live, shared));
  });

  // 5. Rebuild the tree, replacing each unknown block by identity.
  const blocks = rebuild(input.blocks, resolutions);

  // 6. Reconcile notes: replace each paired walker note with the instance's
  //    terminal note(s); append terminals for any unpaired instance.
  const notes = reconcileNotes(input.notes, walkerNoteIndices, instances, resolutions);

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
  const m: MacroInstance = {
    name,
    params: block.params ?? [],
    ...(block.body ? { body: block.body } : {}),
    ...(block.plainBody !== undefined ? { plainBody: block.plainBody } : {}),
    ...(block.macroId !== undefined ? { macroId: block.macroId } : {}),
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
      return { replacement: result.blocks, notes };
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
  code: string,
  level: "info" | "warning",
  message: string,
  skipNotes: ExportNote[]
): Resolution {
  const notes: ExportNote[] = [
    ...skipNotes,
    { level, code, message, macroName: block.macroName },
  ];
  if (block.bodyNotes) notes.push(...block.bodyNotes);
  return { replacement: [block], notes };
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
  shared: SharedState
): MacroExportContext {
  // Cross-plan sync point with 002: resolve each macro against its own source
  // page. `contextFor` (when supplied) yields a fresh ports/context bundle for
  // that page; otherwise fall back to the shared context (single-page export).
  const raw = block.sourcePage && contextFor ? contextFor(block.sourcePage) : base;
  return wrapPorts(raw, shared, base.documentBlocks);
}

function wrapPorts(
  ctx: MacroExportContext,
  shared: SharedState,
  documentBlocks: readonly ExportBlock[] | undefined
): MacroExportContext {
  const siteId = ctx.siteId ?? "";
  const guard = (service: string, key: string, fn: () => Promise<unknown>): Promise<unknown> => {
    if (ctx.signal?.aborted) {
      return Promise.reject(new DOMException("Macro resolution aborted.", "AbortError"));
    }
    if (shared.deadlineAt !== undefined && shared.now() > shared.deadlineAt) {
      return Promise.reject(new DeadlineError());
    }
    if (shared.openServices.has(service)) {
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
          const svc = err.service ?? service;
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
    wrapped.confluence = wrappedC;
  }

  if (ctx.exportView) {
    const ev = ctx.exportView;
    const wrappedEv: ExportViewPort = {
      renderMacroHtml: (pageId, macroId) =>
        guard(
          "exportView",
          stableKey({ port: "exportView", method: "renderMacroHtml", siteId, pageId, macroId }),
          () => ev.renderMacroHtml(pageId, macroId)
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
        out.push(b);
        break;
      case "callout":
      case "blockquote":
      case "orientation":
        collectUnknown(b.content, out);
        break;
      case "list":
        for (const item of b.items) collectUnknown(item.content, out);
        break;
      case "table":
        for (const row of b.rows) for (const cell of row.cells) collectUnknown(cell.content, out);
        break;
      default:
        break;
    }
  }
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
      case "table":
        out.push({
          ...b,
          rows: b.rows.map((row) => ({
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
