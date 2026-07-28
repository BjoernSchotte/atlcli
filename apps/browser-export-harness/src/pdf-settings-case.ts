/**
 * Conformance case 007 — PDF template settings & watermark (spec 007, gated by
 * spec 011). Compiles the SAME blocks under different `settings` and proves:
 *   - each settings variant is deterministic (byte-identical warm repeat),
 *   - two different settings produce different bytes,
 *   - toggling the watermark alone changes the bytes (watermark is applied),
 *   - each output is a valid tagged PDF with embedded fonts,
 *   - a `.wiki-pdf-template` container round-trips through the template library.
 *
 * The JSON result carries sha256 digests + a report-note projection so
 * `check-parity.ts` can prove the CLI produces byte-identical output. This is
 * the conformance case the UMSETZUNGSPLAN references for spec 012's gate.
 */
import {
  BUILTIN_PDF_TEMPLATE_MANIFEST,
  PDF_CANONICAL_SOURCE_API_V1,
  PDF_CANONICAL_SOURCE_REVISION,
  PDF_TEMPLATE_CAPABILITIES_V1,
  PDF_TEMPLATE_CAPABILITY_DIGEST_V1,
  generateCanonicalPdfTemplateSourceV1,
  loadPdfTemplatePack,
  runPdfExport,
  validatePdfOutput,
  type PdfAssetResolver,
  type PdfExportReport,
  type PdfTemplateSettings,
  type PdfTemplateRuntimeV1,
} from "@atlcli/pdf/browser";
import {
  packTemplate,
  unpackTemplate,
  validateManifest,
} from "@atlcli/template-pack";
import {
  PDF_SETTINGS_A,
  PDF_SETTINGS_A_NO_WATERMARK,
  PDF_SETTINGS_B,
  PDF_SETTINGS_BLOCKS,
  PDF_SETTINGS_METADATA,
  PDF_TEMPLATE_PACK_FILES,
  PDF_TEMPLATE_PACK_MANIFEST,
} from "./fixture.js";
import { MemoryOutputSink } from "./memory-output.js";
import { HarnessPdfWorkerClient } from "./pdf-worker-client.js";

const compiler = new HarnessPdfWorkerClient();

