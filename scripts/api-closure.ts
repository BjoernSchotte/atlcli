#!/usr/bin/env bun
/**
 * API-freeze closure classification (spec 009 T4.2, "Classify the full
 * reachable declaration closure, not just the named seams").
 *
 * For every publishable package this generates `packages/<p>/etc/<p>.closure.md`:
 *
 * - the reviewed FREEZE DECISION (1.0.0 frozen vs. stays 0.x) with reasoning —
 *   per the plan's rule, a package only jumps to 1.0.0 with a reviewed
 *   classification;
 * - per exports entrypoint: its stability class (stable / experimental /
 *   internal) and the exported symbol list;
 * - for STABLE entrypoints: the transitive type closure of every exported
 *   declaration — same-package references are checked against the stable
 *   export set (a reachable-but-unexported type is a GAP), cross-`@atlcli/*`
 *   references are recorded per package (types owned by a 0.x package but
 *   reachable from a frozen surface are "frozen-by-closure": the frozen
 *   package's 1.0 contract covers its USE of them; the owning package stays
 *   0.x for its wider surface — lockstep versioning ships them together).
 *
 * Deterministic (sorted, no timestamps/absolute paths); `--update` writes the
 * committed files, plain mode exits non-zero on any diff.
 */
import ts from "typescript";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { entryPointsOf } from "./api-report.js";
import { publishablePackages, repoRoot } from "./consumer-smoke.js";

export interface FreezeDecision {
  version: "1.0.0" | "0.x";
  frozen: boolean;
  reasoning: string;
}

/**
 * The reviewed per-package freeze decisions (spec 009 T4.2, 2026-07-19).
 * Recorded here as the single source the closure files render from.
 */
