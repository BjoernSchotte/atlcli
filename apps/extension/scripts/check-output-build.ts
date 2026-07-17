#!/usr/bin/env bun
/**
 * Extension output-bundle isomorphism gate (spec 002 Task 6).
 *
 * The shared packages (`@atlcli/core` browser entry, confluence client/markdown)
 * stay covered by the repo-wide `scripts/check-browser-build.ts` (spec 001).
 * This script is the belt-and-suspenders equivalent for the WXT/Vite ARTIFACT:
 * a post-build scan over the built `.output/chrome-mv3` js/html files asserting
 *   1. zero `node:`/`bun:` module specifiers,
 *   2. zero remote script origins (import / importScripts / <script src> from
 *      an http(s) URL) — the extension must load only bundled, local assets, and
 *   3. zero bare node GLOBALS (`Buffer.`, `process.env`, `__dirname`),
 *   4. zero string-to-code constructors (`Function(...)`, `eval(...)`) that
 *      violate Manifest V3's extension-page CSP, and
 *   5. a complete, locally bundled PDF runtime (worker, WASM and ten fonts).
 *
 * Bare node globals are
 *      invisible to an import-specifier scan — nothing is imported, the symbol is
 *      just assumed to exist — yet they are `undefined` in the extension runtime,
 *      so code touching them throws at use (spec 003, finding #6: unknown-macro
 *      conversion crashed on `Buffer` in the panel bundle). This gate closes that
 *      whole class of leak.
 *
 * On a leak it names the offending file(s) and finding(s) and exits non-zero.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { createHash } from "node:crypto";

/** Quoted `node:`/`bun:` module specifier — a real import/require target. */
const NODE_BUN_RE = /["'`](node|bun):[A-Za-z0-9_./-]*["'`]/g;

/**
 * Bare node GLOBALS that do not exist in the extension runtime. Matched as
 * member access / usage rather than as import specifiers (there is no import to
 * find). `Buffer\.` catches `Buffer.from(...)` etc.; `process\.env` catches env
 * reads; `__dirname` / `__filename` are CJS-only path globals. A hit here means
 * code will throw `ReferenceError`/`undefined` at runtime in the panel/worker.
 */
const NODE_GLOBAL_RE = /\bBuffer\.|\bprocess\.env\b|\b__dirname\b|\b__filename\b/g;

/** A browser bundle must not hide the same dependency behind a fake global Buffer. */
const FAKE_BUFFER_GLOBAL_RES: RegExp[] = [
  /\b(?:globalThis|self|window)\s*(?:\.\s*Buffer|\[\s*["']Buffer["']\s*\])\s*=/g,
  /\bObject\.defineProperty\(\s*(?:globalThis|self|window)\s*,\s*["']Buffer["']/g,
];

/** Dynamic code execution is forbidden by the extension page CSP. */
const DYNAMIC_CODE_RES: RegExp[] = [
  /\bnew\s+Function\s*\(/g,
  /(?:^|[=(:,!&|?;{}])\s*Function\s*\(\s*["'`]/g,
  /(?:^|[^\w.])eval\s*\(/g,
];

export interface OutputArtifact {
  path: string;
  size: number;
  sha256?: string;
}

const REQUIRED_PDF_ARTIFACTS = [
  { label: "PDF compiler worker", pattern: /(?:^|\/)assets\/pdf-compiler-[^/]+\.js$/ },
  {
    label: "Typst compiler WASM",
    pattern: /(?:^|\/)assets\/typst_ts_web_compiler_bg-[^/]+\.wasm$/,
    minimumSize: 20_000_000,
    sha256: "1fc968438a672366dfec39c96c842c26ed29caff4eb1bcaab19a6c60867de5fd",
  },
  {
    label: "Source Sans 3 Regular",
    pattern: /(?:^|\/)assets\/SourceSans3-Regular-[^/]+\.ttf$/,
    sha256: "4644c81b86ec9caaa76b634889968ed3c4f4f52f054855933acc7c2b21e53b0f",
  },
  {
    label: "Source Sans 3 Italic",
    pattern: /(?:^|\/)assets\/SourceSans3-It-[^/]+\.ttf$/,
    sha256: "192afd78f0f54a3c69eaf02d43f4d9a821e9d6110e41d3d25d61a7385cd580e4",
  },
  {
    label: "Source Sans 3 SemiBold",
    pattern: /(?:^|\/)assets\/SourceSans3-Semibold-[^/]+\.ttf$/,
    sha256: "a3f4f8dcf343a8f24dc61951de93f3ba1558b15cd250ba24af8a40e957081b7d",
  },
  {
    label: "Source Sans 3 Bold",
    pattern: /(?:^|\/)assets\/SourceSans3-Bold-[^/]+\.ttf$/,
    sha256: "9214b9d95e4231c609802815c2646c98174e2102d0d37f88978a7f8e71006e6a",
  },
  {
    label: "Source Serif 4 Regular",
    pattern: /(?:^|\/)assets\/SourceSerif4-Regular-[^/]+\.ttf$/,
    sha256: "e5a4ee6a3d87bb9024796be390c6771e2a0eb1883dae25effaf57ca01668e24b",
  },
  {
    label: "Source Serif 4 Italic",
    pattern: /(?:^|\/)assets\/SourceSerif4-It-[^/]+\.ttf$/,
    sha256: "9d2950a8f1da66e21502c35d646a1d2148e79f9ea43fd2158cf02f5232e7f430",
  },
  {
    label: "Source Serif 4 SemiBold",
    pattern: /(?:^|\/)assets\/SourceSerif4-Semibold-[^/]+\.ttf$/,
    sha256: "36db62940cb5728b12b1802476dc7fcf4c6c519a7bdd476ba23a4e555fc4655f",
  },
  {
    label: "Source Serif 4 Bold",
    pattern: /(?:^|\/)assets\/SourceSerif4-Bold-[^/]+\.ttf$/,
    sha256: "7cf4f4e1ad74f45058d5bc61716b82560442fbdcd9d3654d2dea96bf6c683d86",
  },
  {
    label: "Source Code Pro Regular",
    pattern: /(?:^|\/)assets\/SourceCodePro-Regular-[^/]+\.ttf$/,
    sha256: "74bd80d3e42a08517cd7e1108ba3d86f2da29ac0f3065be95e0357956ab9db37",
  },
  {
    label: "Source Code Pro Bold",
    pattern: /(?:^|\/)assets\/SourceCodePro-Bold-[^/]+\.ttf$/,
    sha256: "b2095e0d657e6d28dc32444a9dacabab0c9241d0bf39d96371756cc9bdbc3a5f",
  },
  {
    label: "Source Sans 3 font license",
    pattern: /(?:^|\/)assets\/LICENSE-Source-Sans-3-[^/]+\.txt$/,
  },
  {
    label: "Source Serif 4 font license",
    pattern: /(?:^|\/)assets\/LICENSE-Source-Serif-4-[^/]+\.txt$/,
  },
  {
    label: "Source Code Pro font license",
    pattern: /(?:^|\/)assets\/LICENSE-Source-Code-Pro-[^/]+\.txt$/,
  },
  {
    label: "compiler Apache-2.0 license",
    pattern: /(?:^|\/)assets\/LICENSE-[A-Za-z0-9_-]+\.$/,
  },
] as const;

/**
 * Remote script origin: any executable form that would pull code from an
 * http(s) URL —
 *   - a static `import` (with bindings `import x from "url"`, namespace
 *     `import * as ns from "url"`, or a bare side-effect `import "url"`),
 *   - a dynamic `import(...)`,
 *   - `importScripts(...)` (classic/worker), or
 *   - an HTML `<script src=...>` whose URL is quoted OR unquoted.
 * Bare data/blob URLs and non-script string literals (e.g. a fetch endpoint)
 * are intentionally NOT matched — only executable remote code counts. Patterns
 * tolerate minified spacing (`import{a}from"url"`).
 */
const REMOTE_SCRIPT_RES: RegExp[] = [
  // Static import: side-effect (`import "url"`), or with a binding clause
  // (`import x from "url"`, `import * as ns from "url"`, `import {a} from "url"`).
  /\bimport\s*(?:[^"'`()]*\bfrom\s*)?["'`]https?:\/\/[^"'`]+["'`]/g,
  // Dynamic import().
  /\bimport\s*\(\s*["'`]https?:\/\/[^"'`]+["'`]/g,
  // Classic worker importScripts().
  /\bimportScripts\s*\(\s*["'`]https?:\/\/[^"'`]+["'`]/g,
  // HTML <script src=...> — URL quoted ("url"/'url') or unquoted (src=url).
  /<script\b[^>]*\bsrc\s*=\s*["']?https?:\/\/[^"'\s>]+/gi,
];

export interface FileLeak {
  /** Path relative to the scanned root. */
  file: string;
  /** Disallowed specifiers / remote origins found in the file. */
  findings: string[];
}

function walk(dir: string, exts: string[]): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      out.push(...walk(full, exts));
    } else if (exts.some((e) => full.endsWith(e))) {
      out.push(full);
    }
  }
  return out;
}

/** Extract all disallowed findings from one file's text. */
export function scanText(text: string): string[] {
  const found = new Set<string>();
  for (const m of text.matchAll(NODE_BUN_RE)) found.add(m[0].slice(1, -1));
  for (const re of REMOTE_SCRIPT_RES) {
    for (const m of text.matchAll(re)) found.add(m[0]);
  }
  for (const m of text.matchAll(NODE_GLOBAL_RE)) found.add(m[0]);
  for (const re of FAKE_BUFFER_GLOBAL_RES) {
    for (const m of text.matchAll(re)) found.add(m[0]);
  }
  for (const re of DYNAMIC_CODE_RES) {
    for (const m of text.matchAll(re)) found.add(m[0].trim());
  }
  return [...found];
}

/** Verify that every runtime asset needed for a browser-only PDF export exists. */
export function validatePdfArtifactInventory(artifacts: OutputArtifact[]): string[] {
  const issues: string[] = [];
  for (const requirement of REQUIRED_PDF_ARTIFACTS) {
    const matches = artifacts.filter((artifact) => requirement.pattern.test(artifact.path));
    if (matches.length !== 1) {
      issues.push(
        `${requirement.label}: expected exactly one bundled artifact, found ${matches.length}`
      );
      continue;
    }
    if ("minimumSize" in requirement && matches[0]!.size < requirement.minimumSize) {
      issues.push(
        `${requirement.label}: artifact is unexpectedly small (${matches[0]!.size} bytes)`
      );
    }
    if ("sha256" in requirement && matches[0]!.sha256 !== requirement.sha256) {
      issues.push(`${requirement.label}: SHA-256 does not match the pinned artifact`);
    }
  }
  return issues;
}

function collectArtifacts(root: string): OutputArtifact[] {
  return walk(root, [""]).map((file) => {
    const path = relative(root, file);
    const needsHash = file.endsWith(".wasm") || file.endsWith(".ttf");
    return {
      path,
      size: statSync(file).size,
      sha256: needsHash
        ? createHash("sha256").update(readFileSync(file)).digest("hex")
        : undefined,
    };
  });
}

/**
 * Scan a built extension directory for disallowed specifiers / remote origins.
 * Returns one {@link FileLeak} per offending file (empty array = clean).
 */
export function scanOutputDir(root: string): FileLeak[] {
  const leaks: FileLeak[] = [];
  for (const file of walk(root, [".js", ".html"])) {
    const findings = scanText(readFileSync(file, "utf8"));
    if (findings.length > 0) {
      leaks.push({ file: relative(root, file), findings });
    }
  }
  return leaks;
}

async function main(): Promise<void> {
  const root =
    process.argv[2] ?? join(import.meta.dir, "..", ".output", "chrome-mv3");

  let leaks: FileLeak[];
  let artifactIssues: string[];
  try {
    leaks = scanOutputDir(root);
    artifactIssues = validatePdfArtifactInventory(collectArtifacts(root));
  } catch (err) {
    console.error(
      `✗ extension output scan could not read '${root}': ${
        err instanceof Error ? err.message : String(err)
      }`
    );
    console.error("  run `bun run --cwd apps/extension build` first.");
    process.exit(1);
  }

  if (leaks.length === 0 && artifactIssues.length === 0) {
    console.log(
      `✓ extension output clean — CSP-safe and complete PDF runtime in ${root}`
    );
    return;
  }

  console.error("✗ extension output scan FAILED:");
  if (leaks.length > 0) {
    console.error("  disallowed content in bundle:");
    for (const leak of leaks) {
      console.error(`    ${leak.file}: ${leak.findings.join(", ")}`);
    }
  }
  if (artifactIssues.length > 0) {
    console.error("  incomplete PDF runtime:");
    for (const issue of artifactIssues) console.error(`    ${issue}`);
  }
  process.exit(1);
}

if (import.meta.main) {
  await main();
}
