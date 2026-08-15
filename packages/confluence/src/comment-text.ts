import { storageToMarkdown } from "./markdown.js";

/**
 * Convert a Confluence Storage comment body to deterministic plain text.
 *
 * This module is intentionally browser-safe: export hosts use it while
 * correlating transient v2 comment resources to ADF annotation ranges.
 */
export function commentBodyToText(storageBody: string): string {
  const markdown = storageToMarkdown(storageBody);
  return markdown
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\*\*([^*\n]+)\*\*/g, "$1")
    .replace(/(?<!\\)\*([^*\n]+)(?<!\\)\*/g, "$1")
    .replace(/(?<!\\)~([^~\n]+)(?<!\\)~/g, "$1")
    .replace(/`([^`\n]*)`/g, "$1")
    .replace(/\\([\\`*_[\]{}()#+\-.!>~])/g, "$1")
    .replace(/\n+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
