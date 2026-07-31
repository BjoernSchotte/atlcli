import {
  AssetBudgetExceededError,
  type ExportBlock,
  type ExportNote,
  type ExportProgressCallback,
} from "@atlcli/confluence";
import { resolveMacroBlocks, type MacroResolutionOptions } from "@atlcli/export-macros";
import type { TemplateManifest } from "@atlcli/template-pack";
import {
  clonePdfTemplateRuntime,
  type ValidatedPdfTemplatePackV1,
} from "./template-pack.js";
import { pdfBytesFromUint8Array, type PdfBytesHandle } from "./bytes-handle.js";
import { formatPdfCompilerDiagnostics, type PdfCompilePort } from "./compiler.js";
import { preparePdfDocument } from "./prepare.js";
import { resolvePdfSettings } from "./settings.js";
import { serializePdfDocument } from "./serialize.js";
import type {
  PdfAssetResolver,
  PdfCompilerDiagnostic,
  PdfExportMetadata,
  PdfExportReport,
  PdfProfile,
  PdfSourceBundle,
  PdfTemplateSettings,
  PdfThemeOptions,
  PreparedPdfBlock,
} from "./types.js";
import { validatePdfOutput } from "./validate.js";
import {
  resolveCodeThemeId,
  type CodeThemeId,
} from "@atlcli/code-highlight/registry";
import type { ExportImageQualityV1 } from "@atlcli/export-media";

export interface PdfOutputSink {
  /**
   * Commit one compiled document.
   *
   * Takes a {@link PdfBytesHandle} rather than a `Uint8Array` (spec 010, T5.6):
   * a sink that wants a `Blob` asks the handle for one instead of building a
   * second full copy of the document next to the first. Node sinks call
   * `await bytes.asUint8Array()`, which for the default array-backed handle is
   * the original buffer, not a copy.
   */
  emit(name: string, bytes: PdfBytesHandle, context?: { signal?: AbortSignal }): Promise<void>;
}

export type PdfExportPhase =
  | "configuration"
  | "preparing"
  | "fetching"
  | "compiling"
  | "validating"
  | "emitting";

export interface RunPdfExportInput {
  /** Bundled Shiki theme for code blocks; defaults to `github-light`. */
  codeTheme?: CodeThemeId;
  blocks: ExportBlock[];
  sourceNotes?: ExportNote[];
  metadata: PdfExportMetadata;
  profile?: PdfProfile;
  theme?: PdfThemeOptions;
  settings?: PdfTemplateSettings;
  /** Curated template manifest to render with (spec 012). Defaults to built-in. */
  templateManifest?: TemplateManifest;
  /**
   * Explicit image-quality profile (issue #118 Phase 1/3): `standard`/`print`
   * (or an `imagePpi` override) deterministically downscale rasters before
   * embedding. Absent means `original` — byte-identical rasters.
   */
  imageQuality?: ExportImageQualityV1;
  /** Fully validated template pack including visual assets/decorations. */
  templatePack?: ValidatedPdfTemplatePackV1;
  filename: string;
  signal?: AbortSignal;
  onPhase?: (phase: PdfExportPhase) => void;
  /** Granular progress callback (spec 002 — asset embedding + emit phases). */
  onProgress?: ExportProgressCallback;
  /**
   * Whether the composed document is complete (spec 002 completeness contract);
   * surfaced at the top of the report. Defaults to `true`.
   */
  complete?: boolean;
  /**
   * The root/source page context for dynamic-macro resolution (spec 004). Used
   * as the fallback `MacroExportContext.page` for single-page exports (tree/space
   * exports carry per-instance `unknown.sourcePage`). Absent → derived from
   * `metadata` (space/version only, no page id).
   */
  page?: { id: string; version?: number; spaceKey?: string };
}

export interface PdfExportEnv {
  assets: PdfAssetResolver;
  compiler: PdfCompilePort;
  output: PdfOutputSink;
  now?: () => number;
  /**
   * Dynamic-macro resolution options (spec 004). Applied during the `preparing`
   * phase before `preparePdfDocument`. Omitting it reproduces today's output.
   */
  macros?: MacroResolutionOptions;
}