export const FREEZE_DECISIONS: Record<string, FreezeDecision> = {
  "@atlcli/code-highlight": {
    version: "0.x",
    frozen: false,
    reasoning:
      "STAYS 0.x: introduced for issue 102 as the shared lazy Shiki catalogue and tokenizer " +
      "for DOCX, PDF, extension, CLI, and browser hosts. Keep it experimental while catalogue " +
      "upgrade and downstream host compatibility policy are proven across a release cycle.",
  },
  "@atlcli/confluence": {
    version: "1.0.0",
    frozen: true,
    reasoning:
      "Core v1 seams (ExportBlock/storageToBlocks, ExportNoteCode registry, ConfluenceClient, " +
      "TreeSource/fetchExportTree/composeChapters from spec 002) — designed, documented, and " +
      "regression-guarded (api-report + conformance suites). The non-frozen sync machinery " +
      "lives behind ./internal.",
  },
  "@atlcli/docx": {
    version: "1.0.0",
    frozen: true,
    reasoning:
      "ExportEnv/runExport host seams stable since spec 006 and consumed by three hosts " +
      "(CLI, extension, harness); barrel trimmed to the documented v1 surface; scan/resolver/" +
      "serialize internals live behind ./scan and ./internal (non-frozen).",
  },
  "@atlcli/pdf": {
    version: "1.0.0",
    frozen: true,
    reasoning:
      "PdfExportEnv/runPdfExport and the PdfCompilePort contract (specs 007/008 landed); " +
      "barrel trimmed to the seams + transitively required types; prepare/serialize/theme/" +
      "validate internals behind ./internal (non-frozen).",
  },
  "@atlcli/pdf-compiler-browser": {
    version: "1.0.0",
    frozen: true,
    reasoning:
      "Tiny, stable surface (BrowserPdfCompiler + BrowserPdfCompilerAssets) over the " +
      "sha256-pinned vendored compiler; consumed identically by CLI, extension, harness, and " +
      "the spec 011 parity harness.",
  },
  "@atlcli/pdf-template-authoring": {
    version: "0.x",
    frozen: false,
    reasoning:
      "STAYS 0.x: introduced by the PDF-template DOCX-intake vertical slice as the shared " +
      "browser-safe authoring and journey core. Keep it experimental until the CLI shape " +
      "and a browser host have both exercised the versioned reducers, ports, and views.",
  },
  "@atlcli/export-macros": {
    version: "1.0.0",
    frozen: true,
    reasoning:
      "MacroRendererRegistry is a named v1 seam, and the frozen docx/pdf surfaces embed " +
      "MacroResolutionOptions — freezing them requires freezing this contract too. The " +
      "renderer SET may still grow (additive, non-breaking); the registry/resolve contract " +
      "itself is what freezes.",
  },
  "@atlcli/export-wiring": {
    version: "0.x",
    frozen: false,
    reasoning:
      "STAYS 0.x: created in spec 010 by promoting the CLI's host-wiring module into a package " +
      "so the extension stops carrying a second copy. Its shape follows the hosts (client " +
      "construction, origin allowlists, session latching are all still moving); freeze it only " +
      "once a third shell — Forge or Tauri — has consumed it unchanged.",
  },
  "@atlcli/export-jobs": {
    version: "0.x",
    frozen: false,
    reasoning:
      "STAYS 0.x: the versioned lifecycle contracts begin in spec 013, but the reducers, " +
      "host stores, and second engine/host consumers have not landed yet. Keep the package " +
      "experimental until DOCX and PDF both pass CLI and packed-browser parity/recovery gates.",
  },
  "@atlcli/export-node": {
    version: "0.x",
    frozen: false,
    reasoning:
      "STAYS 0.x: days old (spec 009 phase 9), additive to the DoD and not in the original " +
      "v1 seam list; its convenience surface (nodePdfEnv options, default-template shape) " +
      "should harden against real external consumers before a 1.0 promise.",
  },
  "@atlcli/core": {
    version: "0.x",
    frozen: false,
    reasoning:
      "STAYS 0.x (plan pre-decision): the barrel is largely CLI/Bun-internal (auth.node, " +
      "keychain, tls.node, update, templates). Types reachable from frozen surfaces " +
      "(Profile, auth/TLS config) are frozen-by-closure only.",
  },
  "@atlcli/diagram": {
    version: "0.x",
    frozen: false,
    reasoning:
      "STAYS 0.x (plan pre-decision): renderer-internal surface beyond renderDiagram/" +
      "DiagramTheme; those two are re-exported (and frozen-by-closure) via @atlcli/docx.",
  },
  "@atlcli/jira": {
    version: "0.x",
    frozen: false,
    reasoning:
      "STAYS 0.x: never API-reviewed, Bun-only engines (webhook server is Bun.serve-native).",
  },
  "@atlcli/plugin-api": {
    version: "0.x",
    frozen: false,
    reasoning: "STAYS 0.x: never API-reviewed; the plugin loader story predates the freeze work.",
  },
  "@atlcli/template-pack": {
    version: "0.x",
    frozen: false,
    reasoning:
      "STAYS 0.x: spec 007 did not decide whether the template container is public API; the " +
      "byte format carries its own manifest versioning independent of semver.",
  },
};

type EntryStability = "stable" | "experimental" | "internal";

const INTERNAL_SUBPATHS = new Set(["./internal", "./scan", "./fixtures", "./template"]);
const EXPERIMENTAL_SUBPATHS = new Set(["./browser-runtime", "./vite"]);

export function entrypointStability(pkgName: string, label: string): EntryStability {
  const subpath = label.split(" ")[0]!;
  if (INTERNAL_SUBPATHS.has(subpath)) return "internal";
  if (EXPERIMENTAL_SUBPATHS.has(subpath)) return "experimental";
  return FREEZE_DECISIONS[pkgName]?.frozen ? "stable" : "experimental";
}

const COMPILER_OPTIONS: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  customConditions: [],
  skipLibCheck: true,
  noEmit: true,
};

interface ClosureRef {
  name: string;
  /** `@atlcli/<pkg>` for cross-package refs, "" for same-package. */
  ownerPackage: string;
}

