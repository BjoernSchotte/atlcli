/**
 * Dependency-free, renderer-neutral document model shared by every export and
 * publishing surface.
 *
 * Source adapters own parsing, validation, authenticated fetching, and
 * source-specific correlation. This package owns only resolved content shapes,
 * stable note vocabulary, and pure presentation-neutral helpers.
 */

type AdfJsonValue =
  | null
  | boolean
  | number
  | string
  | AdfJsonValue[]
  | { [key: string]: AdfJsonValue };

interface PortableEmojiProjection {
  canonicalName:
    | "smile"
    | "sad"
    | "cheeky"
    | "laugh"
    | "wink"
    | "thumbs-up"
    | "thumbs-down"
    | "tick"
    | "cross"
    | "warning"
    | "information"
    | "question"
    | "light-on"
    | "light-off"
    | "yellow-star"
    | "red-star"
    | "green-star"
    | "blue-star"
    | "heart"
    | "broken-heart"
    | "plus"
    | "minus";
  text: string;
}

function isColonEmojiShortName(value: string): boolean {
  return value.length >= 3 &&
    value.startsWith(":") &&
    value.endsWith(":") &&
    !/\s/u.test(value);
}

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

/** Inline text formatting marks. Modeled as a set, not pre-rendered delimiters. */
export type InlineMark =
  | "bold"
  | "italic"
  | "code"
  | "strike"
  | "underline"
  | "subscript"
  | "superscript";

/** Where a link points. External URLs, Confluence page refs, attachments, in-page anchors. */
export type LinkTarget =
  | { kind: "external"; href: string }
  /**
   * A link to another Confluence page. `contentId` is the `ri:content-id`
   * attribute Confluence emits for links created via its page picker; it is the
   * most reliable target key when duplicate page titles exist (spec 002 anchor
   * rewrite resolves by `contentId` first). Optional + backwards compatible:
   * hand-authored `ri:content-title`-only links leave it unset.
   */
  | {
      kind: "page";
      contentTitle: string;
      contentId?: string;
      spaceKey?: string;
      anchor?: string;
      /**
       * Exact safe source href. Composed exports prefer an in-document target;
       * single-page/out-of-scope exports retain this as their clickable fallback.
       */
      href?: string;
    }
  | {
      kind: "attachment";
      filename: string;
      /** Exact safe source href used when no host-specific attachment resolver runs. */
      href?: string;
    }
  | { kind: "anchor"; anchor: string };

/** Exact optional provenance carried by the pinned ADF `link` mark. */
export interface AdfLinkAttributes {
  title?: string;
  id?: string;
  collection?: string;
  occurrenceKey?: string;
}

/** A resolved-safe link plus its exact optional ADF provenance. */
export interface ExportLink {
  target: LinkTarget;
  adfAttributes?: AdfLinkAttributes;
}

/** The three display modes represented by ADF Smart Card node types. */
export type SmartCardAppearance = "inline" | "block" | "embed";

/**
 * Target-neutral, lossless projection of a pinned ADF Smart Card node.
 *
 * `data` and `datasource` remain JSON because the pinned schema deliberately
 * leaves these provider-owned payloads open. Static renderers use only the
 * stable title/URL projection and never execute or fetch that opaque data.
 * `target` exists only when the URL passed the shared link-safety gate.
 */
export interface SmartCardSemantics {
  appearance: SmartCardAppearance;
  source: "url" | "data" | "datasource";
  url?: string;
  target?: LinkTarget;
  title?: string;
  localId?: string;
  data?: AdfJsonValue;
  datasource?: AdfJsonValue;
  layout?:
    | "wide"
    | "full-width"
    | "center"
    | "wrap-right"
    | "wrap-left"
    | "align-end"
    | "align-start";
  width?: number;
  originalHeight?: number;
  originalWidth?: number;
}

/** Deterministic visible label shared by both static export engines. */
export function smartCardDisplayText(card: SmartCardSemantics): string {
  const title = card.title?.trim();
  if (title) return title;
  const url = card.url?.trim();
  if (url) return url;
  return card.source === "datasource" ? "Datasource" : "Smart link";
}

/**
 * A typed inline node. Serializers render these to runs/spans; the model never
 * pre-renders formatting into strings.
 */
export type InlineNode =
  | {
      type: "text";
      text: string;
      marks?: InlineMark[];
      /** Canonical foreground color (`#RRGGBB`), when Confluence supplied one. */
      color?: string;
      /** Canonical inline highlight/background color (`#RRGGBB`). */
      backgroundColor?: string;
      /**
       * Stored emoji semantics retained alongside the portable visible text.
       * `text` is the exact optional source attribute (including an empty
       * string); `renderedFrom` records whether the visible run uses that text,
       * a reviewed catalog projection, or the exact unresolved short name.
       */
      emoji?: EmojiSemantics;
      /** Identity retained when this visible text approximates an ADF inline extension. */
      adfExtension?: AdfExtensionIdentity;
      /** Structured ADF inline-extension parameters, kept separate from identity. */
      extensionParams?: MacroParameter[];
      /** Source page of an approximated inline extension. */
      sourcePage?: { id: string; version?: number; spaceKey?: string };
      /** ADF inline-comment source ranges retained independently of comment bodies. */
      annotations?: AdfAnnotationIdentity[];
      /** ADF fragment identities retained without inventing bookmark semantics. */
      fragments?: AdfFragmentIdentity[];
      /**
       * Unsupported ADF inline wrappers retained on the first visible text run
       * they own. Arrays preserve nested wrapper boundaries in source order.
       */
      unsupportedAdf?: AdfUnsupportedNodeProvenance[];
    }
  | ({
      type: "link";
      content: InlineNode[];
    } & ExportLink)
  /**
   * A user or collection mention. The source identity and presentation
   * attributes remain metadata; renderers never expose `accountId` merely
   * because a display-name lookup failed.
   */
  | {
      type: "mention";
      accountId: string;
      /** Resolved or source-derived visible name without the leading `@`. */
      displayName?: string;
      /** Exact optional ADF textual representation, including an empty string. */
      sourceText?: string;
      /** Stable editor identity, retained as non-visual metadata. */
      localId?: string;
      /** Exact optional product access scope from the pinned ADF node. */
      accessLevel?: string;
      /** Exact pinned mention category. */
      userType?: "DEFAULT" | "SPECIAL" | "APP";
    }
  /**
   * A semantic calendar date. ADF stores Unix epoch milliseconds as a string;
   * keeping that source value avoids baking one viewer's locale into the
   * target-neutral document model.
   */
  | { type: "date"; timestamp: string; localId?: string }
  /**
   * A Confluence status lozenge. Storage may expose legacy color names in
   * addition to ADF's pinned semantic colors, so `color` remains an exact
   * string while the ADF validator enforces its narrower source contract.
   */
  | { type: "status"; text: string; color: string; localId?: string; style?: string }
  | { type: "smartCard"; card: SmartCardSemantics }
  | {
      type: "media";
      media: UnresolvedMediaIdentity;
      /** Correlated image source. Non-image files deliberately omit it. */
      source?: ImageSource;
      alt?: string;
      width?: number;
      height?: number;
      border?: MediaBorder;
      annotations?: AdfAnnotationIdentity[];
      link?: ExportLink;
    }
  /**
   * Template instruction text. Confluence hides placeholders in published
   * view; exporters retain the identity but deliberately render no visible
   * text.
   */
  | { type: "placeholder"; text: string; localId?: string; placeholderType?: string }
  | { type: "lineBreak" };