/** Dependencies used before a PDF reaches its durable render checkpoint. */
export interface PreparePdfExportEnv {
  assets: PdfAssetResolver;
  now?: () => number;
  macros?: MacroResolutionOptions;
}

/** Complete engine state that can be persisted as a ready-to-render checkpoint. */
export interface PreparedPdfExportV1 {
  schema: "atlcli.prepared-pdf-export/1";
  /**
   * Complete Typst VFS for one render attempt.
   *
   * `renderPreparedPdfExport()` takes ownership by setting this field to
   * `undefined` before it invokes the compiler. A durable checkpoint therefore
   * remains the source of truth and must materialize a fresh clone for every
   * retry; reusing an already-consumed value fails closed.
   */
  bundle: PdfSourceBundle | undefined;
  filename: string;
  codeTheme: CodeThemeId;
  profile: PdfProfile;
  language?: string;
  sourceNotes: ExportNote[];
  bundleNotes: ExportNote[];
  counts: { images: number; diagrams: number; skipped: number };
  complete: boolean;
  startedAt: number;
  prepareMs: number;
}

/** Per-attempt hooks deliberately excluded from the durable checkpoint. */
export interface RenderPreparedPdfExportInput {
  signal?: AbortSignal;
  onPhase?: (phase: Extract<PdfExportPhase, "compiling" | "validating" | "emitting">) => void;
  onProgress?: ExportProgressCallback;
}

/** Dependencies materialized only after the host admits the heavy render. */
export interface RenderPreparedPdfExportEnv {
  compiler: PdfCompilePort;
  output: PdfOutputSink;
  now?: () => number;
}

export type PdfExportErrorPhase = "configuration" | "prepare" | "compile" | "validate" | "emit";

export class PdfExportError extends Error {
  readonly phase: PdfExportErrorPhase;
  readonly diagnostics: PdfCompilerDiagnostic[];
  override readonly cause?: unknown;

