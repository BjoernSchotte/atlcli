import {
  digestPublicationJsonV1,
  normalizePublicationRouteV1,
  publicationRouteToOutputPathV1,
  validatePublicationOutputPathV1,
  type PublicationBuildRequestV1,
  type StaticPublicationManifestV1,
} from "@atlcli/web-publish";

export interface AstroBuildInventoryV1 {
  schema: "atlcli.astro-build-inventory/1";
  bundleDigest: string;
  pages: readonly { kind: "page"; sourceId: string; route: string; pathname: string }[];
  /** Generated graph landings are output-verified but are not source pages. */
  labelLandings?: readonly {
    kind: "label";
    label: string;
    slug: string;
    route: string;
    sourceIds: readonly string[];
    pathname: string;
  }[];
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
  const stem = pathname.replace(/^\/+|\/+$/gu, "");
  const route = normalizePublicationRouteV1(stem === "" ? "/" : `/${stem}/`);
  return publicationRouteToOutputPathV1(route, profile);
}

function assertInventoryOutput(inventory: AstroBuildInventoryV1): Map<string, AstroBuildInventoryV1["output"][number]> {
  const outputs = new Map<string, AstroBuildInventoryV1["output"][number]>();
  for (const output of inventory.output) {
    const path = validatePublicationOutputPathV1(output.path);
    if (path !== output.path) throw new TypeError(`Astro build inventory output path is not canonical: ${output.path}`);
    if (!/^[a-f0-9]{64}$/u.test(output.sha256) || !Number.isSafeInteger(output.byteLength) || output.byteLength < 0) {
      throw new TypeError(`Astro build inventory has invalid output integrity data: ${path}`);
    }
    if (outputs.has(path)) throw new TypeError(`Astro build inventory has duplicate output path: ${path}`);
    outputs.set(path, output);
  }
  return outputs;
}

function assertInventoryPages(request: PublicationBuildRequestV1, inventory: AstroBuildInventoryV1): Map<string, AstroBuildInventoryV1["pages"][number]> {
  const bundlePageIds = new Set(request.bundle.pages.map((page) => page.sourceId));
  const pages = new Map<string, AstroBuildInventoryV1["pages"][number]>();
  for (const page of inventory.pages) {
    if (page.kind !== "page") throw new TypeError("Astro build inventory has an invalid source page kind");
    if (!bundlePageIds.has(page.sourceId)) throw new TypeError(`Astro build inventory has unexplained publication page '${page.sourceId}'`);
    if (pages.has(page.sourceId)) throw new TypeError(`Astro build inventory has duplicate publication page '${page.sourceId}'`);
    const expectedRoute = request.bundle.routes.find((route) => route.sourceId === page.sourceId && route.state === "active")?.route;
    if (expectedRoute === undefined || page.route !== expectedRoute) {
      throw new TypeError(`Astro build inventory route does not match publication page '${page.sourceId}'`);
    }
    // This validates the Astro pathname before it becomes an output path.
    outputPathForPage(page.pathname, request.project.builder.outputProfile);
    pages.set(page.sourceId, page);
  }
  return pages;
}

function assertInventoryLabelLandings(
  request: PublicationBuildRequestV1,
  inventory: AstroBuildInventoryV1,
): Set<string> {
  const knownSourceIds = new Set(request.bundle.pages.map((page) => page.sourceId));
  const outputPaths = new Set<string>();
  const slugs = new Set<string>();
  for (const landing of inventory.labelLandings ?? []) {
    if (
      landing.kind !== "label" ||
      typeof landing.label !== "string" || landing.label.length === 0 ||
      typeof landing.slug !== "string" || landing.slug.length === 0 ||
      !Array.isArray(landing.sourceIds) || landing.sourceIds.length === 0
    ) {
      throw new TypeError("Astro build inventory has an invalid label landing");
    }
    if (slugs.has(landing.slug)) throw new TypeError(`Astro build inventory has duplicate label landing '${landing.slug}'`);
    slugs.add(landing.slug);
    for (const sourceId of landing.sourceIds) {
      if (!knownSourceIds.has(sourceId)) throw new TypeError(`Astro build inventory label landing references unknown page '${sourceId}'`);
    }
    const path = outputPathForPage(landing.pathname, request.project.builder.outputProfile);
    if (outputPaths.has(path)) throw new TypeError(`Astro build inventory has duplicate label landing output '${path}'`);
    outputPaths.add(path);
  }
  return outputPaths;
}

function isTrustedGeneratedOutput(path: string): boolean {
  return path.startsWith("_astro/") ||
    path.startsWith("pagefind/") ||
    /(?:^|\/)(?:sitemap[^/]*\.xml|robots\.txt|[^/]+\.xml)$/u.test(path);
}

function assertNoUnexplainedOutput(
  outputs: ReadonlyMap<string, AstroBuildInventoryV1["output"][number]>,
  pagePaths: ReadonlySet<string>,
  assetPaths: ReadonlySet<string>,
): void {
  for (const path of outputs.keys()) {
    if (pagePaths.has(path) || assetPaths.has(path) || isTrustedGeneratedOutput(path)) continue;
    throw new TypeError(`Astro build inventory has unexplained output path: ${path}`);
  }
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
  const outputs = assertInventoryOutput(inventory);
  const bySourceId = assertInventoryPages(request, inventory);
  const labelLandingPaths = assertInventoryLabelLandings(request, inventory);
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
  assertNoUnexplainedOutput(
    outputs,
    new Set([...pages.map((page) => page.outputPath), ...labelLandingPaths]),
    new Set(assets.map((asset) => asset.outputPath)),
  );
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
