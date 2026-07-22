import { describe, test, expect, afterAll } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BROWSER_ENTRYPOINTS,
  checkEntrypoint,
  type EntryCheckResult,
} from "./check-browser-build.js";

/**
 * Note on scope: the *positive* proof — that the §6 entrypoints build for the
 * browser with nothing Node-only in their graph — is delivered by the
 * executable gate itself (`bun run check:browser`), which runs in CI. It is
 * intentionally not re-run here.
 *
 * This file provides the *negative* proof (spec 001 task 6 AC) plus the
 * false-positive guards, and — since spec 010 — the acceptance test for the
 * legacy-bare-specifier hole (see "the real Bun-native barrel" below).
 */

const tmpDirs: string[] = [];
afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

function fixtureDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "atlcli-browser-gate-"));
  tmpDirs.push(dir);
  return dir;
}

describe("browser-build gate (spec 001 task 6)", () => {
  test("the gate's entrypoint set includes every browser entrypoint", () => {
    expect(BROWSER_ENTRYPOINTS).toEqual([
      "packages/confluence/src/markdown.ts",
      "packages/confluence/src/client.ts",
      "packages/jira/src/client.ts",
      "packages/core/src/index.browser.ts",
      "packages/confluence/src/index.browser.ts",
      "packages/jira/src/index.browser.ts",
      "packages/docx/src/index.browser.ts",
      "packages/docx/src/internal.ts",
      "packages/docx/src/browser-runtime.ts",
      "packages/diagram/src/index.ts",
      "packages/pdf/src/index.browser.ts",
      "packages/pdf/src/internal.ts",
      "packages/pdf-compiler-browser/src/index.ts",
      "packages/template-pack/src/index.browser.ts",
      "packages/export-macros/src/index.ts",
      "packages/export-macros/src/internal.ts",
      "packages/export-wiring/src/index.ts",
      "packages/export-wiring/src/fixtures.ts",
    ]);
  });

  test("a browser-safe entrypoint passes (build ok, nothing flagged)", async () => {
    const dir = fixtureDir();
    const file = join(dir, "clean.ts");
    writeFileSync(file, `export const answer = 40 + 2;\n`);

    const result = await checkEntrypoint(file);
    expect(result.buildFailed).toBe(false);
    expect(result.specifiers).toEqual([]);
    expect(result.builtinImports).toEqual([]);
    expect(result.bunGlobals).toEqual([]);
    expect(result.ok).toBe(true);
  });

  // Negative proof (spec 001 task 6 AC).
  //
  // Deviation from the AC's `import "node:fs"` wording: under Bun 1.3.x,
  // `node:fs` is silently *polyfilled* for the browser target (it builds clean),
  // so seeding it would NOT turn the gate red. The module that actually broke the
  // clients in the §1 baseline is `node:os` (via `config.ts` → the barrel), which
  // Bun cannot polyfill — the build fails and the specifier is named.
  test("a seeded node: import turns the gate red, naming the entrypoint and specifier", async () => {
    const dir = fixtureDir();
    const file = join(dir, "leaky-client.ts");
    // Mimics a client that has picked up a stray Node-only import.
    writeFileSync(
      file,
      `import os from "node:os";\nexport const platform = os.platform();\n`
    );

    const result = await checkEntrypoint(file);

    expect(result.ok).toBe(false);
    expect(result.buildFailed).toBe(true);
    expect(result.specifiers).toContain("node:os");
    expect(result.entrypoint).toBe(file); // named in the failure output
  });

  test("the specifier scan ignores Bun's inlined polyfill diagnostic strings (no false positive)", async () => {
    // A string literal that merely *contains* the text `node:buffer` must not be
    // mistaken for a real import — this is the exact shape of Bun's browser
    // polyfill stub messages that markdown.ts legitimately carries.
    const dir = fixtureDir();
    const file = join(dir, "stringy.ts");
    writeFileSync(file, `export const note = "not implemented for node:buffer browser build";\n`);

    const result = await checkEntrypoint(file);
    expect(result.ok).toBe(true);
    expect(result.specifiers).toEqual([]);
  });
});

