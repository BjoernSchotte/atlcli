import type { HighlighterCore, LanguageInput, ThemeInput } from "shiki/core";
// Import the catalogue-only entrypoints. Importing `shiki` also re-exports its
// full singleton bundle; Bun's monolithic CLI bundler can then retain a broken
// `bundle_full_exports` initializer even though this package never uses it.
import { bundledLanguages } from "shiki/langs";
import { bundledThemes } from "shiki/themes";
import {
  canonicalCodeLanguage,
  DEFAULT_CODE_THEME,
  resolveCodeTheme,
  type CodeLanguageId,
  type CodeThemeId,
  type ResolvedCodeTheme,
} from "./registry.js";

export * from "./registry.js";

export interface CodeToken {
  text: string;
  color?: `#${string}`;
}

export type CodeLine = CodeToken[];
export type HighlightSkip = "unknown-language" | "highlight-failed";

export interface HighlightedCode {
  theme: ResolvedCodeTheme;
  lines: CodeLine[];
  skipped: HighlightSkip | null;
}

/** Backward-friendly name for consumers migrating from engine-local adapters. */
export type HighlightResult = HighlightedCode;

const highlighters = new Map<CodeThemeId, Promise<HighlighterCore>>();
const languageLoads = new Map<CodeThemeId, Map<CodeLanguageId, Promise<void>>>();

function opaqueHex(value: string, background: `#${string}`): `#${string}` {
  const source = value.slice(1);
  const expanded =
    source.length === 3 || source.length === 4
      ? [...source].map((digit) => digit + digit).join("")
      : source;
  if (expanded.length !== 8) return `#${expanded.slice(0, 6).toUpperCase()}`;
  const alpha = Number.parseInt(expanded.slice(6), 16) / 255;
  const bg = background.slice(1);
  const channels = [0, 2, 4].map((offset) =>
    Math.round(
      Number.parseInt(expanded.slice(offset, offset + 2), 16) * alpha +
        Number.parseInt(bg.slice(offset, offset + 2), 16) * (1 - alpha),
    )
      .toString(16)
      .padStart(2, "0"),
  );
  return `#${channels.join("").toUpperCase()}`;
}

function plainLines(code: string): CodeLine[] {
  return code.split("\n").map((line) => [{ text: line }]);
}

async function getHighlighter(theme: CodeThemeId): Promise<HighlighterCore> {
  let promise = highlighters.get(theme);
  if (!promise) {
    promise = (async () => {
      const [{ createHighlighterCore }, engine, themeModule] =
        await Promise.all([
          import("shiki/core"),
          createEngine(),
          bundledThemes[theme](),
        ]);
      const loadedTheme =
        "default" in themeModule ? themeModule.default : themeModule;
      return createHighlighterCore({
        themes: [loadedTheme as ThemeInput],
        langs: [],
        engine,
      });
    })();
    promise.catch(() => {
      if (highlighters.get(theme) === promise) highlighters.delete(theme);
    });
    highlighters.set(theme, promise);
  }
  return promise;
}

function canCompileWasm(): boolean {
  try {
    return (
      typeof WebAssembly !== "undefined" &&
      new WebAssembly.Module(
        Uint8Array.of(0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00),
      ) instanceof WebAssembly.Module
    );
  } catch {
    return false;
  }
}

async function createEngine(): Promise<import("shiki/core").RegexEngine> {
  if (canCompileWasm()) {
    try {
      const { createOnigurumaEngine } = await import("shiki/engine/oniguruma");
      return await createOnigurumaEngine(import("shiki/wasm"));
    } catch {
      // MV3 without wasm-unsafe-eval and other CSP-restricted hosts use JS.
    }
  }
  const { createJavaScriptRegexEngine } = await import("shiki/engine/javascript");
  return createJavaScriptRegexEngine();
}

async function loadLanguage(theme: CodeThemeId, language: CodeLanguageId): Promise<void> {
  let loads = languageLoads.get(theme);
  if (!loads) {
    loads = new Map();
    languageLoads.set(theme, loads);
  }
  let promise = loads.get(language);
  if (!promise) {
    promise = (async () => {
      const [highlighter, grammarModule] = await Promise.all([
        getHighlighter(theme),
        bundledLanguages[language](),
      ]);
      const grammar =
        "default" in grammarModule ? grammarModule.default : grammarModule;
      await highlighter.loadLanguage(grammar as LanguageInput);
      highlighter.codeToTokens("0;", { lang: language, theme });
    })();
    promise.catch(() => {
      if (loads?.get(language) === promise) loads.delete(language);
    });
    loads.set(language, promise);
  }
  return promise;
}

export async function highlightCode(
  code: string,
  language?: string,
  theme: CodeThemeId = DEFAULT_CODE_THEME,
): Promise<HighlightedCode> {
  const resolvedTheme = resolveCodeTheme(theme);
  if (!language) {
    return { theme: resolvedTheme, lines: plainLines(code), skipped: null };
  }
  const canonical = canonicalCodeLanguage(language);
  if (!canonical) {
    return { theme: resolvedTheme, lines: plainLines(code), skipped: "unknown-language" };
  }
  try {
    await loadLanguage(theme, canonical);
    const highlighter = await getHighlighter(theme);
    const result = highlighter.codeToTokens(code, { lang: canonical, theme });
    const lines: CodeLine[] = result.tokens.map((line) =>
      line.map((token) => ({
        text: token.content,
        ...(token.color
          ? { color: opaqueHex(token.color, resolvedTheme.background) }
          : {}),
      })),
    );
    const sourceTextLines = code.split("\n");
    const highlightedTextLines = lines.map((line) =>
      line.map((token) => token.text).join(""),
    );
    if (
      lines.length > sourceTextLines.length ||
      highlightedTextLines.some((line, index) => line !== sourceTextLines[index])
    ) {
      return {
        theme: resolvedTheme,
        lines: plainLines(code),
        skipped: "highlight-failed",
      };
    }
    const sourceLines = plainLines(code);
    if (lines.length < sourceLines.length) lines.push(...sourceLines.slice(lines.length));
    return {
      theme: resolvedTheme,
      lines,
      skipped: null,
    };
  } catch {
    return { theme: resolvedTheme, lines: plainLines(code), skipped: "highlight-failed" };
  }
}

export function warmHighlight(
  languages: readonly string[],
  theme: CodeThemeId = DEFAULT_CODE_THEME,
): void {
  const unique = new Set(
    languages
      .map(canonicalCodeLanguage)
      .filter((language): language is CodeLanguageId => language !== undefined),
  );
  for (const language of unique) void loadLanguage(theme, language).catch(() => {});
}
