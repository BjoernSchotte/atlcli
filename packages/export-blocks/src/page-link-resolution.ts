import type { LinkTarget } from "./index.js";

/**
 * Minimal page identity needed to resolve an {@link LinkTarget} without a
 * Confluence client, source parser, route policy, or renderer.
 */
export interface PageLinkCandidate {
  id: string;
  title: string;
  spaceKey?: string;
}

/** Result of resolving a page link against one bounded publication scope. */
export type PageLinkResolution =
  | { kind: "resolved"; targetId: string }
  | { kind: "ambiguous" }
  | { kind: "out-of-scope" };

/** Pure, reusable page-link lookup with an immutable public surface. */
export interface PageLinkResolver {
  resolve(
    target: Extract<LinkTarget, { kind: "page" }>,
    currentSpaceKey?: string,
  ): PageLinkResolution;
}

/** Unambiguous composite key for `(spaceKey, title)` lookups. */
function spaceTitleKey(spaceKey: string, title: string): string {
  return JSON.stringify([spaceKey, title]);
}

/**
 * Build the shared page-link resolver used before format-specific rendering.
 *
 * Resolution deliberately preserves the historical `composeChapters` truth
 * table:
 *
 * 1. A non-empty `contentId` is authoritative. A missing ID is out of scope;
 *    it never falls back to a possibly matching title.
 * 2. Otherwise the link's own `spaceKey` wins, followed by the current page's
 *    space.
 * 3. An exact `(spaceKey, contentTitle)` match resolves only when unique.
 *    Duplicate titles are ambiguous; everything else is out of scope.
 *
 * Pages without a non-empty space key are intentionally not title-indexed.
 * Duplicate IDs retain the previous Map semantics (the last candidate wins),
 * although the externally visible target remains that duplicate ID.
 */
export function createPageLinkResolver(
  pages: readonly PageLinkCandidate[],
): PageLinkResolver {
  const byId = new Map<string, PageLinkCandidate>();
  const bySpaceTitle = new Map<string, PageLinkCandidate[]>();

  for (const page of pages) {
    byId.set(page.id, page);
    if (page.spaceKey) {
      const key = spaceTitleKey(page.spaceKey, page.title);
      const candidates = bySpaceTitle.get(key);
      if (candidates) candidates.push(page);
      else bySpaceTitle.set(key, [page]);
    }
  }

  return Object.freeze({
    resolve(
      target: Extract<LinkTarget, { kind: "page" }>,
      currentSpaceKey?: string,
    ): PageLinkResolution {
      if (target.contentId) {
        const candidate = byId.get(target.contentId);
        return candidate
          ? { kind: "resolved", targetId: candidate.id }
          : { kind: "out-of-scope" };
      }

      const spaceKey = target.spaceKey ?? currentSpaceKey;
      if (spaceKey) {
        const candidates = bySpaceTitle.get(
          spaceTitleKey(spaceKey, target.contentTitle),
        ) ?? [];
        if (candidates.length === 1) {
          return { kind: "resolved", targetId: candidates[0]!.id };
        }
        if (candidates.length > 1) return { kind: "ambiguous" };
      }

      return { kind: "out-of-scope" };
    },
  });
}
