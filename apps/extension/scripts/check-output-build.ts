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
 *   3. zero bare node GLOBALS (`Buffer.`, `process.env`, `__dirname`). These are
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
  return [...found];
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
  try {
    leaks = scanOutputDir(root);
  } catch (err) {
    console.error(
      `✗ extension output scan could not read '${root}': ${
        err instanceof Error ? err.message : String(err)
      }`
    );
    console.error("  run `bun run --cwd apps/extension build` first.");
    process.exit(1);
  }

  if (leaks.length === 0) {
    console.log(`✓ extension output clean — no node:/bun:/remote leaks in ${root}`);
    return;
  }

  console.error("✗ extension output scan FAILED — disallowed content in bundle:");
  for (const leak of leaks) {
    console.error(`  ${leak.file}: ${leak.findings.join(", ")}`);
  }
  process.exit(1);
}

if (import.meta.main) {
  await main();
}