/** Parse an ADF date timestamp (Unix epoch milliseconds) without guessing units. */
export function parseAdfDateTimestamp(timestamp: string): Date | undefined {
  if (!/^-?\d+$/u.test(timestamp)) return undefined;
  const milliseconds = Number(timestamp);
  if (!Number.isSafeInteger(milliseconds)) return undefined;
  const date = new Date(milliseconds);
  return Number.isFinite(date.getTime()) ? date : undefined;
}

/**
 * Format an ADF date in the document locale while keeping UTC calendar
 * semantics stable across Node, browsers, and developer time zones.
 */
export function formatAdfDateTimestamp(timestamp: string, locale = "en"): string {
  const date = parseAdfDateTimestamp(timestamp);
  if (!date) return timestamp;
  const requested = locale.trim().replace(/_/gu, "-") || "en";
  const options: Intl.DateTimeFormatOptions = {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  };
  try {
    return new Intl.DateTimeFormat(requested, options).format(date);
  } catch {
    return new Intl.DateTimeFormat("en", options).format(date);
  }
}

/** Match Atlassian's published-view casing while retaining the exact source text. */
export function statusDisplayText(
  status: Pick<Extract<InlineNode, { type: "status" }>, "text" | "color" | "style">,
): string {
  const text = status.text || status.color;
  return status.style === "mixedCase" ? text : text.toUpperCase();
}

/**
 * Deterministic, privacy-safe mention text shared by both static renderers.
 * The account/collection ID remains available to resolvers but is never used
 * as an accidental published label.
 */
export function mentionDisplayText(
  mention: Pick<
    Extract<InlineNode, { type: "mention" }>,
    "displayName" | "userType"
  >,
): string {
  const resolved = mention.displayName?.trim();
  if (resolved) return resolved;
  return mention.userType === "APP" ? "Unknown app" : "Unknown user";
}

export type TableVerticalAlignment = "top" | "middle" | "bottom";

export type TableLayout =
  | "default"
  | "wide"
  | "full-width"
  | "center"
  | "align-start"
  | "align-end";

export type TableDisplayMode = "default" | "fixed";

/**
 * Source table presentation retained independently from portable row/cell
 * geometry. Optional members distinguish an omitted ADF attribute from its
 * explicit default value.
 */
export interface TablePresentation {
  layout?: TableLayout;
  /** Authored ADF table width in CSS pixels. */
  width?: number;
  displayMode?: TableDisplayMode;
  /** ADF's implicit first column that visibly numbers every source row. */
  numberedColumn?: boolean;
  /** Stable ADF editor identity. */
  localId?: string;
  /** Authored table identifier used by the Chart macro's `tables` selector. */
  sourceId?: string;
}

/** A table cell. Confluence `<th>` → `header: true`. colspan/rowspan default to 1. */
export interface TableCell {
  header: boolean;
  colspan: number;
  rowspan: number;
  /** Canonical source background color (`#RRGGBB`), when Confluence supplied one. */
  backgroundColor?: string;
  /** Exact ADF per-cell `colwidth` vector, including zero/unfixed tracks. */
  columnWidths?: number[];
  /** Portable ADF/Storage vertical cell alignment. */
  verticalAlignment?: TableVerticalAlignment;
  /** Stable ADF/Storage editor identity, including an explicitly empty value. */
  localId?: string;
  /** Authored HTML/ADF title used by the Chart macro's `columns` selector. */
  title?: string;
  content: ExportBlock[];
}

export interface TableRow {
  cells: TableCell[];
  /** Stable ADF/Storage editor identity, including an explicitly empty value. */
  localId?: string;
}

export interface LayoutBreakout {
  mode: "wide" | "full-width";
  /** Optional authored breakout width from ADF, retained in source units. */
  width?: number;
}

export interface LayoutColumn {
  /** Authored share of the section width, expressed as a percentage. */
  width: number;
  verticalAlignment?: TableVerticalAlignment;
  /** Stable ADF editor identity, including an explicitly empty value. */
  localId?: string;
  content: ExportBlock[];
}

/**
 * Target-neutral multi-column page layout.
 *
 * ADF supplies exact percentage tracks. Storage's named layout shapes are
 * projected onto the same percentages so renderers do not need source-specific
 * branches.
 */
export interface PageLayout {
  columns: LayoutColumn[];
  /** Stable ADF editor identity, including an explicitly empty value. */
  localId?: string;
  breakout?: LayoutBreakout;
}

/**
 * Exact ADF synchronization identity attached to a static callout projection.
 *
 * Static exports never execute Confluence's product-internal synchronization.
 * A bodied block carries the embedded snapshot; a reference-only block carries
 * a visible unavailable-content fallback. Opaque IDs remain non-visual.
 */
export interface SyncedContentProvenance {
  resourceId: string;
  localId: string;
  projection: "embedded-snapshot" | "unresolved-reference";
  breakout?: LayoutBreakout;
}

/**
 * A list item. `checked` is the backwards-compatible task checkbox projection;
 * typed task/decision identity and exact state live in the adjacent fields.
 * A normal bullet/number item leaves all semantic fields undefined.
 */
export interface ListItem {
  content: ExportBlock[];
  /**
   * Typed static semantics for ADF task/decision items. Ordinary list items
   * omit this field; Storage task lists use `task`.
   */
  kind?: "task" | "decision";
  /** Exact ADF state (`TODO`/`DONE` for tasks; product-defined for decisions). */
  state?: string;
  /** Stable editor identity when the source representation exposes it. */
  localId?: string;
  /** Distinguishes ADF `blockTaskItem` from its inline `taskItem` sibling. */
  block?: boolean;
  checked?: boolean;
}

/**
 * Presentation semantics authored on an ADF block. These remain logical and
 * target-neutral: serializers decide the physical indent and how logical
 * `end` alignment maps into their own writing-direction model.
 */
