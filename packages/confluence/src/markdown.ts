import MarkdownIt from "markdown-it";
import taskLists from "markdown-it-task-lists";
import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";
import { createHash } from "crypto";
import { stripFrontmatter } from "./frontmatter.js";

// ============ Smart Link Types and Utilities ============

/** Display modes for Atlassian Smart Links */
export type SmartLinkAppearance = "inline" | "card" | "embed";

/** Options for markdown conversion functions */
export interface ConversionOptions {
  /** Base URL of the Atlassian instance (e.g., "https://company.atlassian.net") */
  baseUrl?: string;
  /** Emit deprecation warnings for legacy syntax */
  emitWarnings?: boolean;
  /** Callback for deprecation warnings */
  onWarning?: (message: string) => void;
}

/** URL patterns for detecting Atlassian product URLs */
const ATLASSIAN_URL_PATTERNS = {
  jira: /\/browse\/([A-Z][A-Z0-9]*-\d+)/i,
  confluence: /\/wiki\/spaces\/([^\/]+)\/pages\/(\d+)/i,
  trello: /^https?:\/\/trello\.com\/(c|b)\/([a-zA-Z0-9]+)/i,
  bitbucket: /^https?:\/\/bitbucket\.org\/([^\/]+)\/([^\/]+)/i,
};

/**
 * Check if a URL matches the given baseUrl's hostname.
 */
function urlMatchesBaseUrl(url: string, baseUrl: string): boolean {
  try {
    const urlHost = new URL(url).hostname.toLowerCase();
    const baseHost = new URL(baseUrl).hostname.toLowerCase();
    return urlHost === baseHost;
  } catch {
    return false;
  }
}

/**
 * Check if a URL is an Atlassian product URL (Jira, Confluence, etc.)
 */
function isAtlassianUrl(url: string): boolean {
  return (
    ATLASSIAN_URL_PATTERNS.jira.test(url) ||
    ATLASSIAN_URL_PATTERNS.confluence.test(url) ||
    ATLASSIAN_URL_PATTERNS.trello.test(url) ||
    ATLASSIAN_URL_PATTERNS.bitbucket.test(url)
  );
}

// ============ Markdown Conversion ============

const md = new MarkdownIt({
  html: true,  // Allow HTML passthrough for macro placeholders
  linkify: true,
  breaks: false,
  typographer: true,
})
  .use(taskLists, { label: true, labelAfter: false });

md.renderer.rules.fence = (tokens, idx) => {
  const token = tokens[idx];
  const info = (token.info || "").trim();
  const content = token.content;

  // Parse extended syntax: ```lang{title="..." collapse}
  const extendedMatch = info.match(/^(\w*)\{(.+)\}$/);
  if (extendedMatch) {
    const lang = extendedMatch[1] || "";
    const attrsStr = extendedMatch[2];

    // Parse attributes
    const titleMatch = attrsStr.match(/title="([^"]*)"/);
    const hasCollapse = /\bcollapse\b/.test(attrsStr);

    const title = titleMatch ? titleMatch[1] : "";

    // Build Confluence code macro
    let macroHtml = `<ac:structured-macro ac:name="code">`;
    if (lang) {
      macroHtml += `\n<ac:parameter ac:name="language">${escapeHtml(lang)}</ac:parameter>`;
    }
    if (title) {
      macroHtml += `\n<ac:parameter ac:name="title">${escapeHtml(title)}</ac:parameter>`;
    }
    if (hasCollapse) {
      macroHtml += `\n<ac:parameter ac:name="collapse">true</ac:parameter>`;
    }
    macroHtml += `\n<ac:plain-text-body><![CDATA[${content}]]></ac:plain-text-body>\n</ac:structured-macro>`;

    return macroHtml;
  }

  // Regular code block
  const lang = info ? ` language-${escapeHtml(info)}` : "";
  const escapedContent = escapeHtml(content);
  return `<pre><code class="${lang.trim()}">${escapedContent}</code></pre>`;
};

/**
 * Supported Confluence macro types for ::: syntax
 */
const PANEL_MACROS = ["info", "note", "warning", "tip"];
// Use [ \t]+ instead of \s+ to avoid matching newlines in the title capture
const MACRO_REGEX = /^:::(info|note|warning|tip|expand|toc)(?:[ \t]+(.+))?\n([\s\S]*?)^:::\s*$/gm;

// Regex for preserved confluence macros (unknown/3rd-party)
const CONFLUENCE_MACRO_REGEX = /^:::confluence\s+(\S+)\n([\s\S]*?)^:::\s*$/gm;

/**
 * Convert ::: macro blocks to placeholders, render markdown, then replace placeholders.
 * @param markdown - The markdown content to convert
 * @param options - Optional conversion options (baseUrl for smart links, warnings)
 */