/** Which `@atlcli` package (or "") a declaration file belongs to. */
function ownerOf(fileName: string): string | null {
  if (/\/typescript\/lib\//.test(fileName)) return null; // TS lib
  if (/\/(bun-types|@types\/node|@types\/)/.test(fileName)) return null; // ambient env types
  const atlcli = fileName.match(/\/(?:packages|@atlcli)\/([^/]+)\/dist\//);
  if (atlcli) return `@atlcli/${atlcli[1]}`;
  if (fileName.includes("/node_modules/")) return "(third-party)";
  return null;
}

/** Collect referenced type names from a declaration subtree. */
function collectTypeRefs(
  decl: ts.Node,
  checker: ts.TypeChecker,
  currentPackage: string,
  out: Map<string, ClosureRef>,
): void {
  const record = (nameNode: ts.EntityName | ts.Expression): void => {
    const leftmost = ts.isQualifiedName(nameNode as ts.Node)
      ? (function walk(n: ts.QualifiedName): ts.EntityName {
          return ts.isQualifiedName(n.left) ? walk(n.left) : n.left;
        })(nameNode as ts.QualifiedName)
      : nameNode;
    if (!ts.isIdentifier(leftmost as ts.Node)) return;
    const symbol = checker.getSymbolAtLocation(leftmost as ts.Node);
    if (!symbol) return;
    const resolved = symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
    const firstDecl = resolved.declarations?.[0];
    if (!firstDecl) return;
    // Generic type parameters (the T in Promise<T>) are declaration-local,
    // not part of any package surface.
    if (ts.isTypeParameterDeclaration(firstDecl)) return;
    const declFile = firstDecl.getSourceFile().fileName;
    const owner = ownerOf(declFile);
    if (owner === null || owner === "(third-party)") return;
    const ownerPackage = owner === currentPackage ? "" : owner;
    out.set(`${ownerPackage}|${resolved.name}`, { name: resolved.name, ownerPackage });
  };

  const visit = (node: ts.Node): void => {
    if (ts.isTypeReferenceNode(node)) record(node.typeName);
    else if (ts.isExpressionWithTypeArguments(node)) record(node.expression);
    else if (ts.isImportTypeNode(node) && node.qualifier) record(node.qualifier);
    node.forEachChild(visit);
  };
  visit(decl);
}

export interface EntrypointClosure {
  label: string;
  stability: EntryStability;
  exports: string[];
  /** Same-package refs NOT in the stable export set (should be empty). */
  gaps: string[];
  /** Cross-@atlcli refs, grouped: package → sorted type names. */
  crossRefs: Map<string, string[]>;
  /** Number of distinct same-package stable refs. */
  samePackageRefs: number;
}

export interface ClosureEntry {
  label: string;
  dtsPath: string;
  stability: EntryStability;
}

/**
 * The core closure/gap detector, decoupled from package.json + FREEZE_DECISIONS
 * so it can be exercised on synthetic fixtures (guard-the-guard). Classifies
 * each entrypoint's transitive type closure and flags same-package references
 * not present in the union of the stable entrypoints' exports.
 */
export function closureForEntrypoints(
  pkgName: string,
  entries: ClosureEntry[],
): EntrypointClosure[] {
  const program = ts.createProgram(
    entries.map((e) => e.dtsPath).filter((p) => existsSync(p)),
    COMPILER_OPTIONS,
  );
  const checker = program.getTypeChecker();

  const exportsOf = (dtsPath: string): { names: string[]; symbols: ts.Symbol[] } => {
    const sf = program.getSourceFile(dtsPath);
    if (!sf) return { names: [], symbols: [] };
    const moduleSymbol = checker.getSymbolAtLocation(sf);
    if (!moduleSymbol) return { names: [], symbols: [] };
    const symbols = checker.getExportsOfModule(moduleSymbol);
    return { names: symbols.map((s) => s.name).sort(), symbols };
  };

  // The package's stable export set = union of exports of its stable entrypoints.
  const stableNames = new Set<string>();
  for (const entry of entries) {
    if (entry.stability !== "stable") continue;
    for (const name of exportsOf(entry.dtsPath).names) stableNames.add(name);
  }

  return entries.map((entry) => {
    const stability = entry.stability;
    const { names, symbols } = exportsOf(entry.dtsPath);
    const gaps = new Set<string>();
    const crossRefs = new Map<string, Set<string>>();
    let samePackageRefs = 0;

    if (stability === "stable") {
      const refs = new Map<string, ClosureRef>();
      for (const symbol of symbols) {
        const resolved =
          symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
        for (const decl of resolved.declarations ?? []) {
          collectTypeRefs(decl, checker, pkgName, refs);
        }
      }
      const samePkg = new Set<string>();
      for (const ref of refs.values()) {
        if (ref.ownerPackage === "") {
          samePkg.add(ref.name);
          if (!stableNames.has(ref.name)) gaps.add(ref.name);
        } else {
          let set = crossRefs.get(ref.ownerPackage);
          if (!set) crossRefs.set(ref.ownerPackage, (set = new Set()));
          set.add(ref.name);
        }
      }
      samePackageRefs = samePkg.size;
    }

    return {
      label: entry.label,
      stability,
      exports: names,
      gaps: [...gaps].sort(),
      crossRefs: new Map(
        [...crossRefs.entries()]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([pkg, set]) => [pkg, [...set].sort()]),
      ),
      samePackageRefs,
    };
  });
}

export function closureForPackage(pkgDir: string, pkgName: string): EntrypointClosure[] {
  return closureForEntrypoints(
    pkgName,
    entryPointsOf(pkgDir).map((e) => ({
      label: e.label,
      dtsPath: e.dtsPath,
      stability: entrypointStability(pkgName, e.label),
    })),
  );
}

export function closureReportFor(pkgDir: string, pkgName: string): string {
  const decision = FREEZE_DECISIONS[pkgName];
  if (!decision) throw new Error(`no freeze decision recorded for ${pkgName}`);
  const closures = closureForPackage(pkgDir, pkgName);

  const lines: string[] = [
    `## API Closure Classification: ${pkgName}`,
    "",
    `> **Freeze decision (spec 009 T4.2): ${decision.frozen ? `${decision.version} — FROZEN` : `stays ${decision.version} — NOT frozen`}.**`,
    `> ${decision.reasoning}`,
    ">",
    "> Generated by `scripts/api-closure.ts` — regenerate with",
    "> `bun scripts/api-closure.ts --update` and have the diff reviewed.",
    "> Classes: **stable** (frozen v1 surface), **experimental** (exported,",
    "> may change in minors), **internal** (non-frozen implementation subpath).",
  ];

  for (const closure of closures) {
    lines.push("", `### Entry point \`${closure.label}\` — ${closure.stability}`, "");
    lines.push(`- exported symbols (${closure.exports.length}): ${closure.exports.join(", ") || "(none)"}`);
    if (closure.stability === "stable") {
      lines.push(`- same-package closure references: ${closure.samePackageRefs}`);
      if (closure.crossRefs.size > 0) {
        for (const [pkg, names] of closure.crossRefs) {
          const owner = FREEZE_DECISIONS[pkg];
          const status = owner?.frozen ? "frozen" : "0.x — frozen-by-closure";
          lines.push(`- reaches \`${pkg}\` (${status}): ${names.join(", ")}`);
        }
      }
      lines.push(
        closure.gaps.length === 0
          ? "- reachable-but-unexported gaps: none"
          : `- **reachable-but-unexported gaps (${closure.gaps.length}): ${closure.gaps.join(", ")}**`,
      );
    }
  }

  return `${lines.join("\n")}\n`;
}

export function closurePathFor(pkgDir: string): string {
  return join(pkgDir, "etc", `${basename(pkgDir)}.closure.md`);
}

export interface ClosureFileResult {
  name: string;
  path: string;
  generated: string;
  committed: string | null;
}

export function generateAllClosures(): ClosureFileResult[] {
  return publishablePackages().map((pkg) => {
    const path = closurePathFor(pkg.dir);
    return {
      name: pkg.name,
      path,
      generated: closureReportFor(pkg.dir, pkg.name),
      committed: existsSync(path) ? readFileSync(path, "utf8") : null,
    };
  });
}

if (import.meta.main) {
  const update = process.argv.includes("--update");
  let dirty = 0;
  for (const result of generateAllClosures()) {
    const rel = result.path.replace(`${repoRoot}/`, "");
    if (result.generated === result.committed) {
      console.log(`api-closure: ${result.name} unchanged (${rel})`);
      continue;
    }
    dirty += 1;
    if (update) {
      mkdirSync(dirname(result.path), { recursive: true });
      writeFileSync(result.path, result.generated);
      console.log(`api-closure: ${result.name} ${result.committed ? "updated" : "created"} ${rel}`);
    } else {
      console.error(`api-closure: ${result.name} DIFFERS from committed ${rel}`);
    }
  }
  if (dirty > 0 && !update) {
    console.error(
      "\napi-closure: classification changed — run `bun scripts/api-closure.ts --update` and have the diff reviewed.",
    );
    process.exit(1);
  }
}