/**
 * The hole this closes (spec 010).
 *
 * The gate used to scan bundled OUTPUT for `node:`/`bun:`-prefixed specifiers
 * only. The legacy bare spelling (`import { homedir } from "os"`) leaves no such
 * marker and Bun silently polyfills it, so a Node-only module could pass. The
 * source-graph rule sees the specifier the bundler actually resolved, in either
 * spelling.
 */
describe("bare Node builtin specifiers (spec 010)", () => {
  test("a bare `os` import is caught, and names the importing file", async () => {
    const dir = fixtureDir();
    const file = join(dir, "legacy-bare.ts");
    writeFileSync(
      file,
      `import { homedir } from "os";\nexport const home = homedir();\n`
    );

    const result = await checkEntrypoint(file);

    expect(result.ok).toBe(false);
    // The point of the whole exercise: the OLD rule sees nothing here.
    expect(result.specifiers).toEqual([]);
    expect(result.builtinImports.map((h) => h.specifier)).toContain("os");
    expect(result.builtinImports.every((h) => h.importer.endsWith("legacy-bare.ts"))).toBe(true);
  });

  test("bare `fs`, `path`, `crypto` and a builtin subpath are all caught", async () => {
    const dir = fixtureDir();
    const file = join(dir, "many.ts");
    writeFileSync(
      file,
      `import { existsSync } from "fs";\n` +
        `import { readFile } from "fs/promises";\n` +
        `import { join } from "path";\n` +
        `import { createHash } from "crypto";\n` +
        `export const use = [existsSync, readFile, join, createHash];\n`
    );

    const result = await checkEntrypoint(file);

    expect(result.ok).toBe(false);
    expect(result.builtinImports.map((h) => h.specifier).sort()).toEqual([
      "crypto",
      "fs",
      "fs/promises",
      "path",
    ]);
  });

  test("a bare `bun` VALUE import is caught, and attributed", async () => {
    const dir = fixtureDir();
    const file = join(dir, "bun-value.ts");
    writeFileSync(file, `import { Glob } from "bun";\nexport const g = new Glob("*.ts");\n`);

    const result = await checkEntrypoint(file);
    expect(result.ok).toBe(false);
    // Bun also refuses to bundle `bun` for the browser, so `ok` would be false
    // regardless — assert the source-graph attribution too, or this test would
    // still pass with rule 1 removed.
    expect(result.builtinImports.map((h) => h.specifier)).toEqual(["bun"]);
    // `endsWith`, not equality: macOS resolves the tmpdir through /private/var.
    expect(result.builtinImports[0]?.importer.endsWith("bun-value.ts")).toBe(true);
  });

  /**
   * Rule 3. A type-only import erases entirely — there is no specifier left for
   * any import scan, ours included — but the CALL survives and throws in a
   * browser. This is exactly the shape of `packages/jira/src/webhook-server.ts`.
   */
  test("an erased `import type ... from \"bun\"` is caught by its surviving Bun.* call", async () => {
    const dir = fixtureDir();
    const file = join(dir, "bun-typeonly.ts");
    writeFileSync(
      file,
      `import type { Server } from "bun";\n` +
        `export function listen(): Server {\n` +
        `  return Bun.serve({ port: 0, fetch: () => new Response("hi") }) as unknown as Server;\n` +
        `}\n`
    );

    const result = await checkEntrypoint(file);

    expect(result.buildFailed).toBe(false);
    // Nothing for an import-based rule to find: the type import is gone.
    expect(result.specifiers).toEqual([]);
    expect(result.builtinImports).toEqual([]);
    expect(result.bunGlobals).toContain("Bun.serve");
    expect(result.ok).toBe(false);
  });
});

/**
 * False positives are the failure mode that matters: this gate runs in CI, and a
 * wrong red blocks everyone. Each case below is a shape that a naive
 * "does the source mention `path`?" rule would flag.
 */
