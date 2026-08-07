/** Browser-safe, digest-pinned baseline resolution for PDF Recipe V2. */
import {
  canonicalCapabilityJson,
  evaluateCapabilityConstraintsV2,
  validateDesignOverlayAgainstCatalogV2,
  validateLocalization,
  validatePdfTemplateRecipeV2,
  WIKI_PDF_SUPPORTED_DOCUMENT_LABELS,
  WIKI_PDF_V1_DOCUMENT_LABELS,
  type PdfTemplateRecipeBaselineV2,
  type TemplateCapabilityCatalogReferenceV1,
  type WikiPdfTemplateLocalizationV1,
  type WikiPdfTemplateRecipeV2,
} from "@atlcli/template-pack";
import {
  BUILTIN_PDF_DESIGN,
  BUILTIN_PDF_TEMPLATE_MANIFEST,
} from "./builtin-template.js";
import { resolvePdfCatalogAuthoringTarget } from "./catalog-runtime.js";
import {
  PDF_TEMPLATE_CAPABILITIES_V3,
  PDF_TEMPLATE_CAPABILITY_DIGEST_V3,
  projectPdfDesignThroughCatalogSchemaV2,
} from "./design-catalog.js";

export const PDF_TEMPLATE_BASELINE_SCHEMA_V1 =
  "atlcli.pdf-template-baseline/1" as const;
export const BUILTIN_PDF_TEMPLATE_BASELINE_ID_V1 = "atlcli.editorial" as const;
export const BUILTIN_PDF_TEMPLATE_BASELINE_VERSION_V1 = 1 as const;

export interface PdfTemplateBaselineContentV1 {
  schema: typeof PDF_TEMPLATE_BASELINE_SCHEMA_V1;
  id: string;
  version: number;
  catalog: TemplateCapabilityCatalogReferenceV1;
  design: Readonly<Record<string, unknown>>;
  localization: WikiPdfTemplateLocalizationV1;
}

export interface ResolvedPdfTemplateBaselineV1 extends PdfTemplateBaselineContentV1 {
  digest: string;
}

/** Synchronous and capability-free: implementations can only return installed data. */
export interface PdfTemplateBaselineRegistryV1 {
  resolve(
    reference: Pick<PdfTemplateRecipeBaselineV2, "id" | "version">,
  ): ResolvedPdfTemplateBaselineV1 | undefined;
}

export interface ResolvedPdfTemplateRecipeV2 {
  recipe: WikiPdfTemplateRecipeV2;
  baseline: {
    id: string;
    version: number;
    digest: string;
  };
  catalog: TemplateCapabilityCatalogReferenceV1;
  canonicalSource: {
    api: "wiki.pdf-canonical-typst";
    revision: "5";
  };
  compilerRange: string;
  design: Readonly<Record<string, unknown>>;
  localization: WikiPdfTemplateLocalizationV1;
}

export type PdfTemplateRecipeV2ResolutionReason =
  | "baseline-not-installed"
  | "baseline-identity-mismatch"
  | "baseline-digest-mismatch"
  | "catalog-mismatch"
  | "constraint-violation";

export class PdfTemplateRecipeV2ResolutionError extends Error {
  constructor(
    readonly reason: PdfTemplateRecipeV2ResolutionReason,
    message: string,
  ) {
    super(message);
    this.name = "PdfTemplateRecipeV2ResolutionError";
  }
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
  }
  return value;
}

function neutralCatalogV3Design(): Record<string, unknown> {
  const inherited = structuredClone(BUILTIN_PDF_DESIGN) as unknown as Record<
    string,
    unknown
  >;
  delete inherited.page;
  delete inherited.features;
  inherited.page = {
    format: { kind: "preset", name: "a4" },
    orientation: "portrait",
    binding: "left",
    margin: {
      mode: "physical",
      top: "23mm",
      bottom: "20mm",
      left: "22mm",
      right: "22mm",
    },
  };
  inherited.compositions = {
    cover: { kind: "standard", logo: "hide", metadataPosition: "flow" },
    closingPage: {
      kind: "document-summary",
      logo: "hide",
      website: "hide",
      legalNotice: "hide",
      align: "left",
    },
    running: {
      header: {
        enabled: true,
        layout: "single",
        first: "hide",
        odd: { center: { field: "documentTitle" } },
        even: { center: { field: "documentTitle" } },
      },
      footer: {
        enabled: true,
        layout: "three-column",
        first: "hide",
        odd: {
          center: { field: "pageNumber", numbering: "current" },
          end: { field: "organizationName" },
        },
        even: {
          center: { field: "pageNumber", numbering: "current" },
          end: { field: "organizationName" },
        },
      },
    },
  };
  inherited.navigation = {
    contents: { enabled: true, depth: 3, pageNumbers: "show", leader: "dots" },
    bookmarks: { enabled: true, depth: 4, includeHeadingNumbers: true },
    headingNumbers: { enabled: false, preset: "decimal" },
    pageNumbers: { enabled: true, preset: "arabic", start: 1 },
  };
  inherited.components = {
    paragraph: { align: "left", hyphenation: "auto" },
    list: { bulletPreset: "disc-circle-square", markerAlign: "start" },
    enumeration: {
      numberingPreset: "decimal-alpha-roman",
      markerAlign: "end",
    },
    table: { repeatHeader: true, banding: "none", borders: "all" },
    outline: { leader: "dots", pageNumbers: "show" },
    callout: { preset: "accent-bar", icon: "show" },
    codeBlock: { wrap: "soft", lineNumbers: "hide" },
  };
  return inherited;
}

