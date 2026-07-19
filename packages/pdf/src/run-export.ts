import type { ExportBlock, ExportNote } from "@atlcli/confluence";
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
  PdfTemplateSettings,
  PdfThemeOptions,
  PreparedPdfBlock,
} from "./types.js";
import { validatePdfOutput } from "./validate.js";

export interface PdfOutputSink {
  emit(name: string, bytes: Uint8Array, context?: { signal?: AbortSignal }): Promise<void>;
}

export type PdfExportPhase =
  | "configuration"
  | "preparing"
  | "fetching"
  | "compiling"
  | "validating"
  | "emitting";

export interface RunPdfExportInput {
  blocks: ExportBlock[];
  sourceNotes?: ExportNote[];
  metadata: PdfExportMetadata;
  profile?: PdfProfile;
  theme?: PdfThemeOptions;
  settings?: PdfTemplateSettings;
  filename: string;
  signal?: AbortSignal;
  onPhase?: (phase: PdfExportPhase) => void;
}

export interface PdfExportEnv {
  assets: PdfAssetResolver;
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
  if (isAbortError(error) || error instanceof PdfExportError) throw error;
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
        case "blockquote":
        case "orientation":
          walk(block.content);
          break;
        case "list":
          for (const item of block.items) walk(item.content);
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

export async function runPdfExport(
  input: RunPdfExportInput,
  env: PdfExportEnv
): Promise<PdfExportReport> {
  const now = env.now ?? (() => Date.now());
  const startedAt = now();
  throwIfAborted(input.signal);

  // Validate settings before any asset fetch so a settings typo never pays for
  // (or is masked by) network requests it would discard.
  input.onPhase?.("configuration");
  try {
    resolvePdfSettings(input.settings);
  } catch (error) {
    wrapFailure(error, "configuration");
  }

  input.onPhase?.("preparing");
  const prepareStarted = now();
  let prepared;
  let bundle;
  try {
    input.onPhase?.("fetching");
    prepared = await preparePdfDocument(input.blocks, env.assets);
    throwIfAborted(input.signal);
    bundle = serializePdfDocument(prepared, {
      metadata: input.metadata,
      profile: input.profile,
      theme: input.theme,
      settings: input.settings,
    });
  } catch (error) {
    wrapFailure(error, "prepare");
  }
  const prepareMs = now() - prepareStarted;
  const counts = countPrepared(prepared.blocks);

  input.onPhase?.("compiling");
  const compileStarted = now();
  let compiled;
  try {
    compiled = await env.compiler.compile(bundle, { signal: input.signal });
    throwIfAborted(input.signal);
  } catch (error) {
    wrapFailure(error, "compile");
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
    await env.output.emit(input.filename, compiled.pdf, { signal: input.signal });
  } catch (error) {
    wrapFailure(error, "emit");
  }
  const emitMs = now() - emitStarted;

  return {
    filename: input.filename,
    profile: input.profile ?? "tagged",
    compilerVersion: compiled.compilerVersion,
    pageCount: inspection.pageCount,
    embeddedImages: counts.images,
    renderedDiagrams: counts.diagrams,
    skippedAssets: counts.skipped,
    notes: [...(input.sourceNotes ?? []), ...bundle.notes],
    timings: { prepareMs, compileMs, emitMs, totalMs: now() - startedAt },
  };
}
