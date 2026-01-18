/**
 * Hierarchy utilities for nested directory structure.
 *
 * Maps Confluence page/folder hierarchy to local directory structure
 * using the "index pattern":
 *
 * Confluence:
 *   Folder (id: 50)
 *     └── Parent Page (id: 100)
 *           └── Child Page (id: 101)
 *                 └── Grandchild Page (id: 102)
 *
 * Local (index pattern):
 *   ./my-folder/
 *     └── index.md (type: folder)
 *     └── parent-page/
 *           └── index.md (parent content)
 *           └── child-page/
 *                 └── index.md (child content)
 *                 └── grandchild-page.md (leaf page)
 *
 * Rules:
 * - Folders always use: {slug}/index.md (with type: folder frontmatter)
 * - Pages with children use: {slug}/index.md
 * - Leaf pages (no children) use: {slug}.md
 * - When a leaf page gains children, transform {slug}.md → {slug}/index.md
 */

import { join, dirname, basename, extname, relative, resolve } from "path";
import { mkdir, rename, rmdir, readdir } from "fs/promises";
import { existsSync } from "fs";
import { slugifyTitle } from "./atlcli-dir.js";

/** Content type for hierarchy computation */
export type HierarchyContentType = "page" | "folder";

/** Page info needed for hierarchy computation */
export interface PageHierarchyInfo {
  id: string;
  title: string;
  parentId: string | null;
  ancestors: string[]; // Array of ancestor IDs from root to parent
  /** Content type: page or folder (defaults to "page") */
  contentType?: HierarchyContentType;
  /** Whether this item has children (folders/pages with children use index.md) */
  hasChildren?: boolean;
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
  /** Whether this is an index file (used for pages with children or folders) */
  isIndex: boolean;
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
 * Compute the file path for a page/folder based on its ancestors.
 *
 * Index Pattern Rules:
 * - Folders always use: `{slug}/index.md`
 * - Pages with children use: `{slug}/index.md`
 * - Leaf pages (no children) use: `{slug}.md`
 * - Child pages go in: `{parent-slug}/` directory
 * - Root items (no parent in scope) go in sync root
 * - If rootAncestorId is set, children of that item go in sync root
 *
 * @param page - Page info with title, parentId, ancestors, contentType, hasChildren
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
  const contentType = page.contentType ?? "page";
  const hasChildren = page.hasChildren ?? false;

  // Determine if this should be an index file
  // Folders and pages with children use index.md
  const isIndex = contentType === "folder" || hasChildren;

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

  // For index pattern: if isIndex, add slug to directory path
  if (isIndex) {
    dirParts.push(slug);
  }

  const directory = dirParts.join("/");

  // Generate filename: index.md for folders/parents, {slug}.md for leaves
  let filename = isIndex ? "index.md" : `${slug}.md`;
  let relativePath = directory ? `${directory}/${filename}` : filename;
  let counter = 2;

  while (existingPaths.has(relativePath)) {
    if (isIndex) {
      // For index files, modify the directory instead
      const newSlug = `${slug}-${counter}`;
      const newDirParts = dirParts.slice(0, -1);
      newDirParts.push(newSlug);
      const newDir = newDirParts.join("/");
      relativePath = newDir ? `${newDir}/index.md` : "index.md";
    } else {
      filename = `${slug}-${counter}.md`;
      relativePath = directory ? `${directory}/${filename}` : filename;
    }
    counter++;
  }

  return {
    relativePath,
    directory,
    filename,
    slug,
    isIndex,
  };
}

/**
 * Parse a file path to extract hierarchy information.
 *
 * Handles both index pattern and legacy sibling pattern:
 * - Index pattern: `parent/index.md` → slug is "parent"
 * - Index pattern: `parent/child.md` → slug is "child", parent is "parent"
 * - Legacy pattern: `parent.md` → slug is "parent"
 *
 * @param relativePath - Relative path from root dir (e.g., "parent/child.md")
 * @returns Extracted hierarchy info
 */
