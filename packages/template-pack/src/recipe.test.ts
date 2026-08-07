import { describe, expect, it } from "bun:test";
import { WIKI_PDF_V1_DOCUMENT_LABELS } from "./localization.js";
import { ManifestValidationError } from "./manifest.js";
import {
  migratePdfTemplateRecipeToTypst0151V1,
  TYPST_0151_RECIPE_COMPILER_RANGE,
  validatePdfTemplateRecipeV1,
  WIKI_PDF_TEMPLATE_RECIPE_SCHEMA_V1,
} from "./recipe.js";

function validRecipe(): Record<string, unknown> {
  const document: Record<string, string> = {};
  for (const key of WIKI_PDF_V1_DOCUMENT_LABELS) document[key] = key;
  document.coverEyebrow = "EXECUTIVE BRIEFING";
  return {
    schema: WIKI_PDF_TEMPLATE_RECIPE_SCHEMA_V1,
    template: {
      id: "example.executive",
      name: "Example Executive",
      version: "1.0.0",
      compilerRange: ">=0.14 <0.15",
    },
    design: {
      page: {
        size: "a4",
        orientation: "portrait",
        margin: { top: "23mm", right: "22mm", bottom: "20mm", left: "22mm" },
      },
      features: {
        cover: { enabled: true },
        outline: { enabled: true, depth: 3 },
        header: { enabled: true, mode: "title" },
        footer: { enabled: true },
        closingPage: { enabled: true },
      },
      compositions: {
        cover: {
          kind: "type-cut",
          logo: "hide",
          metadataPosition: "bottom",
          typeCut: { angle: 43, stop: 58 },
        },
        closingPage: {
          kind: "brand-lockup",
          logo: "show",
          website: "show",
          legalNotice: "show",
          align: "left",
        },
      },
      branding: {
        accent: "#E75204",
        organizationName: "Example Systems GmbH",
        websiteLabel: "example.invalid",
        websiteUrl: "https://example.invalid",
        legalNotice: "© Example Systems GmbH · Zürich",
      },
      typography: {
        fonts: {
          body: "Source Serif 4",
          heading: "Source Sans 3",
          mono: "Source Code Pro",
        },
        roles: {
          body: { font: "body", size: "10pt" },
          coverTitle: { font: "heading", size: "44pt", weight: "bold" },
        },
      },
      tokens: {
        colors: { ink: "#172B4D", accent: "#E75204" },
        layout: {
          paragraphSpacing: "10pt",
          leading: "0.74em",
          coverMetaBottomInset: "24mm",
        },
        ratios: { coverWidth: 90 },
        contrast: { minimum: 4.5 },
      },
      semanticPalettes: {
        callouts: { info: { background: "#DEEBFF", foreground: "#0747A6" } },
        statuses: { green: "#00875A" },
      },
    },
    localization: {
      defaultLocale: "en",
      fallbackLocale: "en",
      locales: {
        en: {
          template: { name: "Example Executive", description: "Executive PDF" },
          document,
        },
      },
    },
    assets: {
      "asset.coverBackground": {
        source: "assets/cover.svg",
        decorative: true,
        placement: {
          relativeTo: "page",
          fit: "stretch",
          x: "0mm",
          y: "0mm",
          width: "210mm",
          height: "297mm",
        },
      },
      "asset.logo": {
        source: "assets/logo.svg",
        decorative: false,
        alt: "Example Systems",
      },
    },
  };
}

function setPath(recipe: Record<string, unknown>, path: string[], value: unknown): void {
  let current = recipe;
  for (const segment of path.slice(0, -1)) {
    current = current[segment] as Record<string, unknown>;
  }
  current[path.at(-1)!] = value;
}

