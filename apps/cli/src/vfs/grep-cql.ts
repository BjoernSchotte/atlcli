import type { ParsedGrep } from "./grep-flags.js";

/** An index-backed candidate query, not a completeness proof for Markdown grep. */
export function planGrepCql(parsed: ParsedGrep): { query: string } | { reason: string } {
  if (parsed.noCql) return { reason: "index search explicitly disabled" };
  if (parsed.hasUnsupportedOptions) return { reason: "unsupported grep options" };
  if (parsed.invertMatch) return { reason: "inverted matches require all files" };
  if (parsed.includes.length || parsed.excludes.length || parsed.excludeDirs.length) return { reason: "path filters require hierarchy traversal" };
  if (parsed.patternFiles.length) return { reason: "patterns are read from files" };
  // normalizedArgs holds values too: a pattern literally named '-c' is not a flag.
  for (let i = 0; i < parsed.normalizedArgs.length; i++) {
    const arg = parsed.normalizedArgs[i]!;
    if (arg === "--") break;
    if (arg === "-c" || arg === "-L") return { reason: "counts and nonmatching filenames require all files" };
    if (["-e", "-f", "-m", "-A", "-B", "-C"].includes(arg)) i++;
  }
  const patterns = parsed.patterns.flatMap((pattern) => pattern.split("\n"));
  if (!patterns.length || patterns.length > 32) return { reason: "pattern count exceeds indexed search limits" };
  const alternatives: string[] = [];
  for (const pattern of patterns) {
    // ERE alternation is supported only when each entire branch is literal.
    const branches = !parsed.fixedString && parsed.extendedRegex ? pattern.split("|") : [pattern];
    for (const branch of branches) {
      const literal = parsed.fixedString ? branch : regexLiteral(branch);
      if (literal === undefined) return { reason: "regex has no supported literal translation" };
      const tokens = [...new Set((literal.match(/[\p{L}\p{N}]+/gu) ?? []).filter((token) => [...token].length >= 3))];
      if (!tokens.length || tokens.length > 12 || tokens.some((token) => token.length > 80)) {
        return { reason: "literal has no bounded searchable word tokens" };
      }
      // Only Unicode letters/digits reach CQL; syntax and quote characters cannot leak.
      alternatives.push(`(${tokens.map((token) => `(text ~ "${token}" OR text ~ "${token}*")`).join(" AND ")})`);
      if (alternatives.length > 32) return { reason: "pattern count exceeds indexed search limits" };
    }
  }
  const query = [...new Set(alternatives)].join(" OR ");
  return query.length <= 4096 ? { query } : { reason: "indexed query exceeds length limit" };
}

/** Decode only literal regexes, optionally anchored at either boundary. */
function regexLiteral(pattern: string): string | undefined {
  if (pattern.startsWith("^")) pattern = pattern.slice(1);
  let literal = "";
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i]!;
    if (char === "\\") {
      const escaped = pattern[++i];
      // These escapes are literal in both basic and extended grep regexes.
      if (!escaped || !".[]^$\\*".includes(escaped)) return undefined;
      literal += escaped;
    } else if (char === "$" && i === pattern.length - 1) {
      continue;
    } else if (".*+?[](){}|^$".includes(char)) {
      return undefined;
    } else literal += char;
  }
  return literal;
}