export interface BlockPresentation {
  alignment?: "center" | "end";
  indentation?: 1 | 2 | 3 | 4 | 5 | 6;
  /** ADF's bounded paragraph font-size semantic; the pinned schema currently exposes only `small`. */
  fontSize?: "small";
}

/** Where an image's bytes come from. */
export type ImageSource =
  /**
   * A page attachment. `pageId` is the id of the page the attachment lives on;
   * it lets a multi-page (tree/space) export resolve an attachment against the
   * right page instead of a `filename@pageId` multiplexing hack (spec 002,
   * A1(c)). Optional and backwards compatible: single-page export leaves it
   * unset (set by `fetchExportTree` via {@link StorageToBlocksOptions.pageContext}).
   */
  | { kind: "attachment"; filename: string; pageId?: string }
  /**
   * An external image URL. `trust` marks provenance (spec 004): `"page"`
   * (default/absent) is a page-author `<ac:image>` external ref on today's asset
   * path; `"export-view"` is a URL rendered by a third-party app's macro HTML
   * (untrusted) — the asset seam routes it through the stricter
   * `ExternalAssetFetcher`/`ExternalAssetPolicy`. Set to `"export-view"` only by
   * {@link htmlToExportBlocks}.
   */
  | { kind: "external"; url: string; trust?: "page" | "export-view" };

/** Confluence callout kinds plus the generic/custom titled panel fallback. */
export type CalloutKind = "info" | "note" | "warning" | "tip" | "success" | "error" | "panel";

/** Standard callouts that receive a portable semantic icon by default. */
export type StandardCalloutKind = Exclude<CalloutKind, "panel">;

/**
 * Target-neutral meaning and glyph for one standard callout kind.
 *
 * Renderers must not emit `symbol` as an ordinary text run. P1 renders a
 * graphical target-specific icon and exposes `label` exactly once as its
 * replacement text.
 */
export interface SemanticCalloutIcon {
  kind: StandardCalloutKind;
  symbol: string;
  label: string;
}

export const SEMANTIC_CALLOUT_ICONS: Readonly<Record<StandardCalloutKind, SemanticCalloutIcon>> =
  Object.freeze({
    info: Object.freeze({ kind: "info", symbol: "ℹ", label: "Info" }),
    note: Object.freeze({ kind: "note", symbol: "✎", label: "Note" }),
    warning: Object.freeze({ kind: "warning", symbol: "⚠", label: "Warning" }),
    tip: Object.freeze({ kind: "tip", symbol: "💡", label: "Tip" }),
    success: Object.freeze({ kind: "success", symbol: "✓", label: "Success" }),
    error: Object.freeze({ kind: "error", symbol: "✕", label: "Error" }),
  });

export type ResolvedCalloutIcon =
  | { source: "explicit"; text: string }
  | { source: "semantic-default"; icon: SemanticCalloutIcon };

/** What a {@link Caption} labels — drives the serializer's numbering prefix (Figure/Table/…). */
export type CaptionKind = "figure" | "table" | "code" | "equation";

/**
 * A caption attached to a captionable block (figure/table/code/equation). Its
 * `content` is typed inline nodes so a mention inside a caption resolves the
 * same way as anywhere else (see `resolve-mentions.ts`). Native ADF
 * `mediaSingle` captions and Storage `scroll-title` macros both use this shape.
 */
export interface Caption {
  kind: CaptionKind;
  content: InlineNode[];
  /** Stable ADF editor identity, including an explicitly empty value. */
  localId?: string;
}

/** Source identity retained for an ADF media node that could not be correlated. */
export interface UnresolvedMediaIdentity {
  mediaType?: string;
  id?: string;
  collection?: string;
  occurrenceKey?: string;
  localId?: string;
  /** Exact ordered `dataConsumer` marks retained as non-visual provenance. */
  dataConsumers?: AdfDataConsumerProvenance[];
  /** Exact external-media URL from ADF, retained independently from live-link policy. */
  url?: string;
  /** Stable JSON serialization of the schema-permitted opaque `mediaInline.data` payload. */
  dataJson?: string;
  /** Host-proven attachment filename for a correlated Media Services file ID. */
  filename?: string;
  /** Page that owns the correlated attachment. */
  pageId?: string;
  /** MIME type returned by the official Confluence v2 attachment resource. */
  attachmentMediaType?: string;
  /** Exact safe attachment UI/download targets returned by Confluence. */
  webuiLink?: string;
  downloadLink?: string;
}

/** Static border authored on an ADF `media` or `mediaInline` node. */
export interface MediaBorder {
  /** Canonical source color. Eight-digit ADF colors retain their alpha channel. */
  color: string;
  size: 1 | 2 | 3;
}

export type MediaLayout =
  | "wide"
  | "full-width"
  | "center"
  | "wrap-right"
  | "wrap-left"
  | "align-end"
  | "align-start";

/**
 * Presentation owned by an ADF `mediaSingle` container. Source dimensions on
 * the child media remain separate so renderers can apply the container width
 * without destroying the media's intrinsic geometry.
 */
export interface MediaPresentation {
  layout: MediaLayout;
  width?: number;
  widthType?: "percentage" | "pixel";
  localId?: string;
}

/** Position of one item inside an ADF `mediaGroup` attachment/gallery boundary. */
export interface MediaGroupPosition {
  index: number;
  size: number;
}

/** Deterministic visible fallback for inline media in static text flows. */
export function inlineMediaDisplayText(
  media: Pick<Extract<InlineNode, { type: "media" }>, "media" | "alt">,
): string {
  return media.alt?.trim() ||
    media.media.filename?.trim() ||
    media.media.id?.trim() ||
    "Media";
}

/** Visible static label for a block media card or unresolved media fallback. */
export function mediaFallbackDisplayText(
  block: Pick<
    Extract<ExportBlock, { type: "mediaFallback" }>,
    "media" | "alt" | "label"
  >,
): string {
  const label = block.alt?.trim() || block.media.filename?.trim() || block.label;
  if (block.media.filename) {
    const mediaType = block.media.attachmentMediaType?.trim();
    return `Attachment: ${label}${mediaType ? ` (${mediaType})` : ""}`;
  }
  if (block.media.mediaType === "link") return `Linked media: ${label}`;
  return `Media unavailable: ${label}`;
}

/**
 * A structured reference captured from a macro parameter's `ri:*` child
 * element (never raw XML — a typed projection of the five reference shapes
 * the markdown→storage converter and hand-authored storage both emit:
 * `ri:page`, `ri:attachment`, `ri:url`, `ri:user`, `ri:space`).
 */
