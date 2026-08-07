/** Shared neutral revision-5 pack fixture for browser/Bun parity. */
import {
  BUILTIN_PDF_TEMPLATE_BASELINE_V1,
  BUILTIN_PDF_TEMPLATE_MANIFEST,
  PDF_CANONICAL_SOURCE_API_V1,
  PDF_CANONICAL_SOURCE_REVISION_5,
  PDF_TEMPLATE_CAPABILITIES_V3,
  PDF_TEMPLATE_CAPABILITY_DIGEST_V3,
  generateCanonicalPdfTemplateSourceV1,
  loadPdfTemplatePack,
  type PdfTemplateRuntimeV1,
} from "@atlcli/pdf/browser";
import {
  packTemplate,
  validateManifestV3,
  type TemplateManifest,
  type WikiPdfTemplateDesignV3,
} from "@atlcli/template-pack";

export interface PdfV5RuntimeFixture {
  manifest: TemplateManifest<WikiPdfTemplateDesignV3>;
  packBytes: Uint8Array;
  runtime: PdfTemplateRuntimeV1;
}

export async function buildPdfV5RuntimeFixture(): Promise<PdfV5RuntimeFixture> {
  const manifest = validateManifestV3({
    ...BUILTIN_PDF_TEMPLATE_MANIFEST,
    id: "com.atlcli.browser-runtime-v5",
    name: "Browser runtime revision 5 conformance",
    version: "1.0.0",
    design: BUILTIN_PDF_TEMPLATE_BASELINE_V1.design,
    bindings: undefined,
    capabilityCatalog: {
      id: PDF_TEMPLATE_CAPABILITIES_V3.id,
      version: PDF_TEMPLATE_CAPABILITIES_V3.version,
      digest: PDF_TEMPLATE_CAPABILITY_DIGEST_V3,
    },
    canonicalSource: {
      api: PDF_CANONICAL_SOURCE_API_V1,
      revision: PDF_CANONICAL_SOURCE_REVISION_5,
    },
    provenance: undefined,
  });
  const canonicalSource = generateCanonicalPdfTemplateSourceV1(manifest, {
    assets: {},
    decorations: [],
  });
  const packBytes = await packTemplate({
    manifest,
    files: { "atlcli.typ": new TextEncoder().encode(canonicalSource) },
  });
  const runtime = await loadPdfTemplatePack(packBytes);
  return { manifest, packBytes, runtime };
}
