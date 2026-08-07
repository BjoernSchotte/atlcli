/** Host-neutral recipe -> canonical revision-4 template-pack materializer. */
import type {
  TemplateGeneratedPackCompilerV1,
  TemplateRuntimeAssetV1,
} from "@atlcli/pdf-template-authoring";
import {
  packTemplate,
  unpackTemplate,
  validateManifest,
  validatePdfTemplateRecipeV1,
  type TemplateAssetMediaTypeV1,
  type TemplateManifest,
  type WikiPdfTemplateRecipeV1,
} from "@atlcli/template-pack";
import { BUILTIN_PDF_TEMPLATE_MANIFEST } from "./builtin-template.js";
import {
  PDF_TEMPLATE_CAPABILITIES_V2,
  PDF_TEMPLATE_CAPABILITY_DIGEST_V2,
  projectPdfDesignThroughCatalogV2,
} from "./design-catalog.js";
import { PDF_RUNTIME_ASSETS } from "./runtime-assets.js";
import {
  PDF_CANONICAL_SOURCE_API_V1,
  PDF_CANONICAL_SOURCE_REVISION_4,
  PDF_TEMPLATE_ASSET_SLOTS_V1,
  generateCanonicalPdfTemplateSourceV1,
  loadPdfTemplatePack,
  validatePdfTemplateManifest,
  validatePdfTemplatePack,
  type PdfTemplateRuntimeSnapshotV1,
  type PdfTemplateVisualsV1,
} from "./template-pack.js";
import {
  PDF_RECIPE_TEMPLATE_ASSET_IDENTITY_V1,
  materializePdfTemplateAssetFields,
  pdfTemplateAssetExtension,
  sha256PdfTemplateBytes,
  validatePdfTemplateAssetPreflight,
} from "./template-assets.js";

const encoder = new TextEncoder();
const ASSET_SLOTS = new Set<string>(PDF_TEMPLATE_ASSET_SLOTS_V1);
const SHA256_RE = /^[a-f0-9]{64}$/u;

export interface ResolvedPdfTemplateRecipeAssetV1 {
  /** Must equal the recipe map key. */
  slot: string;
  /** Must equal the validated recipe's relative source path. */
  source: string;
  mediaType: TemplateAssetMediaTypeV1;
  /** Resolver-computed digest; materialization recomputes and verifies it. */
  sha256: string;
  bytes: Uint8Array;
}

export interface MaterializePdfTemplateRecipeInputV1 {
  recipe: WikiPdfTemplateRecipeV1;
  resolvedAssets: Readonly<
    Record<string, ResolvedPdfTemplateRecipeAssetV1>
  >;
  compiler: TemplateGeneratedPackCompilerV1;
}

export interface MaterializedPdfTemplateRecipeV1 {
  bytes: Uint8Array;
  packDigest: string;
  manifest: TemplateManifest;
  canonicalTypst: string;
  runtimeSnapshot: PdfTemplateRuntimeSnapshotV1;
  compile: { digest: string; pageCount: number };
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return (
    left.length === right.length &&
    sortedLeft.every((value, index) => value === sortedRight[index])
  );
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return (
    left.byteLength === right.byteLength &&
    left.every((byte, index) => byte === right[index])
  );
}

function runtimeAssets(
  recipe: WikiPdfTemplateRecipeV1,
  resolved: Readonly<Record<string, ResolvedPdfTemplateRecipeAssetV1>>
): TemplateRuntimeAssetV1[] {
  const declaredSlots = Object.keys(recipe.assets);
  const resolvedSlots = Object.keys(resolved);
  if (!sameStringSet(declaredSlots, resolvedSlots)) {
    throw new Error(
      "Resolved recipe assets must match the declared asset slots exactly"
    );
  }
  return declaredSlots
    .sort()
    .map((slot): TemplateRuntimeAssetV1 => {
      if (!ASSET_SLOTS.has(slot)) {
        throw new Error(`Recipe asset slot ${slot} is not supported by PDF revision 4`);
      }
      const declaration = recipe.assets[slot]!;
      const asset = resolved[slot]!;
      if (asset.slot !== slot || asset.source !== declaration.source) {
        throw new Error(`Resolved recipe asset ${slot} does not match its declaration`);
      }
      if (!SHA256_RE.test(asset.sha256)) {
        throw new Error(`Resolved recipe asset ${slot} has an invalid SHA-256`);
      }
      if (!(asset.bytes instanceof Uint8Array)) {
        throw new Error(`Resolved recipe asset ${slot} has no byte payload`);
      }
      return {
        slot,
        sha256: asset.sha256,
        mediaType: asset.mediaType,
        bytes: new Uint8Array(asset.bytes),
        accessibility: {
          decorative: declaration.decorative,
          ...(declaration.alt === undefined ? {} : { alt: declaration.alt }),
        },
        rendering: declaration.placement
          ? { kind: "custom-placement", placement: declaration.placement }
          : { kind: "slot-default" },
      };
    });
}

