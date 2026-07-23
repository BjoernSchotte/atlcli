/**
 * Chapter composition (spec 002, Cluster A / T1.1 "Composition").
 *
 * `composeChapters` turns the ordered `ExportNode[]` that `fetchExportTree`
 * produces into ONE chapterized `ExportBlock[]` document: it emits a chapter
 * heading per node (page or folder), promotes+shifts each page's own headings so
 * page depth maps to chapter level, and namespaces + rewrites every anchor and
 * cross-page link so a multi-page document has working in-document jumps and a
 * working table of contents.
 *
 * The engines (DOCX, PDF/Typst) never learn the document came from many pages —
 * they serialize a single `ExportBlock[]`. The chapter-start / heading / anchor
 * ids this module assigns are the SAME sanitized ids both engines render into
 * (round 3), computed exactly once here via {@link sanitizeAnchorId} so DOCX
 * bookmarks and Typst labels can never desync for the same source anchor.
 *
 * The heading-offset helpers (`computeHeadingOffset`/`minHeadingLevel`) also live
 * here — the single home of the "promote the shallowest heading to level 1"
 * logic both serializers consume (lifted out of the two engines).
 *
 * Isomorphic: no `node:`/`bun:` specifiers — only pure data transforms.
 */
import type {
  Caption,
  ExportBlock,
  ExportNote,
  InlineNode,
  LinkTarget,
} from "./export-blocks.js";
import type {
  ExportNode,
  ExportPageNode,
  ExportFolderNode,
} from "./tree-fetch.js";
import { nodeId } from "./tree-fetch.js";

// ---------------------------------------------------------------------------
// Heading-offset helpers (single home; consumed by DOCX + PDF serializers)
// ---------------------------------------------------------------------------

/**
 * Minimal structural view of a block the heading scan reads. Both the
 * `ExportBlock` union (this package) and the engines' prepared block unions
 * (`PreparedPdfBlock`, DOCX) are assignable to `readonly HeadingScanBlock[]`,
 * so the promotion logic lives here exactly once instead of once per engine.
 */
export interface HeadingScanBlock {
  readonly type: string;
  readonly level?: number;
  readonly content?: readonly unknown[];
  readonly items?: readonly { readonly content: readonly unknown[] }[];
  readonly rows?: readonly {
    readonly cells: readonly { readonly content: readonly unknown[] }[];
  }[];
  readonly columns?: readonly { readonly content: readonly unknown[] }[];
}

/** Smallest heading `level` anywhere in the tree, or `Infinity` if none. */
export function minHeadingLevel(blocks: readonly HeadingScanBlock[]): number {
  let min = Infinity;
  for (const block of blocks) {
    switch (block.type) {
      case "heading":
        if (typeof block.level === "number" && block.level < min) min = block.level;
        break;
      case "callout":
      case "blockquote":
      case "orientation":
        if (block.content) {
          min = Math.min(min, minHeadingLevel(block.content as readonly HeadingScanBlock[]));
        }
        break;
      case "list":
        if (block.items) {
          for (const item of block.items) {
            min = Math.min(min, minHeadingLevel(item.content as readonly HeadingScanBlock[]));
          }
        }
        break;
      case "table":
        if (block.rows) {
          for (const row of block.rows) {
            for (const cell of row.cells) {
              min = Math.min(min, minHeadingLevel(cell.content as readonly HeadingScanBlock[]));
            }
          }
        }
        break;
      case "layout":
        if (block.columns) {
          for (const column of block.columns) {
            min = Math.min(min, minHeadingLevel(column.content as readonly HeadingScanBlock[]));
          }
        }
        break;
    }
  }
  return min;
}

/**
 * Heading-level promotion ("promotion"), matching Scroll Office.
 *
 * Confluence pages usually omit H1 (the page title is the implicit Heading 1)
 * and start their body headings at H2. Preserving levels would leave the top TOC
 * level empty, so the shallowest heading in the document is promoted to Heading
 * 1: `offset = minLevel - 1`, and every heading's effective level is
 * `block.level - offset`. The scan spans the WHOLE block tree. A document with
 * no headings (or one already starting at H1) yields offset 0 (no-op) — which is
 * exactly what a `composeChapters` output yields, since its chapter headings
 * always start at level 1.
 */
