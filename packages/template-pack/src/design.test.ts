/**
 * Design/bindings/localization schema tests (spec 012 T6.1). Real fixture
 * manifests, boundary values, and typed rejections — no mocks.
 */
import { describe, expect, it } from "bun:test";
import {
  validateDesign,
  type WikiPdfTemplateDesignV1,
} from "./design.js";
import { validateBindings } from "./bindings.js";
import { validateLocalization, WIKI_PDF_V1_DOCUMENT_LABELS } from "./localization.js";
import { validateManifest, ManifestValidationError } from "./manifest.js";
import { localizeTemplateUi } from "./localize.js";

function validDesign(): WikiPdfTemplateDesignV1 {
  return {
    page: {
      size: "a4",
      orientation: "portrait",
      margin: { top: "23mm", bottom: "20mm", left: "22mm", right: "22mm" },
    },
    features: {
      cover: { enabled: true },
      outline: { enabled: true, depth: 3 },
      header: { enabled: true },
      footer: { enabled: true },
      closingPage: { enabled: true },
    },
    branding: { accent: "#4B57A3" },
    typography: {
      fonts: { body: "Source Serif 4", heading: "Source Sans 3", mono: "Source Code Pro" },
      roles: {
        body: { font: "body", size: "10pt" },
        h1: { font: "heading", size: "18pt", weight: "semibold" },
        eyebrow: { font: "heading", size: "8pt", weight: "semibold", tracking: "0.12em" },
      },
    },
    tokens: {
      colors: { ink: "#172B4D", accent: "#4B57A3" },
      layout: { paragraphSpacing: "10pt", leading: "0.74em" },
      ratios: { coverWidth: 90 },
      contrast: { minimum: 4.5 },
    },
    semanticPalettes: {
      callouts: { info: { background: "#DEEBFF", foreground: "#0747A6" } },
      statuses: { green: "#00875A" },
    },
  };
}

describe("validateDesign", () => {
  it("accepts a complete, in-bounds design", () => {
    expect(() => validateDesign(validDesign())).not.toThrow();
  });

  it("rejects a non-canonical color", () => {
    const design = validDesign();
    (design.tokens.colors as Record<string, string>).ink = "#abc";
    expect(() => validateDesign(design)).toThrow(ManifestValidationError);
  });

  it("rejects a length without a pt/mm/em unit", () => {
    const design = validDesign();
    (design.tokens.layout as Record<string, string>).leading = "0.74rem";
    expect(() => validateDesign(design)).toThrow(/pt\/mm\/em/);
  });

  it("rejects an out-of-bounds length magnitude", () => {
    const design = validDesign();
    (design.tokens.layout as Record<string, string>).leading = "5000pt";
    expect(() => validateDesign(design)).toThrow(/magnitude/);
  });

  it("rejects an out-of-bounds ratio and a non-integer outline depth", () => {
    const overRatio = validDesign();
    (overRatio.tokens.ratios as Record<string, number>).coverWidth = 500;
    expect(() => validateDesign(overRatio)).toThrow(ManifestValidationError);
    const badDepth = validDesign();
    badDepth.features.outline.depth = 2.5;
    expect(() => validateDesign(badDepth)).toThrow(/integer/);
  });

  it("rejects a Typst-source-shaped string in a design field", () => {
    const design = validDesign();
    design.typography.fonts.body = 'Evil"#{sys.exit()}';
    expect(() => validateDesign(design)).toThrow(/metacharacters/);
  });

  it("rejects an unknown font weight", () => {
    const design = validDesign();
    (design.typography.roles.h1 as { weight: string }).weight = "ultrablack";
    expect(() => validateDesign(design)).toThrow(ManifestValidationError);
  });

  it("accepts boundary lengths, colors, and ratios", () => {
    const design = validDesign();
    design.tokens.layout.leading = "0pt";
    design.tokens.ratios.coverWidth = 0;
    design.tokens.contrast.minimum = 21;
    (design.tokens.colors as Record<string, string>).ink = "#000000";
    expect(() => validateDesign(design)).not.toThrow();
  });
});

describe("validateBindings", () => {
  it("accepts allowlisted targets with identity and choice-map transforms", () => {
    const bindings = validateBindings([
      { setting: "accentColor", targets: ["branding.accent", "tokens.colors.accent"] },
      { setting: "page", targets: ["page.size"], transform: { kind: "identity" } },
      { setting: "cover", targets: ["features.cover.enabled"], transform: { kind: "choice-map", map: { on: true } } },
    ]);
    expect(bindings).toHaveLength(3);
  });

  it("rejects a binding targeting a path outside the allowlist", () => {
    expect(() => validateBindings([{ setting: "x", targets: ["tokens.colors.ink"] }])).toThrow(
      /allowlisted design paths/
    );
  });

  it("rejects a transform other than identity/choice-map", () => {
    expect(() =>
      validateBindings([{ setting: "x", targets: ["page.size"], transform: { kind: "compute" } as never }])
    ).toThrow(/identity.*choice-map/);
  });
});

