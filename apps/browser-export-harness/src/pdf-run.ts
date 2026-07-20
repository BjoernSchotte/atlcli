/**
 * Shared browser-side PDF export helper for the feature-lane conformance cases
 * (spec 011). Keeps each case's `runPdfExport` invocation IDENTICAL to the
 * Bun/CLI parity runner's (same profile, no external assets, deterministic
 * clock) so a digest divergence is a real engine divergence, never a wiring
 * drift. The compiler is passed in so a case can own its own worker lifecycle.
 */
import {
  runPdfExport,
  type ExportBlock,
  type ExportNote,
  type PdfAssetResolver,
  type PdfCompilePort,
  type PdfExportMetadata,
  type PdfExportReport,
} from "@atlcli/pdf/browser";
import { MemoryOutputSink } from "./memory-output.js";

export const noPdfAssets: PdfAssetResolver = {
  async resolve(): Promise<never> {
    throw new Error("The deterministic conformance fixture has no external assets.");
  },
};

export function deterministicClock(): () => number {
  let tick = 0;
  return () => tick++;
}

/**
 * Compile `blocks` to PDF with the canonical (parity-shared) request shape.
 * `sourceNotes` threads upstream notes (e.g. macro-resolution notes) into the
 * report so the report projection — and thus the parity gate — sees them.
 */
export async function compilePdf(
  compiler: PdfCompilePort,
  blocks: ExportBlock[],
  metadata: PdfExportMetadata,
  filename: string,
  sourceNotes: ExportNote[] = [],
): Promise<{ report: PdfExportReport; bytes: Uint8Array }> {
  const output = new MemoryOutputSink();
  const report = await runPdfExport(
    { blocks, metadata, profile: "tagged", filename, sourceNotes },
    { assets: noPdfAssets, compiler, output, now: deterministicClock() },
  );
  return { report, bytes: output.single.bytes };
}
