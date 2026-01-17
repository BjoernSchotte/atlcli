/**
 * Extract links from Confluence XHTML storage format.
 *
 * This extractor parses the authoritative Confluence storage format which
 * contains page IDs, space keys, and other metadata directly - no path
 * resolution needed.
 *
 * Link types in Confluence storage:
 * - <ac:link><ri:page ri:content-id="..." ri:space-key="..."/></ac:link>
 * - <ac:link><ri:attachment ri:filename="..."/></ac:link>
 * - <a href="...">...</a> (external links)
 * - <ac:link><ri:user ri:account-id="..."/></ac:link> (user mentions - ignored)
 */

import type { LinkRecord } from "./sync-db/types.js";

/**
 * Extracted link from Confluence storage format.
 * Contains all information available in the storage format.
 */
export interface StorageLink {
  /** Type of link */
  type: "internal" | "external" | "attachment" | "anchor";
  /** Target page ID (for internal links) */
  targetPageId: string | null;
  /** Target space key (for cross-space links) */
  targetSpaceKey: string | null;
  /** Target page title (when ID not available) */
  targetPageTitle: string | null;
  /** Attachment filename (for attachment links) */
  attachmentFilename: string | null;
  /** External URL (for external links) */
  externalUrl: string | null;
  /** Anchor/section ID */
  anchor: string | null;
  /** Link text displayed to users */
  linkText: string | null;
  /** Raw matched element (for debugging) */
  raw: string;
}

/**
 * Extract all links from Confluence XHTML storage format.
 *
 * @param storage - The Confluence storage format (XHTML)
 * @param sourcePageId - The page ID of the source page (for LinkRecord)
 * @returns Array of LinkRecord objects ready for database storage
 */
export function extractLinksFromStorage(
  storage: string,
  sourcePageId: string
): LinkRecord[] {
  const storageLinks = parseStorageLinks(storage);
  const now = new Date().toISOString();

  return storageLinks.map((link): LinkRecord => ({
    sourcePageId,
    targetPageId: link.targetPageId,
    targetPath: link.attachmentFilename || link.externalUrl || link.targetPageTitle,
    linkType: link.type,
    linkText: link.linkText,
    lineNumber: null, // Storage format doesn't have line numbers
    isBroken: false, // Will be determined later by validation
    createdAt: now,
  }));
}

/**
 * Parse storage format and extract raw link information.
 * This is the lower-level function that does the actual parsing.
 */
export function parseStorageLinks(storage: string): StorageLink[] {
  const links: StorageLink[] = [];

  // Extract internal page links: <ac:link><ri:page .../></ac:link>
  // Can have ri:content-id, ri:content-title, ri:space-key
  const pageLinkRegex =
    /<ac:link[^>]*>([\s\S]*?)<\/ac:link>/gi;

  let match: RegExpExecArray | null;
  while ((match = pageLinkRegex.exec(storage)) !== null) {
    const inner = match[1];
    const raw = match[0];

    // Skip user mentions - they're not navigation links
    if (inner.includes("<ri:user")) {
      continue;
    }

    // Check for page link
    const pageMatch = inner.match(/<ri:page([^>]*)\/>/i);
    if (pageMatch) {
      const attrs = pageMatch[1];
      const link = parsePageLink(attrs, inner, raw);
      if (link) {
        links.push(link);
      }
      continue;
    }

    // Check for attachment link
    const attachmentMatch = inner.match(/<ri:attachment([^>]*)\/>/i);
    if (attachmentMatch) {
      const attrs = attachmentMatch[1];
      const link = parseAttachmentLink(attrs, inner, raw);
      if (link) {
        links.push(link);
      }
      continue;
    }

    // Check for shortcut link (external URL in Confluence format)
    const shortcutMatch = inner.match(/<ri:shortcut\s+ri:value="([^"]+)"[^>]*\/>/i);
    if (shortcutMatch) {
      links.push({
        type: "external",
        targetPageId: null,
        targetSpaceKey: null,
        targetPageTitle: null,
        attachmentFilename: null,
        externalUrl: shortcutMatch[1],
        anchor: null,
        linkText: extractLinkText(inner),
        raw,
      });
      continue;
    }
  }

  // Extract external links: <a href="...">...</a>
  // These are standard HTML links embedded in the storage
  const externalLinkRegex = /<a\s+[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  while ((match = externalLinkRegex.exec(storage)) !== null) {
    const href = match[1];
    const text = stripHtml(match[2]);
    const raw = match[0];

    // Skip anchors (same-page links)
    if (href.startsWith("#")) {
      links.push({
        type: "anchor",
        targetPageId: null,
        targetSpaceKey: null,
        targetPageTitle: null,
        attachmentFilename: null,
        externalUrl: null,
        anchor: href.slice(1),
        linkText: text,
        raw,
      });
      continue;
    }

    // Only include truly external URLs
    if (href.startsWith("http://") || href.startsWith("https://") || href.startsWith("mailto:")) {
      links.push({
        type: "external",
        targetPageId: null,
        targetSpaceKey: null,
        targetPageTitle: null,
        attachmentFilename: null,
        externalUrl: href,
        anchor: null,
        linkText: text,
        raw,
      });
    }
  }

  // Extract image links to attachments: <ac:image><ri:attachment .../></ac:image>
  // These reference attachments but aren't navigational links - we still track them
  const imageRegex = /<ac:image[^>]*>([\s\S]*?)<\/ac:image>/gi;
  while ((match = imageRegex.exec(storage)) !== null) {
    const inner = match[1];
    const raw = match[0];

    const attachmentMatch = inner.match(/<ri:attachment\s+ri:filename="([^"]+)"[^>]*\/>/i);
    if (attachmentMatch) {
      links.push({
        type: "attachment",
        targetPageId: null,
        targetSpaceKey: null,
        targetPageTitle: null,
        attachmentFilename: attachmentMatch[1],
        externalUrl: null,
        anchor: null,
        linkText: null,
        raw,
      });
    }
  }

  return links;
}

