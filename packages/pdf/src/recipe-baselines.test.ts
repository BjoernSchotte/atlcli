import { describe, expect, it } from "bun:test";
import {
  canonicalCapabilityJson,
  WIKI_PDF_V1_DOCUMENT_LABELS,
  type PdfTemplateRecipeDesignOverlayV2,
  type WikiPdfTemplateRecipeV2,
} from "@atlcli/template-pack";
import {
  PDF_TEMPLATE_CAPABILITIES_V3,
  PDF_TEMPLATE_CAPABILITY_DIGEST_V3,
} from "./design-catalog.js";
import {
  BUILTIN_PDF_TEMPLATE_BASELINE_DIGEST_V1,
  BUILTIN_PDF_TEMPLATE_BASELINE_ID_V1,
  BUILTIN_PDF_TEMPLATE_BASELINE_REGISTRY_V1,
  BUILTIN_PDF_TEMPLATE_BASELINE_V1,
  computePdfTemplateBaselineDigestV1,
  PdfTemplateRecipeV2ResolutionError,
  resolvePdfTemplateRecipeV2Design,
  type PdfTemplateBaselineRegistryV1,
  type ResolvedPdfTemplateBaselineV1,
} from "./recipe-baselines.js";

function recipe(
  design: PdfTemplateRecipeDesignOverlayV2 = {},
): WikiPdfTemplateRecipeV2 {
  return {
    schema: "wiki.pdf-template-recipe/v2",
    template: {
      id: "example.handbook",
      name: "Example Handbook",
      version: "1.0.0",
    },
    baseline: {
      id: BUILTIN_PDF_TEMPLATE_BASELINE_ID_V1,
      version: 1,
      catalogVersion: 3,
      digest: BUILTIN_PDF_TEMPLATE_BASELINE_DIGEST_V1,
    },
    design,
    assets: {},
  };
}

function reverseKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverseKeys);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .reverse()
        .map(([key, entry]) => [key, reverseKeys(entry)]),
    );
  }
  return value;
}

async function registryWith(
  baseline: Omit<ResolvedPdfTemplateBaselineV1, "digest"> & { digest?: string },
): Promise<PdfTemplateBaselineRegistryV1> {
  const digest =
    baseline.digest ??
    (await computePdfTemplateBaselineDigestV1(
      baseline as ResolvedPdfTemplateBaselineV1,
    ));
  const resolved = { ...baseline, digest } as ResolvedPdfTemplateBaselineV1;
  return { resolve: () => resolved };
}

