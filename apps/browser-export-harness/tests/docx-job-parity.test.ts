import { describe, expect, it } from "bun:test";
import type { ExportReport } from "@atlcli/docx/browser";
import { buildDocx, para, pngFixtureBytes, stylesXml } from "@atlcli/docx/fixtures";
import {
  runDocxJobParityCase,
  runDocxPreparedParityCase,
} from "../src/docx-job-parity-case.js";
import {
  assertDocxJobParity,
  projectDocxReport,
} from "../src/docx-job-parity.js";

function bytes(body = "same", media?: Uint8Array): Uint8Array {
  return buildDocx({
    body: para(body),
    styles: stylesXml(),
    ...(media === undefined
      ? {}
      : { extraParts: { "word/media/image1.png": String.fromCharCode(...media) } }),
  });
}

function report(overrides: Partial<ExportReport> = {}): ExportReport {
  return {
    resolvedCount: 1,
    unsupportedNames: [],
    skippedImages: 0,
    embeddedImages: 1,
    renderedDiagrams: 1,
    durationMs: 10,
    filename: "Parity.docx",
    notes: [
      { code: "unknown-macro", level: "warning", message: "semantic warning" },
      { code: "perf-timing", level: "info", message: "10 ms" },
    ],
    sourceNotes: [],
    complete: true,
    scan: {
      supported: [],
      unsupported: [],
      never: [],
      parts: ["word/document.xml"],
      hasContentPlaceholder: true,
      stylerefStyleNames: [],
    },
    timings: {
      resolveMs: 1,
      bodyMs: 2,
      logoFetchMs: 0,
      includeFetchMs: 0,
      renderMs: 3,
      imageFetchMs: 0,
      imageFetches: 0,
      diagramRenderMs: 4,
      diagramRasterMs: 5,
    },
    ...overrides,
    codeTheme: overrides.codeTheme ?? "github-light",
  };
}

