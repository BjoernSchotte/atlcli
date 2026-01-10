import MarkdownIt from "markdown-it";
import taskLists from "markdown-it-task-lists";
import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";
import { createHash } from "crypto";

const md = new MarkdownIt({
  html: true,  // Allow HTML passthrough for macro placeholders
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

/**
 * Supported Confluence macro types for ::: syntax
 */
const PANEL_MACROS = ["info", "note", "warning", "tip"];
// Use [ \t]+ instead of \s+ to avoid matching newlines in the title capture
const MACRO_REGEX = /^:::(info|note|warning|tip|expand|toc)(?:[ \t]+(.+))?\n([\s\S]*?)^:::\s*$/gm;

/**
 * Convert ::: macro blocks to placeholders, render markdown, then replace placeholders.
 */
export function markdownToStorage(markdown: string): string {
  const macros: { placeholder: string; html: string }[] = [];
  let placeholderIndex = 0;

  // Replace ::: blocks with placeholders
  const withPlaceholders = markdown.replace(MACRO_REGEX, (_, macro, title, content) => {
    const trimmedContent = (content || "").trim();
    const placeholder = `<!--MACRO_PLACEHOLDER_${placeholderIndex++}-->`;

    let html: string;

    if (macro === "toc") {
      html = `<ac:structured-macro ac:name="toc"/>`;
    } else if (macro === "expand") {
      const expandTitle = title?.trim() || "Click to expand";
      html = `<ac:structured-macro ac:name="expand">
<ac:parameter ac:name="title">${escapeHtml(expandTitle)}</ac:parameter>
<ac:rich-text-body>
${md.render(trimmedContent).trim()}
</ac:rich-text-body>
</ac:structured-macro>`;
    } else if (PANEL_MACROS.includes(macro)) {
      // Panel macros: info, note, warning, tip
      let panelHtml = `<ac:structured-macro ac:name="${macro}">`;
      if (title?.trim()) {
        panelHtml += `\n<ac:parameter ac:name="title">${escapeHtml(title.trim())}</ac:parameter>`;
      }
      panelHtml += `
<ac:rich-text-body>
${md.render(trimmedContent).trim()}
</ac:rich-text-body>
</ac:structured-macro>`;
      html = panelHtml;
    } else {
      // Unknown macro - keep original
      return _;
    }

    macros.push({ placeholder, html });
    return placeholder;
  });

  // Render markdown
  let result = md.render(withPlaceholders);

  // Replace placeholders with actual macro HTML
  for (const { placeholder, html } of macros) {
    // The placeholder might be wrapped in <p> tags
    result = result.replace(`<p>${placeholder}</p>`, html);
    result = result.replace(placeholder, html);
  }

  return result;
}

/**
 * Preprocess Confluence storage to convert macros to placeholder HTML
 * that turndown can process.
 */
function preprocessStorageMacros(storage: string): string {
  // Convert panel macros (info, note, warning, tip)
  storage = storage.replace(
    /<ac:structured-macro\s+ac:name="(info|note|warning|tip)"[^>]*>([\s\S]*?)<\/ac:structured-macro>/gi,
    (_, macroName, inner) => {
      const titleMatch = inner.match(/<ac:parameter\s+ac:name="title"[^>]*>([^<]*)<\/ac:parameter>/i);
      const title = titleMatch ? titleMatch[1] : "";
      const bodyMatch = inner.match(/<ac:rich-text-body>([\s\S]*?)<\/ac:rich-text-body>/i);
      const body = bodyMatch ? bodyMatch[1] : "";
      return `<div data-macro="${macroName}" data-title="${escapeHtml(title)}">${body}</div>`;
    }
  );

  // Convert expand macro
  storage = storage.replace(
    /<ac:structured-macro\s+ac:name="expand"[^>]*>([\s\S]*?)<\/ac:structured-macro>/gi,
    (_, inner) => {
      const titleMatch = inner.match(/<ac:parameter\s+ac:name="title"[^>]*>([^<]*)<\/ac:parameter>/i);
      const title = titleMatch ? titleMatch[1] : "Click to expand";
      const bodyMatch = inner.match(/<ac:rich-text-body>([\s\S]*?)<\/ac:rich-text-body>/i);
      const body = bodyMatch ? bodyMatch[1] : "";
      return `<div data-macro="expand" data-title="${escapeHtml(title)}">${body}</div>`;
    }
  );

  // Convert toc macro
  storage = storage.replace(
    /<ac:structured-macro\s+ac:name="toc"[^>]*\/?>([\s\S]*?<\/ac:structured-macro>)?/gi,
    () => `<div data-macro="toc"></div>`
  );

  return storage;
}

export function storageToMarkdown(storage: string): string {
  // Preprocess Confluence macros
  const preprocessed = preprocessStorageMacros(storage);

  const service = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    emDelimiter: "*",
    strongDelimiter: "**",
  });
  service.use(gfm);

  // Handle Confluence macros converted to data-macro divs
  service.addRule("confluenceMacro", {
    filter: (node) => {
      return node.nodeName === "DIV" && (node as any).getAttribute?.("data-macro");
    },
    replacement: (content, node) => {
      const macroName = (node as any).getAttribute?.("data-macro") || "";
      const title = (node as any).getAttribute?.("data-title") || "";

      if (macroName === "toc") {
        return "\n\n:::toc\n:::\n\n";
      }

      if (macroName === "expand") {
        return `\n\n:::expand ${title}\n${content.trim()}\n:::\n\n`;
      }

      // Panel macros
      if (PANEL_MACROS.includes(macroName)) {
        const titlePart = title ? ` ${title}` : "";
        return `\n\n:::${macroName}${titlePart}\n${content.trim()}\n:::\n\n`;
      }

      return content;
    },
  });

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

  const markdown = service.turndown(preprocessed);
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
