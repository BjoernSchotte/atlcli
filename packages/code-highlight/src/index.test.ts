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
import {
  CODE_LANGUAGE_LOADERS,
  CODE_THEME_LOADERS,
} from "./loaders.generated.js";

describe("catalogue", () => {
  test("ships Shiki's full pinned theme and language catalogues", async () => {
    const { bundledLanguagesInfo, bundledThemesInfo } = await import("shiki");
    expect([...CODE_THEME_IDS] as string[]).toEqual(bundledThemesInfo.map(({ id }) => id));
    expect([...CODE_LANGUAGE_IDS] as string[]).toEqual(bundledLanguagesInfo.map(({ id }) => id));
    expect(CODE_THEME_IDS.length).toBeGreaterThan(60);
    expect(CODE_LANGUAGE_IDS.length).toBeGreaterThan(200);
  });

  test("maps every public runtime ID to exactly one fine-grained loader", () => {
    expect(Object.keys(CODE_LANGUAGE_LOADERS)).toEqual([...CODE_LANGUAGE_IDS]);
    expect(Object.keys(CODE_THEME_LOADERS)).toEqual([...CODE_THEME_IDS]);
    expect(new Set(Object.keys(CODE_LANGUAGE_LOADERS)).size).toBe(
      CODE_LANGUAGE_IDS.length,
    );
    expect(new Set(Object.keys(CODE_THEME_LOADERS)).size).toBe(
      CODE_THEME_IDS.length,
    );
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
    // Cold engine and grammar work overlap. Each phase reports its own wall
    // time, so they are individually bounded but are no longer additive.
    expect(
      Math.max(timing!.engineInitMs, timing!.grammarLoadMs),
    ).toBeLessThanOrEqual(elapsedMs + 5);
  });

  test("loads only the selected direct grammar and theme modules", async () => {
    const originalLanguageLoader = CODE_LANGUAGE_LOADERS.ada;
    const originalThemeLoader = CODE_THEME_LOADERS["ayu-light"];
    let languageLoads = 0;
    let themeLoads = 0;
    CODE_LANGUAGE_LOADERS.ada = async () => {
      languageLoads += 1;
      return originalLanguageLoader();
    };
    CODE_THEME_LOADERS["ayu-light"] = async () => {
      themeLoads += 1;
      return originalThemeLoader();
    };
    try {
      await prepareCodeHighlighting(["ada"], "ayu-light");
      await prepareCodeHighlighting(["ada"], "ayu-light");
      expect(languageLoads).toBe(1);
      expect(themeLoads).toBe(1);
    } finally {
      CODE_LANGUAGE_LOADERS.ada = originalLanguageLoader;
      CODE_THEME_LOADERS["ayu-light"] = originalThemeLoader;
    }
  });

  test("retries a rejected direct grammar load", async () => {
    const originalLoader = CODE_LANGUAGE_LOADERS.abap;
    let attempts = 0;
    CODE_LANGUAGE_LOADERS.abap = async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("synthetic grammar load failure");
      return originalLoader();
    };
    try {
      await expect(
        prepareCodeHighlighting(["abap"], "andromeeda"),
      ).rejects.toThrow("synthetic grammar load failure");
      await prepareCodeHighlighting(["abap"], "andromeeda");
      expect(attempts).toBe(2);
    } finally {
      CODE_LANGUAGE_LOADERS.abap = originalLoader;
    }
  });

  test("retries a rejected direct theme load", async () => {
    const originalLoader = CODE_THEME_LOADERS["aurora-x"];
    let attempts = 0;
    CODE_THEME_LOADERS["aurora-x"] = async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("synthetic theme load failure");
      return originalLoader();
    };
    try {
      await expect(
        prepareCodeHighlighting(["actionscript-3"], "aurora-x"),
      ).rejects.toThrow("synthetic theme load failure");
      await prepareCodeHighlighting(["actionscript-3"], "aurora-x");
      expect(attempts).toBe(2);
    } finally {
      CODE_THEME_LOADERS["aurora-x"] = originalLoader;
    }
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

  test("keeps aggregate Shiki catalogues out of runtime source", async () => {
    const runtimeSources = await Promise.all(
      ["./highlight.ts", "./loaders.generated.ts"].map((path) =>
        Bun.file(new URL(path, import.meta.url)).text(),
      ),
    );
    for (const source of runtimeSources) {
      expect(source).not.toMatch(/\bfrom\s+["']shiki["']/);
      expect(source).not.toContain('"shiki/langs"');
      expect(source).not.toContain('"shiki/themes"');
    }
    expect(
      runtimeSources[1]!.match(/import\("@shikijs\/langs\//g),
    ).toHaveLength(CODE_LANGUAGE_IDS.length);
    expect(
      runtimeSources[1]!.match(/import\("@shikijs\/themes\//g),
    ).toHaveLength(CODE_THEME_IDS.length);
  });
});
