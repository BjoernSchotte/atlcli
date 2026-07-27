import { describe, expect, test } from "bun:test";
import { resolveDocxSections } from "./section-resolution.js";
import { analyzeDocxVisualAssets } from "./visual-analysis.js";
import {
  DRAWING_NAMESPACES,
  TEST_VISUAL_CAPABILITIES,
  TrackingAssetStore,
  anchorDrawing,
  contentTypes,
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

describe("DrawingML and page-scene resolution", () => {
  test("keeps different crops of one asset as separate scenes", async () => {
    const image = png(300, 200);
    const result = await analyzeDocxVisualAssets(
      visualDocx({
        document: wordDocument(
          `${inlineDrawing("rImage", {
            crop: { left: 0, top: 0, right: 20_000, bottom: 0 },
          })}${inlineDrawing("rImage", {
            crop: { left: 20_000, top: 0, right: 0, bottom: 0 },
          })}`
        ),
        documentRelationships: imageRelationships([
          { id: "rImage", target: "media/shared.png" },
        ]),
        entries: { "word/media/shared.png": image },
      }),
      {
        capabilities: TEST_VISUAL_CAPABILITIES,
        assetStore: new TrackingAssetStore(),
        sections: await singleSection(),
      }
    );

    expect(result.analysis.assets).toHaveLength(1);
    expect(result.analysis.scenes).toHaveLength(2);
    expect(
      result.analysis.scenes.map(({ transform }) => transform?.crop)
    ).toEqual([
      {
        left: 0,
        top: 0,
        right: 20,
        bottom: 0,
        unit: "percent",
      },
      {
        left: 20,
        top: 0,
        right: 0,
        bottom: 0,
        unit: "percent",
      },
    ]);
  });

  test("preserves complete independent anchor axes, simplePos, effects, xfrm, flips, and units", async () => {
    const result = await analyzeDocxVisualAssets(
      visualDocx({
        document: wordDocument(
          anchorDrawing("rImage", {
            horizontal: "page",
            vertical: "margin",
            simplePos: true,
          })
        ),
        documentRelationships: imageRelationships([
          { id: "rImage", target: "media/anchor.png" },
        ]),
        entries: { "word/media/anchor.png": png(600, 700) },
      }),
      {
        capabilities: TEST_VISUAL_CAPABILITIES,
        assetStore: new TrackingAssetStore(),
        sections: await singleSection(),
      }
    );
    const scene = result.analysis.scenes[0]!;

    expect(scene.placement).toEqual({
      kind: "anchor",
      horizontal: {
        relativeFrom: "page",
        value: { kind: "align", align: "center" },
      },
      vertical: {
        relativeFrom: "margin",
        value: { kind: "offset", emu: 333 },
      },
      extent: { width: 7_000_000, height: 9_000_000, unit: "emu" },
      simplePos: { x: 111, y: 222, unit: "emu" },
      useSimplePos: true,
      effectExtent: {
        left: 1,
        top: 2,
        right: 3,
        bottom: 4,
        unit: "emu",
      },
      distance: {
        top: 10,
        right: 20,
        bottom: 30,
        left: 40,
        unit: "emu",
      },
      wrap: { kind: "square" },
      relativeHeight: 42,
      behindDoc: false,
      allowOverlap: true,
      layoutInCell: false,
      resolution: "local-exact",
    });
    expect(scene.transform).toEqual({
      xfrm: {
        offset: { x: 10, y: 20, unit: "emu" },
        extent: { width: 7_000_000, height: 9_000_000, unit: "emu" },
        flipH: true,
        flipV: true,
      },
      rotation: { value: 30, unit: "degree" },
    });
  });

  test("represents relationship-free shapes through inline-xml", async () => {
    const result = await analyzeDocxVisualAssets(
      visualDocx({
        document: wordDocument(inlineDrawing(undefined)),
      }),
      {
        capabilities: TEST_VISUAL_CAPABILITIES,
        assetStore: new TrackingAssetStore(),
        sections: await singleSection(),
      }
    );
    const representation = result.analysis.scenes[0]?.representations[0];

    expect(representation?.sourceUse.kind).toBe("inline-xml");
    expect(representation?.sourceUse.elementFingerprint).toMatch(
      /^[0-9a-f]{64}$/
    );
    expect(representation?.assetSha256).toBeUndefined();
  });

  test("assigns first/default/even header scenes to their effective masters without globalization", async () => {
    const documentRelationships = relationshipsXml([
      {
        id: "rHeaderDefault",
        type: officeRelationshipType("header"),
        target: "header1.xml",
      },
      {
        id: "rHeaderFirst",
        type: officeRelationshipType("header"),
        target: "header2.xml",
      },
      {
        id: "rHeaderEven",
        type: officeRelationshipType("header"),
        target: "header3.xml",
      },
    ]);
    const entries = {
      "word/header1.xml": storyDocument(inlineDrawing("rImage")),
      "word/header2.xml": storyDocument(inlineDrawing("rImage")),
      "word/header3.xml": storyDocument(inlineDrawing("rImage")),
      "word/_rels/header1.xml.rels": imageRelationships([
        { id: "rImage", target: "media/header.png" },
      ]),
      "word/_rels/header2.xml.rels": imageRelationships([
        { id: "rImage", target: "media/header.png" },
      ]),
      "word/_rels/header3.xml.rels": imageRelationships([
        { id: "rImage", target: "media/header.png" },
      ]),
      "word/media/header.png": png(100, 30),
    };
    const sections = await singleSection({
      titlePage: true,
      evenAndOddHeaders: true,
      headers: {
        default: "word/header1.xml",
        first: "word/header2.xml",
        even: "word/header3.xml",
      },
    });
    const result = await analyzeDocxVisualAssets(
      visualDocx({
        documentRelationships,
        entries,
      }),
      {
        capabilities: TEST_VISUAL_CAPABILITIES,
        assetStore: new TrackingAssetStore(),
        sections,
      }
    );

    expect(
      result.analysis.scenes.map(({ scope }) => scope.master).sort()
    ).toEqual(["default", "even", "first"]);
    expect(
      result.analysis.scenes.every(
        ({ sectionScope, scope }) =>
          sectionScope === "native" && scope.section === 0
      )
    ).toBe(true);
  });

  test("marks multi-section first pages and odd/even restarts unsupported-section-scope", async () => {
    const sections = await resolveDocxSections({
      evenAndOddHeaders: true,
      sections: [0, 1].map((section) => ({
        section,
        locator: `document.section.${section}`,
        page: {
          widthTwips: section === 0 ? 11_906 : 12_240,
          heightTwips: section === 0 ? 16_838 : 15_840,
          marginTopTwips: 1_440,
          marginRightTwips: 1_440,
          marginBottomTwips: 1_440,
          marginLeftTwips: 1_440,
        },
        titlePage: true,
        ...(section === 1 ? { pageNumberStart: 1 } : {}),
        headers: {
          default: "word/header1.xml",
          first: "word/header1.xml",
          even: "word/header1.xml",
        },
      })),
    });
    const result = await analyzeDocxVisualAssets(
      visualDocx({
        documentRelationships: relationshipsXml([
          {
            id: "rHeader",
            type: officeRelationshipType("header"),
            target: "header1.xml",
          },
        ]),
        entries: {
          "word/header1.xml": storyDocument(inlineDrawing("rImage")),
          "word/_rels/header1.xml.rels": imageRelationships([
            { id: "rImage", target: "media/header.png" },
          ]),
          "word/media/header.png": png(100, 30),
        },
      }),
      {
        capabilities: TEST_VISUAL_CAPABILITIES,
        assetStore: new TrackingAssetStore(),
        sections,
      }
    );

    expect(result.analysis.scenes).toHaveLength(6);
    expect(
      result.analysis.scenes.every(
        ({ sectionScope }) =>
          sectionScope === "unsupported-section-scope"
      )
    ).toBe(true);
    expect(
      result.analysis.scenes.some(({ id }) => id.includes(".body"))
    ).toBe(false);
  });

  test("classifies page/margin anchors as native and paragraph/line anchors as unsupported", async () => {
    const result = await analyzeDocxVisualAssets(
      visualDocx({
        document: wordDocument(
          `${anchorDrawing("rNative")}${anchorDrawing("rLayout", {
            horizontal: "paragraph",
            vertical: "line",
          })}`
        ),
        documentRelationships: imageRelationships([
          { id: "rNative", target: "media/native.png" },
          { id: "rLayout", target: "media/layout.png" },
        ]),
        entries: {
          "word/media/native.png": png(300, 300),
          "word/media/layout.png": png(300, 300),
        },
      }),
      {
        capabilities: TEST_VISUAL_CAPABILITIES,
        assetStore: new TrackingAssetStore(),
        sections: await singleSection(),
      }
    );

    expect(result.analysis.scenes.map(({ compatibility }) => compatibility)).toEqual([
      "native",
      "unsupported",
    ]);
    expect(
      result.analysis.scenes.map(({ placement }) =>
        placement?.kind === "anchor" ? placement.resolution : undefined
      )
    ).toEqual(["page-resolved", "layout-dependent"]);
  });

  test("keeps private Unicode metadata only in the private sidecar", async () => {
    const privateValues = {
      part: "word/media/秘密-😀.png",
      name: "形状-😀",
      title: "Titel-秘密",
      description: "Alt-私人",
    };
    const result = await analyzeDocxVisualAssets(
      visualDocx({
        document: wordDocument(
          inlineDrawing("rPrivate", {
            name: privateValues.name,
            title: privateValues.title,
            description: privateValues.description,
          })
        ),
        documentRelationships: imageRelationships([
          { id: "rPrivate", target: "media/秘密-😀.png" },
        ]),
        entries: { [privateValues.part]: png(20, 20) },
      }),
      {
        capabilities: TEST_VISUAL_CAPABILITIES,
        assetStore: new TrackingAssetStore(),
        sections: await singleSection(),
      }
    );
    const portable = JSON.stringify(result.analysis);
    const privateJson = JSON.stringify(result.privateSource);

    for (const value of Object.values(privateValues)) {
      expect(portable).not.toContain(value);
      expect(privateJson).toContain(value);
    }
    expect(portable).not.toContain("sourceAltText");
    expect(
      result.analysis.scenes[0]?.representations[0]?.sourceUse.altText
    ).toEqual({
      present: true,
      fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
  });

  test("inventories the unsupported feature zoo without slots or generated Typst", async () => {
    const featureZoo = [
      `<w:p><w:r><w:drawing><wp:inline><wp:extent cx="1" cy="1"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"/></a:graphic></wp:inline></w:drawing></w:r></w:p>`,
      `<w:p><w:r><w:drawing><wp:inline><wp:extent cx="1" cy="1"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/diagram"/></a:graphic></wp:inline></w:drawing></w:r></w:p>`,
      `<w:p><w:r><w:pict><v:shape id="vml"><v:textbox/></v:shape></w:pict></w:r></w:p>`,
      `<w:p><w:r><w:drawing><wp:inline><wp:extent cx="1" cy="1"/><a:graphic><a:graphicData uri="picture"><a:grpSp/></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`,
    ].join("");
    const emf = new Uint8Array(44);
    emf.set([0x20, 0x45, 0x4d, 0x46], 40);
    const result = await analyzeDocxVisualAssets(
      visualDocx({
        document: `<?xml version="1.0" encoding="UTF-8"?><w:document ${DRAWING_NAMESPACES}><w:body>${featureZoo}${inlineDrawing("rEmf")}</w:body></w:document>`,
        documentRelationships: imageRelationships([
          { id: "rEmf", target: "media/vector.emf" },
        ]),
        entries: { "word/media/vector.emf": emf },
        types: contentTypes({ emf: "image/x-emf" }),
      }),
      {
        capabilities: TEST_VISUAL_CAPABILITIES,
        assetStore: new TrackingAssetStore(),
        sections: await singleSection(),
      }
    );
    const portable = JSON.stringify(result.analysis);

    expect(result.analysis.inventory).toMatchObject({
      charts: 1,
      smartart: 1,
      vml: 1,
      groups: 1,
      textboxes: 1,
      emfWmf: 1,
    });
    expect(result.analysis.assets).toEqual([]);
    expect(result.analysis.assetReview).toEqual([]);
    expect(portable).not.toContain("template.typ");
    expect(portable).not.toContain("#image");
  });

  test("captures solid/theme backgrounds and only uniform single page borders as native", async () => {
    const body = [
      `<w:background w:color="ABCDEF" w:themeColor="accent1" w:themeTint="80"/>`,
      `<w:sectPr><w:pgBorders w:offsetFrom="page">`,
      ...["top", "right", "bottom", "left"].map(
        (side) =>
          `<w:${side} w:val="single" w:color="112233" w:sz="8"/>`
      ),
      `</w:pgBorders></w:sectPr>`,
      `<w:sectPr><w:pgBorders w:offsetFrom="text"><w:top w:val="double"/></w:pgBorders></w:sectPr>`,
    ].join("");
    const result = await analyzeDocxVisualAssets(
      visualDocx({ document: wordDocument(body) }),
      {
        capabilities: TEST_VISUAL_CAPABILITIES,
        assetStore: new TrackingAssetStore(),
        sections: await singleSection(),
      }
    );

    expect(result.analysis.backgrounds).toEqual([
      {
        story: "document",
        color: "#ABCDEF",
        themeColor: { slot: "accent1", tint: "80" },
        drawingPresent: false,
      },
    ]);
    expect(
      result.analysis.pageBorders.map(({ compatibility }) => compatibility)
    ).toEqual(["native", "unsupported"]);
  });
});
