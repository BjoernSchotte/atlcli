import type { ConfluenceClient } from "@atlcli/confluence/browser";
import type { IncludeLookupOutcome, IncludePageRef, ResolveDeps } from "@atlcli/docx/internal";
import type { ScanResult } from "@atlcli/docx/scan";

type SpaceInfo = Awaited<ReturnType<ConfluenceClient["getSpaceWithIcon"]>>;

export interface ExportDependencyLoaders {
  getSpaceWithIcon(key: string): Promise<SpaceInfo>;
  getCurrentUser(): ReturnType<ConfluenceClient["getCurrentUser"]>;
  getPageOwner(id: string): ReturnType<ConfluenceClient["getPageOwner"]>;
  getSpaceHomepageStorage(key: string): ReturnType<ConfluenceClient["getSpaceHomepageStorage"]>;
  /**
   * Cross-page include lookup (spec 005 D1). Unlike the other four loaders it is
   * NOT pre-started by {@link scanDependencies} (its refs are discovered only
   * inside the engine's include pass, per occurrence), so it stays lazy and
   * uncalled until an include token is actually expanded.
   */
  getIncludedPage(ref: IncludePageRef): Promise<IncludeLookupOutcome>;
}

type ExportDependency = "space" | "currentUser" | "owner" | "spaceHomepage" | "spaceLogo";

function pagePropertyUsesHomepage(raw: string): boolean {
  const open = raw.indexOf("(");
  const close = raw.lastIndexOf(")");
  if (open === -1 || close <= open) return false;
  const parts = raw
    .slice(open + 1, close)
    .split(",")
    .map((part) => part.trim().replace(/^["']|["']$/g, ""));
  if (parts[1] === "true") return true;
  return parts[1] !== "false" && parts[2] === "true";
}

/**
 * Derive the network dependencies from the scan already shown by the panel.
 * This deliberately mirrors the small public placeholder dependency contract
 * without importing the heavy DOCX browser barrel into the panel's static
 * graph. Raw page-property forms matter because only `(...,true)` needs the
 * homepage fallback.
 */
export function scanDependencies(scan: ScanResult): Set<ExportDependency> {
  const dependencies = new Set<ExportDependency>();
  for (const hit of scan.supported) {
    if (hit.base === "$scroll.space.name" || hit.base === "$scroll.space.url") {
      dependencies.add("space");
    } else if (hit.base.startsWith("$scroll.exporter")) {
      dependencies.add("currentUser");
    } else if (hit.base === "$scroll.pageowner.fullName") {
      dependencies.add("owner");
    } else if (hit.base === "$scroll.spacelogo" || hit.base === "$scroll.globallogo") {
      dependencies.add("spaceLogo");
    } else if (
      hit.base === "$scroll.pageproperty" &&
      hit.raw.some(pagePropertyUsesHomepage)
    ) {
      dependencies.add("spaceHomepage");
    }
  }
  return dependencies;
}

function memoByKey<T>(
  entries: Map<string, Promise<T>>,
  key: string,
  load: (key: string) => Promise<T>
): Promise<T> {
  const hit = entries.get(key);
  if (hit) return hit;
  const value = load(key);
  entries.set(key, value);
  return value;
}

function consumeRejection<T>(promise: Promise<T>): void {
  // Pre-starting is an optimization. This branch prevents an unhandled
  // rejection before the engine awaits the ORIGINAL promise; the engine still
  // receives that original rejection and turns it into the normal report note.
  void promise.catch(() => {});
}

/**
 * Build one export's dependency bag and pre-start exactly the calls named by
 * the uploaded template scan. All calls are memoized for this export, while
 * cross-export cache policy remains the host's responsibility (currently only
 * space + icon are safe to keep for five minutes).
 */
export function prepareExportDeps(
  scan: ScanResult,
  details: { spaceKey?: string; id?: string },
  loaders: ExportDependencyLoaders
): ResolveDeps {
  const spaceInfoEntries = new Map<string, Promise<SpaceInfo>>();
  const ownerEntries = new Map<string, ReturnType<ConfluenceClient["getPageOwner"]>>();
  const homepageEntries = new Map<string, ReturnType<ConfluenceClient["getSpaceHomepageStorage"]>>();
  let currentUserPromise: ReturnType<ConfluenceClient["getCurrentUser"]> | undefined;

  const spaceInfo = (key: string): Promise<SpaceInfo> =>
    memoByKey(spaceInfoEntries, key, loaders.getSpaceWithIcon);
  const currentUser = (): ReturnType<ConfluenceClient["getCurrentUser"]> =>
    (currentUserPromise ??= loaders.getCurrentUser());
  const pageOwner = (id: string): ReturnType<ConfluenceClient["getPageOwner"]> =>
    memoByKey(ownerEntries, id, loaders.getPageOwner);
  const homepageStorage = (key: string): ReturnType<ConfluenceClient["getSpaceHomepageStorage"]> =>
    memoByKey(homepageEntries, key, loaders.getSpaceHomepageStorage);

  const deps: ResolveDeps = {
    getSpace: async (key) => (await spaceInfo(key)).space,
    getCurrentUser: currentUser,
    getPageOwner: pageOwner,
    getSpaceHomepageStorage: homepageStorage,
    getSpaceLogo: async (key) => {
      const icon = (await spaceInfo(key)).icon;
      return icon ? { url: icon.path } : null;
    },
    // Wired straight through (spec 005 D1): the include pass invokes it lazily
    // per occurrence, so — unlike the four loaders above — there is no
    // pre-start branch for it in `scanDependencies`.
    getIncludedPage: loaders.getIncludedPage,
  };

  const required = scanDependencies(scan);
  if (details.spaceKey && (required.has("space") || required.has("spaceLogo"))) {
    consumeRejection(spaceInfo(details.spaceKey));
  }
  if (required.has("currentUser")) consumeRejection(currentUser());
  if (details.id && required.has("owner")) consumeRejection(pageOwner(details.id));
  if (details.spaceKey && required.has("spaceHomepage")) {
    consumeRejection(homepageStorage(details.spaceKey));
  }

  return deps;
}
