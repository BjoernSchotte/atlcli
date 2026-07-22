import { describe, expect, it } from "bun:test";
import { Glob } from "bun";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  EXPORT_NOTE_CODES,
  RETIRED_EXPORT_NOTE_CODES,
} from "../packages/confluence/src/export-blocks.js";

/**
 * ExportNote.code registry enforcement (spec 009, "Stabilize
 * ExportNote.code").
 *
 * The type system already rejects unregistered codes at emission sites — this
 * test closes the two remaining gaps: (a) a literal emitted somewhere the
 * compiler cannot see as ExportNote-typed, and (b) registry DRIFT in the
 * other direction (a member nothing emits anymore — e.g. a code renamed at
 * the call site while the old union member lingers).
 *
 * Detection: every non-test source file is scanned for `code: "…"` literals
 * that sit next to a `message:` property (the ExportNote shape), plus
 * template-literal sites (`code: \`prefix-${…}\``) whose expansion is matched
 * against registry members by prefix.
 */

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

const SCAN_GLOBS = [
  "packages/*/src/**/*.ts",
  "packages/*/src/**/*.tsx",
  "apps/cli/src/**/*.ts",
  "apps/extension/utils/**/*.ts",
  "apps/extension/workers/**/*.ts",
  "apps/extension/entrypoints/**/*.ts",
  "apps/extension/entrypoints/**/*.tsx",
  "apps/extension/scripts/**/*.ts",
  "apps/browser-export-harness/src/**/*.ts",
  "apps/browser-export-harness/scripts/**/*.ts",
];

interface EmissionSite {
  file: string;
  code: string;
}

interface EmissionScan {
  /** Strict `code: "x"` sites adjacent to a `message:` (ExportNote shape). */
  literals: EmissionSite[];
  /** `code: \`prefix-${…}\`` sites (the resolver's placeholder-status codes). */
  templatePrefixes: EmissionSite[];
  /** Full text of every scanned file, for the lenient dead-code direction. */
  sources: Map<string, string>;
}

