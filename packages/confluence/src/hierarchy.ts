/**
 * Hierarchy utilities for nested directory structure.
 *
 * Maps Confluence page hierarchy to local directory structure:
 *
 * Confluence:
 *   Parent Page (id: 100)
 *     └── Child Page (id: 101)
 *           └── Grandchild Page (id: 102)
 *
 * Local:
 *   ./parent-page.md
 *   ./parent-page/
 *     └── child-page.md
 *     └── child-page/
 *           └── grandchild-page.md
 */

import { join, dirname, basename, extname, relative, resolve } from "path";
import { mkdir, rename, rmdir, readdir } from "fs/promises";
import { existsSync } from "fs";
import { slugifyTitle } from "./atlcli-dir.js";

/** Page info needed for hierarchy computation */
export interface PageHierarchyInfo {
  id: string;
  title: string;
  parentId: string | null;
  ancestors: string[]; // Array of ancestor IDs from root to parent
}

/** Computed file path info */
export interface ComputedPath {
  /** Relative path from root dir */
  relativePath: string;
  /** Directory containing the file */
  directory: string;
  /** Filename (with .md extension) */
  filename: string;
  /** Slug used for the file/directory */
  slug: string;
}

/** Options for computing file paths */
export interface ComputeFilePathOptions {
  /** Set of paths already in use (for uniqueness) */
  existingPaths?: Set<string>;
  /**
   * Root ancestor ID to skip in path computation.
   * When set, this ancestor and any ancestors before it are not included
   * in the directory path. Used to flatten space home page children.
   */
  rootAncestorId?: string;
}

/**
 * Compute the file path for a page based on its ancestors.
 *
 * Rules:
 * - Page file: `{slug}.md`
 * - Child pages go in: `{parent-slug}/` directory
 * - Root pages (no parent in scope) go in sync root
 * - If rootAncestorId is set, children of that page go in sync root
 *
 * @param page - Page info with title, parentId, and ancestors
 * @param ancestorTitles - Map of ancestor ID to title (for slug generation)
 * @param options - Optional settings for path computation
 * @returns Computed path info
 */
export function computeFilePath(
  page: PageHierarchyInfo,
  ancestorTitles: Map<string, string>,
  options: ComputeFilePathOptions | Set<string> = {}
): ComputedPath {
  // Support legacy signature: computeFilePath(page, titles, existingPaths)
  const opts: ComputeFilePathOptions =
    options instanceof Set ? { existingPaths: options } : options;
  const existingPaths = opts.existingPaths ?? new Set<string>();
  const rootAncestorId = opts.rootAncestorId;

  const slug = slugifyTitle(page.title) || "page";

  // Build directory path from ancestors
  const dirParts: string[] = [];

  // Find the index to start from (skip root ancestor and its ancestors)
  let startIndex = 0;
  if (rootAncestorId) {
    const rootIndex = page.ancestors.indexOf(rootAncestorId);
    if (rootIndex !== -1) {
      // Start after the root ancestor
      startIndex = rootIndex + 1;
    }
  }

  for (let i = startIndex; i < page.ancestors.length; i++) {
    const ancestorId = page.ancestors[i];
    const ancestorTitle = ancestorTitles.get(ancestorId);
    if (ancestorTitle) {
      const ancestorSlug = slugifyTitle(ancestorTitle) || "page";
      dirParts.push(ancestorSlug);
    }
  }

  const directory = dirParts.join("/");

  // Generate unique filename
  let filename = `${slug}.md`;
  let relativePath = directory ? `${directory}/${filename}` : filename;
  let counter = 2;

  while (existingPaths.has(relativePath)) {
    filename = `${slug}-${counter}.md`;
    relativePath = directory ? `${directory}/${filename}` : filename;
    counter++;
  }

  return {
    relativePath,
    directory,
    filename,
    slug,
  };
}

/**
 * Parse a file path to extract hierarchy information.
 *
 * @param relativePath - Relative path from root dir (e.g., "parent/child.md")
 * @returns Extracted hierarchy info
 */
export function parseFilePath(relativePath: string): {
  slug: string;
  parentSlug: string | null;
  ancestorSlugs: string[];
} {
  const parts = relativePath.split("/");
  const filename = parts[parts.length - 1];
  const slug = basename(filename, extname(filename));

  if (parts.length === 1) {
    // Root level file
    return {
      slug,
      parentSlug: null,
      ancestorSlugs: [],
    };
  }

  // Extract ancestor slugs from directory path
  const ancestorSlugs = parts.slice(0, -1);
  const parentSlug = ancestorSlugs[ancestorSlugs.length - 1];

  return {
    slug,
    parentSlug,
    ancestorSlugs,
  };
}