export function parseFilePath(relativePath: string): {
  slug: string;
  parentSlug: string | null;
  ancestorSlugs: string[];
  isIndex: boolean;
} {
  const parts = relativePath.split("/");
  const filename = parts[parts.length - 1];
  const isIndex = filename === "index.md";

  // For index files, the slug comes from the directory name
  // For regular files, the slug comes from the filename
  let slug: string;
  let ancestorSlugs: string[];

  if (isIndex) {
    if (parts.length === 1) {
      // Edge case: just "index.md" at root
      slug = "index";
      ancestorSlugs = [];
    } else {
      // index.md - slug is the parent directory
      slug = parts[parts.length - 2];
      ancestorSlugs = parts.slice(0, -2);
    }
  } else {
    slug = basename(filename, extname(filename));
    ancestorSlugs = parts.slice(0, -1);
  }

  if (ancestorSlugs.length === 0) {
    // Root level item
    return {
      slug,
      parentSlug: null,
      ancestorSlugs: [],
      isIndex,
    };
  }

  const parentSlug = ancestorSlugs[ancestorSlugs.length - 1];

  return {
    slug,
    parentSlug,
    ancestorSlugs,
    isIndex,
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
 *
 * With index pattern:
 * - If parent is `parent/index.md`, children go in `parent/`
 * - If parent is `parent.md` (legacy), children go in `parent/`
 *
 * @param parentPath - Parent file's relative path (e.g., "parent/index.md" or "parent.md")
 * @returns Directory path for children (e.g., "parent/")
 */
export function getChildDirectory(parentPath: string): string {
  const parsed = parseFilePath(parentPath);

  if (parsed.isIndex) {
    // For index.md, children go in the same directory
    return dirname(parentPath);
  }

  // Legacy: for regular files, children go in a directory named after the file
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

// ============ Pattern Migration Utilities ============

/**
 * Detect if a path uses the sibling pattern (needs migration to index pattern).
 *
 * Sibling pattern indicators:
 * - File `parent.md` exists AND directory `parent/` exists with children
 *
 * @param relativePath - Relative path to check (e.g., "parent.md")
 * @param existingPaths - Set of all existing paths in the sync
 * @returns True if this path uses sibling pattern and needs migration
 */
export function usesSiblingPattern(
  relativePath: string,
  existingPaths: Set<string>
): boolean {
  const parsed = parseFilePath(relativePath);

  // Already using index pattern
  if (parsed.isIndex) {
    return false;
  }

  // Check if there's a corresponding directory with children
  const potentialChildDir = getChildDirectory(relativePath);

  for (const path of existingPaths) {
    if (path.startsWith(potentialChildDir + "/")) {
      // Found a child in the sibling directory - this uses sibling pattern
      return true;
    }
  }

  return false;
}

/**
 * Convert a path from sibling pattern to index pattern.
 *
 * Sibling: `parent.md` → Index: `parent/index.md`
 *
 * @param relativePath - Current sibling-pattern path (e.g., "parent.md")
 * @returns New index-pattern path (e.g., "parent/index.md")
 */
export function siblingToIndexPath(relativePath: string): string {
  const dir = dirname(relativePath);
  const slug = basename(relativePath, extname(relativePath));

  if (dir === ".") {
    return `${slug}/index.md`;
  }

  return `${dir}/${slug}/index.md`;
}

/**
 * Detect files that need migration from sibling to index pattern.
 *
 * @param existingPaths - Set of all existing paths in the sync
 * @returns Array of paths that need migration, with their new paths
 */
export function detectSiblingPatternMigrations(
  existingPaths: Set<string>
): Array<{ oldPath: string; newPath: string }> {
  const migrations: Array<{ oldPath: string; newPath: string }> = [];

  for (const path of existingPaths) {
    if (usesSiblingPattern(path, existingPaths)) {
      migrations.push({
        oldPath: path,
        newPath: siblingToIndexPath(path),
      });
    }
  }

  return migrations;
}

/**
 * Migrate a page from sibling pattern to index pattern.
 * Moves `{slug}.md` to `{slug}/index.md`.
 *
 * @param rootDir - Root sync directory
 * @param relativePath - Current sibling-pattern path
 * @returns New path after migration
 */
export async function migrateSiblingToIndex(
  rootDir: string,
  relativePath: string
): Promise<string> {
  const newPath = siblingToIndexPath(relativePath);
  await moveFile(rootDir, relativePath, newPath);
  return newPath;
}
