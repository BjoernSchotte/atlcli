import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { InMemoryTemplateAssetStore } from "@atlcli/pdf-template-authoring";
import { PDF_TEMPLATE_ASSET_CAPABILITIES_V1 } from "@atlcli/pdf";
import { resolveDocxTemplateDesign } from "./design-analysis.js";
import { analyzeDocxVisualAssets } from "./visual-analysis.js";
import {
  compareVisualOracle,
  projectVisualOracle,
  type VisualOracleEntryV1,
} from "./visual-oracle.js";
import { REAL_VISUAL_FIXTURE_ORACLES } from "./fixtures/visual-oracles.js";
import {
  DRAWING_NAMESPACES,
  TEST_VISUAL_CAPABILITIES,
  TrackingAssetStore,
  anchorDrawing,
  imageRelationships,
  inlineDrawing,
  png,
  singleSection,
  storyDocument,
  visualDocx,
  wordDocument,
} from "./visual-test-support.js";
import {
  officeRelationshipType,
  relationshipsXml,
} from "./test-support.js";

describe("visual role suggestions and review safety", () => {
  test("suggests repeated small header graphics as logos with concrete reasons", async () => {
    const sections = await singleSection({
      titlePage: true,
      headers: {
        default: "word/header1.xml",
        first: "word/header2.xml",
      },
    });
    const result = await analyzeDocxVisualAssets(
      visualDocx({
        documentRelationships: relationshipsXml([
          {
            id: "rDefault",
            type: officeRelationshipType("header"),
            target: "header1.xml",
          },
          {
            id: "rFirst",
            type: officeRelationshipType("header"),
            target: "header2.xml",
          },
        ]),
        entries: {
          "word/header1.xml": storyDocument(inlineDrawing("rLogo")),
          "word/header2.xml": storyDocument(inlineDrawing("rLogo")),
          "word/_rels/header1.xml.rels": imageRelationships([
            { id: "rLogo", target: "media/brand.png" },
          ]),
          "word/_rels/header2.xml.rels": imageRelationships([
            { id: "rLogo", target: "media/brand.png" },
          ]),
          "word/media/brand.png": png(320, 80),
        },
      }),
      {
        capabilities: TEST_VISUAL_CAPABILITIES,
        assetStore: new TrackingAssetStore(),
        sections,
      }
    );
    const logoSuggestions = result.analysis.roleSuggestions.filter(
      ({ role }) => role === "logo"
    );

    expect(logoSuggestions).toHaveLength(2);
    expect(
      logoSuggestions.every(
        ({ confidence, explanations }) =>
          confidence === "corroborated" &&
          explanations.some(
            ({ code, params }) =>
              code === "DOCX_VISUAL_ROLE_REPEATED_HEADER" &&
              params.occurrences === 2
          )
      )
    ).toBe(true);
    expect(
      result.analysis.roleSuggestions.some(
        ({ confidence }) => confidence === "conclusive"
      )
    ).toBe(false);
  });

  test("a logo filename alone does not create a logo suggestion", async () => {
    const result = await analyzeDocxVisualAssets(
      visualDocx({
        document: wordDocument(inlineDrawing("rLogo")),
        documentRelationships: imageRelationships([
          { id: "rLogo", target: "media/logo.png" },
        ]),
        entries: { "word/media/logo.png": png(100, 30) },
      }),
      {
        capabilities: TEST_VISUAL_CAPABILITIES,
        assetStore: new TrackingAssetStore(),
        sections: await singleSection(),
      }
    );

    expect(
      result.analysis.roleSuggestions.some(({ role }) => role === "logo")
    ).toBe(false);
  });

  test("suggests page backgrounds, first-page cover art, and watermark evidence without adopting them", async () => {
    const width = 11_906 * 635;
    const height = 16_838 * 635;
    const sections = await singleSection({
      titlePage: true,
      headers: { first: "word/header1.xml" },
    });
    const result = await analyzeDocxVisualAssets(
      visualDocx({
        document: wordDocument(
          anchorDrawing("rPage", {
            width,
            height,
            behindDoc: true,
            rotation: 30,
            opacity: 0.5,
          })
        ),
        documentRelationships: relationshipsXml([
          {
            id: "rPage",
            type: officeRelationshipType("image"),
            target: "media/page.png",
          },
          {
            id: "rHeader",
            type: officeRelationshipType("header"),
            target: "header1.xml",
          },
        ]),
        entries: {
          "word/header1.xml": storyDocument(inlineDrawing("rCover")),
          "word/_rels/header1.xml.rels": imageRelationships([
            { id: "rCover", target: "media/cover.png" },
          ]),
          "word/media/page.png": png(800, 600),
          "word/media/cover.png": png(640, 480),
        },
      }),
      {
        capabilities: TEST_VISUAL_CAPABILITIES,
        assetStore: new TrackingAssetStore(),
        sections,
      }
    );
    const roles = result.analysis.roleSuggestions.map(({ role }) => role);

    expect(roles).toContain("page-background");
    expect(roles).toContain("watermark");
    expect(roles).toContain("cover-art");
    expect(
      result.analysis.roleSuggestions.flatMap(({ explanations }) =>
        explanations.map(({ code }) => code)
      )
    ).toEqual(
      expect.arrayContaining([
        "DOCX_VISUAL_ROLE_PAGE_FILL",
        "DOCX_VISUAL_ROLE_FIRST_ONLY",
        "DOCX_VISUAL_ROLE_WATERMARK",
      ])
    );
    expect(
      result.analysis.assetReview.every(
        (item) =>
          item.defaultDecision === "do-not-include" &&
          item.rights === "unknown" &&
          item.semanticRole === "unconfirmed" &&
          item.accessibility === "unanswered" &&
          item.placement === "unanswered"
      )
    ).toBe(true);
    expect(JSON.stringify(result.analysis)).not.toContain("rightsConfirmed");
  });
});

