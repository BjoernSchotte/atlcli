/**
 * Chrome adapter for {@link PdfExportPort} (spec 010 Phase 0, extended by
 * T5.1/T5.4).
 *
 * The lazy `import()` is not new indirection — it is the same deferral
 * `PdfSection.tsx:49` did inline, moved behind the port so the screen no longer
 * knows that the engine is a separate chunk. A panel that never exports still
 * never pulls Typst WASM.
 *
 * Scope, labels and the live-macro toggle ride the portable
 * `ExportScopeRequest` and are handed to `utils/pdf/run-export.ts` unchanged;
 * the only translation this adapter performs is `total: null → 0`, because the
 * shared walk reports "not yet known" as `null` while the portable progress
 * shape spells it `0`.
 */
import type { PdfExportPort } from "../../../utils/ports/export.js";

const loadRunExport = () => import("../../../utils/pdf/run-export.js");

export function chromePdfExportPort(): PdfExportPort {
  return {
    async run(request) {
      const { runPdfExport } = await loadRunExport();
      const onProgress = request.onProgress;
      return runPdfExport({
        page: request.page,
        pageUrl: request.pageUrl,
        signal: request.signal,
        // No cast on purpose. `onPhase` is a function-typed property, so it is
        // checked contravariantly under `strictFunctionTypes`: if
        // `run-export.ts` grows a phase the port's `ExportPhase` does not
        // model, this line stops compiling instead of the panel silently
        // rendering a blank label.
        onPhase: request.onPhase,
        ...(request.scope ? { scope: request.scope } : {}),
        ...(request.labels ? { labels: request.labels } : {}),
        ...(request.settings ? { settings: request.settings } : {}),
        ...(onProgress
          ? {
              onProgress: (progress) =>
                onProgress({
                  fetched: progress.fetched,
                  total: progress.total ?? 0,
                  ...(progress.currentTitle ? { currentTitle: progress.currentTitle } : {}),
                }),
            }
          : {}),
        // `resolveMacros === false` is the panel's "Resolve dynamic macros" off
        // switch, and maps onto the engine's `live: false` — the same value the
        // CLI's `--no-live-macros` produces, so the export reports
        // `macro-skipped-by-config` rather than silently dropping the macro.
        ...(request.resolveMacros === false ? { macros: { live: false } } : {}),
      });
    },
  };
}
