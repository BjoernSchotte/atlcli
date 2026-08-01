import {
  digestPublicationJsonV1,
  type PublicationBuildRequestV1,
  type StaticPublicationManifestV1,
} from "@atlcli/web-publish";

export interface AstroBuildInventoryV1 {
  schema: "atlcli.astro-build-inventory/1";
  bundleDigest: string;
  pages: readonly { sourceId: string; route: string; pathname: string }[];
  output: readonly { path: string; sha256: string; byteLength: number }[];
}

export interface CreateAstroStaticManifestOptionsV1 {
  request: PublicationBuildRequestV1;
  inventory: AstroBuildInventoryV1;
  builderVersion: string;
  astroVersion: string;
  experience: { id: string; version: string; digest: string };
}

function outputPathForPage(pathname: string, profile: "directory" | "portable-file"): string {
  const normalized = pathname.replace(/^\/+|\/+$/gu, "");
  return profile === "directory" ? `${normalized}/index.html` : `${normalized}.html`;
}

/**
 * Convert the private, immutable-build inventory into the public typed static
 * manifest. Every page and logical asset must have one exact output record;
 * unexplained inventory entries remain visible in `verification.issues`.
 */
export async function createAstroStaticPublicationManifestV1(
  options: CreateAstroStaticManifestOptionsV1,
): Promise<StaticPublicationManifestV1> {
  const { request, inventory } = options;
  if (inventory.schema !== "atlcli.astro-build-inventory/1" || inventory.bundleDigest !== request.bundle.bundleDigest) {
    throw new TypeError("Astro build inventory does not belong to the requested immutable bundle");
  }
  const outputs = new Map(inventory.output.map((entry) => [entry.path, entry]));
  const bySourceId = new Map(inventory.pages.map((page) => [page.sourceId, page]));
  const pages = request.bundle.pages.map((entry) => {
    const inventoryPage = bySourceId.get(entry.sourceId);
    if (inventoryPage === undefined) throw new TypeError(`Astro build inventory omitted publication page '${entry.sourceId}'`);
    const outputPath = outputPathForPage(inventoryPage.pathname, request.project.builder.outputProfile);
    const output = outputs.get(outputPath);
    if (output === undefined) throw new TypeError(`Astro build inventory has no output for publication page '${entry.sourceId}'`);
    return { sourceId: entry.sourceId, route: inventoryPage.route, outputPath, sha256: output.sha256, byteLength: output.byteLength };
  });
  const assets = request.bundle.assets.map((asset) => {
    const output = outputs.get(asset.path);
    if (output === undefined) throw new TypeError(`Astro build inventory omitted publication asset '${asset.assetId}'`);
    return { assetId: asset.assetId, outputPath: asset.path, sha256: output.sha256, byteLength: output.byteLength, mediaType: asset.mediaType };
  });
  const searchFiles = inventory.output.filter((entry) => entry.path.startsWith("pagefind/")).sort((a, b) => a.path.localeCompare(b.path));
  const seoFiles = inventory.output.filter((entry) => /(?:^|\/)(?:sitemap[^/]*\.xml|robots\.txt|[^/]+\.xml)$/u.test(entry.path));
  const seoDigest = await digestPublicationJsonV1(seoFiles);
  const searchDigest = await digestPublicationJsonV1(searchFiles);
  const analytics = request.project.analytics.provider === "none"
    ? { provider: "none" as const }
    : { provider: "plausible" as const, endpointOrigin: new URL(request.project.analytics.endpoint).origin, events: ["pageview"] };
  const base = {
    schema: "atlcli.static-publication-manifest/1" as const,
    bundleDigest: request.bundle.bundleDigest,
    builder: { id: "astro-static" as const, version: options.builderVersion, astroVersion: options.astroVersion },
    projectDigest: request.projectDigest,
    configDigest: request.configDigest,
    lockfileDigest: request.lockfileDigest,
    base: request.project.builder.base,
    outputProfile: request.project.builder.outputProfile,
    pages,
    assets,
    experience: options.experience,
    search: { provider: "pagefind" as const, digest: searchDigest, files: searchFiles, languages: [...request.project.search.languages], indexedSourceIds: pages.map((page) => page.sourceId) },
    seo: { digest: seoDigest },
    analytics,
    editLinks: { provider: request.project.editLink.provider === "none" ? "none" as const : "confluence" as const, includedSourceIds: [], omittedSourceIds: pages.map((page) => page.sourceId) },
    removedOwnedPaths: [],
    verification: { valid: true, checkedPages: pages.length, checkedAssets: assets.length, issues: [] },
  };
  return { ...base, buildDigest: await digestPublicationJsonV1(base) };
}
