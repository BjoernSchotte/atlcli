import type {
  AdfDocument,
  AdfJsonValue,
  AdfMark,
  AdfNode,
  AdfParseBudget,
  AdfDiagnostic,
} from "./adf-types.js";
import { DEFAULT_ADF_PARSE_BUDGET } from "./adf-types.js";
import { validateAdf } from "./adf-validate.js";
import type {
  Caption,
  AdfExtensionIdentity,
  ExportBlock,
  ExportNote,
  ExportNoteSource,
  InlineMark,
  InlineNode,
  LinkTarget,
  MacroParameter,
  StorageToBlocksOptions,
  TableCell,
  TableRow,
} from "./export-blocks.js";
import { sanitizeLinkHref, unsafeLinkMessage } from "./link-safety.js";
import type { BlocksResult } from "./page-body.js";

export interface AdfToBlocksOptions
  extends Omit<StorageToBlocksOptions, "parseBudget"> {
  parseBudget?: Partial<AdfParseBudget>;
  /**
   * Optional host-proven Media Services ID correlation. The decoder never
   * guesses a filename from an ADF ID; without this seam media stays visible
   * and degraded.
   */
  resolveMediaAttachment?: (
    reference: AdfMediaReference,
  ) => AdfResolvedMediaAttachment | undefined;
}

export interface AdfMediaReference {
  id: string;
  collection?: string;
  occurrenceKey?: string;
}

export interface AdfResolvedMediaAttachment {
  filename: string;
  pageId?: string;
}

/** Attachment metadata proven to correlate ADF media `id` with v2 `fileId`. */
export interface AdfMediaAttachment {
  fileId: string;
  filename: string;
  pageId: string;
}

/** Build an exact, synchronous decoder resolver from prefetched page metadata. */
export function createAdfMediaAttachmentResolver(
  attachments: readonly AdfMediaAttachment[] | undefined,
): AdfToBlocksOptions["resolveMediaAttachment"] | undefined {
  if (!attachments) return undefined;
  const byFileId = new Map<string, AdfResolvedMediaAttachment>();
  for (const attachment of attachments) {
    const fileId = attachment.fileId.trim();
    const filename = attachment.filename.trim();
    const pageId = attachment.pageId.trim();
    if (!fileId || !filename || !pageId || byFileId.has(fileId)) continue;
    byFileId.set(fileId, { filename, pageId });
  }
  return (reference) => byFileId.get(reference.id);
}

interface DecodeContext {
  notes: NoteCollector;
  pageContext?: StorageToBlocksOptions["pageContext"];
  resolveMediaAttachment?: AdfToBlocksOptions["resolveMediaAttachment"];
  exporter?: StorageToBlocksOptions["exporter"];
  exportControls: NonNullable<StorageToBlocksOptions["exportControls"]>;
}

class NoteCollector {
  readonly notes: ExportNote[] = [];
  private readonly seen = new Set<string>();
  private dropped = 0;
  private observed = 0;

  constructor(private readonly max: number) {}

  add(note: ExportNote, key = `${note.code}|${note.source?.blockPath ?? ""}|${note.message}`): void {
    if (this.seen.has(key)) return;
    this.seen.add(key);
    this.observed += 1;
    if (this.notes.length < this.max) this.notes.push(note);
    else this.dropped += 1;
  }

  get degraded(): boolean {
    return this.observed > 0;
  }

  get limit(): number {
    return this.max;
  }

  finish(source?: ExportNoteSource): ExportNote[] {
    if (this.dropped === 0 || this.max === 0) return this.notes;
    const summary: ExportNote = {
      level: "warning",
      code: "adf-node-degraded",
      message: `${this.dropped} additional ADF degradation diagnostics were suppressed by the report budget.`,
      ...(source ? { source } : {}),
    };
    if (this.notes.length === this.max) this.notes[this.notes.length - 1] = summary;
    else this.notes.push(summary);
    return this.notes;
  }
}

function sourceFor(ctx: DecodeContext, blockPath: string): ExportNoteSource {
  const page = ctx.pageContext;
  return {
    ...(page?.id ? { pageId: page.id } : {}),
    ...(page?.title ? { pageTitle: page.title } : {}),
    ...(page?.url ? { pageUrl: page.url } : {}),
    blockPath,
  };
}

