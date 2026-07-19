import { describe, expect, it } from "bun:test";
import { PdfSettingsError, resolvePdfSettings, typstSettingsDict } from "./settings.js";
import type { PdfLogoAsset } from "./types.js";

function pngBytes(): Uint8Array {
  return new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52,
    0, 0, 0, 1, 0, 0, 0, 1,
  ]);
}

function svgBytes(inner = ""): Uint8Array {
  return new TextEncoder().encode(`<svg xmlns="http://www.w3.org/2000/svg">${inner}</svg>`);
}

function expectSettingsError(run: () => unknown, path: string): PdfSettingsError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(PdfSettingsError);
    const settingsError = error as PdfSettingsError;
    expect(settingsError.path).toBe(path);
    expect(settingsError.constraint.length).toBeGreaterThan(0);
    return settingsError;
  }
  throw new Error(`expected a PdfSettingsError at ${path}`);
}

describe("resolvePdfSettings defaults", () => {
  it("fills every Level-A default when nothing is supplied", () => {
    expect(resolvePdfSettings()).toEqual({
      page: "a4",
      orientation: "portrait",
      cover: true,
      outline: true,
      accentColor: "#4B57A3",
    });
  });

  it("is deterministic for equal input", () => {
    const input = { page: "letter" as const, orientation: "landscape" as const, headerText: "Acme" };
    expect(resolvePdfSettings(input)).toEqual(resolvePdfSettings(input));
  });

  it("normalizes accent and watermark colors and fills watermark defaults", () => {
    const resolved = resolvePdfSettings({
      accentColor: "#abcdef",
      watermark: { text: "DRAFT" },
    });
    expect(resolved.accentColor).toBe("#ABCDEF");
    expect(resolved.watermark).toEqual({
      text: "DRAFT",
      color: "#DE350B",
      opacity: 0.08,
      angle: -54,
      size: 96,
    });
  });
});

describe("resolvePdfSettings validation", () => {
  it("rejects unknown enum values", () => {
    expectSettingsError(() => resolvePdfSettings({ page: "a3" as never }), "page");
    expectSettingsError(
      () => resolvePdfSettings({ orientation: "sideways" as never }),
      "orientation"
    );
  });

  it("carries the offending value on the error", () => {
    const error = expectSettingsError(() => resolvePdfSettings({ page: "a3" as never }), "page");
    expect(error.value).toBe("a3");
  });

  it("rejects over-cap header/footer/organization text", () => {
    const long = "x".repeat(201);
    expectSettingsError(() => resolvePdfSettings({ headerText: long }), "headerText");
    expectSettingsError(() => resolvePdfSettings({ footerText: long }), "footerText");
    expectSettingsError(() => resolvePdfSettings({ organizationName: long }), "organizationName");
    // Exactly at the cap is accepted.
    expect(resolvePdfSettings({ headerText: "x".repeat(200) }).headerText).toHaveLength(200);
  });

  it("rejects an invalid accent color", () => {
    expectSettingsError(() => resolvePdfSettings({ accentColor: "not-a-color" }), "accentColor");
  });

  it("rejects an empty watermark text", () => {
    expectSettingsError(() => resolvePdfSettings({ watermark: { text: "  " } }), "watermark.text");
  });

  it("rejects watermark opacity at the 0/NaN/Infinity boundaries and clamps nothing", () => {
    expectSettingsError(
      () => resolvePdfSettings({ watermark: { text: "D", opacity: 0 } }),
      "watermark.opacity"
    );
    expectSettingsError(
      () => resolvePdfSettings({ watermark: { text: "D", opacity: Number.NaN } }),
      "watermark.opacity"
    );
    expectSettingsError(
      () => resolvePdfSettings({ watermark: { text: "D", opacity: Number.POSITIVE_INFINITY } }),
      "watermark.opacity"
    );
    expectSettingsError(
      () => resolvePdfSettings({ watermark: { text: "D", opacity: 1.0001 } }),
      "watermark.opacity"
    );
    // Upper bound 1 is inclusive.
    expect(resolvePdfSettings({ watermark: { text: "D", opacity: 1 } }).watermark?.opacity).toBe(1);
  });

  it("rejects watermark size and angle outside range", () => {
    expectSettingsError(
      () => resolvePdfSettings({ watermark: { text: "D", size: 7 } }),
      "watermark.size"
    );
    expectSettingsError(
      () => resolvePdfSettings({ watermark: { text: "D", size: 401 } }),
      "watermark.size"
    );
    expectSettingsError(
      () => resolvePdfSettings({ watermark: { text: "D", angle: -181 } }),
      "watermark.angle"
    );
    expectSettingsError(
      () => resolvePdfSettings({ watermark: { text: "D", angle: 181 } }),
      "watermark.angle"
    );
  });
});

