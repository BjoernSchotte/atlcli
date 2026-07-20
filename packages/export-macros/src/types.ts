/**
 * Macro-renderer ports and registry types (spec 004, E1–E5).
 *
 * This module is the isomorphic contract for the macro fallback chain: pure
 * data + interface definitions, no HTTP, no client imports, no host APIs. Every
 * renderer is a pure function over the ports declared here; each host (CLI,
 * extension, future) supplies its own port implementations over its own HTTP
 * adapter.
 *
 * Import boundary: `@atlcli/confluence` is imported **type-only** (for
 * `ExportBlock`/`ExportNote`/`MacroParameter`) — this package takes no runtime
 * import from any `@atlcli/*` package, enforced by the browser-build gate
 * (`scripts/check-browser-build.ts`).
 */
import type { ExportBlock, ExportNote, MacroParameter } from "@atlcli/confluence";

/**
 * One macro instance the resolver hands to a renderer. Mirrors the enriched
 * `unknown` block spec 001 landed (`export-blocks.ts`), minus the block-level
 * `sourcePage`/`bodyNotes` bookkeeping the resolver owns itself.
 */
export interface MacroInstance {
  name: string;
  params: MacroParameter[];
  body?: ExportBlock[];
  plainBody?: string;
  macroId?: string;
}

/**
 * Stable per-instance key for report correlation and `visited`/dedup
 * bookkeeping. Internal to the resolver — never round-tripped through
 * `ExportNote` (which carries no `macroId`/`instanceId` field).
 */
export type MacroInstanceId = string;

/**
 * A renderer's outcome. `blocks` replaces the macro with real content;
 * `skip` falls through to the next stage of the chain. Both carry optional
 * notes so a permission or rate-limit skip is never silent.
 */
export type MacroRenderResult =
  | {
      kind: "blocks";
      blocks: ExportBlock[];
      notes?: ExportNote[];
      /**
       * `true` when the rendered blocks derive from `m.body` (transparent-body
       * passthroughs: scroll-tablelayout, excerpt, …). Tells the resolver to
       * promote the macro's `bodyNotes` (spec 001 deferral) alongside the
       * terminal note. `false`/absent when the body was superseded by
       * port-fetched content (Jira table, export_view HTML) — those `bodyNotes`
       * annotate content that no longer appears and are dropped.
       */
      bodyConsumed?: boolean;
    }
  | { kind: "skip"; notes?: ExportNote[] };

/**
 * Tagged reason a port call failed, so the resolver decides fall-through vs.
 * abort without parsing error strings. Ports SHOULD reject with a
 * {@link PortError}; the resolver treats any other thrown error as
 * `"invalid-response"` (fall through) except `AbortError`/`ctx.signal.aborted`,
 * which always propagates and stops the whole export.
 */
export type PortErrorKind =
  | "permission"
  | "not-found"
  | "rate-limited"
  | "network"
  | "invalid-response";

export interface PortError extends Error {
  readonly kind: PortErrorKind;
  /**
   * Present on `"rate-limited"`; drives the per-port circuit breaker. Parsed
   * from a `Retry-After` header when the client surfaces one, else a
   * conservative default.
   */
  readonly retryAfterMs?: number;
  /** Which port raised this (`"jira"`, `"confluence"`, `"exportView"`, …). */
  readonly service?: string;
}

/** Construct a tagged {@link PortError} (convenience for host adapters). */
export function portError(
  kind: PortErrorKind,
  message: string,
  opts?: { retryAfterMs?: number; service?: string; cause?: unknown }
): PortError {
  const err = new Error(message) as Error & {
    kind: PortErrorKind;
    retryAfterMs?: number;
    service?: string;
  };
  err.name = "PortError";
  err.kind = kind;
  if (opts?.retryAfterMs !== undefined) err.retryAfterMs = opts.retryAfterMs;
  if (opts?.service !== undefined) err.service = opts.service;
  if (opts?.cause !== undefined) (err as { cause?: unknown }).cause = opts.cause;
  return err;
}

/** Narrow an unknown thrown value to a {@link PortError}. */
export function isPortError(e: unknown): e is PortError {
  if (!(e instanceof Error)) return false;
  const kind = (e as unknown as { kind?: unknown }).kind;
  return (
    typeof kind === "string" &&
    ["permission", "not-found", "rate-limited", "network", "invalid-response"].includes(kind)
  );
}

/** True for an `AbortError` (DOMException or plain Error). */
export function isAbortError(e: unknown): boolean {
  return e instanceof Error && e.name === "AbortError";
}

export interface MacroRenderer {
  /** `ac:name` values, lowercase; `"*"` = catch-all. */
  readonly macros: readonly string[];
  /** Stable identity for introspection, override resolution, docs listing. */
  readonly id: string;
  /**
   * `false` for renderers that only read `m.params`/`m.body` (TOC,
   * scroll-tablelayout, transparent-body passthroughs) — these still run under
   * `--no-live-macros`. `true` for anything that touches a port. Required, not
   * defaulted.
   */
  readonly requiresLivePort: boolean;
  render(m: MacroInstance, ctx: MacroExportContext): Promise<MacroRenderResult>;
}

/**
 * Metadata `AttachmentLookupPort.lookup` returns instead of a bare boolean —
 * needed by the diagram renderer's staleness note and any future consumer.
 */
export interface AttachmentMeta {
  filename: string;
  version: number;
  /** ISO timestamp of the attachment's last version, when the host exposes it. */
  modified?: string;
}

