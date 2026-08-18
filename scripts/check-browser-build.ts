#!/usr/bin/env bun
/**
 * Browser-build CI gate (spec 001 §6).
 *
 * Rebuilds every isomorphic entrypoint with `--target=browser` and asserts, per
 * entrypoint, that the build succeeds AND that nothing in its transitive graph
 * reaches a Node/Bun builtin or a host-only framework/runtime.
 *
 * ## Three rules, because one is not enough
 *
 * 1. **Source-graph scan (primary).** A `Bun.build` plugin observes every
 *    module specifier the bundler resolves and flags builtins — in BOTH
 *    spellings, `node:fs` *and* the legacy bare `fs` — plus host-only Forge,
 *    WXT, React, and WebExtension imports. It names the importing source file,
 *    so a failure points at the line to change.
 * 2. **Output specifier scan.** The original rule, kept as belt-and-suspenders:
 *    `bun build --target=browser` sometimes *externalizes* a `node:` import
 *    instead of failing, producing a "successful" but browser-broken bundle.
 * 3. **Output `Bun.*` global scan.** Covers what rule 1 structurally cannot see
 *    (below).
 *
 * ## Why rule 1 exists — the hole it closes
 *
 * Until spec 010 this gate had only rule 2, and rule 2 requires the `node:`/
 * `bun:` PREFIX. Modules using the legacy bare form (`import { homedir } from
 * "os"`, `"path"`, `"fs"`, `"crypto"`) were invisible to it, and Bun silently
 * substitutes a browser polyfill for those rather than failing. Measured on
 * Bun 1.3.8: `packages/jira/src/index.ts` — a barrel that re-exports a
 * **Bun-native webhook server** — built "successfully" at 0.98 MB with ZERO
 * quoted specifier matches, while the bundle contained `homedir`,
 * `createHmac`, `Bun.serve` and Bun's own "not implemented" polyfill text. The
 * gate called it isomorphic. `check-browser-build.test.ts` now runs the real
 * check against that real barrel and asserts it fails, so the hole cannot
 * silently reopen.
 *
 * ## Why rule 3 exists
 *
 * `import type { Server } from "bun"` erases at compile time: rule 1 never sees
 * a resolve, rule 2 never sees a specifier, yet the `Bun.serve(...)` CALL
 * survives into the bundle and throws in a browser. Scanning the output for
 * `Bun.<member>` catches that residue. It is deliberately narrow — see
 * "Measured false-positive surface" below.
 *
 * ## Measured false-positive surface
 *
 * Rules were checked against all 18 entrypoints before being adopted:
 *   - `Bun.<member>`: 0 hits across all 18, 1 hit on the jira barrel. Adopted.
 *   - `Buffer.`: hits 9 of 18 legitimately (bundled dependency code, e.g.
 *     `Buffer.isBuffer` guards). REJECTED — it would fail CI on green code.
 *     The shipped extension artifact is where that rule belongs, and
 *     `apps/extension/scripts/check-output-build.ts` already enforces it there.
 *   - `process.env`: hits the docx entrypoints. REJECTED, same reason.
 *   - Bun's "not implemented" polyfill text: hits entrypoints with no builtin
 *     in their graph at all. REJECTED — it is not specific to a leak.
 *
 * ## Known limits (documented on purpose)
 *
 *   - Rule 1 sees SPECIFIERS. A dependency that ships a *pre-bundled* copy of a
 *     polyfill inline (no import to resolve) is invisible to it.
 *   - Bare Node globals (`Buffer`, `process`, `__dirname`) are not checked
 *     here, for the false-positive reason above.
 *   - Reaching a Node-only npm package (say `keytar`) is not detected as such;
 *     it is only caught if that package itself imports a builtin.
 */
import { existsSync } from "node:fs";
import { dirname, join, parse as parsePath } from "node:path";
import ts from "typescript";

