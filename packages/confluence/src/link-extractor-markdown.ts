/**
 * Extract links from local markdown files.
 *
 * Used for local change detection during `wiki docs status` and `wiki docs push`.
 * Unlike storage format extraction, this requires path resolution to map
 * relative paths to page IDs.
 */

import { dirname, join, normalize, relative } from "node:path";
import type { LinkRecord, SyncDbAdapter } from "./sync-db/types.js";
import { extractLinks, type MarkdownLink, type LinkType } from "./links.js";

/**
 * Extracted link from markdown with resolution metadata.
 */
export interface MarkdownLinkWithResolution extends MarkdownLink {
  /** Resolved absolute path (for relative links) */
  resolvedPath: string | null;
  /** Resolved page ID (if found in database) */
  resolvedPageId: string | null;
  /** Whether the link target was found */
  isResolved: boolean;
  /** Whether the link is broken (target not found) */
  isBroken: boolean;
}

/**
 * Options for markdown link extraction.
 */
export interface ExtractMarkdownLinksOptions {
  /** Absolute path to the markdown file */
  filePath: string;
  /** Absolute path to the root directory (for relative path calculation) */
  rootDir: string;
  /** Database adapter for path resolution (optional) */
  adapter?: SyncDbAdapter;
  /** Track external links (default: true) */
  includeExternal?: boolean;
  /** Track attachment links (default: true) */
  includeAttachments?: boolean;
  /** Track anchor links (default: false) */
  includeAnchors?: boolean;
}

/**
 * Extract links from markdown content and optionally resolve to page IDs.
 *
 * @param markdown - The markdown content
 * @param options - Extraction options
 * @returns Array of links with resolution information
 */
export async function extractLinksFromMarkdown(
  markdown: string,
  options: ExtractMarkdownLinksOptions
): Promise<MarkdownLinkWithResolution[]> {
  const {
    filePath,
    rootDir,
    adapter,
    includeExternal = true,
    includeAttachments = true,
    includeAnchors = false,
  } = options;

  // Use existing link extraction
  const rawLinks = extractLinks(markdown);

  // Filter by type
  const filteredLinks = rawLinks.filter((link) => {
    switch (link.type) {
      case "external":
        return includeExternal;
      case "attachment":
        return includeAttachments;
      case "anchor":
        return includeAnchors;
      case "relative-path":
        return true;
      default:
        return true;
    }
  });

  // Resolve links
  const resolvedLinks: MarkdownLinkWithResolution[] = [];

  for (const link of filteredLinks) {
    const resolved = await resolveLink(link, filePath, rootDir, adapter);
    resolvedLinks.push(resolved);
  }

  return resolvedLinks;
}

/**
 * Convert extracted markdown links to LinkRecord format for database storage.
 *
 * @param markdown - The markdown content
 * @param sourcePageId - The page ID of the source page
 * @param options - Extraction options
 * @returns Array of LinkRecord objects
 */
export async function extractLinksFromMarkdownToRecords(
  markdown: string,
  sourcePageId: string,
  options: ExtractMarkdownLinksOptions
): Promise<LinkRecord[]> {
  const links = await extractLinksFromMarkdown(markdown, options);
  const now = new Date().toISOString();

  return links.map((link): LinkRecord => ({
    sourcePageId,
    targetPageId: link.resolvedPageId,
    targetPath: link.type === "relative-path" ? link.target : null,
    linkType: mapLinkType(link.type),
    linkText: link.text || null,
    lineNumber: link.line,
    isBroken: link.isBroken,
    createdAt: now,
  }));
}

/**
 * Map markdown link type to LinkRecord link type.
 */
function mapLinkType(type: LinkType): LinkRecord["linkType"] {
  switch (type) {
    case "relative-path":
      return "internal";
    case "external":
      return "external";
    case "attachment":
      return "attachment";
    case "anchor":
      return "anchor";
    default:
      return "internal";
  }
}