export function markdownToStorage(markdown: string, options?: ConversionOptions): string {
  // Strip frontmatter before processing (defensive - callers should also strip)
  const content = stripFrontmatter(markdown);

  const macros: { placeholder: string; html: string }[] = [];
  let placeholderIndex = 0;

  // Handle inline status macros: {status:color}text{status}
  let processed = content.replace(STATUS_REGEX, (_, color, text) => {
    const placeholder = `<!--MACRO_PLACEHOLDER_${placeholderIndex++}-->`;
    const normalizedColor = color.charAt(0).toUpperCase() + color.slice(1).toLowerCase();
    const html = `<ac:structured-macro ac:name="status"><ac:parameter ac:name="colour">${escapeHtml(normalizedColor)}</ac:parameter><ac:parameter ac:name="title">${escapeHtml(text.trim())}</ac:parameter></ac:structured-macro>`;
    macros.push({ placeholder, html });
    return placeholder;
  });

  // Handle anchor macros: {#anchor-name}
  processed = processed.replace(ANCHOR_REGEX, (_, anchorName) => {
    const placeholder = `<!--MACRO_PLACEHOLDER_${placeholderIndex++}-->`;
    const html = `<ac:structured-macro ac:name="anchor"><ac:parameter ac:name="">${escapeHtml(anchorName)}</ac:parameter></ac:structured-macro>`;
    macros.push({ placeholder, html });
    return placeholder;
  });

  // Handle jira macros: {jira:PROJ-123} or {jira:PROJ-123|showSummary}
  // Note: This syntax is deprecated in favor of full URLs
  processed = processed.replace(JIRA_REGEX, (_, issueKey, jiraOpts) => {
    // Emit deprecation warning if enabled
    if (options?.emitWarnings && options?.onWarning) {
      const baseUrl = options.baseUrl || "https://your-instance.atlassian.net";
      options.onWarning(
        `Deprecation: {jira:${issueKey}} syntax is deprecated. ` +
        `Use [${issueKey}](${baseUrl}/browse/${issueKey}) instead.`
      );
    }

    const placeholder = `<!--MACRO_PLACEHOLDER_${placeholderIndex++}-->`;
    let html = `<ac:structured-macro ac:name="jira"><ac:parameter ac:name="key">${escapeHtml(issueKey)}</ac:parameter>`;
    if (jiraOpts) {
      // Parse options - handle columns= specially since it can contain commas
      // First extract columns= if present
      const columnsMatch = jiraOpts.match(/columns=([^,]*(?:,[^,=]*)*?)(?:,(?=\w+=)|,(?=showSummary|count)|$)/);
      let remainingOpts = jiraOpts;
      if (columnsMatch) {
        html += `<ac:parameter ac:name="columns">${escapeHtml(columnsMatch[1])}</ac:parameter>`;
        remainingOpts = jiraOpts.replace(columnsMatch[0], "").replace(/^,|,$/g, "");
      }
      // Parse remaining simple options
      const simpleOpts = remainingOpts.split(",").map((o: string) => o.trim()).filter(Boolean);
      for (const opt of simpleOpts) {
        if (opt === "showSummary") {
          html += `<ac:parameter ac:name="showSummary">true</ac:parameter>`;
        } else if (opt === "count") {
          html += `<ac:parameter ac:name="count">true</ac:parameter>`;
        }
      }
    }
    html += `</ac:structured-macro>`;
    macros.push({ placeholder, html });
    return placeholder;
  });

  // Handle date macros: {date:2024-01-15}
  processed = processed.replace(DATE_REGEX, (_, dateValue) => {
    const placeholder = `<!--MACRO_PLACEHOLDER_${placeholderIndex++}-->`;
    const html = `<time datetime="${escapeHtml(dateValue)}" />`;
    macros.push({ placeholder, html });
    return placeholder;
  });

  // Handle panel macro with parameters: :::panel title="Title" bgColor="#fff"
  processed = processed.replace(PANEL_MACRO_REGEX, (_, params, content) => {
    const placeholder = `<!--MACRO_PLACEHOLDER_${placeholderIndex++}-->`;
    const trimmedContent = (content || "").trim();

    // Parse parameters
    const titleMatch = params?.match(/title="([^"]*)"/i);
    const bgColorMatch = params?.match(/bgColor="([^"]*)"/i);
    const borderColorMatch = params?.match(/borderColor="([^"]*)"/i);

    let panelHtml = `<ac:structured-macro ac:name="panel">`;
    if (titleMatch) {
      panelHtml += `\n<ac:parameter ac:name="title">${escapeHtml(titleMatch[1])}</ac:parameter>`;
    }
    if (bgColorMatch) {
      panelHtml += `\n<ac:parameter ac:name="bgColor">${escapeHtml(bgColorMatch[1])}</ac:parameter>`;
    }
    if (borderColorMatch) {
      panelHtml += `\n<ac:parameter ac:name="borderColor">${escapeHtml(borderColorMatch[1])}</ac:parameter>`;
    }
    panelHtml += `\n<ac:rich-text-body>\n${md.render(trimmedContent).trim()}\n</ac:rich-text-body>\n</ac:structured-macro>`;

    macros.push({ placeholder, html: panelHtml });
    return placeholder;
  });

  // Handle excerpt macro: :::excerpt name="intro" hidden
  processed = processed.replace(EXCERPT_MACRO_REGEX, (_, params, content) => {
    const placeholder = `<!--MACRO_PLACEHOLDER_${placeholderIndex++}-->`;
    const trimmedContent = (content || "").trim();

    // Parse parameters
    const nameMatch = params?.match(/name="([^"]*)"/i);
    const hasHidden = params ? /\bhidden\b/i.test(params) : false;

    let excerptHtml = `<ac:structured-macro ac:name="excerpt">`;
    if (nameMatch) {
      excerptHtml += `\n<ac:parameter ac:name="name">${escapeHtml(nameMatch[1])}</ac:parameter>`;
    }
    if (hasHidden) {
      excerptHtml += `\n<ac:parameter ac:name="hidden">true</ac:parameter>`;
    }
    excerptHtml += `\n<ac:rich-text-body>\n${md.render(trimmedContent).trim()}\n</ac:rich-text-body>\n</ac:structured-macro>`;

    macros.push({ placeholder, html: excerptHtml });
    return placeholder;
  });

  // Handle excerpt-include macro: :::excerpt-include page="id" name="name"
  processed = processed.replace(EXCERPT_INCLUDE_REGEX, (_, params) => {
    const placeholder = `<!--MACRO_PLACEHOLDER_${placeholderIndex++}-->`;

    // Parse parameters
    const pageMatch = params?.match(/page="([^"]*)"/i);
    const nameMatch = params?.match(/name="([^"]*)"/i);
    const noPanelMatch = params ? /\bnopanel\b/i.test(params) : false;

    // excerpt-include uses ri:content-id for page reference
    let html = `<ac:structured-macro ac:name="excerpt-include">`;
    if (pageMatch) {
      html += `\n<ac:parameter ac:name=""><ri:page ri:content-id="${escapeHtml(pageMatch[1])}" /></ac:parameter>`;
    }
    if (nameMatch) {
      html += `\n<ac:parameter ac:name="name">${escapeHtml(nameMatch[1])}</ac:parameter>`;
    }
    if (noPanelMatch) {
      html += `\n<ac:parameter ac:name="nopanel">true</ac:parameter>`;
    }
    html += `\n</ac:structured-macro>`;

    macros.push({ placeholder, html });
    return placeholder;
  });

  // Handle include macro: :::include page="id"
  processed = processed.replace(INCLUDE_MACRO_REGEX, (_, params) => {
    const placeholder = `<!--MACRO_PLACEHOLDER_${placeholderIndex++}-->`;

    // Parse parameters
    const pageMatch = params?.match(/page="([^"]*)"/i);

    let html = `<ac:structured-macro ac:name="include">`;
    if (pageMatch) {
      html += `\n<ac:parameter ac:name=""><ri:page ri:content-id="${escapeHtml(pageMatch[1])}" /></ac:parameter>`;
    }
    html += `\n</ac:structured-macro>`;

    macros.push({ placeholder, html });
    return placeholder;
  });

  // Handle gallery macro: :::gallery columns=3
  processed = processed.replace(GALLERY_MACRO_REGEX, (_, params) => {
    const placeholder = `<!--MACRO_PLACEHOLDER_${placeholderIndex++}-->`;

    // Parse parameters
    const columnsMatch = params?.match(/columns=(\d+)/i);
    const includeMatch = params?.match(/include="([^"]*)"/i);
    const excludeMatch = params?.match(/exclude="([^"]*)"/i);

    let html = `<ac:structured-macro ac:name="gallery">`;
    if (columnsMatch) {
      html += `\n<ac:parameter ac:name="columns">${escapeHtml(columnsMatch[1])}</ac:parameter>`;
    }
    if (includeMatch) {
      html += `\n<ac:parameter ac:name="include">${escapeHtml(includeMatch[1])}</ac:parameter>`;
    }
    if (excludeMatch) {
      html += `\n<ac:parameter ac:name="exclude">${escapeHtml(excludeMatch[1])}</ac:parameter>`;
    }
    html += `\n</ac:structured-macro>`;

    macros.push({ placeholder, html });
    return placeholder;
  });

  // Handle attachments macro: :::attachments patterns="*.pdf"
  processed = processed.replace(ATTACHMENTS_MACRO_REGEX, (_, params) => {
    const placeholder = `<!--MACRO_PLACEHOLDER_${placeholderIndex++}-->`;

    // Parse parameters
    const patternsMatch = params?.match(/patterns="([^"]*)"/i);
    const sortMatch = params?.match(/sort="([^"]*)"/i);
    const oldMatch = params ? /\bold\b/i.test(params) : false;

    let html = `<ac:structured-macro ac:name="attachments">`;
    if (patternsMatch) {
      html += `\n<ac:parameter ac:name="patterns">${escapeHtml(patternsMatch[1])}</ac:parameter>`;
    }
    if (sortMatch) {
      html += `\n<ac:parameter ac:name="sort">${escapeHtml(sortMatch[1])}</ac:parameter>`;
    }
    if (oldMatch) {
      html += `\n<ac:parameter ac:name="old">true</ac:parameter>`;
    }
    html += `\n</ac:structured-macro>`;

    macros.push({ placeholder, html });
    return placeholder;
  });

  // Handle multimedia macro: :::multimedia file="video.mp4" width="640" height="480"
  // Multimedia is for ATTACHED files, not external URLs (use widget for external)
  // Uses ri:attachment with ri:filename
  processed = processed.replace(MULTIMEDIA_MACRO_REGEX, (_, params) => {
    const placeholder = `<!--MACRO_PLACEHOLDER_${placeholderIndex++}-->`;

    // Parse parameters
    const fileMatch = params?.match(/file="([^"]*)"/i);
    const widthMatch = params?.match(/width="([^"]*)"/i);
    const heightMatch = params?.match(/height="([^"]*)"/i);
    const autostartMatch = params ? /\bautostart\b/i.test(params) : false;

    let html = `<ac:structured-macro ac:name="multimedia">`;
    if (fileMatch) {
      // File parameter uses ri:attachment with ri:filename
      html += `\n<ac:parameter ac:name="name"><ri:attachment ri:filename="${escapeHtml(fileMatch[1])}" /></ac:parameter>`;
    }
    if (widthMatch) {
      html += `\n<ac:parameter ac:name="width">${escapeHtml(widthMatch[1])}</ac:parameter>`;
    }
    if (heightMatch) {
      html += `\n<ac:parameter ac:name="height">${escapeHtml(heightMatch[1])}</ac:parameter>`;
    }
    if (autostartMatch) {
      html += `\n<ac:parameter ac:name="autostart">true</ac:parameter>`;
    }
    html += `\n</ac:structured-macro>`;

    macros.push({ placeholder, html });
    return placeholder;
  });

  // Handle widget macro: :::widget url="..."
  // URL uses ri:url element with ri:value attribute
  processed = processed.replace(WIDGET_MACRO_REGEX, (_, params) => {
    const placeholder = `<!--MACRO_PLACEHOLDER_${placeholderIndex++}-->`;

    // Parse parameters
    const urlMatch = params?.match(/url="([^"]*)"/i);
    const widthMatch = params?.match(/width="([^"]*)"/i);
    const heightMatch = params?.match(/height="([^"]*)"/i);

    let html = `<ac:structured-macro ac:name="widget">`;
    if (heightMatch) {
      html += `\n<ac:parameter ac:name="height">${escapeHtml(heightMatch[1])}</ac:parameter>`;
    }
    if (widthMatch) {
      html += `\n<ac:parameter ac:name="width">${escapeHtml(widthMatch[1])}</ac:parameter>`;
    }
    if (urlMatch) {
      // URL parameter uses ri:url with ri:value attribute
      html += `\n<ac:parameter ac:name="url"><ri:url ri:value="${escapeHtml(urlMatch[1])}" /></ac:parameter>`;
    }
    html += `\n</ac:structured-macro>`;

    macros.push({ placeholder, html });
    return placeholder;
  });

  // Handle section macro with nested columns
  // Section contains column macros inside
  processed = processed.replace(SECTION_MACRO_REGEX, (_, params, content) => {
    const placeholder = `<!--MACRO_PLACEHOLDER_${placeholderIndex++}-->`;

    // Parse section parameters
    const hasBorder = params ? /\bborder\b/i.test(params) : false;

    // Process columns inside the section
    let columnsHtml = "";
    const columnRegex = /:::column(?:[ \t]+(.+))?\n([\s\S]*?):::column-end/gm;
    let columnMatch;

    while ((columnMatch = columnRegex.exec(content)) !== null) {
      const columnParams = columnMatch[1] || "";
      const columnContent = columnMatch[2].trim();

      const widthMatch = columnParams.match(/width="([^"]*)"/i);

      let columnHtml = `<ac:structured-macro ac:name="column">`;
      if (widthMatch) {
        columnHtml += `\n<ac:parameter ac:name="width">${escapeHtml(widthMatch[1])}</ac:parameter>`;
      }
      columnHtml += `\n<ac:rich-text-body>\n${md.render(columnContent).trim()}\n</ac:rich-text-body>\n</ac:structured-macro>`;
      columnsHtml += columnHtml + "\n";
    }

    let sectionHtml = `<ac:structured-macro ac:name="section">`;
    if (hasBorder) {
      sectionHtml += `\n<ac:parameter ac:name="border">true</ac:parameter>`;
    }
    sectionHtml += `\n<ac:rich-text-body>\n${columnsHtml}</ac:rich-text-body>\n</ac:structured-macro>`;

    macros.push({ placeholder, html: sectionHtml });
    return placeholder;
  });

  // Handle children macro: :::children depth=2 sort="title" all
  processed = processed.replace(CHILDREN_MACRO_REGEX, (_, params) => {
    const placeholder = `<!--MACRO_PLACEHOLDER_${placeholderIndex++}-->`;

    const depthMatch = params?.match(/depth=(\d+)/i);
    const sortMatch = params?.match(/sort="([^"]*)"/i);
    const pageMatch = params?.match(/page="([^"]*)"/i);
    const hasAll = params ? /\ball\b/i.test(params) : false;
    const hasReverse = params ? /\breverse\b/i.test(params) : false;

    let html = `<ac:structured-macro ac:name="children">`;
    if (pageMatch) {
      // Page parameter requires ac:link wrapper with ri:page element
      html += `\n<ac:parameter ac:name="page"><ac:link><ri:page ri:content-title="${escapeHtml(pageMatch[1])}" /></ac:link></ac:parameter>`;
    }
    if (depthMatch) {
      html += `\n<ac:parameter ac:name="depth">${escapeHtml(depthMatch[1])}</ac:parameter>`;
    }
    if (sortMatch) {
      html += `\n<ac:parameter ac:name="sort">${escapeHtml(sortMatch[1])}</ac:parameter>`;
    }
    if (hasAll) {
      html += `\n<ac:parameter ac:name="all">true</ac:parameter>`;
    }
    if (hasReverse) {
      html += `\n<ac:parameter ac:name="reverse">true</ac:parameter>`;
    }
    html += `\n</ac:structured-macro>`;

    macros.push({ placeholder, html });
    return placeholder;
  });

  // Handle content-by-label macro: :::content-by-label labels="label1,label2" spaces="SPACE" max=10
  processed = processed.replace(CONTENT_BY_LABEL_REGEX, (_, params) => {
    const placeholder = `<!--MACRO_PLACEHOLDER_${placeholderIndex++}-->`;

    const labelsMatch = params?.match(/labels="([^"]*)"/i);
    const spacesMatch = params?.match(/spaces="([^"]*)"/i);
    const maxMatch = params?.match(/max=(\d+)/i);
    const sortMatch = params?.match(/sort="([^"]*)"/i);

    let html = `<ac:structured-macro ac:name="contentbylabel">`;
    if (labelsMatch) {
      html += `\n<ac:parameter ac:name="labels">${escapeHtml(labelsMatch[1])}</ac:parameter>`;
    }
    if (spacesMatch) {
      html += `\n<ac:parameter ac:name="spaces">${escapeHtml(spacesMatch[1])}</ac:parameter>`;
    }
    if (maxMatch) {
      html += `\n<ac:parameter ac:name="max">${escapeHtml(maxMatch[1])}</ac:parameter>`;
    }
    if (sortMatch) {
      html += `\n<ac:parameter ac:name="sort">${escapeHtml(sortMatch[1])}</ac:parameter>`;
    }
    html += `\n</ac:structured-macro>`;

    macros.push({ placeholder, html });
    return placeholder;
  });

  // Handle recently-updated macro: :::recently-updated max=10 spaces="SPACE"
  processed = processed.replace(RECENTLY_UPDATED_REGEX, (_, params) => {
    const placeholder = `<!--MACRO_PLACEHOLDER_${placeholderIndex++}-->`;

    const maxMatch = params?.match(/max=(\d+)/i);
    const spacesMatch = params?.match(/spaces="([^"]*)"/i);
    const typesMatch = params?.match(/types="([^"]*)"/i);

    let html = `<ac:structured-macro ac:name="recently-updated">`;
    if (maxMatch) {
      html += `\n<ac:parameter ac:name="max">${escapeHtml(maxMatch[1])}</ac:parameter>`;
    }
    if (spacesMatch) {
      html += `\n<ac:parameter ac:name="spaces">${escapeHtml(spacesMatch[1])}</ac:parameter>`;
    }
    if (typesMatch) {
      html += `\n<ac:parameter ac:name="types">${escapeHtml(typesMatch[1])}</ac:parameter>`;
    }
    html += `\n</ac:structured-macro>`;

    macros.push({ placeholder, html });
    return placeholder;
  });

  // Handle pagetree macro: :::pagetree root="PageName" startDepth=2
  processed = processed.replace(PAGETREE_MACRO_REGEX, (_, params) => {
    const placeholder = `<!--MACRO_PLACEHOLDER_${placeholderIndex++}-->`;

    const rootMatch = params?.match(/root="([^"]*)"/i);
    const startDepthMatch = params?.match(/startDepth=(\d+)/i);
    const hasExpandCollapseAll = params ? /\bexpandCollapseAll\b/i.test(params) : false;
    const hasSearchBox = params ? /\bsearchBox\b/i.test(params) : false;

    let html = `<ac:structured-macro ac:name="pagetree">`;
    if (rootMatch) {
      // Root parameter requires ac:link wrapper with ri:page element
      html += `\n<ac:parameter ac:name="root"><ac:link><ri:page ri:content-title="${escapeHtml(rootMatch[1])}" /></ac:link></ac:parameter>`;
    }
    if (startDepthMatch) {
      html += `\n<ac:parameter ac:name="startDepth">${escapeHtml(startDepthMatch[1])}</ac:parameter>`;
    }
    if (hasExpandCollapseAll) {
      html += `\n<ac:parameter ac:name="expandCollapseAll">true</ac:parameter>`;
    }
    if (hasSearchBox) {
      html += `\n<ac:parameter ac:name="searchBox">true</ac:parameter>`;
    }
    html += `\n</ac:structured-macro>`;

    macros.push({ placeholder, html });
    return placeholder;
  });

  // Handle preserved :::confluence blocks (restore raw XML)
  processed = processed.replace(CONFLUENCE_MACRO_REGEX, (_, macroName, content) => {
    const placeholder = `<!--MACRO_PLACEHOLDER_${placeholderIndex++}-->`;

    // Extract raw XML from <!--raw ... --> comment
    const rawMatch = content.match(/<!--raw\n([\s\S]*?)\n-->/);
    if (rawMatch) {
      macros.push({ placeholder, html: rawMatch[1] });
    } else {
      // No raw content - create empty macro placeholder
      macros.push({ placeholder, html: `<!-- atlcli: ${macroName} macro content lost -->` });
    }

    return placeholder;
  });

  // Replace ::: blocks with placeholders
  processed = processed.replace(MACRO_REGEX, (_, macro, title, content) => {
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

  // Protect inline code from attachment processing
  // Replace `...` with placeholders to prevent matching attachment patterns inside code
  const inlineCodeBlocks: string[] = [];
  processed = processed.replace(/`[^`]+`/g, (match) => {
    const idx = inlineCodeBlocks.length;
    inlineCodeBlocks.push(match);
    return `<!--INLINE_CODE_${idx}-->`;
  });

  // Handle Confluence wiki attachment syntax: !filename.ext! or !filename.ext|alt text!
  // This allows users to use familiar Confluence syntax in markdown
  processed = processed.replace(
    /!([^|!\s]+\.\w+)(?:\|([^!]*))?!/g,
    (_, filename, alt) => {
      const placeholder = `<!--MACRO_PLACEHOLDER_${placeholderIndex++}-->`;
      // Determine if it's an image or other attachment
      if (isImageFile(filename)) {
        let html = `<ac:image><ri:attachment ri:filename="${escapeHtml(filename)}"`;
        if (alt) html += ` ac:alt="${escapeHtml(alt.trim())}"`;
        html += `/></ac:image>`;
        macros.push({ placeholder, html });
      } else {
        const linkText = alt?.trim() || filename;
        const html = `<ac:link><ri:attachment ri:filename="${escapeHtml(filename)}"/><ac:plain-text-link-body><![CDATA[${linkText}]]></ac:plain-text-link-body></ac:link>`;
        macros.push({ placeholder, html });
      }
      return placeholder;
    }
  );

  // Handle image attachments with size syntax: ![alt](./page.attachments/img.png){width=600}
  processed = processed.replace(
    /!\[([^\]]*)\]\(\.\/([\w.-]+\.attachments)\/([^)]+)\)\{([^}]+)\}/g,
    (_, alt, _attachDir, filename, sizeAttrs) => {
      const placeholder = `<!--MACRO_PLACEHOLDER_${placeholderIndex++}-->`;

      // Parse size attributes
      const widthMatch = sizeAttrs.match(/width=(\d+)/);
      const heightMatch = sizeAttrs.match(/height=(\d+)/);

      let html = `<ac:image`;
      if (widthMatch) html += ` ac:width="${widthMatch[1]}"`;
      if (heightMatch) html += ` ac:height="${heightMatch[1]}"`;
      html += `><ri:attachment ri:filename="${escapeHtml(filename)}"`;
      if (alt) html += ` ac:alt="${escapeHtml(alt)}"`;
      html += `/></ac:image>`;

      macros.push({ placeholder, html });
      return placeholder;
    }
  );

  // Handle image attachments: ![alt](./page.attachments/image.png)
  processed = processed.replace(LOCAL_IMAGE_REGEX, (_, alt, _attachDir, filename) => {
    const placeholder = `<!--MACRO_PLACEHOLDER_${placeholderIndex++}-->`;
    let html = `<ac:image><ri:attachment ri:filename="${escapeHtml(filename)}"`;
    if (alt) html += ` ac:alt="${escapeHtml(alt)}"`;
    html += `/></ac:image>`;
    macros.push({ placeholder, html });
    return placeholder;
  });

  // Handle non-image attachment links: [text](./page.attachments/file.pdf)
  // Only match if not already matched as an image (check extension)
  processed = processed.replace(LOCAL_ATTACHMENT_LINK_REGEX, (match, text, _attachDir, filename) => {
    // Skip if it's an image (already handled above)
    if (isImageFile(filename)) {
      return match;
    }

    const placeholder = `<!--MACRO_PLACEHOLDER_${placeholderIndex++}-->`;
    const html = `<ac:link><ri:attachment ri:filename="${escapeHtml(filename)}"/><ac:plain-text-link-body><![CDATA[${text}]]></ac:plain-text-link-body></ac:link>`;
    macros.push({ placeholder, html });
    return placeholder;
  });

  // Convert Atlassian URLs to smart links if baseUrl is provided
  // Matches: [text](url) or [text](url)<!--card--> or [text](url)<!--embed-->
  if (options?.baseUrl) {
    const smartLinkRegex = /\[([^\]]+)\]\(([^)]+)\)(?:<!--(card|embed)-->)?/g;
    processed = processed.replace(smartLinkRegex, (match, text, url, appearance) => {
      // Only convert if URL matches profile baseUrl and is an Atlassian URL
      if (!urlMatchesBaseUrl(url, options.baseUrl!) || !isAtlassianUrl(url)) {
        return match; // Leave as regular markdown link
      }

      const placeholder = `<!--MACRO_PLACEHOLDER_${placeholderIndex++}-->`;
      const displayMode = appearance || "inline";

      // Use anchor tag for all appearances - Confluence strips attributes from div elements
      // The data-card-appearance attribute controls display mode (inline/card/embed)
      const html = `<a href="${escapeHtml(url)}" data-card-appearance="${displayMode}">${escapeHtml(text)}</a>`;

      macros.push({ placeholder, html });
      return placeholder;
    });
  }

  // Restore inline code blocks before markdown rendering
  for (let i = 0; i < inlineCodeBlocks.length; i++) {
    processed = processed.replace(`<!--INLINE_CODE_${i}-->`, inlineCodeBlocks[i]);
  }

  // Render markdown
  let result = md.render(processed);

  // Convert task lists to Confluence ac:task-list format
  // markdown-it-task-lists produces: <ul class="contains-task-list"><li class="task-list-item"><input type="checkbox" disabled> text</li></ul>
  result = convertTaskListsToConfluence(result);

  // Replace placeholders with actual macro HTML
  for (const { placeholder, html } of macros) {
    // The placeholder might be wrapped in <p> tags
    result = result.replace(`<p>${placeholder}</p>`, html);
    result = result.replace(placeholder, html);
  }

  return result;
}

/**
 * Convert HTML task lists (from markdown-it-task-lists) to Confluence ac:task-list format.
 * Input: <ul class="contains-task-list"><li class="task-list-item"><input type="checkbox" disabled> text</li></ul>
 * Output: <ac:task-list><ac:task><ac:task-id>1</ac:task-id><ac:task-status>incomplete</ac:task-status><ac:task-body>text</ac:task-body></ac:task></ac:task-list>
 */
function convertTaskListsToConfluence(html: string): string {
  // Match task list ULs - they have class="contains-task-list"
  return html.replace(
    /<ul class="contains-task-list">([\s\S]*?)<\/ul>/gi,
    (_, listContent) => {
      let taskId = 1;
      const tasks: string[] = [];

      // Match each task list item - checkbox attributes can be in any order
      // With labelAfter: false, markdown-it-task-lists produces:
      // <li class="task-list-item"><label><input class="..." checked="" disabled="" type="checkbox"> content</label></li>
      const itemRegex = /<li class="task-list-item">\s*<label>\s*<input([^>]*)>\s*([\s\S]*?)<\/label>\s*<\/li>/gi;
      let itemMatch;
      while ((itemMatch = itemRegex.exec(listContent)) !== null) {
        const attrs = itemMatch[1];
        // Check if this is actually a checkbox (should always be, but verify)
        if (!/type="checkbox"/i.test(attrs)) continue;
        const isChecked = /\bchecked\b/i.test(attrs);
        const status = isChecked ? "complete" : "incomplete";
        // Get the task body content (after the checkbox, before </label>)
        const body = itemMatch[2].trim();

        tasks.push(
          `<ac:task>` +
          `<ac:task-id>${taskId++}</ac:task-id>` +
          `<ac:task-status>${status}</ac:task-status>` +
          `<ac:task-body>${body}</ac:task-body>` +
          `</ac:task>`
        );
      }

      if (tasks.length === 0) {
        // No tasks found, return original
        return `<ul class="contains-task-list">${listContent}</ul>`;
      }

      return `<ac:task-list>${tasks.join("")}</ac:task-list>`;
    }
  );
}

/**
 * Macros we explicitly convert to markdown syntax.
 * All others will be preserved as :::confluence blocks.
 */
const KNOWN_MACROS = ["info", "note", "warning", "tip", "expand", "toc", "status", "anchor", "jira", "panel", "code", "excerpt", "excerpt-include", "include", "gallery", "attachments", "multimedia", "widget", "section", "column", "children", "content-by-label", "recently-updated", "pagetree", "date"];

/**
 * Valid status colors in Confluence
 */
const STATUS_COLORS = ["grey", "red", "yellow", "green", "blue"];

/**
 * Regex for inline status macro: {status:color}text{status}
 */
const STATUS_REGEX = /\{status:(\w+)\}([^{]*)\{status\}/gi;

/**
 * Regex for anchor macro: {#anchor-name}
 */
const ANCHOR_REGEX = /\{#([a-zA-Z][a-zA-Z0-9_-]*)\}/g;

/**
 * Regex for jira macro: {jira:PROJ-123} or {jira:PROJ-123|showSummary}
 * Supports optional parameters after pipe: showSummary, count, etc.
 */
const JIRA_REGEX = /\{jira:([A-Z][A-Z0-9]*-\d+)(?:\|([^}]*))?\}/gi;

/**
 * Regex for date macro: {date:2024-01-15}
 * Supports ISO date format YYYY-MM-DD
 */
const DATE_REGEX = /\{date:(\d{4}-\d{2}-\d{2})\}/gi;

/**
 * Regex for panel macro with parameters: :::panel title="Title" bgColor="#fff"
 */
const PANEL_MACRO_REGEX = /^:::panel(?:[ \t]+(.+))?\n([\s\S]*?)^:::\s*$/gm;

/**
 * Regex for excerpt macro: :::excerpt name="name" hidden
 */
const EXCERPT_MACRO_REGEX = /^:::excerpt(?:[ \t]+(.+))?\n([\s\S]*?)^:::\s*$/gm;

/**
 * Regex for excerpt-include macro: :::excerpt-include page="id" name="name"
 */
const EXCERPT_INCLUDE_REGEX = /^:::excerpt-include(?:[ \t]+(.+))?\n?:::\s*$/gm;

/**
 * Regex for include macro: :::include page="id"
 */
const INCLUDE_MACRO_REGEX = /^:::include(?:[ \t]+(.+))?\n?:::\s*$/gm;

/**
 * Regex for gallery macro: :::gallery columns=3
 */
const GALLERY_MACRO_REGEX = /^:::gallery(?:[ \t]+(.+))?\n?:::\s*$/gm;

/**
 * Regex for attachments macro: :::attachments patterns="*.pdf"
 */
const ATTACHMENTS_MACRO_REGEX = /^:::attachments(?:[ \t]+(.+))?\n?:::\s*$/gm;

/**
 * Regex for multimedia macro: :::multimedia url="..."
 */
const MULTIMEDIA_MACRO_REGEX = /^:::multimedia(?:[ \t]+(.+))?\n?:::\s*$/gm;

/**
 * Regex for widget macro: :::widget url="..."
 */
const WIDGET_MACRO_REGEX = /^:::widget(?:[ \t]+(.+))?\n?:::\s*$/gm;

/**
 * Regex for section macro with nested columns: :::section ... :::column ... ::: ... :::
 * Uses a special delimiter :::section-end to avoid ambiguity with nested ::: blocks
 */
const SECTION_MACRO_REGEX = /^:::section(?:[ \t]+(.+))?\n([\s\S]*?)^:::section-end\s*$/gm;

/**
 * Regex for column macro inside section: :::column width="50%"
 */
const COLUMN_MACRO_REGEX = /^:::column(?:[ \t]+(.+))?\n([\s\S]*?)^:::column-end\s*$/gm;

/**
 * Regex for children macro: :::children depth=2 sort="title"
 */
const CHILDREN_MACRO_REGEX = /^:::children(?:[ \t]+(.+))?\n?:::\s*$/gm;

/**
 * Regex for content-by-label macro: :::content-by-label labels="label1,label2"
 */
const CONTENT_BY_LABEL_REGEX = /^:::content-by-label(?:[ \t]+(.+))?\n?:::\s*$/gm;

/**
 * Regex for recently-updated macro: :::recently-updated max=10
 */
const RECENTLY_UPDATED_REGEX = /^:::recently-updated(?:[ \t]+(.+))?\n?:::\s*$/gm;

/**
 * Regex for pagetree macro: :::pagetree root="PageName"
 */
const PAGETREE_MACRO_REGEX = /^:::pagetree(?:[ \t]+(.+))?\n?:::\s*$/gm;

/**
 * Regex for local attachment image references: ![alt](./path.attachments/image.png)
 * Matches images from .attachments/ directories
 */
const LOCAL_IMAGE_REGEX = /!\[([^\]]*)\]\(\.\/([\w.-]+\.attachments)\/([^)]+)\)/g;

/**
 * Regex for local non-image attachment links: [text](./path.attachments/file.pdf)
 * Matches file links from .attachments/ directories (but not images)
 */
const LOCAL_ATTACHMENT_LINK_REGEX = /\[([^\]]+)\]\(\.\/([\w.-]+\.attachments)\/([^)]+)\)/g;

/**
 * Regex for image size syntax: {width=600} or {width=600 height=400}
 * Applied after the image markdown
 */
const IMAGE_SIZE_REGEX = /!\[([^\]]*)\]\(([^)]+)\)\{([^}]+)\}/g;

/**
 * Image file extensions (case-insensitive check)
 */
const IMAGE_EXTENSIONS = [".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp", ".bmp", ".ico"];

/**
 * Check if a filename is an image based on extension
 */
export function isImageFile(filename: string): boolean {
  const ext = filename.toLowerCase().slice(filename.lastIndexOf("."));
  return IMAGE_EXTENSIONS.includes(ext);
}

/**
 * Replace generic attachment paths with page-specific paths.
 * Converts ./attachments/file.ext to ./page.attachments/file.ext
 * @param markdown The markdown content with generic attachment paths
 * @param pageFilename The page filename (e.g., "architecture.md")
 * @returns Markdown with page-specific attachment paths
 */
export function replaceAttachmentPaths(markdown: string, pageFilename: string): string {
  // Get the base name without extension
  const baseName = pageFilename.replace(/\.md$/i, "");
  const attachmentsDir = `${baseName}.attachments`;

  // Replace image references: ![alt](./attachments/file) -> ![alt](./page.attachments/file)
  let result = markdown.replace(
    /!\[([^\]]*)\]\(\.\/attachments\/([^)]+)\)/g,
    `![$1](./${attachmentsDir}/$2)`
  );

  // Replace link references: [text](./attachments/file) -> [text](./page.attachments/file)
  result = result.replace(
    /\[([^\]]+)\]\(\.\/attachments\/([^)]+)\)/g,
    `[$1](./${attachmentsDir}/$2)`
  );

  return result;
}

/**
 * Extract all attachment references from markdown content.
 * Returns filenames referenced in the markdown (for sync comparison).
 * Excludes references inside code blocks and inline code.
 */
export function extractAttachmentRefs(markdown: string): string[] {
  const refs: Set<string> = new Set();

  // Remove code blocks and inline code to avoid matching examples
  const withoutCode = markdown
    .replace(/```[\s\S]*?```/g, "") // Remove fenced code blocks
    .replace(/`[^`]+`/g, ""); // Remove inline code

  // Match images: ![alt](./page.attachments/file.ext)
  const imageMatches = withoutCode.matchAll(/!\[[^\]]*\]\(\.\/([\w.-]+\.attachments)\/([^)]+)\)/g);
  for (const match of imageMatches) {
    refs.add(match[2]);
  }

  // Match images with size: ![alt](./page.attachments/file.ext){...}
  const imageSizeMatches = withoutCode.matchAll(/!\[[^\]]*\]\(\.\/([\w.-]+\.attachments)\/([^)]+)\)\{[^}]+\}/g);
  for (const match of imageSizeMatches) {
    refs.add(match[2]);
  }

  // Match links: [text](./page.attachments/file.ext)
  const linkMatches = withoutCode.matchAll(/\[[^\]]+\]\(\.\/([\w.-]+\.attachments)\/([^)]+)\)/g);
  for (const match of linkMatches) {
    // Exclude images (which start with !)
    refs.add(match[2]);
  }

  // Match Confluence wiki syntax: !filename.ext! or !filename.ext|alt!
  // This allows users to use the familiar Confluence syntax in markdown
  const wikiMatches = withoutCode.matchAll(/!([^|!\s]+\.\w+)(?:\|[^!]*)!/g);
  for (const match of wikiMatches) {
    refs.add(match[1]);
  }

  return Array.from(refs);
}

