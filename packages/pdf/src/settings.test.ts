import { describe, expect, it } from "bun:test";
import {
  applyBindings,
  PdfSettingsError,
  resolvePdfSettings,
  resolveTemplateLabels,
  typstSettingsDict,
} from "./settings.js";
import { BUILTIN_PDF_TEMPLATE_MANIFEST } from "./builtin-template.js";
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
    const resolved = resolvePdfSettings();
    expect(resolved).toMatchObject({
      page: "a4",
      orientation: "portrait",
      cover: true,
      outline: true,
      accentColor: "#4B57A3",
    });
    // The resolved design carries the built-in defaults (bindings applied) and
    // the labels resolve to the fallback locale.
    expect(resolved.design.branding.accent).toBe("#4B57A3");
    expect(resolved.design.page.size).toBe("a4");
    expect(resolved.design.features.cover.enabled).toBe(true);
    expect(resolved.labels.contents).toBe("Contents");
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

  it("rejects namespace-prefixed and URI-scheme SVG bypass attempts", () => {
    const cases: Array<[string, string]> = [
      ["<svg:script xmlns:svg=\"http://www.w3.org/2000/svg\">alert(1)</svg:script>", "blocked-element"],
      ["<svg:foreignObject><body/></svg:foreignObject>", "blocked-element"],
      ["<rect svg:onload=\"steal()\"/>", "event-handler-attribute"],
      ["<a href=\"javascript:alert(1)\"><rect/></a>", "non-fragment-reference"],
      ["<image href=\"../../etc/passwd\"/>", "non-fragment-reference"],
      ["<image href=\"logo-helper.svg\"/>", "non-fragment-reference"],
      ["<use xlink:href=\"https://evil.example/defs.svg#icon\"/>", "non-fragment-reference"],
      ["<image href=\"data:image/png;base64,iVBORw0KGgo=\"/>", "non-fragment-reference"],
    ];
    for (const [inner, rule] of cases) {
      const error = expectSettingsError(
        () => resolvePdfSettings({ logo: { bytes: svgBytes(inner), mediaType: "image/svg+xml", alt: "Acme" } }),
        "logo.bytes"
      );
      expect(error.constraint).toContain(rule);
    }
  });

  it("rejects SVG logos containing DOCTYPE or ENTITY declarations", () => {
    const doctype = new TextEncoder().encode(
      '<!DOCTYPE svg [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><svg xmlns="http://www.w3.org/2000/svg">&xxe;</svg>'
    );
    const error = expectSettingsError(
      () => resolvePdfSettings({ logo: { bytes: doctype, mediaType: "image/svg+xml", alt: "Acme" } }),
      "logo.bytes"
    );
    expect(error.constraint).toContain("doctype-or-entity");
  });

  it("still accepts a clean self-contained SVG with fragment references", () => {
    const clean = svgBytes(
      '<defs><linearGradient id="g"><stop offset="0"/></linearGradient><rect id="r" fill="url(#g)"/></defs><use href="#r"/><use xlink:href="#r"/>'
    );
    const resolved = resolvePdfSettings({
      logo: { bytes: clean, mediaType: "image/svg+xml", alt: "Acme" },
    });
    expect(resolved.logo?.mediaType).toBe("image/svg+xml");
  });
});

describe("resolvePdfSettings text caps and re-resolution", () => {
  it("counts the 200 cap in Unicode code points, not UTF-16 code units", () => {
    // 150 astral code points = 300 UTF-16 units: must be accepted.
    const emoji = "🚀".repeat(150);
    expect(resolvePdfSettings({ headerText: emoji }).headerText).toBe(emoji);
    const error = expectSettingsError(
      () => resolvePdfSettings({ headerText: "🚀".repeat(201) }),
      "headerText"
    );
    expect(error.constraint).toContain("Unicode code points");
  });

  it("returns an already-resolved settings object unchanged without re-validating", () => {
    let pageReads = 0;
    const raw = {
      get page(): "letter" {
        pageReads += 1;
        return "letter";
      },
    };
    const resolved = resolvePdfSettings(raw);
    expect(pageReads).toBe(1);
    expect(resolvePdfSettings(resolved)).toBe(resolved);
    expect(pageReads).toBe(1);
  });
});

