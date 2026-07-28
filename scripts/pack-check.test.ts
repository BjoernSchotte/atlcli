import { describe, expect, it } from "bun:test";
import { Glob } from "bun";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PDF_RUNTIME_ASSETS } from "../packages/pdf/src/runtime-assets.js";
import { PATCH_MARKER } from "../packages/pdf-compiler-browser/scripts/vendor-typst.js";
import { runStripDevCondition } from "./strip-dev-condition.js";

/**
 * Pack-check (spec 009, Build artifacts / Special cases) — real `bun pm pack`
 * per publishable package, no mocks, no registry.
 *
 * The publishable set is derived from each package's fail-closed
 * `atlcli.publish` classification (never a hardcoded list). Each tarball is
 * unpacked-inspected via system tar and asserted against the packaging
 * contract: dist JS + declarations shipped, no src leak, no `workspace:`
 * ranges (bun rewrites them at pack time — verified empirically), no
 * workspace-only `development` export condition, every exports target
 * resolvable inside the tarball, the exact sha-pinned PDF font set present
 * even though `.fonts/` is gitignored (`files` wins over .gitignore —
 * verified, not trusted), and the vendored PATCHED typst glue + wasm inside
 * `@atlcli/pdf-compiler-browser`.
 */

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

interface PublishablePackage {
  name: string;
  dir: string;
  rel: string;
}

