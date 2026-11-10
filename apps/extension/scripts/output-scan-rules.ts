/**
 * Artifact rules shared by the two built-output gates: the extension's
 * `check-output-build.ts` and the browser export harness' `check-output.ts`.
 *
 * Both artifacts bundle the same export engines, so "no remote code, no
 * string-to-code, no Oniguruma, no aggregate Shiki catalogue" must mean the
 * same thing in both. Each gate adds its own host-specific rules on top.
 *
 * Dependency-free on purpose: the harness imports this file by path, and it
 * must not pull any extension source or type into the harness' typecheck.
 */

/**
 * Remote script origin: any executable form that would pull code from an
 * http(s) URL —
 *   - a static `import` (with bindings `import x from "url"`, namespace
 *     `import * as ns from "url"`, or a bare side-effect `import "url"`),
 *   - a dynamic `import(...)`,
 *   - `importScripts(...)` (classic/worker), or
 *   - an HTML `<script src=...>` whose URL is quoted OR unquoted.
 * Bare data/blob URLs and non-script string literals (e.g. a fetch endpoint)
 * are intentionally NOT matched — only executable remote code counts. Patterns
 * tolerate minified spacing (`import{a}from"url"`).
 */
export const REMOTE_SCRIPT_RES: readonly RegExp[] = [
  // Static import: side-effect (`import "url"`), or with a binding clause
  // (`import x from "url"`, `import * as ns from "url"`, `import {a} from "url"`).
  /\bimport\s*(?:[^"'`()]*\bfrom\s*)?["'`]https?:\/\/[^"'`]+["'`]/g,
  // Dynamic import().
  /\bimport\s*\(\s*["'`]https?:\/\/[^"'`]+["'`]/g,
  // Classic worker importScripts().
  /\bimportScripts\s*\(\s*["'`]https?:\/\/[^"'`]+["'`]/g,
  // HTML <script src=...> — URL quoted ("url"/'url') or unquoted (src=url).
  /<script\b[^>]*\bsrc\s*=\s*["']?https?:\/\/[^"'\s>]+/gi,
];

/**
 * String-to-code constructors, forbidden by the extension page CSP and by the
 * harness' own policy. Order matters to callers: the first two are the
 * `Function` forms, the third is `eval`.
 */
export const DYNAMIC_CODE_RES: readonly RegExp[] = [
  /\bnew\s+Function\s*\(/g,
  /(?:^|[=(:,!&|?;{}])\s*Function\s*\(\s*["'`]/g,
  /(?<![\w.])\beval\s*\(/g,
];

/** Markers of Shiki's Oniguruma (WASM) regex engine; only the JS engine may ship. */
export const ONIGURUMA_RUNTIME_RES: readonly RegExp[] = [
  /\bfindNextOnigScannerMatch\b/g,
  /Must invoke loadWasm first[.]/g,
];

/** Markers of Shiki's aggregate language/theme catalogue instead of pinned grammars. */
export const AGGREGATE_SHIKI_RUNTIME_RES: readonly RegExp[] = [
  /\bbundle_full_exports\b/g,
  /\blangs-bundle-full\b/g,
  /["'`]shiki(?:\/(?:langs|themes))?["'`]/g,
];

/** Artifact paths that must not exist in either output. */
export const ONIGURUMA_ENGINE_CHUNK_RE = /(?:^|\/)engine-oniguruma-[^/]+[.]js$/i;
export const ONIGURUMA_WASM_RE = /(?:^|\/)(?:onig|shiki)[^/]*[.]wasm$/i;
export const AGGREGATE_SHIKI_CHUNK_RE =
  /(?:^|\/)(?:langs|themes|bundle-full|bundle-web)-[^/]+[.]js$/i;

/**
 * Shiki grammar chunks are inert JSON payloads. Some grammars list Node
 * globals as source-language keywords; those strings are not runtime use.
 */
export function withoutGrammarKeywordFindings(text: string, findings: string[]): string[] {
  if (!text.includes("Object.freeze(JSON.parse(`") || !text.includes('"scopeName"')) {
    return findings;
  }
  return findings.filter((finding) => finding !== "__dirname" && finding !== "__filename");
}
