import { describe, expect, test } from "bun:test";
import type { TemplateCapabilityCatalogV1 } from "@atlcli/template-pack";
import { matchDocxTemplate } from "./matching.js";
import { resolveDocxSections } from "./section-resolution.js";
import { resolveDocxStyles } from "./style-resolution.js";
import {
  canonicalDocxThemeDefinition,
  resolveDocxThemeColor,
  resolveDocxThemeFont,
  type DocxThemeDefinitionV1,
} from "./theme-resolution.js";

const THEME: DocxThemeDefinitionV1 = {
  colors: {
    accent1: "336699",
    dark: "#112233",
    light: "FFFFFF",
  },
  colorMapping: { t1: "accent1" },
  fonts: {
    major: {
      ascii: "Source Sans 3",
      hAnsi: "Source Sans 3",
      eastAsia: "Noto Sans CJK",
      cs: "Noto Naskh Arabic",
    },
    minor: { ascii: "Source Serif 4" },
  },
};

const catalog: TemplateCapabilityCatalogV1 = {
  schema: "atlcli.template-capability-catalog/1",
  id: "test.theme",
  version: 1,
  descriptors: [
    {
      path: "tokens.colors.accent",
      valueKind: "color",
      required: true,
      consumers: ["test"],
    },
  ],
};

describe("DOCX theme resolution", () => {
  test("resolves color mapping, tint, and shade to canonical RGB", () => {
    expect(
      resolveDocxThemeColor(
        { theme: "text1", tint: "80", shade: "80" },
        THEME
      )
    ).toBe("#4D5966");
    expect(resolveDocxThemeColor({ rgb: "abcdef" }, THEME)).toBe("#ABCDEF");
    expect(resolveDocxThemeColor({ theme: "dark" }, THEME)).toBe("#112233");
    expect(
      resolveDocxThemeColor(
        { theme: "dark1" },
        { ...THEME, colors: { ...THEME.colors, dk1: "010203" } }
      )
    ).toBe("#010203");
    expect(resolveDocxThemeColor({ rgb: "invalid" }, THEME)).toBeUndefined();
  });

  test("resolves theme fonts independently for every Word script", () => {
    expect(
      resolveDocxThemeFont({ theme: "major-ascii" }, "ascii", THEME)
    ).toBe("Source Sans 3");
    expect(
      resolveDocxThemeFont({ theme: "major-eastAsia" }, "eastAsia", THEME)
    ).toBe("Noto Sans CJK");
    expect(resolveDocxThemeFont({ theme: "major-cs" }, "cs", THEME)).toBe(
      "Noto Naskh Arabic"
    );
    expect(
      resolveDocxThemeFont(
        { family: "Explicit Family", theme: "major-ascii" },
        "ascii",
        THEME
      )
    ).toBe("Explicit Family");
  });

  test("canonicalizes equivalent theme maps independently of insertion order", () => {
    expect(
      canonicalDocxThemeDefinition({
        colors: { light: "ffffff", accent1: "#336699", dark: "112233" },
        colorMapping: { t1: "accent1" },
        fonts: THEME.fonts,
      })
    ).toEqual(canonicalDocxThemeDefinition(THEME));
  });

  test("equivalent explicit and theme-derived colors have the same candidate fingerprint", async () => {
    const styles = await resolveDocxStyles({ styles: [], usage: [] });
    const sections = await resolveDocxSections({
      evenAndOddHeaders: false,
      sections: [],
    });
    const base = {
      analysisDigest: "analysis-a",
      catalog,
      styles,
      theme: THEME,
      sections,
      bundledFontFamilies: [],
    };
    const fromTheme = await matchDocxTemplate({
      ...base,
      centralColors: [
        {
          concept: "accent",
          reference: { theme: "text1", tint: "80", shade: "80" },
          locator: "theme.accent",
        },
      ],
    });
    const explicit = await matchDocxTemplate({
      ...base,
      analysisDigest: "analysis-b",
      centralColors: [
        {
          concept: "accent",
          reference: { rgb: "4D5966" },
          locator: "theme.accent",
        },
      ],
    });
    expect(fromTheme.candidates).toHaveLength(1);
    expect(explicit.candidates).toHaveLength(1);
    expect(fromTheme.candidates[0]?.candidateFingerprint).toBe(
      explicit.candidates[0]?.candidateFingerprint
    );
    expect(fromTheme.candidates[0]?.id).not.toBe(explicit.candidates[0]?.id);
  });
});