function addNodeNote(
  ctx: DecodeContext,
  path: string,
  type: string,
  detail: string,
): void {
  ctx.notes.add(
    {
      level: "warning",
      code: "adf-node-degraded",
      message: `ADF ${type} ${detail}`,
      source: sourceFor(ctx, path),
    },
    `node|${path}|${type}|${detail}`,
  );
}

function addMarkNote(ctx: DecodeContext, path: string, type: string): void {
  ctx.notes.add(
    {
      level: "warning",
      code: "adf-mark-degraded",
      message: `ADF mark ${type} is not represented natively; its visible content was preserved.`,
      source: sourceFor(ctx, path),
    },
    `mark|${path}|${type}`,
  );
}

function diagnosticToNote(ctx: DecodeContext, diagnostic: AdfDiagnostic): void {
  if (diagnostic.kind === "unknown-node") {
    addNodeNote(ctx, diagnostic.path, diagnostic.type ?? "unknown", "is unknown; its visible content was preserved.");
    return;
  }
  if (diagnostic.kind === "unknown-mark") {
    addMarkNote(ctx, diagnostic.path, diagnostic.type ?? "unknown");
    return;
  }
  if (diagnostic.kind === "unknown-attribute") {
    ctx.notes.add(
      {
        level: "warning",
        code: "adf-attribute-dropped",
        message: `ADF attribute ${diagnostic.attribute ?? "unknown"} on ${diagnostic.type ?? "node"} was not used by the export model.`,
        source: sourceFor(ctx, diagnostic.path),
      },
      `attr|${diagnostic.path}|${diagnostic.type}|${diagnostic.attribute}`,
    );
    return;
  }
  ctx.notes.add(
    {
      level: "warning",
      code: "adf-attribute-dropped",
      message: `${diagnostic.count ?? 0} additional ADF validation diagnostics were suppressed by the parse budget.`,
      source: sourceFor(ctx, diagnostic.path),
    },
    `validation-summary|${diagnostic.count}`,
  );
}

/** Decode untrusted ADF into the same neutral model consumed by DOCX and PDF. */
export function adfToBlocks(
  input: string | unknown,
  options: AdfToBlocksOptions = {},
): BlocksResult {
  const validated = validateAdf(input, { budget: options.parseBudget });
  const maxDiagnostics = options.parseBudget?.maxDiagnostics ?? DEFAULT_ADF_PARSE_BUDGET.maxDiagnostics;
  const ctx: DecodeContext = {
    notes: new NoteCollector(maxDiagnostics),
    pageContext: options.pageContext,
    resolveMediaAttachment: options.resolveMediaAttachment,
    exporter: options.exporter,
    exportControls: options.exportControls ?? "apply",
  };
  for (const diagnostic of validated.diagnostics) diagnosticToNote(ctx, diagnostic);
  const blocks = decodeBlockChildren(validated.document.content, ctx, "blocks");
  const notes = ctx.notes.finish(sourceFor(ctx, "blocks"));
  return {
    blocks,
    notes,
    representation: "atlas_doc_format",
    ...(ctx.notes.degraded ? { degraded: true } : {}),
  };
}

function decodeBlockChildren(
  nodes: readonly AdfNode[] | undefined,
  ctx: DecodeContext,
  path: string,
): ExportBlock[] {
  if (!nodes || nodes.length === 0) return [];
  const out: ExportBlock[] = [];
  let inline: InlineNode[] = [];
  const flush = (): void => {
    if (inline.length > 0) out.push({ type: "paragraph", content: inline });
    inline = [];
  };
  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index]!;
    const nodePath = `${path}[${index}]`;
    if (isInlineNodeType(node.type)) {
      inline.push(...decodeInlineNode(node, ctx, nodePath));
      continue;
    }
    flush();
    out.push(...decodeBlockNode(node, ctx, nodePath));
  }
  flush();
  return out;
}

