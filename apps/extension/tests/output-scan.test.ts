import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  scanText,
  validatePdfArtifactInventory,
} from "../scripts/check-output-build.js";
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

  // Regression (finding #6 hardening): bare node GLOBALS are invisible to the
  // import-specifier scan (nothing is imported), yet they are undefined in the
  // extension runtime and throw at use — exactly how the unknown-macro `Buffer`
  // crash slipped past. The gate must now catch them.
  it.each([
    ["Buffer.from usage", `const b = Buffer.from(xml, "utf-8");`, "Buffer."],
    ["Buffer.alloc usage", `Buffer.alloc(10)`, "Buffer."],
    ["process.env read", `const x = process.env.NODE_ENV;`, "process.env"],
    ["__dirname global", `const p = join(__dirname, "x");`, "__dirname"],
    ["__filename global", `console.log(__filename);`, "__filename"],
  ])("flags %s", (_label, text, expected) => {
    expect(scanText(text)).toContain(expected);
  });

  it("does not flag look-alike identifiers that are not node globals", () => {
    // A property literally named `Buffer` or a `processEnv` variable must not trip.
    expect(scanText(`const myBuffer = new Uint8Array(4);`)).toEqual([]);
    expect(scanText(`const processEnvironment = cfg.processEnvironment;`)).toEqual([]);
  });

  it.each([
    ["globalThis property", `globalThis.Buffer = fake;`],
    ["window bracket property", `window["Buffer"] = fake;`],
    ["defineProperty", `Object.defineProperty(self, "Buffer", { value: fake });`],
  ])("flags a fake global Buffer via %s", (_label, source) => {
    expect(scanText(source).some((finding) => finding.includes("Buffer"))).toBe(true);
  });

  it("allows the DOCX-specific byte-helper namespace", () => {
    expect(scanText(`globalThis.__atlDocxByteHelpers = helpers;`)).toEqual([]);
  });

  it.each([
    ["Function constructor", `const make = Function("return 1");`, "Function("],
    ["new Function constructor", `const make = new Function("return 1");`, "Function("],
    ["direct eval", `const value = eval("1 + 1");`, "eval("],
  ])("flags MV3-incompatible %s", (_label, source, expected) => {
    expect(scanText(source).some((finding) => finding.includes(expected))).toBe(true);
  });

  it("does not confuse method names with direct eval", () => {
    expect(scanText(`const value = parser.eval(source);`)).toEqual([]);
  });
});

describe("PDF artifact inventory", () => {
  const complete = [
    { path: "assets/pdf-compiler-abc.js", size: 30_000 },
    { path: "assets/typst_ts_web_compiler_bg-abc.wasm", size: 28_000_000, sha256: "1fc968438a672366dfec39c96c842c26ed29caff4eb1bcaab19a6c60867de5fd" },
    { path: "assets/SourceSans3-Regular-abc.ttf", size: 100_000, sha256: "4644c81b86ec9caaa76b634889968ed3c4f4f52f054855933acc7c2b21e53b0f" },
    { path: "assets/SourceSans3-It-abc.ttf", size: 100_000, sha256: "192afd78f0f54a3c69eaf02d43f4d9a821e9d6110e41d3d25d61a7385cd580e4" },
    { path: "assets/SourceSans3-Semibold-abc.ttf", size: 100_000, sha256: "a3f4f8dcf343a8f24dc61951de93f3ba1558b15cd250ba24af8a40e957081b7d" },
    { path: "assets/SourceSans3-Bold-abc.ttf", size: 100_000, sha256: "9214b9d95e4231c609802815c2646c98174e2102d0d37f88978a7f8e71006e6a" },
    { path: "assets/SourceSerif4-Regular-abc.ttf", size: 100_000, sha256: "e5a4ee6a3d87bb9024796be390c6771e2a0eb1883dae25effaf57ca01668e24b" },
    { path: "assets/SourceSerif4-It-abc.ttf", size: 100_000, sha256: "9d2950a8f1da66e21502c35d646a1d2148e79f9ea43fd2158cf02f5232e7f430" },
    { path: "assets/SourceSerif4-Semibold-abc.ttf", size: 100_000, sha256: "36db62940cb5728b12b1802476dc7fcf4c6c519a7bdd476ba23a4e555fc4655f" },
    { path: "assets/SourceSerif4-Bold-abc.ttf", size: 100_000, sha256: "7cf4f4e1ad74f45058d5bc61716b82560442fbdcd9d3654d2dea96bf6c683d86" },
    { path: "assets/SourceCodePro-Regular-abc.ttf", size: 100_000, sha256: "74bd80d3e42a08517cd7e1108ba3d86f2da29ac0f3065be95e0357956ab9db37" },
    { path: "assets/SourceCodePro-Bold-abc.ttf", size: 100_000, sha256: "b2095e0d657e6d28dc32444a9dacabab0c9241d0bf39d96371756cc9bdbc3a5f" },
    { path: "assets/LICENSE-Source-Sans-3-abc.txt", size: 4_000 },
    { path: "assets/LICENSE-Source-Serif-4-abc.txt", size: 4_000 },
    { path: "assets/LICENSE-Source-Code-Pro-abc.txt", size: 4_000 },
    { path: "assets/LICENSE-abc.", size: 11_000 },
  ];

  it("accepts a complete local PDF runtime", () => {
    expect(validatePdfArtifactInventory(complete)).toEqual([]);
  });

  it("names missing and truncated compiler artifacts", () => {
    const missingWorker = complete.filter((artifact) => !artifact.path.includes("pdf-compiler"));
    expect(validatePdfArtifactInventory(missingWorker).join("\n")).toContain(
      "PDF compiler worker"
    );

    const truncated = complete.map((artifact) =>
      artifact.path.endsWith(".wasm") ? { ...artifact, size: 1024 } : artifact
    );
    expect(validatePdfArtifactInventory(truncated).join("\n")).toContain(
      "unexpectedly small"
    );

    const tampered = complete.map((artifact) =>
      artifact.path.includes("SourceSans3-Regular") ? { ...artifact, sha256: "tampered" } : artifact
    );
    expect(validatePdfArtifactInventory(tampered).join("\n")).toContain("SHA-256");
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