export type MacroParamRef =
  | { kind: "page"; contentId?: string; contentTitle?: string; spaceKey?: string; anchor?: string }
  | { kind: "attachment"; filename: string }
  | { kind: "url"; value: string }
  | { kind: "user"; accountId: string }
  | { kind: "space"; spaceKey: string };

/**
 * One `<ac:parameter>`. `name` is the lowercased `ac:name` attribute — the
 * empty string for the unnamed first parameter some macros use (e.g.
 * `include`/`excerpt-include`'s page ref, `markdown.ts:333`). `text` holds
 * trimmed text content when present (today's `elementText` semantics);
 * `refs` holds every `ri:*` child in document order — most parameters have
 * at most one, but `spaces` (`blog-posts`) can carry several sibling
 * `ri:space` refs under a single parameter. A parameter can have `text`,
 * `refs`, both (mixed content), or neither (empty parameter).
 */
export interface MacroParameter {
  name: string;
  text?: string;
  refs?: MacroParamRef[];
}

/**
 * Identity carried by an ADF extension node.
 *
 * `localId` identifies the editor extension instance. It remains separate from
 * Storage's `ac:macro-id` in the neutral model. For Forge macros, however,
 * Confluence's macro-body/export REST contract explicitly uses this ADF local
 * ID as the macro ID; the live export-view resolver applies that documented
 * projection at the port boundary.
 */
export interface AdfExtensionIdentity {
  extensionType: string;
  extensionKey: string;
  localId?: string;
}

/**
 * One Stage-0 `extensionFrame` inside a multi-bodied extension.
 *
 * Static exporters retain frame boundaries and visible child blocks while
 * keeping product-internal fragment/data-consumer bindings non-visual.
 */
export interface AdfExtensionFrame {
  content: ExportBlock[];
  fragments?: AdfFragmentIdentity[];
  dataConsumers?: AdfDataConsumerProvenance[];
  bodyNotes?: ExportNote[];
}

/** One reply attached to an ADF inline comment. */
export interface AdfAnnotationReply {
  bodyText: string;
  created?: string;
}

/** Portable projection of the separately fetched Confluence comment resource. */
export interface AdfAnnotationComment {
  bodyText: string;
  status: "open" | "resolved";
  created?: string;
  replies: AdfAnnotationReply[];
}

/** Identity of an ADF inline-comment annotation mark and correlated resource. */
export interface AdfAnnotationIdentity {
  id: string;
  annotationType: "inlineComment";
  comment?: AdfAnnotationComment;
}

/**
 * Identity of an ADF fragment mark. This is product-owned source provenance,
 * not a user-authored bookmark or link target.
 */
export interface AdfFragmentIdentity {
  localId: string;
  /** Optional source name, including the schema-valid empty string. */
  name?: string;
}

/** One exact, ordered attribute retained from an unsupported ADF wrapper. */
export interface AdfUnsupportedAttribute {
  name: string;
  value: AdfJsonValue;
}

/** One exact mark retained from an unsupported direct-ADF wrapper. */
export interface AdfUnsupportedMark {
  type: string;
  attributes?: AdfUnsupportedAttribute[];
}

/**
 * Product/legacy ADF wrapper provenance retained without publishing opaque
 * attributes in the static artifact. Visible child content stays renderable;
 * this record prevents the wrapper type and attributes from disappearing.
 */
export interface AdfUnsupportedNodeProvenance {
  nodeType: string;
  sourceRepresentation: "atlas_doc_format" | "storage";
  attributes?: AdfUnsupportedAttribute[];
  marks?: AdfUnsupportedMark[];
}

/**
 * One ADF `dataConsumer` mark retained on media without executing the
 * product-internal consumer binding. Mark boundaries and source order remain
 * exact; renderers deliberately keep these opaque identifiers non-visual.
 */
export interface AdfDataConsumerProvenance {
  sources: string[];
}

/** Portable identity and fallback provenance for an ADF/Storage emoji node. */
export interface EmojiSemantics {
  shortName: string;
  id?: string;
  text?: string;
  renderedFrom: "source-text" | "catalog-projection" | "short-name";
  projection?: PortableEmojiProjection;
}

/**
 * Select the already-decided portable text for an explicit ADF panel icon.
 *
 * This helper deliberately does not resolve short names. Source adapters own
 * that decision and may attach `panelIconProjection`; renderers consume only
 * this precedence chain.
 */
export function panelIconDisplayText(panel: {
  panelIcon?: string;
  panelIconText?: string;
  panelIconProjection?: PortableEmojiProjection;
}): string | undefined {
  if (panel.panelIconText) return panel.panelIconText;
  if (panel.panelIcon && !isColonEmojiShortName(panel.panelIcon)) {
    return panel.panelIcon;
  }
  if (panel.panelIconProjection) return panel.panelIconProjection.text;
  return panel.panelIcon || undefined;
}

/**
 * Resolve one callout icon without erasing its provenance.
 *
 * Explicit source metadata always wins. Storage's authored `icon=false`
 * suppression then wins over semantic defaults. Generic/custom panels never
 * receive a default.
 */
export function resolveCalloutIcon(callout: {
  kind: CalloutKind;
  panelIcon?: string;
  panelIconText?: string;
  panelIconProjection?: PortableEmojiProjection;
  suppressDefaultIcon?: boolean;
}): ResolvedCalloutIcon | undefined {
  const explicit = panelIconDisplayText(callout);
  if (explicit) return { source: "explicit", text: explicit };
  if (callout.suppressDefaultIcon || callout.kind === "panel") return undefined;
  return {
    source: "semantic-default",
    icon: SEMANTIC_CALLOUT_ICONS[callout.kind],
  };
}

/**
 * Case-insensitive convenience lookup for a parameter's plain-text value only
 * (mirrors the internal `macroParam` helper). Returns `undefined` for
 * ref-only or absent parameters — callers that need `ri:*` data read `refs`
 * directly. When duplicate names exist, the first match wins.
 */
export function macroParamText(
  params: MacroParameter[] | undefined,
  name: string
): string | undefined {
  if (!params) return undefined;
  const target = name.toLowerCase();
  for (const p of params) {
    if (p.name.toLowerCase() === target) return p.text;
  }
  return undefined;
}

/**
 * A block-level element. Discriminated on `type`. This is the unit both the
 * DOCX and Typst serializers iterate.
 *
 * The `pageBreak`, `orientation` and `anchor` variants are fed by the
 * `scroll-pagebreak`/`scroll-landscape`/`scroll-bookmark` walker features
 * (T1.4); until the engines learn real rendering (T1.3/T1.5) both serializers
 * render them as no-ops (`pageBreak`/`anchor` → nothing, `orientation` →
 * its `content` children rendered transparently, never dropped).
 */
