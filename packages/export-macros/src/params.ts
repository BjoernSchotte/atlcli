/**
 * Local macro-parameter helpers (spec 004).
 *
 * Re-implemented here (rather than imported from `@atlcli/confluence`) to keep
 * `@atlcli/export-macros` free of any runtime import from an `@atlcli/*` package
 * — only type-level imports are allowed (see package header / Architecture).
 * The behavior mirrors `@atlcli/confluence`'s `macroParamText`.
 */
import type { MacroParameter } from "@atlcli/confluence";

/**
 * Case-insensitive lookup for a parameter's plain-text value. Returns
 * `undefined` for ref-only or absent parameters. First match wins.
 */
export function macroParamText(
  params: MacroParameter[] | undefined,
  name: string
): string | undefined {
  if (!params) return undefined;
  const target = name.toLowerCase();
  for (const p of params) {
    if (p.name.toLowerCase() === target) return p.text;
  }
  return undefined;
}

/**
 * Escape a value for use inside a double-quoted CQL string literal. Mirrors
 * `@atlcli/confluence`'s `escapeCqlValue` (local re-implementation for the same
 * package-boundary reason as {@link macroParamText}). Macro parameters are
 * PAGE-EDITOR-controlled — a different trust boundary than CLI flags — so any
 * CQL a renderer builds from them MUST pass through this, never raw
 * interpolation (a `"` in a label would otherwise break out of the literal).
 */
export function escapeCqlValue(value: string): string {
  return value
    // Strip C0/C1 control characters (incl. NUL, newlines, DEL).
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001F\u007F-\u009F]/g, "")
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"');
}
