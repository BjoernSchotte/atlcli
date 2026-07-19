/**
 * Hardcoding-ledger lint stub (spec 007 T2.5).
 *
 * A **heuristic** (not a parser) guard that makes a *new* unledgered hardcoded
 * presentation value in `packages/pdf/src/template.ts` visible in review. It
 * greps the template source for three token classes:
 *   - bare hex color literals   `#[0-9a-fA-F]{6}`
 *   - bare length literals      `<number>pt | mm | em`
 *   - font-family string values `font: "<family>"`
 * and fails (exit 1, named line/column) for any token that is neither recorded
 * in the ledger nor on the narrow, commented engine-structural allowlist below.
 *
 * ## Design choice: the ledger is the single source of truth
 *
 * The recorded set is **parsed from
 * `specs/export-expansion/007-pdf-template-settings/HARDCODING-LEDGER.md`**,
 * not from an inline constant list in this script. Every hex color, font
 * family, and length literal in the ledger appears inside a Markdown backtick
 * code span; this script extracts all code spans (de-quoting `"…"`) and unions
 * them into the recorded set. Consequence: to add a hardcoded value to
 * `template.ts` without tripping the lint, you must first record it in the
 * ledger — which is exactly the behavior 012 wants (the ledger stays the
 * authoritative inventory; the lint just enforces "nothing new escapes it").
 * An inline list would have duplicated the ledger and let the two drift.
 *
 * False positives are acceptable (this is a review aid, not a gate on every
 * edge case); false *negatives* on the current `template.ts` are not — the
 * current state must pass. See the companion test
 * `check-hardcoding-ledger.test.ts`, which asserts exactly that under
 * `bun test` (the CI seam — hooking the tsc-focused root `typecheck` was more
 * intrusive than a test wrapper, and `bun test` already runs every `*.test.ts`
 * in the repo).
 *
 * ## Consumer
 *
 * `012-pdf-template-migration/PLAN.md` starts from the ledger this script
 * guards as its migration inventory, and inherits this stub as its "no new
 * unledgered hardcoding" check while it moves these literals into manifest
 * design tokens. See that plan's Reference/Goal sections.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_TEMPLATE_PATH = resolve(SCRIPT_DIR, "../src/template.ts");
const DEFAULT_LEDGER_PATH = resolve(
  SCRIPT_DIR,
  "../../../specs/export-expansion/007-pdf-template-settings/HARDCODING-LEDGER.md"
);

/**
 * Engine-structural values (structural, not presentation) that are
 * intentionally NOT recorded in the ledger. Kept narrow and commented, per the
 * "engine invariant allowlist" idea 012 formalizes.
 */
const ENGINE_STRUCTURAL_ALLOWLIST = new Set<string>([
  // Unit-conversion multiplier: `settings.at("size", …) * 1pt` turns a numeric
  // setting into a Typst length. Not a presentation constant.
  "1pt",
]);

const HEX_RE = /#[0-9a-fA-F]{6}(?![0-9a-fA-F])/g;
const LENGTH_RE = /(?<![\w.])\d+(?:\.\d+)?(?:pt|mm|em)(?![\w])/g;
const FONT_RE = /font:\s*"([^"]+)"/g;

export type TokenClass = "hex-color" | "length" | "font-family";

export interface LedgerViolation {
  class: TokenClass;
  token: string;
  line: number;
  column: number;
}

/** Extract every Markdown inline code span's text, plus a de-quoted variant. */
export function parseLedgerRecordedSet(ledgerSource: string): Set<string> {
  const recorded = new Set<string>();
  // Non-greedy single-backtick spans; ledger uses no multi-backtick spans.
  for (const match of ledgerSource.matchAll(/`([^`\n]+)`/g)) {
    const raw = match[1].trim();
    if (raw.length === 0) continue;
    recorded.add(raw);
    // Record `"Source Sans 3"` and `Source Sans 3` alike.
    const dequoted = raw.replace(/^"(.*)"$/, "$1");
    if (dequoted !== raw) recorded.add(dequoted);
  }
  return recorded;
}

function columnOf(lineText: string, index: number): number {
  // 1-based column of `index` within a full-source string, given the line start.
  return index + 1;
}

/**
 * Scan `templateSource` for hardcoded tokens not covered by `recorded` or the
 * engine-structural allowlist. Returns violations (empty === clean).
 */
export function scanTemplate(templateSource: string, recorded: Set<string>): LedgerViolation[] {
  const violations: LedgerViolation[] = [];
  const lines = templateSource.split("\n");

  const isKnown = (token: string): boolean =>
    recorded.has(token) || ENGINE_STRUCTURAL_ALLOWLIST.has(token);

  lines.forEach((lineText, i) => {
    const lineNo = i + 1;
    const push = (cls: TokenClass, token: string, colIndex: number) => {
      if (isKnown(token)) return;
      violations.push({ class: cls, token, line: lineNo, column: columnOf(lineText, colIndex) });
    };

    for (const m of lineText.matchAll(HEX_RE)) {
      push("hex-color", m[0], m.index ?? 0);
    }
    for (const m of lineText.matchAll(LENGTH_RE)) {
      push("length", m[0], m.index ?? 0);
    }
    for (const m of lineText.matchAll(FONT_RE)) {
      const family = m[1];
      // Column points at the family value, not the `font:` keyword.
      const valueIndex = (m.index ?? 0) + m[0].indexOf(family);
      push("font-family", family, valueIndex);
    }
  });

  return violations;
}

export interface CheckOptions {
  templatePath?: string;
  ledgerPath?: string;
}

export interface CheckResult {
  violations: LedgerViolation[];
  recordedCount: number;
  templatePath: string;
  ledgerPath: string;
}

/** Run the lint against real files (defaults to the pinned template + ledger). */
export function checkHardcodingLedger(options: CheckOptions = {}): CheckResult {
  const templatePath = options.templatePath ?? DEFAULT_TEMPLATE_PATH;
  const ledgerPath = options.ledgerPath ?? DEFAULT_LEDGER_PATH;
  const recorded = parseLedgerRecordedSet(readFileSync(ledgerPath, "utf8"));
  const violations = scanTemplate(readFileSync(templatePath, "utf8"), recorded);
  return { violations, recordedCount: recorded.size, templatePath, ledgerPath };
}

function formatViolation(v: LedgerViolation): string {
  return `  template.ts:${v.line}:${v.column}  ${v.class}  ${v.token}`;
}

if (import.meta.main) {
  const result = checkHardcodingLedger();
  if (result.violations.length === 0) {
    console.log(
      `hardcoding-ledger: OK — ${result.recordedCount} recorded tokens, no unledgered hardcoded values in template.ts`
    );
    process.exit(0);
  }
  console.error(
    `hardcoding-ledger: ${result.violations.length} unledgered hardcoded value(s) in template.ts.\n` +
      `Record them in HARDCODING-LEDGER.md (or add a structural value to the script allowlist):`
  );
  for (const v of result.violations) console.error(formatViolation(v));
  process.exit(1);
}
