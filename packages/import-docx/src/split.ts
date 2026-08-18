/**
 * Split one imported document into a Confluence page tree at Word heading
 * levels (specs/import-docx/009-page-tree-split, full-form semantics §3).
 *
 * Pure projection: input is the parsed document, output is a tree of page
 * plans plus split issues and the bookmark→page ownership map used for
 * cross-page link rewriting. Heading levels ≤ `level` open new pages; the
 * opening heading itself becomes the page title (label included) and is
 * removed from the page body. Content before the first splitting heading
 * stays on the root page.
 */
import type { ImportAsset, ImportIssue } from "@atlcli/import-core";
import type { DocxImportBlock as ImportBlock, ImportedDocument } from "./model.js";

export interface ImportPagePlan {
  /** Resolved page title (heading label + text for split pages). */
  title: string;
  blocks: ImportBlock[];
  /** Assets referenced by this page's blocks (subset of the document's). */
  assets: ImportAsset[];
  children: ImportPagePlan[];
  /** The heading that opened this page (absent on the root). */
  sourceHeading?: Extract<ImportBlock, { type: "heading" }>;
}

export interface SplitOptions {
  /** Heading levels 1..`level` open new pages. */
  level: 1 | 2 | 3 | 4 | 5 | 6;
  /** Title for the root page. */
  rootTitle: string;
}

export interface SplitResult {
  root: ImportPagePlan;
  issues: ImportIssue[];
  /** Bookmark name → owning page plan (for cross-page link rewriting). */
  anchorOwners: Map<string, ImportPagePlan>;
}

export class SplitTitleConflictError extends Error {
  constructor(public readonly duplicates: string[]) {
    super(
      `Splitting would create multiple pages with the same title: ${duplicates.join(", ")}. ` +
        `Confluence titles must be unique per space — rename the duplicated headings, or use --title-conflict rename.`,
    );
    this.name = "SplitTitleConflictError";
  }
}

function headingTitle(block: Extract<ImportBlock, { type: "heading" }>): string {
  const text = block.runs
    .map((r) => (r.kind === "text" ? r.text : " "))
    .join("")
    .trim();
  return block.label ? `${block.label} ${text}`.trim() : text;
}

function collectAssetIds(blocks: ImportBlock[], into: Set<string>): void {
  for (const block of blocks) {
    if (block.type === "image") into.add(block.assetId);
    else if (block.type === "list") {
      for (const item of block.items) {
        collectAssetIds(item.blocks, into);
        if (item.child) collectAssetIds([item.child], into);
      }
    } else if (block.type === "table") {
      for (const row of block.rows) for (const cell of row.cells) collectAssetIds(cell.blocks, into);
    } else if (block.type === "blockquote" || block.type === "disclosure") {
      collectAssetIds(block.blocks, into);
    }
  }
}

function assetsFor(blocks: ImportBlock[], doc: ImportedDocument): ImportAsset[] {
  const ids = new Set<string>();
  collectAssetIds(blocks, ids);
  return doc.assets.filter((a) => ids.has(a.id));
}

function collectTitles(page: ImportPagePlan, into: string[]): void {
  into.push(page.title);
  for (const child of page.children) collectTitles(child, into);
}

/** Bookmarks carried by a block (headings and paragraphs). */
function blockBookmarks(block: ImportBlock): string[] {
  return block.type === "heading" || block.type === "paragraph" ? (block.bookmarks ?? []) : [];
}

/**
 * Split into a page-plan tree.
 *
 * @param titleConflict `fail` throws {@link SplitTitleConflictError} on
 * duplicate resulting titles; `rename` deduplicates with " (2)", " (3)"…
 */
