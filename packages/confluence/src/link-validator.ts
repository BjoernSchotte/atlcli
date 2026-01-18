/**
 * Shared link validation module.
 *
 * Used by both:
 * - `wiki docs status --links` - quick check during sync workflow
 * - `audit wiki --broken-links` - comprehensive audit report
 *
 * @module link-validator
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { SyncDbAdapter, LinkRecord, PageRecord } from "./sync-db/types.js";
import { extractLinksFromMarkdownToRecords } from "./link-extractor-markdown.js";

// Re-export types for backwards compatibility
export { detectLinkChanges, detectLinkChangesBatch, type LinkChangeResult } from "./atlcli-dir.js";
export { type MarkdownLinkWithResolution } from "./link-extractor-markdown.js";

/**
 * Result of validating links for a single page.
 * Matches the spec interface for shared link validation.
 */
export interface LinkValidationResult {
  /** Page ID being validated */
  pageId: string;
  /** File path relative to root */
  pagePath: string;
  /** Link comparison results */
  links: {
    /** Links currently stored in sync.db */
    stored: LinkRecord[];
    /** Links extracted from current markdown file */
    current: LinkRecord[];
    /** New links not in database */
    added: LinkRecord[];
    /** Links in database but not in file */
    removed: LinkRecord[];
    /** Links to non-existent files */
    broken: LinkRecord[];
  };
}

/**
 * Summary of broken links across all pages.
 */
export interface BrokenLinkSummary {
  /** Total number of broken links */
  totalBroken: number;
  /** Broken links grouped by source page */
  bySourcePage: Map<string, LinkRecord[]>;
  /** Pages with broken links */
  pagesAffected: number;
}

/**
 * Get all broken links from the sync database.
 *
 * Used by `audit wiki --broken-links` for reporting.
 *
 * @param adapter - The sync database adapter
 * @returns Array of broken link records
 */
export async function getBrokenLinksFromDb(adapter: SyncDbAdapter): Promise<LinkRecord[]> {
  return adapter.getBrokenLinks();
}

/**
 * Get broken links grouped by source page.
 *
 * @param adapter - The sync database adapter
 * @returns Broken links grouped by source page ID
 */
export async function getBrokenLinksByPage(
  adapter: SyncDbAdapter
): Promise<Map<string, LinkRecord[]>> {
  const brokenLinks = await adapter.getBrokenLinks();
  const byPage = new Map<string, LinkRecord[]>();

  for (const link of brokenLinks) {
    const existing = byPage.get(link.sourcePageId) ?? [];
    existing.push(link);
    byPage.set(link.sourcePageId, existing);
  }

  return byPage;
}

/**
 * Get a summary of broken links.
 *
 * @param adapter - The sync database adapter
 * @returns Summary of broken links
 */
export async function getBrokenLinkSummary(adapter: SyncDbAdapter): Promise<BrokenLinkSummary> {
  const brokenLinks = await adapter.getBrokenLinks();
  const bySourcePage = new Map<string, LinkRecord[]>();

  for (const link of brokenLinks) {
    const existing = bySourcePage.get(link.sourcePageId) ?? [];
    existing.push(link);
    bySourcePage.set(link.sourcePageId, existing);
  }

  return {
    totalBroken: brokenLinks.length,
    bySourcePage,
    pagesAffected: bySourcePage.size,
  };
}

/**
 * Validate all links for a page by comparing database state with current markdown.
 *
 * This is the spec-compliant validation function that:
 * - Extracts links from current markdown content
 * - Compares with links stored in sync.db
 * - Identifies added, removed, and broken links
 *
 * Used by both `wiki docs status --links` and `audit wiki --broken-links`.
 *
 * @param adapter - The sync database adapter
 * @param pagePath - Absolute path to the markdown file
 * @param markdownContent - Current markdown content
 * @param rootDir - Root directory for relative path resolution
 * @returns Full validation result with stored, current, added, removed, broken links
 */
export async function validatePageLinks(
  adapter: SyncDbAdapter,
  pagePath: string,
  markdownContent: string,
  rootDir: string
): Promise<LinkValidationResult> {
  // Get page from database by path
  const page = await adapter.getPageByPath(pagePath.replace(rootDir + "/", ""));
  const pageId = page?.pageId ?? "";

  // Get stored links from database
  const stored = pageId ? await adapter.getOutgoingLinks(pageId) : [];

  // Extract current links from markdown
  const current = await extractLinksFromMarkdownToRecords(markdownContent, pageId, {
    filePath: pagePath,
    rootDir,
    adapter,
    includeExternal: true,
    includeAttachments: true,
    includeAnchors: false,
  });

  // Build sets for comparison (by target path for internal, by URL for external)
  const storedSet = new Set(
    stored.map((l) => l.targetPageId ?? l.targetPath ?? "")
  );
  const currentSet = new Set(
    current.map((l) => l.targetPageId ?? l.targetPath ?? "")
  );

  // Find added links (in current but not in stored)
  const added = current.filter(
    (l) => !storedSet.has(l.targetPageId ?? l.targetPath ?? "")
  );

  // Find removed links (in stored but not in current)
  const removed = stored.filter(
    (l) => !currentSet.has(l.targetPageId ?? l.targetPath ?? "")
  );

  // Find broken links (from current extraction)
  const broken = current.filter((l) => l.isBroken);

  return {
    pageId,
    pagePath: pagePath.replace(rootDir + "/", ""),
    links: {
      stored,
      current,
      added,
      removed,
      broken,
    },
  };
}

/**
 * Simple validation that only queries the database for broken/external links.
 *
 * Use this for quick checks when you don't need full link drift detection.
 *
 * @param adapter - The sync database adapter
 * @param page - The page to validate
 * @returns Quick validation result with broken and external links
 */
export async function validatePageLinksQuick(
  adapter: SyncDbAdapter,
  page: PageRecord
): Promise<{ broken: LinkRecord[]; external: LinkRecord[] }> {
  const outgoing = await adapter.getOutgoingLinks(page.pageId);

  const broken = outgoing.filter((l) => l.isBroken);
  const external = outgoing.filter((l) => l.linkType === "external");

  return { broken, external };
}

/**
 * Validate all links across all pages in a directory.
 *
 * Batch validation for comprehensive audit reports.
 *
 * @param adapter - The sync database adapter
 * @param localDir - Root directory containing markdown files
 * @returns Array of validation results for all pages
 */
export async function validateAllLinks(
  adapter: SyncDbAdapter,
  localDir: string
): Promise<LinkValidationResult[]> {
  const pages = await adapter.listPages({});
  const results: LinkValidationResult[] = [];

  for (const page of pages) {
    const filePath = join(localDir, page.path);

    try {
      const markdownContent = await readFile(filePath, "utf-8");
      const result = await validatePageLinks(adapter, filePath, markdownContent, localDir);
      results.push(result);
    } catch {
      // File might not exist locally (remote-only page)
      // Skip silently
    }
  }

  return results;
}

/**
 * Get external links from the database, optionally for a specific page.
 *
 * @param adapter - The sync database adapter
 * @param pageId - Optional page ID to filter by
 * @returns Array of external link records
 */
export async function getExternalLinks(
  adapter: SyncDbAdapter,
  pageId?: string
): Promise<LinkRecord[]> {
  return adapter.getExternalLinks(pageId);
}
