/**
 * The one piece of mutable state the Chrome adapters share (spec 010 Phase 0).
 *
 * `ConfluenceExportReader` and the template store are constructed once, but the
 * site they act against changes whenever the user switches tab. Rather than
 * threading a URL through every port signature — which would force a Forge host
 * to carry a parameter it does not have — the page-context adapter publishes
 * the current URL here and the other adapters read it at call time.
 *
 * Deliberately host-local: nothing in `components/` or `utils/ports/` imports
 * this.
 */
export interface SiteContext {
  /** The URL the host is currently showing, or `null`. */
  readonly url: string | null;
  set(url: string | null): void;
}

export function createSiteContext(initial: string | null = null): SiteContext {
  let url = initial;
  return {
    get url() {
      return url;
    },
    set(next) {
      url = next;
    },
  };
}
