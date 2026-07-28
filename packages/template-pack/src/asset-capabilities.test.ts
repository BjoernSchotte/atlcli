import { describe, expect, test } from "bun:test";
import {
  TEMPLATE_ASSET_CAPABILITIES_SCHEMA_V1,
  validateTemplateAssetCapabilitiesV1,
  type TemplateAssetCapabilitiesV1,
} from "./asset-capabilities.js";

function valid(): TemplateAssetCapabilitiesV1 {
  return {
    schema: TEMPLATE_ASSET_CAPABILITIES_SCHEMA_V1,
    id: "renderer.assets",
    version: 1,
    mediaTypes: ["image/png", "image/jpeg", "image/svg+xml"],
    maxBytes: 100,
    maxWidth: 200,
    maxHeight: 300,
    maxPixels: 40_000,
    svg: {
      maxElements: 20,
      maxPathElements: 10,
      maxFilterPrimitives: 5,
    },
  };
}

describe("template visual-asset capability contract", () => {
  test("accepts the complete deterministic descriptor", () => {
    expect(validateTemplateAssetCapabilitiesV1(valid())).toEqual(valid());
  });

  test("rejects unknown media types, duplicates, invalid ids, and unsafe bounds", () => {
    const mutations = [
      { mediaTypes: ["image/png", "image/png"] },
      { mediaTypes: ["image/gif"] },
      { id: "../renderer" },
      { maxBytes: 0 },
      { maxPixels: Number.MAX_SAFE_INTEGER + 1 },
      { svg: { maxElements: 0, maxPathElements: 1, maxFilterPrimitives: 1 } },
    ];
    for (const mutation of mutations) {
      expect(() =>
        validateTemplateAssetCapabilitiesV1({
          ...valid(),
          ...mutation,
        })
      ).toThrow();
    }
  });
});