export type ExportBlock =
  | {
      type: "heading";
      level: 1 | 2 | 3 | 4 | 5 | 6;
      content: InlineNode[];
      explicitAnchor?: string;
      presentation?: BlockPresentation;
      /** Stable ADF/Storage editor identity, retained as non-visual metadata. */
      localId?: string;
    }
  | {
      type: "paragraph";
      content: InlineNode[];
      presentation?: BlockPresentation;
      /** Stable ADF/Storage editor identity, retained as non-visual metadata. */
      localId?: string;
    }
  | { type: "smartCard"; card: SmartCardSemantics }
  | {
      type: "codeBlock";
      language?: string;
      code: string;
      /**
       * Legacy Storage code-macro title. Static targets render it as the header
       * row above the code body, independently from a numbered `caption`.
       */
      title?: string;
      /**
       * Authored legacy Storage `collapse` state. Static targets always retain
       * the complete body and report when an initially collapsed block was
       * rendered open.
       */
      initiallyCollapsed?: boolean;
      caption?: Caption;
      /**
       * Exact ADF wrapping preference. `undefined` retains the schema's
       * deliberate "no authored preference" state.
       */
      wrap?: boolean;
      /**
       * Normalized, one-based source-line highlights. Renderers may use this
       * bounded data only to select their fixed highlight presentation; it is
       * never an arbitrary highlighter meta/config string.
       */
      highlightLines?: readonly number[];
      /**
       * Normalized line-number policy. Direct ADF materializes its documented
       * default (`false`); Storage adapters materialize their own legacy
       * default so renderers never have to guess the source representation.
       */
      hideLineNumbers?: boolean;
      /** Storage code-macro start ordinal; direct ADF always starts at one. */
      firstLineNumber?: number;
      /** Stable ADF editor identity, retained as non-visual metadata. */
      localId?: string;
      /** Stable ADF code-block identity, retained independently of `localId`. */
      uniqueId?: string;
      /** Root-level ADF wide/full-width intent, bounded by static page geometry. */
      breakout?: LayoutBreakout;
    }
  | {
      type: "callout";
      kind: CalloutKind;
      title?: string;
      content: ExportBlock[];
      /** Stable ADF editor identity, retained as non-visual metadata. */
      localId?: string;
      /** Canonical portable color, or exact source value when it is not portable. */
      panelColor?: string;
      /** Exact custom-panel emoji short name or portable textual icon fallback. */
      panelIcon?: string;
      /** Exact custom emoji service identity, retained for authorized resolvers. */
      panelIconId?: string;
      /** Exact custom-panel visible icon text, preferred by static renderers. */
      panelIconText?: string;
      /** Reviewed portable projection for a typed colon-shaped panel icon. */
      panelIconProjection?: PortableEmojiProjection;
      /** Authored Storage `icon=false`; prevents a semantic default icon. */
      suppressDefaultIcon?: boolean;
      /** Exact ADF synced-content identity retained behind the static projection. */
      syncedContent?: SyncedContentProvenance;
    }
  | {
      /**
       * A static export of Confluence's disclosure/accordion container.
       * `nested` distinguishes ADF `nestedExpand` (and Storage expands inside
       * table cells) without coupling either renderer to the source format.
       */
      type: "expand";
      nested: boolean;
      content: ExportBlock[];
      title?: string;
      /** Stable ADF editor identity, including an explicitly empty value. */
      localId?: string;
      /** Storage macro identity; deliberately distinct from ADF `localId`. */
      macroId?: string;
      /** Root-level ADF wide/full-width intent, bounded by static page geometry. */
      breakout?: LayoutBreakout;
    }
  | {
      type: "list";
      ordered: boolean;
      items: ListItem[];
      /** First visible ordinal for an ordered list. Omitted means the target default (1). */
      start?: number;
      /** Distinguishes ADF/Storage task and ADF decision lists from ordinary lists. */
      listKind?: "task" | "decision";
      /** Stable ADF/Storage editor identity when the representation exposes it. */
      localId?: string;
    }
  | ({ type: "layout" } & PageLayout)
  | {
      type: "chart";
      chart: import("./charts.js").ChartModelV1;
      caption?: Caption;
      diagnostics?: import("./charts.js").ChartDiagnosticV1[];
      /** Stable ADF/Storage editor identity, retained as non-visual metadata. */
      localId?: string;
    }
  | {
      type: "table";
      rows: TableRow[];
      columnWidths?: number[];
      presentation?: TablePresentation;
      caption?: Caption;
      fragments?: AdfFragmentIdentity[];
    }
  | {
      type: "image";
      source: ImageSource;
      /** Complete ADF media identity, when this image came from an ADF media node. */
      media?: UnresolvedMediaIdentity;
      alt?: string;
      width?: number;
      height?: number;
      mediaPresentation?: MediaPresentation;
      mediaGroup?: MediaGroupPosition;
      border?: MediaBorder;
      caption?: Caption;
      annotations?: AdfAnnotationIdentity[];
      /** Media or media-container link mark, retained for clickable output. */
      link?: ExportLink;
    }
  | {
      /**
       * Visible, non-fetching projection of an ADF media node whose Media
       * Services ID could not be correlated to an attachment. Keeping this as
       * a block lets a native ADF caption remain associated and numbered.
       */
      type: "mediaFallback";
      label: string;
      media: UnresolvedMediaIdentity;
      caption?: Caption;
      alt?: string;
      width?: number;
      height?: number;
      mediaPresentation?: MediaPresentation;
      mediaGroup?: MediaGroupPosition;
      border?: MediaBorder;
      annotations?: AdfAnnotationIdentity[];
      /** Media or media-container link mark, retained for clickable fallback output. */
      link?: ExportLink;
    }
  | { type: "blockquote"; content: ExportBlock[] }
  | { type: "divider" }
  /** A hard page break (`scroll-pagebreak`). Engines render nothing until T1.3/T1.5. */
  | { type: "pageBreak" }
  /**
   * A page-orientation region (`scroll-landscape`). `content` is walked
   * recursively; engines render the children transparently (no real
   * orientation switch) until T1.5, so no content is ever lost.
   */
  | { type: "orientation"; landscape: boolean; content: ExportBlock[] }
  /** A named in-page anchor / bookmark (`scroll-bookmark`). No nested content. */
  | { type: "anchor"; name: string }
  /**
   * An unrecognized macro. Never carries raw XML — the captured parameters and
   * body are structured data (typed refs + walked blocks), not passthrough. All
   * enrichment fields are optional so the block stays backward-compatible with
   * `{ type: "unknown", macroName }`.
   */
  | { type: "unknown"; macroName: string;
      /** Every `<ac:parameter>`, in document order, losslessly typed. */
      params?: MacroParameter[];
      /** `<ac:rich-text-body>`, recursively walked. */
      body?: ExportBlock[];
      /** `<ac:plain-text-body>` text, verbatim. */
      plainBody?: string;
      /** The `ac:macro-id` attribute. */
      macroId?: string;
      /**
       * ADF editor-extension identity. It stays distinct from Storage
       * `macroId`; the live Forge export port may use its documented `localId`.
       */
      adfExtension?: AdfExtensionIdentity;
      /**
       * Ordered Stage-0 multi-bodied extension frames. `body`, when also
       * present, is their flattened compatibility projection for macro
       * renderers; DOCX/PDF use these frames to retain the authored grouping.
       */
      extensionFrames?: AdfExtensionFrame[];
      /** ADF fragment identities retained without inventing bookmark semantics. */
      fragments?: AdfFragmentIdentity[];
      /** Unsupported ADF wrapper type/attributes retained as exact provenance. */
      unsupportedAdf?: AdfUnsupportedNodeProvenance;
      /**
       * Notes the scratch walk of `body` produced but did NOT merge into the
       * top-level report — preserved on the block for a later consumer (Lane E,
       * T1.7) to promote rather than silently discarded.
       */
      bodyNotes?: ExportNote[];
      /**
       * The page this macro was found on, in a multi-page (tree/space) export.
       * Cross-plan sync point for specs 004 (macro renderer) and 010 (extension
       * `export_view` page-context resolution): a macro resolved against the
       * wrong source page is a silent correctness bug. Set by `fetchExportTree`
       * via {@link StorageToBlocksOptions.pageContext}; unset for single-page
       * export. Backwards compatible (optional).
       */
      sourcePage?: { id: string; version?: number; spaceKey?: string } };