export function computeHeadingOffset(blocks: readonly HeadingScanBlock[]): number {
  const min = minHeadingLevel(blocks);
  return min === Infinity ? 0 : min - 1;
}

// ---------------------------------------------------------------------------
// Anchor id sanitization (feeds BOTH engines in round 3)
// ---------------------------------------------------------------------------

/** OOXML bookmark-name length limit; Typst labels reuse the same budget. */
export const MAX_ANCHOR_ID_LENGTH = 40;

/** Deterministic short hash (FNV-1a → base36) — no crypto, isomorphic. */
function shortHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    // 32-bit FNV prime multiply via shifts (stays in 32-bit range).
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36);
}

/** Append a short content-hash suffix to `base`, staying within the length cap. */
function withHashSuffix(base: string, source: string): string {
  const hash = shortHash(source);
  const room = MAX_ANCHOR_ID_LENGTH - hash.length - 1;
  const head = base.slice(0, Math.max(0, room)).replace(/-+$/g, "");
  return head ? `${head}-${hash}` : hash;
}

/**
 * Sanitize a raw (already-namespaced) anchor key into a stable, ASCII-safe id
 * that is a legal OOXML bookmark name and Typst label: strip control chars,
 * fold diacritics, lowercase, collapse non-alphanumerics to `-`, and truncate
 * over-long ids with a short content-hash suffix so distinct long keys never
 * collide on a shared prefix. Deterministic and pure — round 3 imports this so
 * both engines compute the identical id for the same source anchor.
 */
