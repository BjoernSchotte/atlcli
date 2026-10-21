/**
 * Markdown ↔ ADF conversion for Jira rich-text fields (descriptions, comments,
 * worklog comments). Spec: `specs/jira-content-workflows` A1.
 *
 * Browser-safe: no `node:`/`bun:` imports. The markdown dialect matches the
 * Confluence one in `packages/confluence/src/markdown.ts` (`@[Name](id)`,
 * `{date:…}`, `{status:…}…{status}`, `{jira:KEY}`, `:::info` panels) so users
 * write the same markdown for both products. The regexes are copied, not
 * imported, because `@atlcli/jira` must not depend on `@atlcli/confluence`.
 *
 * Lossy-case rule: anything without a markdown form is kept as an opaque
 * `<!--adf:BASE64URL(JSON)-->` sentinel, so `get → edit → update` never drops
 * content (attachments, extensions, complex tables).
 */

import MarkdownIt from "markdown-it";
import { decodeBase64, encodeBase64 } from "@atlcli/core";
import type { AdfDocument, AdfJsonValue, AdfMark, AdfNode } from "@atlcli/change-set/adf";

type Token = ReturnType<InstanceType<typeof MarkdownIt>["parse"]>[number];

export interface MarkdownToAdfOptions {
  /** Site base URL; `{jira:KEY}` becomes an inlineCard to `<baseUrl>/browse/KEY`. */
  baseUrl?: string;
  /** Receives non-fatal conversion notes (local images, raw HTML). */
  onWarning?: (message: string) => void;
}

export interface AdfToMarkdownOptions {
  /** Site base URL; inlineCards to `<baseUrl>/browse/KEY` become `{jira:KEY}`. */
  baseUrl?: string;
}

// ============ Shared dialect ============

const SENTINEL_PREFIX = "adf:";
const SENTINEL_REGEX = /^<!--adf:([A-Za-z0-9_-]+)-->$/;
const BROWSE_REGEX = /\/browse\/([A-Z][A-Z0-9_]*-\d+)\/?$/;
const PANEL_TYPES = new Set(["info", "note", "warning", "error", "success"]);
const BLOCK_OPEN_REGEX = /^:::(info|note|warning|tip|error|success|expand)(?:[ \t]+(.+))?[ \t]*$/;
const BLOCK_CLOSE_REGEX = /^:::[ \t]*$/;
const FENCE_REGEX = /^[ \t]{0,3}(`{3,}|~{3,})/;

// Inline dialect (same shapes as the Confluence converter).
const INLINE_DIALECT_REGEX = new RegExp(
  [
    /\{status:(\w+)\}([^{]*)\{status\}/.source,
    /\{date:(\d{4}-\d{2}-\d{2})\}/.source,
    /\{jira:([A-Z][A-Z0-9_]*-\d+)(?:\|[^}]*)?\}/.source,
    /(?<=^|[\s(])(:[a-z][a-z0-9_+-]*:)(?=$|[\s).,!?;])/.source,
  ].join("|"),
  "g",
);

const STATUS_COLOR_TO_ADF: Record<string, string> = { grey: "neutral", gray: "neutral" };
const STATUS_COLOR_FROM_ADF: Record<string, string> = { neutral: "grey" };

function encodeSentinel(node: AdfNode): string {
  const base64 = encodeBase64(JSON.stringify(node));
  return `<!--${SENTINEL_PREFIX}${base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}-->`;
}

function decodeSentinel(html: string): AdfNode | undefined {
  const match = SENTINEL_REGEX.exec(html.trim());
  if (!match) return undefined;
  let base64 = match[1]!.replace(/-/g, "+").replace(/_/g, "/");
  while (base64.length % 4 !== 0) base64 += "=";
  try {
    const node = JSON.parse(decodeBase64(base64)) as unknown;
    return isAdfNode(node) ? node : undefined;
  } catch {
    return undefined;
  }
}

function isAdfNode(value: unknown): value is AdfNode {
  return typeof value === "object" && value !== null && typeof (value as { type?: unknown }).type === "string";
}

function localId(): string {
  return crypto.randomUUID();
}

function browseUrl(baseUrl: string, key: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/browse/${key}`;
}

// ============ Markdown → ADF ============

