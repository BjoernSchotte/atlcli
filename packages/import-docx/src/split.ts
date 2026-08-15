/**
 * Split one imported document into a Confluence page tree at Word heading
 * levels (specs/import-docx/009-page-tree-split, slice scope).
 *
 * Pure projection: input is the parsed document, output is a tree of page
 * plans. Heading levels ≤ `level` open new pages; the opening heading itself
 * becomes the page title (label included) and is removed from the page body.
 * Content before the first splitting heading stays on the root page.
 */
import type { ImportAsset, ImportBlock, ImportedDocument } from "./model.js";

export interface ImportPagePlan {
  /** Resolved page title (heading label + text for split pages). */
  title: string;
  blocks: ImportBlock[];
  /** Assets referenced by this page's blocks (subset of the document's). */
  assets: ImportAsset[];
  children: ImportPagePlan[];
}

export interface SplitOptions {
  /** Heading levels 1..`level` open new pages. 0 disables splitting. */
  level: 1 | 2;
  /** Title for the root page. */
  rootTitle: string;
}

export class SplitTitleConflictError extends Error {
  constructor(public readonly duplicates: string[]) {
    super(
      `Splitting would create multiple pages with the same title: ${duplicates.join(", ")}. ` +
        `Confluence titles must be unique per space — rename the duplicated headings and re-import.`,
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
    } else if (block.type === "blockquote") {
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

/**
 * @throws SplitTitleConflictError when two resulting pages share a title —
 * a conflict the user must resolve before any publication (§2.12).
 */
export function splitDocument(doc: ImportedDocument, options: SplitOptions): ImportPagePlan {
  const root: ImportPagePlan = { title: options.rootTitle, blocks: [], assets: [], children: [] };
  // Stack of open pages by split depth; index 0 = root.
  const stack: ImportPagePlan[] = [root];

  for (const block of doc.blocks) {
    if (block.type === "heading" && block.level <= options.level) {
      const title = headingTitle(block) || "Untitled section";
      const depth = block.level; // H1 → child of root (depth 1), H2 → depth 2
      while (stack.length - 1 >= depth) stack.pop();
      // A jump straight to H2 without an open H1 page attaches to the
      // deepest open page rather than inventing an empty intermediate page.
      const parent = stack[stack.length - 1];
      const page: ImportPagePlan = { title, blocks: [], assets: [], children: [] };
      parent.children.push(page);
      stack.push(page);
      continue;
    }
    stack[stack.length - 1].blocks.push(block);
  }

  const fill = (page: ImportPagePlan): void => {
    page.assets = assetsFor(page.blocks, doc);
    for (const child of page.children) fill(child);
  };
  fill(root);

  const titles: string[] = [];
  collectTitles(root, titles);
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const title of titles) {
    const key = title.toLowerCase();
    if (seen.has(key)) duplicates.add(title);
    seen.add(key);
  }
  if (duplicates.size > 0) throw new SplitTitleConflictError([...duplicates].sort());

  return root;
}

/** Count pages in a plan tree (root included). */
export function countPages(page: ImportPagePlan): number {
  return 1 + page.children.reduce((sum, child) => sum + countPages(child), 0);
}
