import {
  canonicalCodeLanguage,
  DEFAULT_CODE_THEME,
  resolveCodeTheme,
  type CodeThemeId,
  type ResolvedCodeTheme,
} from "./registry.js";

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

/**
 * Host-neutral syntax-highlighting capability.
 *
 * Importing this contract never evaluates Shiki. Node/Bun and browser hosts
 * obtain the concrete runtime through the condition-selected package root only
 * after a document usage scan proves that a known grammar is required.
 */
export interface CodeHighlightRuntime {
  prepare(
    languages: readonly string[],
    theme?: CodeThemeId,
    options?: CodeHighlightOptions,
  ): Promise<void>;
  highlight(
    code: string,
    language?: string,
    theme?: CodeThemeId,
    options?: CodeHighlightOptions,
  ): Promise<HighlightedCode>;
}

export type CodeHighlightRuntimeLoader = () => Promise<CodeHighlightRuntime>;

let runtimePromise: Promise<CodeHighlightRuntime> | undefined;

/**
 * Load the Node/Bun or browser implementation selected by package conditions.
 * The shared promise is retryable and the dynamic edge keeps the complete
 * Shiki graph out of no-usage entry chunks.
 */
export function loadCodeHighlightRuntime(): Promise<CodeHighlightRuntime> {
  if (runtimePromise) return runtimePromise;
  const owned = import("@atlcli/code-highlight").then(
    ({ codeHighlightRuntime }) => codeHighlightRuntime,
  );
  owned.catch(() => {
    if (runtimePromise === owned) runtimePromise = undefined;
  });
  runtimePromise = owned;
  return owned;
}

/** Deterministic plain-text projection used before or without a Shiki runtime. */
export function plainCodeHighlight(
  code: string,
  theme: CodeThemeId = DEFAULT_CODE_THEME,
  skipped: HighlightSkip | null = null,
): HighlightedCode {
  return {
    theme: resolveCodeTheme(theme),
    lines: code.split("\n").map((line) => [{ text: line }]),
    skipped,
  };
}

/**
 * Render through an injected runtime only for a known canonical language.
 *
 * Missing/unknown languages and a failed or unavailable runtime preserve the
 * same plain-text semantics without evaluating a concrete Shiki adapter.
 */
export async function highlightCodeWithRuntime(
  runtime: CodeHighlightRuntime | undefined,
  code: string,
  language?: string,
  theme: CodeThemeId = DEFAULT_CODE_THEME,
  options: CodeHighlightOptions = {},
): Promise<HighlightedCode> {
  const plain = plainCodeHighlight(code, theme);
  if (!language) return plain;
  const canonical = canonicalCodeLanguage(language);
  if (!canonical) return { ...plain, skipped: "unknown-language" };
  if (!runtime) return { ...plain, skipped: "highlight-failed" };
  try {
    return await runtime.highlight(code, canonical, theme, options);
  } catch {
    return { ...plain, skipped: "highlight-failed" };
  }
}