const BUILTIN_BASELINE_CONTENT: PdfTemplateBaselineContentV1 = deepFreeze({
  schema: PDF_TEMPLATE_BASELINE_SCHEMA_V1,
  id: BUILTIN_PDF_TEMPLATE_BASELINE_ID_V1,
  version: BUILTIN_PDF_TEMPLATE_BASELINE_VERSION_V1,
  catalog: {
    id: PDF_TEMPLATE_CAPABILITIES_V3.id,
    version: PDF_TEMPLATE_CAPABILITIES_V3.version,
    digest: PDF_TEMPLATE_CAPABILITY_DIGEST_V3,
  },
  design: projectPdfDesignThroughCatalogSchemaV2(
    neutralCatalogV3Design(),
    PDF_TEMPLATE_CAPABILITIES_V3,
  ),
  localization: structuredClone(BUILTIN_PDF_TEMPLATE_MANIFEST.localization!),
});

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  return Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes)),
    ),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

export function canonicalPdfTemplateBaselineV1(
  baseline: PdfTemplateBaselineContentV1,
): string {
  return canonicalCapabilityJson({
    schema: baseline.schema,
    id: baseline.id,
    version: baseline.version,
    catalog: baseline.catalog,
    design: baseline.design,
    localization: baseline.localization,
  });
}

export function computePdfTemplateBaselineDigestV1(
  baseline: PdfTemplateBaselineContentV1,
): Promise<string> {
  return sha256Hex(
    new TextEncoder().encode(canonicalPdfTemplateBaselineV1(baseline)),
  );
}

/** Pinned by `recipe-baselines.test.ts`; changing it requires a new version. */
export const BUILTIN_PDF_TEMPLATE_BASELINE_DIGEST_V1 =
  "46e27e8828ff22f6ac5f6750d8b054c566c3378e7fd960f64be85251cad11f6a" as const;

export const BUILTIN_PDF_TEMPLATE_BASELINE_V1: ResolvedPdfTemplateBaselineV1 =
  deepFreeze({
    ...BUILTIN_BASELINE_CONTENT,
    digest: BUILTIN_PDF_TEMPLATE_BASELINE_DIGEST_V1,
  });

export const BUILTIN_PDF_TEMPLATE_BASELINE_REGISTRY_V1: PdfTemplateBaselineRegistryV1 =
  Object.freeze({
    resolve(reference: Pick<PdfTemplateRecipeBaselineV2, "id" | "version">) {
      return reference.id === BUILTIN_PDF_TEMPLATE_BASELINE_V1.id &&
        reference.version === BUILTIN_PDF_TEMPLATE_BASELINE_V1.version
        ? BUILTIN_PDF_TEMPLATE_BASELINE_V1
        : undefined;
    },
  });

function sameCatalog(
  left: TemplateCapabilityCatalogReferenceV1,
  right: TemplateCapabilityCatalogReferenceV1,
): boolean {
  return (
    left.id === right.id &&
    left.version === right.version &&
    left.digest === right.digest
  );
}

function writeCapability(
  design: Record<string, unknown>,
  path: string,
  value: unknown,
): void {
  const segments = path.split(".");
  let cursor = design;
  for (const segment of segments.slice(0, -1)) {
    const child = cursor[segment];
    if (typeof child !== "object" || child === null || Array.isArray(child)) {
      cursor[segment] = {};
    }
    cursor = cursor[segment] as Record<string, unknown>;
  }
  cursor[segments.at(-1)!] = structuredClone(value);
}

function deleteCapability(design: Record<string, unknown>, path: string): void {
  const segments = path.split(".");
  let cursor: Record<string, unknown> | undefined = design;
  for (const segment of segments.slice(0, -1)) {
    const child: unknown = cursor?.[segment];
    if (typeof child !== "object" || child === null || Array.isArray(child)) {
      return;
    }
    cursor = child as Record<string, unknown>;
  }
  if (cursor) delete cursor[segments.at(-1)!];
}

