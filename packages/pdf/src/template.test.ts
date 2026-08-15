import { describe, expect, it } from "bun:test";
import {
  validatePdfTemplateDesignV3,
  type WikiPdfTemplateDesignV3,
} from "@atlcli/template-pack";
import { BUILTIN_PDF_DESIGN } from "./builtin-template.js";
import {
  PDF_TEMPLATE_LEGACY_FALLBACK_ALIASES_V1,
  materializeLegacyPdfDesign,
  projectPdfDesignV1SubsetFromCatalogV2,
} from "./design-catalog.js";
import { ATLCLI_TYPST_TEMPLATE, createAtlcliTypstTemplate } from "./template.js";
import { createAtlcliTypstTemplateV4 } from "./template-v4.js";
import { createAtlcliTypstTemplateV5 } from "./template-v5.js";
import { BUILTIN_PDF_TEMPLATE_BASELINE_V1 } from "./recipe-baselines.js";

function revision5Design(): WikiPdfTemplateDesignV3 {
  return validatePdfTemplateDesignV3(
    structuredClone(BUILTIN_PDF_TEMPLATE_BASELINE_V1.design),
  );
}

function revision4Design(
  options: {
    kind?: "standard" | "type-cut";
    logo?: "show" | "hide";
    metadataPosition?: "flow" | "bottom";
    closingEnabled?: boolean;
  } = {}
) {
  const design = structuredClone(BUILTIN_PDF_DESIGN);
  const kind = options.kind ?? "type-cut";
  design.features.closingPage.enabled = options.closingEnabled ?? true;
  design.compositions = {
    cover: kind === "type-cut"
      ? {
          kind,
          logo: options.logo ?? "hide",
          ...(options.metadataPosition === undefined
            ? {}
            : { metadataPosition: options.metadataPosition }),
          typeCut: { angle: 43, stop: 58 },
        }
      : { kind, logo: options.logo ?? "show" },
    closingPage: {
      kind: "document-summary",
      logo: "hide",
      website: "hide",
      legalNotice: "hide",
      align: "left",
    },
  };
  if (kind === "type-cut") {
    design.tokens.colors.coverTitleInverse = "#FFFFFF";
    design.tokens.layout.coverTitleFrameHeight = "35mm";
    design.tokens.layout.coverMetaBottomInset = "24mm";
    design.typography.roles.coverTitle = {
      font: "heading",
      size: "44pt",
      weight: "bold",
    };
    design.typography.roles.coverTitleCompact = {
      font: "heading",
      size: "34pt",
      weight: "bold",
    };
    design.typography.roles.coverTitleMinimum = {
      font: "heading",
      size: "24pt",
      weight: "bold",
    };
  }
  return design;
}

function brandLockupDesign(options: {
  logo?: "show" | "hide";
  website?: "show" | "hide";
  legalNotice?: "show" | "hide";
  align?: "left" | "center" | "right";
  legalCopy?: string;
  enabled?: boolean;
} = {}) {
  const design = revision4Design({ closingEnabled: options.enabled ?? true });
  design.compositions!.closingPage = {
    kind: "brand-lockup",
    logo: options.logo ?? "show",
    website: options.website ?? "show",
    legalNotice: options.legalNotice ?? "show",
    align: options.align ?? "left",
  };
  design.branding.websiteLabel = "systems.example";
  design.branding.websiteUrl = "https://systems.example/brief";
  design.branding.legalNotice = options.legalCopy ?? "Example Systems GmbH · Zürich";
  Object.assign(design.tokens.colors, {
    closingPageBackground: "#E75204",
    closingBrandText: "#FFFFFF",
  });
  Object.assign(design.tokens.layout, {
    closingBrandBottomInset: "24mm",
    closingBrandBlockWidth: "90mm",
    closingBrandLogoWidth: "42mm",
    closingBrandLogoHeight: "12mm",
    closingBrandLogoGap: "8mm",
    closingBrandTextGap: "4mm",
  });
  Object.assign(design.typography.roles, {
    closingWebsite: { font: "heading", size: "14pt", weight: "semibold" },
    closingLegal: { font: "heading", size: "9pt", weight: "regular" },
  });
  return design;
}

function coverSource(source: string): string {
  return source.slice(
    source.indexOf('  if cover-config.at("enabled"'),
    source.indexOf("  set page(fill: white)")
  );
}

function closingSource(source: string): string {
  return source.slice(
    source.indexOf("  body\n") + "  body\n".length,
    source.indexOf("\n}\n\n#let callout")
  );
}

