import { describe, expect, it } from "bun:test";
import { BUILTIN_PDF_DESIGN } from "./builtin-template.js";
import {
  PDF_TEMPLATE_LEGACY_FALLBACK_ALIASES_V1,
  materializeLegacyPdfDesign,
  projectPdfDesignV1SubsetFromCatalogV2,
} from "./design-catalog.js";
import { ATLCLI_TYPST_TEMPLATE, createAtlcliTypstTemplate } from "./template.js";
import { createAtlcliTypstTemplateV4 } from "./template-v4.js";

function revision4Design(
  options: { kind?: "standard" | "type-cut"; logo?: "show" | "hide" } = {}
) {
  const design = structuredClone(BUILTIN_PDF_DESIGN);
  const kind = options.kind ?? "type-cut";
  design.compositions = {
    cover: kind === "type-cut"
      ? {
          kind,
          logo: options.logo ?? "hide",
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

function coverSource(source: string): string {
  return source.slice(
    source.indexOf('  if cover-config.at("enabled"'),
    source.indexOf("  set page(fill: white)")
  );
}

describe("atlcli Typst template settings rendering", () => {
  it("keeps the revision-4 standard cover characterized and supports explicit logo hiding", () => {
    const design = revision4Design({ kind: "standard", logo: "show" });
    const characterized = createAtlcliTypstTemplate(
      projectPdfDesignV1SubsetFromCatalogV2(design),
      {},
      undefined,
      { positionedLogo: true }
    );
    expect(createAtlcliTypstTemplateV4(design)).toBe(characterized);

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
