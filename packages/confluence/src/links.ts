import { dirname, join, normalize } from "node:path";

/** Types of links found in markdown */
export type LinkType =
  | "relative-path" // ./other-page.md, ../sibling/page.md
  | "anchor" // #section-name
  | "external" // https://example.com
  | "attachment"; // ./page.attachments/file.pdf

/** A link found in markdown content */
export interface MarkdownLink {
  /** Type of link */
  type: LinkType;
  /** The raw target (path, anchor, url) */
  target: string;
  /** Link text */
  text: string;
  /** 1-indexed line number */
  line: number;
  /** 1-indexed column (start of link) */
  column: number;
  /** Original markdown syntax */
  raw: string;
}

/**
 * Extract all links from markdown content.
 * Excludes links inside code blocks and inline code.
 */
export function extractLinks(markdown: string): MarkdownLink[] {
  const links: MarkdownLink[] = [];

  // Split into lines for line number tracking
  const lines = markdown.split("\n");

  // Track code block state
  let inCodeBlock = false;

  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const line = lines[lineIdx];
    const lineNum = lineIdx + 1;

    // Check for code block start/end
    if (line.trim().startsWith("```")) {
      inCodeBlock = !inCodeBlock;
      continue;
    }

    // Skip lines inside code blocks
    if (inCodeBlock) continue;

    // Remove inline code from line before matching
    const lineWithoutInlineCode = line.replace(/`[^`]+`/g, (match) =>
      " ".repeat(match.length)
    );

    // Match markdown links: [text](target)
    // But NOT images: ![alt](src)
    const linkRegex = /(?<!!)\[([^\]]*)\]\(([^)]+)\)/g;
    let match: RegExpExecArray | null;

    while ((match = linkRegex.exec(lineWithoutInlineCode)) !== null) {
      const text = match[1];
      const target = match[2];
      const column = match.index + 1;
      const raw = match[0];

      const type = classifyLink(target);
      links.push({ type, target, text, line: lineNum, column, raw });
    }
  }

  return links;
}

/**
 * Classify a link target into its type.
 */
export function classifyLink(target: string): LinkType {
  // Anchor-only links
  if (target.startsWith("#")) {
    return "anchor";
  }

  // External URLs
  if (
    target.startsWith("http://") ||
    target.startsWith("https://") ||
    target.startsWith("mailto:") ||
    target.startsWith("ftp://")
  ) {
    return "external";
  }

  // Attachment links (contains .attachments/)
  if (target.includes(".attachments/")) {
    return "attachment";
  }

  // Relative paths (anything else, typically .md files)
  return "relative-path";
}

/**
 * Resolve a relative path link to an absolute path.
 *
 * @param fromFile - Absolute path to the source file
 * @param linkTarget - The relative link target (e.g., "./other.md", "../sibling.md")
 * @returns Resolved absolute path
 */
export function resolveRelativePath(
  fromFile: string,
  linkTarget: string
): string {
  // Handle anchor suffix (e.g., "./page.md#section")
  const [pathPart] = linkTarget.split("#");

  // Get directory of source file
  const fromDir = dirname(fromFile);

  // Resolve relative path
  const resolved = normalize(join(fromDir, pathPart));

  return resolved;
}

/**
 * Check if a path looks like a markdown file.
 */
export function isMarkdownPath(path: string): boolean {
  const lower = path.toLowerCase();
  return lower.endsWith(".md") || lower.endsWith(".markdown");
}

/**
 * Extract just the path portion from a link (without anchor).
 */
export function getPathWithoutAnchor(target: string): string {
  const [pathPart] = target.split("#");
  return pathPart;
}

/**
 * Extract the anchor portion from a link (if any).
 */
export function getAnchor(target: string): string | null {
  const hashIndex = target.indexOf("#");
  if (hashIndex === -1) return null;
  return target.slice(hashIndex + 1);
}
