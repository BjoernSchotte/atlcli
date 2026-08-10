import { readFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import {
  assertPublicationBundleReferencesV1,
  parsePublicationBundleV1,
  parsePublicationPageV1,
  type PublicationBundleV1,
  type PublicationPageV1,
} from "@atlcli/web-publish";

export interface AtlcliPublicationLoaderOptionsV1 {
  /** Absolute or project-relative path of the complete bundle JSON document. */
  bundlePath: string;
}

export interface LoadedPublicationBundleV1 {
  bundle: PublicationBundleV1;
  pages: readonly PublicationPageV1[];
}

/** Minimal public shape of Astro's documented structured-data loader hook. */
export interface AtlcliAstroPublicationLoaderV1 {
  name: string;
  load(context: {
    store: { clear(): void; set(entry: { id: string; data: unknown }): void };
    parseData(entry: { id: string; data: unknown }): Promise<unknown>;
    logger: { info(message: string): void };
  }): Promise<void>;
}

function assertBundlePath(path: string): void {
  if (typeof path !== "string" || path.length === 0) {
    throw new TypeError("publication bundlePath must be a non-empty string");
  }
}

function pagePath(bundlePath: string, relativePagePath: string): string {
  const root = resolve(dirname(bundlePath));
  const candidate = resolve(root, relativePagePath);
  const fromRoot = relative(root, candidate);
  if (fromRoot === "" || fromRoot === ".." || fromRoot.startsWith(`..${sep}`)) {
    throw new TypeError(`publication page path escapes bundle directory: ${relativePagePath}`);
  }
  return candidate;
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}

/**
 * Read a closed bundle and every referenced page document. The bundle is
 * rejected before it reaches Astro when it is partial, malformed, references a
 * missing/outside file, or does not agree with its page documents.
 */
export async function readPublicationBundlePagesV1(
  options: AtlcliPublicationLoaderOptionsV1,
): Promise<LoadedPublicationBundleV1> {
  assertBundlePath(options.bundlePath);
  const bundle = parsePublicationBundleV1(await readJson(options.bundlePath));
  if (!bundle.complete) {
    throw new TypeError("Astro publication loader requires a complete bundle");
  }
  const pages = await Promise.all(bundle.pages.map(async (entry) => {
    const page = parsePublicationPageV1(await readJson(pagePath(options.bundlePath, entry.path)));
    if (page.sourceId !== entry.sourceId || page.pageDigest !== entry.pageDigest) {
      throw new TypeError(`publication page '${entry.sourceId}' does not match its bundle entry`);
    }
    return page;
  }));
  assertPublicationBundleReferencesV1(bundle, pages);
  return { bundle, pages };
}

/**
 * Astro content loader for trusted structured pages. Source content stays data:
 * it cannot name an Astro component, module, MDX file, or loader option.
 */
export function atlcliPublicationLoader(
  options: AtlcliPublicationLoaderOptionsV1,
): AtlcliAstroPublicationLoaderV1 {
  return {
    name: "atlcli-publication-loader",
    async load({ store, parseData, logger }) {
      const loaded = await readPublicationBundlePagesV1(options);
      store.clear();
      for (const page of loaded.pages) {
        const data = await parseData({
          id: page.sourceId,
          data: {
            ...page,
            bundleDigest: loaded.bundle.bundleDigest,
          },
        });
        store.set({ id: page.sourceId, data });
      }
      logger.info(
        `loaded ${loaded.pages.length} structured publication page(s) (${loaded.bundle.bundleDigest})`,
      );
    },
  };
}
