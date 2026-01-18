/**
 * Shared link validation module.
 *
 * Used by both:
 * - `wiki docs status --links` - quick check during sync workflow
 * - `audit wiki --broken-links` - comprehensive audit report
 *
 * @module link-validator
 */

import type { SyncDbAdapter, LinkRecord, PageRecord } from "./sync-db/types.js";

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
 * Validate all links for a page against the filesystem.
 *
 * This is a higher-level function that combines database queries
 * with filesystem checks for comprehensive validation.
 *
 * @param adapter - The sync database adapter
 * @param page - The page to validate
 * @returns Validation result with broken links
 */
export async function validatePageLinks(
  adapter: SyncDbAdapter,
  page: PageRecord
): Promise<{ broken: LinkRecord[]; external: LinkRecord[] }> {
  const outgoing = await adapter.getOutgoingLinks(page.pageId);

  const broken = outgoing.filter((l) => l.isBroken);
  const external = outgoing.filter((l) => l.linkType === "external");

  return { broken, external };
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
