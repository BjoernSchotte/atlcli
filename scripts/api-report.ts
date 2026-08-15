#!/usr/bin/env bun
/**
 * API report generator (spec 009, API freeze & guards).
 *
 * For every publishable package (derived from the fail-closed
 * `atlcli.publish` classification) this flattens the public surface of each
 * `exports` entrypoint — from the BUILT `dist/*.d.ts`, the exact files a
 * consumer's type-checker reads — into a normalized, deterministic report
 * committed at `packages/<p>/etc/<p>.api.md`.
 *
 * Normalization rules:
 * - entrypoints sorted by subpath; symbols sorted by export name;
 * - declarations printed comment-free via the TypeScript printer —
 *   EXCEPT `@deprecated` / `@since` JSDoc tags, which are re-emitted as
 *   `// @deprecated …` lines so a symbol silently losing its deprecation
 *   tag shows up as a report diff (the breaking-change policy's
 *   "one minor with @deprecated before removal" is guard-enforced);
 * - no timestamps, no absolute paths (byte-identical across machines).
 *
 * Any surface change fails `scripts/api-report.test.ts` until the report is
 * regenerated (`bun scripts/api-report.ts --update`) and the diff reviewed.
 */
import ts from "typescript";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { publishablePackages, repoRoot } from "./consumer-smoke.js";

interface EntryPointDts {
  /** Section label, e.g. `.`, `./browser`, `. (browser)`. */
  label: string;
  dtsPath: string;
}

/**
 * The `.d.ts` entrypoints of a package's exports map: skip the workspace-only
 * `development` condition, raw-asset subpaths (patterns and plain-string
 * targets like `./wasm` or `./fonts/*`), and dedupe conditions that share one
 * declaration file.
 */
export function entryPointsOf(pkgDir: string): EntryPointDts[] {
  const manifest = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")) as {
    exports?: Record<string, unknown>;
  };
  const out: EntryPointDts[] = [];

  for (const [subpath, value] of Object.entries(manifest.exports ?? {})) {
    if (subpath.includes("*")) continue; // asset patterns
    if (typeof value === "string") continue; // raw asset target (e.g. ./wasm)
    if (value === null || typeof value !== "object") continue;

    const conditions = value as Record<string, unknown>;
    const variants: Array<{ condition: string; types: string }> = [];

    if (typeof conditions.types === "string") {
      variants.push({ condition: "", types: conditions.types });
    } else {
      for (const [condition, entry] of Object.entries(conditions)) {
        if (condition === "development") continue;
        if (entry && typeof entry === "object") {
          const types = (entry as Record<string, unknown>).types;
          if (typeof types === "string") variants.push({ condition, types });
        }
      }
    }

    const uniqueTargets = [...new Set(variants.map((v) => v.types))];
    if (uniqueTargets.length === 1) {
      out.push({ label: subpath, dtsPath: resolve(pkgDir, uniqueTargets[0]!) });
    } else {
      for (const variant of variants) {
        out.push({
          label: `${subpath} (${variant.condition})`,
          dtsPath: resolve(pkgDir, variant.types),
        });
      }
    }
  }

  return out.sort((a, b) => a.label.localeCompare(b.label));
}

const COMPILER_OPTIONS: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  customConditions: [],
  skipLibCheck: true,
  noEmit: true,
};

/** `@deprecated` / `@since` annotations for a declaration and its members. */
function jsDocAnnotations(decl: ts.Declaration, symbolName: string): string[] {
  const lines: string[] = [];
  const collect = (node: ts.Node, path: string): void => {
    for (const tag of ts.getJSDocTags(node)) {
      const tagName = tag.tagName.text;
      if (tagName !== "deprecated" && tagName !== "since") continue;
      const comment = typeof tag.comment === "string" ? tag.comment : ts.getTextOfJSDocComment(tag.comment) ?? "";
      lines.push(`// @${tagName} ${path}${comment ? ` — ${comment}` : ""}`.trimEnd());
    }
    node.forEachChild((child) => {
      // Not every node carries a `name`, so probe for it as an optional property.
      const nameNode = (child as { name?: ts.Node }).name;
      const name = nameNode && ts.isIdentifier(nameNode) ? nameNode.text : undefined;
      collect(child, name ? `${path}.${name}` : path);
    });
  };
  collect(decl, symbolName);
  return [...new Set(lines)].sort();
}