/**
 * Resolve a single link to its target.
 */
async function resolveLink(
  link: MarkdownLink,
  filePath: string,
  rootDir: string,
  adapter?: SyncDbAdapter
): Promise<MarkdownLinkWithResolution> {
  const base: MarkdownLinkWithResolution = {
    ...link,
    resolvedPath: null,
    resolvedPageId: null,
    isResolved: false,
    isBroken: false,
  };

  switch (link.type) {
    case "relative-path": {
      // Resolve relative path to absolute path
      const dir = dirname(filePath);
      const targetPath = link.target.split("#")[0]; // Remove anchor
      const absolutePath = normalize(join(dir, targetPath));
      const relativePath = relative(rootDir, absolutePath);

      base.resolvedPath = relativePath;

      // Try to resolve to page ID via adapter
      if (adapter) {
        const page = await adapter.getPageByPath(relativePath);
        if (page) {
          base.resolvedPageId = page.pageId;
          base.isResolved = true;
        } else {
          base.isBroken = true;
        }
      }
      break;
    }

    case "attachment": {
      // Attachment links are resolved relative to the page
      base.resolvedPath = link.target;
      base.isResolved = true; // We don't validate attachment existence here
      break;
    }

    case "external": {
      // External links are always "resolved"
      base.isResolved = true;
      break;
    }

    case "anchor": {
      // Anchor links are always "resolved" (same-page)
      base.isResolved = true;
      break;
    }
  }

  return base;
}

/**
 * Validate links in a markdown file against the database.
 * Returns only broken links.
 *
 * @param markdown - The markdown content
 * @param options - Extraction options (adapter required)
 * @returns Array of broken links
 */
export async function findBrokenLinks(
  markdown: string,
  options: ExtractMarkdownLinksOptions & { adapter: SyncDbAdapter }
): Promise<MarkdownLinkWithResolution[]> {
  const links = await extractLinksFromMarkdown(markdown, options);
  return links.filter((link) => link.isBroken);
}

/**
 * Get link statistics for a markdown file.
 */
export async function getLinkStats(
  markdown: string,
  options: ExtractMarkdownLinksOptions
): Promise<{
  total: number;
  internal: number;
  external: number;
  attachments: number;
  anchors: number;
  resolved: number;
  broken: number;
}> {
  const allLinks = await extractLinksFromMarkdown(markdown, {
    ...options,
    includeExternal: true,
    includeAttachments: true,
    includeAnchors: true,
  });

  return {
    total: allLinks.length,
    internal: allLinks.filter((l) => l.type === "relative-path").length,
    external: allLinks.filter((l) => l.type === "external").length,
    attachments: allLinks.filter((l) => l.type === "attachment").length,
    anchors: allLinks.filter((l) => l.type === "anchor").length,
    resolved: allLinks.filter((l) => l.isResolved).length,
    broken: allLinks.filter((l) => l.isBroken).length,
  };
}

/**
 * Compare links between two markdown contents.
 * Useful for detecting link changes during push.
 */
export function compareLinkSets(
  oldLinks: MarkdownLinkWithResolution[],
  newLinks: MarkdownLinkWithResolution[]
): {
  added: MarkdownLinkWithResolution[];
  removed: MarkdownLinkWithResolution[];
  unchanged: MarkdownLinkWithResolution[];
} {
  const oldTargets = new Set(oldLinks.map((l) => linkKey(l)));
  const newTargets = new Set(newLinks.map((l) => linkKey(l)));

  return {
    added: newLinks.filter((l) => !oldTargets.has(linkKey(l))),
    removed: oldLinks.filter((l) => !newTargets.has(linkKey(l))),
    unchanged: newLinks.filter((l) => oldTargets.has(linkKey(l))),
  };
}

/**
 * Generate a unique key for a link (for comparison).
 */
function linkKey(link: MarkdownLinkWithResolution): string {
  return `${link.type}:${link.target}`;
}