/** The entrypoints that MUST build for the browser (spec 001 §6). */
export const BROWSER_ENTRYPOINTS = [
  "packages/action-registry/src/index.ts",
  "packages/change-set/src/index.ts",
  "packages/change-set/src/adf/index.ts",
  "packages/export-blocks/src/index.ts",
  "packages/web-publish/src/index.ts",
  "packages/confluence/src/markdown.ts",
  "packages/confluence/src/client.ts",
  "packages/confluence/src/attachment-delivery.ts",
  "packages/confluence/src/research.ts",
  "packages/jira/src/client.ts",
  "packages/core/src/index.browser.ts",
  "packages/confluence/src/index.browser.ts",
  "packages/jira/src/index.browser.ts",
  "packages/research/src/index.browser.ts",
  "packages/code-highlight/src/index.browser.ts",
  "packages/docx/src/index.browser.ts",
  "packages/docx/src/internal.ts",
  "packages/docx/src/browser-runtime.ts",
  "packages/docx/src/browser-entry.ts",
  "packages/diagram/src/index.ts",
  "packages/pdf/src/index.browser.ts",
  "packages/pdf/src/template-authoring-runtime.ts",
  "packages/pdf/src/internal.ts",
  "packages/pdf-compiler-browser/src/index.ts",
  "packages/template-pack/src/index.browser.ts",
  "packages/pdf-template-authoring/src/index.browser.ts",
  "packages/docx-template-intake/src/index.browser.ts",
  "packages/docx-template-intake/src/application.ts",
  "packages/import-core/src/index.browser.ts",
  "packages/export-macros/src/index.ts",
  "packages/export-macros/src/internal.ts",
  "packages/export-wiring/src/index.ts",
  "packages/export-wiring/src/fixtures.ts",
  "packages/export-wiring/src/jobs/index.ts",
  "packages/export-jobs/src/index.ts",
];

/**
 * Node/Bun builtin module names in their LEGACY BARE form — the spelling that
 * carries no `node:` prefix and therefore no marker for an output text scan.
 *
 * Subpaths (`fs/promises`, `path/posix`, `stream/web`, `util/types`) are matched
 * by prefix, so only the package segment is listed. `bun` is included because a
 * *value* import (`import { $ } from "bun"`) is as fatal as `bun:sqlite`; a
 * type-only import of it erases and is correctly not seen here (rule 3 covers
 * the residue).
 */
export const BARE_BUILTIN_MODULES = [
  "assert", "async_hooks", "buffer", "child_process", "cluster", "console",
  "constants", "crypto", "dgram", "diagnostics_channel", "dns", "domain",
  "events", "fs", "http", "http2", "https", "inspector", "module", "net",
  "os", "path", "perf_hooks", "process", "punycode", "querystring", "readline",
  "repl", "stream", "string_decoder", "sys", "timers", "tls", "trace_events",
  "tty", "url", "util", "v8", "vm", "wasi", "worker_threads", "zlib",
  "bun",
] as const;

/**
 * Import paths rule 1 asks about: anything `node:`/`bun:`-prefixed, plus a bare
 * builtin name either alone or as a subpath root. Relative (`./path.js`) and
 * absolute paths never match, so a local module named `path.ts` is safe by
 * construction. A bare name that merely *starts* with a builtin name is safe
 * too: the `(?:/|$)` boundary keeps `pathe`, `oslllo-svg2`, `utils` out.
 */
const HOST_ONLY_SPECIFIER_RE = new RegExp(
  `^(?:` +
    `@forge/|@wxt-dev/|wxt(?:/|$)|react(?:/|$)|react-dom(?:/|$)|` +
    `webextension-polyfill(?:/|$)|node:|bun:|` +
    `(?:${BARE_BUILTIN_MODULES.join("|")})(?:/|$)` +
  `)`
);

/**
 * Bun resolves its own browser polyfills inside a virtual filesystem. Those
 * shims re-import builtin names among themselves (`crypto` → `buffer`, `vm`,
 * `stream` → `events`), which is Bun's substitute FOR the builtin, not a leak
 * of our own. Ignoring this importer prefix is the gate's only exemption; the
 * import that *caused* Bun to pull the shim in is still reported, at its real
 * source file.
 */
const BUN_POLYFILL_IMPORTER_PREFIX = "/bun-vfs$$/";

/** Looser scan used only on build-failure diagnostics, where quoting is unreliable. */
const BARE_SPECIFIER_RE = /\b(node|bun):[A-Za-z0-9_./-]+/g;