export interface MaterializedTable {
  rows: TableRow[];
  columnWidths?: number[];
}

const MAX_MATERIALIZED_TABLE_COLUMNS = 200;

/**
 * Materialize ADF's implicit numbered column once for every renderer.
 *
 * The source rows deliberately stay unchanged in the neutral model. This
 * helper gives DOCX and PDF the same visible 1-based row numbering and the
 * same narrow leading track without making the implicit cells look authored.
 */
export function materializeTable(
  table: Extract<ExportBlock, { type: "table" }>,
): MaterializedTable {
  if (table.presentation?.numberedColumn !== true) {
    return {
      rows: table.rows,
      ...(table.columnWidths !== undefined ? { columnWidths: table.columnWidths } : {}),
    };
  }

  const rows = table.rows.map((row, index): TableRow => ({
    ...row,
    cells: [{
      header: true,
      colspan: 1,
      rowspan: 1,
      content: [{
        type: "paragraph",
        content: [{ type: "text", text: String(index + 1) }],
      }],
    }, ...row.cells],
  }));

  const sourceWidths = table.columnWidths;
  if (
    sourceWidths !== undefined &&
    sourceWidths.length > 0 &&
    sourceWidths.length <= MAX_MATERIALIZED_TABLE_COLUMNS &&
    sourceWidths.every((width) => Number.isFinite(width) && width > 0)
  ) {
    return { rows, columnWidths: [48, ...sourceWidths] };
  }

  const sourceColumnCount = table.rows.reduce(
    (maximum, row) => Math.max(
      maximum,
      row.cells.reduce((count, cell) => {
        if (count >= MAX_MATERIALIZED_TABLE_COLUMNS) return count;
        const span = Number.isSafeInteger(cell.colspan) && cell.colspan > 0
          ? Math.min(cell.colspan, MAX_MATERIALIZED_TABLE_COLUMNS)
          : 1;
        return Math.min(MAX_MATERIALIZED_TABLE_COLUMNS, count + span);
      }, 0),
    ),
    0,
  );
  if (sourceColumnCount === 0) return { rows };

  const legacyWidth = table.presentation?.layout === "wide"
    ? 960
    : table.presentation?.layout === "full-width"
      ? 1800
      : 760;
  const tableWidth =
    table.presentation?.width !== undefined &&
    Number.isFinite(table.presentation.width) &&
    table.presentation.width > 0
    ? table.presentation.width
    : legacyWidth;
  const sourceTrack = Math.max(48, (tableWidth - 48) / sourceColumnCount);
  return {
    rows,
    columnWidths: [48, ...Array.from({ length: sourceColumnCount }, () => sourceTrack)],
  };
}

export * from "./charts.js";

/**
 * Provenance of an {@link ExportNote} — where in a (possibly multi-page) export
 * the observation originated. Additive optional field (spec 003, owner of the
 * contract) that 011-quality-gates' cross-engine report-parity check reads and
 * 004-macro-renderer adopts for its own note codes. Every field is optional so
 * a single-page export (no page context, no path threading) leaves it absent
 * and stays byte-identical to before.
 */
export interface ExportNoteSource {
  /** The source page's id (from {@link StorageToBlocksOptions.pageContext}). */
  pageId?: string;
  /** The source page's title, when the host threads it. */
  pageTitle?: string;
  /** The source page's canonical URL, when the host threads it. */
  pageUrl?: string;
  /** The emitting block's position in the tree (e.g. `blocks[3].content[0]`). */
  blockPath?: string;
  /** The name of an asset the note is about (image/attachment filename). */
  assetName?: string;
}

/**
 * Every stable machine code an {@link ExportNote} can carry (spec 009,
 * "Stabilize ExportNote.code"). This is the single registry: renaming or
 * removing a member is a breaking API change (it shows up in the api-report
 * diff), and emitting a code that is not listed here is a type error at the
 * call site plus a failure of `scripts/export-note-codes.test.ts`, which
 * walks every real emission site in the repo. Grouped by emitter.
 */
