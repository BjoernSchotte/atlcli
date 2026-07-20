/**
 * Chrome adapter for {@link PdfExportPort} (spec 010 Phase 0).
 *
 * The lazy `import()` is not new indirection — it is the same deferral
 * `PdfSection.tsx:49` did inline, moved behind the port so the screen no longer
 * knows that the engine is a separate chunk. A panel that never exports still
 * never pulls Typst WASM.
 */
import type { PdfExportPort } from "../../../utils/ports/export.js";

const loadRunExport = () => import("../../../utils/pdf/run-export.js");

export function chromePdfExportPort(): PdfExportPort {
  return {
    async run(request) {
      const { runPdfExport } = await loadRunExport();
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
      });
    },
  };
}