function decodeBlockNode(node: AdfNode, ctx: DecodeContext, path: string): ExportBlock[] {
  noteUnhandledNodeMarks(node, ctx, path);
  switch (node.type) {
    case "doc":
      return decodeBlockChildren(node.content, ctx, `${path}.content`);
    case "paragraph": {
      const content = decodeInlineChildren(node.content, ctx, `${path}.content`);
      // An export-control extension can remove the paragraph's only child.
      // Match the Storage walker by dropping that now-empty wrapper, while an
      // authored empty ADF paragraph remains representable.
      return content.length === 0 && (node.content?.length ?? 0) > 0
        ? []
        : [{ type: "paragraph", content }];
    }
    case "heading":
      return [{
        type: "heading",
        level: numberInRange(node.attrs?.level, 1, 6, 1) as 1 | 2 | 3 | 4 | 5 | 6,
        content: decodeInlineChildren(node.content, ctx, `${path}.content`),
      }];
    case "codeBlock":
      return [{
        type: "codeBlock",
        code: descendantText(node),
        ...(stringAttr(node, "language") ? { language: stringAttr(node, "language") } : {}),
      }];
    case "rule":
      return [{ type: "divider" }];
    case "blockquote":
      return [{ type: "blockquote", content: decodeBlockChildren(node.content, ctx, `${path}.content`) }];
    case "bulletList":
      return [{ type: "list", ordered: false, items: decodeListItems(node, ctx, path) }];
    case "orderedList": {
      const order = numberAttr(node, "order");
      if (order !== undefined && order !== 1) {
        addNodeNote(ctx, path, node.type, `starts at ${order}; the neutral list model renders it from 1.`);
      }
      return [{ type: "list", ordered: true, items: decodeListItems(node, ctx, path) }];
    }
    case "listItem":
      return decodeBlockChildren(node.content, ctx, `${path}.content`);
    case "taskList":
    case "decisionList":
      if (node.type === "decisionList") addNodeNote(ctx, path, node.type, "was approximated as a static checklist.");
      return [{ type: "list", ordered: false, items: decodeTaskItems(node, ctx, path) }];
    case "taskItem":
    case "blockTaskItem":
    case "decisionItem":
      return decodeBlockChildren(node.content, ctx, `${path}.content`);
    case "table":
      return [decodeTable(node, ctx, path)];
    case "tableRow":
    case "tableCell":
    case "tableHeader":
      return decodeBlockChildren(node.content, ctx, `${path}.content`);
    case "panel":
      return [{
        type: "callout",
        kind: panelKind(stringAttr(node, "panelType")),
        content: decodeBlockChildren(node.content, ctx, `${path}.content`),
      }];
    case "expand":
    case "nestedExpand":
      addNodeNote(ctx, path, node.type, "was expanded into a visible panel.");
      return [{
        type: "callout",
        kind: "panel",
        ...(stringAttr(node, "title") ? { title: stringAttr(node, "title") } : {}),
        content: decodeBlockChildren(node.content, ctx, `${path}.content`),
      }];
    case "layoutSection":
    case "layoutColumn":
      addNodeNote(ctx, path, node.type, "layout was flattened while preserving document order.");
      return decodeBlockChildren(node.content, ctx, `${path}.content`);
    case "extension":
    case "bodiedExtension": {
      const controlled = decodeBlockExportControl(node, ctx, path);
      if (controlled) return controlled.blocks;
      return [decodeExtension(node, ctx, path)];
    }
    case "blockCard":
    case "embedCard":
      return [cardParagraph(node, ctx, path)];
    case "mediaSingle":
    case "mediaGroup":
      return decodeMediaContainer(node, ctx, path);
    case "media":
      return [decodeMediaBlock(node, ctx, path)];
    case "syncBlock":
    case "bodiedSyncBlock": {
      addNodeNote(ctx, path, node.type, "synchronization metadata was dropped while visible content was preserved.");
      const children = decodeBlockChildren(node.content, ctx, `${path}.content`);
      return children.length > 0 ? children : [fallbackParagraph(node, `Unsupported ${node.type}`)];
    }
    case "caption":
      addNodeNote(ctx, path, node.type, "could not be attached to a captionable parent and was kept as prose.");
      return [{ type: "paragraph", content: decodeInlineChildren(node.content, ctx, `${path}.content`) }];
    case "placeholder":
      addNodeNote(ctx, path, node.type, "was preserved as visible placeholder text.");
      return [fallbackParagraph(node, "Placeholder")];
    default: {
      addNodeNote(ctx, path, node.type, "has no native block mapping; its visible content was preserved.");
      const children = decodeBlockChildren(node.content, ctx, `${path}.content`);
      return children.length > 0 ? children : [fallbackParagraph(node, `Unsupported Confluence ${node.type}`)];
    }
  }
}

function decodeInlineChildren(
  nodes: readonly AdfNode[] | undefined,
  ctx: DecodeContext,
  path: string,
): InlineNode[] {
  if (!nodes) return [];
  const out: InlineNode[] = [];
  for (let index = 0; index < nodes.length; index += 1) {
    out.push(...decodeInlineNode(nodes[index]!, ctx, `${path}[${index}]`));
  }
  return out;
}

