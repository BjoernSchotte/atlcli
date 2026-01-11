/**
 * Comments sync utilities.
 *
 * Provides functions for reading/writing page comments to JSON files.
 */

import { readFile, writeFile } from "node:fs/promises";
import { join, dirname, basename } from "node:path";
import type { PageComments, FooterComment, InlineComment } from "./client.js";
import { storageToMarkdown } from "./markdown.js";

/**
 * Get the comments file path for a markdown file.
 *
 * Example: "docs/architecture.md" -> "docs/architecture.comments.json"
 */
export function getCommentsFilePath(markdownPath: string): string {
  const dir = dirname(markdownPath);
  const base = basename(markdownPath, ".md");
  return join(dir, `${base}.comments.json`);
}

/**
 * Read comments from a JSON file.
 *
 * Returns null if the file doesn't exist.
 */
export async function readCommentsFile(
  commentsPath: string
): Promise<PageComments | null> {
  try {
    const content = await readFile(commentsPath, "utf-8");
    return JSON.parse(content) as PageComments;
  } catch {
    return null;
  }
}

/**
 * Write comments to a JSON file.
 */
export async function writeCommentsFile(
  commentsPath: string,
  comments: PageComments
): Promise<void> {
  const content = JSON.stringify(comments, null, 2);
  await writeFile(commentsPath, content, "utf-8");
}

/**
 * Convert comment body from storage format to plain text.
 *
 * Strips HTML tags and normalizes whitespace.
 */
export function commentBodyToText(storageBody: string): string {
  // Use markdown converter then strip remaining formatting
  const markdown = storageToMarkdown(storageBody);
  return markdown
    .replace(/\*\*/g, "") // Remove bold markers
    .replace(/\*/g, "") // Remove italic markers
    .replace(/`/g, "") // Remove code markers
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1") // Convert links to text
    .replace(/\n+/g, " ") // Collapse newlines
    .replace(/\s+/g, " ") // Collapse whitespace
    .trim();
}

/**
 * Format a comment for display.
 */
export function formatComment(
  comment: FooterComment | InlineComment,
  indent = 0
): string {
  const prefix = "  ".repeat(indent);
  const author = comment.author.displayName;
  const date = new Date(comment.created).toLocaleDateString();
  const status = comment.status === "resolved" ? " [resolved]" : "";
  const body = commentBodyToText(comment.body);

  let text = `${prefix}${author} (${date})${status}: ${body}`;

  // Add text selection for inline comments
  if ("textSelection" in comment && comment.textSelection) {
    text = `${prefix}[on: "${comment.textSelection}"]
${prefix}${author} (${date})${status}: ${body}`;
  }

  // Add replies
  for (const reply of comment.replies) {
    text += "\n" + formatComment(reply, indent + 1);
  }

  return text;
}

/**
 * Count total comments including replies.
 */
export function countComments(comments: PageComments): {
  footer: number;
  inline: number;
  total: number;
} {
  const countReplies = (c: FooterComment | InlineComment): number => {
    return 1 + c.replies.reduce((sum, r) => sum + countReplies(r), 0);
  };

  const footer = comments.footerComments.reduce(
    (sum, c) => sum + countReplies(c),
    0
  );
  const inline = comments.inlineComments.reduce(
    (sum, c) => sum + countReplies(c),
    0
  );

  return { footer, inline, total: footer + inline };
}

/**
 * Check if a page has any comments.
 */
export function hasComments(comments: PageComments): boolean {
  return (
    comments.footerComments.length > 0 || comments.inlineComments.length > 0
  );
}