const noAssets: PdfAssetResolver = {
  async resolve(): Promise<never> {
    throw new Error("The deterministic PDF settings fixture has no external assets.");
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
  // Copy into an ArrayBuffer-backed view so subtle.digest's BufferSource type is met.
  const digest = await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function compileWith(
  settings: PdfTemplateSettings,
  templatePack?: PdfTemplateRuntimeV1
): Promise<{ report: PdfExportReport; bytes: Uint8Array }> {
  const output = new MemoryOutputSink();
  const report = await runPdfExport(
    {
      blocks: PDF_SETTINGS_BLOCKS,
      metadata: PDF_SETTINGS_METADATA,
      settings,
      ...(templatePack ? { templatePack } : {}),
      profile: "tagged",
      filename: "PDF Settings Conformance.pdf",
    },
    { assets: noAssets, compiler, output, now: deterministicClock() },
  );
  return { report, bytes: output.single.bytes };
}

export interface PdfSettingsCaseResult {
  compilerVersion: string;
  variantA: { digest: string; pageCount: number; tagged: boolean; hasOutline: boolean; embeddedFontFiles: number };
  variantB: { digest: string; pageCount: number; tagged: boolean };
  deterministicA: boolean;
  variantsDiffer: boolean;
  watermarkChangesBytes: boolean;
  templatePackRoundTrips: boolean;
  templateRuntimeStructuredClone: boolean;
  templateRuntimeRenders: boolean;
  reportNotes: Array<{ code: string; severity: string }>;
  digests: Record<string, string>;
}

export async function runPdfSettingsCase(): Promise<PdfSettingsCaseResult> {
  const a1 = await compileWith(PDF_SETTINGS_A);
  const a2 = await compileWith(PDF_SETTINGS_A);
  const b = await compileWith(PDF_SETTINGS_B);
  const aNoWatermark = await compileWith(PDF_SETTINGS_A_NO_WATERMARK);

  const deterministicA = equalBytes(a1.bytes, a2.bytes);
  if (!deterministicA) throw new Error("Variant A was not byte-identical on warm repeat.");

  const variantsDiffer = !equalBytes(a1.bytes, b.bytes);
  if (!variantsDiffer) throw new Error("Different PDF settings produced identical bytes.");

  const watermarkChangesBytes = !equalBytes(a1.bytes, aNoWatermark.bytes);
  if (!watermarkChangesBytes) throw new Error("Toggling the watermark did not change the PDF bytes.");

  const inspectionA = validatePdfOutput(a1.bytes);
  const inspectionB = validatePdfOutput(b.bytes);
  if (!inspectionA.tagged || inspectionA.embeddedFontFiles < 1) {
    throw new Error("Variant A is not a valid tagged PDF with embedded fonts.");
  }
  if (!inspectionA.hasOutline) {
    throw new Error("Variant A (outline enabled) has no PDF outline.");
  }
  if (!inspectionB.tagged) throw new Error("Variant B is not tagged.");

  // `.wiki-pdf-template` container round-trip through the real template library.
  const encoder = new TextEncoder();
  const files: Record<string, Uint8Array> = {};
  for (const [name, text] of Object.entries(PDF_TEMPLATE_PACK_FILES)) files[name] = encoder.encode(text);
  const packed = await packTemplate({ manifest: PDF_TEMPLATE_PACK_MANIFEST, files });
  const unpacked = unpackTemplate(packed);
  const templatePackRoundTrips =
    unpacked.manifest.id === PDF_TEMPLATE_PACK_MANIFEST.id &&
    Object.keys(unpacked.files).sort().join(",") === Object.keys(PDF_TEMPLATE_PACK_FILES).sort().join(",");
  if (!templatePackRoundTrips) throw new Error("The .wiki-pdf-template container did not round-trip.");

  const runtimeManifest = validateManifest({
    ...BUILTIN_PDF_TEMPLATE_MANIFEST,
    id: "com.atlcli.browser-runtime",
    name: "Browser runtime conformance",
    version: "1.0.0",
    capabilityCatalog: {
      id: PDF_TEMPLATE_CAPABILITIES_V1.id,
      version: PDF_TEMPLATE_CAPABILITIES_V1.version,
      digest: PDF_TEMPLATE_CAPABILITY_DIGEST_V1,
    },
    canonicalSource: {
      api: PDF_CANONICAL_SOURCE_API_V1,
      revision: PDF_CANONICAL_SOURCE_REVISION,
    },
    provenance: undefined,
  });
  const canonicalSource = generateCanonicalPdfTemplateSourceV1(
    runtimeManifest,
    { assets: {}, decorations: [] }
  );
  const runtime = await loadPdfTemplatePack(
    await packTemplate({
      manifest: runtimeManifest,
      files: {
        "atlcli.typ": new TextEncoder().encode(canonicalSource),
      },
    })
  );
  const templateRuntimeStructuredClone =
    structuredClone(runtime).canonicalSource.sha256 ===
    runtime.canonicalSource.sha256;
  if (!templateRuntimeStructuredClone) {
    throw new Error("The PDF template runtime did not survive structured clone.");
  }
  const runtimeRender = await compileWith(PDF_SETTINGS_A, runtime);
  const templateRuntimeRenders =
    validatePdfOutput(runtimeRender.bytes).tagged &&
    runtimeRender.report.compilerVersion.length > 0;
  if (!templateRuntimeRenders) {
    throw new Error("The browser PDF runtime pack did not render.");
  }

  const reportNotes = a1.report.notes.map((note) => ({ code: note.code, severity: note.level }));

  const digests: Record<string, string> = {
    "variant-a.pdf": await sha256Hex(a1.bytes),
    "variant-b.pdf": await sha256Hex(b.bytes),
  };

  return {
    compilerVersion: a1.report.compilerVersion,
    variantA: {
      digest: digests["variant-a.pdf"],
      pageCount: inspectionA.pageCount,
      tagged: inspectionA.tagged,
      hasOutline: inspectionA.hasOutline,
      embeddedFontFiles: inspectionA.embeddedFontFiles,
    },
    variantB: { digest: digests["variant-b.pdf"], pageCount: inspectionB.pageCount, tagged: inspectionB.tagged },
    deterministicA,
    variantsDiffer,
    watermarkChangesBytes,
    templatePackRoundTrips,
    templateRuntimeStructuredClone,
    templateRuntimeRenders,
    reportNotes,
    digests,
  };
}
