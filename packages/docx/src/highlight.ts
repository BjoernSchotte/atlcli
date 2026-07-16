/**
 * Lazy Shiki code highlighting (spec 004 Task 5 / PLAN §2.3, risk 4).
 *
 * Shiki grammars are heavy, so this module uses the **fine-grained** Shiki core
 * bundle rather than the full `shiki` entry:
 *
 *  - `createHighlighterCore` from `shiki/core` — no built-in language/theme
 *    registry, so Vite does NOT emit a chunk for every one of Shiki's ~200
 *    grammars (the full entry produced a ~10 MB output of per-language chunks).
 *  - a runtime-selected regex engine: Oniguruma WASM where compilation is
 *    allowed, with the JavaScript engine as the CSP-safe fallback.
 *  - one static `import("shiki/langs/<lang>.mjs")` per **curated** common
 *    language, each its own code-split chunk loaded only when a code block of
 *    that language is actually serialized (PLAN: "lazy-load only needed
 *    languages"). Aliases resolve to one canonical loader/warm promise;
 *    unknown/uncurated languages degrade to uncolored lines.
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

/** Why highlighting was skipped, when it was. */
export type HighlightSkip = "unknown-language" | "highlight-failed";

/** Result of {@link highlightCode}: the token grid + why it degraded, if it did. */
export interface HighlightResult {
  lines: CodeLine[];
  /** Set when a language was requested but the code was left uncolored. */
  skipped: HighlightSkip | null;
}

const THEME = "github-light";

/**
 * Curated canonical language loaders. Each value is a static dynamic import so
 * the bundler emits exactly these chunks. Aliases resolve through
 * {@link LANG_ALIASES}; keep both lists tight — every loader is a shipped
 * grammar chunk.
 */
const LANG_LOADERS: Record<string, () => Promise<unknown>> = {
  typescript: () => import("shiki/langs/typescript.mjs"),
  tsx: () => import("shiki/langs/tsx.mjs"),
  javascript: () => import("shiki/langs/javascript.mjs"),
  jsx: () => import("shiki/langs/jsx.mjs"),
  json: () => import("shiki/langs/json.mjs"),
  python: () => import("shiki/langs/python.mjs"),
  java: () => import("shiki/langs/java.mjs"),
  kotlin: () => import("shiki/langs/kotlin.mjs"),
  csharp: () => import("shiki/langs/csharp.mjs"),
  go: () => import("shiki/langs/go.mjs"),
  rust: () => import("shiki/langs/rust.mjs"),
  c: () => import("shiki/langs/c.mjs"),
  cpp: () => import("shiki/langs/cpp.mjs"),
  php: () => import("shiki/langs/php.mjs"),
  ruby: () => import("shiki/langs/ruby.mjs"),
  bash: () => import("shiki/langs/bash.mjs"),
  sql: () => import("shiki/langs/sql.mjs"),
  yaml: () => import("shiki/langs/yaml.mjs"),
  html: () => import("shiki/langs/html.mjs"),
  xml: () => import("shiki/langs/xml.mjs"),
  css: () => import("shiki/langs/css.mjs"),
  markdown: () => import("shiki/langs/markdown.mjs"),
};

/** Curated aliases keyed to the one grammar load/warm promise they share. */
const LANG_ALIASES: Record<string, string> = {
  ts: "typescript",
  js: "javascript",
  py: "python",
  cs: "csharp",
  rs: "rust",
  rb: "ruby",
  shell: "bash",
  sh: "bash",
  yml: "yaml",
  md: "markdown",
};

/** The Shiki grammar id a given requested language or alias resolves to. */
export function canonicalLang(lang: string): string | undefined {
  const canonical = LANG_ALIASES[lang] ?? lang;
  return LANG_LOADERS[canonical] ? canonical : undefined;
}

let highlighterPromise: Promise<HighlighterCore> | null = null;
/** Per-language load promise: concurrent callers (prefetch + serializer) share one load. */
const langLoads = new Map<string, Promise<void>>();

/**
 * True when this host may COMPILE WebAssembly. `typeof WebAssembly` alone is
 * not enough: an MV3 extension page exposes the object but its CSP (without
 * `wasm-unsafe-eval`) rejects compilation — so probe with the smallest valid
 * module (the 8-byte `\0asm` header). Sub-millisecond, no network.
 */
function canCompileWasm(): boolean {
  try {
    return (
      typeof WebAssembly !== "undefined" &&
      new WebAssembly.Module(Uint8Array.of(0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00)) instanceof
        WebAssembly.Module
    );
  } catch {
    return false;
  }
}

