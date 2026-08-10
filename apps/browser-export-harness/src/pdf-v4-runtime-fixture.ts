/** Shared neutral revision-4 pack fixture for browser/Bun parity. */
import {
  BUILTIN_PDF_TEMPLATE_MANIFEST,
  PDF_CANONICAL_SOURCE_API_V1,
  PDF_CANONICAL_SOURCE_REVISION_4,
  PDF_TEMPLATE_CAPABILITIES_V2,
  PDF_TEMPLATE_CAPABILITY_DIGEST_V2,
  generateCanonicalPdfTemplateSourceV1,
  loadPdfTemplatePack,
  type PdfTemplateRuntimeV1,
} from "@atlcli/pdf/browser";
import {
  packTemplate,
  validateManifest,
  type TemplateManifest,
} from "@atlcli/template-pack";

export interface PdfV4RuntimeFixture {
  manifest: TemplateManifest;
  packBytes: Uint8Array;
  runtime: PdfTemplateRuntimeV1;
}

export async function buildPdfV4RuntimeFixture(): Promise<PdfV4RuntimeFixture> {
  const design = structuredClone(BUILTIN_PDF_TEMPLATE_MANIFEST.design!);
  design.compositions = {
    cover: { kind: "standard", logo: "hide" },
    closingPage: {
      kind: "document-summary",
      logo: "hide",
      website: "hide",
      legalNotice: "hide",
      align: "left",
    },
  };
  const manifest = validateManifest({
    ...BUILTIN_PDF_TEMPLATE_MANIFEST,
    id: "com.atlcli.browser-runtime-v4",
    name: "Browser runtime revision 4 conformance",
    version: "1.0.0",
    design,
    capabilityCatalog: {
      id: PDF_TEMPLATE_CAPABILITIES_V2.id,
      version: PDF_TEMPLATE_CAPABILITIES_V2.version,
      digest: PDF_TEMPLATE_CAPABILITY_DIGEST_V2,
    },
    canonicalSource: {
      api: PDF_CANONICAL_SOURCE_API_V1,
      revision: PDF_CANONICAL_SOURCE_REVISION_4,
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