describe("resolvePdfSettings logo validation", () => {
  it("accepts a valid PNG logo with alt", () => {
    const logo: PdfLogoAsset = { bytes: pngBytes(), mediaType: "image/png", alt: "Acme" };
    expect(resolvePdfSettings({ logo }).logo).toEqual({
      bytes: logo.bytes,
      mediaType: "image/png",
      alt: "Acme",
    });
  });

  it("accepts a sanitized SVG logo with alt", () => {
    const logo: PdfLogoAsset = { bytes: svgBytes("<rect/>"), mediaType: "image/svg+xml", alt: "Acme" };
    expect(resolvePdfSettings({ logo }).logo?.mediaType).toBe("image/svg+xml");
  });

  it("rejects PNG bytes that do not match the declared media type", () => {
    const logo: PdfLogoAsset = { bytes: svgBytes(), mediaType: "image/png", alt: "Acme" };
    expectSettingsError(() => resolvePdfSettings({ logo }), "logo.bytes");
  });

  it("rejects logos over the 5 MiB cap", () => {
    const logo: PdfLogoAsset = {
      bytes: new Uint8Array(5 * 1024 * 1024 + 1),
      mediaType: "image/png",
      alt: "Acme",
    };
    expectSettingsError(() => resolvePdfSettings({ logo }), "logo.bytes");
  });

  it("rejects a present logo with a missing or empty alt", () => {
    const png = pngBytes();
    expectSettingsError(
      () => resolvePdfSettings({ logo: { bytes: png, mediaType: "image/png" } }),
      "logo.alt"
    );
    expectSettingsError(
      () => resolvePdfSettings({ logo: { bytes: png, mediaType: "image/png", alt: "   " } }),
      "logo.alt"
    );
  });

  it("rejects SVG logos carrying scripts, event handlers, or external references", () => {
    const cases = [
      "<script>alert(1)</script>",
      "<rect onload=\"steal()\"/>",
      "<foreignObject><body/></foreignObject>",
      "<image href=\"https://evil.example/x.png\"/>",
    ];
    for (const inner of cases) {
      expectSettingsError(
        () => resolvePdfSettings({ logo: { bytes: svgBytes(inner), mediaType: "image/svg+xml", alt: "Acme" } }),
        "logo.bytes"
      );
    }
  });
});

describe("typstSettingsDict", () => {
  it("emits defaults only when nothing is supplied", () => {
    const dict = typstSettingsDict(resolvePdfSettings());
    expect(dict).toContain('page: "a4"');
    expect(dict).toContain('orientation: "portrait"');
    expect(dict).toContain("cover: true");
    expect(dict).toContain("outline: true");
    expect(dict).toContain('accent-color: "#4B57A3"');
    expect(dict).not.toContain("header-text");
    expect(dict).not.toContain("watermark:");
  });

  it("emits kebab-case keys and filled watermark defaults", () => {
    const dict = typstSettingsDict(
      resolvePdfSettings({
        page: "letter",
        orientation: "landscape",
        headerText: "Head",
        footerText: "Foot",
        organizationName: "Acme",
        watermark: { text: "DRAFT" },
      })
    );
    expect(dict).toContain('page: "letter"');
    expect(dict).toContain('orientation: "landscape"');
    expect(dict).toContain('header-text: "Head"');
    expect(dict).toContain('footer-text: "Foot"');
    expect(dict).toContain('organization-name: "Acme"');
    expect(dict).toContain("watermark: (");
    expect(dict).toContain('text: "DRAFT"');
    expect(dict).toContain('color: "#DE350B"');
    expect(dict).toContain("opacity: 0.08");
    expect(dict).toContain("angle: -54");
    expect(dict).toContain("size: 96");
  });

  it("emits the logo path and alt only when serialize supplies the asset path", () => {
    const resolved = resolvePdfSettings({
      logo: { bytes: pngBytes(), mediaType: "image/png", alt: "Acme" },
    });
    expect(typstSettingsDict(resolved)).not.toContain("logo");
    const dict = typstSettingsDict(resolved, { logoPath: "assets/atlcli-logo.png" });
    expect(dict).toContain('logo: "assets/atlcli-logo.png"');
    expect(dict).toContain('logo-alt: "Acme"');
  });

  it("keeps quote/backslash/#{ injection attempts literal in free-text fields", () => {
    const attack = 'a" #{sys.exit()} \\ end';
    const dict = typstSettingsDict(
      resolvePdfSettings({
        headerText: attack,
        footerText: attack,
        organizationName: attack,
        watermark: { text: attack },
      })
    );
    // The raw payload never appears unescaped: the closing quote is escaped and
    // no interpolation marker survives outside a string literal.
    expect(dict).not.toContain(`"${attack}"`);
    expect(dict).toContain('\\" #{sys.exit()} \\\\ end');
    // Every occurrence is inside a quoted, escaped string literal.
    expect(dict).toContain(`header-text: "${attack.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`);
  });
});
