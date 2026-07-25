import { describe, expect, test } from "bun:test";
import {
  canonicalCodeLanguage,
  CODE_LANGUAGE_IDS,
  CODE_THEME_IDS,
  DEFAULT_CODE_THEME,
  highlightCode,
  InvalidCodeThemeError,
  resolveCodeTheme,
  warmHighlight,
} from "./index.js";

describe("catalogue", () => {
  test("ships Shiki's full pinned theme and language catalogues", async () => {
    const { bundledLanguagesInfo, bundledThemesInfo } = await import("shiki");
    expect([...CODE_THEME_IDS] as string[]).toEqual(bundledThemesInfo.map(({ id }) => id));
    expect([...CODE_LANGUAGE_IDS] as string[]).toEqual(bundledLanguagesInfo.map(({ id }) => id));
    expect(CODE_THEME_IDS.length).toBeGreaterThan(60);
    expect(CODE_LANGUAGE_IDS.length).toBeGreaterThan(200);
  });

  test("resolves every bundled alias", async () => {
    const { bundledLanguagesInfo } = await import("shiki");
    for (const language of bundledLanguagesInfo) {
      expect(canonicalCodeLanguage(language.id) as string | undefined).toBe(language.id);
      for (const alias of language.aliases ?? []) {
        expect(canonicalCodeLanguage(alias) as string | undefined).toBe(language.id);
      }
    }
  });
});

describe("themes", () => {
  test("defaults to github-light with serializable color metadata", () => {
    expect(DEFAULT_CODE_THEME).toBe("github-light");
    expect(resolveCodeTheme()).toEqual({
      id: "github-light",
      displayName: "GitHub Light",
      type: "light",
      foreground: "#24292E",
      background: "#FFFFFF",
    });
  });

  test("rejects unknown themes with a typed actionable error", () => {
    expect(() => resolveCodeTheme("not-a-theme")).toThrow(InvalidCodeThemeError);
    expect(() => resolveCodeTheme("not-a-theme")).toThrow("Choose one of:");
  });
});

describe("highlightCode", () => {
  test("highlights aliases and preserves complete source text", async () => {
    const code = "const answer: number = 42;\n";
    const result = await highlightCode(code, "ts");
    expect(result.skipped).toBeNull();
    expect(
      result.lines.map((line) => line.map(({ text }) => text).join("")).join("\n"),
    ).toBe(code);
    expect(result.lines.flat().some(({ color }) => color !== undefined)).toBeTrue();
    expect(result.lines.flat().every(({ color }) => !color || /^#[0-9A-F]{6}$/.test(color))).toBeTrue();
  });

  test("isolates concurrent themes", async () => {
    const [light, dark] = await Promise.all([
      highlightCode("const x = true", "typescript", "github-light"),
      highlightCode("const x = true", "typescript", "github-dark"),
    ]);
    expect(light.theme.id).toBe("github-light");
    expect(dark.theme.id).toBe("github-dark");
    expect(light.theme.background).not.toBe(dark.theme.background);
    expect(light.lines).not.toEqual(dark.lines);
  });

  test("unknown languages preserve source and selected theme colors", async () => {
    const result = await highlightCode("one\ntwo", "definitely-unknown", "dracula");
    expect(result.skipped).toBe("unknown-language");
    expect(result.lines).toEqual([[{ text: "one" }], [{ text: "two" }]]);
    expect(result.theme).toEqual(resolveCodeTheme("dracula"));
  });

  test("warmup accepts aliases and unknown languages without throwing", () => {
    expect(() => warmHighlight(["ts", "definitely-unknown"], "github-light")).not.toThrow();
  });
});
