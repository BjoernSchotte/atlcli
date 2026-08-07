/** Canonical revision-4 cover composition renderer. */
import type { WikiPdfTemplateDesignV1 } from "@atlcli/template-pack";
import {
  projectPdfDesignV1SubsetFromCatalogV2,
  projectPdfDesignThroughCatalogV2,
} from "./design-catalog.js";
import { typstString } from "./escape.js";
import { createAtlcliTypstTemplate } from "./template.js";
import type { PdfTemplateVisualsV1 } from "./template-pack.js";

const SYMBOL_FALLBACK_FONTS = ["Noto Sans Symbols2", "Noto Emoji"] as const;
const COVER_START_MARKER = '  if cover-config.at("enabled"';
const COVER_END_MARKER = "  set page(fill: white)";

function finiteTypstNumber(value: number): string {
  if (!Number.isFinite(value)) {
    throw new Error("PDF template composition number must be finite");
  }
  return Object.is(value, -0) ? "0" : String(value);
}

function replaceCover(base: string, cover: string): string {
  const start = base.indexOf(COVER_START_MARKER);
  const end = base.indexOf(COVER_END_MARKER, start);
  if (start < 0 || end < 0) {
    throw new Error("PDF template revision 4 cannot locate the characterized cover");
  }
  return `${base.slice(0, start)}${cover}${base.slice(end)}`;
}

function hideCharacterizedCoverLogo(base: string): string {
  const start = base.indexOf(COVER_START_MARKER);
  const end = base.indexOf(COVER_END_MARKER, start);
  if (start < 0 || end < 0) {
    throw new Error("PDF template revision 4 cannot locate the characterized cover");
  }
  const cover = base.slice(start, end);
  const withoutPositioned = cover.replace(
    /\n    if logo-path != none and logo-placement != none \{[\s\S]*?\n    \}/u,
    ""
  );
  const withoutFlow = withoutPositioned.replace(
    /      #if logo-path != none and logo-placement == none \[[\s\S]*?\n      \]\n/u,
    ""
  );
  if (withoutFlow.includes("logo-path")) {
    throw new Error("PDF template revision 4 could not suppress the characterized cover logo");
  }
  return replaceCover(base, withoutFlow);
}

/**
 * Generate canonical revision 4 without changing the revision-1/2/3 source
 * function. The characterized revision-3 renderer remains the document base;
 * only the selected cover composition is replaced here.
 */