/**
 * Member access on the `Bun` global (`Bun.serve(`, `Bun.file(`). The lookbehind
 * excludes `foo.Bun.x` and identifiers ending in `Bun`, so this only fires on
 * the global itself. Measured: zero hits across all 18 entrypoints.
 */
const BUN_GLOBAL_RE = /(?<![\w$.])Bun\s*\.\s*[A-Za-z_$][\w$]*/g;

/** One builtin import found in an entrypoint's transitive source graph. */
export interface BuiltinImport {
  /** The specifier as written, e.g. `os` or `node:fs/promises`. */
  specifier: string;
  /** Absolute path of the file that imports it (repo-relative when possible). */
  importer: string;
}

export interface EntryCheckResult {
  entrypoint: string;
  ok: boolean;
  /** Disallowed specifiers found (in bundled output or, on failure, in logs). */
  specifiers: string[];
  /** Builtin imports found in the transitive source graph (rule 1). */
  builtinImports: BuiltinImport[];
  /** `Bun.*` global usages surviving into the bundle (rule 3). */
  bunGlobals: string[];
  /** Host-specific modules reached by an otherwise buildable browser graph. */
  hostGraphViolations: Array<{
    category:
      | "cli"
      | "extension"
      | "filesystem-adapter"
      | "process-lock"
      | "terminal";
    path: string;
  }>;
  /** True when `Bun.build` itself reported failure (vs. a clean build that leaked). */
  buildFailed: boolean;
  /** Human-readable build diagnostics, when any. */
  logs: string[];
}

