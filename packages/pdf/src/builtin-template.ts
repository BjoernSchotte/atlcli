/**
 * Built-in PDF template manifest (spec 012 T6.3) — "Editorial Indigo".
 *
 * This is the declarative form of everything `template.ts`/`serialize.ts` used
 * to hardcode: typography roles, color tokens, both semantic palettes, and
 * component spacing/layout. Every value here is the exact literal it replaces
 * (see `specs/export-expansion/007-pdf-template-settings/HARDCODING-LEDGER.md`),
 * so the built-in template's default output is byte-identical before and after
 * the migration (proven by the parity test in `@atlcli/pdf-compiler-browser`).
 *
 * The manifest is validated at module load through the real `validateManifest`
 * import gate (design/bindings/localization + a `requiredFonts` cross-check
 * against the bundled runtime font inventory) — no separately-typed shadow copy.
 */

import {
  validateManifest,
  type TemplateManifest,
  type WikiPdfTemplateDesignV1,
} from "@atlcli/template-pack";
import { PDF_RUNTIME_ASSETS } from "./runtime-assets.js";

/** Stable id of the built-in template (avoids embedding the product name). */
export const BUILTIN_PDF_TEMPLATE_ID = "builtin.editorial-indigo";

const DESIGN: WikiPdfTemplateDesignV1 = {
  page: {
    size: "a4",
    orientation: "portrait",
    margin: { top: "23mm", bottom: "20mm", left: "22mm", right: "22mm" },
  },
  features: {
    cover: { enabled: true },
    outline: { enabled: true, depth: 3 },
    header: { enabled: true, mode: "title" },
    footer: { enabled: true },
    closingPage: { enabled: true },
  },
  branding: {
    accent: "#4B57A3",
  },
  typography: {
    fonts: {
      body: "Source Serif 4",
      heading: "Source Sans 3",
      mono: "Source Code Pro",
    },
    roles: {
      body: { font: "body", size: "10pt" },
      adfSmallText: { font: "body", size: "9pt" },
      h1: { font: "heading", size: "18pt", weight: "semibold" },
      h2: { font: "heading", size: "14pt", weight: "semibold" },
      h3: { font: "heading", size: "11.5pt", weight: "semibold" },
      code: { font: "mono", size: "8.5pt" },
      tableCell: { font: "heading", size: "9pt" },
      numbering: { font: "heading", size: "0.95em", weight: "semibold" },
      runningHead: { font: "heading", size: "8pt" },
      coverEyebrow: { font: "heading", size: "8pt", weight: "semibold", tracking: "0.12em" },
      coverTitle: { font: "body", size: "31pt", weight: "semibold" },
      coverMetaLabel: { font: "heading", size: "7.5pt", weight: "semibold", tracking: "0.08em" },
      coverMetaValue: { font: "heading", size: "9.5pt" },
      closingEyebrow: { font: "heading", size: "8pt", weight: "semibold", tracking: "0.14em" },
      closingTitle: { font: "body", size: "24pt", weight: "semibold" },
      closingMetaLabel: { font: "heading", size: "7.5pt", weight: "semibold", tracking: "0.08em" },
      closingMetaValue: { font: "heading", size: "9.5pt" },
      colophon: { font: "heading", size: "8.5pt" },
      statusBadge: { font: "mono", size: "7.5pt", weight: "bold" },
      taskMarker: { font: "heading", size: "8.5pt", weight: "semibold" },
    },
  },
  tokens: {
    colors: {
      accent: "#4B57A3",
      ink: "#172B4D",
      paper: "#FCFBF8",
      coverTitleInk: "#202A44",
      warmSlate: "#74727A",
      muted: "#6B778C",
      hairline: "#DFE1E6",
      heading3: "#253858",
      codeBackground: "#F4F5F7",
      neutral: "#42526E",
      taskChecked: "#0052CC",
      taskUnchecked: "#6B778C",
      mention: "#0747A6",
      placeholder: "#97A0AF",
      tableStroke: "#DFE1E6",
      tableHeaderBackground: "#F4F5F7",
      smartCardInlineBackground: "#E9F2FF",
      smartCardBlockBackground: "#F4F5F7",
      smartCardBlockStroke: "#B3BAC5",
      mediaGroupBackground: "#F7F8F9",
      watermark: "#DE350B",
    },
    layout: {
      paragraphLeading: "0.74em",
      paragraphSpacing: "10pt",
      adfBlockIndentStep: "1.5em",
      listBodyIndent: "0.7em",
      listSpacing: "8pt",
      enumBodyIndent: "0.7em",
      enumSpacing: "8pt",
      h1Above: "28pt",
      h1Below: "14pt",
      h2Above: "24pt",
      h2Below: "12pt",
      h3Above: "18pt",
      h3Below: "8pt",
      inlineCodeInsetX: "0.2em",
      inlineCodeInsetY: "0.06em",
      inlineCodeRadius: "2pt",
      codeInset: "9pt",
      codeRadius: "4pt",
      codeTitleBelow: "0pt",
      calloutStroke: "3pt",
      calloutInsetX: "11pt",
      calloutInsetY: "9pt",
      calloutRadius: "4pt",
      calloutAbove: "6pt",
      calloutBelow: "8pt",
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
      taskGridMarker: "1.05em",
      taskGridGutter: "0.45em",
      taskListBodyIndent: "0pt",
      pageLayoutColumnGutter: "12pt",
      pageLayoutInsetX: "0pt",
      denseTableThreshold: "18mm",
      tableCellInsetY: "7pt",
      tableCellInsetNormalX: "6pt",
      tableCellInsetDenseX: "2pt",
      coverTopPad: "37mm",
      coverLogoBelow: "18pt",
      coverLogoHeight: "12mm",
      coverLogoWidth: "45mm",
      coverEyebrowGap: "17pt",
      coverTitleGap: "25pt",
      coverRuleLength: "52mm",
      coverRuleStroke: "0.9pt",
      coverMetaGap: "23pt",
      coverMetaColLabel: "30mm",
      coverMetaColGutter: "12pt",
      coverMetaRowGutter: "8pt",
      coverTitleLeading: "0.98em",
      closingTopPad: "57mm",
      closingEyebrowGap: "14pt",
      closingTitleGap: "22pt",
      closingRuleLength: "52mm",
      closingRuleStroke: "0.9pt",
      closingMetaGap: "22pt",
      closingColophonGap: "24pt",
      closingTitleLeading: "1.02em",
    },
    ratios: {
      coverBlockWidth: 90,
      closingBlockWidth: 82,
      statusBadgeLighten: 82,
      watermarkOpacityScale: 100,
    },
    contrast: { minimum: 4.5 },
  },
  semanticPalettes: {
    callouts: {
      info: { background: "#DEEBFF", foreground: "#0747A6" },
      note: { background: "#EAE6FF", foreground: "#403294" },
      warning: { background: "#FFFAE6", foreground: "#974F0C" },
      tip: { background: "#E3FCEF", foreground: "#006644" },
      success: { background: "#E3FCEF", foreground: "#006644" },
      error: { background: "#FFEBE6", foreground: "#BF2600" },
      panel: { background: "#F4F5F7", foreground: "#42526E" },
    },
    statuses: {
      neutral: "#42526E",
      grey: "#42526E",
      gray: "#42526E",
      purple: "#403294",
      red: "#DE350B",
      yellow: "#FF991F",
      green: "#00875A",
      blue: "#0052CC",
      default: "#42526E",
    },
  },
};

