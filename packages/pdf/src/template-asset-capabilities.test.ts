import { describe, expect, test } from "bun:test";
import { ASSET_MAX_BYTES } from "@atlcli/confluence";
import {
  validateTemplateAssetCapabilitiesV1,
} from "@atlcli/template-pack";
import { PDF_TEMPLATE_ASSET_CAPABILITIES_V1 } from "./template-asset-capabilities.js";

describe("PDF template visual-asset capability descriptor", () => {
  test("is valid and reuses the renderer's existing per-file byte ceiling", () => {
    expect(
      validateTemplateAssetCapabilitiesV1(
        PDF_TEMPLATE_ASSET_CAPABILITIES_V1
      )
    ).toBe(PDF_TEMPLATE_ASSET_CAPABILITIES_V1);
    expect(PDF_TEMPLATE_ASSET_CAPABILITIES_V1.maxBytes).toBe(
      ASSET_MAX_BYTES
    );
    expect(PDF_TEMPLATE_ASSET_CAPABILITIES_V1.maxPixels).toBeLessThanOrEqual(
      PDF_TEMPLATE_ASSET_CAPABILITIES_V1.maxWidth *
        PDF_TEMPLATE_ASSET_CAPABILITIES_V1.maxHeight
    );
  });
});
