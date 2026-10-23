import { existsSync, statSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve, dirname } from "node:path";
import {
  extractLinks,
  resolveRelativePath,
  isMarkdownPath,
  getPathWithoutAnchor,
  type MarkdownLink,
} from "./links.js";
import { parseFrontmatter } from "./frontmatter.js";
import {
  BLOCK_MACRO_RULES,
  MACRO_REGEX,
  SECTION_COLUMN_REGEX,
  TOC_PARAMETERS,
  parseMacroParams,
  splitMacroTitle,
} from "./macro-syntax.js";

/**
 * Parameters push drops for `:::toc` / `:::expand` / panels. `toc` keeps the
 * Confluence toc parameters; expand and the panels only take a title (the
 * Confluence expand macro has no "expanded" option).
 */
function unsupportedMacroParams(macro: string, raw: string | undefined): string[] {
  if (macro === "toc") {
    return parseMacroParams(raw)
      .filter(([key]) => !TOC_PARAMETERS.has(key.toLowerCase()))
      .map(([key]) => `Unsupported ":::toc" parameter "${key}" is ignored (supported: ${[...TOC_PARAMETERS.values()].join(", ")})`);
  }
  return parseMacroParams(splitMacroTitle(raw).params).map(
    ([key]) => `Unsupported ":::${macro}" parameter "${key}" is ignored (only a quoted title is supported)`,
  );
}
import type { AtlcliState } from "./atlcli-dir.js";
import type { SyncDbAdapter } from "./sync-db/types.js";

/** Severity of validation issues */
export type ValidationSeverity = "error" | "warning";

/** Validation issue codes */
export type ValidationCode =
  | "LINK_FILE_NOT_FOUND"
  | "LINK_UNTRACKED_PAGE"
  | "LINK_PAGE_DELETED"
  | "MACRO_UNCLOSED"
  | "MACRO_INVALID_PARAMS"
  | "PAGE_SIZE_EXCEEDED"
  | "FOLDER_EMPTY"
  | "FOLDER_MISSING_INDEX";

/** A single validation issue */
export interface ValidationIssue {
  severity: ValidationSeverity;
  code: ValidationCode;
  message: string;
  file: string;
  line?: number;
  column?: number;
}

/** Validation result for a single file */
export interface FileValidationResult {
  path: string;
  issues: ValidationIssue[];
  hasErrors: boolean;
  hasWarnings: boolean;
}

/** Overall validation result */
export interface ValidationResult {
  files: FileValidationResult[];
  filesChecked: number;
  totalErrors: number;
  totalWarnings: number;
  passed: boolean;
}

/** Validation options */
export interface ValidationOptions {
  checkBrokenLinks?: boolean;
  checkMacroSyntax?: boolean;
  checkPageSize?: boolean;
  maxPageSizeKb?: number;
  /** Database adapter for enhanced link validation (resolves paths to page IDs) */
  adapter?: SyncDbAdapter;
}

const DEFAULT_OPTIONS: ValidationOptions = {
  checkBrokenLinks: true,
  checkMacroSyntax: true,
  checkPageSize: true,
  maxPageSizeKb: 500,
};

/**
 * Validate a single markdown file.
 */
export function validateFile(
  filePath: string,
  content: string,
  state: AtlcliState | null,
  atlcliDir: string | null,
  options: ValidationOptions = {}
): FileValidationResult {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const issues: ValidationIssue[] = [];
  const relPath = atlcliDir ? relative(atlcliDir, filePath) : filePath;

  // Check broken links
  if (opts.checkBrokenLinks) {
    const linkIssues = validateLinks(filePath, content, state, atlcliDir, opts.adapter);
    issues.push(...linkIssues);
  }

  // Check macro syntax
  if (opts.checkMacroSyntax) {
    const macroIssues = validateMacros(content, relPath);
    issues.push(...macroIssues);
  }

  // Check page size
  if (opts.checkPageSize && opts.maxPageSizeKb) {
    const sizeKb = Buffer.byteLength(content, "utf-8") / 1024;
    if (sizeKb > opts.maxPageSizeKb) {
      issues.push({
        severity: "warning",
        code: "PAGE_SIZE_EXCEEDED",
        message: `Page size (${Math.round(sizeKb)}KB) exceeds ${opts.maxPageSizeKb}KB limit`,
        file: relPath,
      });
    }
  }

  return {
    path: relPath,
    issues,
    hasErrors: issues.some((i) => i.severity === "error"),
    hasWarnings: issues.some((i) => i.severity === "warning"),
  };
}

/**
 * Validate all markdown files in a directory.
 */
export async function validateDirectory(
  dir: string,
  state: AtlcliState | null,
  atlcliDir: string | null,
  options: ValidationOptions = {}
): Promise<ValidationResult> {
  const files = collectMarkdownFiles(dir);
  const results: FileValidationResult[] = [];

  for (const filePath of files) {
    const content = readFileSync(filePath, "utf-8");
    const result = validateFile(filePath, content, state, atlcliDir, options);
    results.push(result);
  }

  const totalErrors = results.reduce(
    (sum, r) => sum + r.issues.filter((i) => i.severity === "error").length,
    0
  );
  const totalWarnings = results.reduce(
    (sum, r) => sum + r.issues.filter((i) => i.severity === "warning").length,
    0
  );

  return {
    files: results,
    filesChecked: files.length,
    totalErrors,
    totalWarnings,
    passed: totalErrors === 0,
  };
}

