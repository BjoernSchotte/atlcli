import { describe, test, expect } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

/**
 * Regression: `auth.test.ts` must pass when run IN ISOLATION.
 *
 * Its `mock.module("@atlcli/core", ...)` used to provide only a partial export
 * set. Bun's mock semantics made that order-dependent: if the real barrel was
 * already evaluated (by an earlier test file in a full run), missing exports
 * fell through to the real module and everything passed; if not (isolated run,
 * or a full run whose file order no longer pre-loads @atlcli/core), the factory
 * became the COMPLETE module and `import { resolveDeploymentType } ...` in
 * ./auth.ts failed with a load-time SyntaxError. The spec-002 test-set change
 * flipped the full-suite order and turned this latent bug into a red CI run.
 *
 * The fix spreads the real module into the mock factory. This meta-test pins
 * the isolated invocation — the exact mode that was broken — by spawning it as
 * its own `bun test` process, so a partial mock can never regress silently
 * behind a lucky file order again.
 */

const REPO_ROOT = join(import.meta.dir, "..", "..", "..", "..");

describe("auth.test.ts isolation", () => {
  test("passes when run standalone (no other test file pre-loads @atlcli/core)", () => {
    const res = spawnSync(
      "bun",
      ["test", "apps/cli/src/commands/auth.test.ts"],
      { cwd: REPO_ROOT, encoding: "utf8", timeout: 60_000 }
    );
    const output = `${res.stdout ?? ""}${res.stderr ?? ""}`;
    expect(output).not.toContain("SyntaxError");
    expect(output).toContain(" 0 fail");
    expect(res.status).toBe(0);
  }, 60_000);
});