describe("resolver: bindings, locale, labels (spec 012)", () => {
  const design = BUILTIN_PDF_TEMPLATE_MANIFEST.design!;

  it("applies a binding to the correct design path without mutating the manifest", () => {
    const bound = applyBindings(
      design,
      [{ setting: "accentColor", targets: ["branding.accent", "tokens.colors.accent"] }],
      resolvePdfSettings({ accentColor: "#0052CC" })
    );
    expect(bound.branding.accent).toBe("#0052CC");
    expect(bound.tokens.colors.accent).toBe("#0052CC");
    // The manifest's design is untouched (immutable copy).
    expect(design.branding.accent).toBe("#4B57A3");
  });

  it("leaves the manifest default in place when the source value is undefined", () => {
    const bound = applyBindings(
      design,
      [{ setting: "organizationName", targets: ["branding.organizationName"] }],
      { ...resolvePdfSettings() } // no organizationName
    );
    expect(bound.branding.organizationName).toBeUndefined();
  });

  it("rejects two bindings writing the same design path", () => {
    expect(() =>
      applyBindings(
        design,
        [
          { setting: "accentColor", targets: ["branding.accent"] },
          { setting: "page", targets: ["branding.accent"] },
        ],
        resolvePdfSettings({ accentColor: "#0052CC", page: "letter" })
      )
    ).toThrow(/more than one binding/);
  });

  it("resolves labels through the region → base-language fallback chain", () => {
    // de-CH has no entry; the base language de wins.
    const deCh = resolveTemplateLabels(BUILTIN_PDF_TEMPLATE_MANIFEST, "de", "CH");
    expect(deCh.contents).toBe("Inhalt");
    expect(deCh.endOfDocument).toBe("DOKUMENTENDE");
    // fr has no entry; falls through to the fallback/default English.
    const fr = resolveTemplateLabels(BUILTIN_PDF_TEMPLATE_MANIFEST, "fr", undefined);
    expect(fr.contents).toBe("Contents");
  });

  it("resolvePdfSettings threads the document locale into resolved labels", () => {
    expect(resolvePdfSettings({}, { locale: "de" }).labels.contents).toBe("Inhalt");
    expect(resolvePdfSettings({}, { locale: "en" }).labels.contents).toBe("Contents");
  });

  // Layer 2 of the label-injection defence: even a manifest object that never
  // went through validateManifest (constructed directly, or from a future
  // schema) can only contribute the DECLARED v1 label vocabulary. An unknown
  // key — hostile or merely unexpected — never reaches emission.
  it("resolves only the declared document-label vocabulary, dropping unknown keys", () => {
    const hostile = 'x: panic("pwned"), y';
    const forged = {
      ...BUILTIN_PDF_TEMPLATE_MANIFEST,
      localization: {
        defaultLocale: "en",
        fallbackLocale: "en",
        locales: {
          en: {
            template: { name: "T", description: "D" },
            document: { contents: "Contents", [hostile]: "boom", unexpectedButSafe: "x" },
          },
        },
      },
    };
    const labels = resolveTemplateLabels(forged, "en", undefined);
    expect(labels[hostile]).toBeUndefined();
    expect(labels.unexpectedButSafe).toBeUndefined();
    expect(labels.contents).toBe("Contents");
    // …and what survives is emittable.
    expect(() => typstSettingsDict({ ...resolvePdfSettings(), labels })).not.toThrow();
  });
});

describe("typstSettingsDict", () => {
  it("emits the design subset and labels when nothing is supplied", () => {
    const dict = typstSettingsDict(resolvePdfSettings());
    expect(dict).toContain('accent: "#4B57A3"');
    expect(dict).toContain('size: "a4"');
    expect(dict).toContain('orientation: "portrait"');
    expect(dict).toContain("cover: (enabled: true)");
    expect(dict).toContain("outline: (enabled: true, depth: 3)");
    expect(dict).toContain("labels: (");
    expect(dict).toContain('version: "Version"');
    expect(dict).not.toContain("header-text");
    expect(dict).not.toContain("watermark:");
  });

  it("emits the settings-driven design subset and filled watermark defaults", () => {
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
    expect(dict).toContain('size: "letter"');
    expect(dict).toContain('orientation: "landscape"');
    expect(dict).toContain('organization-name: "Acme"');
    expect(dict).toContain('header-text: "Head"');
    expect(dict).toContain('footer-text: "Foot"');
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

  it("emits validated imported-logo placement for the canonical template", () => {
    const resolved = resolvePdfSettings({
      logo: { bytes: pngBytes(), mediaType: "image/png", alt: "Acme" },
    });
    resolved.templateVisuals = {
      assets: {
        "asset.logo": {
          vfsPath: "template-assets/logo.png",
          reference: {
            descriptor: "logo",
            writer: "typst.logo",
            decorative: false,
            alt: "Acme",
            placement: {
              relativeTo: "margin",
              fit: "contain",
              x: "-1.94mm",
              y: "-0.423mm",
              width: "49.989mm",
              height: "11.342mm",
            },
          },
        },
      },
      decorations: [],
    };

    const dict = typstSettingsDict(resolved, {
      logoPath: "template-assets/logo.png",
    });
    expect(dict).toContain("logo-placement: (");
    expect(dict).toContain('relativeTo: "margin"');
    expect(dict).toContain("x: -1.94mm");
    expect(dict).toContain("y: -0.423mm");
    expect(dict).toContain("width: 49.989mm");
    expect(dict).toContain("height: 11.342mm");
    expect(dict).toContain("rotation: 0");
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

  it("escapes hostile label strings so a manifest label can never inject Typst (spec 012)", () => {
    const resolved = resolvePdfSettings();
    resolved.labels = { ...resolved.labels, contents: 'X" #{sys.exit()} \\ end' };
    const dict = typstSettingsDict(resolved);
    expect(dict).toContain('contents: "X\\" #{sys.exit()} \\\\ end"');
    expect(dict).not.toContain('contents: "X" #{sys.exit()}');
  });

  // Layer 3 of the label-injection defence: a dictionary KEY is emitted
  // unquoted, so `typstString` cannot protect it. Even if a hostile key somehow
  // reached the resolved labels (bypassing the manifest import gate AND the
  // vocabulary filter), emission must hard-fail rather than write it out.
  it("refuses to emit a label dictionary key that is not a safe identifier", () => {
    for (const key of ['x: panic("pwned"), y', "#let evil = 1", "a`b", "has space"]) {
      const resolved = resolvePdfSettings();
      resolved.labels = { ...resolved.labels, [key]: "boom" };
      expect(() => typstSettingsDict(resolved)).toThrow(/safe identifier/);
    }
  });
});
