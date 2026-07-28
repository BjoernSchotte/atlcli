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
import {
  anchorDrawing,
  imageRelationships,
  png,
  visualDocx,
  wordDocument,
} from "./visual-test-support.js";

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

  test("projects a stable one-column Word anchor into margin-relative template placement", async () => {
    const result = await analyzeDocxTemplateImport(
      visualDocx({
        document: wordDocument(
          `${anchorDrawing("rLogo", {
            horizontal: "column",
            vertical: "page",
            horizontalOffset: -69_850,
            verticalOffset: 899_160,
            width: 1_799_590,
            height: 408_305,
            rotation: 0,
          })}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/><w:cols w:num="1"/></w:sectPr>`
        ),
        documentRelationships: imageRelationships([
          { id: "rLogo", target: "media/logo.png" },
        ]),
        entries: { "word/media/logo.png": png(500, 110) },
      }),
      {
        catalog: PDF_TEMPLATE_CAPABILITIES_V1,
        bundledFontFamilies: PDF_RUNTIME_ASSETS.fonts.map(
          ({ family }) => family
        ),
        assetCapabilities: PDF_TEMPLATE_ASSET_CAPABILITIES_V1,
        assetStore: new InMemoryTemplateAssetStore(),
      }
    );

    const asset = result.privateAssetCandidates.at(0);
    expect(asset?.proposedRole).toBeUndefined();
    expect(asset?.candidatePlacement).toEqual({
      relativeTo: "margin",
      fit: "contain",
      x: "-1.94mm",
      y: "-0.423mm",
      width: "49.989mm",
      height: "11.342mm",
    });
    expect(
      result.analysis.candidates.find(({ id }) => id === asset?.candidateId)
    ).toMatchObject({
      compatibility: "native",
      adoption: "review",
      layoutDependent: false,
    });
  });
});
