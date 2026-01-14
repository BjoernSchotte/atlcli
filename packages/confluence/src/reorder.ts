/**
 * Page reordering and sorting utilities.
 */

import type { ConfluenceClient, ConfluencePage } from "./client.js";

export type PageWithPosition = ConfluencePage & { position: number | null };

export type SortStrategy =
  | { type: "alphabetical"; reverse?: boolean }
  | { type: "natural"; reverse?: boolean }
  | { type: "created"; reverse?: boolean }
  | { type: "modified"; reverse?: boolean }
  | { type: "custom"; order: string[] };

export interface ReorderResult {
  parent: { id: string; title: string };
  oldOrder: PageWithPosition[];
  newOrder: PageWithPosition[];
  moved: number;
}

/**
 * Natural sort comparison (handles numbers in strings).
 * "Chapter 1" < "Chapter 2" < "Chapter 10"
 */
export function naturalCompare(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
}

/**
 * Sort pages according to strategy.
 */
export function sortPages(
  pages: PageWithPosition[],
  strategy: SortStrategy
): PageWithPosition[] {
  const sorted = [...pages];

  switch (strategy.type) {
    case "alphabetical":
      sorted.sort((a, b) => a.title.localeCompare(b.title));
      break;
    case "natural":
      sorted.sort((a, b) => naturalCompare(a.title, b.title));
      break;
    case "created":
      // Note: createdAt not always available, fallback to alphabetical
      sorted.sort((a, b) => {
        const aDate = (a as any).createdAt;
        const bDate = (b as any).createdAt;
        if (aDate && bDate) {
          return new Date(aDate).getTime() - new Date(bDate).getTime();
        }
        return a.title.localeCompare(b.title);
      });
      break;
    case "modified":
      // Note: modifiedAt not always available, fallback to alphabetical
      sorted.sort((a, b) => {
        const aDate = (a as any).modifiedAt;
        const bDate = (b as any).modifiedAt;
        if (aDate && bDate) {
          return new Date(aDate).getTime() - new Date(bDate).getTime();
        }
        return a.title.localeCompare(b.title);
      });
      break;
    case "custom":
      const orderMap = new Map(strategy.order.map((id, i) => [id, i]));
      sorted.sort((a, b) => {
        const aIdx = orderMap.get(a.id) ?? Number.MAX_SAFE_INTEGER;
        const bIdx = orderMap.get(b.id) ?? Number.MAX_SAFE_INTEGER;
        return aIdx - bIdx;
      });
      break;
  }

  if ("reverse" in strategy && strategy.reverse) {
    sorted.reverse();
  }

  return sorted;
}

/**
 * Check if two arrays have the same order by ID.
 */
export function isSameOrder(a: PageWithPosition[], b: PageWithPosition[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((page, i) => page.id === b[i].id);
}

/**
 * Reorder children of a parent page to match a new order.
 * Uses the move API to position pages sequentially.
 *
 * @returns Number of pages actually moved
 */
export async function reorderChildren(
  client: ConfluenceClient,
  parentId: string,
  newOrder: string[]
): Promise<number> {
  if (newOrder.length <= 1) return 0;

  let moved = 0;

  // Strategy: Move each page after the previous one
  // First page doesn't need to move (it becomes the anchor)
  for (let i = 1; i < newOrder.length; i++) {
    const pageId = newOrder[i];
    const afterId = newOrder[i - 1];

    try {
      await client.movePageToPosition(pageId, "after", afterId);
      moved++;
    } catch (err) {
      // If page is already in position, API may error - continue
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes("already")) {
        throw err;
      }
    }
  }

  return moved;
}

/**
 * Sort children of a parent page according to a strategy.
 */