describe("validatePdfTemplateRecipeV1", () => {
  it("accepts and preserves the complete portable declarative recipe", () => {
    const recipe = validatePdfTemplateRecipeV1(validRecipe());
    expect(recipe.schema).toBe(WIKI_PDF_TEMPLATE_RECIPE_SCHEMA_V1);
    expect(recipe.design.compositions?.cover.typeCut).toEqual({ angle: 43, stop: 58 });
    expect(recipe.design.compositions?.cover.metadataPosition).toBe("bottom");
    expect(recipe.design.tokens.layout.coverMetaBottomInset).toBe("24mm");
    expect(recipe.design.branding.legalNotice).toBe("© Example Systems GmbH · Zürich");
    expect(recipe.localization.locales.en?.document?.coverEyebrow).toBe(
      "EXECUTIVE BRIEFING"
    );
    expect(recipe.assets["asset.coverBackground"]?.source).toBe("assets/cover.svg");
  });

  it("keeps an old design without compositions valid", () => {
    const recipe = validRecipe();
    const design = recipe.design as Record<string, unknown>;
    delete design.compositions;
    const branding = design.branding as Record<string, unknown>;
    delete branding.websiteLabel;
    delete branding.websiteUrl;
    delete branding.legalNotice;
    expect(validatePdfTemplateRecipeV1(recipe).design.compositions).toBeUndefined();
  });

  it("rejects renderer-generated and raw-code fields at stable paths", () => {
    for (const field of [
      "canonicalSource",
      "capabilityCatalog",
      "assetDescriptors",
      "provenance",
      "engine",
      "rawTypst",
    ]) {
      const recipe = validRecipe();
      recipe[field] = field === "rawTypst" ? "#panic(\"boom\")" : {};
      expect(() => validatePdfTemplateRecipeV1(recipe)).toThrow(
        new RegExp(`recipe\\.${field}.*not recognized`)
      );
    }
    const nested = validRecipe();
    (nested.template as Record<string, unknown>).entry = "atlcli.typ";
    expect(() => validatePdfTemplateRecipeV1(nested)).toThrow(/template\.entry.*not recognized/);
  });

  it("rejects unknown keys in every fixed recipe structure", () => {
    const cases: Array<[string[], string]> = [
      [["design", "page", "bleed"], "design.page.bleed"],
      [["design", "features", "cover", "visible"], "features.cover.visible"],
      [["design", "branding", "copyright"], "branding.copyright"],
      [["design", "typography", "fonts", "display"], "fonts.display"],
      [["design", "tokens", "contrast", "preferred"], "contrast.preferred"],
      [["localization", "locales", "en", "unknown"], "locales.en.unknown"],
      [["assets", "asset.logo", "writer"], "asset.logo.writer"],
    ];
    for (const [path, expected] of cases) {
      const recipe = validRecipe();
      setPath(recipe, path, true);
      expect(() => validatePdfTemplateRecipeV1(recipe)).toThrow(
        new RegExp(expected.replaceAll(".", "\\."))
      );
    }
  });

  it("rejects Typst-shaped strings as data at the portable import gate", () => {
    const recipe = validRecipe();
    (recipe.template as Record<string, unknown>).name = '#let x = panic("executed")';
    expect(() => validatePdfTemplateRecipeV1(recipe)).toThrow(/metacharacters/);
  });

  it("rejects unsafe asset source paths", () => {
    for (const source of [
      "./assets/logo.svg",
      "../logo.svg",
      "assets/../logo.svg",
      "/tmp/logo.svg",
      "C:/assets/logo.svg",
      "assets\\logo.svg",
      "assets//logo.svg",
      "assets/\u0000logo.svg",
    ]) {
      const recipe = validRecipe();
      setPath(recipe, ["assets", "asset.logo", "source"], source);
      expect(() => validatePdfTemplateRecipeV1(recipe)).toThrow(/safe relative portable path/);
    }
  });

  it("requires accessible copy for meaning-bearing assets", () => {
    const recipe = validRecipe();
    delete ((recipe.assets as Record<string, Record<string, unknown>>)["asset.logo"]!).alt;
    expect(() => validatePdfTemplateRecipeV1(recipe)).toThrow(/asset\.logo\.alt/);
  });

  it("migrates only the compiler range to a distinct 0.15.1 recipe", () => {
    const source = validRecipe();
    const sourceSnapshot = structuredClone(source);
    const migrated = migratePdfTemplateRecipeToTypst0151V1(source);
    expect(source).toEqual(sourceSnapshot);
    expect(migrated).not.toBe(source);
    expect(migrated.template.compilerRange).toBe(TYPST_0151_RECIPE_COMPILER_RANGE);
    expect({ ...migrated, template: { ...migrated.template, compilerRange: ">=0.14 <0.15" } })
      .toEqual(validatePdfTemplateRecipeV1(source));
    expect(() => migratePdfTemplateRecipeToTypst0151V1(migrated)).toThrow(
      /already accepts Typst 0\.15\.1/u
    );
  });

  it("bounds asset collections, dynamic maps, paths, and placement values", () => {
    const tooManyAssets = validRecipe();
    const assets = tooManyAssets.assets as Record<string, unknown>;
    for (let index = 0; index < 65; index += 1) {
      assets[`asset.extra${index}`] = {
        source: `assets/extra${index}.svg`,
        decorative: true,
      };
    }
    expect(() => validatePdfTemplateRecipeV1(tooManyAssets)).toThrow(/at most 64 entries/);

    const tooManyRoles = validRecipe();
    const roles = (
      (tooManyRoles.design as Record<string, unknown>).typography as Record<string, unknown>
    ).roles as Record<string, unknown>;
    for (let index = 0; index < 257; index += 1) {
      roles[`role${index}`] = { size: "10pt" };
    }
    expect(() => validatePdfTemplateRecipeV1(tooManyRoles)).toThrow(/at most 256 entries/);

    const longPath = validRecipe();
    setPath(
      longPath,
      ["assets", "asset.logo", "source"],
      `assets/${"a".repeat(505)}.svg`
    );
    expect(() => validatePdfTemplateRecipeV1(longPath)).toThrow(/safe relative portable path/);

    const invalidPlacement = validRecipe();
    setPath(
      invalidPlacement,
      ["assets", "asset.coverBackground", "placement", "width"],
      "-1mm"
    );
    expect(() => validatePdfTemplateRecipeV1(invalidPlacement)).toThrow(/non-negative/);
  });

  it("rejects invalid schema, template identity, version, and compiler range", () => {
    for (const [path, value] of [
      [["schema"], "wiki.pdf-template-recipe/v2"],
      [["template", "id"], "bad id"],
      [["template", "version"], "one"],
      [["template", "compilerRange"], ">=0.14 || <0.15"],
    ] as Array<[string[], unknown]>) {
      const recipe = validRecipe();
      setPath(recipe, path, value);
      expect(() => validatePdfTemplateRecipeV1(recipe)).toThrow(ManifestValidationError);
    }
  });
});
