import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { EXTENSION_ROOT } from "./build-helper.js";

/**
 * Regression (finding 6): the root `typecheck` script must cover the extension
 * sources. The root tsconfig `include` only globs `**​/src/**`, which the
 * extension (entrypoints/**, utils/**) does not use — so a bare `tsc --noEmit`
 * silently skips the extension. PLAN §2.4 claims root-flow coverage, so the
 * root script must also run the extension's own typecheck.
 */
describe("root typecheck coverage", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rootPkg: any = JSON.parse(
    readFileSync(join(EXTENSION_ROOT, "..", "..", "package.json"), "utf8")
  );

  it("root `typecheck` runs the extension typecheck too", () => {
    const script: string = rootPkg.scripts.typecheck;
    expect(script).toContain("tsc --noEmit");
    // Chains the extension typecheck (directly or via the typecheck:extension
    // turbo script) so one root command covers the extension workspace.
    expect(
      script.includes("typecheck:extension") ||
        script.includes("--cwd apps/extension")
    ).toBe(true);
  });

  it("keeps a dedicated extension typecheck script for CI parity", () => {
    expect(typeof rootPkg.scripts["typecheck:extension"]).toBe("string");
    expect(rootPkg.scripts["typecheck:extension"]).toContain("@atlcli/extension");
  });
});