function assertCompositionAssetUse(
  recipe: WikiPdfTemplateRecipeV1,
  assets: readonly TemplateRuntimeAssetV1[]
): void {
  const slots = new Set(assets.map(({ slot }) => slot));
  const compositions = recipe.design.compositions;
  if (!compositions) {
    throw new Error("Revision-4 recipes require explicit page compositions");
  }
  if (
    compositions.cover.kind === "type-cut" &&
    !slots.has("asset.coverBackground")
  ) {
    throw new Error("Type Cut recipes require asset.coverBackground");
  }
  if (
    (compositions.cover.logo === "show" ||
      (compositions.closingPage.kind === "brand-lockup" &&
        compositions.closingPage.logo === "show")) &&
    !slots.has("asset.logo")
  ) {
    throw new Error("A visible composition logo requires asset.logo");
  }
  if (
    slots.has("asset.logo") &&
    compositions.cover.logo !== "show" &&
    !(
      compositions.closingPage.kind === "brand-lockup" &&
      compositions.closingPage.logo === "show"
    )
  ) {
    throw new Error("asset.logo is unreferenced by the selected compositions");
  }
}

/**
 * Validate, materialize, pack, round-trip, and compile one declarative recipe.
 * No archive bytes escape this function until every gate has succeeded.
 */
export async function materializePdfTemplateRecipeV1(
  input: MaterializePdfTemplateRecipeInputV1
): Promise<MaterializedPdfTemplateRecipeV1> {
  const recipe = validatePdfTemplateRecipeV1(input.recipe);
  const design = projectPdfDesignThroughCatalogV2(recipe.design);
  const assets = runtimeAssets(recipe, input.resolvedAssets);
  assertCompositionAssetUse(recipe, assets);
  for (const asset of assets) {
    await validatePdfTemplateAssetPreflight(asset);
  }

  const visual = materializePdfTemplateAssetFields(
    assets,
    design,
    PDF_RECIPE_TEMPLATE_ASSET_IDENTITY_V1
  );
  const manifest = validateManifest(
    {
      ...BUILTIN_PDF_TEMPLATE_MANIFEST,
      id: recipe.template.id,
      name: recipe.template.name,
      version: recipe.template.version,
      engine: {
        ...BUILTIN_PDF_TEMPLATE_MANIFEST.engine,
        compilerRange: recipe.template.compilerRange,
      },
      design,
      localization: recipe.localization,
      capabilityCatalog: {
        id: PDF_TEMPLATE_CAPABILITIES_V2.id,
        version: PDF_TEMPLATE_CAPABILITIES_V2.version,
        digest: PDF_TEMPLATE_CAPABILITY_DIGEST_V2,
      },
      canonicalSource: {
        api: PDF_CANONICAL_SOURCE_API_V1,
        revision: PDF_CANONICAL_SOURCE_REVISION_4,
      },
      assetDescriptors: visual.descriptors,
      assets: visual.references,
      decorations: visual.decorations,
      provenance: undefined,
    },
    {
      availableFonts: PDF_RUNTIME_ASSETS.fonts.map(({ family, style, weight }) => ({
        family,
        style,
        weight,
      })),
    }
  );
  validatePdfTemplateManifest(manifest);

  const visuals: PdfTemplateVisualsV1 = {
    assets: Object.fromEntries(
      Object.entries(manifest.assets ?? {}).map(([slot, reference]) => {
        const descriptor = manifest.assetDescriptors?.[reference.descriptor];
        if (!descriptor) {
          throw new Error(`PDF recipe asset ${slot} has no validated descriptor`);
        }
        return [
          slot,
          {
            vfsPath: `template-assets/${reference.descriptor
              .toLowerCase()
              .replace(/[._]+/g, "-")}.${pdfTemplateAssetExtension(
              descriptor.mediaType
            )}`,
            reference,
          },
        ];
      })
    ) as PdfTemplateVisualsV1["assets"],
    decorations: manifest.decorations ?? [],
  };

  // Canonical source is intentionally generated only after design, asset
  // cross-references, byte hashes, media, dimensions, budgets, and SVG safety.
  const canonicalTypst = generateCanonicalPdfTemplateSourceV1(manifest, visuals);
  const files: Record<string, Uint8Array> = {
    ...visual.files,
    [manifest.engine.entry]: encoder.encode(canonicalTypst),
  };
  await validatePdfTemplatePack(manifest, files);

  const bytes = await packTemplate({ manifest, files });
  const unpacked = unpackTemplate(bytes);
  const repacked = await packTemplate(unpacked);
  if (!bytesEqual(bytes, repacked)) {
    throw new Error("Recipe template pack round-trip was not byte-identical");
  }
  const loaded = await loadPdfTemplatePack(bytes);
  const compile = await input.compiler.compile({
    packBytes: new Uint8Array(bytes),
    manifest: structuredClone(loaded.manifest),
    runtimeSnapshot: structuredClone(
      loaded.runtimeSnapshot
    ) as unknown as Readonly<Record<string, unknown>>,
  });
  if (
    !SHA256_RE.test(compile.digest) ||
    !Number.isSafeInteger(compile.pageCount) ||
    compile.pageCount < 1
  ) {
    throw new Error("Recipe compiler returned invalid proof metadata");
  }

  return {
    bytes: new Uint8Array(bytes),
    packDigest: await sha256PdfTemplateBytes(bytes),
    manifest: structuredClone(loaded.manifest),
    canonicalTypst,
    runtimeSnapshot: structuredClone(loaded.runtimeSnapshot),
    compile: { digest: compile.digest, pageCount: compile.pageCount },
  };
}
