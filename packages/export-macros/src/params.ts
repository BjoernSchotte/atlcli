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
