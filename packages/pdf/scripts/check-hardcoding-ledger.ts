/**
 * Hardcoding-ledger lint — CI-enforced (spec 007 T2.5 → spec 012 T6.3).
 *
 * After the 012 migration, the canonical template renderers and `serialize.ts`
 * author **no presentation literal**: every color, length, and font family is
 * either interpolated from a validated `wiki.pdf-template/v1` design (`${…}`)
 * or read from the resolved `settings.design`/`settings.labels` at runtime. The
 * literals themselves live in the manifest (see `builtin-template.ts` and
 * `specs/export-expansion/007-pdf-template-settings/HARDCODING-LEDGER.md`).
 *
 * This lint enforces that boundary. It scans both hot files for a bare hex
 * color, a `pt`/`mm`/`em` length, or a `font: "…"` family, **after blanking
 * `${…}` interpolation spans** (those are design-data reads, not literals). Any
 * remaining bare token that is not on the small, reviewed
 * {@link ENGINE_INVARIANT_ALLOWLIST} fails the build.
 *
 * ## Engine-invariant allowlist
 *
 * A literal earns a place here only if it is *structurally required by the
 * engine* and is not a presentation choice. Every entry carries a one-line
 * justification and is reviewed on addition — the list is not append-by-default
 * (spec 012 "Engine invariants absorb presentation choices" STOP condition). A
 * font, color, spacing value, or label must never land here because migrating
 * it was inconvenient.
 *
 * ## CI seam
 *
 * The companion test `check-hardcoding-ledger.test.ts` asserts zero violations
 * under `bun test` (the CI seam; hooking the tsc-focused root `typecheck` was
 * more intrusive than a test wrapper).
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const HOT_FILES = ["template.ts", "template-v4.ts", "serialize.ts"] as const;

/**
 * Structural literals (not presentation) intentionally allowed to appear bare.
 * Keep narrow; every entry needs a justification and is reviewed on addition.
 */
export const ENGINE_INVARIANT_ALLOWLIST = new Set<string>([
  // `settings…watermark.size * 1pt` — unit-conversion multiplier that turns a
  // numeric setting into a Typst length. Structural, not a presentation size.
  "1pt",
]);

const HEX_RE = /#[0-9a-fA-F]{6}(?![0-9a-fA-F])/g;
const LENGTH_RE = /(?<![\w.])\d+(?:\.\d+)?(?:pt|mm|em)(?![\w])/g;
const FONT_RE = /font:\s*"([^"]+)"/g;

export type TokenClass = "hex-color" | "length" | "font-family";

export interface LedgerViolation {
  file: string;
  class: TokenClass;
  token: string;
  line: number;
  column: number;
}

/**
 * Blank every `${…}` template-literal interpolation span in a line, preserving
 * length (and therefore column offsets) by substituting spaces. A value read
 * from the manifest via `${…}` is design data, never a bare literal.
 */
export function blankInterpolations(line: string): string {
  return line.replace(/\$\{[^{}]*\}/g, (match) => " ".repeat(match.length));
}

/**
 * Scan one source file's text for bare presentation literals not covered by the
 * engine-invariant allowlist (plus any `extraAllowed`, used by unit tests).
 */
export function scanSource(
  source: string,
  file: string,
  extraAllowed: Set<string> = new Set()
): LedgerViolation[] {
  const violations: LedgerViolation[] = [];
  const isKnown = (token: string): boolean =>
    ENGINE_INVARIANT_ALLOWLIST.has(token) || extraAllowed.has(token);

  source.split("\n").forEach((rawLine, index) => {
    const line = blankInterpolations(rawLine);
    const lineNo = index + 1;
    const push = (cls: TokenClass, token: string, colIndex: number): void => {
      if (isKnown(token)) return;
      violations.push({ file, class: cls, token, line: lineNo, column: colIndex + 1 });
    };
    for (const m of line.matchAll(HEX_RE)) push("hex-color", m[0], m.index ?? 0);
    for (const m of line.matchAll(LENGTH_RE)) push("length", m[0], m.index ?? 0);
    for (const m of line.matchAll(FONT_RE)) {
      const family = m[1].trim();
      if (family.length === 0) continue; // an all-blanked interpolation, not a literal
      const valueIndex = (m.index ?? 0) + m[0].indexOf(m[1]);
      push("font-family", family, valueIndex);
    }
  });
  return violations;
}

export interface CheckResult {
  violations: LedgerViolation[];
  filesScanned: string[];
}

/** Run the lint against the canonical renderers plus `serialize.ts`. */
export function checkHardcodingLedger(options: { srcDir?: string } = {}): CheckResult {
  const srcDir = options.srcDir ?? resolve(SCRIPT_DIR, "../src");
  const violations: LedgerViolation[] = [];
  for (const file of HOT_FILES) {
    const source = readFileSync(resolve(srcDir, file), "utf8");
    violations.push(...scanSource(source, file));
  }
  return { violations, filesScanned: [...HOT_FILES] };
}

function formatViolation(v: LedgerViolation): string {
  return `  ${v.file}:${v.line}:${v.column}  ${v.class}  ${v.token}`;
}

if (import.meta.main) {
  const result = checkHardcodingLedger();
  if (result.violations.length === 0) {
    console.log(
      `hardcoding-ledger: OK — no bare presentation literals in ${result.filesScanned.join(", ")} ` +
        `(outside the ${ENGINE_INVARIANT_ALLOWLIST.size}-entry engine-invariant allowlist)`
    );
    process.exit(0);
  }
  console.error(
    `hardcoding-ledger: ${result.violations.length} bare presentation literal(s) found. Move each into ` +
      `the template manifest (builtin-template.ts) or justify it on the engine-invariant allowlist:`
  );
  for (const v of result.violations) console.error(formatViolation(v));
  process.exit(1);
}
