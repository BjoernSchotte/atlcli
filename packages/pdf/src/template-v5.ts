/**
 * Canonical PDF renderer revision 5.
 *
 * Unlike revision 4, this renderer does not rewrite a generated Typst string.
 * It validates the complete Catalog-V3 design, projects the historical body
 * renderer's typed token subset, and passes a data-only page model to the
 * shared renderer. Revisions 1-4 keep using their existing call paths.
 */
import {
  validatePdfTemplateDesignV3,
  type DesignPageMarginV3,
  type WikiPdfTemplateDesignV1,
  type WikiPdfTemplateDesignV3,
} from "@atlcli/template-pack";
import type { PdfTemplateVisualsV1 } from "./template-pack.js";
import { createAtlcliTypstTemplate } from "./template.js";

function coverPhysicalMargins(
  margin: DesignPageMarginV3,
  binding: "left" | "right",
): WikiPdfTemplateDesignV1["page"]["margin"] {
  if (margin.mode === "physical") {
    return {
      top: margin.top,
      bottom: margin.bottom,
      left: margin.left,
      right: margin.right,
    };
  }
  return {
    top: margin.top,
    bottom: margin.bottom,
    left: binding === "left" ? margin.inside : margin.outside,
    right: binding === "left" ? margin.outside : margin.inside,
  };
}

export function projectPdfDesignV5RuntimeSettings(
  design: WikiPdfTemplateDesignV3,
): WikiPdfTemplateDesignV1 {
  const contents = design.navigation.contents;
  return {
    page: {
      size:
        design.page.format.kind === "preset"
          ? design.page.format.name
          : "a4",
      orientation: design.page.orientation,
      margin: coverPhysicalMargins(design.page.margin, design.page.binding),
    },
    features: {
      cover: { enabled: true },
      outline: { enabled: contents.enabled, depth: contents.depth },
      header: {
        enabled: design.compositions.running.header.enabled,
        mode: "title",
      },
      footer: { enabled: design.compositions.running.footer.enabled },
      closingPage: { enabled: true },
    },
    branding: design.branding,
    typography: design.typography,
    tokens: design.tokens,
    semanticPalettes: design.semanticPalettes,
  };
}

export function createAtlcliTypstTemplateV5(
  design: WikiPdfTemplateDesignV3,
  labels: Record<string, string> = {},
  visuals?: PdfTemplateVisualsV1,
): string {
  const validated = validatePdfTemplateDesignV3(design);
  return createAtlcliTypstTemplate(
    projectPdfDesignV5RuntimeSettings(validated),
    labels,
    visuals,
    {
      positionedLogo: true,
      pageModelV5: {
        page: validated.page,
        running: validated.compositions.running,
      },
      semanticModelV5: {
        navigation: validated.navigation,
        components: validated.components,
      },
    },
  );
}