// ---------------------------------------------------------------------------
// Ports (interfaces only — no client imports)
// ---------------------------------------------------------------------------

export interface JiraIssueRef {
  key: string;
  summary: string;
  /** Status name, e.g. "In Progress". */
  status: string;
  /** Confluence status color name (already mapped from Jira statusCategory). */
  statusColor: string;
  /** Browse URL (`${baseUrl}/browse/${key}`), NOT the REST self link. */
  url: string;
  /** Arbitrary extra columns keyed by lowercase field id, for JQL tables. */
  fields?: Record<string, string>;
}

export interface JiraIssuePort {
  getIssue(key: string): Promise<JiraIssueRef>;
  searchJql(
    jql: string,
    opts: { columns: string[]; maximumIssues: number }
  ): Promise<JiraIssueRef[]>;
}

export interface ConfluenceContentPort {
  /** Fetch a page's storage by title (+ space). `undefined` = not found. */
  getPageStorage(
    title: string,
    spaceKey?: string
  ): Promise<{ id: string; version: number; storage: string } | undefined>;
  /** Fetch a page's storage by id. `undefined` = not found. */
  getPageStorageById?(
    id: string
  ): Promise<{ id: string; version: number; storage: string } | undefined>;
  getChildren(
    pageId: string,
    opts?: { limit?: number }
  ): Promise<{ id: string; title: string }[]>;
  searchCql(cql: string, opts?: { limit?: number }): Promise<{ id: string; title: string }[]>;
}

export interface ExportViewPort {
  /** Server-side render a macro to HTML via the `export_view` representation. */
  renderMacroHtml(pageId: string, macroId: string): Promise<string | undefined>;
}

export interface AttachmentLookupPort {
  lookup(pageId: string, filename: string): Promise<AttachmentMeta | undefined>;
}

/** Origin-check building block for {@link ExternalAssetFetcher}. */
export interface ExternalAssetPolicy {
  allow(url: string): boolean;
}

/**
 * Sink-side contract for fetching non-attachment external bytes
 * (`export_view`-sourced `<img>` URLs). Enforces a policy across redirects and
 * caps memory — a naive `fetch()` can do neither.
 */
export interface ExternalAssetFetcher {
  fetch(
    url: string,
    opts: { maxBytes: number; signal?: AbortSignal }
  ): Promise<{ bytes: Uint8Array; mediaType?: string }>;
}

export interface MacroResolutionBudget {
  /** Max concurrent in-flight port calls across the resolve pass. Default 4. */
  concurrency?: number;
  /**
   * Wall-clock deadline for the whole resolve pass; exceeding it degrades all
   * remaining macro instances to `skipped-by-config` rather than failing.
   */
  deadlineMs?: number;
  /** Injected clock for tests; defaults to `Date.now`. */
  now?: () => number;
}

export interface MacroExportContext {
  /** The macro's *source* page (per-instance in tree/space exports). */
  page: { id: string; version?: number; spaceKey?: string };
  confluence?: ConfluenceContentPort;
  jira?: JiraIssuePort;
  exportView?: ExportViewPort;
  attachments?: AttachmentLookupPort;
  externalAssets?: ExternalAssetFetcher;
  /** Recursion guards, shared across include-style renderers. */
  depth: number;
  visited: Set<string>;
  /** Checked cooperatively between port calls (see resolve.ts). */
  signal?: AbortSignal;
  budget?: MacroResolutionBudget;
  /**
   * Multi-site disambiguation for the dedup cache key. Two textually-identical
   * JQL queries against different sites must not share a cache entry.
   */
  siteId?: string;
  /**
   * Renderer-level flags threaded from {@link MacroResolutionOptions}. E.g.
   * `nativeTocPresent` lets the TOC renderer suppress a duplicate body-TOC when
   * the DOCX template already carries a native TOC field.
   */
  flags?: {
    nativeTocPresent?: boolean;
    /**
     * Which engine this export targets. The diagram renderer prefers an SVG
     * preview only for `"pdf"` (PDF renders SVG natively); DOCX has no
     * arbitrary-SVG-attachment seam yet (blocked on 006-word-quality G4/T1.15),
     * so it stays on the PNG preview.
     */
    targetEngine?: "docx" | "pdf";
  };
  /**
   * The whole composed document's block tree, set by the resolver. The TOC
   * renderer scans it for headings; most renderers ignore it. Read-only.
   */
  documentBlocks?: readonly ExportBlock[];
}

/**
 * An immutable, validated ordering of renderers — the "port" the goal promises.
 */
export interface MacroRendererRegistry {
  readonly renderers: readonly MacroRenderer[];
  /**
   * Returns a new registry with `overrides` placed before the built-ins,
   * keeping first-match-wins semantics; still validated.
   */
  compose(...overrides: MacroRenderer[]): MacroRendererRegistry;
}

/** Options threaded through `ExportInput`/`PdfExportEnv` (engine hook-in). */
export interface MacroResolutionOptions {
  registry: MacroRendererRegistry;
  /**
   * Builds the per-page {@link MacroExportContext}. A function, not a static
   * object, because tree/space exports need a fresh context per source page.
   */
  contextFor(page: { id: string; version?: number; spaceKey?: string }): MacroExportContext;
  /**
   * `false` disables stages 2–3 for `requiresLivePort: true` renderers only.
   * Pure renderers keep running. Default `true`.
   */
  live?: boolean;
}