describe("independent visual oracle", () => {
  test("agrees with the reviewed Word and LibreOffice fixture scenes", async () => {
    for (const [fixture, expected] of Object.entries(
      REAL_VISUAL_FIXTURE_ORACLES
    )) {
      const bytes = readFileSync(
        resolve(import.meta.dir, "fixtures", fixture)
      );
      const design = await resolveDocxTemplateDesign(bytes);
      const bundle = await analyzeDocxVisualAssets(bytes, {
        capabilities: PDF_TEMPLATE_ASSET_CAPABILITIES_V1,
        assetStore: new InMemoryTemplateAssetStore(),
        sections: design.sections,
      });
      expect(compareVisualOracle(expected, projectVisualOracle(bundle.analysis))).toEqual([]);
    }
  });

  test("AlternateContent is one scene with selected and fallback provenance", async () => {
    const choice = inlineDrawing("rChoice", {
      crop: { left: 1_000, top: 2_000, right: 3_000, bottom: 4_000 },
    });
    const fallback = inlineDrawing("rFallback", {
      crop: { left: 4_000, top: 3_000, right: 2_000, bottom: 1_000 },
    });
    const body = [
      `<mc:AlternateContent>`,
      `<mc:Choice Requires="a">${choice}</mc:Choice>`,
      `<mc:Fallback>${fallback}</mc:Fallback>`,
      `</mc:AlternateContent>`,
    ].join("");
    const result = await analyzeDocxVisualAssets(
      visualDocx({
        document: `<?xml version="1.0" encoding="UTF-8"?><w:document ${DRAWING_NAMESPACES}><w:body>${body}</w:body></w:document>`,
        documentRelationships: imageRelationships([
          { id: "rChoice", target: "media/choice.png" },
          { id: "rFallback", target: "media/fallback.png" },
        ]),
        entries: {
          "word/media/choice.png": png(200, 100),
          "word/media/fallback.png": png(200, 100),
        },
      }),
      {
        capabilities: TEST_VISUAL_CAPABILITIES,
        assetStore: new TrackingAssetStore(),
        sections: await singleSection(),
      }
    );

    expect(result.analysis.scenes).toHaveLength(1);
    expect(result.analysis.scenes[0]?.representations).toHaveLength(2);
    expect(
      result.analysis.scenes[0]?.representations.map(({ selected }) => selected)
    ).toEqual([true, false]);
    expect(
      result.analysis.scenes[0]?.representations.map(
        ({ sourceUse }) => sourceUse.alternateContent?.branch
      )
    ).toEqual(["choice.0", "fallback.0"]);
  });

  test("crop, relationship, branch, and section mutations each identify exactly their responsible oracle field", () => {
    const base: VisualOracleEntryV1 = {
      key: "fixture.scene.0",
      assetSha256: "a".repeat(64),
      relationshipRef: "relationship.0.abcdef",
      targetFingerprint: "b".repeat(64),
      alternateBranch: "choice.0",
      crop:
        '{"left":1,"top":2,"right":3,"bottom":4,"unit":"percent"}',
      horizontalReference: "page",
      verticalReference: "margin",
      section: 0,
      master: "first",
      adoption: "do-not-include",
    };
    const mutations: readonly [
      keyof Pick<
        VisualOracleEntryV1,
        "alternateBranch" | "crop" | "section" | "targetFingerprint"
      >,
      string | number,
    ][] = [
      ["crop", "null"],
      ["targetFingerprint", "c".repeat(64)],
      ["alternateBranch", "fallback.0"],
      ["section", 1],
    ];
    for (const [field, value] of mutations) {
      const changed = { ...base, [field]: value };
      expect(compareVisualOracle([base], [changed])).toEqual([
        `${base.key}.${field}`,
      ]);
    }
  });
});
