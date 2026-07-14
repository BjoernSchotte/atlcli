import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { scanText } from "../scripts/check-output-build.js";
import { EXTENSION_ROOT, ensureExtensionBuilt, OUTPUT_DIR } from "./build-helper.js";

const CLI_PATH = join(EXTENSION_ROOT, "scripts", "check-output-build.ts");

/** Run the REAL check CLI against `root`; return exit code + merged output. */
function runCheckCli(root: string): { code: number; output: string } {
  const res = spawnSync("bun", [CLI_PATH, root], {
    cwd: EXTENSION_ROOT,
    encoding: "utf8",
  });
  return { code: res.status ?? -1, output: `${res.stdout ?? ""}${res.stderr ?? ""}` };
}

/**
 * Extension output isomorphism gate (spec 002 Task 6).
 *
 * Positive: the real built bundle is clean.
 * Negative: a seeded `node:os` import (and a remote script origin) are caught
 * and named — same spirit as the spec-001 seeded-`node:os` fixture.
 */
describe("scanText classification", () => {
  it("flags node:/bun: specifiers", () => {
    expect(scanText(`import x from "node:os";`)).toContain("node:os");
    expect(scanText(`require('bun:sqlite')`)).toContain("bun:sqlite");
  });

  it("flags remote script origins", () => {
    const hits = scanText(`import a from "https://evil.example/x.js";`);
    expect(hits.some((h) => h.includes("https://evil.example"))).toBe(true);
    const scriptHits = scanText(`<script src="http://cdn.example/lib.js"></script>`);
    expect(scriptHits.some((h) => h.includes("http://cdn.example"))).toBe(true);
  });

  // Regression (finding 1): each executable remote-code form must be caught.
  it.each([
    ["static import w/ default binding", `import x from "https://cdn.example/a.js";`],
    ["static import w/ named bindings", `import { a, b } from "https://cdn.example/a.js";`],
    ["static import namespace", `import * as ns from "https://cdn.example/a.js";`],
    ["side-effect import (no bindings)", `import "https://cdn.example/a.js";`],
    ["minified side-effect import", `import"https://cdn.example/a.js"`],
    ["minified named import", `import{a}from"https://cdn.example/a.js"`],
    ["dynamic import()", `const m = await import("https://cdn.example/a.js");`],
    ["importScripts()", `importScripts("https://cdn.example/a.js")`],
    ["HTML <script src> double-quoted", `<script src="https://cdn.example/a.js"></script>`],
    ["HTML <script src> single-quoted", `<script src='https://cdn.example/a.js'></script>`],
    ["HTML <script src> unquoted", `<script src=https://cdn.example/a.js></script>`],
  ])("catches %s", (_label, text) => {
    const hits = scanText(text);
    expect(hits.some((h) => h.includes("https://cdn.example"))).toBe(true);
  });

  it("does not flag ordinary local imports or http string data", () => {
    expect(scanText(`import a from "./local.js";`)).toEqual([]);
    // A bare URL string (not an import/script) is not a remote SCRIPT origin.
    expect(scanText(`const url = "https://api.atlassian.net/rest";`)).toEqual([]);
  });
});

/**
 * End-to-end gate proof (spec 002 Task 6): the REAL `wxt build` output is
 * scanned by the REAL check CLI as a spawned process, so the observed signal is
 * the actual gate — process exit code + named offender — not an in-process
 * scanner call over synthetic files.
 *
 * Positive: the real clean bundle → exit 0.
 * Negative: a real build, copied to a temp outDir with a `node:os` leak seeded
 * in, → nonzero exit naming the offending file AND specifier. (Vite strips
 * `node:` specifiers from real entrypoints, so the leak is injected into a copy
 * of the built output — an alternate outDir — while the build+CLI both run for
 * real. Temp dir is always cleaned up.)
 */
describe("check-output-build CLI (end-to-end)", () => {
  let leakDir: string;

  beforeAll(() => {
    ensureExtensionBuilt();
    leakDir = mkdtempSync(join(tmpdir(), "atlcli-outscan-"));
  });

  afterAll(() => rmSync(leakDir, { recursive: true, force: true }));

  it("exits 0 on the real clean .output/chrome-mv3", () => {
    const { code, output } = runCheckCli(OUTPUT_DIR);
    expect(code).toBe(0);
    expect(output).toContain("clean");
  });

  it("exits nonzero and names the offending file + specifier on a seeded leak", () => {
    // Copy the real build into an alternate outDir, then seed a leak file.
    cpSync(OUTPUT_DIR, leakDir, { recursive: true });
    writeFileSync(
      join(leakDir, "leaky.js"),
      `import { platform } from "node:os";\nexport const p = platform();\n`
    );

    const { code, output } = runCheckCli(leakDir);
    expect(code).not.toBe(0);
    expect(output).toContain("leaky.js");
    expect(output).toContain("node:os");
  });
});
