/**
 * Curated built-in PDF templates registry (spec 012 T6.5).
 *
 * Two built-in templates ship through the identical `wiki.pdf-template/v1`
 * engine (`template.ts` + the resolver). "Manuscript" is NOT a fork of the
 * engine — it is a different, fully validated manifest with a distinct design:
 * a serif-display/sans-body pairing (the inverse of Editorial Indigo), a deep
 * green accent, wider book-like margins, a larger type scale and rhythm, a
 * warmer callout palette, different cover geometry, and a chapter running head
 * (`features.header.mode: "chapter"`). Proving it renders with zero new engine
 * code is the whole point of the 012 migration.
 */

import {
  validateManifest,
  type TemplateManifest,
  type WikiPdfTemplateDesignV1,
} from "@atlcli/template-pack";
import {
  BUILTIN_PDF_TEMPLATE_ID,
  BUILTIN_PDF_TEMPLATE_MANIFEST,
} from "./builtin-template.js";
import { PDF_RUNTIME_ASSETS } from "./runtime-assets.js";

export const MANUSCRIPT_PDF_TEMPLATE_ID = "builtin.manuscript";

const MANUSCRIPT_DESIGN: WikiPdfTemplateDesignV1 = {
  page: {
    size: "a4",
    orientation: "portrait",
    // Wider, book-like page master — a different page geometry from the built-in.
    margin: { top: "28mm", bottom: "24mm", left: "27mm", right: "27mm" },
  },
  features: {
    cover: { enabled: true },
    outline: { enabled: true, depth: 3 },
    // The one design decision Manuscript makes that Editorial Indigo does not:
    // a chapter running head. A book-like template repeating the document title
    // on every page carries no information; the level-1 heading that owns the
    // page does. Manuscript has no pinned parity digest, so its output changing
    // here is intended (proven by the chapter-running-head tests). The built-in
    // stays on the default "title" mode, which is what keeps its digest fixed.
    header: { enabled: true, mode: "chapter" },
    footer: { enabled: true },
    closingPage: { enabled: true },
  },
  branding: {
    accent: "#0B6E4F",
  },
  typography: {
    fonts: {
      // Inverted pairing: serif display, sans body (Editorial Indigo is the reverse).
      body: "Source Sans 3",
      heading: "Source Serif 4",
      mono: "Source Code Pro",
    },
    roles: {
      body: { font: "body", size: "10.5pt" },
      adfSmallText: { font: "body", size: "9pt" },
      h1: { font: "heading", size: "22pt", weight: "bold" },
      h2: { font: "heading", size: "16pt", weight: "semibold" },
      h3: { font: "heading", size: "12.5pt", weight: "semibold" },
      code: { font: "mono", size: "8.5pt" },
      tableCell: { font: "body", size: "9pt" },
      numbering: { font: "body", size: "0.95em", weight: "semibold" },
      runningHead: { font: "body", size: "8pt" },
      coverEyebrow: { font: "body", size: "8.5pt", weight: "semibold", tracking: "0.24em" },
      coverTitle: { font: "heading", size: "38pt", weight: "bold" },
      coverMetaLabel: { font: "body", size: "7.5pt", weight: "semibold", tracking: "0.1em" },
      coverMetaValue: { font: "body", size: "9.5pt" },
      closingEyebrow: { font: "body", size: "8.5pt", weight: "semibold", tracking: "0.24em" },
      closingTitle: { font: "heading", size: "28pt", weight: "bold" },
      closingMetaLabel: { font: "body", size: "7.5pt", weight: "semibold", tracking: "0.1em" },
      closingMetaValue: { font: "body", size: "9.5pt" },
      colophon: { font: "body", size: "8.5pt" },
      statusBadge: { font: "mono", size: "7.5pt", weight: "bold" },
      taskMarker: { font: "body", size: "8.5pt", weight: "semibold" },
    },
  },
  tokens: {
    colors: {
      accent: "#0B6E4F",
      ink: "#1B2733",
      paper: "#FBF9F4",
      coverTitleInk: "#101820",
      warmSlate: "#6B6459",
      muted: "#7A8494",
      hairline: "#D8DCE3",
      heading3: "#2C3A4B",
      codeBackground: "#F2F0EB",
      neutral: "#48505B",
      taskChecked: "#0B6E4F",
      taskUnchecked: "#7A8494",
      mention: "#0B6E4F",
      placeholder: "#9AA1AC",
      tableStroke: "#D8DCE3",
      tableHeaderBackground: "#F2F0EB",
      // Explicit compatibility values: these capabilities were historically
      // read through Editorial Indigo fallbacks. Keeping their characterized
      // values here makes Manuscript complete without changing its output.
      smartCardInlineBackground: "#E9F2FF",
      smartCardBlockBackground: "#F4F5F7",
      smartCardBlockStroke: "#B3BAC5",
      mediaGroupBackground: "#F7F8F9",
      watermark: "#B23B3B",
    },
    layout: {
      // Looser vertical rhythm and larger heading gaps than the built-in.
      paragraphLeading: "0.8em",
      paragraphSpacing: "11pt",
      adfBlockIndentStep: "1.5em",
      listBodyIndent: "0.8em",
      listSpacing: "9pt",
      enumBodyIndent: "0.8em",
      enumSpacing: "9pt",
      h1Above: "34pt",
      h1Below: "16pt",
      h2Above: "28pt",
      h2Below: "13pt",
      h3Above: "20pt",
      h3Below: "9pt",
      inlineCodeInsetX: "0.2em",
      inlineCodeInsetY: "0.06em",
      inlineCodeRadius: "2pt",
      codeInset: "10pt",
      codeRadius: "5pt",
      codeTitleBelow: "0pt",
      calloutStroke: "3pt",
      calloutInsetX: "13pt",
      calloutInsetY: "10pt",
      calloutRadius: "5pt",
      calloutAbove: "7pt",
      calloutBelow: "9pt",
      calloutIconGap: "0.55em",
      smartCardInlineInsetX: "3pt",
      smartCardInlineInsetY: "1pt",
      smartCardInlineRadius: "2pt",
      smartCardBlockInset: "8pt",
      smartCardBlockRadius: "3pt",
      inlineMediaBaseline: "0pt",
      inlineMediaInset: "0pt",
      inlineMediaChipInsetX: "3pt",
      inlineMediaChipInsetY: "1pt",
      inlineMediaChipRadius: "2pt",
      mediaWrapColumnGutter: "8pt",
      mediaFrameInset: "3pt",
      mediaFrameDefaultStroke: "0.5pt",
      statusBadgeInsetX: "5pt",
      statusBadgeInsetY: "2pt",
      statusBadgeRadius: "3pt",
      denseBadgeCompactInsetX: "2pt",
      denseBadgeInsetX: "1pt",
      denseBadgeInsetY: "2pt",
      denseBadgeRadius: "3pt",
      denseBadgeLeading: "0.72em",
      denseBadgeWidthAdjust: "2pt",
      taskGridMarker: "1.1em",
      taskGridGutter: "0.5em",
      taskListBodyIndent: "0pt",
      pageLayoutColumnGutter: "14pt",
      pageLayoutInsetX: "0pt",
      denseTableThreshold: "18mm",
      tableCellInsetY: "8pt",
      tableCellInsetNormalX: "6pt",
      tableCellInsetDenseX: "2pt",
      // Distinct cover geometry: taller top pad, longer rule, different offsets.
      coverTopPad: "46mm",
      coverLogoBelow: "20pt",
      coverLogoHeight: "13mm",
      coverLogoWidth: "48mm",
      coverEyebrowGap: "20pt",
      coverTitleGap: "28pt",
      coverRuleLength: "68mm",
      coverRuleStroke: "1.2pt",
      coverMetaGap: "26pt",
      coverMetaColLabel: "32mm",
      coverMetaColGutter: "14pt",
      coverMetaRowGutter: "9pt",
      coverTitleLeading: "1.02em",
      closingTopPad: "62mm",
      closingEyebrowGap: "16pt",
      closingTitleGap: "24pt",
      closingRuleLength: "68mm",
      closingRuleStroke: "1.2pt",
      closingMetaGap: "24pt",
      closingColophonGap: "26pt",
      closingTitleLeading: "1.06em",
    },
    ratios: {
      coverBlockWidth: 88,
      closingBlockWidth: 80,
      statusBadgeLighten: 82,
      watermarkOpacityScale: 100,
    },
    contrast: { minimum: 4.5 },
  },
  semanticPalettes: {
    callouts: {
      // Warmer, softer callout palette.
      info: { background: "#E6F0EA", foreground: "#0B6E4F" },
      note: { background: "#EDEAF4", foreground: "#3F317C" },
      warning: { background: "#FBF1E0", foreground: "#8A5218" },
      tip: { background: "#E4F3EC", foreground: "#0B6E4F" },
      success: { background: "#E4F3EC", foreground: "#0B6E4F" },
      error: { background: "#FBE8E6", foreground: "#A63A32" },
      panel: { background: "#F2F0EB", foreground: "#48505B" },
    },
    statuses: {
      neutral: "#48505B",
      grey: "#48505B",
      gray: "#48505B",
      purple: "#3F317C",
      red: "#B23B3B",
      yellow: "#C6871A",
      green: "#0B6E4F",
      blue: "#245BB5",
      default: "#48505B",
    },
  },
};

