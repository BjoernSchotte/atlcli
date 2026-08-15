/**
 * The imperative-shell contract of the isomorphic export engine (spec 006 §2.3).
 *
 * The engine itself is pure: `ExportBlock[]` → OOXML, placeholder resolution,
 * docxtemplater orchestration. The three places hosts genuinely differ —
 * where the template comes from, how attachment bytes are fetched, and where
 * the finished document goes — are injected through this interface set.
 * None of the interfaces has a default that assumes a browser (or Node): the
 * extension supplies IndexedDB / session-fetch / download implementations,
 * a Node host supplies filesystem / token-auth ones. Mirrors the spec-001
 * `TokenResolver`/`LogSink` injection pattern.
 */
import { exportDocx, type ExportInput, type ExportReport } from "./export.js";
import type { MacroResolutionOptions } from "@atlcli/export-macros";

/**
 * Optional per-call context threaded into the host seams (spec 002 cancellation).
 * Mirrors the `TreeSource` port context and PDF's sink context so a `Ctrl-C`
 * abort stops in-flight asset downloads and the final file write, not just new
 * orchestration.
 */
export interface HostCallContext {
  signal?: AbortSignal;
}

/** Where template bytes come from (extension: IndexedDB blob · CLI: readFile). */
export interface TemplateSource {
  getBytes(id: string, context?: HostCallContext): Promise<Uint8Array>;
}

/**
 * A reference to a page asset (attachment) the engine needs to embed.
 * Attachment refs carry a wiki-base-relative `url` (the same shape as the
 * Confluence API's own `downloadUrl`); external images carry their absolute
 * URL. The OOXML image module (spec 005) drives this seam.
 */
export interface AssetRef {
  /** Download URL of the asset (absolute, or site-relative for session hosts). */
  url: string;
  /** Owning page id, when known. */
  pageId?: string;
  /** Attachment filename, when known. */
  filename?: string;
  /**
   * Provenance (spec 004). `"page"` (default/absent) is a page-author ref on the
   * trusted asset path; `"export-view"` is a URL from a third-party app's
   * rendered macro HTML, which a host SHOULD route through its stricter
   * `ExternalAssetFetcher`/policy rather than an unrestricted fetch.
   */
  trust?: "page" | "export-view";
}

/** How asset bytes are fetched (extension: session fetch · CLI: token client). */
export interface AssetFetcher {
  fetch(ref: AssetRef, context?: HostCallContext): Promise<Uint8Array>;
}

/** Where the finished document goes (extension: download · CLI: writeFile). */
export interface OutputSink {
  emit(name: string, bytes: Uint8Array, context?: HostCallContext): Promise<void>;
}

/**
 * How an SVG becomes PNG bytes (spec 005a §2.4). Rasterization is inherently
 * a host capability — the engine has no canvas — so it is injected like the
 * other seams: the extension panel supplies a `<canvas>` implementation, a
 * Node/server host can plug in resvg or similar later. Callers pass the
 * TARGET pixel size (the engine asks for 2× the diagram's intrinsic size);
 * the returned bytes MUST be a well-formed PNG. A host with no rasterizer
 * omits it — mermaid diagrams then stay readable source code blocks.
 */
export interface SvgRasterizer {
  rasterize(
    svg: string,
    target: { widthPx: number; heightPx: number },
    context?: HostCallContext
  ): Promise<Uint8Array>;
}

/** Everything a host must supply to run an export. */
export interface ExportEnv {
  templates: TemplateSource;
  /**
   * How image bytes are fetched (spec 005). A host with no asset path simply
   * omits it — images then degrade to report notes instead of embedding.
   */
  assets?: AssetFetcher;
  /**
   * SVG → PNG rasterization (spec 005a). Omit it and mermaid diagrams
   * degrade to source code blocks with a report note.
   */
  rasterizer?: SvgRasterizer;
  /**
   * Dynamic-macro resolution options (spec 004), threaded into
   * {@link ExportInput.macros} by {@link runExport} the same way
   * `assets`/`rasterizer` are. A host with no live-macro support omits it —
   * unresolved macros then stay placeholders (today's behavior).
   */
  macros?: MacroResolutionOptions;
  output: OutputSink;
}

/**
 * The engine's input when driven through {@link runExport}: the same as
 * {@link ExportInput} minus the template bytes, which come from the injected
 * {@link TemplateSource} instead.
 */
export interface RunExportInput extends Omit<ExportInput, "templateBytes"> {
  /** Id passed to {@link TemplateSource.getBytes}. Defaults to `"current"`. */
  templateId?: string;
}

/**
 * Top-level entry: load the template through the env, run the pure export,
 * emit the bytes through the env, return the report. Hosts that need the raw
 * bytes (or manage template bytes themselves) can keep calling
 * {@link exportDocx} directly — this wrapper is the cross-host convention.
 *
 * `input.signal` is threaded into the pure export (asset fetches) and honored
 * before the final emit, so a mid-export abort stops in-flight downloads and
 * never writes a partial file (the atomic sink then leaves any pre-existing
 * target untouched).
 */
export async function runExport(input: RunExportInput, env: ExportEnv): Promise<ExportReport> {
  const { templateId, ...rest } = input;
  input.signal?.throwIfAborted();
  const templateBytes = await env.templates.getBytes(
    templateId ?? "current",
    input.signal ? { signal: input.signal } : {}
  );
  input.signal?.throwIfAborted();
  // The env's asset fetcher drives image embedding (spec 005) and its
  // rasterizer drives diagram embedding (spec 005a) unless the input
  // overrides them; `embedImages: false` disables image embedding entirely.
  const { bytes, report } = await exportDocx({
    ...rest,
    templateBytes,
    assets: rest.assets ?? env.assets,
    rasterizer: rest.rasterizer ?? env.rasterizer,
    macros: rest.macros ?? env.macros,
  });
  // Real cancellation: stop before committing output so an abort during the
  // asset-heavy phase leaves the destination untouched.
  input.signal?.throwIfAborted();
  input.onProgress?.({ phase: "emit", done: 0, total: 1, detail: report.filename });
  await env.output.emit(report.filename, bytes, { signal: input.signal });
  input.onProgress?.({ phase: "emit", done: 1, total: 1, detail: report.filename });
  return report;
}
