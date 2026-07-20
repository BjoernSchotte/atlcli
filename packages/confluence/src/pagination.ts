/**
 * Cursor / link pagination driver, shared by every paginated `ConfluenceClient`
 * listing (`searchPages`, `getChildrenWithPosition`, `getPageDirectChildren`,
 * `getFolderChildren`).
 *
 * Completeness contract (the reason this exists as one helper): pagination ends
 * ONLY when a page reports no `next` token. A *short* page — fewer items than
 * the requested limit — that still carries a live `next` token is NOT the last
 * page, and continuing is mandatory. Confluence Cloud legitimately returns
 * short pages with a live `next` link (permission-filtered items, internal
 * page-size adjustments); the previous per-caller `results.length < limit` /
 * `results.length === 0` early break silently dropped every page after such a
 * short page — a completeness and (for `searchPages`-backed label filters) a
 * privacy bug. A `next` token identical to one already followed cannot advance
 * pagination and is treated as a loop → {@link PaginationLoopError}, rather than
 * spinning forever.
 *
 * Isomorphic: only Promise/Set/Array, no `node:`/`bun:` specifiers.
 */

/** Thrown when a paginated endpoint returns a `next` token it already returned. */
export class PaginationLoopError extends Error {
  /** Stable machine code for the export report / callers. */
  readonly code = "pagination-loop" as const;
  constructor(public readonly token: string) {
    super(
      `Pagination did not advance: the cursor/next link repeated (${token}). ` +
        `Aborting to avoid an infinite loop.`
    );
    this.name = "PaginationLoopError";
  }
}

/** One page returned by a {@link drainPaginated} fetcher. */
export interface PaginatedPage<T> {
  items: T[];
  /**
   * The token that fetches the *next* page (a `_links.next` path for v1 or an
   * extracted cursor for v2), or `undefined` when this is the final page.
   */
  next?: string;
}

/**
 * Drive a paginated endpoint to completion.
 *
 * @param fetchPage - Fetches one page. Receives `undefined` for the first
 *   request, then the previous page's `next` token for each subsequent request.
 * @returns Every item across all pages, in page order.
 * @throws {PaginationLoopError} when a `next` token repeats.
 */
export async function drainPaginated<T>(
  fetchPage: (token: string | undefined) => Promise<PaginatedPage<T>>
): Promise<T[]> {
  const all: T[] = [];
  const seen = new Set<string>();
  let token: string | undefined;
  for (;;) {
    const page = await fetchPage(token);
    all.push(...page.items);
    const next = page.next;
    // Absence of a next token is the ONLY legitimate end of pagination.
    if (next === undefined || next === "") break;
    if (seen.has(next)) throw new PaginationLoopError(next);
    seen.add(next);
    token = next;
  }
  return all;
}