const md = new MarkdownIt({ html: true, linkify: true, breaks: false, typographer: false });
// Keep backslash escapes and entities as separate `text_special` tokens so an
// escaped `\{status:…}` stays literal instead of re-entering the dialect pass.
md.core.ruler.disable("text_join");

/** Convert atlcli-dialect markdown to an ADF document. */
export function markdownToAdf(markdown: string, options: MarkdownToAdfOptions = {}): AdfDocument {
  return { type: "doc", version: 1, content: convertBlocks(markdown.replace(/\r\n?/g, "\n"), options) };
}

/**
 * Split `:::panel` / `:::expand` regions out before markdown-it sees them
 * (markdown-it has no container syntax); everything else is plain markdown.
 * Panels are recognised at top level and outside code fences only.
 */
function convertBlocks(markdown: string, options: MarkdownToAdfOptions): AdfNode[] {
  const lines = markdown.split("\n");
  const out: AdfNode[] = [];
  let chunk: string[] = [];
  let fence: string | undefined;

  const flush = () => {
    if (chunk.length > 0) out.push(...convertMarkdownChunk(chunk.join("\n"), options));
    chunk = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const fenceMatch = FENCE_REGEX.exec(line);
    if (fence) {
      if (fenceMatch && fenceMatch[1]![0] === fence[0] && fenceMatch[1]!.length >= fence.length) fence = undefined;
      chunk.push(line);
      continue;
    }
    if (fenceMatch) {
      fence = fenceMatch[1];
      chunk.push(line);
      continue;
    }
    const open = BLOCK_OPEN_REGEX.exec(line);
    const end = open ? findBlockEnd(lines, i + 1) : -1;
    if (!open || end < 0) {
      chunk.push(line);
      continue;
    }
    flush();
    const inner = convertBlocks(lines.slice(i + 1, end).join("\n"), options);
    const kind = open[1]!;
    if (kind === "expand") {
      out.push({ type: "expand", attrs: { title: open[2]?.trim() ?? "" }, content: inner.length ? inner : [emptyParagraph()] });
    } else {
      out.push({
        type: "panel",
        attrs: { panelType: kind === "tip" ? "success" : kind },
        content: inner.length ? inner : [emptyParagraph()],
      });
    }
    i = end;
  }
  flush();
  return out;
}

function findBlockEnd(lines: string[], start: number): number {
  let depth = 1;
  let fence: string | undefined;
  for (let i = start; i < lines.length; i++) {
    const line = lines[i]!;
    const fenceMatch = FENCE_REGEX.exec(line);
    if (fence) {
      if (fenceMatch && fenceMatch[1]![0] === fence[0] && fenceMatch[1]!.length >= fence.length) fence = undefined;
      continue;
    }
    if (fenceMatch) {
      fence = fenceMatch[1];
      continue;
    }
    if (BLOCK_OPEN_REGEX.test(line)) depth++;
    else if (BLOCK_CLOSE_REGEX.test(line) && --depth === 0) return i;
  }
  return -1;
}

function emptyParagraph(): AdfNode {
  return { type: "paragraph", content: [] };
}

function convertMarkdownChunk(markdown: string, options: MarkdownToAdfOptions): AdfNode[] {
  const tokens = md.parse(markdown, {});
  const walker = new BlockWalker(tokens, options);
  return walker.blocks(undefined);
}

class BlockWalker {
  private pos = 0;
  constructor(private readonly tokens: Token[], private readonly options: MarkdownToAdfOptions) {}

  /** Read block nodes until the matching `closeType` token (consumed) or the end. */
  blocks(closeType: string | undefined): AdfNode[] {
    const out: AdfNode[] = [];
    while (this.pos < this.tokens.length) {
      const token = this.tokens[this.pos]!;
      if (closeType && token.type === closeType) {
        this.pos++;
        return out;
      }
      const node = this.block(token);
      if (node) out.push(node);
    }
    return out;
  }