describe("false-positive guards", () => {
  test("a LOCAL module named like a builtin is not flagged", async () => {
    const dir = fixtureDir();
    writeFileSync(join(dir, "path.ts"), `export const join = (a: string) => a;\n`);
    writeFileSync(join(dir, "os.ts"), `export const homedir = () => "/home";\n`);
    const file = join(dir, "local.ts");
    writeFileSync(
      file,
      `import { join } from "./path.js";\n` +
        `import { homedir } from "./os.js";\n` +
        `export const v = join(homedir());\n`
    );

    const result = await checkEntrypoint(file);
    expect(result.builtinImports).toEqual([]);
    expect(result.ok).toBe(true);
  });

  test("a real npm PACKAGE named like a builtin is not flagged", async () => {
    const dir = fixtureDir();
    const pkg = join(dir, "node_modules", "os");
    mkdirSync(pkg, { recursive: true });
    writeFileSync(
      join(pkg, "package.json"),
      JSON.stringify({ name: "os", version: "1.0.0", main: "index.js" })
    );
    writeFileSync(join(pkg, "index.js"), `export const homedir = () => "/browser";\n`);
    const file = join(dir, "uses-package.ts");
    writeFileSync(file, `import { homedir } from "os";\nexport const home = homedir();\n`);

    const result = await checkEntrypoint(file);
    expect(result.builtinImports).toEqual([]);
  });

  test("a bare package whose name merely STARTS with a builtin name is not flagged", async () => {
    const dir = fixtureDir();
    for (const name of ["pathe", "osmosis", "fsx"]) {
      const pkg = join(dir, "node_modules", name);
      mkdirSync(pkg, { recursive: true });
      writeFileSync(
        join(pkg, "package.json"),
        JSON.stringify({ name, version: "1.0.0", main: "index.js" })
      );
      writeFileSync(join(pkg, "index.js"), `export const v = ${JSON.stringify(name)};\n`);
    }
    const file = join(dir, "prefixy.ts");
    writeFileSync(
      file,
      `import { v as a } from "pathe";\n` +
        `import { v as b } from "osmosis";\n` +
        `import { v as c } from "fsx";\n` +
        `export const all = [a, b, c];\n`
    );

    const result = await checkEntrypoint(file);
    expect(result.builtinImports).toEqual([]);
    expect(result.ok).toBe(true);
  });

  test("an identifier or property merely ending in `Bun` is not a Bun global", async () => {
    const dir = fixtureDir();
    const file = join(dir, "notbun.ts");
    writeFileSync(
      file,
      `const isBun = { serve: () => 1 };\n` +
        `const wrapper = { Bun: { serve: () => 2 } };\n` +
        `export const v = isBun.serve() + wrapper.Bun.serve();\n`
    );

    const result = await checkEntrypoint(file);
    expect(result.bunGlobals).toEqual([]);
    expect(result.ok).toBe(true);
  });
});

/**
 * Acceptance test for the hole (spec 010), against the REAL module — no fixture.
 *
 * `packages/jira/src/index.ts` is the Node/Bun barrel of `@atlcli/jira`: it
 * re-exports a Bun-native webhook server (`Bun.serve`, `import type { Server }
 * from "bun"`) and file-backed template storage that imports `os`/`path`/`fs`
 * in the LEGACY BARE form. Measured on Bun 1.3.8 before this change, feeding it
 * to the gate produced a 0.98 MB bundle with ZERO quoted specifier matches —
 * reported CLEAN. That is the exact failure this asserts against, using the real
 * check function on the real file so the hole cannot silently reopen.
 *
 * ## Why this one runs in a child process
 *
 * Not for convenience, and not to weaken the test: `Bun.build` over the
 * WORKSPACE source graph corrupts module resolution for test files loaded after
 * it in the same process. Measured on Bun 1.3.8 — adding this single in-process
 * call took `bun run test` from 4162 passing / 0 failing to 4011 passing with 9
 * files erroring out before their first test, including
 * `apps/cli/src/e2e/registry-probe.test.ts`, whose entire job is to notice that
 * the module registry has been damaged. (The tmpdir fixtures elsewhere in this
 * file have no workspace deps and are unaffected; this is the same class of
 * problem `apps/cli/src/e2e/registry-isolation.test.ts` solves the same way.)
 *
 * Spawning the gate SCRIPT rather than importing the function keeps the test
 * end-to-end — the executable path CI runs, the real entrypoint, the real
 * verdict — and lets every assertion below be unconditional.
 */
