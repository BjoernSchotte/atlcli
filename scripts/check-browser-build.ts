#!/usr/bin/env bun
/**
 * Browser-build CI gate (spec 001 §6).
 *
 * Rebuilds the four isomorphic entrypoints with `--target=browser` and asserts,
 * per entrypoint, that the build succeeds AND the bundled output contains no
 * `node:`/`bun:` specifiers. The specifier scan is deliberate belt-and-suspenders:
 * `bun build --target=browser` sometimes *externalizes* a `node:` import instead
 * of failing, producing a "successful" but browser-broken bundle.
 *
 * A stray `node:`/`bun:` import anywhere in an entrypoint's transitive graph
 * turns this red, naming both the entrypoint and the offending specifier(s).
 */
/** The entrypoints that MUST build for the browser (spec 001 §6). */
export const BROWSER_ENTRYPOINTS = [
  "packages/confluence/src/markdown.ts",
  "packages/confluence/src/client.ts",
  "packages/jira/src/client.ts",
  "packages/core/src/index.browser.ts",
  "packages/confluence/src/index.browser.ts",
  "packages/docx/src/index.browser.ts",
  "packages/diagram/src/index.ts",
  "packages/pdf/src/index.browser.ts",
];

/**
 * Matches a *quoted* `node:`/`bun:` module specifier — i.e. an actual import
 * or require target (including the ones Bun externalizes verbatim, e.g.
 * `require("node:fs")`). Bare (unquoted) matches are avoided on bundled output
 * because Bun inlines diagnostic strings like `"… not implemented for node:buffer …"`
 * into its browser polyfill shims, which are self-contained, not real imports.
 */
const SPECIFIER_RE = /["'](node|bun):[A-Za-z0-9_./-]*["']/g;
/** Looser scan used only on build-failure diagnostics, where quoting is unreliable. */
const BARE_SPECIFIER_RE = /\b(node|bun):[A-Za-z0-9_./-]+/g;

export interface EntryCheckResult {
  entrypoint: string;
  ok: boolean;
  /** Disallowed specifiers found (in bundled output or, on failure, in logs). */
  specifiers: string[];
  /** True when `Bun.build` itself reported failure (vs. a clean build that leaked). */
  buildFailed: boolean;
  /** Human-readable build diagnostics, when any. */
  logs: string[];
}

/**
 * Extract disallowed specifiers.
 * @param includeBare - also match unquoted forms (only safe for failure logs).
 */
function uniqueSpecifiers(text: string, includeBare = false): string[] {
  const found = new Set<string>();
  for (const m of text.matchAll(SPECIFIER_RE)) found.add(m[0].slice(1, -1));
  if (includeBare) {
    for (const m of text.matchAll(BARE_SPECIFIER_RE)) found.add(m[0]);
  }
  return [...found];
}

/** Flatten Bun build diagnostics (BuildMessages / AggregateError) into strings. */
function collectDiagnostics(source: unknown): string[] {
  const out: string[] = [];
  const push = (v: unknown) => {
    if (v && typeof v === "object" && "message" in v && typeof (v as { message: unknown }).message === "string") {
      out.push((v as { message: string }).message);
    } else {
      out.push(String(v));
    }
  };
  if (Array.isArray(source)) {
    for (const item of source) push(item);
  } else if (source instanceof AggregateError) {
    if (source.message) out.push(source.message);
    for (const sub of source.errors ?? []) push(sub);
  } else {
    push(source);
  }
  return out;
}

/** Build one entrypoint for the browser and scan its output for leaks. */
export async function checkEntrypoint(entrypoint: string): Promise<EntryCheckResult> {
  let result: Awaited<ReturnType<typeof Bun.build>>;
  try {
    result = await Bun.build({ entrypoints: [entrypoint], target: "browser" });
  } catch (err) {
    const logs = collectDiagnostics(err);
    return {
      entrypoint,
      ok: false,
      buildFailed: true,
      specifiers: uniqueSpecifiers(logs.join("\n"), true),
      logs,
    };
  }

  if (!result.success) {
    const logs = collectDiagnostics(result.logs);
    return {
      entrypoint,
      ok: false,
      buildFailed: true,
      specifiers: uniqueSpecifiers(logs.join("\n"), true),
      logs,
    };
  }

  let output = "";
  for (const artifact of result.outputs) output += await artifact.text();
  const specifiers = uniqueSpecifiers(output);

  return {
    entrypoint,
    ok: specifiers.length === 0,
    buildFailed: false,
    specifiers,
    logs: [],
  };
}

/** Check all given entrypoints; defaults to {@link BROWSER_ENTRYPOINTS}. */
export async function checkBrowserBuild(
  entrypoints: string[] = BROWSER_ENTRYPOINTS
): Promise<EntryCheckResult[]> {
  return Promise.all(entrypoints.map(checkEntrypoint));
}

async function main(): Promise<void> {
  const results = await checkBrowserBuild();
  let failed = false;

  for (const r of results) {
    if (r.ok) {
      console.log(`✓ ${r.entrypoint} — browser build clean (no node:/bun: specifiers)`);
      continue;
    }
    failed = true;
    if (r.buildFailed) {
      console.error(`✗ ${r.entrypoint} — bun build --target=browser failed`);
    } else {
      console.error(`✗ ${r.entrypoint} — bundled output leaks disallowed specifier(s)`);
    }
    if (r.specifiers.length > 0) {
      console.error(`    offending specifier(s): ${r.specifiers.join(", ")}`);
    }
    for (const log of r.logs) console.error(`    ${log}`);
  }

  if (failed) {
    console.error("\nbrowser-build gate FAILED — a node:/bun: dependency leaked into a browser entrypoint.");
    process.exit(1);
  }
  console.log(`\nbrowser-build gate passed — ${results.length} entrypoints are isomorphic.`);
}

// Run only when invoked directly (not when imported by the test).
if (import.meta.main) {
  await main();
}