  private block(token: Token): AdfNode | undefined {
    switch (token.type) {
      case "heading_open": {
        this.pos++;
        const content = this.inline();
        this.pos++; // heading_close
        return { type: "heading", attrs: { level: Number(token.tag.slice(1)) }, content };
      }
      case "paragraph_open": {
        this.pos++;
        const content = this.inline();
        this.pos++; // paragraph_close
        return { type: "paragraph", content };
      }
      case "bullet_list_open":
      case "ordered_list_open":
        return this.list(token);
      case "blockquote_open": {
        this.pos++;
        return { type: "blockquote", content: this.blocks("blockquote_close") };
      }
      case "fence":
      case "code_block": {
        this.pos++;
        const language = token.type === "fence" ? token.info.trim().split(/\s+/)[0] : "";
        const text = token.content.endsWith("\n") ? token.content.slice(0, -1) : token.content;
        const node: AdfNode = { type: "codeBlock" };
        if (language) node.attrs = { language };
        if (text) node.content = [{ type: "text", text }];
        return node;
      }
      case "hr":
        this.pos++;
        return { type: "rule" };
      case "table_open":
        return this.table();
      case "html_block": {
        this.pos++;
        const sentinel = decodeSentinel(token.content);
        if (sentinel) return sentinel;
        this.options.onWarning?.("Raw HTML block was kept as plain text.");
        return { type: "paragraph", content: [{ type: "text", text: token.content.replace(/\n$/, "") }] };
      }
      default:
        this.pos++;
        return undefined;
    }
  }

  private list(open: Token): AdfNode {
    const ordered = open.type === "ordered_list_open";
    const closeType = ordered ? "ordered_list_close" : "bullet_list_close";
    this.pos++;
    const items: AdfNode[][] = [];
    while (this.pos < this.tokens.length && this.tokens[this.pos]!.type !== closeType) {
      this.pos++; // list_item_open
      items.push(this.blocks("list_item_close"));
    }
    this.pos++; // list close

    if (!ordered) {
      const tasks = toTaskList(items);
      if (tasks) return tasks;
    }
    const node: AdfNode = {
      type: ordered ? "orderedList" : "bulletList",
      content: items.map((content) => ({ type: "listItem", content: content.length ? content : [emptyParagraph()] })),
    };
    const start = Number(open.attrGet("start") ?? 1);
    if (ordered && start !== 1) node.attrs = { order: start };
    return node;
  }

  private table(): AdfNode {
    this.pos++; // table_open
    const rows: AdfNode[] = [];
    while (this.pos < this.tokens.length && this.tokens[this.pos]!.type !== "table_close") {
      const token = this.tokens[this.pos]!;
      if (token.type === "tr_open") {
        this.pos++;
        const cells: AdfNode[] = [];
        while (this.tokens[this.pos]!.type !== "tr_close") {
          const cell = this.tokens[this.pos]!;
          this.pos++;
          const content = this.inline();
          this.pos++; // th_close / td_close
          cells.push({
            type: cell.type === "th_open" ? "tableHeader" : "tableCell",
            content: [{ type: "paragraph", content }],
          });
        }
        this.pos++; // tr_close
        rows.push({ type: "tableRow", content: cells });
      } else {
        this.pos++; // thead/tbody open/close
      }
    }
    this.pos++; // table_close
    return { type: "table", content: rows };
  }

  /** Convert the `inline` token at `pos` (if any) into ADF inline nodes. */
  private inline(): AdfNode[] {
    const token = this.tokens[this.pos];
    if (!token || token.type !== "inline") return [];
    this.pos++;
    return convertInline(token.children ?? [], this.options);
  }
}

/** A bullet list whose items all start with `[ ]` / `[x]` and hold no nested non-task lists. */
function toTaskList(items: AdfNode[][]): AdfNode | undefined {
  const content: AdfNode[] = [];
  for (const blocks of items) {
    const [first, ...rest] = blocks;
    if (!first || first.type !== "paragraph") return undefined;
    const inline = first.content ?? [];
    const head = inline[0];
    const match = head?.type === "text" && !head.marks?.length ? /^\[([ xX])\](?:\s+|$)/.exec(head.text ?? "") : null;
    if (!match) return undefined;
    if (rest.some((block) => block.type !== "taskList")) return undefined;
    const remaining = head!.text!.slice(match[0].length);
    const itemInline = remaining ? [{ ...head!, text: remaining }, ...inline.slice(1)] : inline.slice(1);
    content.push({
      type: "taskItem",
      attrs: { localId: localId(), state: match[1] === " " ? "TODO" : "DONE" },
      content: itemInline,
    });
    content.push(...rest);
  }
  return { type: "taskList", attrs: { localId: localId() }, content };
}