function collectEmissionSites(): EmissionScan {
  const literals: EmissionSite[] = [];
  const templatePrefixes: EmissionSite[] = [];
  const sources = new Map<string, string>();

  for (const pattern of SCAN_GLOBS) {
    for (const rel of new Glob(pattern).scanSync({ cwd: repoRoot })) {
      if (rel.endsWith(".test.ts") || rel.endsWith(".test.tsx") || rel.endsWith(".d.ts")) continue;
      if (sources.has(rel)) continue;
      const source = readFileSync(join(repoRoot, rel), "utf8");
      sources.set(rel, source);

      for (const match of source.matchAll(/code:\s*"([a-z0-9-]+)"/g)) {
        // ExportNote emissions carry a `message:` nearby; unrelated `code:`
        // properties (mark maps, exit codes, …) do not.
        const windowText = source.slice(Math.max(0, match.index - 400), match.index + 400);
        if (!windowText.includes("message:")) continue;
        literals.push({ file: rel, code: match[1]! });
      }

      for (const match of source.matchAll(/code:\s*`([a-z0-9-]+-)\$\{/g)) {
        templatePrefixes.push({ file: rel, code: match[1]! });
      }
    }
  }

  return { literals, templatePrefixes, sources };
}

describe("ExportNote.code registry (spec 009)", () => {
  const registry = new Set<string>(EXPORT_NOTE_CODES);
  const { literals, templatePrefixes, sources } = collectEmissionSites();

  it("the detector finds a plausible number of real emission sites", () => {
    // 35+ literal sites and the resolver's template site exist today; if this
    // drops sharply the detection regexes have rotted, not the codebase.
    expect(literals.length).toBeGreaterThanOrEqual(30);
    expect(templatePrefixes.length).toBeGreaterThanOrEqual(1);
  });

  it("every emitted literal code is a registry member", () => {
    const offenders = literals
      .filter((site) => !registry.has(site.code))
      .map((site) => `${site.file}: "${site.code}"`);
    expect(
      offenders,
      offenders.length
        ? `Unregistered ExportNote codes emitted (add to EXPORT_NOTE_CODES in ` +
          `packages/confluence/src/export-blocks.ts, or fix the call site):\n  ${offenders.join("\n  ")}`
        : undefined,
    ).toEqual([]);
  });

  it("every template-literal emission expands to at least one registry member", () => {
    const offenders = templatePrefixes
      .filter((site) => ![...registry].some((code) => code.startsWith(site.code)))
      .map((site) => `${site.file}: \`${site.code}\${…}\``);
    expect(offenders, offenders.join("\n")).toEqual([]);
  });

  it("every registry member is actually emitted somewhere (no dead codes)", () => {
    // Lenient direction: a member counts as alive if its quoted string
    // appears in any scanned non-test source (this also covers multi-line
    // ternary emissions like `known ? "macro-not-rendered" : "unknown-macro"`
    // that the strict site detector deliberately skips), or if a
    // template-literal prefix expands to it.
    const allSource = [...sources.values()].join("\n");
    const prefixes = templatePrefixes.map((site) => site.code);
    const dead = EXPORT_NOTE_CODES.filter(
      (code) => !allSource.includes(`"${code}"`) && !prefixes.some((prefix) => code.startsWith(prefix)),
    );
    expect(
      dead,
      dead.length
        ? `Registry members no emission site produces (renamed call site? remove or re-wire):\n  ${dead.join("\n  ")}`
        : undefined,
    ).toEqual([]);
  });

  /**
   * Vocabulary unification (spec 010). The registry checks above answer "is
   * this code known?"; these answer "do two emitters that observe the SAME
   * condition spell it the same way?" — the thing a `notesByCode` consumer
   * actually depends on, and the thing a type-checked union cannot express.
   */
  it("no retired code is emitted anywhere again", () => {
    // The alias table is the migration path, not a second live spelling. If a
    // retired code reappears at an emission site, the divergence is back.
    const retired = new Set<string>(Object.keys(RETIRED_EXPORT_NOTE_CODES));
    const offenders = literals
      .filter((site) => retired.has(site.code))
      .map((site) => `${site.file}: "${site.code}" → use "${RETIRED_EXPORT_NOTE_CODES[site.code as keyof typeof RETIRED_EXPORT_NOTE_CODES]}"`);
    expect(offenders, offenders.join("\n")).toEqual([]);
  });

  it("both PDF hosts spell the unresolved-mention fact identically", () => {
    // The CLI's PDF host and the extension's PDF host observe the very same
    // condition — an account id that did not resolve to a display name — from
    // the same `resolveExportMentions` result. They are separate processes with
    // no shared call site, so nothing but this assertion keeps their spelling
    // together. (Each side's own runtime behaviour is pinned separately: the CLI
    // in `apps/cli/src/commands/engine-parity.test.ts`, the extension in
    // `apps/extension/tests/pdf/run-export.test.ts`.)
    const hosts = ["apps/cli/src/commands/export-pdf.ts", "apps/extension/utils/pdf/run-export.ts"];
    const spellings = new Map<string, string[]>();
    for (const host of hosts) {
      const source = sources.get(host);
      expect(source, `${host} must be scanned (path moved?)`).toBeDefined();
      spellings.set(
        host,
        [...source!.matchAll(/code:\s*"([a-z0-9-]*mention-unresolved)"/g)].map((m) => m[1]!),
      );
    }
    for (const [host, codes] of spellings) {
      expect(codes.length, `${host} must emit an unresolved-mention note`).toBeGreaterThan(0);
    }
    const distinct = new Set([...spellings.values()].flat());
    expect(
      [...distinct],
      `The two PDF hosts disagree on the unresolved-mention code: ${JSON.stringify(Object.fromEntries(spellings))}`,
    ).toEqual(["mention-unresolved"]);
  });
});
