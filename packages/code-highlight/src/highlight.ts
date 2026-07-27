import type {
  HighlighterCore,
  LanguageInput,
  ThemeInput,
} from "shiki/core";
import {
  CODE_LANGUAGE_LOADERS,
  CODE_THEME_LOADERS,
} from "./loaders.generated.js";
import {
  canonicalCodeLanguage,
  DEFAULT_CODE_THEME,
  resolveCodeTheme,
  type CodeLanguageId,
  type CodeThemeId,
  type ResolvedCodeTheme,
} from "./registry.js";
import { lockCodeHighlightEngine } from "./highlight-engine-state.js";

export * from "./registry.js";
export {
  CodeHighlightEngineConfigurationError,
  getCodeHighlightEngineId,
  installCodeHighlightEngine,
  type CodeHighlightEngine,
} from "./highlight-engine-state.js";

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

/**
 * Newly performed highlighting work. Engine and grammar timings are zero when
 * an earlier preload already populated the relevant caches.
 */
export interface CodeHighlightTiming {
  engineInitMs: number;
  grammarLoadMs: number;
  tokenizeMs: number;
}

export interface CodeHighlightOptions {
  onTiming?: (timing: CodeHighlightTiming) => void;
}

interface HighlighterRecord {
  highlighter: HighlighterCore;
  initMs: number;
}

const highlighters = new Map<CodeThemeId, Promise<HighlighterRecord>>();
const languageLoads = new Map<
  CodeThemeId,
  Map<CodeLanguageId, Promise<CodeHighlightTiming>>
>();

const ZERO_TIMING: CodeHighlightTiming = {
  engineInitMs: 0,
  grammarLoadMs: 0,
  tokenizeMs: 0,
};

function nowMs(): number {
  return typeof performance === "undefined" ? Date.now() : performance.now();
}

function addTiming(
  left: CodeHighlightTiming,
  right: CodeHighlightTiming,
): CodeHighlightTiming {
  return {
    engineInitMs: left.engineInitMs + right.engineInitMs,
    grammarLoadMs: left.grammarLoadMs + right.grammarLoadMs,
    tokenizeMs: left.tokenizeMs + right.tokenizeMs,
  };
}

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

async function getHighlighter(
  theme: CodeThemeId,
): Promise<{ highlighter: HighlighterCore; initMs: number }> {
  let promise = highlighters.get(theme);
  let created = false;
  if (!promise) {
    created = true;
    const engine = lockCodeHighlightEngine();
    promise = (async () => {
      const startedAt = nowMs();
      const [{ createHighlighterCore }, regexEngine, themeModule] =
        await Promise.all([
          import("shiki/core"),
          engine.create(),
          CODE_THEME_LOADERS[theme](),
        ]);
      const highlighter = await createHighlighterCore({
        themes: [themeModule.default as ThemeInput],
        langs: [],
        engine: regexEngine,
      });
      return { highlighter, initMs: nowMs() - startedAt };
    })();
    promise.catch(() => {
      if (highlighters.get(theme) === promise) highlighters.delete(theme);
    });
    highlighters.set(theme, promise);
  }
  const record = await promise;
  return {
    highlighter: record.highlighter,
    initMs: created ? record.initMs : 0,
  };
}

async function loadLanguage(
  theme: CodeThemeId,
  language: CodeLanguageId,
): Promise<CodeHighlightTiming> {
  let loads = languageLoads.get(theme);
  if (!loads) {
    loads = new Map();
    languageLoads.set(theme, loads);
  }
  let promise = loads.get(language);
  let created = false;
  if (!promise) {
    created = true;
    promise = (async () => {
      const startedAt = nowMs();
      const highlighterPromise = getHighlighter(theme);
      const grammarPromise = CODE_LANGUAGE_LOADERS[language]();
      const [{ highlighter, initMs }, grammarModule] = await Promise.all([
        highlighterPromise,
        grammarPromise,
      ]);
      await highlighter.loadLanguage(grammarModule.default as LanguageInput);
      // Shiki's JavaScript engine compiles grammar rules lazily. This dummy
      // tokenize belongs to grammar-load/compile time and makes the first real
      // source tokenize identical to every warm repeat.
      highlighter.codeToTokens("0;", { lang: language, theme });
      return {
        engineInitMs: initMs,
        // This is the grammar's wall time from import request through ready
        // state. On a cold theme it intentionally overlaps engineInitMs.
        grammarLoadMs: nowMs() - startedAt,
        tokenizeMs: 0,
      };
    })();
    promise.catch(() => {
      if (loads?.get(language) === promise) loads.delete(language);
    });
    loads.set(language, promise);
  }
  const timing = await promise;
  return created ? timing : ZERO_TIMING;
}

