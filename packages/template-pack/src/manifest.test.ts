/**
 * Manifest import-gate tests (spec 007 T2.4). Each rejection carries a typed
 * reason so a host can render an actionable hint.
 */
import { describe, expect, it } from "bun:test";
import {
  validateManifest,
  satisfiesRange,
  ManifestValidationError,
  PINNED_TYPST_VERSION,
  type ManifestErrorReason,
} from "./manifest.js";

function base(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    id: "com.acme.doc",
    name: "Acme",
    version: "1.0.0",
    engine: { kind: "typst", api: "wiki.pdf-template/v1", entry: "template.typ" },
  };
}

function expectReason(json: unknown, reason: ManifestErrorReason): void {
  try {
    validateManifest(json);
    throw new Error("expected ManifestValidationError, none thrown");
  } catch (err) {
    expect(err).toBeInstanceOf(ManifestValidationError);
    expect((err as ManifestValidationError).reason).toBe(reason);
  }
}

describe("validateManifest gate", () => {
  it("accepts a minimal valid typst manifest", () => {
    const m = validateManifest(base());
    expect(m.engine.kind).toBe("typst");
    expect(m.engine.api).toBe("wiki.pdf-template/v1");
  });

  it("accepts a valid docx manifest", () => {
    const m = validateManifest({
      ...base(),
      engine: { kind: "docx", api: "wiki.docx-template/v1", entry: "template.docx" },
    });
    expect(m.engine.kind).toBe("docx");
  });

  it("rejects an unknown schemaVersion with unknown-schema-version", () => {
    expectReason({ ...base(), schemaVersion: 2 }, "unknown-schema-version");
  });

  it("rejects an unrecognized engine.api with unknown-api", () => {
    expectReason(
      { ...base(), engine: { kind: "typst", api: "wiki.pdf-template/v2", entry: "template.typ" } },
      "unknown-api"
    );
  });

  it("rejects a docx manifest carrying the typst api with unknown-api", () => {
    expectReason(
      { ...base(), engine: { kind: "docx", api: "wiki.pdf-template/v1", entry: "template.docx" } },
      "unknown-api"
    );
  });

  it("rejects a compilerRange the pinned compiler does not satisfy", () => {
    expectReason(
      {
        ...base(),
        engine: {
          kind: "typst",
          api: "wiki.pdf-template/v1",
          entry: "template.typ",
          compilerRange: ">=0.14 <0.15",
        },
      },
      "compiler-range-mismatch"
    );
  });

  it("accepts a compilerRange the pinned compiler satisfies", () => {
    const m = validateManifest({
      ...base(),
      engine: {
        kind: "typst",
        api: "wiki.pdf-template/v1",
        entry: "template.typ",
        compilerRange: ">=0.15.1 <0.16",
      },
    });
    expect(m.engine.compilerRange).toBe(">=0.15.1 <0.16");
  });

  it("does not compiler-gate docx manifests", () => {
    const m = validateManifest({
      ...base(),
      engine: {
        kind: "docx",
        api: "wiki.docx-template/v1",
        entry: "template.docx",
        compilerRange: ">=99.0",
      },
    });
    expect(m.engine.kind).toBe("docx");
  });

  it("rejects a malformed manifest shape with shape-error", () => {
    expectReason({ ...base(), id: "" }, "shape-error");
    expectReason({ ...base(), engine: { kind: "png", api: "x", entry: "y" } }, "shape-error");
  });

  it("shape-checks requiredFonts and settings without cross-checking availability", () => {
    const m = validateManifest({
      ...base(),
      requiredFonts: [{ family: "Source Sans 3", style: "normal", weight: 400 }],
      settings: { cover: { type: "boolean", default: true } },
    });
    expect(m.requiredFonts?.[0].family).toBe("Source Sans 3");
    expect(m.settings?.cover.type).toBe("boolean");
    expectReason({ ...base(), settings: { x: { type: "wat" } } }, "shape-error");
  });

  it("validates portable asset descriptors, references, and decorations without claiming PDF support", () => {
    const sha256 = "a".repeat(64);
    const manifest = validateManifest({
      ...base(),
      assetDescriptors: {
        hero: {
          path: "assets/hero.svg",
          sha256,
          mediaType: "image/svg+xml",
          byteLength: 128,
          dimensions: { width: 1200, height: 800, unit: "pixel" },
        },
      },
      assets: {
        "asset.pageBackground": {
          descriptor: "hero",
          writer: "future.engine.writer",
          decorative: true,
        },
      },
      decorations: [
        {
          kind: "image",
          id: "future.decoration",
          writer: "future.engine.writer",
          scope: "odd",
          layer: "page-background",
          asset: "asset.pageBackground",
          placement: {
            relativeTo: "page",
            fit: "cover",
            x: "0mm",
            y: "0mm",
            width: "210mm",
            height: "297mm",
            rotation: -2,
            crop: { left: 0.1, top: 0, right: 0.1, bottom: 0 },
            clip: { kind: "rounded-rect", radius: "4mm" },
          },
          decorative: true,
        },
      ],
      canonicalSource: { api: "wiki.pdf-canonical-typst", revision: "1" },
    });
    expect(manifest.assetDescriptors?.hero.sha256).toBe(sha256);
    expect(manifest.assets?.["asset.pageBackground"]?.writer).toBe(
      "future.engine.writer"
    );
    expect(manifest.decorations?.[0]?.scope).toBe("odd");
    const decoration = manifest.decorations?.[0];
    expect(decoration?.kind === "image" && decoration.placement.clip).toEqual({
      kind: "rounded-rect",
      radius: "4mm",
    });
  });

  it("rejects asset shape, path, reference, alt, and placement-bound errors", () => {
    const sha256 = "a".repeat(64);
    const descriptor = {
      path: "assets/hero.svg",
      sha256,
      mediaType: "image/svg+xml",
      byteLength: 128,
      dimensions: { width: 1200, height: 800, unit: "pixel" },
    };
    expectReason(
      { ...base(), assetDescriptors: { hero: { ...descriptor, path: "../hero.svg" } } },
      "shape-error"
    );
    expectReason(
      { ...base(), assetDescriptors: { hero: { ...descriptor, sha256: "ABC" } } },
      "shape-error"
    );
    expectReason(
      {
        ...base(),
        assetDescriptors: { hero: descriptor },
        assets: {
          logo: {
            descriptor: "missing",
            writer: "writer.image",
            decorative: true,
          },
        },
      },
      "shape-error"
    );
    expectReason(
      {
        ...base(),
        assetDescriptors: { hero: descriptor },
        assets: {
          logo: {
            descriptor: "hero",
            writer: "writer.image",
            decorative: false,
          },
        },
      },
      "shape-error"
    );
    expectReason(
      {
        ...base(),
        assetDescriptors: { hero: descriptor },
        assets: {
          logo: {
            descriptor: "hero",
            writer: "writer.image",
            decorative: true,
          },
        },
        decorations: [
          {
            kind: "image",
            id: "decoration",
            writer: "writer.image",
            scope: "all",
            layer: "page-background",
            asset: "logo",
            placement: {
              relativeTo: "page",
              x: "0mm",
              y: "0mm",
              width: "210mm",
              height: "297mm",
              opacity: 2,
            },
            decorative: true,
          },
        ],
      },
      "shape-error"
    );
    expectReason(
      {
        ...base(),
        assetDescriptors: { hero: descriptor },
        assets: {
          logo: {
            descriptor: "hero",
            writer: "writer.image",
            decorative: true,
          },
        },
        decorations: [
          {
            kind: "image",
            id: "decoration",
            writer: "writer.image",
            scope: "all",
            layer: "page-background",
            asset: "logo",
            placement: {
              relativeTo: "page",
              x: "0mm",
              y: "0mm",
              width: "20mm",
              height: "20mm",
              clip: { kind: "circle", radius: "4mm" },
            },
            decorative: true,
          },
        ],
      },
      "shape-error",
    );
  });
});

