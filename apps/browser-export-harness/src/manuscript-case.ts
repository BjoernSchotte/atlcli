/**
 * Conformance case 012 — the "Manuscript" curated PDF template (spec 012 T6.5,
 * gated by spec 011).
 *
 * Spec 012's central claim is that a second built-in template needs ZERO new
 * engine code: same `wiki.pdf-template/v1` path, different validated manifest.
 * This case compiles the SAME blocks twice — once with the default (Editorial
 * Indigo) manifest, once with `MANUSCRIPT_PDF_TEMPLATE_MANIFEST` — through the
 * real Typst WASM compiler in the browser, and proves:
 *   - Manuscript is deterministic (byte-identical warm repeat),
 *   - Manuscript and the built-in produce DIFFERENT bytes (the manifest is not
 *     dead data — a regression where the serializer bound the built-in design at
 *     module scope is exactly what this catches),
 *   - Manuscript output is a valid tagged PDF with embedded fonts and an outline,
 *   - both templates report the same engine api + entry.
 *
 * The JSON result carries sha256 digests + a report-note projection so
 * `check-parity.ts` proves the Bun/CLI host produces byte-identical output.
 */
import {
  MANUSCRIPT_PDF_TEMPLATE_ID,
  MANUSCRIPT_PDF_TEMPLATE_MANIFEST,
  BUILTIN_PDF_TEMPLATE_MANIFEST,
  runPdfExport,
  validatePdfOutput,
  type PdfAssetResolver,
  type PdfExportReport,
  type TemplateManifest,
} from "@atlcli/pdf/browser";
import { MANUSCRIPT_BLOCKS, MANUSCRIPT_FILENAME, MANUSCRIPT_METADATA } from "./fixture.js";
import { MemoryOutputSink } from "./memory-output.js";
import { HarnessPdfWorkerClient } from "./pdf-worker-client.js";

const compiler = new HarnessPdfWorkerClient();

const noAssets: PdfAssetResolver = {
  async resolve(): Promise<never> {
    throw new Error("The Manuscript conformance fixture has no external assets.");
  },
};

function deterministicClock(): () => number {
  let tick = 0;
  return () => tick++;
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function compileWith(
  templateManifest?: TemplateManifest,
): Promise<{ report: PdfExportReport; bytes: Uint8Array }> {
  const output = new MemoryOutputSink();
  const report = await runPdfExport(
    {
      blocks: MANUSCRIPT_BLOCKS,
      metadata: MANUSCRIPT_METADATA,
      profile: "tagged",
      filename: MANUSCRIPT_FILENAME,
      ...(templateManifest ? { templateManifest } : {}),
    },
    { assets: noAssets, compiler, output, now: deterministicClock() },
  );
  return { report, bytes: output.single.bytes };
}

export interface ManuscriptCaseResult {
  compilerVersion: string;
  templateId: string;
  manuscript: {
    digest: string;
    pageCount: number;
    tagged: boolean;
    hasOutline: boolean;
    embeddedFontFiles: number;
  };
  builtin: { digest: string; pageCount: number; tagged: boolean };
  deterministic: boolean;
  templatesDiffer: boolean;
  sharesEngineContract: boolean;
  reportNotes: Array<{ code: string; severity: string }>;
  digests: Record<string, string>;
}

export async function runManuscriptCase(): Promise<ManuscriptCaseResult> {
  const first = await compileWith(MANUSCRIPT_PDF_TEMPLATE_MANIFEST);
  const repeat = await compileWith(MANUSCRIPT_PDF_TEMPLATE_MANIFEST);
  const builtin = await compileWith();

  const deterministic = equalBytes(first.bytes, repeat.bytes);
  if (!deterministic) throw new Error("Manuscript was not byte-identical on warm repeat.");

  const templatesDiffer = !equalBytes(first.bytes, builtin.bytes);
  if (!templatesDiffer) {
    throw new Error("Manuscript and the built-in template produced identical bytes — the manifest is dead data.");
  }

  const inspection = validatePdfOutput(first.bytes);
  const builtinInspection = validatePdfOutput(builtin.bytes);
  if (!inspection.tagged || inspection.embeddedFontFiles < 1) {
    throw new Error("Manuscript output is not a valid tagged PDF with embedded fonts.");
  }
  if (!inspection.hasOutline) throw new Error("Manuscript (outline enabled) has no PDF outline.");

  // The whole point of 012: one engine contract, two manifests.
  const sharesEngineContract =
    MANUSCRIPT_PDF_TEMPLATE_MANIFEST.engine.api === BUILTIN_PDF_TEMPLATE_MANIFEST.engine.api &&
    MANUSCRIPT_PDF_TEMPLATE_MANIFEST.engine.entry === BUILTIN_PDF_TEMPLATE_MANIFEST.engine.entry;
  if (!sharesEngineContract) {
    throw new Error("Manuscript does not share the built-in template's engine api/entry.");
  }

  const digests: Record<string, string> = {
    "manuscript.pdf": await sha256Hex(first.bytes),
    "manuscript-builtin.pdf": await sha256Hex(builtin.bytes),
  };

  return {
    compilerVersion: first.report.compilerVersion,
    templateId: MANUSCRIPT_PDF_TEMPLATE_ID,
    manuscript: {
      digest: digests["manuscript.pdf"]!,
      pageCount: inspection.pageCount,
      tagged: inspection.tagged,
      hasOutline: inspection.hasOutline,
      embeddedFontFiles: inspection.embeddedFontFiles,
    },
    builtin: {
      digest: digests["manuscript-builtin.pdf"]!,
      pageCount: builtinInspection.pageCount,
      tagged: builtinInspection.tagged,
    },
    deterministic,
    templatesDiffer,
    sharesEngineContract,
    reportNotes: first.report.notes.map((note) => ({ code: note.code, severity: note.level })),
    digests,
  };
}
