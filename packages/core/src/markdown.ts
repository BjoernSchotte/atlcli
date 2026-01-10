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
 */
export function markdownToStorage(markdown: string): string {
  const macros: { placeholder: string; html: string }[] = [];
  let placeholderIndex = 0;

  // Handle inline status macros: {status:color}text{status}
  let processed = markdown.replace(STATUS_REGEX, (_, color, text) => {
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

  // Render markdown
  let result = md.render(processed);

  // Replace placeholders with actual macro HTML
  for (const { placeholder, html } of macros) {
    // The placeholder might be wrapped in <p> tags
    result = result.replace(`<p>${placeholder}</p>`, html);
    result = result.replace(placeholder, html);
  }

  return result;
}

/**
 * Macros we explicitly convert to markdown syntax.
 * All others will be preserved as :::confluence blocks.
 */
const KNOWN_MACROS = ["info", "note", "warning", "tip", "expand", "toc", "status", "anchor", "panel", "code", "excerpt", "excerpt-include", "include", "gallery", "attachments", "multimedia", "widget"];

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