describe("the real Bun-native barrel must fail the gate (spec 010 acceptance)", () => {
  const JIRA_NODE_BARREL = "packages/jira/src/index.ts";
  const REPO_ROOT = join(import.meta.dir, "..");

  test("it is deliberately NOT in the checked set", () => {
    expect(BROWSER_ENTRYPOINTS).not.toContain(JIRA_NODE_BARREL);
  });

  test(
    "the gate rejects it",
    () => {
      const run = spawnSync(
        "bun",
        // `--conditions=development` mirrors how CI invokes the gate (spec 009):
        // without it `@atlcli/*` resolves to dist/ and the graph would differ.
        [
          "--conditions=development",
          "scripts/check-browser-build.ts",
          "--json",
          JIRA_NODE_BARREL,
        ],
        { cwd: REPO_ROOT, encoding: "utf8", timeout: 120_000 }
      );

      // Non-zero exit is the gate's actual verdict, not a derived one.
      expect(run.status).toBe(1);

      const [result] = JSON.parse(run.stdout) as EntryCheckResult[];
      expect(result!.entrypoint).toBe(JIRA_NODE_BARREL);
      expect(result!.ok).toBe(false);
      // It BUILDS — that is precisely why the old output-text rule could not see it…
      expect(result!.buildFailed).toBe(false);
      // …and this is the old rule's complete view of that bundle: nothing.
      expect(result!.specifiers).toEqual([]);

      const specifiers = result!.builtinImports.map((h) => h.specifier);
      // Legacy bare form (packages/jira/src/templates.ts) — the blind spot.
      expect(specifiers).toContain("os");
      expect(specifiers).toContain("fs");
      expect(specifiers).toContain("path");
      expect(specifiers).toContain("fs/promises");
      // …and the prefixed form, which the old rule would only have found in the
      // OUTPUT — where it was not, because Bun polyfilled these away.
      expect(specifiers).toContain("node:crypto");
      expect(specifiers).toContain("node:os");

      // Every violation is attributed to a real source file, not to the barrel.
      const bareOs = result!.builtinImports.find((h) => h.specifier === "os");
      expect(bareOs?.importer).toBe("packages/jira/src/templates.ts");
      const nodeCrypto = result!.builtinImports.find((h) => h.specifier === "node:crypto");
      expect(nodeCrypto?.importer).toBe("packages/jira/src/webhook-server.ts");

      // The erased `import type { Server } from "bun"` leaves a live Bun.serve call.
      expect(result!.bunGlobals).toContain("Bun.serve");
    },
    120_000
  );
});

/**
 * The same shape as the jira barrel, in a fixture with no workspace deps — so
 * it builds in every environment and can pin, unconditionally, the property
 * that made the hole invisible: a **successful, clean-looking** browser build
 * whose output the old specifier rule reports as empty.
 *
 * This exists IN ADDITION to the real-module test above, never instead of it.
 */
describe("a module shaped like the jira barrel (fixture)", () => {
  test("builds successfully, passes the old rule, and is still rejected", async () => {
    const dir = fixtureDir();
    writeFileSync(
      join(dir, "templates.ts"),
      `import { homedir } from "os";\n` +
        `import { join } from "path";\n` +
        `import { existsSync } from "fs";\n` +
        `export const dir = existsSync(join(homedir(), ".atlcli"));\n`
    );
    writeFileSync(
      join(dir, "webhook-server.ts"),
      `import type { Server } from "bun";\n` +
        `export function start(): Server {\n` +
        `  return Bun.serve({ port: 0, fetch: () => new Response("ok") }) as unknown as Server;\n` +
        `}\n`
    );
    const file = join(dir, "barrel.ts");
    writeFileSync(file, `export * from "./templates.js";\nexport * from "./webhook-server.js";\n`);

    const result = await checkEntrypoint(file);

    // The bundler is happy — Bun polyfilled `os`/`path`/`fs` away.
    expect(result.buildFailed).toBe(false);
    // …and the OLD rule finds nothing in that bundle. This is the hole.
    expect(result.specifiers).toEqual([]);
    // The new rules do find it.
    expect(result.builtinImports.map((h) => h.specifier).sort()).toEqual(["fs", "os", "path"]);
    expect(result.bunGlobals).toContain("Bun.serve");
    expect(result.ok).toBe(false);
  });
});
