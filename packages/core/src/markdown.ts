import MarkdownIt from "markdown-it";
import taskLists from "markdown-it-task-lists";
import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";
import { createHash } from "crypto";

const md = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: false,
  typographer: true,
})
  .use(taskLists, { label: true, labelAfter: true });

md.renderer.rules.fence = (tokens, idx) => {
  const token = tokens[idx];
  const info = (token.info || "").trim();
  const lang = info ? ` language-${escapeHtml(info)}` : "";
  const content = escapeHtml(token.content);
  return `<pre><code class=\"${lang.trim()}\">${content}</code></pre>`;
};

export function markdownToStorage(markdown: string): string {
  return md.render(markdown);
}

export function storageToMarkdown(storage: string): string {
  const service = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    emDelimiter: "*",
    strongDelimiter: "**",
  });
  service.use(gfm);

  service.addRule("preCodeFence", {
    filter: (node) => node.nodeName === "PRE" && node.firstChild?.nodeName === "CODE",
    replacement: (_content, node) => {
      const codeNode = (node.firstChild as any) ?? null;
      const className = codeNode?.getAttribute?.("class") ?? "";
      const lang = className.replace(/^language-/, "").trim();
      const text = codeNode?.textContent ?? "";
      return `\n\n\`\`\`${lang ? " " + lang : ""}\n${text}\n\`\`\`\n\n`;
    },
  });

  service.addRule("taskList", {
    filter: (node) =>
      node.nodeName === "INPUT" && (node as any).getAttribute?.("type") === "checkbox",
    replacement: (_content, node) => {
      const checked = (node as any).hasAttribute?.("checked");
      return checked ? "[x] " : "[ ] ";
    },
  });

  const markdown = service.turndown(storage);
  return markdown.trim() + "\n";
}

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;");
}

/**
 * Normalizes markdown content for consistent comparison.
 * - Converts CRLF to LF
 * - Removes trailing whitespace from lines
 * - Collapses multiple blank lines to single blank line
 * - Ensures single trailing newline
 */
export function normalizeMarkdown(markdown: string): string {
  return markdown
    .replace(/\r\n/g, "\n")           // Normalize line endings
    .replace(/[ \t]+$/gm, "")         // Remove trailing whitespace per line
    .replace(/\n{3,}/g, "\n\n")       // Collapse multiple blank lines
    .trim() + "\n";                   // Ensure single trailing newline
}

/**
 * Computes SHA-256 hash of content for change detection.
 * Returns hex-encoded hash string.
 */
export function hashContent(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}