const HOST_GRAPH_RULES: readonly {
  category: EntryCheckResult["hostGraphViolations"][number]["category"];
  pattern: RegExp;
}[] = [
  { category: "cli", pattern: /\/apps\/cli\//u },
  { category: "extension", pattern: /\/apps\/extension\//u },
  {
    category: "filesystem-adapter",
    pattern: /\/(?:pdf-template-project-writer|file-system|filesystem)\.[cm]?[jt]s$/u,
  },
  { category: "process-lock", pattern: /\/process-lock\.[cm]?[jt]s$/u },
  {
    category: "terminal",
    pattern: /\/(?:terminal|prompt|terminal-formatting)\.[cm]?[jt]s$/u,
  },
];

function hostGraphScanPlugin(
  sink: EntryCheckResult["hostGraphViolations"],
  cwd: string
): import("bun").BunPlugin {
  return {
    name: "atlcli-host-neutral-path-scan",
    setup(build) {
      build.onLoad({ filter: /.*/ }, (args) => {
        for (const rule of HOST_GRAPH_RULES) {
          if (!rule.pattern.test(args.path)) continue;
          sink.push({
            category: rule.category,
            path: args.path.startsWith(cwd + "/")
              ? args.path.slice(cwd.length + 1)
              : args.path,
          });
        }
        return undefined;
      });
    },
  };
}

function uniqueHostGraphViolations(
  found: EntryCheckResult["hostGraphViolations"]
): EntryCheckResult["hostGraphViolations"] {
  const seen = new Set<string>();
  return found.filter(({ category, path }) => {
    const key = `${category}\0${path}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Extract disallowed specifiers.
 * @param includeBare - also match unquoted forms (only safe for failure logs).
 */
function uniqueDiagnosticSpecifiers(text: string): string[] {
  const found = new Set<string>();
  for (const m of text.matchAll(BARE_SPECIFIER_RE)) found.add(m[0]);
  return [...found];
}

/**
 * Read only syntactic import/export/require targets from a completed bundle.
 *
 * A text regex is not sufficient here: dependencies may include documentation
 * strings such as `set File to import('node:buffer').File`. That text contains
 * a perfectly quoted specifier but is not executable module syntax. Parsing the
 * emitted JavaScript preserves the belt-and-suspenders output check without
 * turning dependency error messages into false positives.
 */
export function uniqueOutputSpecifiers(text: string): string[] {
  const source = ts.createSourceFile(
    "browser-bundle.js",
    text,
    ts.ScriptTarget.ESNext,
    false,
    ts.ScriptKind.JS,
  );
  const found = new Set<string>();
  const collect = (literal: ts.Expression | undefined): void => {
    if (!literal || !ts.isStringLiteralLike(literal)) return;
    if (/^(?:node|bun):[A-Za-z0-9_./-]*$/u.test(literal.text)) {
      found.add(literal.text);
    }
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      collect(node.moduleSpecifier);
    } else if (ts.isCallExpression(node) && node.arguments.length === 1) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(node.expression) && node.expression.text === "require")) {
        collect(node.arguments[0]);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
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

/**
 * Is `specifier` shadowed by a real npm package of the same name, reachable
 * from `fromDir`?
 *
 * This is the false-positive guard the bare-form rule needs. Packages named
 * exactly like builtins exist and are legitimate browser shims (`util`,
 * `buffer`, `events`, `process`, `punycode`, `stream`, `assert`). If one is
 * installed, a bare import of that name is a package import, not a builtin, and
 * must not fail the gate.
 *
 * `Bun.resolveSync` cannot answer this on its own: run under Bun/Node it
 * resolves `util` to `node:util` whether or not a package by that name is
 * installed, exactly as `require` would. So the node_modules lookup is done
 * directly, the way a bundler's resolver does it.
 */
function shadowedByRealPackage(specifier: string, fromDir: string): boolean {
  const pkg = specifier.split("/")[0]!;
  const { root } = parsePath(fromDir);
  let dir = fromDir;
  for (;;) {
    if (existsSync(join(dir, "node_modules", pkg, "package.json"))) return true;
    if (dir === root) return false;
    const parent = dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
}

/**
 * A `Bun.build` plugin that records every builtin the bundler resolves.
 *
 * It never *changes* resolution: the hook returns `undefined`, so Bun proceeds
 * exactly as it would without the plugin, and the gate's build stays a faithful
 * reproduction of a real browser build.
 */
function builtinScanPlugin(sink: BuiltinImport[], cwd: string): import("bun").BunPlugin {
  return {
    name: "atlcli-builtin-scan",
    setup(build) {
      build.onResolve({ filter: HOST_ONLY_SPECIFIER_RE }, (args) => {
        const importer = args.importer;
        // Bun's own polyfill graph — see BUN_POLYFILL_IMPORTER_PREFIX.
        if (!importer || importer.startsWith(BUN_POLYFILL_IMPORTER_PREFIX)) return undefined;

        const bare = args.path.replace(/^(?:node|bun):/, "");
        const hostOnlyPackage =
          args.path.startsWith("@forge/") ||
          args.path.startsWith("@wxt-dev/") ||
          /^(?:wxt|react|react-dom|webextension-polyfill)(?:\/|$)/u.test(
            args.path,
          );
        const prefixed = args.path !== bare || hostOnlyPackage;
        // A `node:`/`bun:` prefix is unambiguous; a bare name is only a builtin
        // when no real package of that name shadows it. Framework/host imports
        // are also unambiguous here: shared exporters must remain independent
        // of Forge, React, WXT, and WebExtension APIs.
        if (!prefixed && shadowedByRealPackage(bare, dirname(importer))) return undefined;

        sink.push({
          specifier: args.path,
          importer: importer.startsWith(cwd + "/") ? importer.slice(cwd.length + 1) : importer,
        });
        return undefined;
      });
    },
  };
}

/** Dedupe `{specifier, importer}` pairs, preserving first-seen order. */
function uniqueBuiltinImports(found: BuiltinImport[]): BuiltinImport[] {
  const seen = new Set<string>();
  const out: BuiltinImport[] = [];
  for (const hit of found) {
    const key = `${hit.specifier} ${hit.importer}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(hit);
  }
  return out;
}

/** Build one entrypoint for the browser and apply all three rules. */
export async function checkEntrypoint(entrypoint: string): Promise<EntryCheckResult> {
  const found: BuiltinImport[] = [];
  const hostGraphViolations: EntryCheckResult["hostGraphViolations"] = [];
  let result: Awaited<ReturnType<typeof Bun.build>>;
  try {
    // `development` keeps this gate source-based: `@atlcli/*` exports resolve
    // to `src/*.ts` (workspace DX condition, spec 009) instead of `dist/`,
    // so the gate needs no prior package build.
    result = await Bun.build({
      entrypoints: [entrypoint],
      target: "browser",
      conditions: ["development"],
      plugins: [
        builtinScanPlugin(found, process.cwd()),
        hostGraphScanPlugin(hostGraphViolations, process.cwd()),
      ],
    });
  } catch (err) {
    const logs = collectDiagnostics(err);
    return {
      entrypoint,
      ok: false,
      buildFailed: true,
      specifiers: uniqueDiagnosticSpecifiers(logs.join("\n")),
      builtinImports: uniqueBuiltinImports(found),
      bunGlobals: [],
      hostGraphViolations: uniqueHostGraphViolations(hostGraphViolations),
      logs,
    };
  }

  if (!result.success) {
    const logs = collectDiagnostics(result.logs);
    return {
      entrypoint,
      ok: false,
      buildFailed: true,
      specifiers: uniqueDiagnosticSpecifiers(logs.join("\n")),
      builtinImports: uniqueBuiltinImports(found),
      bunGlobals: [],
      hostGraphViolations: uniqueHostGraphViolations(hostGraphViolations),
      logs,
    };
  }

  let output = "";
  for (const artifact of result.outputs) output += await artifact.text();
  const specifiers = uniqueOutputSpecifiers(output);
  const bunGlobals = [...new Set([...output.matchAll(BUN_GLOBAL_RE)].map((m) => m[0]))];
  const builtinImports = uniqueBuiltinImports(found);
  const uniqueHostViolations =
    uniqueHostGraphViolations(hostGraphViolations);

  return {
    entrypoint,
    ok:
      specifiers.length === 0 &&
      builtinImports.length === 0 &&
      bunGlobals.length === 0 &&
      uniqueHostViolations.length === 0,
    buildFailed: false,
    specifiers,
    builtinImports,
    bunGlobals,
    hostGraphViolations: uniqueHostViolations,
    logs: [],
  };
}

/** Check all given entrypoints; defaults to {@link BROWSER_ENTRYPOINTS}. */
export async function checkBrowserBuild(
  entrypoints: string[] = BROWSER_ENTRYPOINTS
): Promise<EntryCheckResult[]> {
  return Promise.all(entrypoints.map(checkEntrypoint));
}

/**
 * CLI.
 *
 * `bun scripts/check-browser-build.ts` — check {@link BROWSER_ENTRYPOINTS} (CI).
 * `bun scripts/check-browser-build.ts [--json] <entry>…` — check the given
 * entrypoints instead; `--json` prints the raw {@link EntryCheckResult}s.
 *
 * The explicit-entrypoint form exists because the gate's own test cannot run a
 * repo-module build in-process: `Bun.build` over the workspace source graph
 * corrupts module resolution for test files loaded afterwards (measured — a
 * single such call inside `bun test` took the suite from 4162 passing to 4011
 * with 9 files erroring out). So `check-browser-build.test.ts` spawns THIS
 * script, which keeps the acceptance test end-to-end rather than mocked.
 *
 * `--json` never changes the exit code: a failing entrypoint still exits 1, so
 * the flag cannot be used to soften the gate.
 */
async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const asJson = argv.includes("--json");
  const requested = argv.filter((arg) => !arg.startsWith("--"));

  const results = await checkBrowserBuild(requested.length > 0 ? requested : undefined);
  let failed = results.some((r) => !r.ok);

  if (asJson) {
    console.log(JSON.stringify(results, null, 2));
    process.exit(failed ? 1 : 0);
  }

  for (const r of results) {
    if (r.ok) {
      console.log(`✓ ${r.entrypoint} — browser build clean (no Node/Bun builtins reached)`);
      continue;
    }
    failed = true;
    if (r.buildFailed) {
      console.error(`✗ ${r.entrypoint} — bun build --target=browser failed`);
    } else {
      console.error(`✗ ${r.entrypoint} — reaches Node/Bun-only code`);
    }
    for (const hit of r.builtinImports) {
      console.error(`    builtin import: ${hit.importer} imports "${hit.specifier}"`);
    }
    for (const hit of r.hostGraphViolations) {
      console.error(`    host graph: ${hit.category} module ${hit.path}`);
    }
    if (r.specifiers.length > 0) {
      console.error(`    offending specifier(s) in output: ${r.specifiers.join(", ")}`);
    }
    if (r.bunGlobals.length > 0) {
      console.error(`    Bun global(s) in output: ${r.bunGlobals.join(", ")}`);
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