/**
 * Pick the fastest regex engine the host allows (perf finding: loading the
 * TypeScript grammar through the JS engine costs ~650ms of oniguruma-to-es
 * translation; the Oniguruma WASM engine does the same in ~30ms — it runs
 * the grammars' original regexes natively):
 *
 *  - hosts that can compile WASM (CLI/Bun, Node, Tauri webviews, extensions
 *    WITH `wasm-unsafe-eval`) get the Oniguruma engine — the reference
 *    implementation, so token output is at least as faithful;
 *  - the MV3 panel (no `wasm-unsafe-eval` in its CSP) keeps the JavaScript
 *    engine, exactly the pre-existing behavior. The probe means the panel
 *    never even fetches the ~600 KB wasm chunk — and auto-upgrades if the
 *    permission is ever added.
 *
 * Any wasm-path failure falls back to the JS engine rather than degrading
 * highlighting.
 */
async function createEngine(): Promise<import("shiki/core").RegexEngine> {
  if (canCompileWasm()) {
    try {
      const { createOnigurumaEngine } = await import("shiki/engine/oniguruma");
      return await createOnigurumaEngine(import("shiki/wasm"));
    } catch {
      // fall through to the JS engine
    }
  }
  const { createJavaScriptRegexEngine } = await import("shiki/engine/javascript");
  return createJavaScriptRegexEngine();
}

async function getHighlighter(): Promise<HighlighterCore> {
  if (!highlighterPromise) {
    const p = (async () => {
      const [{ createHighlighterCore }, engine, theme] = await Promise.all([
        import("shiki/core"),
        createEngine(),
        import("shiki/themes/github-light.mjs"),
      ]);
      return createHighlighterCore({
        themes: [theme.default],
        langs: [],
        engine,
      });
    })();
    // A failed init (transient chunk-load error during background warm-up)
    // must not poison every later highlight — clear the memo so the next
    // call retries. Callers still observe the original rejection.
    p.catch(() => {
      if (highlighterPromise === p) highlighterPromise = null;
    });
    highlighterPromise = p;
  }
  return highlighterPromise;
}

/** Load one language grammar into the highlighter exactly once (shared promise). */
function loadLang(lang: string): Promise<void> {
  let p = langLoads.get(lang);
  if (!p) {
    p = (async () => {
      const hl = await getHighlighter();
      const mod = (await LANG_LOADERS[lang]()) as { default: unknown };
      await hl.loadLanguage(mod.default as never);
      // Warm the grammar with a throwaway tokenize: the JS regex engine
      // compiles rules lazily, and the very FIRST tokenize after loadLanguage
      // can emit differently-merged tokens than every later call (observed:
      // `1;` as one number-colored token, then `1` + `;` split ever after).
      // One dummy call makes all real output deterministic from call one —
      // which the spec-006 golden-file equality test depends on.
      hl.codeToTokens("0;", { lang, theme: THEME });
    })();
    // A failed load must not poison later attempts (they re-import).
    p.catch(() => {
      langLoads.delete(lang);
    });
    langLoads.set(lang, p);
  }
  return p;
}

/**
 * Start loading the highlighter core + the given languages' grammars in the
 * background (perf: the first Shiki use costs ~700ms of import + grammar
 * compile, which this overlaps with the export's network round-trips).
 * Never throws and never rejects — a failed warm just means the later
 * {@link highlightCode} call retries and degrades on its own.
 */
export function warmHighlight(languages: string[]): void {
  const langs = new Set(
    languages.map((l) => canonicalLang(l.trim().toLowerCase())).filter((l): l is string => Boolean(l))
  );
  for (const lang of langs) void loadLang(lang).catch(() => {});
}

/** Split code into uncolored lines (the fallback path). */
function plainLines(code: string): CodeLine[] {
  return code.split("\n").map((line) => [{ text: line }]);
}

/**
 * Highlight `code` in `language`, returning a token grid plus a `skipped` reason
 * when it degraded to plain lines. A language that is present but uncurated
 * (`skipped: "unknown-language"`) or a Shiki load/tokenize failure
 * (`skipped: "highlight-failed"`) both fall back to uncolored text — and now
 * surface a reason so the caller can add a report note. A code block with no
 * language is plain by design (`skipped: null`).
 */
export async function highlightCode(code: string, language?: string): Promise<HighlightResult> {
  const raw = (language ?? "").trim().toLowerCase();
  const canonical = canonicalLang(raw);
  if (!canonical) {
    // Only a REQUESTED-but-unknown language is a skip worth reporting.
    return { lines: plainLines(code), skipped: raw ? "unknown-language" : null };
  }

  try {
    await loadLang(canonical);
    const hl = await getHighlighter();
    // Tokenize with the requested alias so Shiki preserves its public alias
    // behavior, while grammar loading/warm-up is shared by canonical id.
    const { tokens } = hl.codeToTokens(code, { lang: raw, theme: THEME });
    return {
      lines: tokens.map((line) => line.map((t) => ({ text: t.content, color: t.color }))),
      skipped: null,
    };
  } catch {
    return { lines: plainLines(code), skipped: "highlight-failed" };
  }
}