function decodeInlineNode(node: AdfNode, ctx: DecodeContext, path: string): InlineNode[] {
  if (node.type !== "text" && node.type !== "emoji" && node.type !== "date" && node.type !== "placeholder") {
    for (const mark of node.marks ?? []) addMarkNote(ctx, path, mark.type);
  }
  switch (node.type) {
    case "text":
      return applyMarks(node.text ?? "", node.marks ?? [], ctx, path);
    case "hardBreak":
      return [{ type: "lineBreak" }];
    case "emoji": {
      const text = stringAttr(node, "text") ?? stringAttr(node, "shortName") ?? "[emoji]";
      if (!stringAttr(node, "text")) addNodeNote(ctx, path, node.type, "had no Unicode text; its short name was preserved.");
      return applyMarks(text, node.marks ?? [], ctx, path);
    }
    case "date":
      return applyMarks(renderDate(stringAttr(node, "timestamp")), node.marks ?? [], ctx, path);
    case "mention":
      return [{
        type: "mention",
        accountId: stringAttr(node, "id") ?? "",
        ...(stringAttr(node, "text") ? { displayName: stripMentionPrefix(stringAttr(node, "text")!) } : {}),
      }];
    case "status":
      return [{
        type: "status",
        text: stringAttr(node, "text") ?? "",
        color: (stringAttr(node, "color") ?? "neutral").toLowerCase(),
      }];
    case "inlineCard":
      return cardInline(node, ctx, path);
    case "inlineExtension": {
      const controlled = decodeInlineExportControl(node, ctx, path);
      if (controlled) return controlled.content;
      addNodeNote(ctx, path, node.type, "was preserved as a visible inline extension label.");
      const extensionKey = stringAttr(node, "extensionKey") ?? "adf-extension";
      const params = extensionParams(node.attrs?.parameters);
      return [{
        type: "text",
        text: extensionLabel(node),
        adfExtension: {
          extensionType: stringAttr(node, "extensionType") ?? "unknown",
          extensionKey,
          ...(stringAttr(node, "localId") ? { localId: stringAttr(node, "localId") } : {}),
        },
        ...(params.length > 0 ? { extensionParams: params } : {}),
        ...(ctx.pageContext ? {
          sourcePage: {
            id: ctx.pageContext.id,
            ...(ctx.pageContext.version !== undefined ? { version: ctx.pageContext.version } : {}),
            ...(ctx.pageContext.spaceKey ? { spaceKey: ctx.pageContext.spaceKey } : {}),
          },
        } : {}),
      }];
    }
    case "mediaInline":
    case "media":
      addMediaNote(ctx, node, path);
      return [{ type: "text", text: mediaLabel(node) }];
    case "placeholder":
      addNodeNote(ctx, path, node.type, "was preserved as visible placeholder text.");
      return applyMarks(stringAttr(node, "text") ?? "[Placeholder]", node.marks ?? [], ctx, path);
    default: {
      addNodeNote(ctx, path, node.type, "has no native inline mapping; its visible content was preserved.");
      const children = decodeInlineChildren(node.content, ctx, `${path}.content`);
      return children.length > 0 ? children : [{ type: "text", text: `[${node.type}]` }];
    }
  }
}

function applyMarks(
  text: string,
  marks: readonly AdfMark[],
  ctx: DecodeContext,
  path: string,
): InlineNode[] {
  const sorted = [...marks].sort((left, right) => markKey(left).localeCompare(markKey(right)));
  const inlineMarks = new Set<InlineMark>();
  let color: string | undefined;
  let backgroundColor: string | undefined;
  let link: string | undefined;
  for (const mark of sorted) {
    switch (mark.type) {
      case "strong": inlineMarks.add("bold"); break;
      case "em": inlineMarks.add("italic"); break;
      case "code": inlineMarks.add("code"); break;
      case "strike": inlineMarks.add("strike"); break;
      case "underline": inlineMarks.add("underline"); break;
      case "subsup": inlineMarks.add(mark.attrs?.type === "sup" ? "superscript" : "subscript"); break;
      case "textColor": color = normalizeColor(mark.attrs?.color); break;
      case "backgroundColor": backgroundColor = normalizeColor(mark.attrs?.color); break;
      case "link": link ??= stringJson(mark.attrs?.href); break;
      default: addMarkNote(ctx, path, mark.type); break;
    }
  }
  const node: InlineNode = {
    type: "text",
    text,
    ...(inlineMarks.size > 0 ? { marks: [...inlineMarks].sort() } : {}),
    ...(color ? { color } : {}),
    ...(backgroundColor ? { backgroundColor } : {}),
  };
  if (!link) return [node];
  return wrapLink(link, [node], ctx, path);
}

