/**
 * Lazy Shiki code highlighting (spec 004 Task 5 / PLAN §2.3, risk 4).
 *
 * Shiki grammars are heavy, so this module uses the **fine-grained** Shiki core
 * bundle rather than the full `shiki` entry:
 *
 *  - `createHighlighterCore` from `shiki/core` — no built-in language/theme
 *    registry, so Vite does NOT emit a chunk for every one of Shiki's ~200
 *    grammars (the full entry produced a ~10 MB output of per-language chunks).
 *  - the **JavaScript regex engine** (`shiki/engine/javascript`) instead of the
 *    Oniguruma WASM engine — avoids shipping the ~600 KB `.wasm` and keeps the
 *    panel within MV3's `wasm-unsafe-eval` posture without needing WASM at all.
 *  - one static `import("shiki/langs/<lang>.mjs")` per **curated** common
 *    language, each its own code-split chunk loaded only when a code block of
 *    that language is actually serialized (PLAN: "lazy-load only needed
 *    languages"). Unknown/uncurated languages degrade to uncolored lines.
 *
 * The whole module is only reached through the serializer's `await`, so nothing
 * here lands in the main panel bundle.
 */
import type { HighlighterCore } from "shiki/core";

/** One colored span within a line. */
export interface CodeToken {
  text: string;
  /** Hex color (`#rrggbb`), when the theme assigned one. */
  color?: string;
}

/** A line of code as an ordered list of colored tokens. */
export type CodeLine = CodeToken[];

const THEME = "github-light";

/**
 * Curated language loaders. Each value is a static dynamic import so the bundler
 * emits exactly these chunks (aliases share a loader). Keep this list tight —
 * every entry is a shipped grammar chunk.
 */
const LANG_LOADERS: Record<string, () => Promise<unknown>> = {
  typescript: () => import("shiki/langs/typescript.mjs"),
  ts: () => import("shiki/langs/typescript.mjs"),
  tsx: () => import("shiki/langs/tsx.mjs"),
  javascript: () => import("shiki/langs/javascript.mjs"),
  js: () => import("shiki/langs/javascript.mjs"),
  jsx: () => import("shiki/langs/jsx.mjs"),
  json: () => import("shiki/langs/json.mjs"),
  python: () => import("shiki/langs/python.mjs"),
  py: () => import("shiki/langs/python.mjs"),
  java: () => import("shiki/langs/java.mjs"),
  kotlin: () => import("shiki/langs/kotlin.mjs"),
  csharp: () => import("shiki/langs/csharp.mjs"),
  cs: () => import("shiki/langs/csharp.mjs"),
  go: () => import("shiki/langs/go.mjs"),
  rust: () => import("shiki/langs/rust.mjs"),
  rs: () => import("shiki/langs/rust.mjs"),
  c: () => import("shiki/langs/c.mjs"),
  cpp: () => import("shiki/langs/cpp.mjs"),
  php: () => import("shiki/langs/php.mjs"),
  ruby: () => import("shiki/langs/ruby.mjs"),
  rb: () => import("shiki/langs/ruby.mjs"),
  bash: () => import("shiki/langs/bash.mjs"),
  shell: () => import("shiki/langs/bash.mjs"),
  sh: () => import("shiki/langs/bash.mjs"),
  sql: () => import("shiki/langs/sql.mjs"),
  yaml: () => import("shiki/langs/yaml.mjs"),
  yml: () => import("shiki/langs/yaml.mjs"),
  html: () => import("shiki/langs/html.mjs"),
  xml: () => import("shiki/langs/xml.mjs"),
  css: () => import("shiki/langs/css.mjs"),
  markdown: () => import("shiki/langs/markdown.mjs"),
  md: () => import("shiki/langs/markdown.mjs"),
};

/** The Shiki grammar id a given language alias resolves to (for load caching). */
function canonicalLang(lang: string): string | undefined {
  return LANG_LOADERS[lang] ? lang : undefined;
}

let highlighterPromise: Promise<HighlighterCore> | null = null;
const loadedLangs = new Set<string>();

async function getHighlighter(): Promise<HighlighterCore> {
  if (!highlighterPromise) {
    highlighterPromise = (async () => {
      const [{ createHighlighterCore }, { createJavaScriptRegexEngine }, theme] = await Promise.all([
        import("shiki/core"),
        import("shiki/engine/javascript"),
        import("shiki/themes/github-light.mjs"),
      ]);
      return createHighlighterCore({
        themes: [theme.default],
        langs: [],
        engine: createJavaScriptRegexEngine(),
      });
    })();
  }
  return highlighterPromise;
}

/** Split code into uncolored lines (the fallback path). */
function plainLines(code: string): CodeLine[] {
  return code.split("\n").map((line) => [{ text: line }]);
}

/**
 * Highlight `code` in `language`, returning a token grid. Falls back to plain
 * (uncolored) lines when the language is uncurated or Shiki fails to load.
 */
export async function highlightCode(code: string, language?: string): Promise<CodeLine[]> {
  const raw = (language ?? "").trim().toLowerCase();
  const lang = canonicalLang(raw);
  if (!lang) return plainLines(code);

  try {
    const hl = await getHighlighter();
    if (!loadedLangs.has(lang)) {
      const mod = (await LANG_LOADERS[lang]()) as { default: unknown };
      await hl.loadLanguage(mod.default as never);
      loadedLangs.add(lang);
    }
    const { tokens } = hl.codeToTokens(code, { lang, theme: THEME });
    return tokens.map((line) => line.map((t) => ({ text: t.content, color: t.color })));
  } catch {
    return plainLines(code);
  }
}