  constructor(
    message: string,
    options: { phase: PdfExportErrorPhase; diagnostics?: PdfCompilerDiagnostic[]; cause?: unknown }
  ) {
    super(message, { cause: options.cause });
    this.name = "PdfExportError";
    this.phase = options.phase;
    this.diagnostics = options.diagnostics ?? [];
    this.cause = options.cause;
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("PDF export was cancelled.", "AbortError");
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError"
    || error instanceof Error && error.name === "AbortError";
}

function wrapFailure(error: unknown, phase: PdfExportErrorPhase): never {
  // A shared asset-budget breach propagates UNWRAPPED (like an abort) so both
  // engines surface the identical AssetBudgetExceededError — the parity contract
  // (spec 002): same error type, same offender list.
  if (
    isAbortError(error) ||
    error instanceof PdfExportError ||
    error instanceof AssetBudgetExceededError
  ) {
    throw error;
  }
  const message = error instanceof Error ? error.message : String(error);
  throw new PdfExportError(message, { phase, cause: error });
}

function countPrepared(blocks: PreparedPdfBlock[]): { images: number; diagrams: number; skipped: number } {
  const total = { images: 0, diagrams: 0, skipped: 0 };
  const walk = (items: PreparedPdfBlock[]): void => {
    for (const block of items) {
      switch (block.type) {
        case "image":
          if (block.assetPath) total.images += 1;
          else total.skipped += 1;
          break;
        case "diagram":
          total.diagrams += 1;
          break;
        case "callout":
        case "expand":
        case "blockquote":
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
          for (const row of block.rows) for (const cell of row.cells) walk(cell.content);
          break;
      }
    }
  };
  walk(blocks);
  return total;
}

export function normalizePdfLocale(locale: string | undefined): { language: string; region?: string } {
  const parts = (locale ?? "").trim().replaceAll("_", "-").split("-").filter(Boolean);
  const rawLanguage = parts[0] ?? "";
  const language = /^[a-z]{2,3}$/i.test(rawLanguage) ? rawLanguage.toLowerCase() : "en";
  const rawRegion = parts.slice(1).find((part) => /^(?:[a-z]{2}|[0-9]{3})$/i.test(part));
  return rawRegion ? { language, region: rawRegion.toUpperCase() } : { language };
}

/**
 * A usable ISO 639 language subtag (spec 011, PDF/UA language audit).
 *
 * This deliberately does NOT reuse {@link normalizePdfLocale}, which is a
 * *coercion*: it silently rewrites anything unparseable to `"en"`, which is the
 * right behavior for rendering (a document must have some language) and exactly
 * the wrong one for auditing — the audit's whole job is to notice that the
 * fallback was taken.
 */
function isUsableLanguage(language: string | undefined): boolean {
  // A bare ISO 639 subtag is the documented shape of `PdfExportMetadata.language`
  // (region travels in its own field), but a caller passing a full BCP-47 tag
  // there still names the language correctly — that is a tidiness issue, not an
  // accessibility defect, so it must not raise an audit warning.
  return /^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i.test((language ?? "").trim());
}

/**
 * Language notes for one export (spec 011, PDF/UA 7.2). Pure over the two facts
 * that decide it, so the branch table is unit-testable without a compiler.
 *
 * Two independent defects, one code:
 *  - the CALLER supplied no usable language, so the template's `"en"` default
 *    silently claims English for a document that may be in any language; and
 *  - the COMPILED file carries no catalog `/Lang` at all, which a Level-B
 *    template can cause even when the metadata was fine.
 */
export function auditPdfLanguage(input: {
  language?: string;
  hasLang: boolean;
}): ExportNote[] {
  const notes: ExportNote[] = [];
  if (!isUsableLanguage(input.language)) {
    const supplied = (input.language ?? "").trim();
    notes.push({
      level: "warning",
      code: "pdf-language-missing",
      message:
        (supplied
          ? `The export metadata's language "${supplied}" is not a usable language tag, so `
          : "The export metadata carries no document language, so ") +
        `the PDF declares "en". Assistive technology uses that declaration to pick pronunciation, ` +
        `so an incorrect one is worse than a guess — set the export language explicitly.`,
    });
  }
  if (!input.hasLang) {
    notes.push({
      level: "warning",
      code: "pdf-language-missing",
      message:
        "The compiled PDF's document catalog declares no /Lang entry. A tagged PDF without a " +
        "document language does not satisfy PDF/UA-1 7.2; check the active template.",
    });
  }
  return notes;
}

export async function preparePdfExport(
  input: RunPdfExportInput,
  env: PreparePdfExportEnv,
): Promise<PreparedPdfExportV1> {
  const now = env.now ?? (() => Date.now());
  const startedAt = now();
  throwIfAborted(input.signal);
  const codeTheme = resolveCodeThemeId(input.codeTheme);
  // Freeze the accepted runtime at the call boundary. Source resolution and
  // document-asset fetching are asynchronous; callers cannot alter a pack's
  // source or visual bytes while preparation is in flight.
  const templatePack =
    input.templatePack === undefined
      ? undefined
      : clonePdfTemplateRuntime(input.templatePack);

  // Validate settings before any asset fetch so a settings typo never pays for
  // (or is masked by) network requests it would discard. The resolved object is
  // forwarded to serialize, whose own resolve call short-circuits on it.
  input.onPhase?.("configuration");
  let settings;
  try {
    settings = resolvePdfSettings(input.settings, {
      ...(input.metadata.language !== undefined ? { locale: input.metadata.language } : {}),
      ...(input.metadata.region !== undefined ? { region: input.metadata.region } : {}),
      ...(input.theme !== undefined ? { theme: input.theme } : {}),
      ...(input.templateManifest !== undefined ? { manifest: input.templateManifest } : {}),
      ...(templatePack !== undefined ? { templatePack } : {}),
    });
  } catch (error) {
    wrapFailure(error, "configuration");
  }

  input.onPhase?.("preparing");
  const prepareStarted = now();
  // `prepared` and `bundle` are declared `| undefined` and NULLED OUT the moment
  // the last thing that needs them has been taken (spec 010, T5.6). They used to
  // stay in scope through compile, validate AND emit, so an image-heavy export
  // held its entire asset bundle — up to the shared 50 MiB
  // `ASSET_MAX_TOTAL_BYTES` cap — alive at exactly the moment the compiler holds
  // its own copy of the same bytes in WASM memory and the finished PDF is being
  // written. Nothing below reads them again; the two facts the report still
  // needs (`counts`, `bundle.notes`) are hoisted out first.
  let prepared: Awaited<ReturnType<typeof preparePdfDocument>> | undefined;
  let bundle: ReturnType<typeof serializePdfDocument> | undefined;
  let resolvedNotes: ExportNote[] = input.sourceNotes ?? [];
  try {
    // Dynamic-macro resolution (spec 004): staged fallback chain before layout.
    let blocks = input.blocks;
    if (env.macros) {
      const rootPage =
        input.page ??
        {
          id: "",
          ...(input.metadata.version !== undefined ? { version: input.metadata.version } : {}),
          ...(input.metadata.space !== undefined ? { spaceKey: input.metadata.space } : {}),
        };
      const resolved = await resolveMacroBlocks(
        { blocks, notes: resolvedNotes },
        env.macros.registry,
        env.macros.contextFor(rootPage),
        {
          ...(env.macros.live !== undefined ? { live: env.macros.live } : {}),
          contextFor: (p) => env.macros!.contextFor(p ?? rootPage),
          targetEngine: "pdf",
        }
      );
      blocks = resolved.blocks;
      resolvedNotes = resolved.notes;
    }
    input.onPhase?.("fetching");
    prepared = await preparePdfDocument(blocks, env.assets, {
      codeTheme,
      ...(input.onProgress ? { onProgress: input.onProgress } : {}),
      ...(input.signal ? { signal: input.signal } : {}),
      // Provenance fallback for the alt-text audit (spec 011): a single-page
      // export's blocks carry no page id of their own, but the caller knows it.
      ...(input.page?.id ? { pageContext: { pageId: input.page.id } } : {}),
      ...(input.imageQuality ? { imageQuality: input.imageQuality } : {}),
    });
    throwIfAborted(input.signal);
    bundle = serializePdfDocument(prepared, {
      metadata: input.metadata,
      profile: input.profile,
      theme: input.theme,
      settings,
      ...(input.templateManifest !== undefined ? { templateManifest: input.templateManifest } : {}),
      ...(input.imageQuality ? { imageQuality: input.imageQuality } : {}),
      ...(templatePack !== undefined ? { templatePack } : {}),
    });
  } catch (error) {
    wrapFailure(error, "prepare");
  }
  const prepareMs = now() - prepareStarted;
  const counts = countPrepared(prepared!.blocks);
  // `prepared` is dead here: `counts` is the only thing downstream reads from
  // it, and the bundle already holds its own serialized copy of the assets.
  prepared = undefined;
  // The notes are the only part of the bundle the report needs, so they survive
  // the bundle itself.
  const bundleNotes = bundle!.notes;

  return {
    schema: "atlcli.prepared-pdf-export/1",
    codeTheme,
    bundle: bundle!,
    filename: input.filename,
    profile: input.profile ?? "tagged",
    ...(input.metadata.language !== undefined ? { language: input.metadata.language } : {}),
    sourceNotes: resolvedNotes,
    bundleNotes,
    counts,
    complete: input.complete ?? true,
    startedAt,
    prepareMs,
  };
}

/** Compile, validate, and emit one already prepared PDF render attempt. */
export async function renderPreparedPdfExport(
  prepared: PreparedPdfExportV1,
  input: RenderPreparedPdfExportInput,
  env: RenderPreparedPdfExportEnv,
): Promise<PdfExportReport> {
  if (prepared.schema !== "atlcli.prepared-pdf-export/1") {
    throw new PdfExportError("Unsupported prepared PDF export schema.", { phase: "compile" });
  }
  const now = env.now ?? (() => Date.now());
  throwIfAborted(input.signal);
  let bundle: PdfSourceBundle | undefined = prepared.bundle;
  if (!bundle) {
    throw new PdfExportError(
      "Prepared PDF export was already consumed; materialize a fresh checkpoint value before retrying.",
      { phase: "compile" },
    );
  }
  const fontRequirements = bundle.fontRequirements;
  // Move, do not borrow: while Typst/WASM and the resulting PDF are alive, the
  // caller-visible prepared value must not keep a second route to the complete
  // VFS. A retry rematerializes a fresh clone from the durable checkpoint.
  prepared.bundle = undefined;

  input.onPhase?.("compiling");
  const compileStarted = now();
  let compiled;
  try {
    compiled = await env.compiler.compile(bundle!, { signal: input.signal });
    throwIfAborted(input.signal);
  } catch (error) {
    wrapFailure(error, "compile");
  } finally {
    // Released in `finally`, not after the `await`: on a compile failure the
    // error travels up through callers that may hold the frame alive, and there
    // is no reason for the asset bundle to travel with it.
    bundle = undefined;
  }
  const compileMs = now() - compileStarted;
  if (!compiled.pdf) {
    throw new PdfExportError(formatPdfCompilerDiagnostics(compiled.diagnostics), {
      phase: "compile",
      diagnostics: compiled.diagnostics,
    });
  }

  input.onPhase?.("validating");
  let inspection;
  try {
    throwIfAborted(input.signal);
    inspection = validatePdfOutput(compiled.pdf);
    throwIfAborted(input.signal);
  } catch (error) {
    wrapFailure(error, "validate");
  }

  input.onPhase?.("emitting");
  const emitStarted = now();
  try {
    // Abort is honored *before* emit; once the sink has committed the bytes we
    // must not turn an already-written file into a reported failure, so there
    // is deliberately no post-emit abort re-check here.
    throwIfAborted(input.signal);
    input.onProgress?.({ phase: "emit", done: 0, total: 1, detail: prepared.filename });
    await env.output.emit(prepared.filename, pdfBytesFromUint8Array(compiled.pdf), {
      signal: input.signal,
    });
    input.onProgress?.({ phase: "emit", done: 1, total: 1, detail: prepared.filename });
  } catch (error) {
    wrapFailure(error, "emit");
  }
  const emitMs = now() - emitStarted;

  return {
    // Historical /1 checkpoints predate codeTheme. New writers pin the field,
    // while resumed old checkpoints retain github-light compatibility.
    codeTheme: resolveCodeThemeId(prepared.codeTheme),
    filename: prepared.filename,
    profile: prepared.profile,
    compilerVersion: compiled.compilerVersion,
    ...(fontRequirements ? { fontRequirements } : {}),
    ...(compiled.fontEvidence ? { fontEvidence: compiled.fontEvidence } : {}),
    pageCount: inspection.pageCount,
    embeddedImages: prepared.counts.images,
    renderedDiagrams: prepared.counts.diagrams,
    skippedAssets: prepared.counts.skipped,
    notes: [
      ...prepared.sourceNotes,
      ...prepared.bundleNotes,
      // PDF/UA language audit (spec 011). Appended after the compile because
      // one of its two inputs is a property of the produced FILE, not of the
      // request — `hasLang` comes from inspecting the real output bytes.
      ...auditPdfLanguage({
        ...(prepared.language !== undefined ? { language: prepared.language } : {}),
        hasLang: inspection.hasLang,
      }),
    ],
    // The host's source notes as the macro resolver left them (spec 010): a
    // per-source-page view rebuilt from the PRE-resolution walk contradicts this
    // aggregate — it still claims a live-rendered macro did not render.
    sourceNotes: prepared.sourceNotes,
    complete: prepared.complete,
    // Surface diagnostics even on a successful compile (spec 008 T3.4) so a host
    // can fail `--strict` on real Typst warnings.
    compilerDiagnostics: compiled.diagnostics,
    timings: {
      prepareMs: prepared.prepareMs,
      compileMs,
      emitMs,
      totalMs: now() - prepared.startedAt,
    },
  };
}

export async function runPdfExport(
  input: RunPdfExportInput,
  env: PdfExportEnv,
): Promise<PdfExportReport> {
  const prepared = await preparePdfExport(input, env);
  return renderPreparedPdfExport(prepared, input, env);
}
