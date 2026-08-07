/**
 * Closed PDF capability-catalog runtime registry.
 *
 * A present catalog reference is always resolved by exact id/version/digest.
 * Only an absent reference enters the explicit catalog-V1 legacy path. This
 * prevents a foreign or future digest from silently executing as V1.
 */
import type {
  TemplateCapabilityCatalogReferenceV1,
  TemplateCapabilityCatalogV1,
  TemplateCapabilityCatalogV2,
  WikiPdfTemplateDesignV1,
} from "@atlcli/template-pack";
import {
  PDF_TEMPLATE_CAPABILITIES_V1,
  PDF_TEMPLATE_CAPABILITIES_V2,
  PDF_TEMPLATE_CAPABILITIES_V3,
  PDF_TEMPLATE_CATALOG_V3_COMPILER_RANGE,
  PDF_TEMPLATE_CAPABILITY_DIGEST_V1,
  PDF_TEMPLATE_CAPABILITY_DIGEST_V2,
  PDF_TEMPLATE_CAPABILITY_DIGEST_V3,
  projectPdfDesignThroughCatalog,
  projectPdfDesignThroughCatalogV2,
  writePdfDesignCapability,
  writePdfDesignCapabilityV2,
} from "./design-catalog.js";

export interface PdfCatalogAuthoringTargetV1 {
  reference: TemplateCapabilityCatalogReferenceV1;
  catalog: TemplateCapabilityCatalogV2;
  canonicalSource: {
    api: "wiki.pdf-canonical-typst";
    revision: "5";
  };
  compilerVersion: "0.15.1";
  compilerRange: string;
  /** Remains false until revision 5 is registered by T3. */
  executable: false;
}

export interface PdfCatalogRuntime {
  reference: TemplateCapabilityCatalogReferenceV1;
  catalog: TemplateCapabilityCatalogV1;
  /** Only the absent-reference V1 path may materialize sparse legacy designs. */
  allowsSparseLegacy: boolean;
  supportsClosingPage: boolean;
  project(design: WikiPdfTemplateDesignV1): WikiPdfTemplateDesignV1;
  write(
    design: WikiPdfTemplateDesignV1,
    path: string,
    value: unknown,
    writerId: string,
  ): WikiPdfTemplateDesignV1;
}

export class PdfCatalogRuntimeError extends Error {
  constructor(
    message: string,
    readonly reference?: TemplateCapabilityCatalogReferenceV1,
  ) {
    super(message);
    this.name = "PdfCatalogRuntimeError";
  }
}

const PDF_CATALOG_RUNTIME_V1: PdfCatalogRuntime = Object.freeze({
  reference: Object.freeze({
    id: PDF_TEMPLATE_CAPABILITIES_V1.id,
    version: PDF_TEMPLATE_CAPABILITIES_V1.version,
    digest: PDF_TEMPLATE_CAPABILITY_DIGEST_V1,
  }),
  catalog: PDF_TEMPLATE_CAPABILITIES_V1,
  allowsSparseLegacy: true,
  supportsClosingPage: false,
  project: projectPdfDesignThroughCatalog,
  write: writePdfDesignCapability,
});

const PDF_CATALOG_RUNTIME_V2: PdfCatalogRuntime = Object.freeze({
  reference: Object.freeze({
    id: PDF_TEMPLATE_CAPABILITIES_V2.id,
    version: PDF_TEMPLATE_CAPABILITIES_V2.version,
    digest: PDF_TEMPLATE_CAPABILITY_DIGEST_V2,
  }),
  catalog: PDF_TEMPLATE_CAPABILITIES_V2,
  allowsSparseLegacy: false,
  supportsClosingPage: true,
  project: projectPdfDesignThroughCatalogV2,
  write: writePdfDesignCapabilityV2,
});

const RUNTIMES_BY_IDENTITY = new Map<string, PdfCatalogRuntime>(
  [PDF_CATALOG_RUNTIME_V1, PDF_CATALOG_RUNTIME_V2].map((runtime) => [
    `${runtime.reference.id}\u0000${runtime.reference.version}\u0000${runtime.reference.digest}`,
    runtime,
  ]),
);

const PDF_CATALOG_AUTHORING_TARGET_V3: PdfCatalogAuthoringTargetV1 =
  Object.freeze({
    reference: Object.freeze({
      id: PDF_TEMPLATE_CAPABILITIES_V3.id,
      version: PDF_TEMPLATE_CAPABILITIES_V3.version,
      digest: PDF_TEMPLATE_CAPABILITY_DIGEST_V3,
    }),
    catalog: PDF_TEMPLATE_CAPABILITIES_V3,
    canonicalSource: Object.freeze({
      api: "wiki.pdf-canonical-typst",
      revision: "5",
    }),
    compilerVersion: "0.15.1",
    compilerRange: PDF_TEMPLATE_CATALOG_V3_COMPILER_RANGE,
    executable: false,
  });

const AUTHORING_TARGETS_BY_IDENTITY = new Map<
  string,
  PdfCatalogAuthoringTargetV1
>([
  [
    `${PDF_CATALOG_AUTHORING_TARGET_V3.reference.id}\u0000${PDF_CATALOG_AUTHORING_TARGET_V3.reference.version}\u0000${PDF_CATALOG_AUTHORING_TARGET_V3.reference.digest}`,
    PDF_CATALOG_AUTHORING_TARGET_V3,
  ],
]);

function identityKey(reference: TemplateCapabilityCatalogReferenceV1): string {
  return `${reference.id}\u0000${reference.version}\u0000${reference.digest}`;
}

/** Exact lookup for a declared catalog; absence is the explicit legacy V1 path. */
export function resolvePdfCatalogRuntime(
  reference?: TemplateCapabilityCatalogReferenceV1,
): PdfCatalogRuntime {
  if (reference === undefined) return PDF_CATALOG_RUNTIME_V1;
  const runtime = RUNTIMES_BY_IDENTITY.get(identityKey(reference));
  if (!runtime) {
    throw new PdfCatalogRuntimeError(
      `Unsupported PDF capability catalog ${reference.id}@${reference.version} (${reference.digest})`,
      reference,
    );
  }
  return runtime;
}

/**
 * Resolve a declared authoring generation without making it executable. Recipe
 * V2 can therefore derive revision/compiler metadata in T2 while the runtime
 * loader continues to reject catalog V3 until T3 supplies canonical revision 5.
 */
export function resolvePdfCatalogAuthoringTarget(
  reference: TemplateCapabilityCatalogReferenceV1,
): PdfCatalogAuthoringTargetV1 {
  const target = AUTHORING_TARGETS_BY_IDENTITY.get(identityKey(reference));
  if (!target) {
    throw new PdfCatalogRuntimeError(
      `Unsupported PDF authoring catalog ${reference.id}@${reference.version} (${reference.digest})`,
      reference,
    );
  }
  return target;
}

export function listPdfCatalogAuthoringTargets(): readonly PdfCatalogAuthoringTargetV1[] {
  return [PDF_CATALOG_AUTHORING_TARGET_V3];
}

export function pdfCatalogRuntimeReference(
  runtime: PdfCatalogRuntime,
): TemplateCapabilityCatalogReferenceV1 {
  return { ...runtime.reference };
}

/** T1 exposes only executable V1/V2 runtimes; catalog V3 joins here with rev5. */
export function listExecutablePdfCatalogRuntimes(): readonly PdfCatalogRuntime[] {
  return [PDF_CATALOG_RUNTIME_V1, PDF_CATALOG_RUNTIME_V2];
}
