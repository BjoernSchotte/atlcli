/**
 * Pure helpers behind the DOCX export panel (spec 010 Phase 0).
 *
 * All four are host-neutral and DOM-free, which is why they live next to the
 * screen rather than in the Chrome shell. `entrypoints/sidepanel/TemplateSection.tsx`
 * re-exports `loadCurrentTemplate` and `rasterizerTimingNote` so
 * `tests/docx/template-load.test.ts` and `tests/docx/rasterizer-report.test.ts`
 * keep passing unchanged through the move.
 */
import type { ExportReport } from "@atlcli/docx/browser";
import type { ScanResult } from "@atlcli/docx/scan";
import type { RasterizerStats } from "../../utils/docx/env.js";
import type { MessageKey, MessageParams } from "../../utils/i18n/messages.js";

export type Translate = (key: MessageKey, params?: MessageParams) => string;

/** A loaded template plus its **freshly derived** scan. */
export interface CurrentTemplate {
  name: string;
  uploadedAt: number;
  scan: ScanResult;
  bytes: ArrayBuffer;
}

/** The minimum a stored record must carry to be loadable. */
export interface StoredTemplateLike {
  name: string;
  uploadedAt: number;
  bytes: ArrayBuffer;
}

/**
 * Load the persisted template and **re-derive** its scan from the stored bytes.
 *
 * Pure core of the panel's mount effect (both collaborators injected) so the
 * staleness rule is testable without a DOM: the scan the panel shows must come
 * from the CURRENT classification, never from a copy frozen at upload time. It
 * once did — a template uploaded before gap G1 closed kept promising
 * "$scroll.pageowner.fullName will be empty" while the export, which always
 * re-scans, resolved it. The panel is the promise and the export is the
 * delivery, so they must be computed the same way.
 *
 * `loadScanner` is only invoked when something is stored: a user who never
 * uploaded a template must not pay for the heavy scan chunk (the lazy-load
 * contract).
 *
 * @returns the current template, or `null` when nothing is stored.
 */
export async function loadCurrentTemplate(
  get: () => Promise<StoredTemplateLike | undefined | null>,
  loadScanner: () => Promise<(bytes: Uint8Array) => ScanResult | Promise<ScanResult>>
): Promise<CurrentTemplate | null> {
  const stored = await get();
  if (!stored) return null;
  const scan = await loadScanner();
  return {
    name: stored.name,
    uploadedAt: stored.uploadedAt,
    scan: await scan(new Uint8Array(stored.bytes)),
    bytes: stored.bytes,
  };
}

/**
 * Build the extension-owned rasterizer timing note, if any call succeeded.
 *
 * Untranslated on purpose: it joins `ExportReport.notes`, which is engine
 * vocabulary shared with the CLI.
 */
export function rasterizerTimingNote(
  stats: RasterizerStats
): ExportReport["notes"][number] | null {
  if (stats.calls === 0) return null;
  return {
    level: "info",
    code: "perf-timing",
    message:
      `Panel rasterizer: ${stats.calls} call(s) — decode ${stats.decodeMs} ms, ` +
      `draw ${stats.drawMs} ms, encode ${stats.encodeMs} ms (sums; per call ` +
      `${stats.encodeCallsMs.join("/")} ms).`,
  };
}

/**
 * Turn a `DocxError` into an upload-panel message.
 *
 * The three original kinds get purpose-written, translated copy. Everything
 * else — the spec 011 archive-budget and active-content rejections — carries an
 * end-user-readable message on the error itself ("Templates with macros or
 * ActiveX/OLE controls cannot be imported; re-save the file as a plain .docx"),
 * so it is surfaced verbatim rather than mapped. A `default` that guesses is
 * worse than one that repeats what the guard already said: the previous nested
 * ternary fell through to "That template is too large." for ANY unrecognised
 * kind, which told a user uploading a macro-bearing template exactly the wrong
 * thing.
 */
export function templateRejectionMessage(
  t: Translate,
  error: { kind: string; message: string }
): string {
  switch (error.kind) {
    case "not-zip":
      return t("docx.error.notZip");
    case "not-docx":
      return t("docx.error.notWord");
    case "too-large":
      return t("docx.error.engineTooLarge");
    default:
      return error.message;
  }
}

/**
 * Turn an export throw into a user-facing message.
 *
 * A `DocxRenderError` (docxtemplater could not render the template) is
 * surfaced with the engine's structured explanation rather than as a generic
 * "Export failed" (spec 004, finding #11). Detected by `name` so this module
 * never pulls the heavy export chunk into its static graph.
 */
export function exportErrorMessage(t: Translate, error: unknown): string {
  if (error instanceof Error && error.name === "DocxRenderError") {
    const details = (error as { details?: string[] }).details;
    return t("docx.error.render", {
      details: details?.length ? ` (${details.join("; ")})` : "",
    });
  }
  return t("docx.error.exportFailed", {
    message: error instanceof Error ? error.message : String(error),
  });
}
