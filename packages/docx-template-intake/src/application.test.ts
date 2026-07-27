import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { sha256Hex } from "@atlcli/core";
import {
  PDF_RUNTIME_ASSETS,
  PDF_TEMPLATE_ASSET_CAPABILITIES_V1,
  PDF_TEMPLATE_CAPABILITIES_V1,
} from "@atlcli/pdf";
import { InMemoryTemplateAssetStore } from "@atlcli/pdf-template-authoring";
import { analyzeDocxTemplateImport } from "./application.js";

describe("host-neutral DOCX template intake application", () => {
  test("preserves caller bytes and pins catalog and visual facts to the raw source digest", async () => {
    const source = new Uint8Array(
      readFileSync(
        resolve(
          import.meta.dir,
          "fixtures/neutral-word-16.111.1.docx"
        )
      )
    );
    const before = new Uint8Array(source);
    const expectedDigest = await sha256Hex(before);
    const result = await analyzeDocxTemplateImport(source, {
      catalog: PDF_TEMPLATE_CAPABILITIES_V1,
      bundledFontFamilies: PDF_RUNTIME_ASSETS.fonts.map(
        ({ family }) => family
      ),
      assetCapabilities: PDF_TEMPLATE_ASSET_CAPABILITIES_V1,
      assetStore: new InMemoryTemplateAssetStore(),
    });

    expect(result.analysis.sourceDigest).toBe(expectedDigest);
    expect(result.visualAnalysis?.sourceDigest).toBe(expectedDigest);
    expect(source).toEqual(before);
  });
});