/** Flatten one d.ts entrypoint into normalized report lines. */
export function reportForDts(dtsPath: string): string {
  if (!existsSync(dtsPath)) {
    throw new Error(`api-report: ${dtsPath} does not exist — run \`bun run build\` first.`);
  }
  const program = ts.createProgram([dtsPath], COMPILER_OPTIONS);
  const checker = program.getTypeChecker();
  const sourceFile = program.getSourceFile(dtsPath);
  if (!sourceFile) throw new Error(`api-report: could not load ${dtsPath}`);
  const moduleSymbol = checker.getSymbolAtLocation(sourceFile);
  if (!moduleSymbol) throw new Error(`api-report: ${dtsPath} is not a module`);

  const printer = ts.createPrinter({ removeComments: true, newLine: ts.NewLineKind.LineFeed });
  const sections: string[] = [];

  const exportsOfModule = checker
    .getExportsOfModule(moduleSymbol)
    .sort((a, b) => a.name.localeCompare(b.name));

  for (const symbol of exportsOfModule) {
    const resolved =
      symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
    const declarations = resolved.declarations ?? [];
    const chunk: string[] = [];

    for (const decl of declarations) {
      // Import-clause / export-specifier nodes carry no surface of their own.
      if (ts.isExportSpecifier(decl) || ts.isImportSpecifier(decl) || ts.isImportClause(decl)) {
        continue;
      }
      chunk.push(...jsDocAnnotations(decl, symbol.name));
      const printable = ts.isVariableDeclaration(decl)
        ? decl.parent.parent // print the full `export declare const …` statement
        : decl;
      chunk.push(
        printer.printNode(ts.EmitHint.Unspecified, printable, decl.getSourceFile()).trim(),
      );
    }

    if (chunk.length > 0) {
      sections.push([`// export: ${symbol.name}`, ...chunk].join("\n"));
    }
  }

  return sections.join("\n\n");
}

/** The full committed report for one package. */
export function reportForPackage(pkgDir: string, pkgName: string): string {
  const parts: string[] = [
    `## API Report: ${pkgName}`,
    "",
    "> Generated by `scripts/api-report.ts` from the built `dist/*.d.ts`.",
    "> Do NOT edit by hand — regenerate with `bun scripts/api-report.ts --update`",
    "> and have the diff reviewed (spec 009, API freeze & guards).",
  ];
  for (const entry of entryPointsOf(pkgDir)) {
    parts.push("", `### Entry point \`${entry.label}\``, "", "```ts", reportForDts(entry.dtsPath), "```");
  }
  return `${parts.join("\n")}\n`;
}

export function reportPathFor(pkgDir: string): string {
  const shortName = basename(pkgDir);
  return join(pkgDir, "etc", `${shortName}.api.md`);
}

export interface PackageReport {
  name: string;
  dir: string;
  reportPath: string;
  generated: string;
  committed: string | null;
}

export function generateAllReports(): PackageReport[] {
  return publishablePackages().map((pkg) => {
    const reportPath = reportPathFor(pkg.dir);
    return {
      name: pkg.name,
      dir: pkg.dir,
      reportPath,
      generated: reportForPackage(pkg.dir, pkg.name),
      committed: existsSync(reportPath) ? readFileSync(reportPath, "utf8") : null,
    };
  });
}

if (import.meta.main) {
  const update = process.argv.includes("--update");
  let dirty = 0;
  for (const report of generateAllReports()) {
    const rel = report.reportPath.replace(`${repoRoot}/`, "");
    if (report.generated === report.committed) {
      console.log(`api-report: ${report.name} unchanged (${rel})`);
      continue;
    }
    dirty += 1;
    if (update) {
      mkdirSync(dirname(report.reportPath), { recursive: true });
      writeFileSync(report.reportPath, report.generated);
      console.log(`api-report: ${report.name} ${report.committed ? "updated" : "created"} ${rel}`);
    } else {
      console.error(`api-report: ${report.name} DIFFERS from committed ${rel}`);
    }
  }
  if (dirty > 0 && !update) {
    console.error(
      "\napi-report: public surface changed — run `bun scripts/api-report.ts --update` and have the diff reviewed.",
    );
    process.exit(1);
  }
}
