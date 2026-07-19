import { describe, expect, it } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertNoWorkspaceLeak,
  buildPackages,
  packAll,
  run,
  scaffoldConsumer,
} from "./consumer-smoke.js";

/**
 * Package-manager install matrix (spec 009, Build artifacts support-matrix
 * task): the SAME packed tarballs must install with npm and pnpm, not only
 * bun — the consumer-smoke suites prove the Bun (and npm-via-node-smoke)
 * paths end-to-end; this matrix proves plain installability per manager.
 * Runs behind ATLCLI_CONSUMER_SMOKE=1 like the other consumer suites
 * (registry access for transitive deps).
 */

const enabled = process.env.ATLCLI_CONSUMER_SMOKE === "1";

if (!enabled) {
  console.log(
    "install-matrix: SKIPPED — set ATLCLI_CONSUMER_SMOKE=1 to run the npm/pnpm tarball install matrix.",
  );
}

function managerAvailable(manager: string): string | null {
  // Probe from a neutral directory: probing from the repo root would make
  // pnpm refuse outright because the ROOT package.json pins
  // `packageManager: "bun@…"` (corepack-style check) — the temp consumer
  // projects carry no such pin.
  const res = run([manager, "--version"], tmpdir());
  return res.exitCode === 0 ? res.stdout.trim() : null;
}

describe.skipIf(!enabled)("tarball install matrix (spec 009)", () => {
  const workDir = join(tmpdir(), `atlcli-install-matrix-${process.pid}`);
  let dependencies: Record<string, string> | undefined;

  it(
    "builds and packs the publishable set once",
    () => {
      rmSync(workDir, { recursive: true, force: true });
      buildPackages();
      const tarballs = packAll(join(workDir, "tarballs"));
      expect(tarballs.size).toBeGreaterThanOrEqual(8);
      dependencies = Object.fromEntries(
        [...tarballs.entries()].map(([name, path]) => [name, `file:${path}`]),
      );
    },
    240000,
  );

  const matrix: Array<{ manager: string; installArgs: string[] }> = [
    { manager: "npm", installArgs: ["install", "--no-audit", "--no-fund"] },
    { manager: "pnpm", installArgs: ["install"] },
  ];

  for (const { manager, installArgs } of matrix) {
    it(
      `${manager} installs all tarballs with internal ranges resolving locally`,
      () => {
        const version = managerAvailable(manager);
        if (!version) {
          // Loud, unmissable skip — a missing manager must not silently pass.
          console.error(
            `install-matrix: ${manager} IS NOT INSTALLED on this machine — the ${manager} ` +
              `leg of the install matrix DID NOT RUN. Install ${manager} to cover it.`,
          );
          return;
        }
        console.log(`install-matrix: ${manager} ${version}`);

        if (!dependencies) throw new Error("pack step did not run — cannot install");
        const projectDir = join(workDir, `consumer-${manager}`);
        scaffoldConsumer(projectDir, { dependencies });

        const res = run([manager, ...installArgs], projectDir);
        expect(
          res.exitCode,
          `${manager} install failed:\n${res.stdout}\n${res.stderr}`,
        ).toBe(0);
        assertNoWorkspaceLeak(projectDir);
      },
      300000,
    );
  }
});