/**
 * Preprocess Confluence storage to convert macros to placeholder HTML
 * that turndown can process.
 */
function preprocessStorageMacros(storage: string, options?: ConversionOptions): string {
  // Convert smart links with data-card-appearance (inline mode)
  // <a href="..." data-card-appearance="inline">text</a>
  storage = storage.replace(
    /<a\s+href="([^"]+)"\s*data-card-appearance="(inline|card|embed)"[^>]*>([^<]*)<\/a>/gi,
    (_, url, appearance, text) => {
      return `<span data-smartlink="true" data-url="${escapeHtml(url)}" data-appearance="${appearance}" data-text="${escapeHtml(text)}">[${escapeHtml(text)}]</span>`;
    }
  );

  // Also handle href after data-card-appearance
  storage = storage.replace(
    /<a\s+data-card-appearance="(inline|card|embed)"[^>]*href="([^"]+)"[^>]*>([^<]*)<\/a>/gi,
    (_, appearance, url, text) => {
      return `<span data-smartlink="true" data-url="${escapeHtml(url)}" data-appearance="${appearance}" data-text="${escapeHtml(text)}">[${escapeHtml(text)}]</span>`;
    }
  );

  // Convert smart links wrapped in div (card/embed mode)
  // <div data-card-appearance="embed"><a href="...">text</a></div>
  storage = storage.replace(
    /<div\s+data-card-appearance="(card|embed)"[^>]*>\s*<a\s+href="([^"]+)"[^>]*>([^<]*)<\/a>\s*<\/div>/gi,
    (_, appearance, url, text) => {
      return `<div data-smartlink="true" data-url="${escapeHtml(url)}" data-appearance="${appearance}" data-text="${escapeHtml(text)}">[${escapeHtml(text)}]</div>`;
    }
  );

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

  // Convert toc macro (add placeholder text so turndown doesn't drop it)
  storage = storage.replace(
    /<ac:structured-macro\s+ac:name="toc"[^>]*\/?>([\s\S]*?<\/ac:structured-macro>)?/gi,
    () => `<div data-macro="toc">TOC</div>`
  );

  // Convert status macro (inline lozenge)
  storage = storage.replace(
    /<ac:structured-macro\s+ac:name="status"[^>]*>([\s\S]*?)<\/ac:structured-macro>/gi,
    (_, inner) => {
      const colorMatch = inner.match(/<ac:parameter\s+ac:name="colou?r"[^>]*>([^<]*)<\/ac:parameter>/i);
      const titleMatch = inner.match(/<ac:parameter\s+ac:name="title"[^>]*>([^<]*)<\/ac:parameter>/i);
      const color = colorMatch ? colorMatch[1].toLowerCase() : "grey";
      const title = titleMatch ? titleMatch[1] : "";
      return `<span data-macro="status" data-color="${escapeHtml(color)}" data-title="${escapeHtml(title)}">[${escapeHtml(title)}]</span>`;
    }
  );

  // Convert date macro (ac:structured-macro format)
  storage = storage.replace(
    /<ac:structured-macro\s+ac:name="date"[^>]*>([\s\S]*?)<\/ac:structured-macro>/gi,
    (_, inner) => {
      // Date can be in parameter with name="" or name="date"
      const dateMatch = inner.match(/<ac:parameter\s+ac:name="[^"]*"[^>]*>([^<]*)<\/ac:parameter>/i);
      const dateValue = dateMatch ? dateMatch[1] : "";
      return `<span data-macro="date" data-date="${escapeHtml(dateValue)}">${escapeHtml(dateValue)}</span>`;
    }
  );

  // Convert HTML5 time element to date macro placeholder
  storage = storage.replace(
    /<time\s+datetime="([^"]+)"[^>]*(?:\/>|><\/time>)/gi,
    (_, dateValue) => {
      return `<span data-macro="date" data-date="${escapeHtml(dateValue)}">${escapeHtml(dateValue)}</span>`;
    }
  );

  // Convert anchor macro (use a zero-width space so turndown doesn't drop it)
  storage = storage.replace(
    /<ac:structured-macro\s+ac:name="anchor"[^>]*>([\s\S]*?)<\/ac:structured-macro>/gi,
    (_, inner) => {
      // Anchor name can be in parameter with name="" or name="0"
      const nameMatch = inner.match(/<ac:parameter\s+ac:name="[^"]*"[^>]*>([^<]*)<\/ac:parameter>/i);
      const anchorName = nameMatch ? nameMatch[1] : "";
      return `<span data-macro="anchor" data-name="${escapeHtml(anchorName)}">\u200B</span>`;
    }
  );

  // Convert jira macro (inline issue link)
  storage = storage.replace(
    /<ac:structured-macro\s+ac:name="jira"[^>]*>([\s\S]*?)<\/ac:structured-macro>/gi,
    (_, inner) => {
      const keyMatch = inner.match(/<ac:parameter\s+ac:name="key"[^>]*>([^<]*)<\/ac:parameter>/i);
      const showSummaryMatch = inner.match(/<ac:parameter\s+ac:name="showSummary"[^>]*>([^<]*)<\/ac:parameter>/i);
      const countMatch = inner.match(/<ac:parameter\s+ac:name="count"[^>]*>([^<]*)<\/ac:parameter>/i);
      const columnsMatch = inner.match(/<ac:parameter\s+ac:name="columns"[^>]*>([^<]*)<\/ac:parameter>/i);

      const key = keyMatch ? keyMatch[1] : "";
      const showSummary = showSummaryMatch ? showSummaryMatch[1].toLowerCase() === "true" : false;
      const count = countMatch ? countMatch[1].toLowerCase() === "true" : false;
      const columns = columnsMatch ? columnsMatch[1] : "";

      return `<span data-macro="jira" data-key="${escapeHtml(key)}" data-showsummary="${showSummary}" data-count="${count}" data-columns="${escapeHtml(columns)}">[${escapeHtml(key)}]</span>`;
    }
  );

  // Convert generic panel macro (with custom colors)
  storage = storage.replace(
    /<ac:structured-macro\s+ac:name="panel"[^>]*>([\s\S]*?)<\/ac:structured-macro>/gi,
    (_, inner) => {
      const titleMatch = inner.match(/<ac:parameter\s+ac:name="title"[^>]*>([^<]*)<\/ac:parameter>/i);
      const bgColorMatch = inner.match(/<ac:parameter\s+ac:name="bgColor"[^>]*>([^<]*)<\/ac:parameter>/i);
      const borderColorMatch = inner.match(/<ac:parameter\s+ac:name="borderColor"[^>]*>([^<]*)<\/ac:parameter>/i);
      const bodyMatch = inner.match(/<ac:rich-text-body>([\s\S]*?)<\/ac:rich-text-body>/i);

      const title = titleMatch ? titleMatch[1] : "";
      const bgColor = bgColorMatch ? bgColorMatch[1] : "";
      const borderColor = borderColorMatch ? borderColorMatch[1] : "";
      const body = bodyMatch ? bodyMatch[1] : "";

      return `<div data-macro="panel" data-title="${escapeHtml(title)}" data-bgcolor="${escapeHtml(bgColor)}" data-bordercolor="${escapeHtml(borderColor)}">${body}</div>`;
    }
  );

  // Convert code macro (with language, title, collapse)
  storage = storage.replace(
    /<ac:structured-macro\s+ac:name="code"[^>]*>([\s\S]*?)<\/ac:structured-macro>/gi,
    (_, inner) => {
      const langMatch = inner.match(/<ac:parameter\s+ac:name="language"[^>]*>([^<]*)<\/ac:parameter>/i);
      const titleMatch = inner.match(/<ac:parameter\s+ac:name="title"[^>]*>([^<]*)<\/ac:parameter>/i);
      const collapseMatch = inner.match(/<ac:parameter\s+ac:name="collapse"[^>]*>([^<]*)<\/ac:parameter>/i);
      // Code is in plain-text-body, possibly wrapped in CDATA
      const bodyMatch = inner.match(/<ac:plain-text-body>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/ac:plain-text-body>/i);

      const lang = langMatch ? langMatch[1] : "";
      const title = titleMatch ? titleMatch[1] : "";
      const collapse = collapseMatch ? collapseMatch[1] : "";
      const code = bodyMatch ? bodyMatch[1] : "";

      return `<pre data-macro="code" data-lang="${escapeHtml(lang)}" data-title="${escapeHtml(title)}" data-collapse="${escapeHtml(collapse)}"><code>${escapeHtml(code)}</code></pre>`;
    }
  );

  // Convert excerpt macro
  storage = storage.replace(
    /<ac:structured-macro\s+ac:name="excerpt"[^>]*>([\s\S]*?)<\/ac:structured-macro>/gi,
    (_, inner) => {
      const nameMatch = inner.match(/<ac:parameter\s+ac:name="name"[^>]*>([^<]*)<\/ac:parameter>/i);
      const hiddenMatch = inner.match(/<ac:parameter\s+ac:name="hidden"[^>]*>([^<]*)<\/ac:parameter>/i);
      const bodyMatch = inner.match(/<ac:rich-text-body>([\s\S]*?)<\/ac:rich-text-body>/i);

      const name = nameMatch ? nameMatch[1] : "";
      const hidden = hiddenMatch ? hiddenMatch[1].toLowerCase() === "true" : false;
      const body = bodyMatch ? bodyMatch[1] : "";

      return `<div data-macro="excerpt" data-name="${escapeHtml(name)}" data-hidden="${hidden}">${body}</div>`;
    }
  );

  // Convert excerpt-include macro
  storage = storage.replace(
    /<ac:structured-macro\s+ac:name="excerpt-include"[^>]*>([\s\S]*?)<\/ac:structured-macro>/gi,
    (_, inner) => {
      // Page reference can be ri:content-id or ri:content-title
      const pageIdMatch = inner.match(/<ri:page[^>]*ri:content-id="([^"]*)"[^>]*\/>/i);
      const pageTitleMatch = inner.match(/<ri:page[^>]*ri:content-title="([^"]*)"[^>]*\/>/i);
      const nameMatch = inner.match(/<ac:parameter\s+ac:name="name"[^>]*>([^<]*)<\/ac:parameter>/i);
      const noPanelMatch = inner.match(/<ac:parameter\s+ac:name="nopanel"[^>]*>([^<]*)<\/ac:parameter>/i);

      const pageId = pageIdMatch ? pageIdMatch[1] : "";
      const pageTitle = pageTitleMatch ? pageTitleMatch[1] : "";
      const name = nameMatch ? nameMatch[1] : "";
      const noPanel = noPanelMatch ? noPanelMatch[1].toLowerCase() === "true" : false;

      return `<div data-macro="excerpt-include" data-page-id="${escapeHtml(pageId)}" data-page-title="${escapeHtml(pageTitle)}" data-name="${escapeHtml(name)}" data-nopanel="${noPanel}">*[excerpt-include]*</div>`;
    }
  );

  // Convert include macro
  storage = storage.replace(
    /<ac:structured-macro\s+ac:name="include"[^>]*>([\s\S]*?)<\/ac:structured-macro>/gi,
    (_, inner) => {
      // Page reference can be ri:content-id or ri:content-title
      const pageIdMatch = inner.match(/<ri:page[^>]*ri:content-id="([^"]*)"[^>]*\/>/i);
      const pageTitleMatch = inner.match(/<ri:page[^>]*ri:content-title="([^"]*)"[^>]*\/>/i);

      const pageId = pageIdMatch ? pageIdMatch[1] : "";
      const pageTitle = pageTitleMatch ? pageTitleMatch[1] : "";

      return `<div data-macro="include" data-page-id="${escapeHtml(pageId)}" data-page-title="${escapeHtml(pageTitle)}">*[include]*</div>`;
    }
  );

  // Convert gallery macro
  storage = storage.replace(
    /<ac:structured-macro\s+ac:name="gallery"[^>]*>([\s\S]*?)<\/ac:structured-macro>/gi,
    (_, inner) => {
      const columnsMatch = inner.match(/<ac:parameter\s+ac:name="columns"[^>]*>([^<]*)<\/ac:parameter>/i);
      const includeMatch = inner.match(/<ac:parameter\s+ac:name="include"[^>]*>([^<]*)<\/ac:parameter>/i);
      const excludeMatch = inner.match(/<ac:parameter\s+ac:name="exclude"[^>]*>([^<]*)<\/ac:parameter>/i);

      const columns = columnsMatch ? columnsMatch[1] : "";
      const include = includeMatch ? includeMatch[1] : "";
      const exclude = excludeMatch ? excludeMatch[1] : "";

      return `<div data-macro="gallery" data-columns="${escapeHtml(columns)}" data-include="${escapeHtml(include)}" data-exclude="${escapeHtml(exclude)}">*[gallery]*</div>`;
    }
  );

  // Convert gallery macro (self-closing)
  storage = storage.replace(
    /<ac:structured-macro\s+ac:name="gallery"[^>]*\/>/gi,
    () => `<div data-macro="gallery" data-columns="" data-include="" data-exclude="">*[gallery]*</div>`
  );

  // Convert attachments macro
  storage = storage.replace(
    /<ac:structured-macro\s+ac:name="attachments"[^>]*>([\s\S]*?)<\/ac:structured-macro>/gi,
    (_, inner) => {
      const patternsMatch = inner.match(/<ac:parameter\s+ac:name="patterns"[^>]*>([^<]*)<\/ac:parameter>/i);
      const sortMatch = inner.match(/<ac:parameter\s+ac:name="sort"[^>]*>([^<]*)<\/ac:parameter>/i);
      const oldMatch = inner.match(/<ac:parameter\s+ac:name="old"[^>]*>([^<]*)<\/ac:parameter>/i);

      const patterns = patternsMatch ? patternsMatch[1] : "";
      const sort = sortMatch ? sortMatch[1] : "";
      const old = oldMatch ? oldMatch[1].toLowerCase() === "true" : false;

      return `<div data-macro="attachments" data-patterns="${escapeHtml(patterns)}" data-sort="${escapeHtml(sort)}" data-old="${old}">*[attachments]*</div>`;
    }
  );

  // Convert attachments macro (self-closing)
  storage = storage.replace(
    /<ac:structured-macro\s+ac:name="attachments"[^>]*\/>/gi,
    () => `<div data-macro="attachments" data-patterns="" data-sort="" data-old="false">*[attachments]*</div>`
  );

  // Convert multimedia macro
  // Multimedia is for attached files, uses ri:attachment with ri:filename
  storage = storage.replace(
    /<ac:structured-macro\s+ac:name="multimedia"[^>]*>([\s\S]*?)<\/ac:structured-macro>/gi,
    (_, inner) => {
      // File attachment via ri:attachment
      const fileMatch = inner.match(/<ri:attachment\s+ri:filename="([^"]*)"[^>]*\/>/i);
      const widthMatch = inner.match(/<ac:parameter\s+ac:name="width"[^>]*>([^<]*)<\/ac:parameter>/i);
      const heightMatch = inner.match(/<ac:parameter\s+ac:name="height"[^>]*>([^<]*)<\/ac:parameter>/i);
      const autostartMatch = inner.match(/<ac:parameter\s+ac:name="autostart"[^>]*>([^<]*)<\/ac:parameter>/i);

      const file = fileMatch ? fileMatch[1] : "";
      const width = widthMatch ? widthMatch[1] : "";
      const height = heightMatch ? heightMatch[1] : "";
      const autostart = autostartMatch ? autostartMatch[1].toLowerCase() === "true" : false;

      return `<div data-macro="multimedia" data-file="${escapeHtml(file)}" data-width="${escapeHtml(width)}" data-height="${escapeHtml(height)}" data-autostart="${autostart}">*[multimedia]*</div>`;
    }
  );

  // Convert widget macro
  // URL can be either plain text or ri:url element with ri:value attribute
  storage = storage.replace(
    /<ac:structured-macro\s+ac:name="widget"[^>]*>([\s\S]*?)<\/ac:structured-macro>/gi,
    (_, inner) => {
      // Try ri:url format first, then plain text
      const riUrlMatch = inner.match(/<ac:parameter\s+ac:name="url"[^>]*>\s*<ri:url\s+ri:value="([^"]*)"[^>]*\/>\s*<\/ac:parameter>/i);
      const plainUrlMatch = inner.match(/<ac:parameter\s+ac:name="url"[^>]*>([^<]*)<\/ac:parameter>/i);
      const widthMatch = inner.match(/<ac:parameter\s+ac:name="width"[^>]*>([^<]*)<\/ac:parameter>/i);
      const heightMatch = inner.match(/<ac:parameter\s+ac:name="height"[^>]*>([^<]*)<\/ac:parameter>/i);

      const url = riUrlMatch ? riUrlMatch[1] : (plainUrlMatch ? plainUrlMatch[1] : "");
      const width = widthMatch ? widthMatch[1] : "";
      const height = heightMatch ? heightMatch[1] : "";

      return `<div data-macro="widget" data-url="${escapeHtml(url)}" data-width="${escapeHtml(width)}" data-height="${escapeHtml(height)}">*[widget]*</div>`;
    }
  );

  // Convert column macros FIRST (before section) to avoid nested regex issues
  // Column must be processed before section because section's body contains columns
  storage = storage.replace(
    /<ac:structured-macro\s+ac:name="column"[^>]*>([\s\S]*?)<\/ac:structured-macro>/gi,
    (_, inner) => {
      const widthMatch = inner.match(/<ac:parameter\s+ac:name="width"[^>]*>([^<]*)<\/ac:parameter>/i);
      const bodyMatch = inner.match(/<ac:rich-text-body>([\s\S]*?)<\/ac:rich-text-body>/i);

      const width = widthMatch ? widthMatch[1] : "";
      const body = bodyMatch ? bodyMatch[1] : "";

      return `<div data-macro="column" data-width="${escapeHtml(width)}">${body}</div>`;
    }
  );

  // Convert section macro (columns already converted to divs above)
  storage = storage.replace(
    /<ac:structured-macro\s+ac:name="section"[^>]*>([\s\S]*?)<\/ac:structured-macro>/gi,
    (_, inner) => {
      const borderMatch = inner.match(/<ac:parameter\s+ac:name="border"[^>]*>([^<]*)<\/ac:parameter>/i);
      const bodyMatch = inner.match(/<ac:rich-text-body>([\s\S]*?)<\/ac:rich-text-body>/i);

      const border = borderMatch ? borderMatch[1].toLowerCase() === "true" : false;
      const body = bodyMatch ? bodyMatch[1] : "";

      return `<div data-macro="section" data-border="${border}">${body}</div>`;
    }
  );

  // Convert children macro
  storage = storage.replace(
    /<ac:structured-macro\s+ac:name="children"[^>]*>([\s\S]*?)<\/ac:structured-macro>/gi,
    (_, inner) => {
      // Page parameter can be plain text OR ac:link with ri:page
      const pageLinkMatch = inner.match(/<ac:parameter\s+ac:name="page"[^>]*>[\s\S]*?<ri:page[^>]*ri:content-title="([^"]*)"[^>]*\/>[\s\S]*?<\/ac:parameter>/i);
      const pagePlainMatch = inner.match(/<ac:parameter\s+ac:name="page"[^>]*>([^<]+)<\/ac:parameter>/i);
      const depthMatch = inner.match(/<ac:parameter\s+ac:name="depth"[^>]*>([^<]*)<\/ac:parameter>/i);
      const sortMatch = inner.match(/<ac:parameter\s+ac:name="sort"[^>]*>([^<]*)<\/ac:parameter>/i);
      const allMatch = inner.match(/<ac:parameter\s+ac:name="all"[^>]*>([^<]*)<\/ac:parameter>/i);
      const reverseMatch = inner.match(/<ac:parameter\s+ac:name="reverse"[^>]*>([^<]*)<\/ac:parameter>/i);

      const page = pageLinkMatch ? pageLinkMatch[1] : (pagePlainMatch ? pagePlainMatch[1] : "");
      const depth = depthMatch ? depthMatch[1] : "";
      const sort = sortMatch ? sortMatch[1] : "";
      const all = allMatch ? allMatch[1].toLowerCase() === "true" : false;
      const reverse = reverseMatch ? reverseMatch[1].toLowerCase() === "true" : false;

      return `<div data-macro="children" data-page="${escapeHtml(page)}" data-depth="${escapeHtml(depth)}" data-sort="${escapeHtml(sort)}" data-all="${all}" data-reverse="${reverse}">*[children]*</div>`;
    }
  );

  // Convert children macro (self-closing)
  storage = storage.replace(
    /<ac:structured-macro\s+ac:name="children"[^>]*\/>/gi,
    () => `<div data-macro="children" data-page="" data-depth="" data-sort="" data-all="false" data-reverse="false">*[children]*</div>`
  );

  // Convert contentbylabel macro (note: Confluence uses "contentbylabel" not "content-by-label")
  storage = storage.replace(
    /<ac:structured-macro\s+ac:name="contentbylabel"[^>]*>([\s\S]*?)<\/ac:structured-macro>/gi,
    (_, inner) => {
      const labelsMatch = inner.match(/<ac:parameter\s+ac:name="labels"[^>]*>([^<]*)<\/ac:parameter>/i);
      const spacesMatch = inner.match(/<ac:parameter\s+ac:name="spaces"[^>]*>([^<]*)<\/ac:parameter>/i);
      const maxMatch = inner.match(/<ac:parameter\s+ac:name="max"[^>]*>([^<]*)<\/ac:parameter>/i);
      const sortMatch = inner.match(/<ac:parameter\s+ac:name="sort"[^>]*>([^<]*)<\/ac:parameter>/i);

      const labels = labelsMatch ? labelsMatch[1] : "";
      const spaces = spacesMatch ? spacesMatch[1] : "";
      const max = maxMatch ? maxMatch[1] : "";
      const sort = sortMatch ? sortMatch[1] : "";

      return `<div data-macro="content-by-label" data-labels="${escapeHtml(labels)}" data-spaces="${escapeHtml(spaces)}" data-max="${escapeHtml(max)}" data-sort="${escapeHtml(sort)}">*[content-by-label]*</div>`;
    }
  );

  // Convert contentbylabel macro (self-closing)
  storage = storage.replace(
    /<ac:structured-macro\s+ac:name="contentbylabel"[^>]*\/>/gi,
    () => `<div data-macro="content-by-label" data-labels="" data-spaces="" data-max="" data-sort="">*[content-by-label]*</div>`
  );

  // Convert recently-updated macro
  storage = storage.replace(
    /<ac:structured-macro\s+ac:name="recently-updated"[^>]*>([\s\S]*?)<\/ac:structured-macro>/gi,
    (_, inner) => {
      const maxMatch = inner.match(/<ac:parameter\s+ac:name="max"[^>]*>([^<]*)<\/ac:parameter>/i);
      const spacesMatch = inner.match(/<ac:parameter\s+ac:name="spaces"[^>]*>([^<]*)<\/ac:parameter>/i);
      const typesMatch = inner.match(/<ac:parameter\s+ac:name="types"[^>]*>([^<]*)<\/ac:parameter>/i);

      const max = maxMatch ? maxMatch[1] : "";
      const spaces = spacesMatch ? spacesMatch[1] : "";
      const types = typesMatch ? typesMatch[1] : "";

      return `<div data-macro="recently-updated" data-max="${escapeHtml(max)}" data-spaces="${escapeHtml(spaces)}" data-types="${escapeHtml(types)}">*[recently-updated]*</div>`;
    }
  );

  // Convert recently-updated macro (self-closing)
  storage = storage.replace(
    /<ac:structured-macro\s+ac:name="recently-updated"[^>]*\/>/gi,
    () => `<div data-macro="recently-updated" data-max="" data-spaces="" data-types="">*[recently-updated]*</div>`
  );

  // Convert pagetree macro
  storage = storage.replace(
    /<ac:structured-macro\s+ac:name="pagetree"[^>]*>([\s\S]*?)<\/ac:structured-macro>/gi,
    (_, inner) => {
      // Root parameter can be plain text OR ac:link with ri:page
      const rootLinkMatch = inner.match(/<ac:parameter\s+ac:name="root"[^>]*>[\s\S]*?<ri:page[^>]*ri:content-title="([^"]*)"[^>]*\/>[\s\S]*?<\/ac:parameter>/i);
      const rootPlainMatch = inner.match(/<ac:parameter\s+ac:name="root"[^>]*>([^<]+)<\/ac:parameter>/i);
      const startDepthMatch = inner.match(/<ac:parameter\s+ac:name="startDepth"[^>]*>([^<]*)<\/ac:parameter>/i);
      const expandCollapseAllMatch = inner.match(/<ac:parameter\s+ac:name="expandCollapseAll"[^>]*>([^<]*)<\/ac:parameter>/i);
      const searchBoxMatch = inner.match(/<ac:parameter\s+ac:name="searchBox"[^>]*>([^<]*)<\/ac:parameter>/i);

      const root = rootLinkMatch ? rootLinkMatch[1] : (rootPlainMatch ? rootPlainMatch[1] : "");
      const startDepth = startDepthMatch ? startDepthMatch[1] : "";
      const expandCollapseAll = expandCollapseAllMatch ? expandCollapseAllMatch[1].toLowerCase() === "true" : false;
      const searchBox = searchBoxMatch ? searchBoxMatch[1].toLowerCase() === "true" : false;

      return `<div data-macro="pagetree" data-root="${escapeHtml(root)}" data-startdepth="${escapeHtml(startDepth)}" data-expandcollapseall="${expandCollapseAll}" data-searchbox="${searchBox}">*[pagetree]*</div>`;
    }
  );

  // Convert pagetree macro (self-closing)
  storage = storage.replace(
    /<ac:structured-macro\s+ac:name="pagetree"[^>]*\/>/gi,
    () => `<div data-macro="pagetree" data-root="" data-startdepth="" data-expandcollapseall="false" data-searchbox="false">*[pagetree]*</div>`
  );

  // Convert ac:task-list (Confluence native tasks) to HTML checkbox list
  // This allows turndown's taskList rule to convert them to markdown task syntax
  storage = storage.replace(
    /<ac:task-list>([\s\S]*?)<\/ac:task-list>/gi,
    (_, inner) => {
      // Extract all tasks from the task list
      const taskItems: string[] = [];
      const taskRegex = /<ac:task>([\s\S]*?)<\/ac:task>/gi;
      let taskMatch;
      while ((taskMatch = taskRegex.exec(inner)) !== null) {
        const taskContent = taskMatch[1];
        // Extract status (complete/incomplete)
        const statusMatch = taskContent.match(/<ac:task-status>([^<]*)<\/ac:task-status>/i);
        const isComplete = statusMatch && statusMatch[1].toLowerCase() === "complete";
        // Extract task body - may contain HTML like spans
        const bodyMatch = taskContent.match(/<ac:task-body>([\s\S]*?)<\/ac:task-body>/i);
        const body = bodyMatch ? bodyMatch[1] : "";
        // Create checkbox input
        const checkbox = isComplete ? '<input type="checkbox" checked>' : '<input type="checkbox">';
        taskItems.push(`<li>${checkbox} ${body}</li>`);
      }
      return `<ul class="task-list">${taskItems.join("")}</ul>`;
    }
  );

  // Convert ac:image with ri:attachment (image attachments)
  // Handles: <ac:image ac:width="600"><ri:attachment ri:filename="img.png" ac:alt="Alt text"/></ac:image>
  storage = storage.replace(
    /<ac:image(?:\s+ac:width="(\d+)")?(?:\s+ac:height="(\d+)")?[^>]*>\s*<ri:attachment\s+ri:filename="([^"]+)"(?:\s+ac:alt="([^"]*)")?[^>]*\/>\s*<\/ac:image>/gi,
    (_, width, height, filename, alt) => {
      let attrs = `data-attachment="true" data-filename="${escapeHtml(filename)}"`;
      if (alt) attrs += ` alt="${escapeHtml(alt)}"`;
      if (width) attrs += ` data-width="${width}"`;
      if (height) attrs += ` data-height="${height}"`;
      return `<img ${attrs} src="./${escapeHtml(filename)}">`;
    }
  );

  // Also handle alternative attribute order and self-closing variations
  storage = storage.replace(
    /<ac:image[^>]*>\s*<ri:attachment[^>]*ri:filename="([^"]+)"[^>]*(?:ac:alt="([^"]*)")?[^>]*\/>\s*<\/ac:image>/gi,
    (match, filename, alt) => {
      // Skip if already processed
      if (match.includes("data-attachment")) return match;

      // Extract width/height from the ac:image tag
      const widthMatch = match.match(/ac:width="(\d+)"/);
      const heightMatch = match.match(/ac:height="(\d+)"/);

      let attrs = `data-attachment="true" data-filename="${escapeHtml(filename)}"`;
      if (alt) attrs += ` alt="${escapeHtml(alt)}"`;
      if (widthMatch) attrs += ` data-width="${widthMatch[1]}"`;
      if (heightMatch) attrs += ` data-height="${heightMatch[1]}"`;
      return `<img ${attrs} src="./${escapeHtml(filename)}">`;
    }
  );

  // Convert ac:link with ri:attachment (file attachment links)
  // Handles: <ac:link><ri:attachment ri:filename="doc.pdf"/><ac:plain-text-link-body><![CDATA[Document]]></ac:plain-text-link-body></ac:link>
  storage = storage.replace(
    /<ac:link[^>]*>\s*<ri:attachment\s+ri:filename="([^"]+)"[^>]*\/>\s*<ac:plain-text-link-body>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/ac:plain-text-link-body>\s*<\/ac:link>/gi,
    (_, filename, linkText) => {
      return `<a data-attachment="true" data-filename="${escapeHtml(filename)}" href="./${escapeHtml(filename)}">${escapeHtml(linkText.trim())}</a>`;
    }
  );

  // Handle ac:link with ri:attachment but without plain-text-link-body (just use filename as text)
  storage = storage.replace(
    /<ac:link[^>]*>\s*<ri:attachment\s+ri:filename="([^"]+)"[^>]*\/>\s*<\/ac:link>/gi,
    (_, filename) => {
      return `<a data-attachment="true" data-filename="${escapeHtml(filename)}" href="./${escapeHtml(filename)}">${escapeHtml(filename)}</a>`;
    }
  );

  // Preserve all unknown/3rd-party macros (whitelist approach)
  // IMPORTANT: Handle self-closing macros FIRST to prevent greedy matching
  storage = storage.replace(
    /<ac:structured-macro\s+ac:name="([^"]+)"[^>]*\/>/gi,
    (fullMatch, macroName) => {
      if (KNOWN_MACROS.includes(macroName.toLowerCase())) {
        return fullMatch;
      }
      const encodedRaw = encodeRawXml(fullMatch);
      return `<div data-macro="confluence" data-macro-name="${escapeHtml(macroName)}" data-raw="${encodedRaw}">*[${escapeHtml(macroName)} macro]*</div>`;
    }
  );

  // Then handle macros with body content
  storage = storage.replace(
    /<ac:structured-macro\s+ac:name="([^"]+)"[^>]*(?<!\/)>([\s\S]*?)<\/ac:structured-macro>/gi,
    (fullMatch, macroName) => {
      // Skip if it's a known macro (already handled above)
      if (KNOWN_MACROS.includes(macroName.toLowerCase())) {
        return fullMatch;
      }
      // Preserve unknown macro with raw XML
      const encodedRaw = encodeRawXml(fullMatch);
      return `<div data-macro="confluence" data-macro-name="${escapeHtml(macroName)}" data-raw="${encodedRaw}">*[${escapeHtml(macroName)} macro]*</div>`;
    }
  );

  return storage;
}

