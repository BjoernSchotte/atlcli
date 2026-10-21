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
import { PDF_RUNTIME_ASSETS } from "./runtime-assets.js";
import { createAtlcliTypstTemplate } from "./template.js";
import { createAtlcliTypstTemplateV4 } from "./template-v4.js";

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

function withoutToggle<T extends { enabled?: boolean }>(
  composition: T,
): Omit<T, "enabled"> {
  const { enabled: _enabled, ...rest } = composition;
  return rest;
}

export function projectPdfDesignV5RuntimeSettings(
  design: WikiPdfTemplateDesignV3,
): WikiPdfTemplateDesignV1 {
  const contents = design.navigation.contents;
  const legacyRoles = Object.fromEntries(
    Object.entries(design.typography.roles).map(([name, role]) => [name, {
      size: role.size,
      ...(role.font === undefined ? {} : { font: role.font }),
      ...(role.weight === undefined ? {} : { weight: role.weight }),
      ...(role.tracking === undefined ? {} : { tracking: role.tracking }),
    }]),
  );
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
      cover: { enabled: design.compositions.cover.enabled ?? true },
      outline: { enabled: contents.enabled, depth: contents.depth },
      header: {
        enabled: design.compositions.running.header.enabled,
        mode: "title",
      },
      footer: { enabled: design.compositions.running.footer.enabled },
      closingPage: { enabled: design.compositions.closingPage.enabled ?? true },
    },
    branding: design.branding,
    typography: {
      fonts: { ...design.typography.fonts },
      roles: legacyRoles,
    },
    tokens: design.tokens,
    semanticPalettes: design.semanticPalettes,
    // The V1 projection carries the toggles in `features`, not compositions.
    compositions: {
      cover: withoutToggle(design.compositions.cover),
      closingPage: withoutToggle(design.compositions.closingPage),
    },
  };
}

export function createAtlcliTypstTemplateV5(
  design: WikiPdfTemplateDesignV3,
  labels: Record<string, string> = {},
  visuals?: PdfTemplateVisualsV1,
  revision: "5" | "6" = "5",
): string {
  const validated = validatePdfTemplateDesignV3(design, "design", {
    availableFonts: PDF_RUNTIME_ASSETS.fonts,
  });
  const runtimeDesign = projectPdfDesignV5RuntimeSettings(validated);
  const revision5Base = createAtlcliTypstTemplate(
    runtimeDesign,
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
      decorationModelV5: {
        paints: validated.paints ?? {},
        decorations: validated.decorations ?? [],
      },
      imageGeometryV5: true,
      typographyModelV5: validated.typography,
      ...(validated.compositions.titleBlock?.enabled ? { titleBlockV5: true } : {}),
      ...(revision === "6" ? { revision6: true } : {}),
    },
  );
  return createAtlcliTypstTemplateV4(
    runtimeDesign,
    labels,
    visuals,
    revision5Base,
  );
}