/**
 * Parse a page link from ri:page attributes.
 */
function parsePageLink(attrs: string, inner: string, raw: string): StorageLink | null {
  // Extract page ID
  const pageIdMatch = attrs.match(/ri:content-id="([^"]+)"/i);
  const pageId = pageIdMatch ? pageIdMatch[1] : null;

  // Extract page title (fallback when ID not available)
  const pageTitleMatch = attrs.match(/ri:content-title="([^"]+)"/i);
  const pageTitle = pageTitleMatch ? decodeHtmlEntities(pageTitleMatch[1]) : null;

  // Extract space key (for cross-space links)
  const spaceKeyMatch = attrs.match(/ri:space-key="([^"]+)"/i);
  const spaceKey = spaceKeyMatch ? spaceKeyMatch[1] : null;

  // Extract anchor if present
  const anchorMatch = inner.match(/<ri:anchor\s+ri:anchor="([^"]+)"[^>]*\/>/i)
    || attrs.match(/ri:anchor="([^"]+)"/i);
  const anchor = anchorMatch ? anchorMatch[1] : null;

  // If we have neither page ID nor title, this isn't a valid link
  if (!pageId && !pageTitle) {
    return null;
  }

  return {
    type: "internal",
    targetPageId: pageId,
    targetSpaceKey: spaceKey,
    targetPageTitle: pageTitle,
    attachmentFilename: null,
    externalUrl: null,
    anchor,
    linkText: extractLinkText(inner),
    raw,
  };
}

/**
 * Parse an attachment link from ri:attachment attributes.
 */
function parseAttachmentLink(attrs: string, inner: string, raw: string): StorageLink | null {
  const filenameMatch = attrs.match(/ri:filename="([^"]+)"/i);
  if (!filenameMatch) {
    return null;
  }

  return {
    type: "attachment",
    targetPageId: null,
    targetSpaceKey: null,
    targetPageTitle: null,
    attachmentFilename: decodeHtmlEntities(filenameMatch[1]),
    externalUrl: null,
    anchor: null,
    linkText: extractLinkText(inner),
    raw,
  };
}

/**
 * Extract link text from the inner content of an ac:link element.
 */
function extractLinkText(inner: string): string | null {
  // Try plain-text-link-body first (with or without CDATA)
  const plainTextMatch = inner.match(
    /<ac:plain-text-link-body>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/ac:plain-text-link-body>/i
  );
  if (plainTextMatch) {
    return plainTextMatch[1].trim() || null;
  }

  // Try link-body (rich text)
  const linkBodyMatch = inner.match(
    /<ac:link-body>([\s\S]*?)<\/ac:link-body>/i
  );
  if (linkBodyMatch) {
    return stripHtml(linkBodyMatch[1]).trim() || null;
  }

  return null;
}

/**
 * Strip HTML tags from content.
 */
function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, "").trim();
}

/**
 * Decode HTML entities in a string.
 */
function decodeHtmlEntities(str: string): string {
  return str
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#x2F;/g, "/");
}

/**
 * Check if a storage format contains any links.
 * Useful for quick filtering before full extraction.
 */
export function hasLinks(storage: string): boolean {
  return (
    storage.includes("<ac:link>") ||
    storage.includes("<a href=") ||
    storage.includes("<ac:image>")
  );
}

/**
 * Count links in storage format without full extraction.
 */
export function countLinks(storage: string): {
  internal: number;
  external: number;
  attachments: number;
  total: number;
} {
  const internal = (storage.match(/<ri:page[^>]*\/>/gi) || []).length;
  const attachmentLinks = (storage.match(/<ac:link>[^<]*<ri:attachment/gi) || []).length;
  const attachmentImages = (storage.match(/<ac:image>[^<]*<ri:attachment/gi) || []).length;
  const external = (storage.match(/<a\s+[^>]*href="https?:\/\//gi) || []).length;

  return {
    internal,
    external,
    attachments: attachmentLinks + attachmentImages,
    total: internal + external + attachmentLinks + attachmentImages,
  };
}