export function sanitizeAnchorId(rawKey: string): string {
  let s = rawKey
    .replace(new RegExp("[\\u0000-\\u001F\\u007F]", "g"), "")
    .normalize("NFKD")
    .replace(new RegExp("[\\u0300-\\u036f]", "g"), "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!s) s = "anchor";
  if (s.length > MAX_ANCHOR_ID_LENGTH) {
    s = withHashSuffix(s, rawKey);
  }
  return s;
}

/**
 * Sanitize `rawName` into an anchor id that does not collide with any id in
 * `used` (the caller adds the returned id to its set). Collisions get the same
 * short-content-hash suffix scheme {@link AnchorRegistry} uses, so the engines'
 * per-document dedupe (single-page exports have no compose-time registry)
 * produces ids in the exact same shape as composed documents. Distinct raw
 * names that sanitize identically (e.g. `"A B"` and `"A_B"`) therefore never
 * yield duplicate DOCX bookmark names or duplicate Typst labels (the latter is
 * a Typst compile error).
 */
export function uniqueAnchorId(rawName: string, used: ReadonlySet<string>): string {
  const base = sanitizeAnchorId(rawName);
  if (!used.has(base)) return base;
  let id = withHashSuffix(base, rawName);
  let salt = 1;
  while (used.has(id)) {
    id = withHashSuffix(base, `${rawName}#${salt}`);
    salt += 1;
  }
  return id;
}

// ---------------------------------------------------------------------------
// Anchor registry
// ---------------------------------------------------------------------------

/**
 * The one logical map from a namespaced *raw* anchor key to its sanitized
 * destination id. Populated (in document order) from chapter starts
 * (`page-<id>`), every heading's plain-text slug (`p<id>-<text>`), and every
 * explicit `anchor` block (`p<id>-<name>`). Link resolution and both engines
 * read the same destinations, so a heading-derived anchor and an explicit
 * `ac:name="anchor"` macro that name the same target resolve identically.
 */
export class AnchorRegistry {
  /** raw key → sanitized destination (first registration of a raw key wins). */
  private readonly lookup = new Map<string, string>();
  /** every assigned destination, to keep sanitized ids globally unique. */
  private readonly used = new Set<string>();

  /** The chapter-start raw key for a node id. */
  static chapterKey(id: string): string {
    return `page-${id}`;
  }

  /** The in-page raw key for an anchor/heading name on a page. */
  static inPageKey(pageId: string, name: string): string {
    return `p${pageId}-${name}`;
  }

  /**
   * Register a raw key and return its stable sanitized destination. Re-registering
   * the same raw key returns the same destination (first-wins, idempotent for
   * link lookups). A NEW raw key whose sanitized form collides with an already
   * used destination gets a hash-suffixed unique variant.
   */
  register(rawKey: string): string {
    const existing = this.lookup.get(rawKey);
    if (existing !== undefined) return existing;
    let dest = sanitizeAnchorId(rawKey);
    if (this.used.has(dest)) {
      dest = withHashSuffix(dest, rawKey);
      // Extremely unlikely second-order collision: perturb until unique.
      let salt = 1;
      while (this.used.has(dest)) {
        dest = withHashSuffix(dest, `${rawKey}#${salt}`);
        salt += 1;
      }
    }
    this.lookup.set(rawKey, dest);
    this.used.add(dest);
    return dest;
  }

  /**
   * Assign a UNIQUE destination for an occurrence that must have its own
   * bookmark even when its raw key duplicates an earlier one (e.g. two same-text
   * headings on one page). The first occurrence owns the lookup entry; later
   * occurrences get a distinct destination but do not steal the lookup.
   */
  registerOccurrence(rawKey: string): string {
    if (!this.lookup.has(rawKey)) return this.register(rawKey);
    // Duplicate raw key: mint a distinct destination without touching lookup.
    let dest = withHashSuffix(sanitizeAnchorId(rawKey), rawKey);
    let salt = 1;
    while (this.used.has(dest)) {
      dest = withHashSuffix(sanitizeAnchorId(rawKey), `${rawKey}#${salt}`);
      salt += 1;
    }
    this.used.add(dest);
    return dest;
  }

  /** Look up a raw key's destination, or `undefined` when unregistered. */
  resolve(rawKey: string): string | undefined {
    return this.lookup.get(rawKey);
  }
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/** The page-link fields a host needs to build an absolute out-of-scope URL. */
export interface ExternalLinkTarget {
  contentId?: string;
  contentTitle: string;
  spaceKey?: string;
}

export interface ComposeOptions {
  /** Break between chapters. `"pageBreak"` (default) inserts a hard page break. */
  chapterBreak?: "none" | "pageBreak";
  /**
   * Synthesize the chapter heading from the page/folder title (default `true`).
   * When `false`, no synthetic heading is emitted; a standalone `anchor` block
   * marks the chapter start so `page-<id>` links still resolve.
   */
  chapterTitleFromPage?: boolean;
  /**
   * Build an absolute URL for a link whose target page is outside the export
   * scope. Kept as a callback so `composeChapters` stays pure — hosts inject
   * their own base-URL logic. When absent, an out-of-scope link degrades to
   * page-only text (still noted `link-outside-scope`).
   */
  resolveExternalUrl?: (target: ExternalLinkTarget, anchor?: string) => string;
}

export interface ComposeResult {
  blocks: ExportBlock[];
  notes: ExportNote[];
  /**
   * Page/folder id → the in-document anchor its chapter was given.
   *
   * Composition's own in-scope answer, published so consumers that run AFTER it
   * can reach the same decision. The macro-resolution pass is exactly that
   * consumer: both engines resolve macros on the already-composed tree, so a
   * renderer listing other Confluence pages (the Confluence-list datasource)
   * cannot emit `{ kind: "page" }` targets and expect them to be rewritten — it
   * reads this map instead, linking into the document rather than out to the
   * web. An id absent from the map is outside the export scope.
   */
  chapterAnchorById: ReadonlyMap<string, string>;
}

// ---------------------------------------------------------------------------
// Inline plain-text (for heading-derived anchor keys)
// ---------------------------------------------------------------------------

function inlinePlainText(nodes: readonly InlineNode[]): string {
  let out = "";
  for (const node of nodes) {
    switch (node.type) {
      case "text":
        out += node.text;
        break;
      case "link":
        out += inlinePlainText(node.content);
        break;
      case "mention":
        out += node.displayName ?? "";
        break;
      case "status":
        out += node.text;
        break;
      case "lineBreak":
        out += " ";
        break;
      default: {
        const exhaustive: never = node;
        void exhaustive;
      }
    }
  }
  return out.trim();
}

// ---------------------------------------------------------------------------
// Registry-building deep walk (over ORIGINAL page blocks)
// ---------------------------------------------------------------------------

/**
 * Per-page pre-pass state: the destination assigned to each original heading and
 * anchor block (by object identity), reused verbatim during the emit pass so a
 * heading's bookmark id is computed exactly once.
 */
interface DestByBlock {
  get(block: ExportBlock): string | undefined;
}

function registerPageAnchors(
  page: ExportPageNode,
  registry: AnchorRegistry,
  destByBlock: Map<ExportBlock, string>
): void {
  const walk = (blocks: readonly ExportBlock[]): void => {
    for (const block of blocks) {
      switch (block.type) {
        case "heading": {
          const text = inlinePlainText(block.content) || block.explicitAnchor || "heading";
          const rawKey = AnchorRegistry.inPageKey(page.pageId, text);
          destByBlock.set(block, registry.registerOccurrence(rawKey));
          break;
        }
        case "anchor": {
          const rawKey = AnchorRegistry.inPageKey(page.pageId, block.name);
          destByBlock.set(block, registry.registerOccurrence(rawKey));
          break;
        }
        case "callout":
        case "blockquote":
        case "orientation":
          walk(block.content);
          break;
        case "list":
          for (const item of block.items) walk(item.content);
          break;
        case "table":
          for (const row of block.rows) for (const cell of row.cells) walk(cell.content);
          break;
        case "layout":
          for (const column of block.columns) walk(column.content);
          break;
        case "paragraph":
        case "codeBlock":
        case "image":
        case "divider":
        case "pageBreak":
        case "unknown":
          break;
        default: {
          const exhaustive: never = block;
          void exhaustive;
        }
      }
    }
  };
  walk(page.blocks);
}

// ---------------------------------------------------------------------------
// Emit pass: link resolution
// ---------------------------------------------------------------------------

type Resolution =
  | { kind: "resolved"; targetId: string }
  | { kind: "ambiguous" }
  | { kind: "out-of-scope" };

interface PageIndex {
  byId: Map<string, ExportPageNode>;
  bySpaceTitle: Map<string, ExportPageNode[]>;
}

/** Unambiguous composite key for (spaceKey, title) lookups. */
function spaceTitleKey(spaceKey: string, title: string): string {
  return JSON.stringify([spaceKey, title]);
}

function buildPageIndex(pages: readonly ExportPageNode[]): PageIndex {
  const byId = new Map<string, ExportPageNode>();
  const bySpaceTitle = new Map<string, ExportPageNode[]>();
  for (const page of pages) {
    byId.set(page.pageId, page);
    const space = page.meta.spaceKey;
    if (space) {
      const key = spaceTitleKey(space, page.title);
      const list = bySpaceTitle.get(key);
      if (list) list.push(page);
      else bySpaceTitle.set(key, [page]);
    }
  }
  return { byId, bySpaceTitle };
}

function resolvePageLink(
  target: Extract<LinkTarget, { kind: "page" }>,
  currentSpaceKey: string | undefined,
  index: PageIndex
): Resolution {
  // (1) contentId exact match.
  if (target.contentId) {
    const node = index.byId.get(target.contentId);
    if (node) return { kind: "resolved", targetId: node.pageId };
    return { kind: "out-of-scope" };
  }
  // (2)/(3) title within a space: the link's own space, else the current page's.
  const space = target.spaceKey ?? currentSpaceKey;
  if (space) {
    const cands = index.bySpaceTitle.get(spaceTitleKey(space, target.contentTitle)) ?? [];
    if (cands.length === 1) return { kind: "resolved", targetId: cands[0]!.pageId };
    if (cands.length > 1) return { kind: "ambiguous" };
  }
  return { kind: "out-of-scope" };
}

// ---------------------------------------------------------------------------
// Emit pass: inline + block transform
// ---------------------------------------------------------------------------

interface EmitCtx {
  page: ExportPageNode;
  index: PageIndex;
  registry: AnchorRegistry;
  chapterDestById: Map<string, string>;
  destByBlock: DestByBlock;
  shift: number;
  notes: ExportNote[];
  options: Required<Pick<ComposeOptions, "chapterTitleFromPage">> &
    Pick<ComposeOptions, "resolveExternalUrl">;
}

function transformInline(nodes: readonly InlineNode[], ctx: EmitCtx): InlineNode[] {
  const out: InlineNode[] = [];
  for (const node of nodes) {
    switch (node.type) {
      case "text":
      case "mention":
      case "status":
      case "lineBreak":
        out.push(node);
        break;
      case "link": {
        const content = transformInline(node.content, ctx);
        const rewritten = rewriteLink(node.target, content, ctx);
        out.push(...rewritten);
        break;
      }
      default: {
        const exhaustive: never = node;
        void exhaustive;
      }
    }
  }
  return out;
}

/** Rewrite a single link node; may unwrap it to page-only text (its content). */
function rewriteLink(
  target: LinkTarget,
  content: InlineNode[],
  ctx: EmitCtx
): InlineNode[] {
  switch (target.kind) {
    case "external":
    case "attachment":
      // Untouched by composition (external URLs / attachment refs).
      return [{ type: "link", target, content }];
    case "anchor": {
      // In-page anchor → this page's namespaced destination.
      const rawKey = AnchorRegistry.inPageKey(ctx.page.pageId, target.anchor);
      const dest = ctx.registry.resolve(rawKey);
      if (dest === undefined) {
        ctx.notes.push({
          level: "warning",
          code: "link-anchor-missing",
          message: `In-page link to anchor "${target.anchor}" on "${ctx.page.title}" has no matching target; rendered as plain text.`,
        });
        return content;
      }
      return [{ type: "link", target: { kind: "anchor", anchor: dest }, content }];
    }
    case "page": {
      const resolution = resolvePageLink(target, ctx.page.meta.spaceKey, ctx.index);
      if (resolution.kind === "ambiguous") {
        ctx.notes.push({
          level: "warning",
          code: "link-target-ambiguous",
          message: `Link to page "${target.contentTitle}" is ambiguous (multiple in-scope pages share that title); rendered as plain text.`,
        });
        return content;
      }
      if (resolution.kind === "out-of-scope") {
        ctx.notes.push({
          level: "info",
          code: "link-outside-scope",
          message: `Link to page "${target.contentTitle}" points outside the export scope; ${
            ctx.options.resolveExternalUrl ? "linked to its absolute URL" : "rendered as plain text"
          }.`,
        });
        if (ctx.options.resolveExternalUrl) {
          const href = ctx.options.resolveExternalUrl(
            {
              ...(target.contentId ? { contentId: target.contentId } : {}),
              contentTitle: target.contentTitle,
              ...(target.spaceKey ? { spaceKey: target.spaceKey } : {}),
            },
            target.anchor
          );
          return [{ type: "link", target: { kind: "external", href }, content }];
        }
        return content;
      }
      // Resolved in-scope.
      const targetId = resolution.targetId;
      if (!target.anchor) {
        const dest = ctx.chapterDestById.get(targetId)!;
        return [{ type: "link", target: { kind: "anchor", anchor: dest }, content }];
      }
      const rawKey = AnchorRegistry.inPageKey(targetId, target.anchor);
      const dest = ctx.registry.resolve(rawKey);
      if (dest === undefined) {
        ctx.notes.push({
          level: "warning",
          code: "link-anchor-missing",
          message: `Cross-page link to anchor "${target.anchor}" on page "${target.contentTitle}" has no matching target; rendered as plain text.`,
        });
        return content;
      }
      return [{ type: "link", target: { kind: "anchor", anchor: dest }, content }];
    }
    default: {
      const exhaustive: never = target;
      void exhaustive;
      return content;
    }
  }
}

/**
 * A caption's `content` is typed inline nodes — including links — so it goes
 * through the same rewrite pass as any other inline content (no walker emits
 * captions yet, spec 003/T1.4, but the seam is wired so the gap can't ship
 * silently once one does).
 */
function transformCaption(caption: Caption, ctx: EmitCtx): Caption {
  return { kind: caption.kind, content: transformInline(caption.content, ctx) };
}

/** Deep-transform one block: shift heading levels + rewrite links/anchors. */
function transformBlock(block: ExportBlock, ctx: EmitCtx): ExportBlock {
  switch (block.type) {
    case "heading": {
      let level = block.level + ctx.shift;
      if (level > 6) {
        ctx.notes.push({
          level: "warning",
          code: "heading-depth-clamped",
          message: `Heading "${inlinePlainText(block.content)}" on "${ctx.page.title}" exceeded level 6 after chapter shift and was clamped.`,
        });
        level = 6;
      }
      if (level < 1) level = 1;
      const dest = ctx.destByBlock.get(block);
      return {
        ...block,
        level: level as 1 | 2 | 3 | 4 | 5 | 6,
        content: transformInline(block.content, ctx),
        ...(dest ? { explicitAnchor: dest } : {}),
      };
    }
    case "anchor": {
      const dest = ctx.destByBlock.get(block);
      return { type: "anchor", name: dest ?? block.name };
    }
    case "paragraph":
      return { ...block, content: transformInline(block.content, ctx) };
    case "callout":
      return {
        type: "callout",
        kind: block.kind,
        ...(block.title !== undefined ? { title: block.title } : {}),
        content: block.content.map((b) => transformBlock(b, ctx)),
      };
    case "blockquote":
      return { type: "blockquote", content: block.content.map((b) => transformBlock(b, ctx)) };
    case "orientation":
      return {
        type: "orientation",
        landscape: block.landscape,
        content: block.content.map((b) => transformBlock(b, ctx)),
      };
    case "list":
      return {
        ...block,
        items: block.items.map((item) => ({
          ...item,
          content: item.content.map((b) => transformBlock(b, ctx)),
        })),
      };
    case "layout":
      return {
        ...block,
        columns: block.columns.map((column) => ({
          ...column,
          content: column.content.map((child) => transformBlock(child, ctx)),
        })),
      };
    case "table":
      return {
        type: "table",
        rows: block.rows.map((row) => ({
          cells: row.cells.map((cell) => ({
            header: cell.header,
            colspan: cell.colspan,
            rowspan: cell.rowspan,
            ...(cell.backgroundColor !== undefined ? { backgroundColor: cell.backgroundColor } : {}),
            ...(cell.columnWidths !== undefined ? { columnWidths: cell.columnWidths } : {}),
            ...(cell.verticalAlignment !== undefined ? { verticalAlignment: cell.verticalAlignment } : {}),
            ...(cell.localId !== undefined ? { localId: cell.localId } : {}),
            content: cell.content.map((b) => transformBlock(b, ctx)),
          })),
          ...(row.localId !== undefined ? { localId: row.localId } : {}),
        })),
        ...(block.columnWidths !== undefined ? { columnWidths: block.columnWidths } : {}),
        ...(block.presentation !== undefined ? { presentation: block.presentation } : {}),
        ...(block.caption !== undefined ? { caption: transformCaption(block.caption, ctx) } : {}),
        ...(block.fragments !== undefined ? { fragments: block.fragments } : {}),
      };
    case "codeBlock":
      // Only the caption carries inline nodes (and thus rewritable links).
      return block.caption !== undefined
        ? { ...block, caption: transformCaption(block.caption, ctx) }
        : block;
    case "image":
      return block.caption !== undefined
        ? { ...block, caption: transformCaption(block.caption, ctx) }
        : block;
    case "divider":
    case "pageBreak":
    case "unknown":
      // No links/headings to rewrite; carry through unchanged.
      return block;
    default: {
      const exhaustive: never = block;
      return exhaustive;
    }
  }
}

// ---------------------------------------------------------------------------
// composeChapters
// ---------------------------------------------------------------------------

function clampChapterLevel(effectiveDepth: number): 1 | 2 | 3 | 4 | 5 | 6 {
  const level = effectiveDepth + 1;
  return Math.min(6, Math.max(1, level)) as 1 | 2 | 3 | 4 | 5 | 6;
}

/**
 * Merge an ordered `ExportNode[]` into one chapterized document.
 *
 * Total over `ExportNode` via an exhaustive `switch (node.kind)`:
 * - `"page"` → optional page break, chapter heading at
 *   `clamp(effectiveDepth + 1, 1, 6)` anchored `page-<id>`, then the page's own
 *   blocks with per-page promotion applied first and then shifted to sit below
 *   the chapter heading (never a global promotion). In-document anchors and
 *   cross-page links are namespaced + rewritten via the shared registry.
 * - `"folder"` → a heading-only chapter (structure without body).
 *
 * Pure: no `Date`/random, stable note ordering (document order) — a double run
 * is byte-equal.
 */
export function composeChapters(
  nodes: readonly ExportNode[],
  opts: ComposeOptions = {}
): ComposeResult {
  const chapterBreak = opts.chapterBreak ?? "pageBreak";
  const chapterTitleFromPage = opts.chapterTitleFromPage ?? true;

  const registry = new AnchorRegistry();
  const chapterDestById = new Map<string, string>();
  const destByBlock = new Map<ExportBlock, string>();

  // ---- Pass 1: build the anchor registry (document order) ----
  for (const node of nodes) {
    chapterDestById.set(nodeId(node), registry.register(AnchorRegistry.chapterKey(nodeId(node))));
    if (node.kind === "page") registerPageAnchors(node, registry, destByBlock);
  }

  const pages = nodes.filter((n): n is ExportPageNode => n.kind === "page");
  const index = buildPageIndex(pages);

  // ---- Pass 2: emit blocks (document order) ----
  const blocks: ExportBlock[] = [];
  const notes: ExportNote[] = [];
  let emittedChapter = false;

  const maybeBreak = (): void => {
    if (chapterBreak === "pageBreak" && emittedChapter) blocks.push({ type: "pageBreak" });
  };

  for (const node of nodes) {
    switch (node.kind) {
      case "page": {
        maybeBreak();
        const chapterLevel = clampChapterLevel(node.effectiveDepth);
        const chapterDest = chapterDestById.get(node.pageId)!;
        if (chapterTitleFromPage) {
          blocks.push({
            type: "heading",
            level: chapterLevel,
            content: [{ type: "text", text: node.title }],
            explicitAnchor: chapterDest,
          });
        } else {
          blocks.push({ type: "anchor", name: chapterDest });
        }
        const offset = computeHeadingOffset(node.blocks);
        const shift = chapterLevel - offset;
        const ctx: EmitCtx = {
          page: node,
          index,
          registry,
          chapterDestById,
          destByBlock,
          shift,
          notes,
          options: { chapterTitleFromPage, ...(opts.resolveExternalUrl ? { resolveExternalUrl: opts.resolveExternalUrl } : {}) },
        };
        for (const block of node.blocks) blocks.push(transformBlock(block, ctx));
        emittedChapter = true;
        break;
      }
      case "folder": {
        maybeBreak();
        const chapterLevel = clampChapterLevel(node.effectiveDepth);
        const chapterDest = chapterDestById.get(node.folderId)!;
        if (chapterTitleFromPage) {
          blocks.push({
            type: "heading",
            level: chapterLevel,
            content: [{ type: "text", text: node.title }],
            explicitAnchor: chapterDest,
          });
        } else {
          // Same degradation as the page branch: a standalone anchor block marks
          // the chapter start so `page-<folderId>` links still resolve.
          blocks.push({ type: "anchor", name: chapterDest });
        }
        emittedChapter = true;
        break;
      }
      default: {
        const exhaustive: never = node;
        void exhaustive;
      }
    }
  }

  return { blocks, notes, chapterAnchorById: chapterDestById };
}

// Re-export the node types for consumers importing composition from one place.
export type { ExportNode, ExportPageNode, ExportFolderNode };