export const EXPORT_NOTE_CODES = [
  // Confluence storage walk (storageToBlocks)
  "unknown-macro",
  "macro-not-rendered",
  "inline-extension-not-rendered",
  "image-unresolved",
  // Aggregate-only diagnostics for an explicit image-quality profile
  // (issue #118 Phase 1): counts/bytes/reasons, never media or names.
  "image-profile-applied",
  "inline-image-skipped",
  "layout-geometry-fallback",
  // Shared static-target projection of Confluence's interactive disclosure.
  "expand-static",
  // Shared ADF/Storage fact: no portable Unicode display was available.
  "emoji-text-fallback",
  // Shared ADF/Storage fact: a semantic date could not be interpreted as an
  // epoch-millisecond calendar value and is therefore shown as source text.
  "date-invalid",
  // ADF adapter degradations. These are representation facts shared by every
  // host/renderer; DOCX and PDF receive the same notes with the same paths.
  "adf-node-degraded",
  "adf-mark-degraded",
  "adf-attribute-dropped",
  "adf-media-unresolved",
  "adf-annotation-unresolved",
  "adf-annotation-comments-truncated",
  "adf-storage-fallback",
  // Datasource smart links (`<a data-datasource>`, the modern Cloud replacement
  // for the Jira table macro). Every degradation is typed and visible: the
  // pre-change behaviour was a raw percent-encoded URL in the body with an
  // EMPTY report, which is the bug these four codes exist to prevent.
  "datasource-invalid",
  "datasource-provider-unknown",
  "datasource-provider-unsupported",
  "datasource-filter-unsupported",
  "datasource-cross-site",
  // A datasource whose parameters compose to NO query fragment. Emitted instead
  // of issuing an unbounded site-wide search that would look like a rendered
  // table while answering a question nobody asked.
  "datasource-query-empty",
  // One requested table column could not be filled: either its key has no
  // mapping, or the mapping produced an empty value on every row. The Jira
  // round proved this drift real (`issuetype` vs `type`), and a silently blank
  // column is indistinguishable from empty data.
  "datasource-column-unresolved",
  // Scope orchestration / tree fetch (spec 002)
  "page-unreadable",
  "subtree-unreadable",
  "tree-cycle",
  "page-ambiguous-404",
  "page-version-changed",
  "label-filtered",
  "root-filter-bypassed",
  "folder-position-unknown",
  "unsupported-child-type",
  // A hierarchy listing reported a child whose status is not "current" (draft,
  // archived, …). Exports ship published pages only; the child is skipped with
  // this note instead of 404-ing one request later on the by-id version read.
  "child-not-current",
  "link-anchor-missing",
  "link-outside-scope",
  "link-target-ambiguous",
  // CROSS-HOST (spec 010): every host that pre-resolves `@mention`s emits this
  // one code — the CLI's DOCX path, the CLI's PDF path AND the extension's PDF
  // path. "an account id did not resolve to a display name" is a fact about the
  // source page, not about the host that noticed it, so a host-local spelling
  // (the retired `pdf-mention-unresolved`) made the same fact invisible to a
  // consumer filtering on the other host's report.
  "mention-unresolved",
  "heading-depth-clamped",
  // Content features / scroll-* compat (spec 003)
  "caption-kind-unknown",
  "caption-kind-unsupported",
  "caption-lang-fallback",
  "scroll-title-caption-fallback",
  "scroll-ignore-applied",
  "scroll-ignore-skipped-other-exporter",
  "scroll-ignore-unknown-exporter",
  "scroll-only-unknown-exporter",
  "scroll-only-applied",
  "scroll-only-skipped-other-exporter",
  "export-controls-passthrough",
  "table-overflow-warned",
  "table-text-scaled",
  "orientation-marker-unmatched",
  "orientation-marker-unterminated",
  "orientation-nested-collapsed",
  "orientation-suppressed-in-container",
  "pagebreak-suppressed-in-container",
  // Macro renderer registry (spec 004)
  "macro-degraded",
  "macro-rendered-via",
  "macro-skipped-by-config",
  "macro-body-truncated",
  // includepage / metadata placeholders (spec 005)
  "includepage-ambiguous-title",
  "includepage-budget-exceeded",
  "includepage-cycle",
  "includepage-invalid-context",
  "includepage-transient-error",
  "includepage-unresolved",
  "includepage-auth-failed",
  "includepage-rate-limited",
  // Word quality: numbering, tables, SVG, StyleRef (spec 006)
  "image-svg-default-size",
  "image-svg-no-rasterizer",
  "image-svg-oversized",
  "list-nesting-clamped",
  "numbering-cap-reached",
  "styleref-style-not-in-template",
  "styleref-style-unused-in-export",
  "table-geometry-clamped",
  "table-style-missing",
  // Template pack validation (spec 007)
  "docx-scan-failed",
  "never-placeholders",
  // Scope orchestration follow-ups (spec 002)
  "empty-include-result",
  // CLI report/error taxonomy (spec 008)
  "usage-error",
  "cancelled",
  "asset-budget-exceeded",
  "blocked-asset",
  "space-homepage-missing",
  "auth-error",
  "remote-error",
  "unexpected-error",
  // Security hardening (spec 011)
  "unsafe-link-skipped",
  "template-field-instruction-risk",
  // Engine-migration honesty (spec 010 W3-D). The template carries placeholder
  // syntax belonging to ANOTHER engine — docxtpl/Jinja `{{ … }}` / `{% … %}` —
  // which the ts DOCX engine never fills, so it renders as literal body text.
  // WARNING level on purpose: it is the only thing standing between a user
  // migrating off the removed Python exporter and a finished document full of
  // visible unfilled placeholders that no report mentioned. Decided from the TEMPLATE
  // archive before the page body is injected, so page content that happens to
  // document Jinja never triggers it. Not fatal — a deliberate hybrid template
  // is a real workflow.
  "template-foreign-placeholders",
  // `--template` was omitted and the bundled default template stood in.
  // `info`: nothing is wrong with the export, but which template produced the
  // document must never be a mystery. CLI-emitted — only a host knows where its
  // template came from.
  "template-default-used",
  // Generic fallback used by scope/CLI error paths
  "other",
  // DOCX placeholder resolver / export pipeline (@atlcli/docx)
  "date-format-unknown",
  "pageproperty-no-key",
  "placeholder-empty",
  "placeholder-substituted",
  "placeholder-unsupported",
  "placeholder-never",
  "space-fetch-failed",
  "space-unavailable",
  "user-fetch-failed",
  "user-unavailable",
  "owner-fetch-failed",
  "owner-unavailable",
  "homepage-fetch-failed",
  "homepage-unavailable",
  "no-content-placeholder",
  // The host asked for no field-refresh prompt (`--no-field-update-prompt`,
  // alias `--no-toc-prompt`) on a document that DOES carry computed fields — a
  // table of contents, caption numbering, a cross-reference. `info`: the export
  // is exactly what was asked for, but "your TOC will be empty until you press
  // F9" must not be something the reader discovers in Word. Only emitted when
  // the suppression costs something; a document of static hyperlinks would not
  // have carried the flag anyway.
  "field-refresh-suppressed",
  "logo-skipped",
  "logo-embed-failed",
  "perf-timing",
  // DOCX block serializer (@atlcli/docx)
  "code-highlight-skipped",
  // CROSS-ENGINE static-page policy: ADF explicitly requested horizontal
  // overflow (`wrap: false`), which an interactive editor can scroll but a
  // bounded DOCX/PDF page cannot. Both renderers keep all code and wrap it
  // safely instead of clipping; the exact source preference remains in the
  // neutral block for audit/reprocessing.
  "code-nowrap-page-bounded",
  // CROSS-ENGINE static-page policy for the legacy Storage code macro:
  // interactive initial collapse cannot survive in a static artifact, so both
  // targets retain the full body and report that it was intentionally opened.
  "code-collapse-static",
  // DOCX-ONLY, and correctly so: the export was configured with NO image
  // pipeline at all (`ExportEnv` without an asset fetcher), so every image
  // degrades at once — an export-configuration fact, level `info`. Distinct from
  // `image-embed-failed` below, which is one image's own failure. The PDF engine
  // has no counterpart because `preparePdfDocument` takes a MANDATORY resolver:
  // "this export cannot embed images" is unrepresentable there.
  "image-skipped",
  // CROSS-ENGINE (spec 010): ONE named image could not be embedded, with the
  // reason. DOCX emits it when the image seam returns `{ ok: false }`; the PDF
  // engine emits it when `resolver.resolve` throws — the same fact from the same
  // position in the pipeline, so it is one code. (The PDF engine used to spell
  // it `pdf-image-skipped`, whose name suggested a pairing with `image-skipped`
  // above; reading the two emitters shows those are different facts.)
  "image-embed-failed",
  // CROSS-ENGINE accessibility audit (spec 011, PDF/UA 7.3): a SOURCE image
  // block carries no author-written alt text. Both engines decide it with the
  // identical `isMissingAltText` rule, from the source block, BEFORE any fetch —
  // so a failed embed is audited too. PDF notes additionally carry
  // `source.blockPath`; DOCX notes do not (its serializer tracks no block
  // paths). That is a provenance-richness difference, not a different fact,
  // which is why one code covers both. (Retired PDF spelling:
  // `pdf-image-missing-alt`.)
  "image-missing-alt",
  "diagram-skipped",
  "diagram-unsupported",
  "diagram-render-failed",
  "table-shape-approximated",
  // PDF pipeline (@atlcli/pdf)
  // RENDER-side statement that the technical filename was substituted into
  // Typst's `alt:`. Genuinely PDF-only and deliberately NOT folded into
  // `image-missing-alt`: that code is the SOURCE defect ("the page needs alt
  // text"), this one is what the renderer DID about it, at the other end of the
  // pipeline. DOCX performs the same substitution into `descr` silently and
  // emits nothing, so there is no DOCX counterpart to unify with.
  "pdf-image-alt-fallback",
  "pdf-language-missing",
  "pdf-diagram-unsupported",
  "pdf-diagram-failed",
  "pdf-link-unresolved",
  "pdf-table-cell-contrast-low",
  "pdf-unknown-block",
  // Host-emitted source notes (extension panel / conformance harness).
  // NOTE: the per-mention outcome is the shared `mention-unresolved` above, not
  // a host-local spelling. This one is a different fact: the mention RESOLUTION
  // CALL itself failed, so the unresolved count is unknown. No CLI counterpart
  // exists (the CLI does not wrap `resolveExportMentions`), so there is nothing
  // to unify it with — see the note on `RETIRED_EXPORT_NOTE_CODES`.
  "pdf-mention-resolution-failed",
  "browser-harness",
] as const;

