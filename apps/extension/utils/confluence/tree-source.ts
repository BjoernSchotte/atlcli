/**
 * Session-backed `TreeSource` adapter (spec 010 T5.1, Architecture point 1).
 *
 * Folder 002 defines the `TreeSource` **port** that `fetchExportTree` walks
 * through, plus `confluenceTreeSource(client)` — a client → port adapter that is
 * already isomorphic (it takes the structural `TreeSourceClient` subset, not a
 * node-only client). The extension therefore contributes exactly one thing: the
 * *host* half — synthesizing a session `Profile` from the active tab URL and
 * threading the export `AbortSignal` through every port method.
 *
 * Why `ConfluenceClient` and not a hand-rolled `fetch` (deliberate, not
 * incidental): the client already implements the two behaviors a session-mode
 * adapter must not get wrong, and both are inherited here for free —
 *
 *  - `assertNotAuthRedirect` (`packages/confluence/src/client.ts`): in session
 *    mode the client fetches with `redirect: "manual"`, so an expired session's
 *    bounce to `id.atlassian.com` surfaces as an opaque redirect that is
 *    classified as "not logged in" instead of being FOLLOWED to a foreign origin
 *    with the user's cookies attached. A raw `fetch` in this module would
 *    silently re-implement that — or, far more likely, forget to.
 *  - 429 `Retry-After` handling with exponential backoff and an *abortable*
 *    sleep, so Cancel during a rate-limit backoff actually stops the walk.
 *
 * The port shape is folder 002's, verbatim — this module deliberately declares
 * no parallel interface of its own.
 *
 * Pattern reference: `utils/docx/env.ts#sessionAssetFetcher` (session-backed
 * adapter over a neutral engine port) and `utils/read-path.ts` (session client
 * construction + injectable client seam for tests).
 */
import {
  ConfluenceClient,
  confluenceTreeSource,
  type TreeFetchContext,
  type TreeSource,
  type TreeSourceClient,
} from "@atlcli/confluence/browser";
import type { Profile } from "@atlcli/core";
import { profileFromTabUrl } from "../profile.js";

/**
 * Message thrown when the active tab is not on a host covered by the manifest's
 * `host_permissions`. Kept identical to the one `utils/pdf/run-export.ts`
 * already uses so the panel renders one wording for one condition.
 */
export const NOT_ATLASSIAN_HOST_MESSAGE =
  "The active page is not on an approved Atlassian host.";

export interface SessionTreeSourceOptions {
  /**
   * The export-level abort signal. Combined with (not replaced by) whatever
   * signal `fetchExportTree` threads into each call's {@link TreeFetchContext},
   * so a Cancel click stops the walk even for a caller that forgot to pass its
   * signal down — and a per-call signal still works on its own.
   */
  signal?: AbortSignal;
  /**
   * Injectable client seam (mirrors `ReadPathDeps.makeClient`). Production
   * passes nothing; tests supply a port-level fake when a real `Response` route
   * would add nothing.
   */
  makeClient?: (profile: Profile) => TreeSourceClient;
}

/**
 * Combine two optional abort signals into one.
 *
 * Returns the single signal when only one exists, and the *same* signal when
 * both are identical (the normal wiring: `fetchExportTree` threads the very
 * signal that was handed to this factory), so the common path allocates no
 * composite signal at all across a 500-page walk.
 */
export function combineAbortSignals(
  a: AbortSignal | undefined,
  b: AbortSignal | undefined
): AbortSignal | undefined {
  if (!a) return b;
  if (!b || a === b) return a;
  return AbortSignal.any([a, b]);
}

/**
 * Wrap a {@link TreeSource} so every method sees the export signal, and rejects
 * eagerly when it is already aborted — a `getChildren` call fans out into two
 * paginated client calls, so checking once up front avoids issuing HTTP for a
 * walk the user has already cancelled.
 */
function withExportSignal(source: TreeSource, exportSignal?: AbortSignal): TreeSource {
  const context = (ctx: TreeFetchContext): TreeFetchContext => {
    const signal = combineAbortSignals(exportSignal, ctx.signal);
    signal?.throwIfAborted();
    return signal ? { ...ctx, signal } : ctx;
  };

  // Every method is `async` so an already-aborted signal REJECTS rather than
  // throwing synchronously — the port declares `Promise<T>`, and a caller that
  // does `source.getPage(...).catch(…)` instead of `await` must not blow up.
  const wrapped: TreeSource = {
    getPage: async (id, ctx) => source.getPage(id, context(ctx)),
    getPageVersion: async (id, ctx) => source.getPageVersion(id, context(ctx)),
    getChildren: async (nodeRef, ctx) => source.getChildren(nodeRef, context(ctx)),
    getSpaceHomepageId: async (spaceKey, ctx) => source.getSpaceHomepageId(spaceKey, context(ctx)),
  };

  // `searchPages` is optional on the port: only expose it when the underlying
  // source actually has it, so `fetchExportTree`'s capability check stays honest
  // (an always-present method that throws would read as "CQL lookup available").
  const search = source.searchPages;
  if (search) {
    wrapped.searchPages = async (cql, ctx) => search.call(source, cql, context(ctx));
  }
  return wrapped;
}

/**
 * A {@link TreeSource} over a session-auth `Profile`.
 *
 * @param profile - a session profile (from {@link profileFromTabUrl}).
 * @param options - export signal + injectable client seam.
 */
export function sessionTreeSourceForProfile(
  profile: Profile,
  options: SessionTreeSourceOptions = {}
): TreeSource {
  const makeClient = options.makeClient ?? ((p: Profile) => new ConfluenceClient(p));
  const client = makeClient(profile);
  // The current panel-owned export path remains explicitly Storage-primary
  // until the background-job resolver owns the complete dual-read lifecycle.
  // Hiding the optional export read here is a routing policy, not a parser
  // fork: the same browser-safe TreeSource/dispatcher contracts are already
  // used by the shared core and will be enabled at the WP8 host boundary.
  const storageCompatibilityClient: TreeSourceClient = {
    getPageDetails: (id, request) => client.getPageDetails(id, request),
    getPageVersion: (id, request) => client.getPageVersion(id, request),
    getChildrenWithPosition: (id, request) => client.getChildrenWithPosition(id, request),
    getPageDirectChildren: (id, request) => client.getPageDirectChildren(id, request),
    getFolderChildren: (id, request) => client.getFolderChildren(id, request),
    getSpaceHomepageId: (key, request) => client.getSpaceHomepageId(key, request),
    searchPages: (cql, limit, request) => client.searchPages(cql, limit, request),
  };
  return withExportSignal(confluenceTreeSource(storageCompatibilityClient), options.signal);
}

/**
 * A {@link TreeSource} riding the ambient Atlassian browser session of the
 * active tab. Throws when the tab is not on an approved Atlassian host — the
 * panel must never attempt a cross-origin session fetch the manifest would not
 * permit (see `utils/profile.ts`).
 *
 * @param pageUrl - the active tab's URL.
 * @param options - export signal + injectable client seam.
 */
export function sessionTreeSource(
  pageUrl: string,
  options: SessionTreeSourceOptions = {}
): TreeSource {
  const profile = profileFromTabUrl(pageUrl);
  if (!profile) throw new Error(NOT_ATLASSIAN_HOST_MESSAGE);
  return sessionTreeSourceForProfile(profile, options);
}
