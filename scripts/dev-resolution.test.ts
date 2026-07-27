import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..");

/**
 * Canary for spec 009's development-condition contract.
 *
 * The workspace manifests export dist/ targets by default and live src/ only
 * under the "development" condition. Bun's runtime does NOT request that
 * condition on its own (verified empirically — `bunfig.toml` has no conditions
 * knob either), so a bare `bun test` would silently exercise stale dist/
 * output — or fail outright on a fresh clone with no dist/ at all.
 *
 * This test turns that silent hazard into a loud, explained failure: it
 * asserts in-repo resolution reaches src/, which only holds when the process
 * was started with `--conditions=development` (the root `bun run test` /
 * `bun run start` scripts do this).
 */
describe("development-condition resolution (spec 009)", () => {
  it("resolves @atlcli/* workspace imports to live src/, not dist/", () => {
    // Resolve from a workspace package's context (scripts/ sits under the
    // root package, whose own resolution context is not what in-repo package
    // code experiences).
    const parent = new URL("../packages/pdf-compiler-browser/", import.meta.url)
      .pathname;
    const resolved = Bun.resolveSync("@atlcli/pdf/browser", parent);
    expect(
      resolved.endsWith("/packages/pdf/src/index.browser.ts"),
      `@atlcli/pdf/browser resolved to\n  ${resolved}\nexpected live src/. ` +
        `You are running tests without the "development" export condition, ` +
        `so imports hit (possibly stale or missing) dist/ builds.\n` +
        `Run tests via "bun run test [files]" or "bun --conditions=development test [files]".`,
    ).toBe(true);
  });

  it("pins development resolution in nested Bun subprocesses", () => {
    const authIsolation = readFileSync(
      join(REPO_ROOT, "apps/cli/src/commands/auth-test-isolation.test.ts"),
      "utf8",
    );
    const pluginCommand = readFileSync(
      join(REPO_ROOT, "apps/cli/src/commands/plugin.test.ts"),
      "utf8",
    );
    const harnessPackage = JSON.parse(
      readFileSync(
        join(REPO_ROOT, "apps/browser-export-harness/package.json"),
        "utf8",
      ),
    ) as { scripts?: Record<string, string> };

    expect(authIsolation).toContain('"--conditions=development"');
    expect(pluginCommand).toContain(
      '[process.execPath, "--conditions=development", "run", cliPath',
    );
    for (const script of ["check:output", "check:parity", "test:unit"]) {
      expect(harnessPackage.scripts?.[script]).toStartWith(
        "bun --conditions=development ",
      );
    }
  });
});
