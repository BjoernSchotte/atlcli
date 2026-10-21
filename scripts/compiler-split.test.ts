import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..");
const TS7_ALIAS = "npm:typescript@^7.0.2";
const TS6_API_ALIAS = "npm:@typescript/typescript6@^6.0.2";

/**
 * Guard for specs/typescript-7-migration: `tsc` is the TypeScript 7 native
 * compiler, while `import "typescript"` is the TypeScript 6 compiler API that
 * api-report, api-closure, check-browser-build, the phase-1 guard and
 * @astrojs/check still need (7.0 ships no programmatic API). A plain
 * `bun add -d typescript` would silently collapse that split.
 */
describe("TypeScript compiler split (TS 7 tsc, TS 6 API)", () => {
  it("runs TypeScript 7 as tsc", () => {
    const res = Bun.spawnSync([join(REPO_ROOT, "node_modules/.bin/tsc"), "-v"]);
    expect(res.stdout.toString()).toStartWith("Version 7.");
  });

  it("resolves the typescript module to the TypeScript 6 compiler API", () => {
    const ts = createRequire(join(REPO_ROOT, "package.json"))("typescript") as {
      version: string;
      createProgram?: unknown;
    };
    expect(ts.version).toStartWith("6.");
    expect(typeof ts.createProgram).toBe("function");
  });

  it("declares the split identically wherever typescript is a dependency", () => {
    for (const manifest of ["package.json", "apps/browser-export-harness/package.json"]) {
      const pkg = JSON.parse(readFileSync(join(REPO_ROOT, manifest), "utf8")) as {
        devDependencies?: Record<string, string>;
      };
      expect(pkg.devDependencies?.["@typescript/native"], manifest).toBe(TS7_ALIAS);
      expect(pkg.devDependencies?.typescript, manifest).toBe(TS6_API_ALIAS);
    }
  });

  it("keeps the extension's ambient types explicit (TS 7 defaults types to [])", () => {
    const tsconfig = JSON.parse(
      readFileSync(join(REPO_ROOT, "apps/extension/tsconfig.json"), "utf8"),
    ) as { compilerOptions?: { types?: string[] } };
    expect(tsconfig.compilerOptions?.types).toContain("chrome");
  });
});
