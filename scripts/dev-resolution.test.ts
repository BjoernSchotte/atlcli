import { describe, expect, it } from "bun:test";

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
    const resolved = import.meta.resolve("@atlcli/pdf/browser");
    expect(
      resolved.endsWith("/packages/pdf/src/index.browser.ts"),
      `@atlcli/pdf/browser resolved to\n  ${resolved}\nexpected live src/. ` +
        `You are running tests without the "development" export condition, ` +
        `so imports hit (possibly stale or missing) dist/ builds.\n` +
        `Run tests via "bun run test [files]" or "bun --conditions=development test [files]".`,
    ).toBe(true);
  });
});