function wrapLink(href: string, content: InlineNode[], ctx: DecodeContext, path: string): InlineNode[] {
  const verdict = sanitizeLinkHref(href);
  if (!verdict.safe) {
    ctx.notes.add({
      level: "warning",
      code: "unsafe-link-skipped",
      message: unsafeLinkMessage(verdict, inlineText(content)),
      source: sourceFor(ctx, path),
    });
    return content;
  }
  return [{ type: "link", target: linkTarget(verdict.href), content }];
}

function linkTarget(href: string): LinkTarget {
  if (href.startsWith("#")) return { kind: "anchor", anchor: decodeURIComponentSafe(href.slice(1)) };
  const attachment = href.match(/\/download\/attachments\/[^/]+\/([^?#]+)/i);
  if (attachment?.[1]) return { kind: "attachment", filename: decodeURIComponentSafe(attachment[1]) };
  const page = href.match(/\/pages\/(\d+)(?:\/([^?#]+))?/i);
  if (page?.[1]) {
    return {
      kind: "page",
      contentId: page[1],
      contentTitle: page[2] ? decodeURIComponentSafe(page[2]).replace(/\+/g, " ") : page[1],
    };
  }
  return { kind: "external", href };
}

function cardInline(node: AdfNode, ctx: DecodeContext, path: string): InlineNode[] {
  const href = cardUrl(node);
  const label = cardTitle(node) ?? href ?? "[Smart link]";
  addNodeNote(ctx, path, node.type, "appearance was approximated as a text link.");
  return href ? wrapLink(href, [{ type: "text", text: label }], ctx, path) : [{ type: "text", text: label }];
}

function cardParagraph(node: AdfNode, ctx: DecodeContext, path: string): ExportBlock {
  return { type: "paragraph", content: cardInline(node, ctx, path) };
}

function decodeExtension(node: AdfNode, ctx: DecodeContext, path: string): ExportBlock {
  addNodeNote(ctx, path, node.type, "was routed through the neutral unresolved-macro contract.");
  const params = extensionParams(node.attrs?.parameters);
  // Match the Storage adapter: unresolved macro-body diagnostics stay attached
  // to the block until a renderer chooses the fallback body. They are not
  // double-counted in the page-level report.
  const bodyCollector = new NoteCollector(ctx.notes.limit);
  const bodyCtx: DecodeContext = { ...ctx, notes: bodyCollector };
  const body = decodeBlockChildren(node.content, bodyCtx, `${path}.content`);
  const bodyNotes = bodyCollector.finish(sourceFor(bodyCtx, `${path}.content`));
  const extensionType = stringAttr(node, "extensionType") ?? "unknown";
  const extensionKey = stringAttr(node, "extensionKey") ?? "adf-extension";
  const adfExtension: AdfExtensionIdentity = {
    extensionType,
    extensionKey,
    ...(stringAttr(node, "localId") ? { localId: stringAttr(node, "localId") } : {}),
  };
  return {
    type: "unknown",
    macroName: extensionKey,
    adfExtension,
    ...(params.length > 0 ? { params } : {}),
    ...(body.length > 0 ? { body } : {}),
    ...(bodyNotes.length > 0 ? { bodyNotes } : {}),
    ...(ctx.pageContext ? {
      sourcePage: {
        id: ctx.pageContext.id,
        ...(ctx.pageContext.version !== undefined ? { version: ctx.pageContext.version } : {}),
        ...(ctx.pageContext.spaceKey ? { spaceKey: ctx.pageContext.spaceKey } : {}),
      },
    } : {}),
  };
}

function decodeBlockExportControl(
  node: AdfNode,
  ctx: DecodeContext,
  path: string,
): { blocks: ExportBlock[] } | undefined {
  const macro = (stringAttr(node, "extensionKey") ?? "").toLowerCase();
  if (macro !== "scroll-only" && macro !== "scroll-ignore") return undefined;
  if (!exportControlKeeps(macro, node, ctx, path)) return { blocks: [] };
  return { blocks: decodeBlockChildren(node.content, ctx, `${path}.content`) };
}

function decodeInlineExportControl(
  node: AdfNode,
  ctx: DecodeContext,
  path: string,
): { content: InlineNode[] } | undefined {
  const macro = (stringAttr(node, "extensionKey") ?? "").toLowerCase();
  if (macro !== "scroll-only-inline" && macro !== "scroll-ignore-inline") return undefined;
  const text = stringAttr(node, "text") ?? descendantText(node);
  const content = text ? [{ type: "text" as const, text }] : [];
  return { content: exportControlKeeps(macro, node, ctx, path) ? content : [] };
}

function exportControlKeeps(
  macro: "scroll-only" | "scroll-ignore" | "scroll-only-inline" | "scroll-ignore-inline",
  node: AdfNode,
  ctx: DecodeContext,
  path: string,
): boolean {
  const base = macro.replace(/-inline$/u, "") as "scroll-only" | "scroll-ignore";
  const target = extensionParamText(node.attrs?.parameters, "exporter")?.trim().toLowerCase();
  const note = (code: ExportNote["code"], message: string, level: ExportNote["level"] = "info"): void => {
    ctx.notes.add({ level, code, message, macroName: macro, source: sourceFor(ctx, path) });
  };
  if (ctx.exportControls === "passthrough") {
    note("export-controls-passthrough", `ADF ${macro} content was retained because export controls are in passthrough mode.`);
    return true;
  }
  if (target && target !== "pdf" && target !== "word") {
    note(
      base === "scroll-only" ? "scroll-only-unknown-exporter" : "scroll-ignore-unknown-exporter",
      `ADF ${macro} named an unknown exporter; its content was retained to avoid silent loss.`,
      "warning",
    );
    return true;
  }
  const effectiveTarget = ctx.exporter ? target : undefined;
  const matches = effectiveTarget === undefined || effectiveTarget === ctx.exporter;
  if (base === "scroll-only") {
    if (matches) {
      note("scroll-only-applied", `ADF ${macro} content applies to this export and was retained.`);
      return true;
    }
    note("scroll-only-skipped-other-exporter", `ADF ${macro} content targets another exporter and was omitted.`);
    return false;
  }
  if (effectiveTarget !== undefined && !matches) {
    note("scroll-ignore-skipped-other-exporter", `ADF ${macro} targets another exporter, so its content was retained.`);
    return true;
  }
  note("scroll-ignore-applied", `ADF ${macro} content applies to this export and was omitted.`);
  return false;
}

function extensionParams(value: AdfJsonValue | undefined): MacroParameter[] {
  if (!value || Array.isArray(value) || typeof value !== "object") return [];
  const macroParams = value.macroParams;
  const source = macroParams && !Array.isArray(macroParams) && typeof macroParams === "object"
    ? macroParams
    : value;
  return Object.keys(source).sort().map((name) => ({
    name: name.toLowerCase(),
    text: extensionParamValue(source[name]!),
  }));
}

function extensionParamText(value: AdfJsonValue | undefined, name: string): string | undefined {
  return extensionParams(value).find((param) => param.name === name.toLowerCase())?.text;
}

function extensionParamValue(value: AdfJsonValue): string {
  if (typeof value === "string") return value;
  if (value && !Array.isArray(value) && typeof value === "object" && typeof value.value === "string") {
    return value.value;
  }
  return stableJson(value);
}

function decodeMediaContainer(node: AdfNode, ctx: DecodeContext, path: string): ExportBlock[] {
  const content = node.content ?? [];
  const captionNode = content.find((child) => child.type === "caption");
  const media = content.filter((child) => child.type !== "caption");
  const blocks = media.flatMap((child, index) => decodeBlockNode(child, ctx, `${path}.content[${index}]`));
  if (captionNode && blocks.length > 0) {
    const caption = decodeCaption(captionNode, ctx, `${path}.caption`);
    const last = blocks[blocks.length - 1]!;
    if (last.type === "table" || last.type === "codeBlock" || last.type === "image") {
      blocks[blocks.length - 1] = { ...last, caption };
    } else {
      blocks.push({ type: "paragraph", content: caption.content });
    }
  }
  return blocks.length > 0 ? blocks : [mediaFallbackBlock(node, ctx, path)];
}

function decodeMediaBlock(node: AdfNode, ctx: DecodeContext, path: string): ExportBlock {
  const id = stringAttr(node, "id");
  const resolved = id ? ctx.resolveMediaAttachment?.({
    id,
    ...(stringAttr(node, "collection") ? { collection: stringAttr(node, "collection") } : {}),
    ...(stringAttr(node, "occurrenceKey") ? { occurrenceKey: stringAttr(node, "occurrenceKey") } : {}),
  }) : undefined;
  if (!resolved?.filename.trim()) return mediaFallbackBlock(node, ctx, path);
  const width = positiveDimension(node.attrs?.width);
  const height = positiveDimension(node.attrs?.height);
  return {
    type: "image",
    source: {
      kind: "attachment",
      filename: resolved.filename,
      ...(resolved.pageId ?? ctx.pageContext?.id ? { pageId: resolved.pageId ?? ctx.pageContext?.id } : {}),
    },
    ...(stringAttr(node, "alt") ? { alt: stringAttr(node, "alt") } : {}),
    ...(width ? { width } : {}),
    ...(height ? { height } : {}),
  };
}

function mediaFallbackBlock(node: AdfNode, ctx: DecodeContext, path: string): ExportBlock {
  addMediaNote(ctx, node, path);
  return { type: "paragraph", content: [{ type: "text", text: mediaLabel(node) }] };
}

function addMediaNote(ctx: DecodeContext, node: AdfNode, path: string): void {
  ctx.notes.add({
    level: "warning",
    code: "adf-media-unresolved",
    message: "ADF media identity could not be correlated to a Confluence attachment; a visible label was preserved.",
    source: { ...sourceFor(ctx, path), ...(stringAttr(node, "alt") ? { assetName: stringAttr(node, "alt") } : {}) },
  }, `media|${path}`);
}

function decodeTable(node: AdfNode, ctx: DecodeContext, path: string): ExportBlock {
  const rowNodes = (node.content ?? []).filter((child) => child.type === "tableRow");
  const rows: TableRow[] = rowNodes.map((row, rowIndex) => ({
    cells: (row.content ?? [])
      .filter((cell) => cell.type === "tableCell" || cell.type === "tableHeader")
      .map((cell, cellIndex) => decodeCell(cell, ctx, `${path}.rows[${rowIndex}].cells[${cellIndex}]`)),
  }));
  const firstRow = rowNodes[0]?.content ?? [];
  const widths = firstRow.flatMap((cell) => numberArrayAttr(cell, "colwidth"));
  const hasWidths = widths.length > 0 && widths.every((width) => width > 0);
  if (node.attrs?.layout !== undefined || node.attrs?.width !== undefined || node.attrs?.displayMode !== undefined) {
    addNodeNote(ctx, path, node.type, "layout-only attributes were approximated by the neutral table model.");
  }
  return { type: "table", rows, ...(hasWidths ? { columnWidths: widths } : {}) };
}

function decodeCell(node: AdfNode, ctx: DecodeContext, path: string): TableCell {
  const colspan = numberInRange(node.attrs?.colspan, 1, 1_000, 1);
  const rowspan = numberInRange(node.attrs?.rowspan, 1, 1_000, 1);
  const backgroundColor = normalizeColor(node.attrs?.background);
  if (node.attrs?.valign !== undefined) addNodeNote(ctx, path, node.type, "vertical alignment was dropped.");
  return {
    header: node.type === "tableHeader",
    colspan,
    rowspan,
    ...(backgroundColor ? { backgroundColor } : {}),
    content: decodeBlockChildren(node.content, ctx, `${path}.content`),
  };
}

function decodeListItems(node: AdfNode, ctx: DecodeContext, path: string) {
  return (node.content ?? []).map((item, index) => ({
    content: decodeBlockChildren(item.content, ctx, `${path}.items[${index}].content`),
  }));
}

function decodeTaskItems(node: AdfNode, ctx: DecodeContext, path: string) {
  return (node.content ?? []).map((item, index) => ({
    content: decodeBlockChildren(item.content, ctx, `${path}.items[${index}].content`),
    checked: stringAttr(item, "state") === "DONE" || stringAttr(item, "state") === "DECIDED",
  }));
}

function decodeCaption(node: AdfNode, ctx: DecodeContext, path: string): Caption {
  return { kind: "figure", content: decodeInlineDescendants(node.content, ctx, `${path}.content`) };
}

function fallbackParagraph(node: AdfNode, label: string): ExportBlock {
  const visible = stringAttr(node, "text") ?? stringAttr(node, "title") ?? `[${label}]`;
  return { type: "paragraph", content: [{ type: "text", text: visible }] };
}

function panelKind(value: string | undefined): "info" | "note" | "warning" | "tip" | "panel" {
  return value === "info" || value === "note" || value === "warning" || value === "tip" ? value : "panel";
}

const INLINE_NODE_TYPES = new Set([
  "date", "emoji", "hardBreak", "inlineCard", "inlineExtension", "mediaInline",
  "mention", "placeholder", "status", "text",
]);

function isInlineNodeType(type: string): boolean {
  return INLINE_NODE_TYPES.has(type);
}

function noteUnhandledNodeMarks(node: AdfNode, ctx: DecodeContext, path: string): void {
  if (!node.marks || node.type === "text") return;
  for (const mark of node.marks) addMarkNote(ctx, path, mark.type);
}

function decodeInlineDescendants(
  nodes: readonly AdfNode[] | undefined,
  ctx: DecodeContext,
  path: string,
): InlineNode[] {
  if (!nodes) return [];
  const out: InlineNode[] = [];
  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index]!;
    const nodePath = `${path}[${index}]`;
    if (isInlineNodeType(node.type)) out.push(...decodeInlineNode(node, ctx, nodePath));
    else out.push(...decodeInlineDescendants(node.content, ctx, `${nodePath}.content`));
  }
  return out;
}

function stringAttr(node: AdfNode, key: string): string | undefined {
  return stringJson(node.attrs?.[key]);
}

function stringJson(value: AdfJsonValue | undefined): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function numberAttr(node: AdfNode, key: string): number | undefined {
  const value = node.attrs?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function numberArrayAttr(node: AdfNode, key: string): number[] {
  const value = node.attrs?.[key];
  return Array.isArray(value)
    ? value.filter((item): item is number => typeof item === "number" && Number.isFinite(item))
    : [];
}

function numberInRange(value: AdfJsonValue | undefined, min: number, max: number, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max ? value : fallback;
}

function positiveDimension(value: AdfJsonValue | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function normalizeColor(value: AdfJsonValue | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  if (/^#[0-9a-f]{6}$/i.test(value)) return value.toUpperCase();
  const short = value.match(/^#([0-9a-f])([0-9a-f])([0-9a-f])$/i);
  return short ? `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`.toUpperCase() : undefined;
}

function renderDate(timestamp: string | undefined): string {
  if (!timestamp) return "[date]";
  if (!/^\d+$/.test(timestamp)) return timestamp;
  const date = new Date(Number(timestamp));
  return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : timestamp;
}

function descendantText(node: AdfNode): string {
  if (node.type === "text") return node.text ?? "";
  return (node.content ?? []).map(descendantText).join("");
}

function inlineText(nodes: readonly InlineNode[]): string {
  return nodes.map((node) => {
    if (node.type === "text") return node.text;
    if (node.type === "link") return inlineText(node.content);
    if (node.type === "mention") return node.displayName ?? node.accountId;
    if (node.type === "status") return node.text;
    return "\n";
  }).join("");
}

function stripMentionPrefix(value: string): string {
  return value.startsWith("@") ? value.slice(1) : value;
}

function extensionLabel(node: AdfNode): string {
  return stringAttr(node, "text") ?? `[Extension: ${stringAttr(node, "extensionKey") ?? "unknown"}]`;
}

function mediaLabel(node: AdfNode): string {
  return stringAttr(node, "alt") ?? `[Media: ${stringAttr(node, "id") ?? "unresolved"}]`;
}

function cardUrl(node: AdfNode): string | undefined {
  const direct = stringAttr(node, "url");
  if (direct) return direct;
  const data = node.attrs?.data;
  if (!data || Array.isArray(data) || typeof data !== "object") return undefined;
  return stringJson(data.url);
}

function cardTitle(node: AdfNode): string | undefined {
  const direct = stringAttr(node, "text");
  if (direct) return direct;
  const data = node.attrs?.data;
  if (!data || Array.isArray(data) || typeof data !== "object") return undefined;
  return stringJson(data.name) ?? stringJson(data.headline) ?? stringJson(data.title);
}

function markKey(mark: AdfMark): string {
  return `${mark.type}\u0000${stableJson(mark.attrs ?? {})}`;
}

function stableJson(value: AdfJsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key]!)}`).join(",")}}`;
}

function decodeURIComponentSafe(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

// Keep the imported document type attached to this adapter's public contract.
export type ValidAdfDocument = AdfDocument;
