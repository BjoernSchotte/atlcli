import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  PDFJS_ARTIFACT_PATTERNS,
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

  // Spec 010: the same blind spot the repo-wide browser gate had. A type-only
  // `import type { Server } from "bun"` erases, so NODE_BUN_RE sees no
  // specifier — but the call survives and `Bun` is undefined in an extension
  // page.
  it.each([
    ["Bun.serve", `const s = Bun.serve({ port: 0 });`],
    ["Bun.file", `const f = Bun.file("x.txt");`],
    ["minified spacing", `Bun.$\`ls\``],
  ])("flags the Bun global via %s", (_label, source) => {
    expect(scanText(source).some((finding) => finding.startsWith("Bun."))).toBe(true);
  });

  it("does not flag look-alike identifiers that are not node globals", () => {
    // A property literally named `Buffer` or a `processEnv` variable must not trip.
    expect(scanText(`const myBuffer = new Uint8Array(4);`)).toEqual([]);
    expect(scanText(`const processEnvironment = cfg.processEnvironment;`)).toEqual([]);
    // …nor an identifier ending in `Bun`, nor `Bun` as someone else's property.
    expect(scanText(`const isBun = { serve() {} }; isBun.serve();`)).toEqual([]);
    expect(scanText(`const v = runtimes.Bun.serve;`)).toEqual([]);
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
    { path: "assets/pdf.min-abc.mjs", size: 452_000, sha256: "4ba2f15599b03fde8755ad91349920c21dadd3e8fd6b6460a7663d46d4cf21b5" },
    { path: "assets/pdf.worker.min-abc.mjs", size: 1_260_000, sha256: "2ab9e09667296dab1a618868b3ce6e6c23d5b8f48120ae7c5b34e7e335ed01fa" },
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

  /**
   * "Bundled locally, never a CDN" as a build assertion (spec 010 T5.3).
   *
   * The pin is only meaningful because both files are emitted **verbatim**
   * (Vite `?url&no-inline`) rather than merged into a chunk — a bundled chunk's
   * hash would change on every unrelated edit.
   */
  it.each([
    ["PDF.js viewer runtime", "pdf.min-abc.mjs"],
    ["PDF.js worker", "pdf.worker.min-abc.mjs"],
  ])("requires %s to be present and unmodified", (label, file) => {
    const missing = complete.filter((artifact) => !artifact.path.endsWith(file));
    expect(validatePdfArtifactInventory(missing).join("\n")).toContain(label);

    const tampered = complete.map((artifact) =>
      artifact.path.endsWith(file) ? { ...artifact, sha256: "tampered" } : artifact
    );
    expect(validatePdfArtifactInventory(tampered).join("\n")).toContain("SHA-256");
  });
});

/**
 * **The scope guarantee** (spec 010 T5.3, Architecture point 8).
 *
 * The plan expected the vendored PDF.js to force a path-scoped exemption from
 * `DYNAMIC_CODE_RES`. Measured against `pdfjs-dist@6.1.200` it does not — v6
 * replaced the `Function`-based PostScript evaluator with a WebAssembly one —
 * so **no exemption was added and the gate was not loosened**.
 *
 * These tests are what keeps that honest in both directions: the PDF.js path
 * enjoys no special treatment (a token seeded there fails like anywhere else),
 * and `.mjs` is scanned at all, so vendoring a dependency under a new extension
 * cannot become a way *around* the gate.
 */
describe("dynamic-code rule has no PDF.js exemption", () => {
  it("flags a string-to-code constructor at the vendored PDF.js path like anywhere else", () => {
    const seeded = `/* vendored */ const make = new Function("return 1");`;
    expect(scanText(seeded).some((finding) => finding.includes("Function("))).toBe(true);
  });

  it("the emitted PDF.js paths are recognizable, and match nothing else in the bundle", () => {
    const pdfjsPaths = ["assets/pdf.min-BZTU-uUE.mjs", "assets/pdf.worker.min-DEtVeC4l.mjs"];
    const others = [
      "chunks/viewer-Cgffbktj.js",
      "chunks/run-export-DiaDTXR5.js",
      "assets/pdf-compiler-DTGjm2tL.js",
      "background.js",
      "sidepanel.html",
      "assets/pdf.min-BZTU-uUE.mjs.map",
      "vendor/pdf.min-abc.mjs",
    ];
    for (const path of pdfjsPaths) {
      expect(PDFJS_ARTIFACT_PATTERNS.some((pattern) => pattern.test(path))).toBe(true);
    }
    for (const path of others) {
      expect(PDFJS_ARTIFACT_PATTERNS.some((pattern) => pattern.test(path))).toBe(false);
    }
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

  /**
   * The PDF.js path is **not** exempt (spec 010 T5.3).
   *
   * Seeding a string-to-code constructor into the real emitted PDF.js file must
   * fail the real gate. If someone later adds a path-scoped exemption for this
   * dependency, this test goes red and the exemption has to be argued for
   * rather than inherited.
   */
  it("fails when dynamic code is seeded into the vendored PDF.js file itself", () => {
    const seedDir = mkdtempSync(join(tmpdir(), "atlcli-outscan-pdfjs-"));
    try {
      cpSync(OUTPUT_DIR, seedDir, { recursive: true });
      const assets = join(seedDir, "assets");
      const target = readdirSync(assets).find(
        (name) => name.startsWith("pdf.min-") && name.endsWith(".mjs")
      );
      expect(target).toBeDefined();
      const path = join(assets, target!);
      writeFileSync(path, `${readFileSync(path, "utf8")}\nconst x = new Function("return 1");\n`);

      const { code, output } = runCheckCli(seedDir);
      expect(code).not.toBe(0);
      expect(output).toContain(target!);
      expect(output).toContain("Function(");
    } finally {
      rmSync(seedDir, { recursive: true, force: true });
    }
  });

  it("scans .mjs assets at all — a new extension is not a way around the gate", () => {
    const seedDir = mkdtempSync(join(tmpdir(), "atlcli-outscan-mjs-"));
    try {
      cpSync(OUTPUT_DIR, seedDir, { recursive: true });
      writeFileSync(join(seedDir, "sneaky.mjs"), `const value = eval("1 + 1");\n`);
      const { code, output } = runCheckCli(seedDir);
      expect(code).not.toBe(0);
      expect(output).toContain("sneaky.mjs");
    } finally {
      rmSync(seedDir, { recursive: true, force: true });
    }
  });
});