/**
 * Validate links in a file.
 */
function validateLinks(
  filePath: string,
  content: string,
  state: AtlcliState | null,
  atlcliDir: string | null,
  adapter?: SyncDbAdapter
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const links = extractLinks(content);
  const relPath = atlcliDir ? relative(atlcliDir, filePath) : filePath;
  const baseDir = atlcliDir || dirname(filePath);

  for (const link of links) {
    // Skip external and anchor-only links
    if (link.type === "external" || link.type === "anchor") {
      continue;
    }

    // Skip attachment links (validated separately)
    if (link.type === "attachment") {
      continue;
    }

    // Validate relative-path links
    if (link.type === "relative-path") {
      const issue = validateRelativeLink(link, filePath, baseDir, state, relPath, adapter);
      if (issue) {
        issues.push(issue);
      }
    }
  }

  return issues;
}

/**
 * Validate a relative path link.
 */
function validateRelativeLink(
  link: MarkdownLink,
  fromFile: string,
  baseDir: string,
  state: AtlcliState | null,
  relPath: string,
  _adapter?: SyncDbAdapter
): ValidationIssue | null {
  const targetPath = getPathWithoutAnchor(link.target);

  // Skip empty paths (anchor-only in disguise)
  if (!targetPath) {
    return null;
  }

  // Resolve the path
  const resolvedPath = resolveRelativePath(fromFile, targetPath);

  // Check if file exists
  if (!existsSync(resolvedPath)) {
    return {
      severity: "error",
      code: "LINK_FILE_NOT_FOUND",
      message: `Broken link to "${link.target}"`,
      file: relPath,
      line: link.line,
      column: link.column,
    };
  }

  // If it's not a markdown file, skip further checks
  if (!isMarkdownPath(resolvedPath)) {
    return null;
  }

  // Check if the target is tracked in state
  if (state) {
    const targetRelPath = relative(baseDir, resolvedPath);
    const pageId = state.pathIndex?.[targetRelPath];

    if (!pageId) {
      return {
        severity: "warning",
        code: "LINK_UNTRACKED_PAGE",
        message: `Link to untracked page "${link.target}"`,
        file: relPath,
        line: link.line,
        column: link.column,
      };
    }
  }

  return null;
}

/**
 * Validate Confluence macro syntax.
 */
export function validateMacros(
  content: string,
  filePath: string
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const lines = content.split("\n");
  const lineOf = (offset: number) => content.slice(0, offset).split("\n").length - 1;

  // Replay the converter: run the same macro regexes in the same order and
  // blank out every match, so later rules see what the converter sees.
  // `consumed` lines became macros; `rendered` lines are macro bodies that are
  // rendered as plain Markdown, where a `:::` line stays literal text.
  const consumed = new Set<number>();
  const rendered = new Set<number>();
  const markRendered = (from: number, text: string) => {
    if (!text) return;
    const first = lineOf(from);
    const count = text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
    for (let l = first; l < first + count; l++) rendered.add(l);
  };

  let working = content;
  for (const rule of BLOCK_MACRO_RULES) {
    working = working.replace(rule.regex, (match: string, ...args: unknown[]) => {
      const offset = args.find((a) => typeof a === "number") as number;
      const first = lineOf(offset);
      const last = first + match.split("\n").length - 1;
      for (let l = first; l <= last; l++) consumed.add(l);
      if (rule.regex === MACRO_REGEX) {
        const [macro, raw] = args as [string, string | undefined];
        for (const message of unsupportedMacroParams(macro, raw)) {
          issues.push({ severity: "warning", code: "MACRO_INVALID_PARAMS", message, file: filePath, line: first + 1 });
        }
      }
      const bodyStart = offset + match.indexOf("\n") + 1;
      if (rule.body !== undefined) {
        markRendered(bodyStart, String(args[rule.body - 1] ?? ""));
      } else if (rule.columns) {
        const body = String(args[1] ?? "");
        for (const column of body.matchAll(SECTION_COLUMN_REGEX)) {
          const columnStart = bodyStart + column.index! + column[0].indexOf("\n") + 1;
          markRendered(columnStart, column[2]);
        }
      }
      return match.replace(/[^\n]/g, " ");
    });
  }

  let fence: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fenceMatch = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (fenceMatch) {
      if (!fence) fence = fenceMatch[1][0];
      else if (fenceMatch[1][0] === fence) fence = null;
      continue;
    }
    if (fence) continue;

    const macroLine = line.match(/^ {0,3}:::(\S*)/);
    if (!macroLine || (consumed.has(i) && !rendered.has(i))) continue;

    const name = macroLine[1];
    const lineNum = i + 1;
    let message: string;
    if (rendered.has(i)) {
      message = `Nested macro line "${line.trim()}" is not supported here and is pushed as literal text`;
    } else if (name === "" && line.trim() !== ":::") {
      message = `Unsupported macro line "${line.trim()}": write ":::name" without a space (pushed as literal text)`;
    } else if (name === "") {
      message = `Unexpected macro close ":::" without matching open (pushed as literal text)`;
    } else if (name.endsWith("-end")) {
      message = `Unexpected ":::${name}" without matching ":::${name.slice(0, -4)}" (pushed as literal text)`;
    } else {
      message = `Unclosed or unsupported macro ":::${name}" starting at line ${lineNum} (pushed as literal text)`;
    }
    issues.push({ severity: "error", code: "MACRO_UNCLOSED", message, file: filePath, line: lineNum });
  }

  return issues;
}

