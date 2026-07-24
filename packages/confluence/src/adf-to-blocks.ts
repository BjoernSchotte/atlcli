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
  AdfAnnotationComment,
  AdfAnnotationIdentity,
  AdfDataConsumerProvenance,
  Caption,
  AdfExtensionFrame,
  AdfExtensionIdentity,
  AdfFragmentIdentity,
  AdfLinkAttributes,
  AdfUnsupportedAttribute,
  AdfUnsupportedNodeProvenance,
  BlockPresentation,
  EmojiSemantics,
  ExportBlock,
  ExportLink,
  ExportNote,
  ExportNoteSource,
  InlineMark,
  InlineNode,
  LayoutBreakout,
  LayoutColumn,
  LinkTarget,
  ListItem,
  MacroParameter,
  MediaBorder,
  MediaPresentation,
  SmartCardAppearance,
  SmartCardSemantics,
  StorageToBlocksOptions,
  TableCell,
  TablePresentation,
  TableRow,
  UnresolvedMediaIdentity,
} from "./export-blocks.js";
import {
  formatAdfDateTimestamp,
  mentionDisplayText,
  parseAdfDateTimestamp,
  statusDisplayText,
} from "./export-blocks.js";
import { translateDatasourceLink } from "./datasource.js";
import { commentBodyToText } from "./comment-text.js";
import type { InlineComment } from "./client.js";
import { sanitizeLinkHref, unsafeLinkMessage } from "./link-safety.js";
import type { BlocksResult } from "./page-body.js";
import {
  isColonEmojiShortName,
  projectTypedEmoji,
} from "./emoji-projection.js";

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
  /** Exact ADF marker-ref to separately fetched Confluence comment resource. */
  resolveAnnotation?: (markerRef: string) => AdfAnnotationComment | undefined;
  /** False when the comment-sidecar pagination/budget was truncated. */
  annotationCommentsComplete?: boolean;
}

export interface AdfMediaReference {
  id: string;
  collection?: string;
  occurrenceKey?: string;
}

export interface AdfResolvedMediaAttachment {
  filename: string;
  pageId?: string;
  mediaType?: string;
  webuiLink?: string;
  downloadLink?: string;
}

/** Attachment metadata proven to correlate ADF media `id` with v2 `fileId`. */
export interface AdfMediaAttachment {
  fileId: string;
  filename: string;
  pageId: string;
  mediaType?: string;
  webuiLink?: string;
  downloadLink?: string;
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
    byFileId.set(fileId, {
      filename,
      pageId,
      ...(attachment.mediaType?.trim() ? { mediaType: attachment.mediaType.trim() } : {}),
      ...(attachment.webuiLink?.trim() ? { webuiLink: attachment.webuiLink.trim() } : {}),
      ...(attachment.downloadLink?.trim() ? { downloadLink: attachment.downloadLink.trim() } : {}),
    });
  }
  return (reference) => byFileId.get(reference.id);
}

/** Build an exact annotation resolver from a privacy-safe, transient sidecar. */
export function createAdfAnnotationResolver(
  comments: readonly InlineComment[] | undefined,
): AdfToBlocksOptions["resolveAnnotation"] | undefined {
  if (!comments) return undefined;
  const byMarkerRef = new Map<string, AdfAnnotationComment>();
  for (const comment of comments) {
    const markerRef = comment.inlineMarkerRef?.trim();
    if (!markerRef || byMarkerRef.has(markerRef)) continue;
    byMarkerRef.set(markerRef, {
      bodyText: commentBodyToText(comment.body),
      status: comment.status,
      ...(comment.created ? { created: comment.created } : {}),
      replies: comment.replies.map((reply) => ({
        bodyText: commentBodyToText(reply.body),
        ...(reply.created ? { created: reply.created } : {}),
      })),
    });
  }
  return (markerRef) => byMarkerRef.get(markerRef);
}