/**
 * Await highlighter initialization and only the requested known grammars.
 * Aliases and concurrent/repeated calls share the same cache promises.
 */
export async function prepareCodeHighlighting(
  languages: readonly string[],
  theme: CodeThemeId = DEFAULT_CODE_THEME,
  options: CodeHighlightOptions = {},
): Promise<void> {
  const unique = new Set(
    languages
      .map(canonicalCodeLanguage)
      .filter((language): language is CodeLanguageId => language !== undefined),
  );
  if (unique.size === 0) return;
  const timings = await Promise.all(
    [...unique].map((language) => loadLanguage(theme, language)),
  );
  options.onTiming?.(timings.reduce<CodeHighlightTiming>(
    (combined, timing) => ({
      // One theme owns one highlighter, so at most one newly created language
      // reports initialization. Sum keeps the contract correct defensively.
      engineInitMs: combined.engineInitMs + timing.engineInitMs,
      // Grammars load concurrently. The longest newly owned load is the batch
      // wall time; summing every overlapping wait would exceed export wall time.
      grammarLoadMs: Math.max(combined.grammarLoadMs, timing.grammarLoadMs),
      tokenizeMs: 0,
    }),
    ZERO_TIMING,
  ));
}

export async function highlightCode(
  code: string,
  language?: string,
  theme: CodeThemeId = DEFAULT_CODE_THEME,
  options: CodeHighlightOptions = {},
): Promise<HighlightedCode> {
  const resolvedTheme = resolveCodeTheme(theme);
  if (!language) {
    return { theme: resolvedTheme, lines: plainLines(code), skipped: null };
  }
  const canonical = canonicalCodeLanguage(language);
  if (!canonical) {
    return {
      theme: resolvedTheme,
      lines: plainLines(code),
      skipped: "unknown-language",
    };
  }
  try {
    let timing = await loadLanguage(theme, canonical);
    const { highlighter, initMs } = await getHighlighter(theme);
    if (initMs > 0) {
      timing = addTiming(timing, {
        engineInitMs: initMs,
        grammarLoadMs: 0,
        tokenizeMs: 0,
      });
    }
    const tokenizeStartedAt = nowMs();
    const result = highlighter.codeToTokens(code, { lang: canonical, theme });
    timing = addTiming(timing, {
      engineInitMs: 0,
      grammarLoadMs: 0,
      tokenizeMs: nowMs() - tokenizeStartedAt,
    });
    options.onTiming?.(timing);
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
      highlightedTextLines.some(
        (line, index) => line !== sourceTextLines[index],
      )
    ) {
      return {
        theme: resolvedTheme,
        lines: plainLines(code),
        skipped: "highlight-failed",
      };
    }
    const sourceLines = plainLines(code);
    if (lines.length < sourceLines.length) {
      lines.push(...sourceLines.slice(lines.length));
    }
    return {
      theme: resolvedTheme,
      lines,
      skipped: null,
    };
  } catch {
    return {
      theme: resolvedTheme,
      lines: plainLines(code),
      skipped: "highlight-failed",
    };
  }
}

/** Fire-and-forget compatibility wrapper around the awaitable preload. */
export function warmHighlight(
  languages: readonly string[],
  theme: CodeThemeId = DEFAULT_CODE_THEME,
): void {
  void prepareCodeHighlighting(languages, theme).catch(() => {});
}