/**
 * Collect all markdown files in a directory recursively.
 */
function collectMarkdownFiles(dir: string): string[] {
  const files: string[] = [];
  const absDir = resolve(dir);

  // Handle single file
  if (statSync(absDir).isFile()) {
    if (isMarkdownPath(absDir)) {
      return [absDir];
    }
    return [];
  }

  function walk(currentDir: string) {
    const entries = readdirSync(currentDir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = join(currentDir, entry.name);

      // Skip hidden directories and .atlcli
      if (entry.name.startsWith(".") || entry.name === "node_modules") {
        continue;
      }

      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile() && isMarkdownPath(entry.name)) {
        // Skip meta files
        if (entry.name.endsWith(".meta.json") || entry.name.endsWith(".base")) {
          continue;
        }
        files.push(fullPath);
      }
    }
  }

  walk(absDir);
  return files;
}

/**
 * Format validation result for human-readable output.
 */
export function formatValidationReport(result: ValidationResult): string {
  const lines: string[] = [];

  lines.push(`Checking ${result.filesChecked} files...\n`);

  // Group by file
  const filesWithIssues = result.files.filter((f) => f.issues.length > 0);

  for (const file of filesWithIssues) {
    lines.push(file.path);
    for (const issue of file.issues) {
      const loc = issue.line ? `line ${issue.line}` : "";
      const severity = issue.severity.toUpperCase();
      lines.push(`  ${loc}: ${severity} - ${issue.message} [${issue.code}]`);
    }
    lines.push("");
  }

  // Summary
  const passedCount = result.filesChecked - filesWithIssues.length;
  lines.push(
    `Summary: ${result.totalErrors} error${result.totalErrors !== 1 ? "s" : ""}, ` +
      `${result.totalWarnings} warning${result.totalWarnings !== 1 ? "s" : ""} ` +
      `in ${filesWithIssues.length} file${filesWithIssues.length !== 1 ? "s" : ""} ` +
      `(${passedCount} passed)`
  );

  return lines.join("\n");
}

/**
 * Validate folder structure in a directory.
 * Used by both `docs check` and `docs audit` commands.
 *
 * Checks for:
 * - FOLDER_EMPTY: Folders that contain no pages or subfolders
 * - FOLDER_MISSING_INDEX: Directories with .md files but no folder index.md
 */
export function validateFolders(dir: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const absDir = resolve(dir);

  // Collect all markdown files with relative paths
  const files = collectMarkdownFiles(absDir).map((f) => relative(absDir, f));

  // Find all index.md files with type: folder
  for (const file of files) {
    if (!file.endsWith("index.md")) continue;

    const fullPath = join(absDir, file);
    const content = readFileSync(fullPath, "utf-8");
    const { frontmatter } = parseFrontmatter(content);

    if (frontmatter?.type !== "folder") continue;

    // Check if folder has children
    const folderDir = dirname(fullPath);
    const entries = readdirSync(folderDir, { withFileTypes: true });
    const children = entries.filter(
      (e) =>
        e.name !== "index.md" &&
        !e.name.startsWith(".") &&
        (e.isDirectory() || (e.isFile() && isMarkdownPath(e.name)))
    );

    if (children.length === 0) {
      const title = frontmatter.title || dirname(file) || "root";
      issues.push({
        severity: "warning",
        code: "FOLDER_EMPTY",
        message: `Folder "${title}" has no children`,
        file,
        line: 1,
      });
    }
  }

  // Find directories with .md files but no index.md
  const dirsWithPages = new Set<string>();
  for (const file of files) {
    if (file.endsWith(".md") && !file.endsWith("index.md")) {
      const dir = dirname(file);
      if (dir !== ".") {
        dirsWithPages.add(dir);
      }
    }
  }

  for (const dirPath of dirsWithPages) {
    const indexPath = join(dirPath, "index.md");
    if (!files.includes(indexPath)) {
      issues.push({
        severity: "warning",
        code: "FOLDER_MISSING_INDEX",
        message: `Directory "${dirPath}" contains pages but has no folder index.md`,
        file: dirPath,
        line: 1,
      });
    }
  }

  return issues;
}
