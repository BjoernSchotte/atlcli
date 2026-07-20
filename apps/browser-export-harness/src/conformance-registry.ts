/**
 * The conformance-case REGISTRY: binds each manifest entry to its run function.
 * Only `app.ts` imports this (it pulls in DOM + engine code); the Playwright
 * spec and CI drift check import the pure manifest instead.
 *
 * A feature lane adds one entry here + one manifest entry + its own `*-case.ts`.
 */
import { CONFORMANCE_MANIFEST, type ConformanceCaseMeta } from "./conformance-manifest.js";
import { runDocxCase } from "./docx-case.js";
import { runPdfAbortCase, runPdfCase } from "./pdf-case.js";
import { runPdfSettingsCase } from "./pdf-settings-case.js";

export interface ConformanceCase extends ConformanceCaseMeta {
  run: () => Promise<unknown>;
}

const RUNNERS: Record<string, () => Promise<unknown>> = {
  "pdf-abort": runPdfAbortCase,
  docx: runDocxCase,
  pdf: runPdfCase,
  "pdf-settings": runPdfSettingsCase,
};

export const CONFORMANCE_CASES: readonly ConformanceCase[] = CONFORMANCE_MANIFEST.map((meta) => {
  const run = RUNNERS[meta.id];
  if (!run) throw new Error(`No run function registered for conformance case "${meta.id}".`);
  return { ...meta, run };
});