function publishablePackages(): PublishablePackage[] {
  const rootPkg = JSON.parse(
    readFileSync(join(repoRoot, "package.json"), "utf8"),
  ) as { workspaces?: string[] };
  const out: PublishablePackage[] = [];
  for (const pattern of rootPkg.workspaces ?? []) {
    for (const rel of new Glob(`${pattern}/package.json`).scanSync({ cwd: repoRoot })) {
      const manifest = JSON.parse(readFileSync(join(repoRoot, rel), "utf8")) as {
        name?: string;
        atlcli?: { publish?: string };
      };
      if (manifest.atlcli?.publish) {
        out.push({ name: manifest.name ?? rel, dir: join(repoRoot, dirname(rel)), rel });
      }
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

interface PackedPackage {
  pkg: PublishablePackage;
  tarball: string;
  entries: string[];
  manifest: Record<string, unknown>;
}

const packages = publishablePackages();
const packed = new Map<string, PackedPackage>();

function run(cmd: string[], cwd: string): { exitCode: number; stdout: string; stderr: string } {
  const proc = Bun.spawnSync(cmd, { cwd, stdio: ["ignore", "pipe", "pipe"] });
  return {
    exitCode: proc.exitCode,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
  };
}

function tarEntries(tarball: string): string[] {
  const res = run(["tar", "-tf", tarball], repoRoot);
  if (res.exitCode !== 0) throw new Error(`tar -tf ${tarball} failed: ${res.stderr}`);
  return res.stdout.split("\n").filter(Boolean);
}

function tarExtract(tarball: string, entry: string): string {
  const res = run(["tar", "-xOf", tarball, entry], repoRoot);
  if (res.exitCode !== 0) throw new Error(`tar -xOf ${tarball} ${entry} failed: ${res.stderr}`);
  return res.stdout;
}

/** All string targets inside an exports-shaped value. */
function exportTargets(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const entry of Object.values(value)) exportTargets(entry, out);
  }
  return out;
}

function packageOf(pkg: PublishablePackage): PackedPackage {
  const result = packed.get(pkg.name);
  if (!result) throw new Error(`${pkg.name} was not packed — did the pack test fail earlier?`);
  return result;
}

describe("pack-check (spec 009)", () => {
  it("derives at least the eight publishable packages from atlcli.publish", () => {
    expect(packages.length).toBeGreaterThanOrEqual(8);
  });

  it(
    "the publishable packages build (dist must exist before packing)",
    () => {
      const build = run(
        ["bunx", "turbo", "run", "build", "--filter=./packages/*", "--output-logs=errors-only"],
        repoRoot,
      );
      if (build.exitCode !== 0) {
        throw new Error(`turbo build failed:\n${build.stdout}\n${build.stderr}`);
      }

      // We pack with `--ignore-scripts` (see the pack test below) to make the
      // manifest snapshot deterministic, so the non-strip prepack side effects
      // — pinned PDF fonts (`@atlcli/pdf`) and the vendored typst glue/wasm
      // (`@atlcli/pdf-compiler-browser`) — must already be on disk. Both scripts
      // are idempotent verify-or-produce, so this is a no-op when present.
      for (const script of ["fonts:ensure", "vendor:typst"]) {
        const res = run(["bun", "run", script], repoRoot);
        if (res.exitCode !== 0) {
          throw new Error(`bun run ${script} failed:\n${res.stdout}\n${res.stderr}`);
        }
      }
    },
    180000,
  );

  it(
    "bun pm pack succeeds for every publishable package and leaves the working tree clean",
    () => {
      const scratch = join(tmpdir(), `atlcli-pack-check-${process.pid}`);
      rmSync(scratch, { recursive: true, force: true });

      // Snapshot of packages/ dirt BEFORE packing — packing must not change it
      // (an absolute "empty" assertion would false-positive on a developer's
      // in-progress uncommitted changes).
      const porcelain = (): string =>
        run(["git", "status", "--porcelain", "--", "packages/"], repoRoot).stdout;
      const dirtBefore = porcelain();

      for (const pkg of packages) {
        const dest = join(scratch, pkg.name.replace(/[^a-z0-9-]/gi, "_"));
        mkdirSync(dest, { recursive: true });

        // We strip the development condition IN-PROCESS and pack with
        // `--ignore-scripts`, rather than letting the package's own
        // prepack/postpack do it. Reason: `bun pm pack` runs prepack/postpack as
        // spawned subprocesses, and their strip (prepack) / restore (postpack)
        // timing relative to bun's own manifest snapshot is not deterministic
        // across platforms — on Linux CI the snapshot could capture the manifest
        // before the spawned strip landed (or after an early restore), leaving
        // the `development` condition in the tarball (observed for
        // @atlcli/confluence, the first package packed). Doing the strip here —
        // a synchronous, atomic write in this single process — makes the
        // snapshot deterministic. The real prepack/postpack scripts (unit-tested
        // in strip-dev-condition.test.ts and used by the release/publish path)
        // are unchanged; the non-strip prepack artifacts (fonts, vendored glue)
        // are provisioned in the build step above.
        try {
          runStripDevCondition("strip", pkg.dir, () => {});
          const res = run(["bun", "pm", "pack", "--ignore-scripts", "--destination", dest], pkg.dir);
          expect(
            res.exitCode,
            `bun pm pack failed for ${pkg.name}:\n${res.stdout}\n${res.stderr}`,
          ).toBe(0);
        } finally {
          // Restore the workspace manifest. Idempotent: a no-backup no-op if a
          // failure between strip and here already restored it.
          runStripDevCondition("restore", pkg.dir, () => {});
        }

        const tarballs = readdirSync(dest).filter((f) => f.endsWith(".tgz"));
        expect(tarballs.length, `${pkg.name}: expected exactly one tarball in ${dest}`).toBe(1);
        const tarball = join(dest, tarballs[0]!);

        // The restore must have put the workspace manifest back (tree clean):
        // the on-disk manifest still carries the development DX condition and
        // no prepack backup file is left behind.
        const onDisk = readFileSync(join(pkg.dir, "package.json"), "utf8");
        expect(onDisk, `${pkg.rel}: development condition not restored after pack`).toContain(
          '"development"',
        );
        expect(
          existsSync(join(pkg.dir, ".package.json.prepack-backup")),
          `${pkg.rel}: prepack backup left behind`,
        ).toBe(false);

        packed.set(pkg.name, {
          pkg,
          tarball,
          entries: tarEntries(tarball),
          manifest: JSON.parse(tarExtract(tarball, "package/package.json")) as Record<
            string,
            unknown
          >,
        });
      }

      expect(
        porcelain(),
        "packing changed the working tree under packages/ — prepack/postpack left residue",
      ).toBe(dirtBefore);
    },
    240000,
  );

  it("every tarball ships dist JS + declarations and leaks no src/", () => {
    for (const pkg of packages) {
      const { entries } = packageOf(pkg);
      expect(
        entries.some((e) => e.startsWith("package/dist/") && e.endsWith(".js")),
        `${pkg.name}: no dist .js in tarball`,
      ).toBe(true);
      expect(
        entries.some((e) => e.startsWith("package/dist/") && e.endsWith(".d.ts")),
        `${pkg.name}: no dist .d.ts in tarball`,
      ).toBe(true);
      const srcLeaks = entries.filter((e) => e.startsWith("package/src/"));
      expect(srcLeaks, `${pkg.name}: src/ leaked into tarball`).toEqual([]);
    }
  });

  it("no packed manifest contains a workspace: range (bun rewrites them at pack time)", () => {
    for (const pkg of packages) {
      const { manifest } = packageOf(pkg);
      for (const field of [
        "dependencies",
        "devDependencies",
        "peerDependencies",
        "optionalDependencies",
      ]) {
        const deps = manifest[field] as Record<string, string> | undefined;
        if (!deps) continue;
        for (const [dep, range] of Object.entries(deps)) {
          expect(
            range.startsWith("workspace:"),
            `${pkg.name}: ${field}.${dep} still "${range}"`,
          ).toBe(false);
        }
      }
    }
  });

  it("no packed manifest contains a development export condition", () => {
    for (const pkg of packages) {
      const { manifest } = packageOf(pkg);
      const flat = JSON.stringify(manifest.exports ?? {});
      expect(flat, `${pkg.name}: development condition survived into the packed manifest`).not.toContain(
        '"development"',
      );
      expect(flat, `${pkg.name}: packed exports reference ./src/`).not.toContain("./src/");
    }
  });

  it("every packed exports target resolves to a file inside its tarball", () => {
    for (const pkg of packages) {
      const { manifest, entries } = packageOf(pkg);
      const entrySet = new Set(entries);
      const missing: string[] = [];

      for (const target of exportTargets(manifest.exports ?? {})) {
        if (target.includes("*")) {
          // Pattern target (./fonts/* -> ./.fonts/*): at least one real file
          // must exist under the prefix so the subpath pattern can resolve.
          const prefix = `package/${target.slice(2, target.indexOf("*"))}`;
          if (!entries.some((e) => e.startsWith(prefix) && e !== prefix)) {
            missing.push(`${target} (no entry under ${prefix})`);
          }
          continue;
        }
        if (!entrySet.has(`package/${target.slice(2)}`)) missing.push(target);
      }

      expect(
        missing,
        `${pkg.name}: exports targets missing from tarball:\n  ${missing.join("\n  ")}`,
      ).toEqual([]);
    }
  });

  it("@atlcli/code-highlight packs only fine-grained Shiki runtime loaders", () => {
    const { entries, manifest, tarball } = packageOf(
      packages.find((p) => p.name === "@atlcli/code-highlight") ??
        (undefined as never),
    );
    const runtime = entries
      .filter((entry) => entry.startsWith("package/dist/") && entry.endsWith(".js"))
      .map((entry) => tarExtract(tarball, entry))
      .join("\n");
    for (const forbidden of [
      'from "shiki"',
      '"shiki/langs"',
      '"shiki/themes"',
      "bundle_full_exports",
      "langs-bundle-full",
    ]) {
      expect(runtime).not.toContain(forbidden);
    }
    expect(runtime).toContain('import("@shikijs/langs/typescript")');
    expect(runtime).toContain('import("@shikijs/themes/github-light")');
    expect(manifest.dependencies).toMatchObject({
      shiki: "4.3.1",
      "@shikijs/langs": "4.3.1",
      "@shikijs/themes": "4.3.1",
    });
  });

  it("@atlcli/pdf ships exactly the PDF_RUNTIME_ASSETS font set plus the OFL licenses (files beats .gitignore)", () => {
    const { entries } = packageOf(
      packages.find((p) => p.name === "@atlcli/pdf") ?? (undefined as never),
    );
    const shippedFonts = entries
      .filter((e) => e.startsWith("package/.fonts/") && e.endsWith(".ttf"))
      .map((e) => e.slice("package/.fonts/".length))
      .sort();
    const expectedFonts = PDF_RUNTIME_ASSETS.fonts.map((f) => f.fileName).sort();
    // Exact equality: no drift in either direction between runtime-assets.ts
    // (the single source of truth) and the shipped tarball. This also proves
    // empirically that the files allowlist overrides .gitignore for .fonts/.
    expect(shippedFonts).toEqual(expectedFonts);

    for (const license of PDF_RUNTIME_ASSETS.licenses) {
      expect(
        entries.includes(`package/licenses/${license.fileName}`),
        `@atlcli/pdf: missing licenses/${license.fileName}`,
      ).toBe(true);
    }
  });

  it("@atlcli/docx ships the ordered browser entry, maps, font licenses, and Node loader", () => {
    const { entries, manifest } = packageOf(
      packages.find((p) => p.name === "@atlcli/docx") ?? (undefined as never),
    );
    for (const required of [
      "package/fonts/JetBrainsMono-Regular.ttf",
      "package/fonts/LICENSE-JetBrainsMono.txt",
      "package/dist/browser-entry.js",
      "package/dist/browser-entry.js.map",
      "package/dist/browser-entry.d.ts",
      "package/dist/browser-entry.d.ts.map",
      "package/dist/font-embedding.js",
      "package/dist/node-code-font.js",
    ]) {
      expect(entries.includes(required), `@atlcli/docx: missing ${required}`).toBe(true);
    }
    expect(manifest.license).toBe("Apache-2.0");
    expect(manifest.exports).toMatchObject({
      "./browser-entry": {
        types: "./dist/browser-entry.d.ts",
        default: "./dist/browser-entry.js",
      },
    });
  });

  it("@atlcli/pdf-compiler-browser ships the vendored PATCHED glue + wasm + LICENSE/NOTICE", () => {
    const { entries, tarball } = packageOf(
      packages.find((p) => p.name === "@atlcli/pdf-compiler-browser") ?? (undefined as never),
    );
    const glueEntry = "package/vendor/typst-ts-web-compiler/pkg/typst_ts_web_compiler.mjs";
    const wasmEntry = "package/vendor/typst-ts-web-compiler/pkg/typst_ts_web_compiler_bg.wasm";
    for (const required of [
      glueEntry,
      wasmEntry,
      "package/vendor/typst-ts-web-compiler/LICENSE",
      "package/vendor/typst-ts-web-compiler/NOTICE",
    ]) {
      expect(entries.includes(required), `missing ${required}`).toBe(true);
    }

    const glue = tarExtract(tarball, glueEntry);
    expect(glue.split(PATCH_MARKER).length - 1).toBeGreaterThanOrEqual(2);
    expect(glue).not.toContain("new Function(");
  }, 60000);
});
