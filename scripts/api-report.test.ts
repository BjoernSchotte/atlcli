import { describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPackages } from "./consumer-smoke.js";
import { generateAllReports, reportForDts } from "./api-report.js";
import { generateAllClosures, closureForEntrypoints } from "./api-closure.js";

/**
 * API report guard (spec 009, API freeze & guards).
 *
 * 1. Builds the packages for real (never vacuous against missing/stale dist),
 *    regenerates every report in memory, and fails on any diff against the
 *    committed `packages/<p>/etc/<p>.api.md`.
 * 2. Guards the guard: the real generator runs on a tiny fixture entrypoint
 *    and must produce a differing report when an export is removed, a
 *    signature changes, or a `@deprecated` tag is dropped.
 */

describe("api-report guard (spec 009)", () => {
  it(
    "the publishable packages build (reports must come from fresh dist)",
    () => {
      buildPackages();
    },
    180000,
  );

  it(
    "every committed api report matches the built public surface",
    () => {
      const offenders: string[] = [];
      for (const report of generateAllReports()) {
        if (report.committed === null) {
          offenders.push(`${report.name}: no committed report at ${report.reportPath}`);
        } else if (report.committed !== report.generated) {
          offenders.push(`${report.name}: ${report.reportPath} is stale`);
        }
      }
      expect(
        offenders,
        offenders.length
          ? `Public API surface changed without a reviewed report update:\n  ${offenders.join("\n  ")}\n` +
            `Run \`bun scripts/api-report.ts --update\` and have the diff reviewed.`
          : undefined,
      ).toEqual([]);
    },
    120000,
  );

  it(
    "every committed closure classification matches the built surface, with zero reachable-but-unexported gaps",
    () => {
      const offenders: string[] = [];
      for (const closure of generateAllClosures()) {
        if (closure.committed === null) {
          offenders.push(`${closure.name}: no committed classification at ${closure.path}`);
        } else if (closure.committed !== closure.generated) {
          offenders.push(`${closure.name}: ${closure.path} is stale`);
        }
        if (closure.generated.includes("reachable-but-unexported gaps (")) {
          offenders.push(
            `${closure.name}: a stable entrypoint reaches unexported types — export them or reclassify`,
          );
        }
      }
      expect(
        offenders,
        offenders.length
          ? `Closure classification out of date:\n  ${offenders.join("\n  ")}\n` +
            `Run \`bun scripts/api-closure.ts --update\` and have the diff reviewed.`
          : undefined,
      ).toEqual([]);
    },
    120000,
  );

  it("guard-the-guard: the closure detector reports a gap for a non-barrel type reference", () => {
    // A synthetic package laid out so ownerOf() recognizes it
    // (…/packages/<name>/dist/…). The stable entrypoint exports a function
    // whose parameter references a type declared in the SAME package but not
    // re-exported from any stable entrypoint — the exact "reachable-but-
    // unexported" shape the freeze guard must catch.
    const root = mkdtempSync(join(tmpdir(), "atlcli-closure-guard-"));
    const distDir = join(root, "packages", "gap-fixture", "dist");
    require("node:fs").mkdirSync(distDir, { recursive: true });
    writeFileSync(
      join(distDir, "hidden.d.ts"),
      `export interface HiddenShape { width: number; }\n`,
    );
    writeFileSync(
      join(distDir, "index.d.ts"),
      `import type { HiddenShape } from "./hidden.js";\n` +
        `export declare function frozen(input: HiddenShape): void;\n`,
    );

    const entry = join(distDir, "index.d.ts");
    const [closure] = closureForEntrypoints("@atlcli/gap-fixture", [
      { label: ".", dtsPath: entry, stability: "stable" },
    ]);

    expect(closure!.stability).toBe("stable");
    expect(closure!.exports).toContain("frozen");
    // HiddenShape is same-package, reachable from `frozen`, and not exported →
    // it must be reported as a gap.
    expect(closure!.gaps).toContain("HiddenShape");

    // Re-exporting it closes the gap.
    writeFileSync(
      join(distDir, "index.d.ts"),
      `import type { HiddenShape } from "./hidden.js";\n` +
        `export type { HiddenShape } from "./hidden.js";\n` +
        `export declare function frozen(input: HiddenShape): void;\n`,
    );
    const [fixed] = closureForEntrypoints("@atlcli/gap-fixture", [
      { label: ".", dtsPath: entry, stability: "stable" },
    ]);
    expect(fixed!.gaps).toEqual([]);
  });

  it("guard-the-guard: surface changes on a fixture entrypoint produce failing diffs", () => {
    const dir = mkdtempSync(join(tmpdir(), "atlcli-api-report-fixture-"));
    const dts = join(dir, "entry.d.ts");

    const baselineSource = `
/** @deprecated use keep instead */
export declare function old(): void;
export declare function keep(a: string): number;
export interface Shape {
    width: number;
}
`;
    writeFileSync(dts, baselineSource);
    const baseline = reportForDts(dts);
    expect(baseline).toContain("// export: keep");
    expect(baseline).toContain("// @deprecated old — use keep instead");

    // Removed export → diff.
    writeFileSync(dts, baselineSource.replace(/\/\*\* @deprecated[^]*?old\(\): void;\n/, ""));
    const removed = reportForDts(dts);
    expect(removed).not.toBe(baseline);
    expect(removed).not.toContain("// export: old");

    // Changed signature → diff.
    writeFileSync(dts, baselineSource.replace("keep(a: string)", "keep(a: number)"));
    expect(reportForDts(dts)).not.toBe(baseline);

    // Dropped @deprecated tag (identical runtime surface) → diff.
    writeFileSync(dts, baselineSource.replace("/** @deprecated use keep instead */\n", ""));
    const undeprecated = reportForDts(dts);
    expect(undeprecated).not.toBe(baseline);
    expect(undeprecated).not.toContain("@deprecated");

    // And the baseline itself is reproducible.
    writeFileSync(dts, baselineSource);
    expect(reportForDts(dts)).toBe(baseline);
  });
});
