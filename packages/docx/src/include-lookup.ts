/**
 * Host-side `$scroll.includepage.(…)` lookup builder (spec 005 D1).
 *
 * The engine's INCLUDE pass calls `deps.getIncludedPage(ref)` and expects a
 * discriminated {@link IncludeLookupOutcome}. Every host (CLI, extension,
 * further hosts) needs the SAME title lookup, id-sorted determinism, ambiguity
 * handling, and error classification — so it lives here once, injectable and
 * isomorphic (no `node:*` / `chrome.*` / direct network). Hosts pass their
 * Confluence client's `getPage` plus `findPagesByTitle`; unit tests inject plain
 * in-memory functions (no mocking).
 *
 * Title resolution goes through the DIRECT content endpoint
 * (`findPagesByTitle` → `GET /content?title=…`), NOT the CQL search index,
 * because the search index lags page creation on Cloud (a freshly created
 * include target came back "not found" on the first export and only resolved on
 * a retry minutes later — see {@link IncludeLookupIo.findPagesByTitle}). No CQL
 * string-literal escaping is involved: the title rides as a plain, URL-encoded
 * query parameter.
 */
import type { ConfluencePageDetails } from "@atlcli/confluence";
import type { IncludePageRef } from "./placeholder-map.js";
import type { IncludeLookupOutcome } from "./resolver.js";

/** The host primitives {@link buildGetIncludedPage} composes. */
export interface IncludeLookupIo {
  /** Fetch a page (with `storage`) by id — the client's `getPage`. */
  getPage: (id: string) => Promise<ConfluencePageDetails>;
  /**
   * Look up pages by EXACT title (+ optional space) through the client's
   * DIRECT content endpoint (`ConfluenceClient.findPagesByTitle`), which reads
   * the content store rather than the lagging search index. Returns every
   * match; the builder sorts by id. Only the hits' `id`s are needed.
   */
  findPagesByTitle: (title: string, spaceKey?: string) => Promise<Array<{ id: string }>>;
  /** Space of the EXPORTED page, filling a bare-title `(Title)` form. */
  defaultSpaceKey?: string;
}

function isAbortError(err: unknown): boolean {
  return (
    (typeof DOMException !== "undefined" && err instanceof DOMException && err.name === "AbortError") ||
    (err instanceof Error && err.name === "AbortError")
  );
}

/**
 * Classify a thrown Confluence error into a non-`resolved`
 * {@link IncludeLookupOutcome}. `@atlcli/confluence`'s `request()` carries no
 * typed status field, but its thrown messages are textually distinguishable:
 *  - 401 → `auth-failed`;
 *  - 403 / 404 → `not-found-or-forbidden` (Cloud makes these genuinely
 *    indistinguishable, so this pair stays one honest combined outcome);
 *  - `Rate limited by Confluence API after N retries` → `rate-limited`;
 *  - anything else (5xx after retries, raw network failure) → `transient-error`
 *    carrying the message.
 *
 * (The PLAN's `40[13]` sketch conflated 401 with the not-found pair; 404 is the
 * not-found status and 401 is auth, so this checks 401 first, then 403/404.)
 */
export function classifyIncludeError(err: unknown): IncludeLookupOutcome {
  const message = err instanceof Error ? err.message : String(err);
  if (/Confluence API error \(401\)/.test(message)) return { kind: "auth-failed" };
  if (/Confluence API error \(40[34]\)/.test(message)) return { kind: "not-found-or-forbidden" };
  if (/^Rate limited by Confluence API/.test(message)) return { kind: "rate-limited" };
  return { kind: "transient-error", message };
}

/**
 * Build a `getIncludedPage` loader from a host's client primitives. Resolution:
 *  - a `pageId` ref → one `getPage`;
 *  - a title ref → a DIRECT `findPagesByTitle(title, spaceKey)` lookup (NOT CQL
 *    — avoids the search-index lag; `spaceKey` defaults to the exported page's
 *    space); zero hits → `not-found-or-forbidden`; the hits are id-sorted for
 *    determinism and the FIRST is fetched — more than one hit still resolves it
 *    but reports `ambiguous` with the count.
 *
 * An `AbortError` is rethrown (host cancellation); every other throw is
 * classified by {@link classifyIncludeError}. The loader is memoization-agnostic
 * — the engine's include pass owns fetch de-duplication.
 */
export function buildGetIncludedPage(
  io: IncludeLookupIo
): (ref: IncludePageRef) => Promise<IncludeLookupOutcome> {
  return async (ref) => {
    try {
      if (ref.pageId) {
        return { kind: "resolved", page: await io.getPage(ref.pageId) };
      }
      const title = ref.title;
      if (!title) return { kind: "not-found-or-forbidden" };

      const spaceKey = ref.spaceKey ?? io.defaultSpaceKey;
      const hits = await io.findPagesByTitle(title, spaceKey);

      if (hits.length === 0) return { kind: "not-found-or-forbidden" };
      const sorted = [...hits].sort((a, b) => a.id.localeCompare(b.id));
      const page = await io.getPage(sorted[0].id);
      if (hits.length > 1) return { kind: "ambiguous", count: hits.length, page };
      return { kind: "resolved", page };
    } catch (err) {
      if (isAbortError(err)) throw err;
      return classifyIncludeError(err);
    }
  };
}
