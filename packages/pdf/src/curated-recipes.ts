/**
 * Curated Recipe-V2 templates shipped with atlcli. Hosts build them into a
 * pack on demand (`wiki export --template report`); the downloadable copy in
 * `public/examples/pdf-template-recipe-v2-report/recipe.yaml` is kept equal by
 * a test.
 */
import type { WikiPdfTemplateRecipeV2 } from "@atlcli/template-pack";
import {
  BUILTIN_PDF_TEMPLATE_BASELINE_DIGEST_V2,
  BUILTIN_PDF_TEMPLATE_BASELINE_ID_V1,
  BUILTIN_PDF_TEMPLATE_BASELINE_VERSION_V2,
} from "./recipe-baselines.js";

const pageRunning = (
  start: { field: "documentTitle" | "exportDate" },
  end:
    | { field: "spaceName" }
    | { field: "pageNumber"; numbering: "current-of-total" },
) => ({ start, end });

/** "Report": no cover or closing page, a title block, quiet teal styling. */
const REPORT_RECIPE: WikiPdfTemplateRecipeV2 = {
  schema: "wiki.pdf-template-recipe/v2",
  template: { id: "atlcli.report", name: "Report", version: "1.0.0" },
  baseline: {
    id: BUILTIN_PDF_TEMPLATE_BASELINE_ID_V1,
    version: BUILTIN_PDF_TEMPLATE_BASELINE_VERSION_V2,
    catalogVersion: 4,
    digest: BUILTIN_PDF_TEMPLATE_BASELINE_DIGEST_V2,
  },
  design: {
    page: {
      margin: { mode: "physical", top: "24mm", bottom: "20mm", left: "20mm", right: "20mm" },
    },
    compositions: {
      cover: { enabled: false },
      closingPage: { enabled: false },
      titleBlock: { enabled: true },
      running: {
        header: {
          enabled: true,
          layout: "split",
          first: "hide",
          odd: pageRunning({ field: "documentTitle" }, { field: "spaceName" }),
          even: pageRunning({ field: "documentTitle" }, { field: "spaceName" }),
        },
        footer: {
          enabled: true,
          layout: "split",
          first: pageRunning({ field: "exportDate" }, { field: "pageNumber", numbering: "current-of-total" }),
          odd: pageRunning({ field: "exportDate" }, { field: "pageNumber", numbering: "current-of-total" }),
          even: pageRunning({ field: "exportDate" }, { field: "pageNumber", numbering: "current-of-total" }),
        },
      },
    },
    navigation: {
      contents: { enabled: true, depth: 2, pageNumbers: "show", leader: "dots" },
    },
    components: {
      table: { repeatHeader: true, banding: "rows", borders: "horizontal" },
      callout: { preset: "filled", icon: "show" },
      outline: { leader: "dots", pageNumbers: "show" },
    },
    branding: { accent: "#0F6E74" },
    typography: {
      fonts: { body: "Source Sans 3", heading: "Source Sans 3" },
      roles: {
        body: { font: "body", size: "10pt" },
        h1: { font: "heading", size: "19pt", weight: "bold" },
        h2: { font: "heading", size: "13.5pt", weight: "semibold" },
        h3: { font: "heading", size: "11pt", weight: "semibold" },
        runningHead: { font: "heading", size: "7.5pt" },
        coverTitle: { font: "heading", size: "24pt", weight: "bold" },
        coverEyebrow: { font: "heading", size: "7.5pt", weight: "semibold", tracking: "0.12em" },
      },
    },
    tokens: {
      colors: {
        accent: "#0F6E74",
        ink: "#1E2A36",
        heading3: "#24414B",
        mention: "#0F6E74",
        taskChecked: "#0F6E74",
        hairline: "#D9E2E4",
        tableStroke: "#D9E2E4",
        tableHeaderBackground: "#EEF4F5",
        codeBackground: "#F3F6F7",
        smartCardInlineBackground: "#E2F0F1",
      },
      // The title block reuses the cover spacing; tighten it for page 1.
      layout: {
        coverTitleLeading: "0.4em",
        coverEyebrowGap: "8pt",
        coverTitleGap: "12pt",
        coverRuleLength: "36mm",
        coverMetaGap: "8pt",
      },
    },
    paints: { band: { kind: "solid", color: "accent" } },
    decorations: [
      {
        kind: "rect",
        scope: "first",
        layer: "page-background",
        box: { x: "0mm", y: "0mm", width: "210mm", height: "4mm" },
        fill: "band",
      },
    ],
  } as WikiPdfTemplateRecipeV2["design"],
  assets: {},
};

/** Curated recipes by the name `wiki export --template <name>` accepts. */
export const CURATED_PDF_TEMPLATE_RECIPES_V2: Readonly<Record<string, WikiPdfTemplateRecipeV2>> =
  Object.freeze({ report: REPORT_RECIPE });
