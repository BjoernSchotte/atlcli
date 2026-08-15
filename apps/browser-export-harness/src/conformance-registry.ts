/**
 * The conformance-case REGISTRY: binds each manifest entry to its run function.
 * Only `app.ts` imports this (it pulls in DOM + engine code); the Playwright
 * spec and CI drift check import the pure manifest instead.
 *
 * A feature lane adds one entry here + one manifest entry + its own `*-case.ts`.
 */
import { CONFORMANCE_MANIFEST, type ConformanceCaseMeta } from "./conformance-manifest.js";
import { runAdfSourceCase } from "./adf-source-case.js";
import { runActivityMonitorCase } from "./activity-monitor-case.js";
import { runAssetSpoolRecoveryCase } from "./asset-spool-recovery-case.js";
import { runBlocksCase } from "./blocks-case.js";
import { runChartCase } from "./chart-case.js";
import { runContentCase } from "./content-case.js";
import { runDocxCase } from "./docx-case.js";
import { runDocxJobParityCase } from "./docx-job-parity-case.js";
import { runDocxQualityCase } from "./docx-quality-case.js";
import { runDocxTemplateIntakeCase } from "./docx-template-intake-case.js";
import { runM1Case } from "./m1-case.js";
import { runMacroCase } from "./macro-case.js";
import { runManuscriptCase } from "./manuscript-case.js";
import { runPdfAbortCase, runPdfCase } from "./pdf-case.js";
import { runPdfJobParityCase } from "./pdf-job-parity-case.js";
import { runPdfSettingsCase } from "./pdf-settings-case.js";
import { runPdfV5Case } from "./pdf-v5-case.js";
import { runPlaceholderCase } from "./placeholder-case.js";
import { runScopeCase } from "./scope-case.js";
import { runSourceSpoolRecoveryCase } from "./source-spool-recovery-case.js";

export interface ConformanceCase extends ConformanceCaseMeta {
  run: () => Promise<unknown>;
}

const RUNNERS: Record<string, () => Promise<unknown>> = {
  "activity-monitor": runActivityMonitorCase,
  "asset-spool-recovery": runAssetSpoolRecoveryCase,
  "source-spool-recovery": runSourceSpoolRecoveryCase,
  "pdf-abort": runPdfAbortCase,
  docx: runDocxCase,
  "docx-job-parity": runDocxJobParityCase,
  pdf: runPdfCase,
  "pdf-job-parity": runPdfJobParityCase,
  "pdf-settings": runPdfSettingsCase,
  "pdf-v5": runPdfV5Case,
  "docx-template-intake": runDocxTemplateIntakeCase,
  blocks: runBlocksCase,
  charts: runChartCase,
  "adf-source": runAdfSourceCase,
  scope: runScopeCase,
  "content-compat": runContentCase,
  macros: runMacroCase,
  placeholders: runPlaceholderCase,
  "docx-quality": runDocxQualityCase,
  m1: runM1Case,
  manuscript: runManuscriptCase,
};

export const CONFORMANCE_CASES: readonly ConformanceCase[] = CONFORMANCE_MANIFEST.map((meta) => {
  const run = RUNNERS[meta.id];
  if (!run) throw new Error(`No run function registered for conformance case "${meta.id}".`);
  return { ...meta, run };
});
