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
          compilerRange: ">=0.15 <0.16",
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
        compilerRange: ">=0.14 <0.15",
      },
    });
    expect(m.engine.compilerRange).toBe(">=0.14 <0.15");
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
    expect(PINNED_TYPST_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