describe("Recipe V2 installed baseline resolution", () => {
  it("pins the neutral catalog-V3 baseline digest and complete metadata", async () => {
    expect(
      await computePdfTemplateBaselineDigestV1(
        BUILTIN_PDF_TEMPLATE_BASELINE_V1,
      ),
    ).toBe(BUILTIN_PDF_TEMPLATE_BASELINE_DIGEST_V1);
    expect(BUILTIN_PDF_TEMPLATE_BASELINE_V1.catalog).toEqual({
      id: PDF_TEMPLATE_CAPABILITIES_V3.id,
      version: 3,
      digest: PDF_TEMPLATE_CAPABILITY_DIGEST_V3,
    });
    expect(BUILTIN_PDF_TEMPLATE_BASELINE_V1.design).toMatchObject({
      page: {
        format: { kind: "preset", name: "a4" },
        orientation: "portrait",
      },
      navigation: {
        contents: { enabled: true },
        bookmarks: { enabled: true },
      },
    });
  });

  it("resolves no overrides into immutable complete authoring data", async () => {
    const resolved = await resolvePdfTemplateRecipeV2Design(recipe());
    expect(resolved.baseline).toEqual({
      id: BUILTIN_PDF_TEMPLATE_BASELINE_ID_V1,
      version: 1,
      digest: BUILTIN_PDF_TEMPLATE_BASELINE_DIGEST_V1,
    });
    expect(resolved.catalog).toEqual(BUILTIN_PDF_TEMPLATE_BASELINE_V1.catalog);
    expect(resolved.canonicalSource).toEqual({
      api: "wiki.pdf-canonical-typst",
      revision: "5",
    });
    expect(resolved.compilerRange).toBe(">=0.15.1 <0.16");
    expect(resolved.design).toEqual(BUILTIN_PDF_TEMPLATE_BASELINE_V1.design);
    expect(Object.isFrozen(resolved)).toBe(true);
    expect(Object.isFrozen(resolved.design)).toBe(true);
    expect(
      Object.isFrozen(resolved.design.page.format),
    ).toBe(true);
  });

  it("applies sparse leaves, replaces arrays, and switches union branches", async () => {
    const resolved = await resolvePdfTemplateRecipeV2Design(
      recipe({
        page: {
          format: { kind: "custom", width: "180mm", height: "240mm" },
          orientation: "landscape",
          margin: {
            mode: "logical",
            top: "18mm",
            bottom: "22mm",
            inside: "25mm",
            outside: "18mm",
          },
        },
        paints: { accent: { kind: "solid", color: "accent" } },
        decorations: [
          {
            kind: "rect",
            scope: "first",
            layer: "page-background",
            box: { x: "0mm", y: "0mm", width: "180mm", height: "40mm" },
            fill: "accent",
          },
        ],
      }),
    );
    expect(resolved.design).toMatchObject({
      page: {
        format: { kind: "custom", width: "180mm", height: "240mm" },
        orientation: "landscape",
        margin: {
          mode: "logical",
          top: "18mm",
          bottom: "22mm",
          inside: "25mm",
          outside: "18mm",
        },
      },
      decorations: [expect.objectContaining({ kind: "rect" })],
    });
    expect("name" in resolved.design.page.format).toBe(false);
    expect("left" in resolved.design.page.margin).toBe(false);
    expect("right" in resolved.design.page.margin).toBe(false);
  });

  it("resolves a full catalog-V3 authoring recipe with conditional assets", async () => {
    const source = recipe({
      page: {
        format: { kind: "preset", name: "letter" },
        binding: "right",
        margin: {
          mode: "logical",
          top: "18mm",
          bottom: "22mm",
          inside: "25mm",
          outside: "18mm",
        },
      },
      compositions: {
        cover: {
          kind: "type-cut",
          logo: "hide",
          metadataPosition: "flow",
          typeCut: { angle: 43, stop: 58 },
        },
        running: {
          header: {
            enabled: true,
            layout: "split",
            first: "hide",
            odd: {
              start: { field: "chapterTitle" },
              end: { field: "spaceKey" },
            },
            even: {
              start: { field: "spaceKey" },
              end: { field: "documentTitle" },
            },
          },
        },
      },
      navigation: {
        contents: {
          enabled: true,
          depth: 3,
          pageNumbers: "show",
          leader: "dots",
        },
        bookmarks: {
          enabled: true,
          depth: 4,
          includeHeadingNumbers: true,
        },
      },
      components: {
        paragraph: { align: "justify", hyphenation: "auto" },
        list: {
          bulletPreset: "disc-circle-square",
          markerAlign: "horizon",
        },
        table: { repeatHeader: true, banding: "rows", borders: "horizontal" },
      },
      typography: {
        roles: {
          body: { style: "normal", kerning: true, ligatures: "common" },
          tableCell: { numberWidth: "tabular" },
          coverTitleCompact: {
            font: "heading",
            size: "25pt",
            weight: "semibold",
          },
          coverTitleMinimum: {
            font: "heading",
            size: "19pt",
            weight: "semibold",
          },
        },
      },
      tokens: {
        colors: { coverTitleInverse: "#FFFFFF" },
        layout: { coverTitleFrameHeight: "92mm" },
      },
      paints: {
        hero: {
          kind: "linear",
          angle: 43,
          relativeTo: "parent",
          stops: [
            { at: 0, color: "coverTitleInk" },
            { at: 58, color: "coverTitleInk" },
            { at: 58, color: "coverTitleInverse" },
            { at: 100, color: "coverTitleInverse" },
          ],
        },
      },
      decorations: [
        {
          kind: "rect",
          scope: "first",
          layer: "page-background",
          box: { x: "0mm", y: "0mm", width: "216mm", height: "80mm" },
          fill: "hero",
        },
      ],
    });
    source.assets = {
      "asset.coverBackground": {
        source: "assets/cover.svg",
        decorative: true,
      },
    };
    const resolved = await resolvePdfTemplateRecipeV2Design(source);
    expect(resolved.design).toMatchObject({
      page: { format: { kind: "preset", name: "letter" }, binding: "right" },
      compositions: { cover: { kind: "type-cut" } },
      navigation: { contents: { depth: 3 }, bookmarks: { depth: 4 } },
      components: { paragraph: { align: "justify" } },
      paints: { hero: { kind: "linear" } },
      decorations: [expect.objectContaining({ fill: "hero" })],
    });
  });

  it("is deterministic under object-key reorder", async () => {
    const source = recipe({
      page: { orientation: "landscape" },
      components: {
        paragraph: { align: "justify", hyphenation: "auto" },
      },
    });
    const first = await resolvePdfTemplateRecipeV2Design(source);
    const reordered = await resolvePdfTemplateRecipeV2Design(
      reverseKeys(source) as WikiPdfTemplateRecipeV2,
    );
    expect(canonicalCapabilityJson(first.design)).toBe(
      canonicalCapabilityJson(reordered.design),
    );
    expect(canonicalCapabilityJson(first.localization)).toBe(
      canonicalCapabilityJson(reordered.localization),
    );
  });

  it("accepts a complete localization replacement and keeps required labels", async () => {
    const source = recipe();
    source.localization = structuredClone(
      BUILTIN_PDF_TEMPLATE_BASELINE_V1.localization,
    );
    source.localization.defaultLocale = "de";
    const resolved = await resolvePdfTemplateRecipeV2Design(source);
    expect(resolved.localization.defaultLocale).toBe("de");
    expect(
      Object.keys(
        resolved.localization.locales[resolved.localization.fallbackLocale]!
          .document!,
      ).sort(),
    ).toEqual([...WIKI_PDF_V1_DOCUMENT_LABELS].sort());
  });

  it("fails closed for unknown paths, null deletion, and active requirements", async () => {
    await expect(
      resolvePdfTemplateRecipeV2Design(recipe({ page: { paper: "a4" } })),
    ).rejects.toThrow(/page\.paper.*not declared/u);

    const deletion = recipe({ page: { bleed: {} } }) as unknown as Record<
      string,
      unknown
    >;
    (
      (deletion.design as Record<string, unknown>).page as Record<
        string,
        unknown
      >
    )["bleed"] = null;
    await expect(resolvePdfTemplateRecipeV2Design(deletion)).rejects.toThrow(
      /null is not a delete operator/u,
    );

    await expect(
      resolvePdfTemplateRecipeV2Design(
        recipe({
          compositions: {
            cover: {
              kind: "type-cut",
              logo: "hide",
              metadataPosition: "flow",
              typeCut: { angle: 43, stop: 58 },
            },
          },
        }),
      ),
    ).rejects.toThrow(PdfTemplateRecipeV2ResolutionError);

    await expect(
      resolvePdfTemplateRecipeV2Design(
        recipe({
          paints: {
            hero: {
              kind: "linear",
              angle: 0,
              relativeTo: "parent",
              stops: [
                { at: 100, color: "ink" },
                { at: 0, color: "accent" },
              ],
            },
          },
        }),
      ),
    ).rejects.toThrow(/sorted in non-decreasing order/u);
  });

  it("rejects missing, mismatched, tampered, and wrong-catalog baselines", async () => {
    await expect(
      resolvePdfTemplateRecipeV2Design(recipe(), { resolve: () => undefined }),
    ).rejects.toMatchObject({ reason: "baseline-not-installed" });

    const wrongIdentity = structuredClone(BUILTIN_PDF_TEMPLATE_BASELINE_V1);
    wrongIdentity.id = "atlcli.other";
    await expect(
      resolvePdfTemplateRecipeV2Design(
        recipe(),
        await registryWith(wrongIdentity),
      ),
    ).rejects.toMatchObject({ reason: "baseline-identity-mismatch" });

    const tampered = structuredClone(BUILTIN_PDF_TEMPLATE_BASELINE_V1);
    tampered.design.page.orientation = "landscape";
    await expect(
      resolvePdfTemplateRecipeV2Design(recipe(), {
        resolve: () => tampered,
      }),
    ).rejects.toMatchObject({ reason: "baseline-digest-mismatch" });

    const wrongCatalog = structuredClone(BUILTIN_PDF_TEMPLATE_BASELINE_V1);
    wrongCatalog.catalog = {
      ...wrongCatalog.catalog,
      version: 2,
      digest: "b".repeat(64),
    };
    delete (wrongCatalog as Partial<ResolvedPdfTemplateBaselineV1>).digest;
    const wrongCatalogRegistry = await registryWith(wrongCatalog);
    const wrongCatalogRecipe = recipe();
    wrongCatalogRecipe.baseline.catalogVersion = 2;
    wrongCatalogRecipe.baseline.digest = wrongCatalogRegistry.resolve(
      wrongCatalogRecipe.baseline,
    )!.digest;
    await expect(
      resolvePdfTemplateRecipeV2Design(
        wrongCatalogRecipe,
        wrongCatalogRegistry,
      ),
    ).rejects.toMatchObject({ reason: "catalog-mismatch" });
  });

  it("does not mutate the author recipe or installed baseline", async () => {
    const source = recipe({ page: { orientation: "landscape" } });
    const sourceSnapshot = structuredClone(source);
    const baselineSnapshot = structuredClone(BUILTIN_PDF_TEMPLATE_BASELINE_V1);
    await resolvePdfTemplateRecipeV2Design(
      source,
      BUILTIN_PDF_TEMPLATE_BASELINE_REGISTRY_V1,
    );
    expect(source).toEqual(sourceSnapshot);
    expect(BUILTIN_PDF_TEMPLATE_BASELINE_V1).toEqual(baselineSnapshot);
  });
});