function validateBaselineLocalization(
  localization: unknown,
): WikiPdfTemplateLocalizationV1 {
  return validateLocalization(localization, {
    requiredDocumentLabels: WIKI_PDF_V1_DOCUMENT_LABELS,
    supportedDocumentLabels: WIKI_PDF_SUPPORTED_DOCUMENT_LABELS,
  });
}

/**
 * Resolve Recipe V2 into complete immutable authoring data. No manifest,
 * canonical Typst, archive, filesystem, or network operation occurs here.
 */
export async function resolvePdfTemplateRecipeV2Design(
  value: unknown,
  registry: PdfTemplateBaselineRegistryV1 = BUILTIN_PDF_TEMPLATE_BASELINE_REGISTRY_V1,
): Promise<ResolvedPdfTemplateRecipeV2> {
  const recipe = validatePdfTemplateRecipeV2(value);
  const baseline = registry.resolve(recipe.baseline);
  if (!baseline) {
    throw new PdfTemplateRecipeV2ResolutionError(
      "baseline-not-installed",
      `PDF template baseline ${recipe.baseline.id}@${recipe.baseline.version} is not installed`,
    );
  }
  if (
    baseline.id !== recipe.baseline.id ||
    baseline.version !== recipe.baseline.version
  ) {
    throw new PdfTemplateRecipeV2ResolutionError(
      "baseline-identity-mismatch",
      "Resolved PDF template baseline does not match the requested id/version",
    );
  }
  const computedDigest = await computePdfTemplateBaselineDigestV1(baseline);
  if (
    computedDigest !== baseline.digest ||
    recipe.baseline.digest !== baseline.digest
  ) {
    throw new PdfTemplateRecipeV2ResolutionError(
      "baseline-digest-mismatch",
      `PDF template baseline ${baseline.id}@${baseline.version} failed its pinned digest`,
    );
  }
  if (
    baseline.catalog.version !== recipe.baseline.catalogVersion ||
    !sameCatalog(baseline.catalog, {
      id: PDF_TEMPLATE_CAPABILITIES_V3.id,
      version: PDF_TEMPLATE_CAPABILITIES_V3.version,
      digest: PDF_TEMPLATE_CAPABILITY_DIGEST_V3,
    })
  ) {
    throw new PdfTemplateRecipeV2ResolutionError(
      "catalog-mismatch",
      `PDF template baseline ${baseline.id}@${baseline.version} does not target the requested catalog`,
    );
  }

  const target = resolvePdfCatalogAuthoringTarget(baseline.catalog);
  const design = structuredClone(
    projectPdfDesignThroughCatalogSchemaV2(baseline.design, target.catalog),
  );
  const overlay = validateDesignOverlayAgainstCatalogV2(
    recipe.design,
    target.catalog,
  );
  // A supplied discriminant selects its union branch. Fields forbidden by
  // that branch are removed from the installed baseline without inventing a
  // nullable deletion syntax for authors.
  for (const constraint of target.catalog.constraints) {
    const branchSelected = constraint.when.every(
      (predicate) => overlay.flat[predicate.path] === predicate.equals,
    );
    if (!branchSelected) continue;
    for (const forbidden of constraint.forbid ?? []) {
      if (forbidden.kind === "path") deleteCapability(design, forbidden.id);
    }
  }
  for (const [path, override] of Object.entries(overlay.flat)) {
    // Object-valued and array-valued catalog capabilities replace atomically;
    // ordinary nested capability paths remain sparse leaf overrides.
    writeCapability(design, path, override);
  }
  const completeDesign = projectPdfDesignThroughCatalogSchemaV2(
    design,
    target.catalog,
  );
  const localization = validateBaselineLocalization(
    recipe.localization ?? baseline.localization,
  );
  const fallback = localization.locales[localization.fallbackLocale];
  const violations = evaluateCapabilityConstraintsV2(
    completeDesign,
    target.catalog,
    {
      assets: Object.keys(recipe.assets).sort(),
      labels: Object.keys(fallback?.document ?? {}).sort(),
      compilerVersion: target.compilerVersion,
    },
  );
  if (violations.length > 0) {
    const violation = violations[0]!;
    throw new PdfTemplateRecipeV2ResolutionError(
      "constraint-violation",
      `PDF template capability constraint ${violation.constraint} ${violation.effect}: ${violation.target.kind}:${violation.target.id}`,
    );
  }

  return deepFreeze({
    recipe: structuredClone(recipe),
    baseline: {
      id: baseline.id,
      version: baseline.version,
      digest: baseline.digest,
    },
    catalog: { ...baseline.catalog },
    canonicalSource: { ...target.canonicalSource },
    compilerRange: target.compilerRange,
    design: structuredClone(completeDesign),
    localization: structuredClone(localization),
  });
}