/**
 * Move a file to a new location, creating directories as needed.
 *
 * @param rootDir - Root sync directory
 * @param oldPath - Old relative path
 * @param newPath - New relative path
 */
export async function moveFile(
  rootDir: string,
  oldPath: string,
  newPath: string
): Promise<void> {
  const oldAbsolute = join(rootDir, oldPath);
  const newAbsolute = join(rootDir, newPath);

  if (!existsSync(oldAbsolute)) {
    throw new Error(`Source file does not exist: ${oldPath}`);
  }

  // Create target directory
  await mkdir(dirname(newAbsolute), { recursive: true });

  // Move the file
  await rename(oldAbsolute, newAbsolute);

  // Try to clean up empty parent directories
  await cleanupEmptyDirs(rootDir, dirname(oldAbsolute));
}

/**
 * Remove empty directories up to (but not including) the root.
 */
async function cleanupEmptyDirs(rootDir: string, dir: string): Promise<void> {
  const root = resolve(rootDir);
  let current = resolve(dir);

  while (current !== root && current.startsWith(root)) {
    try {
      // Check if directory is empty before trying to remove
      const entries = await readdir(current);
      if (entries.length > 0) {
        break; // Directory not empty
      }
      // rmdir only removes empty directories
      await rmdir(current);
      current = dirname(current);
    } catch {
      // Directory doesn't exist or other error - stop cleanup
      break;
    }
  }
}

/**
 * Compute the directory path for a page's children.
 * Children go in a directory named after the parent's slug.
 *
 * @param parentPath - Parent file's relative path (e.g., "parent.md")
 * @returns Directory path for children (e.g., "parent/")
 */
export function getChildDirectory(parentPath: string): string {
  const dir = dirname(parentPath);
  const slug = basename(parentPath, extname(parentPath));

  return dir === "." ? slug : `${dir}/${slug}`;
}

/** Options for building path map */
export interface BuildPathMapOptions {
  /** Set of paths already in use (for uniqueness) */
  existingPaths?: Set<string>;
  /**
   * Root ancestor ID to skip in path computation.
   * Children of this page will be placed at the root level.
   */
  rootAncestorId?: string;
}

/**
 * Build a map of page IDs to their computed file paths.
 * Processes pages in hierarchical order (parents before children).
 *
 * @param pages - Array of pages with hierarchy info
 * @param options - Options for path computation (or legacy Set<string> for existingPaths)
 * @returns Map of page ID to computed path
 */
export function buildPathMap(
  pages: PageHierarchyInfo[],
  options: BuildPathMapOptions | Set<string> = {}
): Map<string, ComputedPath> {
  // Support legacy signature: buildPathMap(pages, existingPaths)
  const opts: BuildPathMapOptions =
    options instanceof Set ? { existingPaths: options } : options;
  const existingPaths = opts.existingPaths ?? new Set<string>();
  const rootAncestorId = opts.rootAncestorId;

  // Build title map for ancestor lookups
  const titleMap = new Map<string, string>();
  for (const page of pages) {
    titleMap.set(page.id, page.title);
  }

  // Sort pages by ancestor depth (parents first)
  const sorted = [...pages].sort((a, b) => a.ancestors.length - b.ancestors.length);

  // Build path map
  const pathMap = new Map<string, ComputedPath>();
  const usedPaths = new Set(existingPaths);

  for (const page of sorted) {
    const computed = computeFilePath(page, titleMap, {
      existingPaths: usedPaths,
      rootAncestorId,
    });
    pathMap.set(page.id, computed);
    usedPaths.add(computed.relativePath);
  }

  return pathMap;
}

/**
 * Detect if a page has moved (parent changed) by comparing ancestors.
 *
 * @param oldAncestors - Previous ancestor IDs
 * @param newAncestors - Current ancestor IDs
 * @returns True if the page has moved
 */
export function hasPageMoved(
  oldAncestors: string[],
  newAncestors: string[]
): boolean {
  if (oldAncestors.length !== newAncestors.length) {
    return true;
  }

  for (let i = 0; i < oldAncestors.length; i++) {
    if (oldAncestors[i] !== newAncestors[i]) {
      return true;
    }
  }

  return false;
}

/**
 * Validate that a file path matches expected hierarchy.
 * Used when pushing to ensure local structure matches what we expect.
 *
 * @param relativePath - File's relative path
 * @param expectedParentSlug - Expected parent directory name (or null for root)
 * @returns True if path matches expected hierarchy
 */
export function validatePathHierarchy(
  relativePath: string,
  expectedParentSlug: string | null
): boolean {
  const { parentSlug } = parseFilePath(relativePath);
  return parentSlug === expectedParentSlug;
}