/** Stable machine code of an {@link ExportNote} — a member of {@link EXPORT_NOTE_CODES}. */
export type ExportNoteCode = (typeof EXPORT_NOTE_CODES)[number];

/**
 * Note codes retired by the cross-engine/cross-host vocabulary unification
 * (spec 010), mapped to the canonical code that replaced them.
 *
 * Why this table exists at all: note codes are a PUBLIC contract. They appear in
 * `--report json` (`issues[].code`, `notesByCode`), in the docs, and in user CI
 * that greps for a specific code. Renaming one is therefore a breaking change,
 * and a breaking change a consumer cannot *detect* is the bad kind. This table
 * is the machine-readable migration path: a consumer (or a support answer) can
 * resolve a code it remembers to the code that is emitted today.
 *
 * Two deliberate non-choices:
 *  - The retired codes are NOT kept as `ExportNoteCode` members. Nothing emits
 *    them, and `scripts/export-note-codes.test.ts` treats an unemitted registry
 *    member as drift — a union member that can never appear is a lie told in
 *    the type system.
 *  - Nothing emits BOTH the old and the new code during a transition. Dual
 *    emission would double every affected `notesByCode` tally and inflate
 *    `--strict` warning counts for a single fact, which is exactly the defect
 *    the duplicate-`mention-unresolved` fix removed.
 *
 * `pdf-image-alt-fallback`, `pdf-mention-resolution-failed`, `image-skipped` and
 * the `pdf-diagram-*` family are deliberately absent: each describes a fact its
 * apparent counterpart does not (see the comments in the registry above).
 */
export const RETIRED_EXPORT_NOTE_CODES = {
  /** PDF's source-side alt-text audit; identical rule to the DOCX audit. */
  "pdf-image-missing-alt": "image-missing-alt",
  /**
   * PDF's per-image embed failure. Note the replacement is NOT `image-skipped`
   * despite the name: `image-skipped` means "this export has no image pipeline",
   * a fact the PDF engine cannot even represent.
   */
  "pdf-image-skipped": "image-embed-failed",
  /** The extension PDF host's spelling of the CLI hosts' `mention-unresolved`. */
  "pdf-mention-unresolved": "mention-unresolved",
} as const satisfies Record<string, ExportNoteCode>;

/** A note code that used to be emitted and no longer is. */
export type RetiredExportNoteCode = keyof typeof RETIRED_EXPORT_NOTE_CODES;

/**
 * Resolve any note code — current or retired — to the code emitted today, or
 * `undefined` when it was never a code at all.
 *
 * Intended for report consumers that must keep understanding older reports (or
 * older grep expressions) after the spec 010 unification.
 */
export function canonicalExportNoteCode(code: string): ExportNoteCode | undefined {
  if (code in RETIRED_EXPORT_NOTE_CODES) {
    return RETIRED_EXPORT_NOTE_CODES[code as RetiredExportNoteCode];
  }
  return (EXPORT_NOTE_CODES as readonly string[]).includes(code)
    ? (code as ExportNoteCode)
    : undefined;
}

/** A non-fatal observation surfaced in the export report (never thrown). */
export interface ExportNote {
  level: "info" | "warning";
  /** Stable machine code, e.g. `"unknown-macro"`, `"inline-image-skipped"`. */
  code: ExportNoteCode;
  message: string;
  macroName?: string;
  /** Where the note originated (spec 003 provenance contract). */
  source?: ExportNoteSource;
}

export * from "./schema.js";
export * from "./visit.js";
export * from "./page-link-resolution.js";

/** Result of {@link storageToBlocks}: the block tree plus report notes. */
