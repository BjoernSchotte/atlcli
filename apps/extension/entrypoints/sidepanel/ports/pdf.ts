/**
 * Chrome adapter for {@link PdfExportPort} (spec 010 Phase 0, extended by
 * T5.1/T5.4).
 *
 * The panel is now an observer of the common durable job. Its lazy chunk
 * contains submission/monitor/download adapters only; all source reads and
 * heavy PDF engine code execute in the offscreen host.
 *
 * Scope, labels and the live-macro toggle ride the portable
 * `ExportScopeRequest` and are handed to `utils/pdf/run-export.ts` unchanged;
 * the only translation this adapter performs is `total: null → 0`, because the
 * shared walk reports "not yet known" as `null` while the portable progress
 * shape spells it `0`.
 */
import type { PdfExportPort } from "../../../utils/ports/export.js";

const loadDurablePdfRun = () =>
  import("../../../utils/export-jobs/pdf-run.js");

export function chromePdfExportPort(): PdfExportPort {
  let deps: ReturnType<
    typeof import("../../../utils/export-jobs/pdf-run.js")["chromeExtensionPdfRunDeps"]
  > | undefined;
  return {
    async run(request) {
      const module = await loadDurablePdfRun();
      deps ??= module.chromeExtensionPdfRunDeps();
      return module.runSubmittedExtensionPdfExport(request, deps);
    },
  };
}
