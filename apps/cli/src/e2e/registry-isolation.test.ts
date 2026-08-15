/**
 * Regression: `mock.module` stubs must not leak out of the file that installed
 * them.
 *
 * Three command tests replace whole `@atlcli/*` barrels with `mock.module`,
 * which is process-wide. They now restore the real modules in `afterAll`; two
 * details make that easy to get wrong, and both were:
 *
 *  - the restore snapshot must be taken BEFORE the mock is installed (spreading
 *    the live module namespace afterwards just copies the stubs back out), and
 *  - `mock.module` must be handed a plain object, not the namespace itself.
 *
 * Asserting this from an ordinary test file would pin it by alphabetical luck —
 * the same fragility that let the original bug through. So this spawns a real
 * `bun test` process with an explicit file order: the three polluters first,
 * the probe last. Same approach as `commands/auth-test-isolation.test.ts`.
 */

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..", "..", "..", "..");

const POLLUTERS = [
  "apps/cli/src/commands/auth.test.ts",
  "apps/cli/src/commands/helloworld.test.ts",
  "apps/cli/src/commands/session-guard.test.ts",
];
const PROBE = "apps/cli/src/e2e/registry-probe.test.ts";

describe("mock.module isolation", () => {
  test("the real @atlcli barrels survive every mock.module user", () => {
    const res = spawnSync(
      "bun",
      // `--conditions=development` keeps the in-repo `@atlcli/*` resolution
      // working (spec 009); without it the probe cannot import the real
      // packages at all and the test would pass for the wrong reason.
      ["--conditions=development", "test", ...POLLUTERS, PROBE],
      { cwd: REPO_ROOT, encoding: "utf8", timeout: 120_000 }
    );
    const output = `${res.stdout ?? ""}${res.stderr ?? ""}`;

    // The exact symptom of the leak, asserted directly so a future regression
    // reads as itself rather than as a generic failure.
    expect(output).not.toContain("logger.api is not a function");
    expect(output).not.toContain("should not be constructed");
    expect(output).toContain(" 0 fail");
    expect(res.status).toBe(0);
  }, 120_000);
});