describe("validateLocalization", () => {
  function localization(extraLocales: Record<string, unknown> = {}): Record<string, unknown> {
    const document: Record<string, string> = {};
    for (const key of WIKI_PDF_V1_DOCUMENT_LABELS) document[key] = key;
    return {
      defaultLocale: "en",
      fallbackLocale: "en",
      locales: {
        en: { template: { name: "T", description: "D" }, document },
        ...extraLocales,
      },
    };
  }

  it("accepts a complete fallback locale", () => {
    expect(() =>
      validateLocalization(localization(), { requiredDocumentLabels: WIKI_PDF_V1_DOCUMENT_LABELS })
    ).not.toThrow();
  });

  it("rejects an incomplete fallback locale (missing a document label)", () => {
    const value = localization();
    delete (value.locales as Record<string, { document: Record<string, string> }>).en.document.contents;
    expect(() =>
      validateLocalization(value, { requiredDocumentLabels: WIKI_PDF_V1_DOCUMENT_LABELS })
    ).toThrow(/document\.contents/);
  });

  it("accepts a partial non-fallback locale with a warning, never a reject", () => {
    const warnings: string[] = [];
    const value = localization({
      de: { template: { name: "T", description: "D" }, document: { version: "Version" } },
    });
    const result = validateLocalization(value, {
      requiredDocumentLabels: WIKI_PDF_V1_DOCUMENT_LABELS,
      onWarning: (w) => warnings.push(w),
    });
    expect(result.locales.de).toBeDefined();
    expect(warnings.some((w) => w.includes("de") && w.includes("document"))).toBe(true);
  });
});

describe("validateManifest with design/bindings/localization", () => {
  function base(): Record<string, unknown> {
    const document: Record<string, string> = {};
    for (const key of WIKI_PDF_V1_DOCUMENT_LABELS) document[key] = key;
    return {
      schemaVersion: 1,
      id: "builtin.test",
      name: "Test",
      version: "1.0.0",
      engine: { kind: "typst", api: "wiki.pdf-template/v1", entry: "atlcli.typ" },
      design: validDesign(),
      bindings: [{ setting: "accentColor", targets: ["branding.accent"] }],
      localization: {
        defaultLocale: "en",
        fallbackLocale: "en",
        locales: { en: { template: { name: "T", description: "D" }, document } },
      },
    };
  }

  it("validates a full manifest and cross-checks requiredFonts against the inventory", () => {
    const manifest = validateManifest(
      { ...base(), requiredFonts: [{ family: "Source Sans 3", style: "normal", weight: 400 }] },
      { availableFonts: [{ family: "Source Sans 3", style: "normal", weight: 400 }] }
    );
    expect(manifest.design?.branding.accent).toBe("#4B57A3");
    expect(manifest.bindings?.[0].setting).toBe("accentColor");
  });

  it("rejects an unsatisfiable required font when the inventory is supplied", () => {
    expect(() =>
      validateManifest(
        { ...base(), requiredFonts: [{ family: "Nonexistent Sans", style: "normal", weight: 400 }] },
        { availableFonts: [{ family: "Source Sans 3", style: "normal", weight: 400 }] }
      )
    ).toThrow(/not in the bundled font inventory/);
  });

  it("rejects an incomplete fallback locale at manifest import", () => {
    const value = base();
    delete (value.localization as { locales: { en: { document: Record<string, string> } } }).locales.en
      .document.pages;
    expect(() => validateManifest(value)).toThrow(ManifestValidationError);
  });
});

describe("localizeTemplateUi", () => {
  function manifestWith(locales: Record<string, unknown>): Record<string, unknown> {
    const document: Record<string, string> = {};
    for (const key of WIKI_PDF_V1_DOCUMENT_LABELS) document[key] = key;
    return validateManifest({
      schemaVersion: 1,
      id: "builtin.test",
      name: "Fallback Name",
      version: "1.0.0",
      engine: { kind: "typst", api: "wiki.pdf-template/v1", entry: "atlcli.typ" },
      localization: {
        defaultLocale: "en",
        fallbackLocale: "en",
        locales: {
          en: { template: { name: "English", description: "EN desc" }, document },
          ...locales,
        },
      },
    }) as unknown as Record<string, unknown>;
  }

  it("returns the exact locale's copy when present", () => {
    const manifest = manifestWith({ de: { template: { name: "Deutsch", description: "DE" }, document: {} } });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ui = localizeTemplateUi(manifest as any, "de");
    expect(ui.name).toBe("Deutsch");
  });

  it("falls back region → base language → default → fallback", () => {
    const manifest = manifestWith({ de: { template: { name: "Deutsch", description: "DE" }, document: {} } });
    // de-CH has no entry; base language de wins.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(localizeTemplateUi(manifest as any, "de-CH").name).toBe("Deutsch");
    // fr has no entry; falls through to the fallback/default English.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(localizeTemplateUi(manifest as any, "fr").name).toBe("English");
  });
});
