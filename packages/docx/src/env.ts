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

/** Where template bytes come from (extension: IndexedDB blob · CLI: readFile). */
export interface TemplateSource {
  getBytes(id: string): Promise<Uint8Array>;
}

/**
 * A reference to a page asset (attachment) the engine may need to embed.
 * v1 defers image embedding, but the seam exists so the OOXML image-module
 * follow-up (spec 005) plugs in without changing the host contract.
 */
export interface AssetRef {
  /** Download URL of the asset (absolute, or site-relative for session hosts). */
  url: string;
  /** Owning page id, when known. */
  pageId?: string;
  /** Attachment filename, when known. */
  filename?: string;
}

/** How asset bytes are fetched (extension: session fetch · CLI: token client). */
export interface AssetFetcher {
  fetch(ref: AssetRef): Promise<Uint8Array>;
}

/** Where the finished document goes (extension: download · CLI: writeFile). */
export interface OutputSink {
  emit(name: string, bytes: Uint8Array): Promise<void>;
}

/** Everything a host must supply to run an export. */
export interface ExportEnv {
  templates: TemplateSource;
  assets: AssetFetcher;
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
 */
export async function runExport(input: RunExportInput, env: ExportEnv): Promise<ExportReport> {
  const { templateId, ...rest } = input;
  const templateBytes = await env.templates.getBytes(templateId ?? "current");
  const { bytes, report } = await exportDocx({ ...rest, templateBytes });
  await env.output.emit(report.filename, bytes);
  return report;
}