function convertInline(children: Token[], options: MarkdownToAdfOptions): AdfNode[] {
  const out: AdfNode[] = [];
  const marks: AdfMark[] = [];

  const pushText = (text: string, literal = false) => {
    if (!text) return;
    for (const node of literal ? [{ type: "text", text } as AdfNode] : splitDialect(text, options)) {
      if (node.type === "text" && marks.length) node.marks = marks.map((mark) => ({ ...mark }));
      out.push(node);
    }
  };
  const popMark = (type: string) => {
    for (let i = marks.length - 1; i >= 0; i--) {
      if (marks[i]!.type === type) {
        marks.splice(i, 1);
        return;
      }
    }
  };

  for (let i = 0; i < children.length; i++) {
    const token = children[i]!;
    switch (token.type) {
      case "text":
        pushText(token.content);
        break;
      case "text_special":
        pushText(token.content, true);
        break;
      case "softbreak":
        pushText(" ");
        break;
      case "hardbreak":
        out.push({ type: "hardBreak" });
        break;
      case "code_inline": {
        const link = marks.find((mark) => mark.type === "link");
        const node: AdfNode = { type: "text", text: token.content, marks: [{ type: "code" }] };
        if (link) node.marks!.push({ ...link });
        out.push(node);
        break;
      }
      case "strong_open":
        marks.push({ type: "strong" });
        break;
      case "strong_close":
        popMark("strong");
        break;
      case "em_open":
        marks.push({ type: "em" });
        break;
      case "em_close":
        popMark("em");
        break;
      case "s_open":
        marks.push({ type: "strike" });
        break;
      case "s_close":
        popMark("strike");
        break;
      case "link_open": {
        const href = String(token.attrGet("href") ?? "");
        // `@[Name](accountId)` parses as "@" + link; it is a mention.
        const previous = out[out.length - 1];
        if (previous?.type === "text" && previous.text?.endsWith("@") && children[i + 2]?.type === "link_close") {
          const name = children[i + 1]?.type === "text" ? children[i + 1]!.content : "";
          previous.text = previous.text.slice(0, -1);
          if (!previous.text) out.pop();
          out.push({ type: "mention", attrs: { id: safeDecode(href), text: `@${name}` } });
          i += 2;
          break;
        }
        // Autolinks (`<url>`) and bare /browse/KEY URLs become smart links.
        const isAuto = token.markup === "autolink" || token.markup === "linkify";
        if (isAuto && (token.markup === "autolink" || BROWSE_REGEX.test(href)) && children[i + 2]?.type === "link_close") {
          out.push({ type: "inlineCard", attrs: { url: href } });
          i += 2;
          break;
        }
        marks.push({ type: "link", attrs: { href } });
        break;
      }
      case "link_close":
        popMark("link");
        break;
      case "image": {
        const src = String(token.attrGet("src") ?? "");
        const alt = token.content;
        options.onWarning?.(`Image "${src}" was kept as a link; Jira images must be attachments.`);
        out.push({ type: "text", text: alt || src, marks: [...marks.filter((m) => m.type !== "link"), { type: "link", attrs: { href: src } }] });
        break;
      }
      case "html_inline": {
        const sentinel = decodeSentinel(token.content);
        if (sentinel) {
          out.push(sentinel);
        } else {
          options.onWarning?.("Raw inline HTML was kept as plain text.");
          pushText(token.content);
        }
        break;
      }
      default:
        if (token.content) pushText(token.content);
    }
  }
  return mergeAdjacentText(out);
}

