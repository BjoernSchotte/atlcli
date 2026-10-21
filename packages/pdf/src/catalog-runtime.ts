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
  WikiPdfTemplateDesignV3,
} from "@atlcli/template-pack";
import { validatePdfTemplateDesignV3 } from "@atlcli/template-pack";
import {
  PDF_TEMPLATE_CAPABILITIES_V1,
  PDF_TEMPLATE_CAPABILITIES_V2,
  PDF_TEMPLATE_CAPABILITIES_V3,
  PDF_TEMPLATE_CAPABILITIES_V4,
  PDF_TEMPLATE_CATALOG_V3_COMPILER_RANGE,
  PDF_TEMPLATE_CAPABILITY_DIGEST_V1,
  PDF_TEMPLATE_CAPABILITY_DIGEST_V2,
  PDF_TEMPLATE_CAPABILITY_DIGEST_V3,
  PDF_TEMPLATE_CAPABILITY_DIGEST_V4,
  projectPdfDesignThroughCatalog,
  projectPdfDesignThroughCatalogSchemaV2,
  projectPdfDesignThroughCatalogV2,
  writePdfDesignCapability,
  writePdfDesignCapabilityV2,
} from "./design-catalog.js";
import { PDF_RUNTIME_ASSETS } from "./runtime-assets.js";