export function splitDocument(
  doc: ImportedDocument,
  options: SplitOptions,
  titleConflict: "fail" | "rename" = "fail",
): SplitResult {
  const issues: ImportIssue[] = [];
  const root: ImportPagePlan = { title: options.rootTitle, blocks: [], assets: [], children: [] };
  // Stack of open pages by split depth; index 0 = root.
  const stack: ImportPagePlan[] = [root];
  let gapCount = 0;

  for (const block of doc.blocks) {
    if (block.type === "heading" && block.level <= options.level) {
      const title = headingTitle(block) || "Untitled section";
      const depth = block.level; // H1 → child of root (depth 1) …
      if (depth > stack.length) gapCount += 1; // e.g. H3 with no open H2
      while (stack.length - 1 >= depth) stack.pop();
      // A level jump attaches to the deepest open page rather than
      // inventing an empty intermediate page (full-form rule 5).
      const parent = stack[stack.length - 1];
      const page: ImportPagePlan = {
        title,
        blocks: [],
        assets: [],
        children: [],
        sourceHeading: block,
      };
      parent.children.push(page);
      stack.push(page);
      continue;
    }
    stack[stack.length - 1].blocks.push(block);
  }

  if (gapCount > 0) {
    issues.push({
      code: "docx-import/page-tree-heading-level-gap",
      severity: "info",
      outcome: "approximated",
      message:
        "A heading skipped one or more levels; its page was attached to the nearest open ancestor.",
      context: { occurrences: gapCount },
    });
  }

  // Empty sections (full-form rule 6): a split page with no content and no
  // children does not become a page — its heading returns to the ancestor
  // body.
  let emptySections = 0;
  const pruneEmpty = (page: ImportPagePlan): void => {
    for (const child of page.children) pruneEmpty(child);
    page.children = page.children.filter((child) => {
      if (child.blocks.length === 0 && child.children.length === 0 && child.sourceHeading) {
        page.blocks.push(child.sourceHeading);
        emptySections += 1;
        return false;
      }
      return true;
    });
  };
  pruneEmpty(root);
  if (emptySections > 0) {
    issues.push({
      code: "docx-import/page-tree-empty-section",
      severity: "info",
      outcome: "approximated",
      message: "Empty heading sections stay as headings in their ancestor page instead of becoming empty pages.",
      context: { occurrences: emptySections },
    });
  }

  const fill = (page: ImportPagePlan): void => {
    page.assets = assetsFor(page.blocks, doc);
    for (const child of page.children) fill(child);
  };
  fill(root);

  // Title conflicts inside the tree.
  const seen = new Map<string, number>();
  const duplicates = new Set<string>();
  const resolveTitles = (page: ImportPagePlan): void => {
    const key = page.title.toLowerCase();
    const count = seen.get(key) ?? 0;
    if (count > 0) {
      if (titleConflict === "rename") {
        page.title = `${page.title} (${count + 1})`;
        issues.push({
          code: "docx-import/page-tree-title-renamed",
          severity: "info",
          outcome: "approximated",
          message: `Duplicate page title renamed to "${page.title}".`,
        });
      } else {
        duplicates.add(page.title);
      }
    }
    seen.set(key, count + 1);
    for (const child of page.children) resolveTitles(child);
  };
  resolveTitles(root);
  if (duplicates.size > 0) throw new SplitTitleConflictError([...duplicates].sort());

  // Bookmark ownership: a heading's own bookmarks belong to the page it
  // opened; body bookmarks belong to the page containing the block.
  const anchorOwners = new Map<string, ImportPagePlan>();
  const collectAnchors = (page: ImportPagePlan): void => {
    if (page.sourceHeading) {
      for (const name of page.sourceHeading.bookmarks ?? []) {
        if (!anchorOwners.has(name)) anchorOwners.set(name, page);
      }
    }
    for (const block of page.blocks) {
      for (const name of blockBookmarks(block)) {
        if (!anchorOwners.has(name)) anchorOwners.set(name, page);
      }
    }
    for (const child of page.children) collectAnchors(child);
  };
  collectAnchors(root);

  return { root, issues, anchorOwners };
}

/** Count pages in a plan tree (root included). */
export function countPages(page: ImportPagePlan): number {
  return 1 + page.children.reduce((sum, child) => sum + countPages(child), 0);
}

/** Every DOCX batch-file reference used anywhere in a block list. */
export function collectFileLinkRefs(blocks: ImportBlock[], into = new Set<string>()): Set<string> {
  for (const block of blocks) {
    if (block.type === "heading" || block.type === "paragraph") {
      for (const run of block.runs) {
        if (run.kind === "text" && run.marks?.reference?.namespace === "docx-file") {
          into.add(run.marks.reference.target);
        }
      }
    } else if (block.type === "list") {
      for (const item of block.items) {
        collectFileLinkRefs(item.blocks, into);
        if (item.child) collectFileLinkRefs([item.child], into);
      }
    } else if (block.type === "table") {
      for (const row of block.rows) for (const cell of row.cells) collectFileLinkRefs(cell.blocks, into);
    } else if (block.type === "blockquote" || block.type === "disclosure") {
      collectFileLinkRefs(block.blocks, into);
    }
  }
  return into;
}

/** Every DOCX bookmark reference used anywhere in a block list. */
export function collectAnchorRefs(blocks: ImportBlock[], into = new Set<string>()): Set<string> {
  for (const block of blocks) {
    if (block.type === "heading" || block.type === "paragraph") {
      for (const run of block.runs) {
        if (run.kind === "text" && run.marks?.reference?.namespace === "docx-bookmark") {
          into.add(run.marks.reference.target);
        }
      }
    } else if (block.type === "list") {
      for (const item of block.items) {
        collectAnchorRefs(item.blocks, into);
        if (item.child) collectAnchorRefs([item.child], into);
      }
    } else if (block.type === "table") {
      for (const row of block.rows) for (const cell of row.cells) collectAnchorRefs(cell.blocks, into);
    } else if (block.type === "blockquote" || block.type === "disclosure") {
      collectAnchorRefs(block.blocks, into);
    }
  }
  return into;
}