const RAW_MANIFEST = {
  schemaVersion: 1,
  id: BUILTIN_PDF_TEMPLATE_ID,
  name: "Editorial Indigo",
  version: "1.0.0",
  engine: {
    kind: "typst",
    api: "wiki.pdf-template/v1",
    entry: "atlcli.typ",
    compilerRange: ">=0.15.1 <0.16",
  },
  requiredFonts: [
    { family: "Source Serif 4", style: "normal", weight: 400 },
    { family: "Source Serif 4", style: "normal", weight: 600 },
    { family: "Source Sans 3", style: "normal", weight: 400 },
    { family: "Source Sans 3", style: "normal", weight: 600 },
    { family: "Source Sans 3", style: "normal", weight: 700 },
    { family: "Source Code Pro", style: "normal", weight: 400 },
    { family: "Source Code Pro", style: "normal", weight: 700 },
    { family: "Noto Sans Symbols2", style: "normal", weight: 400 },
    { family: "Noto Emoji", style: "normal", weight: 400 },
  ],
  design: DESIGN,
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
        template: {
          name: "Editorial Indigo",
          description: "The built-in atlcli editorial PDF template.",
        },
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
      de: {
        template: {
          name: "Editorial Indigo",
          description: "Die eingebaute atlcli-Editorial-PDF-Vorlage.",
        },
        document: {
          version: "Version",
          exported: "Exportiert",
          exporter: "Exportiert von",
          contents: "Inhalt",
          endOfDocument: "DOKUMENTENDE",
          pages: "Seiten",
          generatedWith: "Erzeugt aus Confluence mit",
          spacePrefix: "CONFLUENCE SPACE",
        },
      },
    },
  },
};

/**
 * The validated built-in template manifest. Validation runs the real import
 * gate (design/bindings/localization) plus a `requiredFonts` cross-check
 * against the bundled runtime inventory — a bad literal here fails at load,
 * not at render.
 */
export const BUILTIN_PDF_TEMPLATE_MANIFEST: TemplateManifest = validateManifest(RAW_MANIFEST, {
  availableFonts: PDF_RUNTIME_ASSETS.fonts.map((font) => ({
    family: font.family,
    style: font.style,
    weight: font.weight,
  })),
});

/** The built-in template's fully resolved design (no bindings/theme applied). */
export const BUILTIN_PDF_DESIGN: WikiPdfTemplateDesignV1 = BUILTIN_PDF_TEMPLATE_MANIFEST.design!;

/**
 * The built-in template's fallback-locale document labels. Used as the
 * gen-time defaults so `atlcli-doc` still renders with `settings: (:)` (the
 * 007 backward-compatibility contract).
 */
export const BUILTIN_PDF_FALLBACK_LABELS: Record<string, string> =
  BUILTIN_PDF_TEMPLATE_MANIFEST.localization!.locales[
    BUILTIN_PDF_TEMPLATE_MANIFEST.localization!.fallbackLocale
  ]!.document!;
