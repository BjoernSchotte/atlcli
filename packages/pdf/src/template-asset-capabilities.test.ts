import { describe, expect, test } from "bun:test";
import { ASSET_MAX_BYTES } from "@atlcli/confluence";
import {
  validateTemplateAssetCapabilitiesV1,
} from "@atlcli/template-pack";
import { PDF_TEMPLATE_ASSET_CAPABILITIES_V1 } from "./template-asset-capabilities.js";
import { pdfTemplateAssetDimensions } from "./template-assets.js";

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

describe("PDF template SVG intrinsic dimensions", () => {
  const dimensions = (svg: string) =>
    pdfTemplateAssetDimensions("image/svg+xml", new TextEncoder().encode(svg));

  test("reads only the root <svg> width/height, never stroke-width or a child's", () => {
    expect(
      dimensions('<svg stroke-width="3" width="120" height="60"><rect width="5" height="5"/></svg>'),
    ).toEqual({ width: 120, height: 60, unit: "pixel" });
    expect(
      dimensions('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 480"><rect stroke-width="2" width="5" height="7"/></svg>'),
    ).toEqual({ width: 640, height: 480, unit: "pixel" });
  });

  test("emits integer pixels (descriptor dimensions are integers) and rejects an unsized SVG", () => {
    expect(dimensions('<svg width="120.4px" height="59.6"/>')).toEqual({
      width: 121,
      height: 60,
      unit: "pixel",
    });
    expect(dimensions('<svg width="100%" height="100%" viewBox="0 0 300 150"/>')).toEqual({
      width: 300,
      height: 150,
      unit: "pixel",
    });
    expect(() => dimensions('<svg><rect width="5" height="7"/></svg>')).toThrow(
      /intrinsic dimensions/u,
    );
  });
});