function splitDialect(text: string, options: MarkdownToAdfOptions): AdfNode[] {
  const out: AdfNode[] = [];
  let last = 0;
  INLINE_DIALECT_REGEX.lastIndex = 0;
  for (let match = INLINE_DIALECT_REGEX.exec(text); match; match = INLINE_DIALECT_REGEX.exec(text)) {
    const [whole, statusColor, statusText, date, jiraKey, emoji] = match;
    let node: AdfNode | undefined;
    if (statusColor !== undefined) {
      const color = statusColor.toLowerCase();
      node = { type: "status", attrs: { text: statusText ?? "", color: STATUS_COLOR_TO_ADF[color] ?? color, localId: localId() } };
    } else if (date !== undefined) {
      const [y, m, d] = date.split("-").map(Number);
      node = { type: "date", attrs: { timestamp: String(Date.UTC(y!, m! - 1, d!)) } };
    } else if (jiraKey !== undefined) {
      node = options.baseUrl
        ? { type: "inlineCard", attrs: { url: browseUrl(options.baseUrl, jiraKey) } }
        : { type: "text", text: jiraKey };
    } else if (emoji !== undefined) {
      node = { type: "emoji", attrs: { shortName: emoji } };
    }
    if (!node) continue;
    if (match.index > last) out.push({ type: "text", text: text.slice(last, match.index) });
    out.push(node);
    last = match.index + whole.length;
  }
  if (last < text.length) out.push({ type: "text", text: text.slice(last) });
  return out;
}

function mergeAdjacentText(nodes: AdfNode[]): AdfNode[] {
  const out: AdfNode[] = [];
  for (const node of nodes) {
    const previous = out[out.length - 1];
    if (node.type === "text" && previous?.type === "text" && sameMarks(previous.marks, node.marks)) {
      previous.text = `${previous.text ?? ""}${node.text ?? ""}`;
    } else if (node.type !== "text" || node.text) {
      out.push(node);
    }
  }
  return out;
}