describe("satisfiesRange", () => {
  it("supports the documented range forms", () => {
    expect(satisfiesRange("0.14.2", ">=0.14 <0.15")).toBe(true);
    expect(satisfiesRange("0.14.2", ">=0.15")).toBe(false);
    expect(satisfiesRange("0.14.2", "<0.15")).toBe(true);
    expect(satisfiesRange("0.14.2", ">0.14")).toBe(true);
    expect(satisfiesRange("0.14.2", "<=0.14.2")).toBe(true);
    expect(satisfiesRange("0.14.2", "=0.14.2")).toBe(true);
    expect(satisfiesRange("0.14.2", "0.14.2")).toBe(true);
    expect(satisfiesRange("0.14.2", "0.14.1")).toBe(false);
  });

  it("throws shape-error on an unsupported range token", () => {
    expect(() => satisfiesRange("0.14.2", "^0.14")).toThrow(ManifestValidationError);
  });

  it("gates against the pinned version by default", () => {
    expect(PINNED_TYPST_VERSION).toBe("0.15.1");
    expect(satisfiesRange(PINNED_TYPST_VERSION, ">=0.15.1 <0.16")).toBe(true);
    expect(satisfiesRange(PINNED_TYPST_VERSION, ">=0.14 <0.15")).toBe(false);
  });
});
