import { ASSET_MAX_BYTES } from "@atlcli/confluence";
import {
  TEMPLATE_ASSET_CAPABILITIES_SCHEMA_V1,
  validateTemplateAssetCapabilitiesV1,
  type TemplateAssetCapabilitiesV1,
} from "@atlcli/template-pack";

/**
 * The single visual-asset budget used by DOCX intake now and PDF template-pack
 * validation in T6. General page-content assets keep their existing contract.
 */
export const PDF_TEMPLATE_ASSET_CAPABILITIES_V1: TemplateAssetCapabilitiesV1 =
  validateTemplateAssetCapabilitiesV1({
    schema: TEMPLATE_ASSET_CAPABILITIES_SCHEMA_V1,
    id: "atlcli.pdf-template-assets",
    version: 1,
    mediaTypes: ["image/jpeg", "image/png", "image/svg+xml"],
    maxBytes: ASSET_MAX_BYTES,
    maxWidth: 16_384,
    maxHeight: 16_384,
    maxPixels: 100_000_000,
    svg: {
      maxElements: 10_000,
      maxPathElements: 2_000,
      maxFilterPrimitives: 128,
    },
  });