function sameMarks(a: AdfMark[] | undefined, b: AdfMark[] | undefined): boolean {
  return JSON.stringify(a ?? []) === JSON.stringify(b ?? []);
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

// ============ ADF → Markdown ============

/** Convert an ADF document (or a Data Center plain string) to atlcli-dialect markdown. */
export function adfToMarkdown(
  adf: AdfDocument | string | null | undefined,
  options: AdfToMarkdownOptions = {},
): string {
  if (!adf) return "";
  if (typeof adf === "string") return adf;
  return serializeBlocks(adf.content ?? [], options).trimEnd();
}

function serializeBlocks(nodes: AdfNode[], options: AdfToMarkdownOptions): string {
  return nodes
    .map((node) => serializeBlock(node, options))
    .filter((block) => block !== "")
    .join("\n\n");
}

function serializeBlock(node: AdfNode, options: AdfToMarkdownOptions): string {
  const content = node.content ?? [];
  switch (node.type) {
    case "paragraph":
      return escapeLineStart(serializeInline(content, options));
    case "heading": {
      const level = Math.min(Math.max(Number(node.attrs?.level ?? 1), 1), 6);
      return `${"#".repeat(level)} ${serializeInline(content, options)}`;
    }
    case "bulletList":
      return content.map((item) => listItem("- ", item, options)).join("\n");
    case "orderedList": {
      let n = Number(node.attrs?.order ?? 1);
      return content.map((item) => listItem(`${n++}. `, item, options)).join("\n");
    }
    case "taskList":
      return content
        .map((item) =>
          item.type === "taskItem"
            ? `- [${item.attrs?.state === "DONE" ? "x" : " "}] ${serializeInline(item.content ?? [], options)}`.trimEnd()
            : indent(serializeBlock(item, options), "  "),
        )
        .join("\n");
    case "codeBlock": {
      const text = content.map((child) => child.text ?? "").join("");
      const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
      const fence = "`".repeat(longest + 1);
      const language = typeof node.attrs?.language === "string" ? node.attrs.language : "";
      return `${fence}${language}\n${text}\n${fence}`;
    }
    case "blockquote":
      return serializeBlocks(content, options)
        .split("\n")
        .map((line) => (line ? `> ${line}` : ">"))
        .join("\n");
    case "rule":
      return "---";
    case "panel": {
      const panelType = String(node.attrs?.panelType ?? "info");
      if (!PANEL_TYPES.has(panelType)) return encodeSentinel(node);
      return `:::${panelType}\n${serializeBlocks(content, options)}\n:::`;
    }
    case "expand": {
      const title = typeof node.attrs?.title === "string" ? node.attrs.title : "";
      return `:::expand${title ? ` ${title}` : ""}\n${serializeBlocks(content, options)}\n:::`;
    }
    case "table":
      return serializeTable(node, options) ?? encodeSentinel(node);
    case "mediaSingle": {
      const media = content.length === 1 ? content[0] : undefined;
      if (media?.type === "media" && media.attrs?.type === "external" && typeof media.attrs.url === "string") {
        const alt = typeof media.attrs.alt === "string" ? media.attrs.alt : "";
        return `![${escapeText(alt)}](${media.attrs.url})`;
      }
      return encodeSentinel(node);
    }
    case "blockCard":
    case "embedCard":
      return typeof node.attrs?.url === "string" ? `<${node.attrs.url}>` : encodeSentinel(node);
    default:
      return encodeSentinel(node);
  }
}

function listItem(marker: string, item: AdfNode, options: AdfToMarkdownOptions): string {
  const pad = " ".repeat(marker.length);
  const blocks = (item.content ?? []).map((block) => serializeBlock(block, options));
  let body = "";
  (item.content ?? []).forEach((block, index) => {
    const text = blocks[index]!;
    if (index === 0) {
      body = text;
      return;
    }
    // Paragraph after paragraph needs a blank line; nested lists do not, except
    // an ordered list starting at n ≠ 1, which CommonMark won't let interrupt a
    // paragraph.
    const startsAtOne = block.type !== "orderedList" || Number(block.attrs?.order ?? 1) === 1;
    const separator = block.type === "paragraph" || !startsAtOne ? "\n\n" : "\n";
    body += separator + text;
  });
  const [first = "", ...rest] = body.split("\n");
  return [marker + first, ...rest.map((line) => (line ? pad + line : line))].join("\n").trimEnd();
}

function indent(text: string, pad: string): string {
  return text
    .split("\n")
    .map((line) => (line ? pad + line : line))
    .join("\n");
}

/** GFM table if the first row is all headers and every cell is one inline paragraph. */
function serializeTable(node: AdfNode, options: AdfToMarkdownOptions): string | undefined {
  const rows = node.content ?? [];
  if (rows.length === 0) return undefined;
  const grid: string[][] = [];
  for (const [rowIndex, row] of rows.entries()) {
    const cells: string[] = [];
    for (const cell of row.content ?? []) {
      if (rowIndex === 0 && cell.type !== "tableHeader") return undefined;
      if (rowIndex > 0 && cell.type !== "tableCell") return undefined;
      if ((cell.attrs?.colspan ?? 1) !== 1 || (cell.attrs?.rowspan ?? 1) !== 1) return undefined;
      const blocks = cell.content ?? [];
      if (blocks.length > 1 || (blocks[0] && blocks[0].type !== "paragraph")) return undefined;
      const inline = blocks[0]?.content ?? [];
      if (inline.some((child) => child.type === "hardBreak")) return undefined;
      cells.push(serializeInline(inline, options).replace(/\|/g, "\\|"));
    }
    grid.push(cells);
  }
  const width = grid[0]!.length;
  if (width === 0 || grid.some((cells) => cells.length !== width)) return undefined;
  const line = (cells: string[]) => `| ${cells.join(" | ")} |`;
  return [line(grid[0]!), line(grid[0]!.map(() => "---")), ...grid.slice(1).map(line)].join("\n");
}

const MARK_ORDER = ["link", "strong", "em", "strike", "code"];

function serializeInline(nodes: AdfNode[], options: AdfToMarkdownOptions): string {
  return mergeAdjacentText(nodes.map((node) => ({ ...node })))
    .map((node) => serializeInlineNode(node, options))
    .join("");
}

function serializeInlineNode(node: AdfNode, options: AdfToMarkdownOptions): string {
  switch (node.type) {
    case "text":
      return serializeText(node.text ?? "", node.marks ?? []);
    case "hardBreak":
      return "\\\n";
    case "mention": {
      const id = String(node.attrs?.id ?? "");
      const text = typeof node.attrs?.text === "string" && node.attrs.text ? node.attrs.text.replace(/^@/, "") : id;
      return `@[${text.replace(/[[\]]/g, "\\$&")}](${id})`;
    }
    case "emoji": {
      const shortName = String(node.attrs?.shortName ?? node.attrs?.text ?? "");
      return /^:.+:$/.test(shortName) ? shortName : `:${shortName}:`;
    }
    case "date": {
      const timestamp = Number(node.attrs?.timestamp);
      if (!Number.isFinite(timestamp)) return encodeSentinel(node);
      return `{date:${new Date(timestamp).toISOString().slice(0, 10)}}`;
    }
    case "status": {
      const color = String(node.attrs?.color ?? "neutral");
      return `{status:${STATUS_COLOR_FROM_ADF[color] ?? color}}${String(node.attrs?.text ?? "")}{status}`;
    }
    case "inlineCard": {
      const url = node.attrs?.url;
      if (typeof url !== "string") return encodeSentinel(node);
      const key = BROWSE_REGEX.exec(url)?.[1];
      if (key && options.baseUrl && url === browseUrl(options.baseUrl, key)) return `{jira:${key}}`;
      return `<${url}>`;
    }
    default:
      return encodeSentinel(node);
  }
}

function serializeText(text: string, marks: AdfMark[]): string {
  if (!text) return "";
  const known = marks
    .filter((mark) => MARK_ORDER.includes(mark.type))
    .sort((a, b) => MARK_ORDER.indexOf(b.type) - MARK_ORDER.indexOf(a.type));
  const lines = text.split("\n");
  if (lines.length > 1) return lines.map((line) => serializeText(line, marks)).join("\\\n");

  const hasCode = known.some((mark) => mark.type === "code");
  let core = hasCode ? codeSpan(text) : escapeText(text);
  // Whitespace must sit outside emphasis delimiters to stay valid markdown.
  const lead = hasCode ? "" : (/^\s*/.exec(core)?.[0] ?? "");
  const trail = hasCode ? "" : (/\s*$/.exec(core.slice(lead.length))?.[0] ?? "");
  core = core.slice(lead.length, core.length - trail.length);
  if (!core) return lead + trail;

  for (const mark of known) {
    switch (mark.type) {
      case "strike":
        core = `~~${core}~~`;
        break;
      case "em":
        core = `*${core}*`;
        break;
      case "strong":
        core = `**${core}**`;
        break;
      case "link": {
        const href = String((mark.attrs as Record<string, AdfJsonValue> | undefined)?.href ?? "");
        // A link whose text is its own URL round-trips as a bare (linkified) URL.
        core = core === href && !/[()\s]/.test(href) && known.length === 1 ? href : `[${core}](${href.replace(/[()\s]/g, encodeURIComponent)})`;
        break;
      }
    }
  }
  return lead + core + trail;
}

function codeSpan(text: string): string {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const ticks = "`".repeat(longest + 1);
  const pad = text.startsWith("`") || text.endsWith("`") ? " " : "";
  return `${ticks}${pad}${text}${pad}${ticks}`;
}

/** Escape characters markdown-it or the atlcli dialect would otherwise interpret. */
function escapeText(text: string): string {
  return text
    .replace(/[\\`*[\]<{}~]/g, "\\$&")
    .replace(/_/g, (underscore, offset: number, whole: string) =>
      /[\p{L}\p{N}]/u.test(whole[offset - 1] ?? "") && /[\p{L}\p{N}]/u.test(whole[offset + 1] ?? "") ? underscore : "\\_",
    )
    .replace(/&(?=#?[a-zA-Z0-9]+;)/g, "\\&")
    .replace(/(^|[\s(]):(?=[a-z][a-z0-9_+-]*:)/g, "$1\\:")
    .replace(/@(?=\\\[)/g, "\\@");
}

/** Escape a leading block marker so a paragraph stays a paragraph. */
function escapeLineStart(text: string): string {
  return text.replace(/^(\s*)(#{1,6}(?=\s|$)|[-+>](?=\s|$)|\d+(?=[.)](?:\s|$))|=+\s*$|:::)/, (_m, space: string, marker: string) =>
    /^\d+$/.test(marker) ? `${space}${marker}\\` : `${space}\\${marker}`,
  );
}

// ============ Jira write helper ============

/**
 * Body for a Jira rich-text field: ADF on Cloud (API v3), the raw markdown
 * string on Data Center (API v2 takes wiki-markup strings; markdown is the
 * closest readable form — spec non-goal: no wiki-markup conversion).
 */
export function toJiraRichText(
  client: { readonly isCloudSite: boolean; readonly siteUrl: string },
  markdown: string,
  options: Omit<MarkdownToAdfOptions, "baseUrl"> = {},
): AdfDocument | string {
  return client.isCloudSite ? markdownToAdf(markdown, { ...options, baseUrl: client.siteUrl }) : markdown;
}
