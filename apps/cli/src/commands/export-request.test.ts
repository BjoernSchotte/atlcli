import { describe, expect, test } from "bun:test";
import { parseArgs } from "@atlcli/core";
import {
  buildExportScope,
  ExportRequestError,
  MAX_FOLDERS_LIMIT,
  MAX_PAGES_LIMIT,
  parseExportRequest,
  type ParsedExportRequest,
} from "./export-request.js";

/**
 * Table-driven, pure tests for the scope/label/completeness flag parser — no CLI
 * process spawn, no network. `parseArgs` (the real CLI tokenizer) turns argv into
 * the `{ _, flags }` shape the handler passes in, so these cases exercise the
 * exact flag semantics (including `--space`/`--max-depth` valueless edges).
 */
function parse(argv: string[]): ParsedExportRequest {
  const { _, flags } = parseArgs(argv);
  return parseExportRequest(_[0], flags);
}

describe("parseExportRequest — valid combinations", () => {
  const cases: Array<{
    name: string;
    argv: string[];
    expect: Partial<ParsedExportRequest>;
  }> = [
    {
      name: "bare page id (TypeScript default)",
      argv: ["12345"],
      expect: { scopeKind: "page", engine: "ts", pageRef: "12345" },
    },
    {
      name: "page id with --engine ts",
      argv: ["12345", "--engine", "ts"],
      expect: { scopeKind: "page", engine: "ts", pageRef: "12345" },
    },
    {
      name: "SPACE:Title page ref",
      argv: ["DOCS:Architecture", "--engine", "ts"],
      expect: { scopeKind: "page", pageRef: "DOCS:Architecture" },
    },
    {
      name: "--scope tree",
      argv: ["12345", "--scope", "tree", "--engine", "ts"],
      expect: { scopeKind: "tree", pageRef: "12345", includeRoot: true },
    },
    {
      name: "--include-children alias (ts)",
      argv: ["12345", "--include-children", "--engine", "ts"],
      expect: { scopeKind: "tree", usedIncludeChildrenAlias: true },
    },
    {
      name: "--include-children alias with implicit TypeScript engine",
      argv: ["12345", "--include-children"],
      expect: { scopeKind: "tree", engine: "ts", usedIncludeChildrenAlias: true },
    },
    {
      name: "--scope space --space",
      argv: ["--scope", "space", "--space", "DOCSY", "--engine", "ts"],
      expect: { scopeKind: "space", spaceKey: "DOCSY" },
    },
    {
      name: "--space implies space scope",
      argv: ["--space", "DOCSY", "--engine", "ts"],
      expect: { scopeKind: "space", spaceKey: "DOCSY" },
    },
    {
      name: "tree with max-depth + max-pages",
      argv: ["12345", "--scope", "tree", "--engine", "ts", "--max-depth", "3", "--max-pages", "100"],
      expect: { scopeKind: "tree", maxDepth: 3, maxPages: 100 },
    },
    {
      name: "max-depth 0 is valid (root only)",
      argv: ["12345", "--scope", "tree", "--engine", "ts", "--max-depth", "0"],
      expect: { scopeKind: "tree", maxDepth: 0 },
    },
    {
      name: "tree with max-folders",
      argv: ["12345", "--scope", "tree", "--engine", "ts", "--max-folders", "50"],
      expect: { scopeKind: "tree", maxFolders: 50 },
    },
    {
      name: "space with max-folders",
      argv: ["--scope", "space", "--space", "DOCSY", "--engine", "ts", "--max-folders", "300"],
      expect: { scopeKind: "space", maxFolders: 300 },
    },
    {
      name: "tree with label include + exclude",
      argv: [
        "12345", "--scope", "tree", "--engine", "ts",
        "--label-include", "a,b", "--label-exclude", "c",
      ],
      expect: { scopeKind: "tree", labels: { include: ["a", "b"], exclude: ["c"] } },
    },
    {
      name: "label dedupe (case-sensitive)",
      argv: ["12345", "--scope", "tree", "--engine", "ts", "--label-include", "a,a,b,A"],
      expect: { labels: { include: ["a", "b", "A"] } },
    },
    {
      name: "label list with embedded spaces trims entries",
      argv: ["12345", "--scope", "tree", "--engine", "ts", "--label-include", "a, b"],
      expect: { labels: { include: ["a", "b"] } },
    },
    {
      name: "repeated label flags accumulate",
      argv: [
        "12345", "--scope", "tree", "--engine", "ts",
        "--label-include", "a", "--label-include", "b",
      ],
      expect: { labels: { include: ["a", "b"] } },
    },
    {
      name: "exclude mode page-only",
      argv: [
        "12345", "--scope", "tree", "--engine", "ts",
        "--label-exclude", "x", "--label-exclude-mode", "page-only",
      ],
      expect: { labels: { exclude: ["x"], excludeMode: "page-only" } },
    },
    {
      name: "completeness partial",
      argv: ["12345", "--scope", "tree", "--engine", "ts", "--completeness", "partial"],
      expect: { completenessMode: "partial" },
    },
    {
      name: "completeness defaults to strict",
      argv: ["12345", "--scope", "tree", "--engine", "ts"],
      expect: { completenessMode: "strict" },
    },
    {
      name: "space with max-depth is allowed",
      argv: ["--scope", "space", "--space", "DOCSY", "--engine", "ts", "--max-depth", "2"],
      expect: { scopeKind: "space", maxDepth: 2 },
    },
  ];

  for (const c of cases) {
    test(c.name, () => {
      const result = parse(c.argv);
      expect(result).toMatchObject(c.expect as Record<string, unknown>);
    });
  }
});