export async function sortChildren(
  client: ConfluenceClient,
  parentId: string,
  strategy: SortStrategy,
  options: { dryRun?: boolean } = {}
): Promise<ReorderResult> {
  // Get current children with positions
  const children = await client.getChildrenWithPosition(parentId);

  // Get parent info
  const parent = await client.getPage(parentId);

  // Sort according to strategy
  const sorted = sortPages(children, strategy);

  // Check if already in order
  if (isSameOrder(children, sorted)) {
    return {
      parent: { id: parent.id, title: parent.title },
      oldOrder: children,
      newOrder: sorted,
      moved: 0,
    };
  }

  // Apply reordering if not dry run
  let moved = 0;
  if (!options.dryRun) {
    const newOrderIds = sorted.map((p) => p.id);
    moved = await reorderChildren(client, parentId, newOrderIds);
  } else {
    // In dry run, count how many would move
    moved = children.filter((p, i) => p.id !== sorted[i].id).length;
  }

  return {
    parent: { id: parent.id, title: parent.title },
    oldOrder: children,
    newOrder: sorted,
    moved,
  };
}

/**
 * Move a page to first position among its siblings.
 */
export async function moveToFirst(
  client: ConfluenceClient,
  pageId: string
): Promise<{ moved: boolean; page: ConfluencePage }> {
  const page = await client.getPage(pageId);
  if (!page.parentId) {
    throw new Error("Cannot reorder top-level page (no parent)");
  }

  const siblings = await client.getChildrenWithPosition(page.parentId);
  if (siblings.length <= 1) {
    return { moved: false, page };
  }

  const currentIndex = siblings.findIndex((s) => s.id === pageId);
  if (currentIndex === 0) {
    return { moved: false, page };
  }

  // Move before the first sibling
  const firstSibling = siblings[0];
  const result = await client.movePageToPosition(pageId, "before", firstSibling.id);
  return { moved: true, page: result };
}

/**
 * Move a page to last position among its siblings.
 */
export async function moveToLast(
  client: ConfluenceClient,
  pageId: string
): Promise<{ moved: boolean; page: ConfluencePage }> {
  const page = await client.getPage(pageId);
  if (!page.parentId) {
    throw new Error("Cannot reorder top-level page (no parent)");
  }

  const siblings = await client.getChildrenWithPosition(page.parentId);
  if (siblings.length <= 1) {
    return { moved: false, page };
  }

  const currentIndex = siblings.findIndex((s) => s.id === pageId);
  if (currentIndex === siblings.length - 1) {
    return { moved: false, page };
  }

  // Move after the last sibling
  const lastSibling = siblings[siblings.length - 1];
  const result = await client.movePageToPosition(pageId, "after", lastSibling.id);
  return { moved: true, page: result };
}

/**
 * Move a page to a specific position (1-indexed) among its siblings.
 */
export async function moveToPosition(
  client: ConfluenceClient,
  pageId: string,
  position: number
): Promise<{ moved: boolean; page: ConfluencePage }> {
  const page = await client.getPage(pageId);
  if (!page.parentId) {
    throw new Error("Cannot reorder top-level page (no parent)");
  }

  const siblings = await client.getChildrenWithPosition(page.parentId);
  if (siblings.length <= 1) {
    return { moved: false, page };
  }

  // Convert to 0-indexed
  const targetIndex = Math.max(0, Math.min(position - 1, siblings.length - 1));
  const currentIndex = siblings.findIndex((s) => s.id === pageId);

  if (currentIndex === targetIndex) {
    return { moved: false, page };
  }

  // Remove current page from list to get target siblings
  const siblingsWithoutCurrent = siblings.filter((s) => s.id !== pageId);

  if (targetIndex === 0) {
    // Move before first
    const result = await client.movePageToPosition(pageId, "before", siblingsWithoutCurrent[0].id);
    return { moved: true, page: result };
  } else {
    // Move after the page that will be before us
    const afterPage = siblingsWithoutCurrent[targetIndex - 1];
    const result = await client.movePageToPosition(pageId, "after", afterPage.id);
    return { moved: true, page: result };
  }
}

/**
 * Validate that two pages are siblings (have the same parent).
 */
export async function validateSiblings(
  client: ConfluenceClient,
  pageId1: string,
  pageId2: string
): Promise<{ areSiblings: boolean; page1: ConfluencePage; page2: ConfluencePage }> {
  const [page1, page2] = await Promise.all([
    client.getPage(pageId1),
    client.getPage(pageId2),
  ]);

  return {
    areSiblings: page1.parentId === page2.parentId && page1.parentId !== null,
    page1,
    page2,
  };
}
