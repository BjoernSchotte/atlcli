/**
 * Design/bindings/localization schema tests (spec 012 T6.1). Real fixture
 * manifests, boundary values, and typed rejections — no mocks.
 */
import { describe, expect, it } from "bun:test";
import {
  DEFAULT_DESIGN_PAGE_COMPOSITIONS,
  DESIGN_CLOSING_COMPOSITION_KINDS,
  DESIGN_COVER_COMPOSITION_KINDS,
  DESIGN_COVER_METADATA_POSITIONS,
  DESIGN_HORIZONTAL_ALIGNMENTS,
  DESIGN_VISIBILITIES,
  DEFAULT_DESIGN_HEADER_MODE,
  DESIGN_HEADER_MODES,
  validateDesign,
  validatePdfTemplateDesignV3,
  type WikiPdfTemplateDesignV1,
  type WikiPdfTemplateDesignV3,
} from "./design.js";
import { validateBindings } from "./bindings.js";
import {
  validateLocalization,
  WIKI_PDF_SUPPORTED_DOCUMENT_LABELS,
  WIKI_PDF_V1_DOCUMENT_LABELS,
} from "./localization.js";
import {
  validateManifest,
  validateManifestV3,
  ManifestValidationError,
} from "./manifest.js";
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

function validDesignV3(): WikiPdfTemplateDesignV3 {
  const legacy = validDesign();
  return {
    page: {
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
    },
    branding: legacy.branding,
    typography: legacy.typography,
    tokens: legacy.tokens,
    semanticPalettes: legacy.semanticPalettes,
    compositions: {
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
          even: { center: { field: "chapterTitle" } },
        },
        footer: {
          enabled: true,
          layout: "three-column",
          first: "hide",
          odd: {
            start: { field: "literal", value: "Internal" },
            center: { field: "pageNumber", numbering: "current-of-total" },
            end: { field: "organizationName" },
          },
          even: {
            start: { field: "organizationName" },
            center: { field: "pageNumber", numbering: "current" },
            end: { field: "literal", value: "Internal" },
          },
        },
      },
    },
    navigation: {
      contents: { enabled: true, depth: 3, pageNumbers: "show", leader: "dots" },
      bookmarks: { enabled: true, depth: 4, includeHeadingNumbers: true },
      headingNumbers: { enabled: false, preset: "decimal" },
      pageNumbers: { enabled: true, preset: "arabic", start: 1 },
    },
    components: {
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
    },
  };
}