export interface PdfCatalogAuthoringTargetV1 {
  reference: TemplateCapabilityCatalogReferenceV1;
  catalog: TemplateCapabilityCatalogV2;
  canonicalSource: {
    api: "wiki.pdf-canonical-typst";
    revision: "5" | "6";
  };
  compilerVersion: "0.15.1";
  compilerRange: string;
  executable: boolean;
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

export interface PdfCatalogRuntimeV3 {
  reference: TemplateCapabilityCatalogReferenceV1;
  catalog: TemplateCapabilityCatalogV2;
  allowsSparseLegacy: false;
  supportsClosingPage: true;
  project(design: WikiPdfTemplateDesignV3): WikiPdfTemplateDesignV3;
  write(
    design: WikiPdfTemplateDesignV3,
    path: string,
    value: unknown,
    writerId: string,
  ): WikiPdfTemplateDesignV3;
}

export type AnyPdfCatalogRuntime = PdfCatalogRuntime | PdfCatalogRuntimeV3;

/** Canonical revisions whose manifest carries a complete Catalog-V3-shaped design. */
export function isCompleteDesignPdfRevision(revision: string | undefined): boolean {
  return revision === "5" || revision === "6";
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

function projectCatalogV3Design(
  design: WikiPdfTemplateDesignV3,
  catalog: TemplateCapabilityCatalogV2,
): WikiPdfTemplateDesignV3 {
  return validatePdfTemplateDesignV3(
    projectPdfDesignThroughCatalogSchemaV2(design, catalog),
    "design",
    { availableFonts: PDF_RUNTIME_ASSETS.fonts },
  );
}

/** Catalog V3 (revision 5) and V4 (revision 6) share one complete-design runtime. */
function completeDesignRuntime(
  catalog: TemplateCapabilityCatalogV2,
  digest: string,
): PdfCatalogRuntimeV3 {
  return Object.freeze({
    reference: Object.freeze({ id: catalog.id, version: catalog.version, digest }),
    catalog,
    allowsSparseLegacy: false,
    supportsClosingPage: true,
    project: (design: WikiPdfTemplateDesignV3) => projectCatalogV3Design(design, catalog),
    write(
      design: WikiPdfTemplateDesignV3,
      path: string,
      value: unknown,
      writerId: string,
    ) {
      const descriptor = catalog.descriptors.find(
        (candidate) => candidate.path === path,
      );
      if (!descriptor) {
        throw new Error(`Unknown PDF design capability "${path}"`);
      }
      if (!descriptor.runtimeWriters?.some((writer) => writer.id === writerId)) {
        throw new Error(
          `PDF design capability "${path}" is not writable by "${writerId}"`,
        );
      }
      const copy = structuredClone(design) as unknown as Record<string, unknown>;
      const segments = path.split(".");
      let cursor = copy;
      for (const segment of segments.slice(0, -1)) {
        const child = cursor[segment];
        if (typeof child !== "object" || child === null || Array.isArray(child)) {
          throw new Error(`PDF design capability parent "${segment}" is missing`);
        }
        cursor = child as Record<string, unknown>;
      }
      cursor[segments.at(-1)!] = value;
      return projectCatalogV3Design(
        copy as unknown as WikiPdfTemplateDesignV3,
        catalog,
      );
    },
  });
}

const PDF_CATALOG_RUNTIME_V3 = completeDesignRuntime(
  PDF_TEMPLATE_CAPABILITIES_V3,
  PDF_TEMPLATE_CAPABILITY_DIGEST_V3,
);

const PDF_CATALOG_RUNTIME_V4 = completeDesignRuntime(
  PDF_TEMPLATE_CAPABILITIES_V4,
  PDF_TEMPLATE_CAPABILITY_DIGEST_V4,
);

const RUNTIMES_BY_IDENTITY = new Map<string, PdfCatalogRuntime>(
  [PDF_CATALOG_RUNTIME_V1, PDF_CATALOG_RUNTIME_V2].map((runtime) => [
    `${runtime.reference.id}\u0000${runtime.reference.version}\u0000${runtime.reference.digest}`,
    runtime,
  ]),
);

const V3_RUNTIMES_BY_IDENTITY = new Map<string, PdfCatalogRuntimeV3>(
  [PDF_CATALOG_RUNTIME_V3, PDF_CATALOG_RUNTIME_V4].map((runtime) => [
    `${runtime.reference.id}\u0000${runtime.reference.version}\u0000${runtime.reference.digest}`,
    runtime,
  ]),
);

function authoringTarget(
  runtime: PdfCatalogRuntimeV3,
  revision: "5" | "6",
): PdfCatalogAuthoringTargetV1 {
  return Object.freeze({
    reference: runtime.reference,
    catalog: runtime.catalog,
    canonicalSource: Object.freeze({
      api: "wiki.pdf-canonical-typst",
      revision,
    }),
    compilerVersion: "0.15.1",
    compilerRange: PDF_TEMPLATE_CATALOG_V3_COMPILER_RANGE,
    executable: true,
  });
}

const PDF_CATALOG_AUTHORING_TARGETS = [
  authoringTarget(PDF_CATALOG_RUNTIME_V3, "5"),
  authoringTarget(PDF_CATALOG_RUNTIME_V4, "6"),
] as const;

const AUTHORING_TARGETS_BY_IDENTITY = new Map<
  string,
  PdfCatalogAuthoringTargetV1
>(
  PDF_CATALOG_AUTHORING_TARGETS.map((target) => [
    `${target.reference.id}\u0000${target.reference.version}\u0000${target.reference.digest}`,
    target,
  ]),
);

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

/** Exact complete-design catalog lookup (V3 for revision 5, V4 for revision 6). */
export function resolvePdfCatalogRuntimeV3(
  reference: TemplateCapabilityCatalogReferenceV1,
): PdfCatalogRuntimeV3 {
  const runtime = V3_RUNTIMES_BY_IDENTITY.get(identityKey(reference));
  if (!runtime) {
    throw new PdfCatalogRuntimeError(
      `Unsupported PDF capability catalog ${reference.id}@${reference.version} (${reference.digest})`,
      reference,
    );
  }
  return runtime;
}

/**
 * Resolve an installed authoring generation. The executable bit is explicit so
 * Recipe V2 never infers runtime availability from catalog shape alone.
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
  return PDF_CATALOG_AUTHORING_TARGETS;
}

export function pdfCatalogRuntimeReference(
  runtime: PdfCatalogRuntime,
): TemplateCapabilityCatalogReferenceV1 {
  return { ...runtime.reference };
}

export function listExecutablePdfCatalogRuntimes(): readonly AnyPdfCatalogRuntime[] {
  return [
    PDF_CATALOG_RUNTIME_V1,
    PDF_CATALOG_RUNTIME_V2,
    PDF_CATALOG_RUNTIME_V3,
    PDF_CATALOG_RUNTIME_V4,
  ];
}