describe("atlcli Typst template settings rendering", () => {
  it("renders revision-5 preset geometry and running regions without changing the legacy source", () => {
    const source = createAtlcliTypstTemplateV5(revision5Design());
    expect(source).toContain('paper: "a4"');
    expect(source).toContain("binding: left");
    expect(source).toContain(
      "margin: (top: 23mm, bottom: 20mm, left: 22mm, right: 22mm)",
    );
    expect(source).toContain('numbering: "1"');
    expect(source).toContain('pdf.artifact(kind: "header"');
    expect(source).toContain('pdf.artifact(kind: "footer"');
    expect(createAtlcliTypstTemplate()).toBe(ATLCLI_TYPST_TEMPLATE);
  });

  it("renders custom landscape geometry, logical margins, right binding, bleed, variants, and escaped literals", () => {
    const design = revision5Design();
    design.page = {
      format: { kind: "custom", width: "180mm", height: "240mm" },
      orientation: "landscape",
      binding: "right",
      margin: {
        mode: "logical",
        top: "18mm",
        bottom: "20mm",
        inside: "25mm",
        outside: "15mm",
      },
      bleed: {
        top: "3mm",
        bottom: "3mm",
        inside: "4mm",
        outside: "5mm",
      },
    };
    design.compositions.running.header = {
      enabled: true,
      layout: "split",
      first: { start: { field: "literal", value: "First [page]" }, end: { field: "version" } },
      odd: { start: { field: "chapterTitle" }, end: { field: "spaceKey" } },
      even: { start: { field: "spaceName" }, end: { field: "documentTitle" } },
    };
    design.compositions.running.footer.odd.center = {
      field: "pageNumber",
      numbering: "current-of-total",
    };
    const source = createAtlcliTypstTemplateV5(design);
    expect(source).toContain("width: 240mm");
    expect(source).toContain("height: 180mm");
    expect(source).toContain("binding: right");
    expect(source).toContain(
      "margin: (top: 18mm, bottom: 20mm, inside: 25mm, outside: 15mm)",
    );
    expect(source).toContain(
      "bleed: (top: 3mm, bottom: 3mm, inside: 4mm, outside: 5mm)",
    );
    expect(source).toContain('text("First [page]")');
    expect(source).toContain(
      'let pattern = atlcli-page-numbering.at(here())',
    );
    expect(source).toContain("calc.odd(current-page)");
    expect(source).toContain("let chapters = query(heading.where(level: 1))");
  });

  it("keeps contents, bookmarks, heading numbers, and page-number phases independent", () => {
    const design = revision5Design();
    design.navigation = {
      contents: { enabled: false, depth: 5 },
      bookmarks: { enabled: true, depth: 2, includeHeadingNumbers: true },
      headingNumbers: { enabled: true, preset: "decimal-alpha" },
      pageNumbers: {
        enabled: true,
        preset: "roman-lower",
        start: 3,
        body: { preset: "arabic", start: 1 },
      },
    };
    const source = createAtlcliTypstTemplateV5(design);
    expect(source).toContain('numbering: "i"');
    expect(source).toContain("counter(page).update(3)");
    expect(source).toContain('atlcli-page-numbering.update("1")');
    expect(source).toContain("counter(page).update(1)");
    expect(source).toContain('set heading(numbering: "1.a)", bookmarked: false)');
    expect(source).toContain(
      "show heading.where(level: 2): set heading(bookmarked: true)",
    );
    expect(source).not.toContain(
      "show heading.where(level: 3): set heading(bookmarked: true)",
    );
    expect(source).toContain("if outline-config.at(\"enabled\", default: false)");
  });

  it("maps every bounded heading/page numbering preset and can suppress page labels", () => {
    const headingCases = [
      ["decimal", "1."],
      ["decimal-dot", "1.1."],
      ["decimal-alpha", "1.a)"],
      ["decimal-alpha-roman", "1.a.i."],
    ] as const;
    for (const [preset, pattern] of headingCases) {
      const design = revision5Design();
      design.navigation.headingNumbers = { enabled: true, preset };
      expect(createAtlcliTypstTemplateV5(design)).toContain(
        `set heading(numbering: ${JSON.stringify(pattern)}, bookmarked: false)`,
      );
    }

    for (const [preset, pattern] of [
      ["arabic", "1"],
      ["roman-lower", "i"],
      ["roman-upper", "I"],
    ] as const) {
      const design = revision5Design();
      design.navigation.pageNumbers.preset = preset;
      expect(createAtlcliTypstTemplateV5(design)).toContain(
        `numbering: ${JSON.stringify(pattern)}`,
      );
    }

    const hidden = revision5Design();
    hidden.navigation.pageNumbers.enabled = false;
    const hiddenSource = createAtlcliTypstTemplateV5(hidden);
    expect(hiddenSource).toContain("numbering: none");
    expect(hiddenSource).not.toContain('pdf.artifact(kind: "page-number"');
  });

  it("generates only bounded component set/show rules and token references", () => {
    const design = revision5Design();
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
        banding: "rows",
        borders: "outer",
        bandColor: "codeBackground",
        borderColor: "tableStroke",
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
        backgroundColor: "codeBackground",
      },
    };
    design.navigation.contents = { enabled: true, depth: 2 };
    const source = createAtlcliTypstTemplateV5(design);
    expect(source).toContain("justify: true");
    expect(source).toContain("show par: set text(hyphenate: false)");
    expect(source).toContain("marker-align: horizon");
    expect(source).toContain("number-align: start");
    expect(source).toContain('let pattern = "i."');
    expect(source).toContain("#box(width: 1fr, line(length: 100%");
    expect(source).not.toContain("#it.page()");
    expect(source).toContain("fill: none");
    expect(source).toContain("stroke: 3pt + foreground");
    expect(source).toContain("#if false and icon != none");
  });

  it("binds revision-5 typography roles and inspected variable axes to Typst text parameters", () => {
    const design = revision5Design();
    design.typography.roles.body = {
      ...design.typography.roles.body!,
      style: "italic",
      stretch: "expanded",
      kerning: false,
      ligatures: "none",
      numberType: "old-style",
      numberWidth: "tabular",
    };
    design.typography.fonts.mono = "Noto Emoji";
    design.typography.fontAxes = { mono: { wght: 650 } };
    design.typography.roles.code = {
      ...design.typography.roles.code!,
      font: "mono",
    };
    const source = createAtlcliTypstTemplateV5(design);
    expect(source).toContain('style: "italic"');
    expect(source).toContain("stretch: 125%");
    expect(source).toContain("kerning: false");
    expect(source).toContain("ligatures: false");
    expect(source).toContain('number-type: "old-style"');
    expect(source).toContain('number-width: "tabular"');
    expect(source).toContain("variations: (wght: 650)");
    expect(source).toContain('dir: meta.at("direction", default: ltr)');

    const automatic = revision5Design();
    expect(createAtlcliTypstTemplateV5(automatic)).toContain(
      "show par: set text(hyphenate: auto)",
    );
  });

  it("generates named paints and artifact-only flat shapes from validated revision-5 data", () => {
    const design = revision5Design();
    design.paints = {
      ink: { kind: "solid", color: "ink" },
      hero: {
        kind: "linear",
        angle: 43,
        relativeTo: "parent",
        stops: [
          { at: 0, color: "coverTitleInk" },
          { at: 58, color: "coverTitleInk" },
          { at: 58, color: "paper" },
          { at: 100, color: "paper" },
        ],
      },
    };
    design.decorations = [
      {
        kind: "rect",
        scope: "first",
        layer: "page-background",
        box: { x: "0mm", y: "0mm", width: "210mm", height: "80mm" },
        fill: "hero",
      },
      {
        kind: "line",
        scope: "all",
        layer: "footer",
        from: { x: "0mm", y: "0mm" },
        to: { x: "120mm", y: "0mm" },
        stroke: { paint: "ink", width: "0.5pt" },
      },
    ];
    const source = createAtlcliTypstTemplateV5(design);
    expect(source).toContain("gradient.linear");
    expect(source).toContain('(rgb("#202A44"), 58%)');
    expect(source).toContain('relative: "parent"');
    expect(source.match(/pdf\.artifact\(kind: "other"/gu)).toHaveLength(2);
    expect(source).not.toContain("authorText");
  });

  it("maps the Letter preset to Typst's paper catalog and preserves orientation", () => {
    const design = revision5Design();
    design.page.format = { kind: "preset", name: "letter" };
    design.page.orientation = "landscape";
    const source = createAtlcliTypstTemplateV5(design);
    expect(source).toContain('paper: "us-letter"');
    expect(source).toContain("flipped: true");
  });

  it("preserves neutral revision-4 geometry while making revision-5 binding and numbering explicit", () => {
    const revision4 = createAtlcliTypstTemplateV4(
      revision4Design({ kind: "standard", logo: "hide" }),
    );
    const revision5 = createAtlcliTypstTemplateV5(revision5Design());
    expect(revision4).toContain('page-config.at("size", default: "a4")');
    expect(revision4).toContain(
      'page-config.at("orientation", default: "portrait") == "landscape"',
    );
    for (const source of [revision4, revision5]) {
      expect(source).toContain(
        "margin: (top: 23mm, bottom: 20mm, left: 22mm, right: 22mm)",
      );
    }
    expect(revision4).not.toContain("binding: left");
    expect(revision5).toContain("binding: left");
    expect(revision5).toContain('numbering: "1"');
    expect(revision5).toContain("calc.odd(current-page)");
  });

  it("keeps the revision-4 standard cover characterized and supports explicit logo hiding", () => {
    const design = revision4Design({ kind: "standard", logo: "show" });
    const characterized = createAtlcliTypstTemplate(
      projectPdfDesignV1SubsetFromCatalogV2(design),
      {},
      undefined,
      { positionedLogo: true }
    );
    expect(coverSource(createAtlcliTypstTemplateV4(design))).toBe(
      coverSource(characterized)
    );

    const hidden = coverSource(
      createAtlcliTypstTemplateV4(
        revision4Design({ kind: "standard", logo: "hide" })
      )
    );
    expect(hidden).not.toContain("logo-path");
    expect(hidden).toContain("#meta.title");
  });

  it("emits one fixed-frame Type Cut title with declared geometry and three fitting tiers", () => {
    const source = coverSource(createAtlcliTypstTemplateV4(revision4Design()));
    expect(source.match(/#meta\.title/gu)).toHaveLength(1);
    expect(source).toContain("height: if fixed { 35mm } else { auto }");
    expect(source).toContain('(name: "display"');
    expect(source).toContain('(name: "compact"');
    expect(source).toContain('(name: "minimum"');
    expect(source).toContain('size: 34pt, weight: "bold"');
    expect(source).toContain('size: 24pt, weight: "bold"');
    expect(source).toContain('(rgb("#202A44"), 58%)');
    expect(source).toContain('(rgb("#FFFFFF"), 58%)');
    expect(source).toContain("angle: 43deg");
    expect(source).toContain('relative: "parent"');
    expect(source).toContain("TYPE_CUT_TITLE_OVERFLOW");
    expect(source).not.toContain("logo-path");
  });

  it("anchors the cover rule and metadata grid at the declared bottom inset", () => {
    const source = coverSource(
      createAtlcliTypstTemplateV4(
        revision4Design({ metadataPosition: "bottom" })
      )
    );
    expect(source).toContain("left + bottom");
    expect(source).toContain("dy: -24mm");
    expect(source.match(/#grid\(/gu)).toHaveLength(1);
    expect(source.match(/#line\(/gu)).toHaveLength(1);
    expect(source.indexOf("left + bottom")).toBeGreaterThan(
      source.indexOf("type-cut-title-block(selected")
    );
  });

  it("keeps absent metadataPosition on the historical flow layout", () => {
    const source = coverSource(createAtlcliTypstTemplateV4(revision4Design()));
    expect(source).not.toContain("left + bottom");
    expect(source).toContain("#v(25pt)");
    expect(source.match(/#grid\(/gu)).toHaveLength(1);
  });

  it("uses optional escaped cover eyebrow copy and preserves its space-label fallback", () => {
    const fallback = coverSource(createAtlcliTypstTemplateV4(revision4Design()));
    expect(fallback).toContain(
      'labels.at("coverEyebrow", default: "")'
    );
    expect(fallback).toContain(
      'if cover-eyebrow-label == "" { space-label } else { cover-eyebrow-label }'
    );

    const hostile = 'Executive "Focus" #panic("no")';
    const escaped = coverSource(
      createAtlcliTypstTemplateV4(revision4Design(), { coverEyebrow: hostile })
    );
    expect(escaped).toContain(JSON.stringify(hostile));
    expect(escaped).not.toContain(`default: ${hostile}`);
  });

  it("emits Type Cut logo code only when the composition declares show", () => {
    const shown = coverSource(
      createAtlcliTypstTemplateV4(revision4Design({ logo: "show" }))
    );
    const hidden = coverSource(
      createAtlcliTypstTemplateV4(revision4Design({ logo: "hide" }))
    );
    expect(shown).toContain("logo-path != none and logo-placement != none");
    expect(shown).toContain("logo-path != none and logo-placement == none");
    expect(hidden).not.toContain("logo-path");
  });

  it("guards the characterized document summary and emits no unguarded page break", () => {
    const enabled = closingSource(createAtlcliTypstTemplateV4(revision4Design()));
    expect(enabled).toContain(
      'if closing-config.at("enabled", default: true) {'
    );
    expect(enabled).toContain("set page(fill: cover-paper)");
    expect(enabled).toContain("#end-label");
    expect(enabled.trimStart().startsWith("if closing-config")).toBe(true);

    const disabled = closingSource(
      createAtlcliTypstTemplateV4(revision4Design({ closingEnabled: false }))
    );
    expect(disabled).toContain(
      'if closing-config.at("enabled", default: false) {'
    );
    expect(disabled.trimStart().startsWith("if closing-config")).toBe(true);
  });

  it("controls all brand-lockup items independently without hidden gaps", () => {
    for (let mask = 0; mask < 8; mask += 1) {
      const logo = (mask & 1) === 0 ? "hide" : "show";
      const website = (mask & 2) === 0 ? "hide" : "show";
      const legalNotice = (mask & 4) === 0 ? "hide" : "show";
      const source = closingSource(
        createAtlcliTypstTemplateV4(
          brandLockupDesign({ logo, website, legalNotice })
        )
      );
      expect(source.includes("BRAND_LOCKUP_LOGO_MISSING")).toBe(logo === "show");
      expect(source.includes("https://systems.example/brief")).toBe(
        website === "show"
      );
      expect(source.includes("Example Systems GmbH")).toBe(
        legalNotice === "show"
      );
      expect(source.includes("#v(8mm)")).toBe(
        logo === "show" && (website === "show" || legalNotice === "show")
      );
      expect(source.includes("#v(4mm)")).toBe(
        website === "show" && legalNotice === "show"
      );
    }
  });

  it("emits exact legal copy, escaped data, dedicated colors, and all alignments", () => {
    const legalCopy = 'Handelsregister Zürich "A" #not-code';
    for (const align of ["left", "center", "right"] as const) {
      const source = closingSource(
        createAtlcliTypstTemplateV4(
          brandLockupDesign({ align, legalCopy })
        )
      );
      expect(source).toContain(`      ${align} + bottom,`);
      expect(source).toContain(`align(${align}, block(width: 90mm)`);
      expect(source).toContain('set page(fill: rgb("#E75204"))');
      expect(source).toContain('fill: rgb("#FFFFFF")');
      expect(source).toContain(JSON.stringify(legalCopy));
      expect(source).not.toContain(`© ${legalCopy}`);
      expect(source).not.toContain("meta.title");
      expect(source).not.toContain("cover-paper");
    }
  });

  it("keeps positioned-logo execution behind canonical revision 3", () => {
    const prior = createAtlcliTypstTemplate();
    const current = createAtlcliTypstTemplate(
      undefined,
      {},
      undefined,
      { positionedLogo: true }
    );

    expect(prior).not.toContain('settings.at("logo-placement"');
    expect(prior).toContain("#if logo-path != none [");
    expect(current).toContain('settings.at("logo-placement"');
    expect(current).toContain(
      "logo-path != none and logo-placement != none"
    );
    expect(current).toContain(
      "logo-path != none and logo-placement == none"
    );
    expect(current).toContain(
      "place(top + left, dx: logo-x, dy: logo-y, placed-logo)"
    );
  });
  const template = ATLCLI_TYPST_TEMPLATE;

  it("reads page geometry from the resolved design (spec 012)", () => {
    expect(template).toContain('let page-size = page-config.at("size", default: "a4")');
    expect(template).toContain('if page-size == "letter" { "us-letter" } else { page-size }');
    expect(template).toContain("paper: paper-name");
    expect(template).toContain(
      'flipped: page-config.at("orientation", default: "portrait") == "landscape"'
    );
  });

  it("defines the watermark layer and wires it as the page background", () => {
    expect(template).toContain("#let watermark-layer(wm)");
    expect(template).toContain(
      'background: watermark-layer(settings.at("watermark", default: none))'
    );
    expect(template).not.toContain("template-page-decorations()");
    expect(template).toContain("transparentize(");
    expect(template).toContain("place(center + horizon, rotate(");
  });

  it("wraps the cover and its trailing pagebreak in one guard", () => {
    const guard = template.match(/if cover-config\.at\("enabled", default: true\) \{[\s\S]*?\n {2}\}/)?.[0];
    expect(guard).toBeDefined();
    expect(guard).toContain("pagebreak()");
    expect(guard).toContain("meta.title");
  });

  it("wraps the outline and its trailing pagebreak in one guard", () => {
    const guard = template.match(/if outline-config\.at\("enabled", default: true\) \{[\s\S]*?\n {2}\}/)?.[0];
    expect(guard).toBeDefined();
    expect(guard).toContain('outline(title: contents-label, depth: outline-config.at("depth", default: 3))');
    expect(guard).toContain("show outline.entry: it => context");
    expect(guard).toContain("atlcli-outline-title.at(it.element.location())");
    expect(guard).toContain("#box(width: 1fr, it.fill)");
    expect(guard).toContain("pagebreak()");
  });

  it("keeps rich headings separate from their plain navigation titles", () => {
    expect(template).toContain('#let atlcli-outline-title = state("atlcli-outline-title", none)');
  });

  it("keeps the intervening white page fill unconditional", () => {
    const betweenGuards = template.slice(
      template.indexOf('if cover-config.at("enabled"'),
      template.indexOf('if outline-config.at("enabled"')
    );
    expect(betweenGuards).toContain("set page(fill: white)");
  });

  it("derives the accent color from the resolved design and keeps content reads (spec 012)", () => {
    expect(template).toContain('let indigo = rgb(brand.at("accent", default: "#4B57A3"))');
    expect(template).toContain('settings.at("header-text", default: none)');
    expect(template).toContain('settings.at("footer-text", default: none)');
    expect(template).toContain('brand.at("organization-name", default: none)');
    expect(template).toContain('settings.at("logo", default: none)');
    expect(template).toContain('settings.at("logo-alt", default: "")');
    expect(template).toContain('image(logo-path, height: 12mm, width: 45mm, fit: "contain", alt: logo-alt)');
  });

  it("interpolates static design tokens rather than hardcoding literals (spec 012)", () => {
    // The generated Typst carries the values (interpolated from the manifest);
    // the SOURCE file template.ts carries no bare literal — proven by the
    // hardcoding-ledger lint, not here. These pins prove the interpolation
    // wired the built-in defaults through unchanged.
    expect(template).toContain('font: ("Source Serif 4", "Noto Sans Symbols2", "Noto Emoji")');
    expect(template).toContain('size: 18pt, weight: "semibold"');
    expect(template).toContain('fill: rgb("#172B4D")');
    expect(template).toContain('info: (rgb("#DEEBFF"), rgb("#0747A6"))');
    expect(template).toContain('success: (rgb("#E3FCEF"), rgb("#006644"))');
    expect(template).toContain('error: (rgb("#FFEBE6"), rgb("#BF2600"))');
  });

  it("keeps existing template-v1 manifests compatible when new panel roles are absent", () => {
    const design = structuredClone(BUILTIN_PDF_DESIGN);
    delete design.semanticPalettes.callouts.success;
    delete design.semanticPalettes.callouts.error;
    expect(() => createAtlcliTypstTemplate(design)).toThrow(
      /semanticPalettes\.callouts\.error\.background/
    );
    const legacyTemplate = createAtlcliTypstTemplate(
      materializeLegacyPdfDesign(
        design,
        BUILTIN_PDF_DESIGN,
        PDF_TEMPLATE_LEGACY_FALLBACK_ALIASES_V1
      ).design
    );
    expect(legacyTemplate).toContain('success: (rgb("#E3FCEF"), rgb("#006644"))');
    expect(legacyTemplate).toContain('error: (rgb("#FFFAE6"), rgb("#974F0C"))');
  });

  it("supports portable custom-panel color and icon overrides", () => {
    expect(template).toContain("custom_color.lighten(85%)");
    expect(template).toContain('text(weight: "semibold", fill: foreground, icon)');
  });

  it("styles inline raw separately from block code with the theme background", () => {
    expect(template).toContain("show raw.where(block: false): it => box(");
    expect(template).toContain('fill: rgb("#F4F5F7")');
    expect(template).toContain("inset: (x: 0.2em, y: 0.06em)");
    expect(template).toContain("show raw.where(block: true): it => block(");
  });

  it("contains no unescaped template-literal leftovers", () => {
    expect(template).not.toContain("${");
  });
});
