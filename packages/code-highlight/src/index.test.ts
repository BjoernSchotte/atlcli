import { describe, expect, test } from "bun:test";
import {
  canonicalCodeLanguage,
  CODE_LANGUAGE_IDS,
  CODE_THEME_IDS,
  DEFAULT_CODE_THEME,
  getCodeHighlightEngineId,
  highlightCode,
  InvalidCodeThemeError,
  resolveCodeTheme,
  prepareCodeHighlighting,
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
  test("uses the explicit Node/Bun Oniguruma adapter", () => {
    expect(getCodeHighlightEngineId()).toBe("oniguruma");
  });

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

  test("awaitable preload shares aliases and reports no repeated grammar work", async () => {
    const cold: number[] = [];
    const warm: number[] = [];
    await Promise.all([
      prepareCodeHighlighting(["lua"], "github-light", {
        onTiming: (timing) => cold.push(timing.grammarLoadMs),
      }),
      prepareCodeHighlighting(["Lua"], "github-light", {
        onTiming: (timing) => cold.push(timing.grammarLoadMs),
      }),
    ]);
    await prepareCodeHighlighting(["lua"], "github-light", {
      onTiming: (timing) => warm.push(timing.grammarLoadMs),
    });
    expect(cold.filter((duration) => duration > 0)).toHaveLength(1);
    expect(warm).toEqual([0]);
  });

  test("reports a concurrent grammar batch as bounded wall time", async () => {
    let timing:
      | { engineInitMs: number; grammarLoadMs: number; tokenizeMs: number }
      | undefined;
    const startedAt = performance.now();
    await prepareCodeHighlighting(
      ["typescript", "python", "java", "csharp", "rust", "shellscript"],
      "github-dark-high-contrast",
      { onTiming: (value) => { timing = value; } },
    );
    const elapsedMs = performance.now() - startedAt;

    expect(timing).toBeDefined();
    expect(timing!.engineInitMs).toBeGreaterThan(0);
    expect(timing!.grammarLoadMs).toBeGreaterThan(0);
    expect(timing!.tokenizeMs).toBe(0);
    expect(timing!.engineInitMs + timing!.grammarLoadMs).toBeLessThanOrEqual(
      elapsedMs + 5,
    );
  });
});

describe("engine module boundaries", () => {
  test("keeps concrete engines out of the shared cache/token contract", async () => {
    const shared = await Bun.file(new URL("./highlight.ts", import.meta.url)).text();
    const javascript = await Bun.file(
      new URL("./highlight-engine-javascript.ts", import.meta.url),
    ).text();
    const oniguruma = await Bun.file(
      new URL("./highlight-engine-oniguruma.ts", import.meta.url),
    ).text();

    expect(shared).not.toContain("shiki/engine/");
    expect(shared).not.toContain("shiki/wasm");
    expect(javascript).toContain("shiki/engine/javascript");
    expect(javascript).not.toContain("oniguruma");
    expect(javascript).not.toContain("shiki/wasm");
    expect(oniguruma).toContain("shiki/engine/oniguruma");
    expect(oniguruma).toContain("shiki/wasm");
    expect(oniguruma).not.toContain("shiki/engine/javascript");
  });
});
