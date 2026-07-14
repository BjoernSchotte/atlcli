import { describe, test, expect } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

/**
 * Regression: the git-hooks test file must leave the process exit code clean.
 *
 * Its failure-path tests exercise handlers that set `process.exitCode = 1` and
 * then reset it. The reset used `process.exitCode = undefined`, which Bun
 * (observed on 1.3.8) does NOT honor — the prior numeric value sticks — so the
 * whole `bun test` process exited 1 with ZERO test failures, silently turning
 * CI red. The reset now assigns `0`, which Bun applies.
 *
 * This meta-test pins the observable symptom: running the file standalone must
 * exit 0. It also documents the Bun-vs-Node semantic difference so the
 * `= undefined` pattern is not reintroduced.
 */

const REPO_ROOT = join(import.meta.dir, "..", "..", "..");

describe("git-hooks.test.ts exit-code hygiene", () => {
  test("standalone run exits 0 (no lingering process.exitCode)", () => {
    const res = spawnSync(
      "bun",
      ["test", "plugins/plugin-git/src/git-hooks.test.ts"],
      { cwd: REPO_ROOT, encoding: "utf8", timeout: 60_000 }
    );
    const output = `${res.stdout ?? ""}${res.stderr ?? ""}`;
    expect(output).toContain(" 0 fail");
    expect(res.status).toBe(0);
  }, 60_000);

  test("Bun honors a numeric reset of process.exitCode (documented quirk)", () => {
    // `= undefined` is NOT a reliable reset in Bun; `= 0` is. Pin both facts so
    // a Bun behavior change (or a revert to `undefined`) surfaces here.
    const probe = spawnSync(
      "bun",
      ["-e", "process.exitCode = 1; process.exitCode = 0;"],
      { encoding: "utf8", timeout: 15_000 }
    );
    expect(probe.status).toBe(0);
  }, 15_000);
});
