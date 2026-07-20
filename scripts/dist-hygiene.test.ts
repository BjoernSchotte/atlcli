import { describe, expect, it } from "bun:test";
import { Glob } from "bun";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Dist hygiene regression tests (spec 009, Build artifacts).
 *
 * 1. Builds the publishable packages (real `turbo run build`, cached on
 *    re-runs) — this test fails loudly if the build fails, it never skips.
 * 2. Asserts every publishable package emitted dist JS + .d.ts.
 * 3. Asserts no emitted `dist` file references a `../` path that escapes the
 *    package (a compiled file reaching into a sibling package's `src/` would
 *    mean `rootDir`/exports resolution regressed).
 * 4. Asserts the built `@atlcli/confluence` default entrypoint imports under
 *    **plain Node** — the regression guard for the `bun:sqlite` barrel leak
 *    (the wide barrel used to reach `bun:sqlite` via sync-db and threw at
 *    import time outside Bun).
 */

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Workspace packages classified for external distribution (atlcli.publish). */
function publishablePackageDirs(): string[] {
  const rootPkg = JSON.parse(
    readFileSync(join(repoRoot, "package.json"), "utf8"),
  ) as { workspaces?: string[] };
  const dirs: string[] = [];
  for (const pattern of rootPkg.workspaces ?? []) {
    const glob = new Glob(`${pattern}/package.json`);
    for (const rel of glob.scanSync({ cwd: repoRoot, onlyFiles: true })) {
      const manifest = JSON.parse(readFileSync(join(repoRoot, rel), "utf8")) as {
        atlcli?: { publish?: string };
      };
      if (manifest.atlcli?.publish) dirs.push(join(repoRoot, dirname(rel)));
    }
  }
  return dirs.sort();
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

/** Module specifiers in compiled JS / declaration files. */
function moduleSpecifiers(source: string): string[] {
  const out: string[] = [];
  const patterns = [
    /(?:^|\s)(?:import|export)\s+[^"'()]*?from\s+["']([^"']+)["']/gm,
    /(?:^|\s)import\s+["']([^"']+)["']/gm,
    /import\(\s*["']([^"']+)["']\s*\)/g,
    /require\(\s*["']([^"']+)["']\s*\)/g,
    /\/\/\/\s*<reference\s+path=["']([^"']+)["']/g,
  ];
  for (const re of patterns) {
    for (const m of source.matchAll(re)) out.push(m[1]!);
  }
  return out;
}

const packageDirs: string[] = publishablePackageDirs();

describe("dist hygiene (spec 009)", () => {
  // Runs first (bun executes tests in file order): the later assertions all
  // inspect the dist output this build produces. A failed build fails the
  // suite loudly — it never skips.
  it(
    "the publishable packages build (turbo run build --filter=./packages/*)",
    () => {
      const build = Bun.spawnSync(
        ["bunx", "turbo", "run", "build", "--filter=./packages/*", "--output-logs=errors-only"],
        { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] },
      );
      if (build.exitCode !== 0) {
        throw new Error(
          `turbo run build --filter=./packages/* failed (exit ${build.exitCode}):\n` +
            `${build.stdout.toString()}\n${build.stderr.toString()}`,
        );
      }
    },
    120000,
  );

  it("found the eight publishable packages via their atlcli.publish classification", () => {
    expect(packageDirs.length).toBeGreaterThanOrEqual(8);
  });

  it("every publishable package emitted dist JS and declarations", () => {
    for (const pkgDir of packageDirs) {
      const dist = join(pkgDir, "dist");
      expect(existsSync(dist), `${pkgDir} has no dist/ after build`).toBe(true);
      const files = walk(dist);
      expect(
        files.some((f) => f.endsWith(".js")),
        `${dist} contains no .js output`,
      ).toBe(true);
      expect(
        files.some((f) => f.endsWith(".d.ts")),
        `${dist} contains no .d.ts output`,
      ).toBe(true);
    }
  });

  it("no dist file references a ../ path escaping its package", () => {
    const offenders: string[] = [];

    for (const pkgDir of packageDirs) {
      const dist = join(pkgDir, "dist");
      if (!existsSync(dist)) continue;

      for (const file of walk(dist)) {
        const fileDir = dirname(file);

        if (file.endsWith(".map")) {
          // Source maps may reference ../src inside the same package, never
          // beyond the package root.
          const map = JSON.parse(readFileSync(file, "utf8")) as { sources?: string[] };
          for (const source of map.sources ?? []) {
            const resolved = resolve(fileDir, source);
            if (!resolved.startsWith(`${pkgDir}/`)) {
              offenders.push(`${file}: map source "${source}" escapes ${pkgDir}`);
            }
          }
          continue;
        }

        if (!file.endsWith(".js") && !file.endsWith(".d.ts")) continue;

        const source = readFileSync(file, "utf8");
        for (const spec of moduleSpecifiers(source)) {
          if (!spec.startsWith(".")) continue; // bare specifiers go through exports maps
          const resolved = resolve(fileDir, spec);
          // Compiled code must stay inside its own dist tree — reaching back
          // into src/ (or a sibling package) breaks packed tarballs, which
          // ship dist only.
          if (!resolved.startsWith(`${dist}/`) && resolved !== dist) {
            offenders.push(`${file}: specifier "${spec}" resolves outside dist (${resolved})`);
          }
        }
      }
    }

    expect(
      offenders,
      offenders.length ? `dist path hygiene violated:\n  ${offenders.join("\n  ")}` : undefined,
    ).toEqual([]);
  });

  it("the built @atlcli/confluence default entrypoint imports under plain Node (no bun:sqlite leak)", () => {
    const entry = join(repoRoot, "packages/confluence/dist/index.js");
    expect(existsSync(entry), `${entry} missing — build did not emit it`).toBe(true);

    const probe = Bun.spawnSync(
      [
        "node",
        "--input-type=module",
        "-e",
        `const m = await import(${JSON.stringify(entry)});` +
          `if (typeof m.storageToBlocks !== "function") throw new Error("storageToBlocks missing from barrel");` +
          `console.log("NODE_IMPORT_OK");`,
      ],
      { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] },
    );

    const stderr = probe.stderr.toString();
    expect(stderr, `plain-node import failed:\n${stderr}`).not.toContain("bun:sqlite");
    expect(probe.exitCode, `plain-node import failed:\n${stderr}`).toBe(0);
    expect(probe.stdout.toString()).toContain("NODE_IMPORT_OK");
  });
});