describe("DOCX direct-vs-job parity", () => {
  it("runs the production executor with independent raster ownership", async () => {
    const rasterCalls: number[] = [];
    const result = await runDocxJobParityCase({
      createRasterizer: () => {
        const index = rasterCalls.length;
        rasterCalls.push(0);
        return {
          async rasterize() {
            rasterCalls[index] += 1;
            return pngFixtureBytes(640, 360).slice();
          },
        };
      },
    });

    expect(result).toMatchObject({
      partsIdentical: true,
      mediaIdentical: true,
      reportIdentical: true,
      usedRealExecutor: true,
      usedIndependentRasterizers: true,
      ownedIndependentBytes: true,
      renderAttempts: 1,
      reservationReleased: true,
      templateResolutions: 1,
    });
    expect(result.codeTheme).toBe("dracula");
    expect(rasterCalls).toEqual([1, 1]);
  });

  it("uses independent rasterizers across the real direct and staged engine paths", async () => {
    const rasterCalls: number[] = [];
    const result = await runDocxPreparedParityCase({
      createRasterizer: () => {
        const index = rasterCalls.length;
        rasterCalls.push(0);
        return {
          async rasterize() {
            rasterCalls[index] += 1;
            return pngFixtureBytes(640, 360).slice();
          },
        };
      },
    });

    expect(result).toMatchObject({
      partsIdentical: true,
      mediaIdentical: true,
      reportIdentical: true,
      usedPreparedStages: true,
      usedIndependentRasterizers: true,
      ownedIndependentBytes: true,
    });
    expect(rasterCalls).toEqual([1, 1]);
  });

  it("accepts exact decompressed parts and ignores only host timing", () => {
    const directBytes = bytes("same", new Uint8Array([1, 2, 3]));
    const jobBytes = bytes("same", new Uint8Array([1, 2, 3]));
    const jobReport = report({
      durationMs: 999,
      timings: {
        resolveMs: 90,
        bodyMs: 80,
        logoFetchMs: 70,
        includeFetchMs: 60,
        renderMs: 50,
        imageFetchMs: 40,
        imageFetches: 0,
        diagramRenderMs: 30,
        diagramRasterMs: 20,
      },
      notes: [
        { code: "unknown-macro", level: "warning", message: "semantic warning" },
        { code: "perf-timing", level: "info", message: "999 ms" },
      ],
    });

    expect(assertDocxJobParity(
      { bytes: directBytes, report: report() },
      { bytes: jobBytes, report: jobReport },
    )).toMatchObject({
      partsIdentical: true,
      mediaIdentical: true,
      reportIdentical: true,
      mediaPartCount: 1,
    });
  });

  it("rejects a changed non-media part", () => {
    expect(() => assertDocxJobParity(
      { bytes: bytes("direct", new Uint8Array([1])), report: report() },
      { bytes: bytes("job", new Uint8Array([1])), report: report() },
    )).toThrow("word/document.xml");
  });

  it("rejects a missing or additional part", () => {
    const directBytes = buildDocx({
      body: para("same"),
      styles: stylesXml(),
      extraParts: {
        "word/media/image1.png": "media",
        "word/customXml/item1.xml": "<item/>",
      },
    });
    expect(() => assertDocxJobParity(
      { bytes: directBytes, report: report() },
      { bytes: bytes("same", new Uint8Array([1])), report: report() },
    )).toThrow("part set diverged");
  });

  it("rejects changed media bytes", () => {
    expect(() => assertDocxJobParity(
      { bytes: bytes("same", new Uint8Array([1, 2, 3])), report: report() },
      { bytes: bytes("same", new Uint8Array([1, 9, 3])), report: report() },
    )).toThrow("word/media/image1.png");
  });

  it("rejects semantic note message and provenance changes", () => {
    const changed = report({
      notes: [{
        code: "unknown-macro",
        level: "warning",
        message: "changed",
        source: { pageId: "other", blockPath: "blocks[0]" },
      }],
    });
    const sharedBytes = bytes("same", new Uint8Array([1]));
    expect(() => assertDocxJobParity(
      { bytes: sharedBytes, report: report() },
      { bytes: sharedBytes.slice(), report: changed },
    )).toThrow("report diverged");
  });

  it("does not collapse an absent sourceNotes field into an empty collection", () => {
    const sharedBytes = bytes("same", new Uint8Array([1]));
    expect(() => assertDocxJobParity(
      { bytes: sharedBytes, report: report({ sourceNotes: undefined }) },
      { bytes: sharedBytes.slice(), report: report({ sourceNotes: [] }) },
    )).toThrow("report diverged");
  });

  it("keeps the complete scan result in the report projection", () => {
    const projected = projectDocxReport(report({
      scan: {
        supported: [{ base: "$scroll.title", status: "supported", count: 1, raw: ["$scroll.title"] }],
        unsupported: [],
        never: [],
        parts: ["word/document.xml"],
        hasContentPlaceholder: true,
        stylerefStyleNames: [],
      },
    })) as { scan: unknown };
    expect(projected.scan).toEqual({
      supported: [{ base: "$scroll.title", status: "supported", count: 1, raw: ["$scroll.title"] }],
      unsupported: [],
      never: [],
      parts: ["word/document.xml"],
      hasContentPlaceholder: true,
      stylerefStyleNames: [],
    });
  });

  it("fails when the fixture does not exercise a real media part", () => {
    const noMedia = buildDocx({ body: para("same"), styles: stylesXml() });
    expect(() => assertDocxJobParity(
      { bytes: noMedia, report: report() },
      { bytes: noMedia.slice(), report: report() },
    )).toThrow("did not render a media part");
  });

  it("allows an explicitly media-free source fixture without weakening part parity", () => {
    const noMedia = buildDocx({ body: para("same"), styles: stylesXml() });
    expect(assertDocxJobParity(
      { bytes: noMedia, report: report({ embeddedImages: 0 }) },
      { bytes: noMedia.slice(), report: report({ embeddedImages: 0 }) },
      { requireMediaPart: false },
    )).toMatchObject({
      partsIdentical: true,
      mediaIdentical: true,
      reportIdentical: true,
      mediaPartCount: 0,
    });
  });
});