describe("validatePdfTemplateDesignV3", () => {
  it("accepts preset and custom page formats, both bindings, both margin modes, and bounded bleed", () => {
    const preset = validDesignV3();
    expect(validatePdfTemplateDesignV3(preset)).toEqual(preset);

    const custom = validDesignV3();
    custom.page = {
      format: { kind: "custom", width: "210mm", height: "297mm" },
      orientation: "landscape",
      binding: "right",
      margin: {
        mode: "logical",
        top: "20mm",
        bottom: "20mm",
        inside: "25mm",
        outside: "15mm",
      },
      bleed: {
        top: "3mm",
        bottom: "3mm",
        inside: "0pt",
        outside: "5mm",
      },
    };
    expect(validatePdfTemplateDesignV3(custom).page).toEqual(custom.page);
  });

  it("dispatches V3 designs through the portable manifest import gate", () => {
    const manifest = validateManifestV3({
      schemaVersion: 1,
      id: "builtin.catalog-v3-test",
      name: "Catalog V3 test",
      version: "1.0.0",
      engine: {
        kind: "typst",
        api: "wiki.pdf-template/v1",
        entry: "atlcli.typ",
        compilerRange: ">=0.15.1 <0.16",
      },
      design: validDesignV3(),
    });
    expect(manifest.design).toBeDefined();
    expect("format" in manifest.design!.page).toBe(true);
  });

  it("rejects malformed page-format unions and unsupported page units", () => {
    for (const format of [
      { kind: "custom", width: "210mm" },
      { kind: "preset", name: "a4", width: "210mm", height: "297mm" },
      { kind: "custom", width: "8.5in", height: "11in" },
    ]) {
      const design = validDesignV3() as unknown as Record<string, unknown>;
      (design.page as Record<string, unknown>).format = format;
      expect(() => validatePdfTemplateDesignV3(design)).toThrow(
        ManifestValidationError,
      );
    }
  });

  it("rejects mixed margin modes and margins that consume the page body", () => {
    const mixed = validDesignV3() as unknown as Record<string, unknown>;
    (mixed.page as Record<string, unknown>).margin = {
      mode: "logical",
      top: "20mm",
      bottom: "20mm",
      inside: "20mm",
      outside: "20mm",
      left: "20mm",
    };
    expect(() => validatePdfTemplateDesignV3(mixed)).toThrow(/not recognized/);

    const consumed = validDesignV3();
    consumed.page.margin = {
      mode: "physical",
      top: "149mm",
      bottom: "149mm",
      left: "20mm",
      right: "20mm",
    };
    expect(() => validatePdfTemplateDesignV3(consumed)).toThrow(
      /positive page body area/,
    );
  });

  it("rejects out-of-bounds bleed and layout-slot mismatches", () => {
    const bleed = validDesignV3();
    bleed.page.bleed = {
      top: "51mm",
      bottom: "0mm",
      inside: "0mm",
      outside: "0mm",
    };
    expect(() => validatePdfTemplateDesignV3(bleed)).toThrow(/50mm/);

    const single = validDesignV3() as unknown as Record<string, unknown>;
    const compositions = single.compositions as Record<string, unknown>;
    const running = compositions.running as Record<string, unknown>;
    const header = running.header as Record<string, unknown>;
    header.odd = { start: { field: "documentTitle" } };
    expect(() => validatePdfTemplateDesignV3(single)).toThrow(
      /not recognized|center/,
    );
  });

  it("requires literal values, restricts numbering, and bounds literal text", () => {
    const missingLiteral = validDesignV3() as unknown as Record<string, unknown>;
    const compositions = missingLiteral.compositions as Record<string, unknown>;
    const running = compositions.running as Record<string, unknown>;
    const footer = running.footer as Record<string, unknown>;
    const odd = footer.odd as Record<string, unknown>;
    odd.start = { field: "literal" };
    expect(() => validatePdfTemplateDesignV3(missingLiteral)).toThrow(
      /required for field "literal"/,
    );

    const badNumbering = validDesignV3() as unknown as Record<string, unknown>;
    const badCompositions = badNumbering.compositions as Record<string, unknown>;
    const badRunning = badCompositions.running as Record<string, unknown>;
    const badFooter = badRunning.footer as Record<string, unknown>;
    const badOdd = badFooter.odd as Record<string, unknown>;
    badOdd.start = { field: "documentTitle", numbering: "current" };
    expect(() => validatePdfTemplateDesignV3(badNumbering)).toThrow(
      /not valid for field "documentTitle"/,
    );

    const hostile = validDesignV3();
    const footerRegion = hostile.compositions.running.footer;
    if (footerRegion.odd.start && footerRegion.odd.start.field === "literal") {
      footerRegion.odd.start.value = "#panic";
    }
    expect(() => validatePdfTemplateDesignV3(hostile)).toThrow(/metacharacters/);
  });

  it("validates independent navigation policies and a bounded body page-number reset", () => {
    const design = validDesignV3();
    design.navigation = {
      contents: { enabled: false, depth: 1 },
      bookmarks: { enabled: true, depth: 6, includeHeadingNumbers: true },
      headingNumbers: {
        enabled: true,
        preset: "decimal-alpha-roman",
      },
      pageNumbers: {
        enabled: true,
        preset: "roman-lower",
        start: 3,
        body: { preset: "arabic", start: 1 },
      },
    };
    expect(validatePdfTemplateDesignV3(design).navigation).toEqual(
      design.navigation,
    );

    for (const depth of [0, 7, 1.5]) {
      const invalid = validDesignV3();
      invalid.navigation.contents.depth = depth;
      expect(() => validatePdfTemplateDesignV3(invalid)).toThrow(
        /within \[1, 6\]|integer/,
      );
    }

    const invalidStart = validDesignV3();
    invalidStart.navigation.pageNumbers.start = 0;
    expect(() => validatePdfTemplateDesignV3(invalidStart)).toThrow(
      /within \[1, 99999\]/,
    );

    const unsupportedBookmarkTitle = validDesignV3();
    unsupportedBookmarkTitle.navigation.headingNumbers.enabled = true;
    unsupportedBookmarkTitle.navigation.bookmarks.includeHeadingNumbers = false;
    expect(() => validatePdfTemplateDesignV3(unsupportedBookmarkTitle)).toThrow(
      /must be true while viewer bookmarks and native heading numbering/,
    );
  });

  it("accepts every bounded component preset and resolves only existing color tokens", () => {
    const design = validDesignV3();
    design.components = {
      paragraph: { align: "justify", hyphenation: "off" },
      list: {
        bulletPreset: "compact",
        markerAlign: "horizon",
        markerColor: "accent",
      },
      enumeration: {
        numberingPreset: "roman-lower",
        markerAlign: "start",
        markerColor: "ink",
      },
      table: {
        repeatHeader: false,
        banding: "columns",
        borders: "horizontal",
        bandColor: "ink",
        borderColor: "accent",
      },
      outline: {
        leader: "line",
        pageNumbers: "hide",
        leaderColor: "accent",
      },
      callout: { preset: "outline", icon: "hide", accentColor: "accent" },
      codeBlock: {
        wrap: "none",
        lineNumbers: "show",
        backgroundColor: "ink",
      },
    };
    expect(validatePdfTemplateDesignV3(design).components).toEqual(
      design.components,
    );

    const unknownToken = validDesignV3();
    unknownToken.components.table.bandColor = "missing";
    expect(() => validatePdfTemplateDesignV3(unknownToken)).toThrow(
      /existing design\.tokens\.colors entry/,
    );

    const arbitraryMarker = validDesignV3() as unknown as Record<string, unknown>;
    const components = arbitraryMarker.components as Record<string, unknown>;
    components.list = {
      bulletPreset: "#panic()",
      markerAlign: "end",
    };
    expect(() => validatePdfTemplateDesignV3(arbitraryMarker)).toThrow(
      /disc-circle-square/,
    );
  });

  it("validates every named paint and flat decorative shape", () => {
    const design = validDesignV3();
    design.paints = {
      ink: { kind: "solid", color: "ink" },
      linear: {
        kind: "linear",
        angle: 43,
        relativeTo: "parent",
        stops: [
          { at: 0, color: "ink" },
          { at: 58, color: "accent" },
          { at: 58, color: "ink" },
          { at: 100, color: "accent" },
        ],
      },
      radial: {
        kind: "radial",
        center: { x: 40, y: 60 },
        radius: 75,
        relativeTo: "self",
        stops: [
          { at: 0, color: "accent" },
          { at: 100, color: "ink" },
        ],
      },
      conic: {
        kind: "conic",
        angle: -90,
        center: { x: 50, y: 50 },
        relativeTo: "parent",
        stops: [
          { at: 0, color: "accent" },
          { at: 100, color: "ink" },
        ],
      },
    };
    design.decorations = [
      {
        kind: "rect",
        scope: "first",
        layer: "page-background",
        box: { x: "0mm", y: "0mm", width: "210mm", height: "80mm" },
        fill: "linear",
        radius: "2mm",
      },
      {
        kind: "line",
        scope: "odd",
        layer: "header",
        from: { x: "0mm", y: "2mm" },
        to: { x: "120mm", y: "2mm" },
        stroke: { paint: "ink", width: "0.5pt" },
      },
      {
        kind: "circle",
        scope: "even",
        layer: "footer",
        center: { x: "10mm", y: "10mm" },
        radius: "4mm",
        fill: "radial",
        stroke: { paint: "conic", width: "0.25pt" },
        rotation: 15,
      },
    ];
    const validated = validatePdfTemplateDesignV3(design);
    expect(validated.paints).toEqual(design.paints);
    expect(validated.decorations).toEqual(design.decorations);
  });

  it("rejects unsafe paint stops, missing paint references, and unbounded shapes", () => {
    const descending = validDesignV3();
    descending.paints = {
      hero: {
        kind: "linear",
        angle: 0,
        relativeTo: "parent",
        stops: [
          { at: 70, color: "ink" },
          { at: 20, color: "accent" },
        ],
      },
    };
    expect(() => validatePdfTemplateDesignV3(descending)).toThrow(/sorted/);

    const missingToken = validDesignV3();
    missingToken.paints = { ink: { kind: "solid", color: "missing" } };
    expect(() => validatePdfTemplateDesignV3(missingToken)).toThrow(
      /existing design\.tokens\.colors entry/,
    );

    const missingPaint = validDesignV3();
    missingPaint.decorations = [
      {
        kind: "rect",
        scope: "all",
        layer: "page-background",
        box: { x: "0mm", y: "0mm", width: "10mm", height: "10mm" },
        fill: "missing",
      },
    ];
    expect(() => validatePdfTemplateDesignV3(missingPaint)).toThrow(
      /missing paint/,
    );

    const oversized = validDesignV3();
    oversized.paints = { ink: { kind: "solid", color: "ink" } };
    oversized.decorations = [
      {
        kind: "circle",
        scope: "all",
        layer: "page-background",
        center: { x: "0mm", y: "0mm" },
        radius: "1001mm",
        fill: "ink",
      },
    ];
    expect(() => validatePdfTemplateDesignV3(oversized)).toThrow(/1000mm/);

    const noAppearance = validDesignV3() as unknown as Record<string, unknown>;
    noAppearance.decorations = [
      {
        kind: "rect",
        scope: "all",
        layer: "page-background",
        box: { x: "0mm", y: "0mm", width: "10mm", height: "10mm" },
      },
    ];
    expect(() => validatePdfTemplateDesignV3(noAppearance)).toThrow(
      /fill or stroke/,
    );
  });
});

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

  it("accepts every declared running-head mode", () => {
    for (const mode of DESIGN_HEADER_MODES) {
      const design = validDesign();
      design.features.header.mode = mode;
      expect(validateDesign(design).features.header.mode).toBe(mode);
    }
  });

  it("treats an absent running-head mode as optional (back-compatible manifests)", () => {
    const design = validDesign();
    expect(design.features.header.mode).toBeUndefined();
    // No coercion: an absent optional stays absent, exactly like
    // `branding.organizationName`. Consumers resolve it with the default.
    expect(validateDesign(design).features.header.mode).toBeUndefined();
    expect(DEFAULT_DESIGN_HEADER_MODE).toBe("title");
  });

  it("rejects an unknown running-head mode", () => {
    const design = validDesign();
    (design.features.header as { mode: string }).mode = "kolumnentitel";
    expect(() => validateDesign(design)).toThrow(ManifestValidationError);
    expect(() => validateDesign(design)).toThrow(/features\.header\.mode/);
    expect(() => validateDesign(design)).toThrow(/"title", "chapter", "custom"/);
  });

  it("rejects a non-string running-head mode", () => {
    for (const bad of [1, true, null, {}, ["chapter"]]) {
      const design = validDesign();
      (design.features.header as { mode: unknown }).mode = bad;
      expect(() => validateDesign(design)).toThrow(ManifestValidationError);
    }
  });

  it("accepts boundary lengths, colors, and ratios", () => {
    const design = validDesign();
    design.tokens.layout.leading = "0pt";
    design.tokens.ratios.coverWidth = 0;
    design.tokens.contrast.minimum = 21;
    (design.tokens.colors as Record<string, string>).ink = "#000000";
    expect(() => validateDesign(design)).not.toThrow();
  });

  it("exposes immutable back-compatible composition defaults", () => {
    expect(DEFAULT_DESIGN_PAGE_COMPOSITIONS.cover).toEqual({
      kind: "standard",
      logo: "show",
    });
    expect(DEFAULT_DESIGN_PAGE_COMPOSITIONS.closingPage).toEqual({
      kind: "document-summary",
      logo: "hide",
      website: "hide",
      legalNotice: "hide",
      align: "left",
    });
    expect(DESIGN_COVER_COMPOSITION_KINDS).toEqual(["standard", "type-cut"]);
    expect(DESIGN_COVER_METADATA_POSITIONS).toEqual(["flow", "bottom"]);
    expect(DESIGN_CLOSING_COMPOSITION_KINDS).toEqual([
      "document-summary",
      "brand-lockup",
    ]);
    expect(DESIGN_VISIBILITIES).toEqual(["show", "hide"]);
    expect(DESIGN_HORIZONTAL_ALIGNMENTS).toEqual(["left", "center", "right"]);
  });

  it("accepts Type Cut and declarative brand-lockup copy including Unicode", () => {
    const design = validDesign();
    design.compositions = {
      cover: {
        kind: "type-cut",
        logo: "hide",
        metadataPosition: "bottom",
        typeCut: { angle: -180, stop: 100 },
      },
      closingPage: {
        kind: "brand-lockup",
        logo: "show",
        website: "show",
        legalNotice: "show",
        align: "right",
      },
    };
    design.branding.websiteLabel = "example.invalid";
    design.branding.websiteUrl = "https://example.invalid/path?from=pdf";
    design.branding.legalNotice = "© Example Systems GmbH · Zürich";
    const validated = validateDesign(design);
    expect(validated.compositions?.cover.typeCut).toEqual({ angle: -180, stop: 100 });
    expect(validated.compositions?.cover.metadataPosition).toBe("bottom");
    expect(validated.branding.legalNotice).toBe("© Example Systems GmbH · Zürich");
  });

  it("rejects invalid Type Cut bounds, non-finite values, dead data, and unknown keys", () => {
    for (const typeCut of [
      { angle: -181, stop: 50 },
      { angle: 181, stop: 50 },
      { angle: 43, stop: -1 },
      { angle: 43, stop: 101 },
      { angle: Number.NaN, stop: 50 },
      { angle: 43, stop: Number.POSITIVE_INFINITY },
    ]) {
      const design = validDesign();
      design.compositions = {
        cover: { kind: "type-cut", logo: "hide", typeCut },
        closingPage: DEFAULT_DESIGN_PAGE_COMPOSITIONS.closingPage,
      };
      expect(() => validateDesign(design)).toThrow(ManifestValidationError);
    }
    const standard = validDesign() as unknown as Record<string, unknown>;
    standard.compositions = {
      cover: { kind: "standard", logo: "show", typeCut: { angle: 43, stop: 58 } },
      closingPage: DEFAULT_DESIGN_PAGE_COMPOSITIONS.closingPage,
    };
    expect(() => validateDesign(standard)).toThrow(/typeCut/);

    const bottomStandard = validDesign() as unknown as Record<string, unknown>;
    bottomStandard.compositions = {
      cover: { kind: "standard", logo: "show", metadataPosition: "bottom" },
      closingPage: DEFAULT_DESIGN_PAGE_COMPOSITIONS.closingPage,
    };
    expect(() => validateDesign(bottomStandard)).toThrow(/metadataPosition/);

    const invalidPosition = validDesign() as unknown as Record<string, unknown>;
    invalidPosition.compositions = {
      cover: {
        kind: "type-cut",
        logo: "hide",
        metadataPosition: "footer",
        typeCut: { angle: 43, stop: 58 },
      },
      closingPage: DEFAULT_DESIGN_PAGE_COMPOSITIONS.closingPage,
    };
    expect(() => validateDesign(invalidPosition)).toThrow(/"flow", "bottom"/);

    const unknown = validDesign() as unknown as Record<string, unknown>;
    unknown.compositions = {
      cover: { kind: "standard", logo: "show", opacity: 0.5 },
      closingPage: DEFAULT_DESIGN_PAGE_COMPOSITIONS.closingPage,
    };
    expect(() => validateDesign(unknown)).toThrow(/opacity.*not recognized/);
  });

  it("rejects brand-lockup visibility without declarative website or legal copy", () => {
    const design = validDesign();
    design.compositions = {
      cover: { kind: "standard", logo: "show" },
      closingPage: {
        kind: "brand-lockup",
        logo: "hide",
        website: "show",
        legalNotice: "hide",
        align: "left",
      },
    };
    expect(() => validateDesign(design)).toThrow(/branding\.websiteLabel/);
    design.branding.websiteLabel = "example.invalid";
    expect(() => validateDesign(design)).toThrow(/branding\.websiteUrl/);
    design.branding.websiteUrl = "https://example.invalid";
    design.compositions.closingPage.website = "hide";
    design.compositions.closingPage.legalNotice = "show";
    expect(() => validateDesign(design)).toThrow(/branding\.legalNotice/);
  });

  it("rejects brand-lockup-only visibility on document-summary", () => {
    for (const field of ["logo", "website", "legalNotice"] as const) {
      const design = validDesign();
      design.compositions = {
        cover: { kind: "standard", logo: "show" },
        closingPage: {
          ...DEFAULT_DESIGN_PAGE_COMPOSITIONS.closingPage,
          [field]: "show",
        },
      };
      expect(() => validateDesign(design)).toThrow(/document-summary must hide/);
    }
  });

  it("accepts only absolute HTTPS website URLs without credentials or fragments", () => {
    for (const bad of [
      "http://example.invalid",
      "//example.invalid",
      "/relative",
      "https://user:secret@example.invalid",
      "https://example.invalid/#fragment",
      "not a url",
    ]) {
      const design = validDesign();
      design.branding.websiteUrl = bad;
      expect(() => validateDesign(design)).toThrow(/HTTPS|credentials|fragment/);
    }
  });

  it("bounds safe literal strings by Unicode code points and rejects DEL", () => {
    const exact = validDesign();
    exact.branding.legalNotice = "🚀".repeat(200);
    expect(validateDesign(exact).branding.legalNotice).toBe("🚀".repeat(200));
    const over = validDesign();
    over.branding.legalNotice = "🚀".repeat(201);
    expect(() => validateDesign(over)).toThrow(/200 Unicode code points/);
    const control = validDesign();
    control.branding.legalNotice = "Example\u007fSystems";
    expect(() => validateDesign(control)).toThrow(/metacharacters/);
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

  it("supports coverEyebrow without requiring it or warning that it is ignored", () => {
    const warnings: string[] = [];
    const value = localization();
    const document = (
      value.locales as Record<string, { document: Record<string, string> }>
    ).en.document;
    document.coverEyebrow = "EXECUTIVE BRIEFING";
    const result = validateLocalization(value, {
      requiredDocumentLabels: WIKI_PDF_V1_DOCUMENT_LABELS,
      supportedDocumentLabels: WIKI_PDF_SUPPORTED_DOCUMENT_LABELS,
      onWarning: (warning) => warnings.push(warning),
    });
    expect(result.locales.en?.document?.coverEyebrow).toBe("EXECUTIVE BRIEFING");
    expect(warnings.some((warning) => warning.includes("coverEyebrow"))).toBe(false);

    delete document.coverEyebrow;
    expect(() =>
      validateLocalization(value, {
        requiredDocumentLabels: WIKI_PDF_V1_DOCUMENT_LABELS,
        supportedDocumentLabels: WIKI_PDF_SUPPORTED_DOCUMENT_LABELS,
      })
    ).not.toThrow();
  });
});