/**
 * Encode raw XML for safe storage in data attribute.
 */
function encodeRawXml(xml: string): string {
  return Buffer.from(xml, "utf-8").toString("base64");
}

/**
 * Decode raw XML from data attribute.
 */
function decodeRawXml(encoded: string): string {
  return Buffer.from(encoded, "base64").toString("utf-8");
}

/**
 * Convert Confluence storage format to markdown.
 * @param storage - The Confluence storage format HTML
 * @param options - Optional conversion options (baseUrl for smart link URLs)
 */
export function storageToMarkdown(storage: string, options?: ConversionOptions): string {
  // Preprocess Confluence macros
  const preprocessed = preprocessStorageMacros(storage, options);

  const service = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    emDelimiter: "*",
    strongDelimiter: "**",
  });
  service.use(gfm);

  // Handle inline status macro
  service.addRule("statusMacro", {
    filter: (node) => {
      return node.nodeName === "SPAN" && (node as any).getAttribute?.("data-macro") === "status";
    },
    replacement: (_content, node) => {
      const color = (node as any).getAttribute?.("data-color") || "grey";
      const title = (node as any).getAttribute?.("data-title") || "";
      return `{status:${color}}${title}{status}`;
    },
  });

  // Handle anchor macro
  service.addRule("anchorMacro", {
    filter: (node) => {
      return node.nodeName === "SPAN" && (node as any).getAttribute?.("data-macro") === "anchor";
    },
    replacement: (_content, node) => {
      const name = (node as any).getAttribute?.("data-name") || "";
      return name ? `{#${name}}` : "";
    },
  });

  // Handle date macro
  service.addRule("dateMacro", {
    filter: (node) => {
      return node.nodeName === "SPAN" && (node as any).getAttribute?.("data-macro") === "date";
    },
    replacement: (_content, node) => {
      const dateValue = (node as any).getAttribute?.("data-date") || "";
      return dateValue ? `{date:${dateValue}}` : "";
    },
  });

  // Handle jira macro - convert to full URL if baseUrl available
  service.addRule("jiraMacro", {
    filter: (node) => {
      return node.nodeName === "SPAN" && (node as any).getAttribute?.("data-macro") === "jira";
    },
    replacement: (_content, node) => {
      const key = (node as any).getAttribute?.("data-key") || "";
      const showSummary = (node as any).getAttribute?.("data-showsummary") === "true";
      const count = (node as any).getAttribute?.("data-count") === "true";
      const columns = (node as any).getAttribute?.("data-columns") || "";

      if (!key) return "";

      // If baseUrl is available, output full URL (preferred format)
      if (options?.baseUrl) {
        const url = `${options.baseUrl}/browse/${key}`;
        return `[${key}](${url})`;
      }

      // Fallback to legacy {jira:KEY} syntax if no baseUrl
      const opts: string[] = [];
      if (showSummary) opts.push("showSummary");
      if (count) opts.push("count");
      if (columns) opts.push(`columns=${columns}`);

      if (opts.length > 0) {
        return `{jira:${key}|${opts.join(",")}}`;
      }
      return `{jira:${key}}`;
    },
  });

  // Handle smart links (data-smartlink attribute)
  service.addRule("smartLink", {
    filter: (node) => {
      const tagName = node.nodeName;
      return (tagName === "SPAN" || tagName === "DIV") &&
             (node as any).getAttribute?.("data-smartlink") === "true";
    },
    replacement: (_content, node) => {
      const url = (node as any).getAttribute?.("data-url") || "";
      const text = (node as any).getAttribute?.("data-text") || "";
      const appearance = (node as any).getAttribute?.("data-appearance") || "inline";

      if (!url) return text || "";

      // Build markdown link
      let link = `[${text}](${url})`;

      // Add appearance annotation if not inline (default)
      if (appearance === "card" || appearance === "embed") {
        link += `<!--${appearance}-->`;
      }

      return link;
    },
  });

  // Handle attachment images: <img data-attachment="true" data-filename="..." ...>
  service.addRule("attachmentImage", {
    filter: (node) => {
      return node.nodeName === "IMG" && (node as any).getAttribute?.("data-attachment") === "true";
    },
    replacement: (_content, node) => {
      const filename = (node as any).getAttribute?.("data-filename") || "";
      const alt = (node as any).getAttribute?.("alt") || "";
      const width = (node as any).getAttribute?.("data-width") || "";
      const height = (node as any).getAttribute?.("data-height") || "";

      // Build markdown image with optional size syntax
      let result = `![${alt}](./attachments/${filename})`;

      // Add size attributes if present
      if (width || height) {
        const attrs: string[] = [];
        if (width) attrs.push(`width=${width}`);
        if (height) attrs.push(`height=${height}`);
        result += `{${attrs.join(" ")}}`;
      }

      return result;
    },
  });

  // Handle attachment links: <a data-attachment="true" data-filename="..." ...>text</a>
  service.addRule("attachmentLink", {
    filter: (node) => {
      return node.nodeName === "A" && (node as any).getAttribute?.("data-attachment") === "true";
    },
    replacement: (content, node) => {
      const filename = (node as any).getAttribute?.("data-filename") || "";
      const linkText = content.trim() || filename;
      return `[${linkText}](./attachments/${filename})`;
    },
  });

  // Handle Confluence macros converted to data-macro divs
  service.addRule("confluenceMacro", {
    filter: (node) => {
      return node.nodeName === "DIV" && (node as any).getAttribute?.("data-macro");
    },
    replacement: (content, node) => {
      const macroType = (node as any).getAttribute?.("data-macro") || "";
      const title = (node as any).getAttribute?.("data-title") || "";

      if (macroType === "toc") {
        return "\n\n:::toc\n:::\n\n";
      }

      if (macroType === "expand") {
        return `\n\n:::expand ${title}\n${content.trim()}\n:::\n\n`;
      }

      // Panel macros (info, note, warning, tip)
      if (PANEL_MACROS.includes(macroType)) {
        const titlePart = title ? ` ${title}` : "";
        return `\n\n:::${macroType}${titlePart}\n${content.trim()}\n:::\n\n`;
      }

      // Generic panel macro with custom colors
      if (macroType === "panel") {
        const bgColor = (node as any).getAttribute?.("data-bgcolor") || "";
        const borderColor = (node as any).getAttribute?.("data-bordercolor") || "";

        let params = "";
        if (title) params += ` title="${title}"`;
        if (bgColor) params += ` bgColor="${bgColor}"`;
        if (borderColor) params += ` borderColor="${borderColor}"`;

        return `\n\n:::panel${params}\n${content.trim()}\n:::\n\n`;
      }

      // Excerpt macro
      if (macroType === "excerpt") {
        const name = (node as any).getAttribute?.("data-name") || "";
        const hidden = (node as any).getAttribute?.("data-hidden") === "true";

        let params = "";
        if (name) params += ` name="${name}"`;
        if (hidden) params += " hidden";

        return `\n\n:::excerpt${params}\n${content.trim()}\n:::\n\n`;
      }

      // Excerpt-include macro
      if (macroType === "excerpt-include") {
        const pageId = (node as any).getAttribute?.("data-page-id") || "";
        const pageTitle = (node as any).getAttribute?.("data-page-title") || "";
        const name = (node as any).getAttribute?.("data-name") || "";
        const noPanel = (node as any).getAttribute?.("data-nopanel") === "true";

        let params = "";
        // Prefer page ID over title for consistency
        if (pageId) params += ` page="${pageId}"`;
        else if (pageTitle) params += ` page="${pageTitle}"`;
        if (name) params += ` name="${name}"`;
        if (noPanel) params += " nopanel";

        return `\n\n:::excerpt-include${params}\n:::\n\n`;
      }

      // Include macro
      if (macroType === "include") {
        const pageId = (node as any).getAttribute?.("data-page-id") || "";
        const pageTitle = (node as any).getAttribute?.("data-page-title") || "";

        let params = "";
        // Prefer page ID over title for consistency
        if (pageId) params += ` page="${pageId}"`;
        else if (pageTitle) params += ` page="${pageTitle}"`;

        return `\n\n:::include${params}\n:::\n\n`;
      }

      // Gallery macro
      if (macroType === "gallery") {
        const columns = (node as any).getAttribute?.("data-columns") || "";
        const include = (node as any).getAttribute?.("data-include") || "";
        const exclude = (node as any).getAttribute?.("data-exclude") || "";

        let params = "";
        if (columns) params += ` columns=${columns}`;
        if (include) params += ` include="${include}"`;
        if (exclude) params += ` exclude="${exclude}"`;

        return `\n\n:::gallery${params}\n:::\n\n`;
      }

      // Attachments macro
      if (macroType === "attachments") {
        const patterns = (node as any).getAttribute?.("data-patterns") || "";
        const sort = (node as any).getAttribute?.("data-sort") || "";
        const old = (node as any).getAttribute?.("data-old") === "true";

        let params = "";
        if (patterns) params += ` patterns="${patterns}"`;
        if (sort) params += ` sort="${sort}"`;
        if (old) params += " old";

        return `\n\n:::attachments${params}\n:::\n\n`;
      }

      // Multimedia macro (for attached files)
      if (macroType === "multimedia") {
        const file = (node as any).getAttribute?.("data-file") || "";
        const width = (node as any).getAttribute?.("data-width") || "";
        const height = (node as any).getAttribute?.("data-height") || "";
        const autostart = (node as any).getAttribute?.("data-autostart") === "true";

        let params = "";
        if (file) params += ` file="${file}"`;
        if (width) params += ` width="${width}"`;
        if (height) params += ` height="${height}"`;
        if (autostart) params += " autostart";

        return `\n\n:::multimedia${params}\n:::\n\n`;
      }

      // Widget macro
      if (macroType === "widget") {
        const url = (node as any).getAttribute?.("data-url") || "";
        const width = (node as any).getAttribute?.("data-width") || "";
        const height = (node as any).getAttribute?.("data-height") || "";

        let params = "";
        if (url) params += ` url="${url}"`;
        if (width) params += ` width="${width}"`;
        if (height) params += ` height="${height}"`;

        return `\n\n:::widget${params}\n:::\n\n`;
      }

      // Column macro (inside section) - must be processed BEFORE section
      // to ensure nested content is converted first
      if (macroType === "column") {
        const width = (node as any).getAttribute?.("data-width") || "";

        let params = "";
        if (width) params += ` width="${width}"`;

        return `\n:::column${params}\n${content.trim()}\n:::column-end\n`;
      }

      // Section macro (contains column macros)
      if (macroType === "section") {
        const border = (node as any).getAttribute?.("data-border") === "true";

        let params = "";
        if (border) params += " border";

        // Content will contain converted column divs
        return `\n\n:::section${params}\n${content}\n:::section-end\n\n`;
      }

      // Children macro (list child pages)
      if (macroType === "children") {
        const page = (node as any).getAttribute?.("data-page") || "";
        const depth = (node as any).getAttribute?.("data-depth") || "";
        const sort = (node as any).getAttribute?.("data-sort") || "";
        const all = (node as any).getAttribute?.("data-all") === "true";
        const reverse = (node as any).getAttribute?.("data-reverse") === "true";

        let params = "";
        if (page) params += ` page="${page}"`;
        if (depth) params += ` depth=${depth}`;
        if (sort) params += ` sort="${sort}"`;
        if (all) params += " all";
        if (reverse) params += " reverse";

        return `\n\n:::children${params}\n:::\n\n`;
      }

      // Content-by-label macro
      if (macroType === "content-by-label") {
        const labels = (node as any).getAttribute?.("data-labels") || "";
        const spaces = (node as any).getAttribute?.("data-spaces") || "";
        const max = (node as any).getAttribute?.("data-max") || "";
        const sort = (node as any).getAttribute?.("data-sort") || "";

        let params = "";
        if (labels) params += ` labels="${labels}"`;
        if (spaces) params += ` spaces="${spaces}"`;
        if (max) params += ` max=${max}`;
        if (sort) params += ` sort="${sort}"`;

        return `\n\n:::content-by-label${params}\n:::\n\n`;
      }

      // Recently-updated macro
      if (macroType === "recently-updated") {
        const max = (node as any).getAttribute?.("data-max") || "";
        const spaces = (node as any).getAttribute?.("data-spaces") || "";
        const types = (node as any).getAttribute?.("data-types") || "";

        let params = "";
        if (max) params += ` max=${max}`;
        if (spaces) params += ` spaces="${spaces}"`;
        if (types) params += ` types="${types}"`;

        return `\n\n:::recently-updated${params}\n:::\n\n`;
      }

      // Pagetree macro
      if (macroType === "pagetree") {
        const root = (node as any).getAttribute?.("data-root") || "";
        const startDepth = (node as any).getAttribute?.("data-startdepth") || "";
        const expandCollapseAll = (node as any).getAttribute?.("data-expandcollapseall") === "true";
        const searchBox = (node as any).getAttribute?.("data-searchbox") === "true";

        let params = "";
        if (root) params += ` root="${root}"`;
        if (startDepth) params += ` startDepth=${startDepth}`;
        if (expandCollapseAll) params += " expandCollapseAll";
        if (searchBox) params += " searchBox";

        return `\n\n:::pagetree${params}\n:::\n\n`;
      }

      // Preserved unknown/3rd-party macros
      if (macroType === "confluence") {
        const macroName = (node as any).getAttribute?.("data-macro-name") || "unknown";
        const rawEncoded = (node as any).getAttribute?.("data-raw") || "";

        if (rawEncoded) {
          const rawXml = decodeRawXml(rawEncoded);
          return `\n\n:::confluence ${macroName}\n<!--raw\n${rawXml}\n-->\n*[${macroName} macro]*\n:::\n\n`;
        }

        return `\n\n:::confluence ${macroName}\n*[${macroName} macro - no content]*\n:::\n\n`;
      }

      return content;
    },
  });

  service.addRule("preCodeFence", {
    filter: (node) => node.nodeName === "PRE" && node.firstChild?.nodeName === "CODE",
    replacement: (_content, node) => {
      const codeNode = (node.firstChild as any) ?? null;

      // Check if this is a Confluence code macro
      const isMacro = (node as any).getAttribute?.("data-macro") === "code";
      if (isMacro) {
        const lang = (node as any).getAttribute?.("data-lang") || "";
        const title = (node as any).getAttribute?.("data-title") || "";
        const collapse = (node as any).getAttribute?.("data-collapse") || "";
        const text = codeNode?.textContent ?? "";

        // Build info string with optional title and collapse
        let infoString = lang;
        if (title || collapse === "true") {
          // Use extended syntax: ```lang {title="..." collapse}
          let attrs = "";
          if (title) attrs += ` title="${title}"`;
          if (collapse === "true") attrs += " collapse";
          infoString = `${lang}{${attrs.trim()}}`;
        }

        return `\n\n\`\`\`${infoString}\n${text}\n\`\`\`\n\n`;
      }

      // Regular code block
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