interface DecodeContext {
  notes: NoteCollector;
  pageContext?: StorageToBlocksOptions["pageContext"];
  resolveMediaAttachment?: AdfToBlocksOptions["resolveMediaAttachment"];
  resolveAnnotation?: AdfToBlocksOptions["resolveAnnotation"];
  annotationCommentsComplete?: boolean;
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

function addExtensionResolutionNote(
  ctx: DecodeContext,
  path: string,
  nodeType: string,
  extensionKey: string,
): void {
  ctx.notes.add(
    {
      level: "warning",
      code: "macro-not-rendered",
      message:
        `ADF ${nodeType} "${extensionKey}" retained its static fallback and awaits macro resolution.`,
      macroName: extensionKey,
      source: sourceFor(ctx, path),
    },
    `extension|${path}|${nodeType}|${extensionKey}`,
  );
}

function addInlineExtensionResolutionNote(
  ctx: DecodeContext,
  path: string,
  extensionKey: string,
): void {
  ctx.notes.add(
    {
      level: "warning",
      code: "inline-extension-not-rendered",
      message:
        `ADF inlineExtension "${extensionKey}" retained its paragraph-local fallback and awaits macro resolution.`,
      macroName: extensionKey,
      source: sourceFor(ctx, path),
    },
    `inline-extension|${path}|${extensionKey}`,
  );
}

function addMarkNote(
  ctx: DecodeContext,
  path: string,
  type: string,
  detail = "is not represented natively; its visible content was preserved.",
): void {
  ctx.notes.add(
    {
      level: "warning",
      code: "adf-mark-degraded",
      message: `ADF mark ${type} ${detail}`,
      source: sourceFor(ctx, path),
    },
    `mark|${path}|${type}|${detail}`,
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
    resolveAnnotation: options.resolveAnnotation,
    annotationCommentsComplete: options.annotationCommentsComplete,
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
  const presentation =
    node.type === "paragraph" || node.type === "heading"
      ? decodeBlockPresentation(node.marks, node.type, ctx, path)
      : undefined;
  if (node.type !== "paragraph" && node.type !== "heading") {
    noteUnhandledNodeMarks(node, ctx, path);
  }
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
        : [{
            type: "paragraph",
            content,
            ...(presentation ? { presentation } : {}),
            ...(optionalStringAttr(node, "localId") !== undefined
              ? { localId: optionalStringAttr(node, "localId") }
              : {}),
          }];
    }
    case "heading":
      return [{
        type: "heading",
        level: numberInRange(node.attrs?.level, 1, 6, 1) as 1 | 2 | 3 | 4 | 5 | 6,
        content: decodeInlineChildren(node.content, ctx, `${path}.content`),
        ...(presentation ? { presentation } : {}),
        ...(optionalStringAttr(node, "localId") !== undefined
          ? { localId: optionalStringAttr(node, "localId") }
          : {}),
      }];
    case "codeBlock": {
      const language = optionalStringAttr(node, "language");
      const localId = optionalStringAttr(node, "localId");
      const uniqueId = optionalStringAttr(node, "uniqueId");
      const breakout = decodeBreakoutIntent(node, ctx, path);
      return [{
        type: "codeBlock",
        code: descendantText(node),
        ...(language !== undefined ? { language } : {}),
        ...(node.attrs?.wrap !== undefined ? { wrap: node.attrs.wrap as boolean } : {}),
        // The official ADF default is to show line numbers. Materialize it so
        // internal/Storage code blocks with no source policy keep their own
        // established behavior instead of inheriting an ADF-only default.
        hideLineNumbers: node.attrs?.hideLineNumbers === true,
        ...(localId !== undefined ? { localId } : {}),
        ...(uniqueId !== undefined ? { uniqueId } : {}),
        ...(breakout ? { breakout } : {}),
      }];
    }
    case "rule":
      return [{ type: "divider" }];
    case "blockquote":
      return [{ type: "blockquote", content: decodeBlockChildren(node.content, ctx, `${path}.content`) }];
    case "bulletList":
      return [{ type: "list", ordered: false, items: decodeListItems(node, ctx, path) }];
    case "orderedList": {
      const order = orderedListStart(node, ctx, path);
      return [{
        type: "list",
        ordered: true,
        items: decodeListItems(node, ctx, path),
        ...(order !== 1 ? { start: order } : {}),
      }];
    }
    case "listItem":
      return decodeBlockChildren(node.content, ctx, `${path}.content`);
    case "taskList":
      return [decodeTaskList(node, ctx, path)];
    case "decisionList":
      return [{
        type: "list",
        ordered: false,
        listKind: "decision",
        ...(stringAttr(node, "localId") ? { localId: stringAttr(node, "localId") } : {}),
        items: (node.content ?? []).map((item, index) =>
          decodeActionItem(item, "decision", ctx, `${path}.items[${index}]`)
        ),
      }];
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
    case "panel": {
      const type = stringAttr(node, "panelType");
      const localId = optionalStringAttr(node, "localId");
      const rawPanelColor = optionalStringAttr(node, "panelColor");
      const normalizedPanelColor = normalizeColor(rawPanelColor);
      const panelColor = normalizedPanelColor ?? rawPanelColor;
      const panelIcon = optionalStringAttr(node, "panelIcon");
      const panelIconId = optionalStringAttr(node, "panelIconId");
      const panelIconText = optionalStringAttr(node, "panelIconText");
      const panelIconResult =
        panelIcon !== undefined && isColonEmojiShortName(panelIcon)
          ? projectTypedEmoji({ shortName: panelIcon })
          : undefined;
      const panelIconProjection =
        panelIconResult?.kind === "known"
          ? panelIconResult.projection
          : undefined;
      if (rawPanelColor !== undefined && normalizedPanelColor === undefined) {
        addNodeNote(
          ctx,
          path,
          node.type,
          "has a non-portable custom color; the exact value was retained and the target default is used.",
        );
      }
      if (
        type === "custom" &&
        panelIconId !== undefined &&
        !(panelIconText || panelIcon)
      ) {
        addNodeNote(
          ctx,
          path,
          node.type,
          "has only a service icon ID; the identity was retained but no portable static icon text exists.",
        );
      }
      if (
        !panelIconText &&
        panelIconResult?.kind === "unresolved"
      ) {
        addNodeNote(
          ctx,
          path,
          node.type,
          "has an unresolved typed panel icon; the exact short name remains visible.",
        );
      }
      return [{
        type: "callout",
        kind: panelKind(type),
        ...(localId !== undefined ? { localId } : {}),
        ...(panelColor !== undefined ? { panelColor } : {}),
        ...(panelIcon !== undefined ? { panelIcon } : {}),
        ...(panelIconId !== undefined ? { panelIconId } : {}),
        ...(panelIconText !== undefined ? { panelIconText } : {}),
        ...(panelIconProjection !== undefined ? { panelIconProjection } : {}),
        content: decodeBlockChildren(node.content, ctx, `${path}.content`),
      }];
    }
    case "expand":
    case "nestedExpand": {
      const breakout = node.type === "expand"
        ? decodeBreakoutIntent(node, ctx, path)
        : undefined;
      ctx.notes.add({
        level: "info",
        code: "expand-static",
        message: "Interactive expand content was rendered open in the static export.",
        source: sourceFor(ctx, path),
      }, `expand-static|${path}`);
      return [{
        type: "expand",
        nested: node.type === "nestedExpand",
        ...(optionalStringAttr(node, "title") !== undefined
          ? { title: optionalStringAttr(node, "title") }
          : {}),
        ...(optionalStringAttr(node, "localId") !== undefined
          ? { localId: optionalStringAttr(node, "localId") }
          : {}),
        ...(breakout ? { breakout } : {}),
        content: decodeBlockChildren(node.content, ctx, `${path}.content`),
      }];
    }
    case "layoutSection":
      return [decodeLayoutSection(node, ctx, path)];
    case "layoutColumn":
      addNodeNote(ctx, path, node.type, "appeared outside a layout section and was preserved in document order.");
      return decodeBlockChildren(node.content, ctx, `${path}.content`);
    case "extension":
    case "bodiedExtension": {
      const controlled = decodeBlockExportControl(node, ctx, path);
      if (controlled) return controlled.blocks;
      return [decodeExtension(node, ctx, path)];
    }
    case "multiBodiedExtension":
      return [decodeMultiBodiedExtension(node, ctx, path)];
    case "extensionFrame":
      addNodeNote(
        ctx,
        path,
        node.type,
        "appeared outside its required multiBodiedExtension parent; its visible body was preserved.",
      );
      return decodeBlockChildren(node.content, ctx, `${path}.content`);
    case "blockCard":
      return decodeBlockCard(node, ctx, path);
    case "embedCard":
      return [{ type: "smartCard", card: decodeSmartCard(node, ctx, path) }];
    case "mediaSingle":
    case "mediaGroup":
      return decodeMediaContainer(node, ctx, path);
    case "media":
      return [decodeMediaBlock(node, ctx, path)];
    case "syncBlock":
    case "bodiedSyncBlock":
      return [decodeSyncedContent(node, ctx, path)];
    case "caption":
      addNodeNote(ctx, path, node.type, "could not be attached to a captionable parent and was kept as prose.");
      return [{ type: "paragraph", content: decodeInlineChildren(node.content, ctx, `${path}.content`) }];
    case "placeholder":
      return [{
        type: "paragraph",
        content: [{
          type: "placeholder",
          text: optionalStringAttr(node, "text") ?? "",
          ...(optionalStringAttr(node, "localId") !== undefined
            ? { localId: optionalStringAttr(node, "localId") }
            : {}),
        }],
      }];
    default: {
      addNodeNote(ctx, path, node.type, "has no native block mapping; its visible content was preserved.");
      const children = decodeBlockChildren(node.content, ctx, `${path}.content`);
      return [{
        type: "unknown",
        macroName: node.type,
        unsupportedAdf: unsupportedNodeProvenance(node, "atlas_doc_format"),
        ...(children.length > 0 ? { body: children } : {}),
      }];
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
    for (const mark of node.marks ?? []) {
      if (!markHandledByNode(node.type, mark.type)) addMarkNote(ctx, path, mark.type);
    }
  }
  switch (node.type) {
    case "text":
      return applyMarks(node.text ?? "", node.marks ?? [], ctx, path);
    case "hardBreak":
      return [{ type: "lineBreak" }];
    case "emoji": {
      const shortName = stringAttr(node, "shortName") ?? "[emoji]";
      // Unlike most optional string attributes, an empty emoji `text` is
      // meaningful: Atlassian emits it for nodes that must fall back to
      // `shortName`, so retain the exact value in the neutral metadata.
      const rawSourceText = node.attrs?.text;
      const sourceText = typeof rawSourceText === "string" ? rawSourceText : undefined;
      const result = projectTypedEmoji({ shortName, sourceText });
      const renderedFrom =
        result.kind === "source-text"
          ? "source-text"
          : result.kind === "known"
            ? "catalog-projection"
            : "short-name";
      const emoji: EmojiSemantics = {
        shortName,
        ...(stringAttr(node, "id") ? { id: stringAttr(node, "id") } : {}),
        ...(sourceText !== undefined ? { text: sourceText } : {}),
        renderedFrom,
        ...(result.kind === "known" ? { projection: result.projection } : {}),
      };
      if (result.kind === "unresolved") {
        ctx.notes.add({
          level: "warning",
          code: "emoji-text-fallback",
          message: "An emoji had no portable Unicode text; its textual short-name fallback was preserved.",
          source: sourceFor(ctx, path),
        });
      }
      return applyMarks(result.text, node.marks ?? [], ctx, path, emoji);
    }
    case "date": {
      const timestamp = stringAttr(node, "timestamp") ?? "";
      if (!parseAdfDateTimestamp(timestamp)) {
        ctx.notes.add({
          level: "warning",
          code: "date-invalid",
          message: "A semantic date timestamp was invalid; its exact source text was preserved.",
          source: sourceFor(ctx, path),
        });
      }
      return [{
        type: "date",
        timestamp,
        ...(optionalStringAttr(node, "localId") !== undefined
          ? { localId: optionalStringAttr(node, "localId") }
          : {}),
      }];
    }
    case "mention": {
      const sourceText = optionalStringAttr(node, "text");
      const localId = optionalStringAttr(node, "localId");
      const accessLevel = optionalStringAttr(node, "accessLevel");
      const userType = node.attrs?.userType;
      return [{
        type: "mention",
        accountId: stringAttr(node, "id") ?? "",
        ...(sourceText !== undefined ? { sourceText } : {}),
        ...(sourceText?.trim() ? { displayName: stripMentionPrefix(sourceText) } : {}),
        ...(localId !== undefined ? { localId } : {}),
        ...(accessLevel !== undefined ? { accessLevel } : {}),
        ...(userType === "DEFAULT" || userType === "SPECIAL" || userType === "APP"
          ? { userType }
          : {}),
      }];
    }
    case "status":
      return [{
        type: "status",
        text: stringAttr(node, "text") ?? "",
        color: (stringAttr(node, "color") ?? "neutral").toLowerCase(),
        ...(optionalStringAttr(node, "localId") !== undefined
          ? { localId: optionalStringAttr(node, "localId") }
          : {}),
        ...(optionalStringAttr(node, "style") !== undefined
          ? { style: optionalStringAttr(node, "style") }
          : {}),
      }];
    case "inlineCard":
      return [{ type: "smartCard", card: decodeSmartCard(node, ctx, path) }];
    case "inlineExtension": {
      const controlled = decodeInlineExportControl(node, ctx, path);
      if (controlled) return controlled.content;
      const extensionKey = stringAttr(node, "extensionKey") ?? "adf-extension";
      addInlineExtensionResolutionNote(ctx, path, extensionKey);
      const params = extensionParams(node.attrs?.parameters);
      const fragments = fragmentMarks(node.marks);
      addFragmentProjectionNote(ctx, path, fragments);
      return [{
        type: "text",
        text: extensionLabel(node),
        adfExtension: {
          extensionType: stringAttr(node, "extensionType") ?? "unknown",
          extensionKey,
          ...(stringAttr(node, "localId") ? { localId: stringAttr(node, "localId") } : {}),
        },
        ...(params.length > 0 ? { extensionParams: params } : {}),
        ...(fragments.length > 0 ? { fragments } : {}),
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
    case "media": {
      return [decodeInlineMedia(node, ctx, path)];
    }
    case "placeholder":
      return [{
        type: "placeholder",
        text: optionalStringAttr(node, "text") ?? "",
        ...(optionalStringAttr(node, "localId") !== undefined
          ? { localId: optionalStringAttr(node, "localId") }
          : {}),
      }];
    default: {
      addNodeNote(ctx, path, node.type, "has no native inline mapping; its visible content was preserved.");
      const children = decodeInlineChildren(node.content, ctx, `${path}.content`);
      return retainUnsupportedInline(
        children,
        unsupportedNodeProvenance(node, "atlas_doc_format"),
      );
    }
  }
}

function unsupportedAttributes(
  attrs: Readonly<Record<string, AdfJsonValue>> | undefined,
): AdfUnsupportedAttribute[] | undefined {
  if (!attrs) return undefined;
  const attributes = Object.entries(attrs).map(([name, value]) => ({ name, value }));
  return attributes.length > 0 ? attributes : undefined;
}

function unsupportedNodeProvenance(
  node: AdfNode,
  sourceRepresentation: AdfUnsupportedNodeProvenance["sourceRepresentation"],
): AdfUnsupportedNodeProvenance {
  const attributes = unsupportedAttributes(node.attrs);
  const marks = (node.marks ?? []).map((mark) => ({
    type: mark.type,
    ...(unsupportedAttributes(mark.attrs)
      ? { attributes: unsupportedAttributes(mark.attrs) }
      : {}),
  }));
  return {
    nodeType: node.type,
    sourceRepresentation,
    ...(attributes ? { attributes } : {}),
    ...(marks.length > 0 ? { marks } : {}),
  };
}

/**
 * Preserve an unsupported inline wrapper without flattening its visible child
 * formatting. The first owned text leaf carries the ordered wrapper stack; a
 * content-free/non-text wrapper gets an explicit visible label.
 */
function retainUnsupportedInline(
  content: InlineNode[],
  provenance: AdfUnsupportedNodeProvenance,
): InlineNode[] {
  let attached = false;
  const visit = (nodes: InlineNode[]): InlineNode[] =>
    nodes.map((node): InlineNode => {
      if (attached) return node;
      if (node.type === "text") {
        attached = true;
        return {
          ...node,
          unsupportedAdf: [...(node.unsupportedAdf ?? []), provenance],
        };
      }
      if (node.type === "link") {
        const linked = visit(node.content);
        return linked === node.content ? node : { ...node, content: linked };
      }
      return node;
    });
  const retained = visit(content);
  return attached
    ? retained
    : [{
        type: "text",
        text: `[Unsupported ADF inline: ${provenance.nodeType}]`,
        unsupportedAdf: [provenance],
      }, ...retained];
}

function applyMarks(
  text: string,
  marks: readonly AdfMark[],
  ctx: DecodeContext,
  path: string,
  emoji?: EmojiSemantics,
): InlineNode[] {
  const sorted = [...marks].sort((left, right) => markKey(left).localeCompare(markKey(right)));
  const inlineMarks = new Set<InlineMark>();
  let color: string | undefined;
  let backgroundColor: string | undefined;
  let link: { href: string; attributes: AdfLinkAttributes } | undefined;
  const annotations: AdfAnnotationIdentity[] = [];
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
      case "link": {
        const href = stringJson(mark.attrs?.href);
        if (link === undefined && href !== undefined) {
          link = {
            href,
            attributes: adfLinkAttributes(mark),
          };
        }
        break;
      }
      case "annotation": {
        const annotation = annotationMark(mark, ctx, path);
        if (annotation) annotations.push(annotation);
        break;
      }
      default: addMarkNote(ctx, path, mark.type); break;
    }
  }
  const node: InlineNode = {
    type: "text",
    text,
    ...(inlineMarks.size > 0 ? { marks: [...inlineMarks].sort() } : {}),
    ...(color ? { color } : {}),
    ...(backgroundColor ? { backgroundColor } : {}),
    ...(emoji ? { emoji } : {}),
    ...(annotations.length > 0 ? { annotations } : {}),
  };
  if (!link) return [node];
  return wrapLink(link.href, [node], ctx, path, link.attributes);
}

function decodeBlockPresentation(
  marks: readonly AdfMark[] | undefined,
  nodeType: "paragraph" | "heading",
  ctx: DecodeContext,
  path: string,
): BlockPresentation | undefined {
  if (!marks || marks.length === 0) return undefined;
  const presentation: BlockPresentation = {};
  for (const mark of [...marks].sort((left, right) => markKey(left).localeCompare(markKey(right)))) {
    if (mark.type === "alignment") {
      const alignment = mark.attrs?.align;
      if (alignment === "center" || alignment === "end") {
        presentation.alignment ??= alignment;
      }
      continue;
    }
    if (mark.type === "indentation") {
      const level = mark.attrs?.level;
      if (Number.isInteger(level) && (level as number) >= 1 && (level as number) <= 6) {
        presentation.indentation ??= level as BlockPresentation["indentation"];
      }
      continue;
    }
    if (mark.type === "fontSize") {
      if (nodeType === "paragraph" && mark.attrs?.fontSize === "small") {
        presentation.fontSize ??= "small";
      } else {
        addMarkNote(ctx, path, mark.type);
      }
      continue;
    }
    addMarkNote(ctx, path, mark.type);
  }
  return presentation.alignment !== undefined ||
    presentation.indentation !== undefined ||
    presentation.fontSize !== undefined
    ? presentation
    : undefined;
}

function wrapLink(
  href: string,
  content: InlineNode[],
  ctx: DecodeContext,
  path: string,
  adfAttributes?: AdfLinkAttributes,
): InlineNode[] {
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
  return [{
    type: "link",
    target: linkTarget(verdict.href),
    content,
    ...(adfAttributes && Object.keys(adfAttributes).length > 0 ? { adfAttributes } : {}),
  }];
}

function linkTarget(href: string): LinkTarget {
  if (href.startsWith("#")) return { kind: "anchor", anchor: decodeURIComponentSafe(href.slice(1)) };
  const attachment = href.match(/\/download\/attachments\/[^/]+\/([^?#]+)/i);
  if (attachment?.[1]) {
    return {
      kind: "attachment",
      filename: decodeURIComponentSafe(attachment[1]),
      href,
    };
  }
  const page = href.match(/\/pages\/(\d+)(?:\/([^?#]+))?/i);
  if (page?.[1]) {
    const hash = href.match(/#([^#]*)$/u)?.[1];
    return {
      kind: "page",
      contentId: page[1],
      contentTitle: page[2] ? decodeURIComponentSafe(page[2]).replace(/\+/g, " ") : page[1],
      ...(hash !== undefined ? { anchor: decodeURIComponentSafe(hash) } : {}),
      href,
    };
  }
  return { kind: "external", href };
}

function optionalMarkString(mark: AdfMark, name: string): string | undefined {
  const value = mark.attrs?.[name];
  return typeof value === "string" ? value : undefined;
}

function adfLinkAttributes(mark: AdfMark): AdfLinkAttributes {
  const optional = (name: string): string | undefined => optionalMarkString(mark, name);
  return {
    ...(optional("title") !== undefined ? { title: optional("title") } : {}),
    ...(optional("id") !== undefined ? { id: optional("id") } : {}),
    ...(optional("collection") !== undefined ? { collection: optional("collection") } : {}),
    ...(optional("occurrenceKey") !== undefined
      ? { occurrenceKey: optional("occurrenceKey") }
      : {}),
  };
}

function mediaLink(
  marks: readonly AdfMark[] | undefined,
  ctx: DecodeContext,
  path: string,
  label: string,
): ExportLink | undefined {
  const mark = [...(marks ?? [])]
    .sort((left, right) => markKey(left).localeCompare(markKey(right)))
    .find((candidate) => candidate.type === "link");
  const href = mark ? stringJson(mark.attrs?.href) : undefined;
  if (!mark || href === undefined) return undefined;
  const verdict = sanitizeLinkHref(href);
  if (!verdict.safe) {
    ctx.notes.add({
      level: "warning",
      code: "unsafe-link-skipped",
      message: unsafeLinkMessage(verdict, label),
      source: sourceFor(ctx, path),
    });
    return undefined;
  }
  const adfAttributes = adfLinkAttributes(mark);
  return {
    target: linkTarget(verdict.href),
    ...(Object.keys(adfAttributes).length > 0 ? { adfAttributes } : {}),
  };
}

function decodeSmartCard(node: AdfNode, ctx: DecodeContext, path: string): SmartCardSemantics {
  const appearance: SmartCardAppearance =
    node.type === "inlineCard" ? "inline" : node.type === "embedCard" ? "embed" : "block";
  const data = node.attrs?.data;
  const datasource = node.attrs?.datasource;
  const source =
    datasource !== undefined ? "datasource" : data !== undefined ? "data" : "url";
  const directUrl = optionalStringAttr(node, "url");
  const dataUrl =
    data !== null && data !== undefined && !Array.isArray(data) && typeof data === "object"
      ? optionalJsonString(data.url)
      : undefined;
  const url = directUrl ?? dataUrl;
  let target: LinkTarget | undefined;
  if (url?.length) {
    const verdict = sanitizeLinkHref(url);
    if (verdict.safe) {
      target = linkTarget(verdict.href);
    } else {
      ctx.notes.add({
        level: "warning",
        code: "unsafe-link-skipped",
        message: unsafeLinkMessage(verdict, cardTitle(node) ?? "Smart link"),
        source: sourceFor(ctx, path),
      });
    }
  }
  const layout = smartCardLayout(node.attrs?.layout);
  return {
    appearance,
    source,
    ...(url !== undefined ? { url } : {}),
    ...(target ? { target } : {}),
    ...(cardTitle(node) !== undefined ? { title: cardTitle(node) } : {}),
    ...(optionalStringAttr(node, "localId") !== undefined
      ? { localId: optionalStringAttr(node, "localId") }
      : {}),
    ...(data !== undefined ? { data } : {}),
    ...(datasource !== undefined ? { datasource } : {}),
    ...(layout ? { layout } : {}),
    ...(numberAttr(node, "width") !== undefined ? { width: numberAttr(node, "width") } : {}),
    ...(numberAttr(node, "originalHeight") !== undefined
      ? { originalHeight: numberAttr(node, "originalHeight") }
      : {}),
    ...(numberAttr(node, "originalWidth") !== undefined
      ? { originalWidth: numberAttr(node, "originalWidth") }
      : {}),
  };
}

function decodeBlockCard(node: AdfNode, ctx: DecodeContext, path: string): ExportBlock[] {
  const card = decodeSmartCard(node, ctx, path);
  if (card.datasource === undefined) return [{ type: "smartCard", card }];

  const outcome = translateDatasourceLink(stableJson(card.datasource), card.url ?? "");
  if (outcome.kind === "degrade") {
    ctx.notes.add({
      level: outcome.level,
      code: outcome.code,
      message: outcome.message,
      ...(outcome.provider
        ? { macroName: outcome.provider.macroName ?? outcome.provider.id }
        : {}),
      source: sourceFor(ctx, path),
    });
    return [{ type: "smartCard", card }];
  }

  ctx.notes.add({
    level: "info",
    code: "macro-not-rendered",
    message:
      `An ADF datasource card was captured as a "${outcome.macroName}" macro; ` +
      "it renders as a live table when dynamic macro resolution runs.",
    macroName: outcome.macroName,
    source: sourceFor(ctx, path),
  });
  return [{
    type: "unknown",
    macroName: outcome.macroName,
    params: outcome.params,
    body: [{ type: "smartCard", card }],
    ...(ctx.pageContext
      ? {
          sourcePage: {
            id: ctx.pageContext.id,
            ...(ctx.pageContext.version !== undefined
              ? { version: ctx.pageContext.version }
              : {}),
            ...(ctx.pageContext.spaceKey !== undefined
              ? { spaceKey: ctx.pageContext.spaceKey }
              : {}),
          },
        }
      : {}),
  }];
}

function smartCardLayout(value: AdfJsonValue | undefined): SmartCardSemantics["layout"] {
  return value === "wide" ||
    value === "full-width" ||
    value === "center" ||
    value === "wrap-right" ||
    value === "wrap-left" ||
    value === "align-end" ||
    value === "align-start"
    ? value
    : undefined;
}

function decodeExtension(node: AdfNode, ctx: DecodeContext, path: string): ExportBlock {
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
  addExtensionResolutionNote(ctx, path, node.type, extensionKey);
  const adfExtension: AdfExtensionIdentity = {
    extensionType,
    extensionKey,
    ...(stringAttr(node, "localId") ? { localId: stringAttr(node, "localId") } : {}),
  };
  const fragments = fragmentMarks(node.marks);
  addFragmentProjectionNote(ctx, path, fragments);
  return {
    type: "unknown",
    macroName: extensionKey,
    adfExtension,
    ...(fragments.length > 0 ? { fragments } : {}),
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

function decodeMultiBodiedExtension(
  node: AdfNode,
  ctx: DecodeContext,
  path: string,
): ExportBlock {
  const extensionType = stringAttr(node, "extensionType") ?? "unknown";
  const extensionKey = stringAttr(node, "extensionKey") ?? "adf-multi-bodied-extension";
  const params = extensionParams(node.attrs?.parameters);
  const extensionFrames: AdfExtensionFrame[] = (node.content ?? []).map((frame, index) => {
    const framePath = `${path}.content[${index}]`;
    const fragments = fragmentMarks(frame.marks);
    const dataConsumers = dataConsumerMarks(frame.marks);
    addFragmentProjectionNote(ctx, framePath, fragments);
    noteDataConsumerProvenance(frame, ctx, framePath);

    const bodyCollector = new NoteCollector(ctx.notes.limit);
    const bodyCtx: DecodeContext = { ...ctx, notes: bodyCollector };
    const content = decodeBlockChildren(frame.content, bodyCtx, `${framePath}.content`);
    const bodyNotes = bodyCollector.finish(sourceFor(bodyCtx, `${framePath}.content`));
    return {
      content,
      ...(fragments.length > 0 ? { fragments } : {}),
      ...(dataConsumers.length > 0 ? { dataConsumers } : {}),
      ...(bodyNotes.length > 0 ? { bodyNotes } : {}),
    };
  });
  const bodyNotes = extensionFrames.flatMap((frame) => frame.bodyNotes ?? []);
  addExtensionResolutionNote(ctx, path, node.type, extensionKey);
  addNodeNote(
    ctx,
    path,
    node.type,
    "retained every Stage-0 extensionFrame boundary and renders the frames sequentially in static output.",
  );
  return {
    type: "unknown",
    macroName: extensionKey,
    adfExtension: {
      extensionType,
      extensionKey,
      ...(stringAttr(node, "localId") ? { localId: stringAttr(node, "localId") } : {}),
    },
    ...(params.length > 0 ? { params } : {}),
    extensionFrames,
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
  const fragments = fragmentMarks(node.marks);
  if (!exportControlKeeps(macro, node, ctx, path)) {
    if (fragments.length > 0) {
      addMarkNote(
        ctx,
        path,
        "fragment",
        "belongs to a consumed export-control wrapper; its intentionally omitted output was reported.",
      );
    }
    return { blocks: [] };
  }
  // Applying a block export-control deliberately removes its extension
  // wrapper. The neutral model has no invisible wrapper slot on which to keep
  // that wrapper's fragment mark, so report the residual instead of silently
  // pretending the identity survived on one arbitrary child.
  if (fragments.length > 0) {
    addMarkNote(
      ctx,
      path,
      "fragment",
      "belongs to a consumed export-control wrapper; its visible body was preserved.",
    );
  }
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
  const fragments = fragmentMarks(node.marks);
  const keep = exportControlKeeps(macro, node, ctx, path);
  if (fragments.length > 0) {
    if (keep && text) {
      addFragmentProjectionNote(ctx, path, fragments);
    } else {
      addMarkNote(
        ctx,
        path,
        "fragment",
        "belongs to a consumed export-control wrapper; its intentionally omitted output was reported.",
      );
    }
  }
  const content = text
    ? [{
        type: "text" as const,
        text,
        ...(fragments.length > 0 ? { fragments } : {}),
      }]
    : [];
  return { content: keep ? content : [] };
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
  let blocks = media.flatMap((child, index) =>
    decodeBlockNode(child, ctx, `${path}.content[${index}]`)
  );
  const containerLink = mediaLink(node.marks, ctx, path, "media");
  if (containerLink) {
    blocks = blocks.map((block) =>
      (block.type === "image" || block.type === "mediaFallback") && block.link === undefined
        ? { ...block, link: containerLink }
        : block
    );
  }
  if (node.type === "mediaSingle") {
    const mediaPresentation = decodeMediaPresentation(node);
    blocks = blocks.map((block) =>
      block.type === "image" || block.type === "mediaFallback"
        ? { ...block, mediaPresentation }
        : block
    );
  }
  if (node.type === "mediaGroup") {
    const size = blocks.filter(
      (block) => block.type === "image" || block.type === "mediaFallback",
    ).length;
    let index = 0;
    blocks = blocks.map((block) => {
      if (block.type !== "image" && block.type !== "mediaFallback") return block;
      const grouped = { ...block, mediaGroup: { index, size } };
      index += 1;
      return grouped;
    });
  }
  if (captionNode && blocks.length > 0) {
    const caption = decodeCaption(captionNode, ctx, `${path}.caption`);
    const last = blocks[blocks.length - 1]!;
    if (
      last.type === "table" ||
      last.type === "codeBlock" ||
      last.type === "image" ||
      last.type === "mediaFallback"
    ) {
      blocks[blocks.length - 1] = { ...last, caption };
    } else {
      blocks.push({ type: "paragraph", content: caption.content });
    }
  }
  return blocks.length > 0 ? blocks : [mediaFallbackBlock(node, ctx, path)];
}

function decodeMediaBlock(node: AdfNode, ctx: DecodeContext, path: string): ExportBlock {
  noteDataConsumerProvenance(node, ctx, path);
  const externalUrl =
    stringAttr(node, "type") === "external" ? optionalStringAttr(node, "url") : undefined;
  if (externalUrl !== undefined) {
    const verdict = sanitizeLinkHref(externalUrl);
    if (verdict.safe) {
      const width = positiveDimension(node.attrs?.width);
      const height = positiveDimension(node.attrs?.height);
      const link = mediaLink(node.marks, ctx, path, stringAttr(node, "alt") ?? externalUrl);
      return {
        type: "image",
        source: { kind: "external", url: verdict.href },
        media: mediaIdentity(node),
        ...(optionalStringAttr(node, "alt") !== undefined
          ? { alt: optionalStringAttr(node, "alt") }
          : {}),
        ...(width ? { width } : {}),
        ...(height ? { height } : {}),
        ...annotationFields(node.marks, ctx, path),
        ...(mediaBorder(node.marks) ? { border: mediaBorder(node.marks) } : {}),
        ...(link ? { link } : {}),
      };
    }
    ctx.notes.add({
      level: "warning",
      code: "unsafe-link-skipped",
      message: unsafeLinkMessage(verdict, stringAttr(node, "alt") ?? "external media"),
      source: sourceFor(ctx, path),
    });
  }
  const id = stringAttr(node, "id");
  const resolved = id ? ctx.resolveMediaAttachment?.({
    id,
    ...(stringAttr(node, "collection") ? { collection: stringAttr(node, "collection") } : {}),
    ...(stringAttr(node, "occurrenceKey") ? { occurrenceKey: stringAttr(node, "occurrenceKey") } : {}),
  }) : undefined;
  if (!resolved?.filename.trim()) return mediaFallbackBlock(node, ctx, path);
  if (resolved.mediaType && !resolved.mediaType.toLowerCase().startsWith("image/")) {
    return mediaFallbackBlock(node, ctx, path, resolved);
  }
  const width = positiveDimension(node.attrs?.width);
  const height = positiveDimension(node.attrs?.height);
  const link = mediaLink(node.marks, ctx, path, stringAttr(node, "alt") ?? "media");
  return {
    type: "image",
    source: {
      kind: "attachment",
      filename: resolved.filename,
      ...(resolved.pageId ?? ctx.pageContext?.id ? { pageId: resolved.pageId ?? ctx.pageContext?.id } : {}),
    },
    media: mediaIdentity(node, resolved),
    ...(stringAttr(node, "alt") ? { alt: stringAttr(node, "alt") } : {}),
    ...(width ? { width } : {}),
    ...(height ? { height } : {}),
    ...annotationFields(node.marks, ctx, path),
    ...(mediaBorder(node.marks) ? { border: mediaBorder(node.marks) } : {}),
    ...(link ? { link } : {}),
  };
}

function decodeInlineMedia(node: AdfNode, ctx: DecodeContext, path: string): InlineNode {
  noteDataConsumerProvenance(node, ctx, path);
  const id = stringAttr(node, "id");
  const resolved = id ? ctx.resolveMediaAttachment?.({
    id,
    ...(stringAttr(node, "collection") ? { collection: stringAttr(node, "collection") } : {}),
    ...(stringAttr(node, "occurrenceKey") ? { occurrenceKey: stringAttr(node, "occurrenceKey") } : {}),
  }) : undefined;
  if (!resolved) addMediaNote(ctx, node, path);
  const isImage = resolved &&
    (resolved.mediaType === undefined || resolved.mediaType.toLowerCase().startsWith("image/"));
  const authoredLink = mediaLink(node.marks, ctx, path, mediaLabel(node));
  const link = authoredLink ?? resolvedAttachmentLink(resolved);
  const width = positiveDimension(node.attrs?.width);
  const height = positiveDimension(node.attrs?.height);
  return {
    type: "media",
    media: mediaIdentity(node, resolved),
    ...(isImage ? {
      source: {
        kind: "attachment",
        filename: resolved.filename,
        ...(resolved.pageId ?? ctx.pageContext?.id
          ? { pageId: resolved.pageId ?? ctx.pageContext?.id }
          : {}),
      } as const,
    } : {}),
    ...(optionalStringAttr(node, "alt") !== undefined
      ? { alt: optionalStringAttr(node, "alt") }
      : {}),
    ...(width ? { width } : {}),
    ...(height ? { height } : {}),
    ...annotationFields(node.marks, ctx, path),
    ...(mediaBorder(node.marks) ? { border: mediaBorder(node.marks) } : {}),
    ...(link ? { link } : {}),
  };
}

function mediaFallbackBlock(
  node: AdfNode,
  ctx: DecodeContext,
  path: string,
  resolved?: AdfResolvedMediaAttachment,
): ExportBlock {
  if (!resolved) addMediaNote(ctx, node, path);
  const width = positiveDimension(node.attrs?.width);
  const height = positiveDimension(node.attrs?.height);
  const authoredLink = mediaLink(node.marks, ctx, path, mediaLabel(node));
  const attachmentLink = resolvedAttachmentLink(resolved);
  const link = authoredLink ?? attachmentLink;
  return {
    type: "mediaFallback",
    label: resolved?.filename ?? mediaLabel(node),
    media: mediaIdentity(node, resolved),
    ...(optionalStringAttr(node, "alt") !== undefined
      ? { alt: optionalStringAttr(node, "alt") }
      : {}),
    ...(width ? { width } : {}),
    ...(height ? { height } : {}),
    ...annotationFields(node.marks, ctx, path),
    ...(mediaBorder(node.marks) ? { border: mediaBorder(node.marks) } : {}),
    ...(link ? { link } : {}),
  };
}

function mediaIdentity(
  node: AdfNode,
  resolved?: AdfResolvedMediaAttachment,
): UnresolvedMediaIdentity {
  const dataConsumers = dataConsumerMarks(node.marks);
  return {
    ...(optionalStringAttr(node, "type") !== undefined
      ? { mediaType: optionalStringAttr(node, "type") }
      : {}),
    ...(optionalStringAttr(node, "id") !== undefined
      ? { id: optionalStringAttr(node, "id") }
      : {}),
    ...(optionalStringAttr(node, "collection") !== undefined
      ? { collection: optionalStringAttr(node, "collection") }
      : {}),
    ...(optionalStringAttr(node, "occurrenceKey") !== undefined
      ? { occurrenceKey: optionalStringAttr(node, "occurrenceKey") }
      : {}),
    ...(optionalStringAttr(node, "localId") !== undefined
      ? { localId: optionalStringAttr(node, "localId") }
      : {}),
    ...(dataConsumers.length > 0 ? { dataConsumers } : {}),
    ...(optionalStringAttr(node, "url") !== undefined
      ? { url: optionalStringAttr(node, "url") }
      : {}),
    ...(node.attrs?.data !== undefined ? { dataJson: stableJson(node.attrs.data) } : {}),
    ...(resolved?.filename ? { filename: resolved.filename } : {}),
    ...(resolved?.pageId ? { pageId: resolved.pageId } : {}),
    ...(resolved?.mediaType ? { attachmentMediaType: resolved.mediaType } : {}),
    ...(resolved?.webuiLink ? { webuiLink: resolved.webuiLink } : {}),
    ...(resolved?.downloadLink ? { downloadLink: resolved.downloadLink } : {}),
  };
}

function resolvedAttachmentLink(
  resolved: AdfResolvedMediaAttachment | undefined,
): ExportLink | undefined {
  const href = resolved?.webuiLink ?? resolved?.downloadLink;
  if (!href) return undefined;
  const verdict = sanitizeLinkHref(href);
  return verdict.safe ? { target: { kind: "external", href: verdict.href } } : undefined;
}

function decodeMediaPresentation(node: AdfNode): MediaPresentation {
  const layout = stringAttr(node, "layout");
  const width = node.attrs?.width;
  const widthType = stringAttr(node, "widthType");
  return {
    layout:
      layout === "wide" ||
      layout === "full-width" ||
      layout === "wrap-right" ||
      layout === "wrap-left" ||
      layout === "align-end" ||
      layout === "align-start"
        ? layout
        : "center",
    ...(typeof width === "number" && Number.isFinite(width) ? { width } : {}),
    ...(widthType === "pixel" || widthType === "percentage" ? { widthType } : {}),
    ...(optionalStringAttr(node, "localId") !== undefined
      ? { localId: optionalStringAttr(node, "localId") }
      : {}),
  };
}

function mediaBorder(marks: readonly AdfMark[] | undefined): MediaBorder | undefined {
  const mark = marks?.find((candidate) => candidate.type === "border");
  const color = mark?.attrs?.color;
  const size = mark?.attrs?.size;
  return typeof color === "string" &&
      /^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/iu.test(color) &&
      (size === 1 || size === 2 || size === 3)
    ? { color: color.toUpperCase(), size }
    : undefined;
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
  const sourceWidth = numberAttr(node, "width");
  if (sourceWidth !== undefined && sourceWidth <= 0) {
    addNodeNote(
      ctx,
      path,
      node.type,
      "has a non-positive width; the source value was retained and exporters use their portable default width.",
    );
  }
  const rowNodes = (node.content ?? []).filter((child) => child.type === "tableRow");
  const rows: TableRow[] = rowNodes.map((row, rowIndex) => ({
    cells: (row.content ?? [])
      .filter((cell) => cell.type === "tableCell" || cell.type === "tableHeader")
      .map((cell, cellIndex) => decodeCell(cell, ctx, `${path}.rows[${rowIndex}].cells[${cellIndex}]`)),
    ...(optionalStringAttr(row, "localId") !== undefined
      ? { localId: optionalStringAttr(row, "localId") }
      : {}),
  }));
  const firstRow = rowNodes[0]?.content ?? [];
  const widths = firstRow.flatMap((cell) => numberArrayAttr(cell, "colwidth"));
  const hasWidths = widths.length > 0 && widths.every((width) => width > 0);
  const presentation: TablePresentation = {
    ...(node.attrs?.layout !== undefined ? { layout: node.attrs.layout as TablePresentation["layout"] } : {}),
    ...(sourceWidth !== undefined ? { width: sourceWidth } : {}),
    ...(node.attrs?.displayMode !== undefined
      ? { displayMode: node.attrs.displayMode as TablePresentation["displayMode"] }
      : {}),
    ...(node.attrs?.isNumberColumnEnabled !== undefined
      ? { numberedColumn: node.attrs.isNumberColumnEnabled as boolean }
      : {}),
    ...(optionalStringAttr(node, "localId") !== undefined
      ? { localId: optionalStringAttr(node, "localId") }
      : {}),
  };
  const fragments = fragmentMarks(node.marks);
  addFragmentProjectionNote(ctx, path, fragments);
  return {
    type: "table",
    rows,
    ...(hasWidths ? { columnWidths: widths } : {}),
    ...(Object.keys(presentation).length > 0 ? { presentation } : {}),
    ...(fragments.length > 0 ? { fragments } : {}),
  };
}

function decodeLayoutSection(node: AdfNode, ctx: DecodeContext, path: string): ExportBlock {
  const columnNodes = (node.content ?? []).filter((child) => child.type === "layoutColumn");
  const columns: LayoutColumn[] = columnNodes.map((column, index) => ({
    width: numberAttr(column, "width") ?? 0,
    ...(optionalStringAttr(column, "valign") !== undefined
      ? { verticalAlignment: optionalStringAttr(column, "valign") as LayoutColumn["verticalAlignment"] }
      : {}),
    ...(optionalStringAttr(column, "localId") !== undefined
      ? { localId: optionalStringAttr(column, "localId") }
      : {}),
    content: decodeBlockChildren(column.content, ctx, `${path}.columns[${index}].content`),
  }));
  if (columns.some((column) => column.width === 0)) {
    addNodeNote(
      ctx,
      path,
      node.type,
      "contains a zero-width column; source widths were retained and exporters enforce a visible minimum track.",
    );
  }
  const breakout = decodeBreakoutIntent(node, ctx, path);
  return {
    type: "layout",
    columns,
    ...(optionalStringAttr(node, "localId") !== undefined
      ? { localId: optionalStringAttr(node, "localId") }
      : {}),
    ...(breakout ? { breakout } : {}),
  };
}

function decodeSyncedContent(
  node: AdfNode,
  ctx: DecodeContext,
  path: string,
): ExportBlock {
  const embedded = node.type === "bodiedSyncBlock";
  const breakout = decodeBreakoutIntent(node, ctx, path);
  addNodeNote(
    ctx,
    path,
    node.type,
    embedded
      ? "was exported from its embedded static snapshot; synchronization was not executed and opaque identity remains non-visual."
      : "was retained as an unresolved static reference; no public resolver contract is available and opaque identity remains non-visual.",
  );
  const content = embedded
    ? decodeBlockChildren(node.content, ctx, `${path}.content`)
    : [{
        type: "paragraph" as const,
        content: [{
          type: "text" as const,
          text: "Synced content is unavailable in this static export.",
        }],
      }];
  return {
    type: "callout",
    kind: "panel",
    title: embedded ? "Synced content snapshot" : "Synced content",
    content,
    syncedContent: {
      resourceId: optionalStringAttr(node, "resourceId") ?? "",
      localId: optionalStringAttr(node, "localId") ?? "",
      projection: embedded ? "embedded-snapshot" : "unresolved-reference",
      ...(breakout ? { breakout } : {}),
    },
  };
}

function decodeCell(node: AdfNode, ctx: DecodeContext, path: string): TableCell {
  const colspan = numberInRange(node.attrs?.colspan, 1, 1_000, 1);
  const rowspan = numberInRange(node.attrs?.rowspan, 1, 1_000, 1);
  const backgroundColor = normalizeColor(node.attrs?.background);
  const columnWidths = numberArrayAttr(node, "colwidth");
  const hasColumnWidths = Array.isArray(node.attrs?.colwidth);
  const verticalAlignment = node.attrs?.valign as TableCell["verticalAlignment"];
  return {
    header: node.type === "tableHeader",
    colspan,
    rowspan,
    ...(backgroundColor ? { backgroundColor } : {}),
    ...(hasColumnWidths ? { columnWidths } : {}),
    ...(verticalAlignment !== undefined ? { verticalAlignment } : {}),
    ...(optionalStringAttr(node, "localId") !== undefined
      ? { localId: optionalStringAttr(node, "localId") }
      : {}),
    content: decodeBlockChildren(node.content, ctx, `${path}.content`),
  };
}

function decodeListItems(node: AdfNode, ctx: DecodeContext, path: string) {
  return (node.content ?? []).map((item, index) => ({
    content: decodeBlockChildren(item.content, ctx, `${path}.items[${index}].content`),
    ...(optionalStringAttr(item, "localId") !== undefined
      ? { localId: optionalStringAttr(item, "localId") }
      : {}),
  }));
}

function decodeTaskList(node: AdfNode, ctx: DecodeContext, path: string): ExportBlock {
  const items: ListItem[] = [];
  for (let index = 0; index < (node.content?.length ?? 0); index += 1) {
    const item = node.content![index]!;
    const itemPath = `${path}.items[${index}]`;
    if (item.type === "taskList") {
      const nested = decodeTaskList(item, ctx, itemPath);
      const parent = items.at(-1);
      if (parent) {
        parent.content.push(nested);
      } else {
        addNodeNote(ctx, itemPath, item.type, "an orphan nested task list was preserved as an unmarked container.");
        items.push({ content: [nested] });
      }
      continue;
    }
    items.push(decodeActionItem(item, "task", ctx, itemPath));
  }
  return {
    type: "list",
    ordered: false,
    listKind: "task",
    ...(stringAttr(node, "localId") ? { localId: stringAttr(node, "localId") } : {}),
    items,
  };
}

function decodeActionItem(
  node: AdfNode,
  kind: "task" | "decision",
  ctx: DecodeContext,
  path: string,
): ListItem {
  const state = stringAttr(node, "state") ?? (kind === "task" ? "TODO" : "");
  const isBlock = node.type === "blockTaskItem";
  const contentPath = `${path}.content`;
  const children = node.content ?? [];
  const content = isBlock || children.some((child) => !INLINE_NODE_TYPES.has(child.type))
    ? decodeBlockChildren(children, ctx, contentPath)
    : [{ type: "paragraph" as const, content: decodeInlineChildren(children, ctx, contentPath) }];
  return {
    content,
    kind,
    state,
    ...(stringAttr(node, "localId") ? { localId: stringAttr(node, "localId") } : {}),
    ...(isBlock ? { block: true } : {}),
    ...(kind === "task" ? { checked: state === "DONE" } : {}),
  };
}

function decodeCaption(node: AdfNode, ctx: DecodeContext, path: string): Caption {
  return {
    kind: "figure",
    content: decodeInlineDescendants(node.content, ctx, `${path}.content`),
    ...(optionalStringAttr(node, "localId") !== undefined
      ? { localId: optionalStringAttr(node, "localId") }
      : {}),
  };
}

function panelKind(
  value: string | undefined,
): "info" | "note" | "warning" | "tip" | "success" | "error" | "panel" {
  return value === "info" ||
    value === "note" ||
    value === "warning" ||
    value === "tip" ||
    value === "success" ||
    value === "error"
    ? value
    : "panel";
}

const INLINE_NODE_TYPES = new Set([
  "date", "emoji", "hardBreak", "inlineCard", "inlineExtension", "mediaInline",
  "mention", "placeholder", "status", "text", "unsupportedInline",
]);

function isInlineNodeType(type: string): boolean {
  return INLINE_NODE_TYPES.has(type);
}

function noteUnhandledNodeMarks(node: AdfNode, ctx: DecodeContext, path: string): void {
  if (!node.marks || node.type === "text") return;
  for (const mark of node.marks) {
    if (!markHandledByNode(node.type, mark.type)) addMarkNote(ctx, path, mark.type);
  }
}

function markHandledByNode(nodeType: string, markType: string): boolean {
  if (markType === "annotation") {
    return nodeType === "media" || nodeType === "mediaInline";
  }
  if (markType === "fragment") {
    return nodeType === "extension" ||
      nodeType === "bodiedExtension" ||
      nodeType === "inlineExtension" ||
      nodeType === "extensionFrame" ||
      nodeType === "table";
  }
  if (markType === "link") {
    return nodeType === "media" ||
      nodeType === "mediaInline" ||
      nodeType === "mediaSingle";
  }
  if (markType === "border") {
    return nodeType === "media" || nodeType === "mediaInline";
  }
  if (markType === "dataConsumer") {
    return nodeType === "media" ||
      nodeType === "mediaInline" ||
      nodeType === "extensionFrame";
  }
  if (markType === "breakout") {
    return nodeType === "layoutSection" ||
      nodeType === "codeBlock" ||
      nodeType === "expand" ||
      nodeType === "syncBlock" ||
      nodeType === "bodiedSyncBlock";
  }
  return false;
}

function dataConsumerMarks(
  marks: readonly AdfMark[] | undefined,
): AdfDataConsumerProvenance[] {
  const consumers: AdfDataConsumerProvenance[] = [];
  for (const mark of marks ?? []) {
    if (mark.type !== "dataConsumer") continue;
    const sources = mark.attrs?.sources;
    if (!Array.isArray(sources) || !sources.every((source) => typeof source === "string")) {
      continue;
    }
    consumers.push({ sources: [...sources] });
  }
  return consumers;
}

function noteDataConsumerProvenance(
  node: AdfNode,
  ctx: DecodeContext,
  path: string,
): void {
  if (dataConsumerMarks(node.marks).length === 0) return;
  addMarkNote(
    ctx,
    path,
    "dataConsumer",
    "sources were retained as non-visual provenance; static output does not execute product-internal consumer bindings.",
  );
}

function breakoutMark(marks: readonly AdfMark[] | undefined): LayoutBreakout | undefined {
  const mark = marks?.find((candidate) => candidate.type === "breakout");
  const mode = mark?.attrs?.mode;
  if (mode !== "wide" && mode !== "full-width") return undefined;
  const width = mark?.attrs?.width;
  return {
    mode,
    ...(typeof width === "number" && Number.isFinite(width) ? { width } : {}),
  };
}

function decodeBreakoutIntent(
  node: AdfNode,
  ctx: DecodeContext,
  path: string,
): LayoutBreakout | undefined {
  const breakout = breakoutMark(node.marks);
  if (!breakout) return undefined;
  addMarkNote(
    ctx,
    path,
    "breakout",
    breakout.width !== undefined && breakout.width <= 0
      ? "has a non-positive width; the source value was retained and exporters use page-bounded width."
      : `retains ${breakout.mode} intent but is bounded to the physical output page.`,
  );
  return breakout;
}

function annotationMark(
  mark: AdfMark,
  ctx: DecodeContext,
  path: string,
): AdfAnnotationIdentity | undefined {
  if (mark.type !== "annotation") return undefined;
  const id = mark.attrs?.id;
  if (typeof id !== "string" || mark.attrs?.annotationType !== "inlineComment") {
    return undefined;
  }
  const comment = id ? ctx.resolveAnnotation?.(id) : undefined;
  if (!comment) {
    ctx.notes.add(
      {
        level: "warning",
        code: "adf-annotation-unresolved",
        message:
          "An ADF inline-comment range could not be correlated to its Confluence comment resource; the range identity was retained.",
        source: sourceFor(ctx, path),
      },
      `annotation-unresolved|${path}|${id}`,
    );
    if (ctx.annotationCommentsComplete === false) {
      ctx.notes.add(
        {
          level: "warning",
          code: "adf-annotation-comments-truncated",
          message:
            "Inline-comment pagination reached its configured export budget; some ADF annotation resources may be absent.",
          source: sourceFor(ctx, "blocks"),
        },
        "annotation-comments-truncated",
      );
    }
  }
  return {
    id,
    annotationType: "inlineComment",
    ...(comment ? { comment } : {}),
  };
}

function annotationFields(
  marks: readonly AdfMark[] | undefined,
  ctx: DecodeContext,
  path: string,
): { annotations?: AdfAnnotationIdentity[] } {
  const annotations = (marks ?? [])
    .slice()
    .sort((left, right) => markKey(left).localeCompare(markKey(right)))
    .map((mark) => annotationMark(mark, ctx, path))
    .filter((value): value is AdfAnnotationIdentity => value !== undefined);
  return annotations.length > 0 ? { annotations } : {};
}

function fragmentMarks(marks: readonly AdfMark[] | undefined): AdfFragmentIdentity[] {
  const fragments: AdfFragmentIdentity[] = [];
  for (const mark of marks ?? []) {
    if (mark.type !== "fragment") continue;
    const localId = mark.attrs?.localId;
    if (typeof localId !== "string" || localId.length === 0) continue;
    const name = mark.attrs?.name;
    fragments.push({
      localId,
      ...(typeof name === "string" ? { name } : {}),
    });
  }
  return fragments;
}

function addFragmentProjectionNote(
  ctx: DecodeContext,
  path: string,
  fragments: readonly AdfFragmentIdentity[],
): void {
  if (fragments.length === 0) return;
  addMarkNote(
    ctx,
    path,
    "fragment",
    "identity is retained as non-visual product provenance; no user navigation target was declared.",
  );
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

function optionalStringAttr(node: AdfNode, key: string): string | undefined {
  const value = node.attrs?.[key];
  return typeof value === "string" ? value : undefined;
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

function orderedListStart(node: AdfNode, ctx: DecodeContext, path: string): number {
  const raw = node.attrs?.order;
  if (raw === undefined) return 1;
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0) {
    addNodeNote(ctx, path, node.type, "has an invalid ordered-list start; the target default was used.");
    return 1;
  }
  const maxPortableStart = 2_147_483_647;
  if (raw > maxPortableStart) {
    addNodeNote(ctx, path, node.type, `starts above ${maxPortableStart}; the portable target maximum was used.`);
    return maxPortableStart;
  }
  return raw;
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

function descendantText(node: AdfNode): string {
  if (node.type === "text") return node.text ?? "";
  return (node.content ?? []).map(descendantText).join("");
}

function inlineText(nodes: readonly InlineNode[]): string {
  return nodes.map((node) => {
    if (node.type === "text") return node.text;
    if (node.type === "link") return inlineText(node.content);
    if (node.type === "mention") return mentionDisplayText(node);
    if (node.type === "date") return formatAdfDateTimestamp(node.timestamp);
    if (node.type === "status") return statusDisplayText(node);
    if (node.type === "placeholder") return "";
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

function cardTitle(node: AdfNode): string | undefined {
  const data = node.attrs?.data;
  if (!data || Array.isArray(data) || typeof data !== "object") return undefined;
  return optionalJsonString(data.name) ??
    optionalJsonString(data.headline) ??
    optionalJsonString(data.title);
}

function optionalJsonString(value: AdfJsonValue | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
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
