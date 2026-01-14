/**
 * Ignore pattern utility for .atlcliignore and .gitignore support.
 * Uses gitignore-style pattern matching.
 */

import ignore, { type Ignore } from "ignore";

export type { Ignore };
import { readFile } from "node:fs/promises";
import { join } from "node:path";

/** Result of loading ignore patterns */
export interface IgnoreResult {
  /** The ignore instance for pattern matching */
  ignore: Ignore;
  /** Whether .atlcliignore was found */
  hasAtlcliIgnore: boolean;
  /** Whether .gitignore was found */
  hasGitIgnore: boolean;
  /** Number of patterns loaded */
  patternCount: number;
}

/**
 * Load ignore patterns from .atlcliignore and .gitignore files.
 * Patterns from both files are merged, with .atlcliignore taking precedence.
 *
 * @param dir - The directory to look for ignore files in
 * @returns IgnoreResult with the ignore instance and metadata
 */
export async function loadIgnorePatterns(dir: string): Promise<IgnoreResult> {
  const ig = ignore();
  let hasAtlcliIgnore = false;
  let hasGitIgnore = false;
  let patternCount = 0;

  // Always ignore .atlcli directory and common non-markdown files
  const defaultPatterns = [
    ".atlcli/",
    "*.meta.json",
    "*.base",
    ".git/",
    "node_modules/",
  ];
  ig.add(defaultPatterns);
  patternCount += defaultPatterns.length;

  // Load .gitignore first (lower precedence)
  try {
    const gitignorePath = join(dir, ".gitignore");
    const gitignoreContent = await readFile(gitignorePath, "utf-8");
    const patterns = parseIgnoreFile(gitignoreContent);
    if (patterns.length > 0) {
      ig.add(patterns);
      patternCount += patterns.length;
      hasGitIgnore = true;
    }
  } catch {
    // .gitignore doesn't exist or can't be read, that's fine
  }

  // Load .atlcliignore second (higher precedence, can override .gitignore)
  try {
    const atlcliIgnorePath = join(dir, ".atlcliignore");
    const atlcliIgnoreContent = await readFile(atlcliIgnorePath, "utf-8");
    const patterns = parseIgnoreFile(atlcliIgnoreContent);
    if (patterns.length > 0) {
      ig.add(patterns);
      patternCount += patterns.length;
      hasAtlcliIgnore = true;
    }
  } catch {
    // .atlcliignore doesn't exist or can't be read, that's fine
  }

  return {
    ignore: ig,
    hasAtlcliIgnore,
    hasGitIgnore,
    patternCount,
  };
}

/**
 * Parse an ignore file content into an array of patterns.
 * Handles comments and empty lines.
 *
 * @param content - The file content to parse
 * @returns Array of patterns (comments and empty lines removed)
 */
export function parseIgnoreFile(content: string): string[] {
  return content
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => {
      // Skip empty lines
      if (!line) return false;
      // Skip comments (but not negations like !pattern)
      if (line.startsWith("#")) return false;
      return true;
    });
}

/**
 * Check if a path should be ignored.
 *
 * @param ig - The Ignore instance (or null if no patterns loaded)
 * @param relativePath - Path relative to the sync root
 * @returns true if the path should be ignored
 */
export function shouldIgnore(ig: Ignore | null, relativePath: string): boolean {
  if (!ig) return false;

  // Normalize path separators and remove leading ./
  const normalized = relativePath
    .replace(/\\/g, "/")
    .replace(/^\.\//, "");

  return ig.ignores(normalized);
}

/**
 * Filter an array of paths, removing ignored ones.
 *
 * @param ig - The Ignore instance (or null if no patterns loaded)
 * @param paths - Array of paths relative to sync root
 * @returns Filtered array with ignored paths removed
 */
export function filterIgnored(ig: Ignore | null, paths: string[]): string[] {
  if (!ig) return paths;

  return paths.filter((p) => !shouldIgnore(ig, p));
}

/**
 * Create a simple ignore instance from an array of patterns.
 * Useful for testing or programmatic pattern creation.
 *
 * @param patterns - Array of gitignore-style patterns
 * @returns Ignore instance
 */
export function createIgnore(patterns: string[]): Ignore {
  const ig = ignore();
  ig.add(patterns);
  return ig;
}