describe("localization injection hardening (spec 012 security regression)", () => {
  function withDocument(document: Record<string, string>): Record<string, unknown> {
    return {
      defaultLocale: "en",
      fallbackLocale: "en",
      locales: { en: { template: { name: "T", description: "D" }, document } },
    };
  }
  function completeDocument(): Record<string, string> {
    const document: Record<string, string> = {};
    for (const key of WIKI_PDF_V1_DOCUMENT_LABELS) document[key] = key;
    return document;
  }

  // A document-label KEY is interpolated into generated Typst source as a
  // dictionary key (unquoted), so an unvalidated key escapes the key position
  // and is evaluated as code. Proven end-to-end before this gate existed:
  // `x: panic("INJECTED-CODE-RAN"), y` made the real compiler panic.
  const HOSTILE_KEYS = [
    'x: panic("INJECTED-CODE-RAN"), y',
    "#let evil = 1",
    "a`b",
    "$x$",
    "with space",
    "kebab-case",
  ];

  for (const key of HOSTILE_KEYS) {
    it(`rejects the hostile document-label key ${JSON.stringify(key)}`, () => {
      const document = completeDocument();
      document[key] = "boom";
      expect(() =>
        validateLocalization(withDocument(document), {
          requiredDocumentLabels: WIKI_PDF_V1_DOCUMENT_LABELS,
        })
      ).toThrow(/key must be a safe identifier/);
    });
  }

  it("rejects a hostile document-label VALUE (it reaches Typst source too)", () => {
    const document = completeDocument();
    document.contents = 'X" #{sys.exit()}';
    expect(() =>
      validateLocalization(withDocument(document), {
        requiredDocumentLabels: WIKI_PDF_V1_DOCUMENT_LABELS,
      })
    ).toThrow(/metacharacters/);
  });

  it("rejects a hostile key at the full manifest import gate", () => {
    const document = completeDocument();
    document['x: panic("pwned"), y'] = "boom";
    expect(() =>
      validateManifest({
        schemaVersion: 1,
        id: "builtin.evil",
        name: "Evil",
        version: "1.0.0",
        engine: { kind: "typst", api: "wiki.pdf-template/v1", entry: "atlcli.typ" },
        localization: withDocument(document),
      })
    ).toThrow(/key must be a safe identifier/);
  });

  it("warns about an unknown-but-safe document label instead of rejecting or silently dropping it", () => {
    // Forward compatibility: a manifest written for a NEWER engine may carry
    // labels this build does not know. It must still import (not rejected), the
    // resolver drops it at render time (see settings.test.ts), and the author
    // must be told by name (not silently swallowed).
    const warnings: string[] = [];
    const document = completeDocument();
    document.futureEngineLabel = "Appendix";
    const result = validateLocalization(withDocument(document), {
      requiredDocumentLabels: WIKI_PDF_V1_DOCUMENT_LABELS,
      onWarning: (w) => warnings.push(w),
    });
    // Not rejected: the manifest imports and keeps the key in its bundle.
    expect(result.locales.en!.document!.futureEngineLabel).toBe("Appendix");
    // Not silent: the warning names the offending key and its fate.
    const warning = warnings.find((w) => w.includes("futureEngineLabel"));
    expect(warning).toBeDefined();
    expect(warning).toContain("unknown document label");
    expect(warning).toContain("ignored at render time");
    // Known labels never warn.
    expect(warnings.some((w) => w.includes("contents"))).toBe(false);
  });

  it("still accepts legitimate UI copy containing punctuation (host-side only)", () => {
    const value = withDocument(completeDocument()) as {
      locales: { en: Record<string, unknown> };
    };
    value.locales.en.settingGroups = { branding: 'Branding & "identity"' };
    expect(() =>
      validateLocalization(value, { requiredDocumentLabels: WIKI_PDF_V1_DOCUMENT_LABELS })
    ).not.toThrow();
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

  it("preserves composition, branding, and optional eyebrow data at manifest import", () => {
    const value = base();
    const design = value.design as WikiPdfTemplateDesignV1;
    design.branding.websiteLabel = "example.invalid";
    design.branding.websiteUrl = "https://example.invalid";
    design.branding.legalNotice = "© Example Systems GmbH";
    design.compositions = {
      cover: { kind: "type-cut", logo: "hide", typeCut: { angle: 43, stop: 58 } },
      closingPage: {
        kind: "brand-lockup",
        logo: "show",
        website: "show",
        legalNotice: "show",
        align: "center",
      },
    };
    const document = (
      value.localization as { locales: { en: { document: Record<string, string> } } }
    ).locales.en.document;
    document.coverEyebrow = "EXECUTIVE BRIEFING";
    const warnings: string[] = [];
    const manifest = validateManifest(value, {
      collectWarnings: (warning) => warnings.push(warning),
    });
    expect(manifest.design?.compositions?.cover.kind).toBe("type-cut");
    expect(manifest.design?.branding.legalNotice).toBe("© Example Systems GmbH");
    expect(manifest.localization?.locales.en?.document?.coverEyebrow).toBe(
      "EXECUTIVE BRIEFING"
    );
    expect(warnings.some((warning) => warning.includes("coverEyebrow"))).toBe(false);
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
