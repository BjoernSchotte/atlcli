import { describe, expect, it } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));

interface TurboTask {
  cache?: boolean;
  dependsOn?: string[];
  inputs?: string[];
  outputs?: string[];
}

interface TurboConfig {
  extends?: string[];
  tasks: Record<string, TurboTask>;
}

interface PackageManifest {
  scripts?: Record<string, string>;
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(join(REPO_ROOT, path), "utf8")) as T;
}

const requiredBrowserInputs = [
  "$TURBO_DEFAULT$",
  "$TURBO_ROOT$/packages/*/src/**",
  "$TURBO_ROOT$/packages/docx/fonts/**",
  "$TURBO_ROOT$/packages/pdf/scripts/ensure-fonts.ts",
  "$TURBO_ROOT$/packages/pdf/.fonts/**",
  "$TURBO_ROOT$/packages/pdf/licenses/**",
  "$TURBO_ROOT$/packages/pdf-compiler-browser/scripts/**",
  "$TURBO_ROOT$/packages/pdf-compiler-browser/vendor/**",
  "$TURBO_ROOT$/patches/**",
  "$TURBO_ROOT$/LICENSE",
] as const;

describe("Turbo cache policy", () => {
  it("keeps package and root CLI outputs owned by separate tasks", async () => {
    const root = await readJson<TurboConfig>("turbo.json");
    const cli = await readJson<TurboConfig>("apps/cli/turbo.json");

    expect(root.tasks.build?.outputs).toEqual(["dist/**"]);
    expect(root.tasks.build?.inputs).toContain("$TURBO_DEFAULT$");
    expect(root.tasks.build?.inputs).toContain("$TURBO_ROOT$/patches/**");

    expect(cli.extends).toEqual(["//"]);
    expect(cli.tasks.build?.outputs).toEqual(["../../dist/**"]);
    expect(cli.tasks.build?.inputs).toContain("$TURBO_DEFAULT$");
    expect(cli.tasks.build?.inputs).toContain("build.ts");
  });

  it("hashes local app files and the complete external browser-build closure", async () => {
    for (const path of [
      "apps/extension/turbo.json",
      "apps/browser-export-harness/turbo.json",
    ]) {
      const config = await readJson<TurboConfig>(path);
      for (const taskName of ["build", "typecheck"]) {
        const inputs = config.tasks[taskName]?.inputs ?? [];
        for (const input of requiredBrowserInputs) {
          expect(inputs, `${path} ${taskName} omits ${input}`).toContain(input);
        }
      }
    }
  });

  it("does not serialize source-bundling apps behind unused package dist builds", async () => {
    const rootPackage = await readJson<PackageManifest>("package.json");
    expect(rootPackage.scripts?.build).toBe("turbo run build");

    for (const path of [
      "apps/extension/turbo.json",
      "apps/browser-export-harness/turbo.json",
    ]) {
      const config = await readJson<TurboConfig>(path);
      expect(config.tasks.build?.dependsOn, path).toEqual([]);
    }
  });

  it("routes the browser-build gate through a distinct cacheable root task", async () => {
    const root = await readJson<TurboConfig>("turbo.json");
    const rootPackage = await readJson<PackageManifest>("package.json");
    const task = root.tasks["//#check:browser:internal"];

    expect(rootPackage.scripts?.["check:browser"]).toBe(
      "turbo run check:browser:internal",
    );
    expect(rootPackage.scripts?.["check:browser:internal"]).toBe(
      "bun scripts/check-browser-build.ts",
    );
    expect(task?.cache).toBe(true);
    expect(task?.outputs).toEqual([]);
    expect(task?.inputs).toContain("packages/*/src/**");
    expect(task?.inputs).toContain("packages/pdf-compiler-browser/vendor/**");
    expect(task?.inputs).toContain("patches/**");
  });

  it("keeps stateful browser verification uncached", async () => {
    const harness = await readJson<TurboConfig>(
      "apps/browser-export-harness/turbo.json",
    );
    expect(harness.tasks["check:output"]?.cache).toBe(false);
    expect(harness.tasks["test:e2e"]?.cache).toBe(false);
  });
});