describe("parseExportRequest — rejected combinations", () => {
  const cases: Array<{ name: string; argv: string[]; match: RegExp }> = [
    { name: "no page reference (page scope)", argv: [], match: /page reference is required/i },
    { name: "tree without page ref", argv: ["--scope", "tree", "--engine", "ts"], match: /--scope tree requires a page reference/i },
    { name: "space without --space", argv: ["--scope", "space", "--engine", "ts"], match: /--scope space requires --space/i },
    {
      name: "space with positional page ref",
      argv: ["--scope", "space", "--space", "DOCSY", "12345", "--engine", "ts"],
      match: /no positional page reference/i,
    },
    {
      name: "--space with positional page ref (implied space)",
      argv: ["--space", "DOCSY", "12345", "--engine", "ts"],
      match: /no positional page reference/i,
    },
    {
      name: "--space with --scope page",
      argv: ["12345", "--scope", "page", "--space", "DOCSY", "--engine", "ts"],
      match: /--space implies --scope space/i,
    },
    {
      name: "--include-children with --scope page",
      argv: ["12345", "--include-children", "--scope", "page", "--engine", "ts"],
      match: /deprecated alias for --scope tree/i,
    },
    { name: "max-pages 0", argv: ["12345", "--scope", "tree", "--engine", "ts", "--max-pages", "0"], match: /at least 1/i },
    { name: "max-depth negative (valueless)", argv: ["12345", "--scope", "tree", "--engine", "ts", "--max-depth", "-1"], match: /requires a non-negative integer/i },
    { name: "max-depth non-numeric", argv: ["12345", "--scope", "tree", "--engine", "ts", "--max-depth", "abc"], match: /must be a non-negative integer/i },
    {
      name: "max-pages absurd",
      argv: ["12345", "--scope", "tree", "--engine", "ts", "--max-pages", String(MAX_PAGES_LIMIT + 1)],
      match: /must not exceed/i,
    },
    { name: "max-folders 0", argv: ["12345", "--scope", "tree", "--engine", "ts", "--max-folders", "0"], match: /at least 1/i },
    { name: "max-folders non-numeric", argv: ["12345", "--scope", "tree", "--engine", "ts", "--max-folders", "many"], match: /must be a positive integer/i },
    {
      name: "max-folders absurd",
      argv: ["12345", "--scope", "tree", "--engine", "ts", "--max-folders", String(MAX_FOLDERS_LIMIT + 1)],
      match: /must not exceed/i,
    },
    { name: "max-folders with page scope", argv: ["12345", "--scope", "page", "--engine", "ts", "--max-folders", "5"], match: /only valid with --scope tree or --scope space/i },
    { name: "label empty entry (double comma)", argv: ["12345", "--scope", "tree", "--engine", "ts", "--label-include", "a,,b"], match: /empty label entry/i },
    { name: "label trailing comma", argv: ["12345", "--scope", "tree", "--engine", "ts", "--label-exclude", "a,"], match: /empty label entry/i },
    { name: "unknown scope", argv: ["12345", "--scope", "foo", "--engine", "ts"], match: /Unknown --scope/i },
    { name: "unknown engine", argv: ["12345", "--engine", "java"], match: /Unknown --engine/i },
    // `python` must NOT reach the generic "Unknown --engine" branch above: the
    // person typing it is migrating off the removed exporter and needs to be
    // told what happened to it, not which values are legal.
    { name: "removed engine: python", argv: ["12345", "--engine", "python"], match: /Python DOCX exporter has been removed/i },
    { name: "removed engine names the replacement", argv: ["12345", "--engine", "python"], match: /TypeScript DOCX engine is the default/i },
    { name: "removed engine names the template migration", argv: ["12345", "--engine", "python"], match: /\$scroll\.\* placeholders/i },
    { name: "max-depth with page scope", argv: ["12345", "--scope", "page", "--engine", "ts", "--max-depth", "3"], match: /only valid with --scope tree or --scope space/i },
    { name: "labels with page scope", argv: ["12345", "--scope", "page", "--engine", "ts", "--label-include", "a"], match: /only valid with --scope tree or --scope space/i },
    { name: "completeness with page scope", argv: ["12345", "--scope", "page", "--engine", "ts", "--completeness", "partial"], match: /only valid with --scope tree or --scope space/i },
    { name: "exclude-mode without exclude", argv: ["12345", "--scope", "tree", "--engine", "ts", "--label-exclude-mode", "page-only"], match: /no effect without --label-exclude/i },
    { name: "unknown exclude-mode", argv: ["12345", "--scope", "tree", "--engine", "ts", "--label-exclude", "x", "--label-exclude-mode", "bogus"], match: /Unknown --label-exclude-mode/i },
    { name: "unknown completeness", argv: ["12345", "--scope", "tree", "--engine", "ts", "--completeness", "bogus"], match: /Unknown --completeness/i },
    { name: "--space without value", argv: ["--scope", "space", "--engine", "ts", "--space"], match: /--space requires a space key/i },
  ];

  for (const c of cases) {
    test(c.name, () => {
      expect(() => parse(c.argv)).toThrow(ExportRequestError);
      try {
        parse(c.argv);
      } catch (error) {
        expect((error as Error).message).toMatch(c.match);
      }
    });
  }
});

describe("buildExportScope — the single ExportScope construction site", () => {
  test("page → page scope", () => {
    const req = parse(["12345", "--engine", "ts"]);
    expect(buildExportScope(req, "12345")).toEqual({ kind: "page", pageId: "12345" });
  });

  test("tree → tree scope with includeRoot + maxDepth", () => {
    const req = parse(["12345", "--scope", "tree", "--engine", "ts", "--max-depth", "4"]);
    expect(buildExportScope(req, "999")).toEqual({
      kind: "tree",
      rootPageId: "999",
      includeRoot: true,
      maxDepth: 4,
    });
  });

  test("space → tree scope rooted at the resolved homepage id", () => {
    const req = parse(["--scope", "space", "--space", "DOCSY", "--engine", "ts"]);
    expect(buildExportScope(req, "homepage-77")).toEqual({
      kind: "tree",
      rootPageId: "homepage-77",
      includeRoot: true,
    });
  });
});
