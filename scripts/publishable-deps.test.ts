/**
 * Publishable packages must only reference publishable workspace packages
 * (spec 009). The pinned consumer-smoke leg installs every publishable
 * package through `file:` links, and bun resolves their `workspace:*`
 * dependency AND devDependency specs against that link matrix — a spec
 * pointing at a `private: true` package cannot resolve there and fails the
 * whole consumer install (seen live: a test-only devDependency on
 * @atlcli/export-fixtures from @atlcli/pdf-compiler-browser). This guard
 * fails the same defect in every local suite run instead of minutes later
 * in CI's consumer leg.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

interface Manifest {
  name?: string;
  private?: boolean;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

const packagesDir = join(import.meta.dir, "..", "packages");

function manifests(): Map<string, Manifest> {
  const result = new Map<string, Manifest>();
  for (const entry of readdirSync(packagesDir)) {
    let manifest: Manifest;
    try {
      manifest = JSON.parse(
        readFileSync(join(packagesDir, entry, "package.json"), "utf8"),
      ) as Manifest;
    } catch {
      continue;
    }
    if (manifest.name) result.set(manifest.name, manifest);
  }
  return result;
}

describe("publishable workspace boundaries", () => {
  test("publishable packages never depend on private workspace packages", () => {
    const all = manifests();
    const violations: string[] = [];
    for (const [name, manifest] of all) {
      if (manifest.private === true) continue;
      for (const [section, deps] of [
        ["dependencies", manifest.dependencies],
        ["devDependencies", manifest.devDependencies],
      ] as const) {
        for (const [dep, spec] of Object.entries(deps ?? {})) {
          if (!spec.startsWith("workspace:")) continue;
          const target = all.get(dep);
          if (target && target.private === true) {
            violations.push(`${name} ${section} -> ${dep} (private)`);
          }
        }
      }
    }
    expect(violations).toEqual([]);
  });
});
