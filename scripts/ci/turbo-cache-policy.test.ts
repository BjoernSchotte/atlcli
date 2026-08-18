import { describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
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
  globalDependencies?: string[];
  tasks: Record<string, TurboTask>;
}

interface PackageManifest {
  scripts?: Record<string, string>;
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(join(REPO_ROOT, path), "utf8")) as T;
}

function run(command: string[], cwd: string): string {
  const result = Bun.spawnSync(command, { cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) {
    throw new Error(
      `${command.join(" ")} failed:\n${result.stdout.toString()}${result.stderr.toString()}`,
    );
  }
  return result.stdout.toString();
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
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
    expect(rootPackage.scripts?.build).toBe("turbo run build --summarize");

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
      "turbo run check:browser:internal --summarize",
    );
    expect(rootPackage.scripts?.["check:browser:internal"]).toBe(
      "bun scripts/check-browser-build.ts",
    );
    expect(task?.cache).toBe(true);
    expect(task?.outputs).toEqual([]);
    expect(task?.inputs).toContain("packages/*/src/**");
    expect(task?.inputs).toContain("packages/pdf-compiler-browser/vendor/**");
    expect(task?.inputs).toContain("patches/**");
    expect(task?.inputs).toContain("bun.lock");
  });

  it("keeps Bun lockfile changes package-aware outside cross-workspace root tasks", async () => {
    const root = await readJson<TurboConfig>("turbo.json");
    expect(root.globalDependencies).toEqual(["package.json", "tsconfig.json"]);
    expect(root.globalDependencies).not.toContain("bun.lock");
    expect(root.tasks["//#typecheck:root"]?.inputs).toContain("bun.lock");
    expect(root.tasks["//#check:browser:internal"]?.inputs).toContain("bun.lock");
  });

  it("preserves unrelated package hashes when a Bun lockfile change belongs to one workspace", async () => {
    const fixture = await mkdtemp(join(tmpdir(), "atlcli-turbo-lockfile-"));
    const packages = join(fixture, "packages");
    const turboBin = join(REPO_ROOT, "node_modules", "turbo", "bin", "turbo");
    const packageManifest = (name: string, dependencies: Record<string, string> = {}) => ({
      name,
      private: true,
      scripts: { build: "bun -e ''" },
      dependencies,
    });
    const hashes = (): Record<string, string> => {
      const dry = JSON.parse(run([
        process.execPath,
        turboBin,
        "run",
        "build",
        "--dry=json",
        "--filter=@fixture/a",
        "--filter=@fixture/b",
      ], fixture)) as { tasks: Array<{ taskId: string; hash: string }> };
      return Object.fromEntries(dry.tasks.map((task) => [task.taskId, task.hash]));
    };

    try {
      for (const name of ["a", "b", "shared", "extra"]) {
        await mkdir(join(packages, name), { recursive: true });
      }
      await writeJson(join(fixture, "package.json"), {
        name: "turbo-lockfile-fixture",
        private: true,
        packageManager: "bun@1.3.14",
        workspaces: ["packages/*"],
      });
      await writeJson(join(fixture, "turbo.json"), {
        $schema: "https://turbo.build/schema.json",
        tasks: { build: { cache: true, outputs: [] } },
      });
      await writeJson(join(packages, "a", "package.json"), packageManifest("@fixture/a", {
        "@fixture/shared": "workspace:*",
      }));
      await writeJson(join(packages, "b", "package.json"), packageManifest("@fixture/b"));
      await writeJson(join(packages, "shared", "package.json"), packageManifest("@fixture/shared"));
      await writeJson(join(packages, "extra", "package.json"), packageManifest("@fixture/extra"));

      run([process.execPath, "install", "--ignore-scripts"], fixture);
      const before = hashes();
      await writeJson(join(packages, "b", "package.json"), packageManifest("@fixture/b", {
        "@fixture/extra": "workspace:*",
      }));
      run([process.execPath, "install", "--ignore-scripts"], fixture);
      const after = hashes();

      expect(after["@fixture/a#build"]).toBe(before["@fixture/a#build"]);
      expect(after["@fixture/b#build"]).not.toBe(before["@fixture/b#build"]);
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  });

  it("runs the complete typecheck coverage in one summarized Turbo graph", async () => {
    const root = await readJson<TurboConfig>("turbo.json");
    const rootPackage = await readJson<PackageManifest>("package.json");
    const command = rootPackage.scripts?.typecheck ?? "";

    expect(rootPackage.scripts?.["typecheck:root"]).toBe("bunx tsc --noEmit");
    expect(command).toStartWith("turbo run typecheck typecheck:root");
    for (const filter of [
      "//",
      "@atlcli/extension",
      "@atlcli/pdf-compiler-browser",
      "@atlcli/browser-export-harness",
    ]) {
      expect(command).toContain(`--filter=${filter}`);
    }
    expect(command).toContain("--summarize");
    expect(root.tasks["//#typecheck:root"]?.cache).toBe(true);
    expect(root.tasks["//#typecheck:root"]?.outputs).toEqual([]);
  });

  it("exposes summarized Turbo wrappers for browser CI builds", async () => {
    const rootPackage = await readJson<PackageManifest>("package.json");
    expect(rootPackage.scripts?.["build:browser-export-harness"]).toBe(
      "turbo run build --filter=@atlcli/browser-export-harness --summarize",
    );
    expect(rootPackage.scripts?.["build:extension"]).toBe(
      "turbo run build --filter=@atlcli/extension --summarize",
    );
  });

  it("keeps stateful browser verification uncached", async () => {
    const harness = await readJson<TurboConfig>(
      "apps/browser-export-harness/turbo.json",
    );
    expect(harness.tasks["check:output"]?.cache).toBe(false);
    expect(harness.tasks["test:e2e"]?.cache).toBe(false);
  });
});
