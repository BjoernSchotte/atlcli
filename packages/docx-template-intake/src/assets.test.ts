import { describe, expect, test } from "bun:test";
import { analyzeDocxVisualAssets } from "./visual-analysis.js";
import {
  TEST_VISUAL_CAPABILITIES,
  TrackingAssetStore,
  imageRelationships,
  inlineDrawing,
  jpeg,
  png,
  singleSection,
  svg,
  visualDocx,
  wordDocument,
} from "./visual-test-support.js";

describe("DOCX visual asset intake", () => {
  test("deduplicates identical bytes from two parts while retaining two scenes", async () => {
    const bytes = png(120, 40);
    const docx = visualDocx({
      document: wordDocument(
        `${inlineDrawing("rIdA")}${inlineDrawing("rIdB")}`
      ),
      documentRelationships: imageRelationships([
        { id: "rIdA", target: "media/first.png" },
        { id: "rIdB", target: "media/second.png" },
      ]),
      entries: {
        "word/media/first.png": bytes,
        "word/media/second.png": bytes,
      },
    });
    const store = new TrackingAssetStore();
    const result = await analyzeDocxVisualAssets(docx, {
      capabilities: TEST_VISUAL_CAPABILITIES,
      assetStore: store,
      sections: await singleSection(),
    });

    expect(result.analysis.assets).toHaveLength(1);
    expect(result.analysis.scenes).toHaveLength(2);
    expect(result.analysis.assetReview[0]?.occurrenceCount).toBe(2);
    expect(new Set(
      result.analysis.scenes.flatMap(({ representations }) =>
        representations.map(({ assetSha256 }) => assetSha256)
      )
    ).size).toBe(1);
    expect(store.puts).toBe(1);
    expect(structuredClone(result.analysis.assetReview[0])).toEqual(
      result.analysis.assetReview[0]
    );
  });

  test("rejects wrong content types, corrupt magic, and incomplete raster headers", async () => {
    const docx = visualDocx({
      document: wordDocument(
        `${inlineDrawing("rPng")}${inlineDrawing("rJpeg")}${inlineDrawing("rSvg")}${inlineDrawing("rJpegType")}${inlineDrawing("rSvgType")}`
      ),
      documentRelationships: imageRelationships([
        { id: "rPng", target: "media/wrong.jpg" },
        { id: "rJpeg", target: "media/corrupt.png" },
        { id: "rSvg", target: "media/not-svg.svg" },
        { id: "rJpegType", target: "media/jpeg-as-png.png" },
        { id: "rSvgType", target: "media/svg-as-jpeg.jpg" },
      ]),
      entries: {
        "word/media/wrong.jpg": png(10, 10),
        "word/media/corrupt.png": new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
        "word/media/not-svg.svg": new TextEncoder().encode("<not-svg/>"),
        "word/media/jpeg-as-png.png": jpeg(10, 10),
        "word/media/svg-as-jpeg.jpg": svg(),
      },
    });
    const store = new TrackingAssetStore();
    const result = await analyzeDocxVisualAssets(docx, {
      capabilities: TEST_VISUAL_CAPABILITIES,
      assetStore: store,
      sections: await singleSection(),
    });

    expect(result.analysis.assets).toEqual([]);
    expect(store.puts).toBe(0);
    expect(
      result.analysis.diagnostics.filter(
        ({ code }) => code === "DOCX_VISUAL_ASSET_CORRUPT"
      )
    ).toHaveLength(5);
  });

  test("enforces width, height, pixel, path, and filter budgets before downstream compilation", async () => {
    const tooManyPaths = Array.from(
      { length: TEST_VISUAL_CAPABILITIES.svg.maxPathElements + 1 },
      () => `<path d="M0 0L1 1"/>`
    ).join("");
    const tooManyFilters = `<filter>${Array.from(
      { length: TEST_VISUAL_CAPABILITIES.svg.maxFilterPrimitives + 1 },
      () => `<feGaussianBlur stdDeviation="1"/>`
    ).join("")}</filter>`;
    const targets = [
      ["rWidth", "width.png", png(TEST_VISUAL_CAPABILITIES.maxWidth + 1, 1)],
      ["rHeight", "height.png", png(1, TEST_VISUAL_CAPABILITIES.maxHeight + 1)],
      ["rPixels", "pixels.png", png(800, 800)],
      ["rPaths", "paths.svg", svg(tooManyPaths)],
      ["rFilters", "filters.svg", svg(tooManyFilters)],
      [
        "rBytes",
        "bytes.png",
        new Uint8Array(TEST_VISUAL_CAPABILITIES.maxBytes + 1),
      ],
      [
        "rValid",
        "valid.png",
        png(TEST_VISUAL_CAPABILITIES.maxWidth, 500),
      ],
      ["rJpeg", "valid.jpg", jpeg(640, 480)],
    ] as const;
    const docx = visualDocx({
      document: wordDocument(
        targets.map(([id]) => inlineDrawing(id)).join("")
      ),
      documentRelationships: imageRelationships(
        targets.map(([id, target]) => ({ id, target: `media/${target}` }))
      ),
      entries: Object.fromEntries(
        targets.map(([, target, bytes]) => [`word/media/${target}`, bytes])
      ),
    });
    const store = new TrackingAssetStore();
    let compilerCalls = 0;
    const result = await analyzeDocxVisualAssets(docx, {
      capabilities: TEST_VISUAL_CAPABILITIES,
      assetStore: store,
      sections: await singleSection(),
    });
    const invokeCompiler = (): void => {
      compilerCalls += 1;
    };

    expect(
      result.analysis.diagnostics
        .filter(({ code }) => code === "DOCX_VISUAL_ASSET_LIMIT")
        .map(({ params }) => params.reason)
        .sort()
    ).toEqual([
      "bytes",
      "height",
      "pixels",
      "svg-filters",
      "svg-paths",
      "width",
    ]);
    expect(result.analysis.assets).toHaveLength(2);
    expect(store.puts).toBe(2);
    expect(compilerCalls).toBe(0);
    expect(invokeCompiler).toBeFunction();
  });

  test("routes the hostile SVG corpus through the shared SVG policy", async () => {
    const hostile = [
      `<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>`,
      `<svg xmlns="http://www.w3.org/2000/svg" onload="x()"/>`,
      `<svg xmlns="http://www.w3.org/2000/svg"><image href="https://invalid.test/x"/></svg>`,
      `<svg xmlns="http://www.w3.org/2000/svg"><style>@import "https://invalid.test/x";</style></svg>`,
      `<!DOCTYPE svg [<!ENTITY x "y">]><svg xmlns="http://www.w3.org/2000/svg"/>`,
    ];
    for (const [index, source] of hostile.entries()) {
      const id = `rSvg${index}`;
      const docx = visualDocx({
        document: wordDocument(inlineDrawing(id)),
        documentRelationships: imageRelationships([
          { id, target: `media/hostile-${index}.svg` },
        ]),
        entries: {
          [`word/media/hostile-${index}.svg`]:
            new TextEncoder().encode(source),
        },
      });
      const store = new TrackingAssetStore();
      const result = await analyzeDocxVisualAssets(docx, {
        capabilities: TEST_VISUAL_CAPABILITIES,
        assetStore: store,
        sections: await singleSection(),
      });
      expect(result.analysis.assets, `hostile SVG ${index}`).toEqual([]);
      expect(store.puts, `hostile SVG ${index}`).toBe(0);
      expect(
        result.analysis.diagnostics.some(
          ({ code }) => code === "DOCX_VISUAL_SVG_UNSAFE"
        )
      ).toBe(true);
    }
  });

  test("never fetches, stores, or proposes an external image", async () => {
    const externalTarget = "https://invalid.test/private/image.png?secret=x";
    const docx = visualDocx({
      document: wordDocument(inlineDrawing("rExternal")),
      documentRelationships: imageRelationships([
        { id: "rExternal", target: externalTarget, external: true },
      ]),
    });
    const store = new TrackingAssetStore();
    const result = await analyzeDocxVisualAssets(docx, {
      capabilities: TEST_VISUAL_CAPABILITIES,
      assetStore: store,
      sections: await singleSection(),
    });
    const portable = JSON.stringify(result.analysis);

    expect(store.puts).toBe(0);
    expect(result.analysis.inventory.externalImages).toBe(1);
    expect(result.analysis.assets).toEqual([]);
    expect(result.analysis.assetReview).toEqual([]);
    expect(
      result.analysis.scenes.every(
        ({ compatibility }) => compatibility === "unsupported"
      )
    ).toBe(true);
    expect(portable).not.toContain("invalid.test");
    expect(portable).not.toContain("secret");
    expect(JSON.stringify(result.privateSource)).not.toContain(externalTarget);
  });

  test("rejects an asset store that returns a path-shaped or inconsistent handle", async () => {
    const docx = visualDocx({
      document: wordDocument(inlineDrawing("rImage")),
      documentRelationships: imageRelationships([
        { id: "rImage", target: "media/image.png" },
      ]),
      entries: { "word/media/image.png": png(10, 10) },
    });
    await expect(
      analyzeDocxVisualAssets(docx, {
        capabilities: TEST_VISUAL_CAPABILITIES,
        assetStore: {
          async put(candidate) {
            return {
              id: "/Users/private/image.png",
              sha256: candidate.sha256,
              mediaType: candidate.mediaType,
              byteLength: candidate.bytes.byteLength,
            };
          },
          async get() {
            return new Uint8Array();
          },
          async verify() {},
        },
        sections: await singleSection(),
      })
    ).rejects.toThrow("unsafe handle");
  });
});