export function createAtlcliTypstTemplateV4(
  design: WikiPdfTemplateDesignV1,
  labels: Record<string, string> = {},
  visuals?: PdfTemplateVisualsV1
): string {
  const catalogDesign = projectPdfDesignThroughCatalogV2(design);
  const composition = catalogDesign.compositions?.cover;
  if (!composition) {
    throw new Error("PDF template revision 4 is missing compositions.cover");
  }

  const base = createAtlcliTypstTemplate(
    projectPdfDesignV1SubsetFromCatalogV2(catalogDesign),
    labels,
    visuals,
    { positionedLogo: true }
  );
  if (composition.kind === "standard") {
    return composition.logo === "show" ? base : hideCharacterizedCoverLogo(base);
  }

  const typeCut = composition.typeCut;
  if (!typeCut) {
    throw new Error("PDF template type-cut cover is missing typeCut configuration");
  }

  const roles = catalogDesign.typography.roles;
  const fonts = catalogDesign.typography.fonts;
  const colors = catalogDesign.tokens.colors;
  const layout = catalogDesign.tokens.layout;
  const ratios = catalogDesign.tokens.ratios;
  const margin = catalogDesign.page.margin;
  const need = <T>(map: Record<string, T>, key: string, kind: string): T => {
    const value = map[key];
    if (value === undefined) throw new Error(`PDF template design is missing ${kind} "${key}"`);
    return value;
  };
  const L = (key: string): string => need(layout, key, "layout length");
  const C = (key: string): string => need(colors, key, "color token");
  const RN = (key: string): number => need(ratios, key, "ratio");
  const role = (key: string) => need(roles, key, "typography role");
  const roleFont = (key: string): string => {
    const font = role(key).font;
    if (font === undefined) throw new Error(`PDF template role "${key}" is missing a font`);
    return fonts[font];
  };
  const roleWeight = (key: string): string => {
    const weight = role(key).weight;
    if (weight === undefined) throw new Error(`PDF template role "${key}" is missing a weight`);
    return weight;
  };
  const roleTracking = (key: string): string => {
    const tracking = role(key).tracking;
    if (tracking === undefined) throw new Error(`PDF template role "${key}" is missing tracking`);
    return tracking;
  };
  const fontStack = (font: string): string =>
    `(${[font, ...SYMBOL_FALLBACK_FONTS].map(typstString).join(", ")})`;
  const angle = finiteTypstNumber(typeCut.angle);
  const stop = finiteTypstNumber(typeCut.stop);
  const coverDefault = catalogDesign.features.cover.enabled ? "true" : "false";
  const coverEyebrow = labels.coverEyebrow ?? "";
  const tiers = ["coverTitle", "coverTitleCompact", "coverTitleMinimum"]
    .map((key, index) => String.raw`    (name: ${typstString(["display", "compact", "minimum"][index]!)}, font: ${fontStack(roleFont(key))}, size: ${role(key).size}, weight: ${typstString(roleWeight(key))})`)
    .join(",\n");

  const positionedLogo = composition.logo === "show"
    ? String.raw`
    if logo-path != none and logo-placement != none {
      let logo-x = if logo-placement.relativeTo == "page" {
        logo-placement.x - ${margin.left}
      } else {
        logo-placement.x
      }
      let logo-y = if logo-placement.relativeTo == "page" {
        logo-placement.y - ${margin.top}
      } else {
        logo-placement.y
      }
      let logo-image = image(
        logo-path,
        width: logo-placement.width,
        height: logo-placement.height,
        fit: logo-placement.fit,
        alt: logo-alt,
      )
      let placed-logo = if logo-placement.rotation == 0 {
        logo-image
      } else {
        rotate(logo-placement.rotation * 1deg, origin: center, logo-image)
      }
      place(top + left, dx: logo-x, dy: logo-y, placed-logo)
    }`
    : "";
  const flowLogo = composition.logo === "show"
    ? String.raw`      #if logo-path != none and logo-placement == none [
        #block(below: ${L("coverLogoBelow")})[#image(logo-path, height: ${L("coverLogoHeight")}, width: ${L("coverLogoWidth")}, fit: "contain", alt: logo-alt)]
      ]
`
    : "";

  const cover = String.raw`  if cover-config.at("enabled", default: ${coverDefault}) {
${positionedLogo}
    let cover-eyebrow-label = labels.at("coverEyebrow", default: ${typstString(coverEyebrow)})
    let type-cut-title-tiers = (
${tiers},
    )
    let type-cut-title-block(tier, frame-width, fill: ink, fixed: false) = block(
      width: frame-width,
      height: if fixed { ${L("coverTitleFrameHeight")} } else { auto },
    )[
      #set text(font: tier.font, size: tier.size, weight: tier.weight, fill: fill)
      #set par(leading: ${L("coverTitleLeading")})
      #meta.title
    ]
    v(${L("coverTopPad")})
    block(width: ${RN("coverBlockWidth")}%)[
      #set text(font: ${fontStack(fonts.heading)})
${flowLogo}      #text(size: ${role("coverEyebrow").size}, weight: ${typstString(roleWeight("coverEyebrow"))}, tracking: ${roleTracking("coverEyebrow")}, fill: indigo, if cover-eyebrow-label == "" { space-label } else { cover-eyebrow-label })
      #v(${L("coverEyebrowGap")})
      #layout(size => {
        let fits(tier) = {
          let bounds = measure(type-cut-title-block(tier, size.width))
          bounds.width <= size.width and bounds.height <= ${L("coverTitleFrameHeight")}
        }
        let selected = type-cut-title-tiers.find(fits)
        assert(
          selected != none,
          message: "TYPE_CUT_TITLE_OVERFLOW: title does not fit coverTitleMinimum in the fixed cover frame",
        )
        // Repeated offsets place the hard boundary at the declared stop while
        // keeping one text object relative to the fixed title frame.
        let title-fill = gradient.linear(
          (rgb("${C("coverTitleInk")}"), 0%),
          (rgb("${C("coverTitleInk")}"), ${stop}%),
          (rgb("${C("coverTitleInverse")}"), ${stop}%),
          (rgb("${C("coverTitleInverse")}"), 100%),
          angle: ${angle}deg,
          relative: "parent",
        )
        type-cut-title-block(selected, size.width, fill: title-fill, fixed: true)
      })
      #v(${L("coverTitleGap")})
      #line(length: ${L("coverRuleLength")}, stroke: ${L("coverRuleStroke")} + indigo)
      #v(${L("coverMetaGap")})
      #grid(
        columns: (${L("coverMetaColLabel")}, 1fr),
        column-gutter: ${L("coverMetaColGutter")},
        row-gutter: ${L("coverMetaRowGutter")},
        text(size: ${role("coverMetaLabel").size}, weight: ${typstString(roleWeight("coverMetaLabel"))}, tracking: ${roleTracking("coverMetaLabel")}, fill: warm-slate, upper(version-label)),
        text(size: ${role("coverMetaValue").size}, fill: ink, meta.version),
        text(size: ${role("coverMetaLabel").size}, weight: ${typstString(roleWeight("coverMetaLabel"))}, tracking: ${roleTracking("coverMetaLabel")}, fill: warm-slate, upper(exported-label)),
        text(size: ${role("coverMetaValue").size}, fill: ink, meta.exported-label),
        text(size: ${role("coverMetaLabel").size}, weight: ${typstString(roleWeight("coverMetaLabel"))}, tracking: ${roleTracking("coverMetaLabel")}, fill: warm-slate, upper(exporter-label)),
        text(size: ${role("coverMetaValue").size}, fill: ink, meta.exporter),
      )
    ]
    pagebreak()
  }
`;
  return replaceCover(base, cover);
}