const RAW_MANUSCRIPT_MANIFEST = {
  schemaVersion: 1,
  id: MANUSCRIPT_PDF_TEMPLATE_ID,
  name: "Manuscript",
  version: "1.0.0",
  engine: {
    kind: "typst",
    api: "wiki.pdf-template/v1",
    entry: "atlcli.typ",
    compilerRange: ">=0.14 <0.15",
  },
  requiredFonts: [
    { family: "Source Serif 4", style: "normal", weight: 600 },
    { family: "Source Serif 4", style: "normal", weight: 700 },
    { family: "Source Sans 3", style: "normal", weight: 400 },
    { family: "Source Sans 3", style: "normal", weight: 600 },
    { family: "Source Code Pro", style: "normal", weight: 700 },
    { family: "Noto Sans Symbols2", style: "normal", weight: 400 },
    { family: "Noto Emoji", style: "normal", weight: 400 },
  ],
  design: MANUSCRIPT_DESIGN,
  bindings: [
    { setting: "accentColor", targets: ["branding.accent", "tokens.colors.accent"] },
    { setting: "organizationName", targets: ["branding.organizationName"] },
    { setting: "page", targets: ["page.size"] },
    { setting: "orientation", targets: ["page.orientation"] },
    { setting: "cover", targets: ["features.cover.enabled"] },
    { setting: "outline", targets: ["features.outline.enabled"] },
  ],
  localization: {
    defaultLocale: "en",
    fallbackLocale: "en",
    locales: {
      en: {
        template: { name: "Manuscript", description: "A serif-display, book-like PDF template." },
        document: {
          version: "Version",
          exported: "Exported",
          exporter: "Exported by",
          contents: "Contents",
          endOfDocument: "END OF DOCUMENT",
          pages: "Pages",
          generatedWith: "Generated from Confluence with",
          spacePrefix: "CONFLUENCE SPACE",
        },
      },
    },
  },
};

/** The validated "Manuscript" curated template manifest (spec 012 T6.5). */
export const MANUSCRIPT_PDF_TEMPLATE_MANIFEST: TemplateManifest = validateManifest(
  RAW_MANUSCRIPT_MANIFEST,
  {
    availableFonts: PDF_RUNTIME_ASSETS.fonts.map((font) => ({
      family: font.family,
      style: font.style,
      weight: font.weight,
    })),
  }
);

/** Every built-in curated template, keyed by id. Both render the same engine. */
export const BUILTIN_PDF_TEMPLATES: Readonly<Record<string, TemplateManifest>> = Object.freeze({
  [BUILTIN_PDF_TEMPLATE_ID]: BUILTIN_PDF_TEMPLATE_MANIFEST,
  [MANUSCRIPT_PDF_TEMPLATE_ID]: MANUSCRIPT_PDF_TEMPLATE_MANIFEST,
});

/** Look up a curated built-in template manifest by id. */
export function getBuiltinPdfTemplate(id: string): TemplateManifest | undefined {
  return BUILTIN_PDF_TEMPLATES[id];
}
