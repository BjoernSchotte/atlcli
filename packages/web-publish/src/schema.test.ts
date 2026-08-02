import { describe, expect, test } from "bun:test";
import {
  PUBLICATION_BUNDLE_SCHEMA_V1,
  PUBLICATION_EXPERIENCE_SCHEMA_V1,
  PUBLICATION_PAGE_SCHEMA_V1,
  PUBLICATION_PROJECT_SCHEMA_V1,
  PUBLICATION_REFRESH_PLAN_SCHEMA_V1,
  PUBLISH_RUN_REQUEST_SCHEMA_V1,
  STATIC_PUBLICATION_MANIFEST_SCHEMA_V1,
  PublicationValidationErrorV1,
  parsePublicationBuildRequestV1,
  parsePublicationBuildResultV1,
  parsePublicationBundleV1,
  parsePublicationExperienceDescriptorV1,
  parsePublicationPageV1,
  parsePublicationProjectV1,
  parsePublicationRefreshPlanV1,
  parsePublicationRendererDescriptorV1,
  parsePublishRunRequestV1,
  parseStaticPublicationManifestV1,
  type PublicationBundleV1,
  type PublicationExperienceDescriptorV1,
  type PublicationPageV1,
  type PublicationProjectV1,
  type PublicationRefreshPlanV1,
  type StaticPublicationManifestV1,
} from "./index.js";

const project = {
  schema: PUBLICATION_PROJECT_SCHEMA_V1,
  publicationKey: "docs",
  source: { kind: "tree", rootPageId: "100" },
  sourcePolicy: {
    representation: "adf-primary",
    includeLabels: [],
    excludeLabels: ["private"],
    excludeMode: "prune-subtree",
    maxDepth: 8,
    maxPages: 10_000,
    maxFolders: 1_000,
  },
  completeness: "strict",
  visibility: "internal",
  routes: {
    prefix: "/docs",
    generatedStyle: "stable-pretty",
    collisions: "stable-source-suffix",
    tombstones: "retain",
    customRoutes: [],
  },
  macros: {
    mode: "allow-frozen-live",
    unknown: "visible-fallback",
    liveFreshnessSeconds: 300,
    maxRows: 5_000,
    maxNodes: 50_000,
    maxBytes: 8_000_000,
  },
  assets: {
    selfContained: true,
    external: "same-origin-only",
    allowedOrigins: [],
    activeContent: "block",
    maxAssetBytes: 50_000_000,
    maxTotalBytes: 1_000_000_000,
    maxImagePixels: 40_000_000,
    maxSvgNodes: 50_000,
  },
  renderers: {
    allowedRendererIds: ["atlcli.chart"],
    allowIslands: true,
    maxIslandBytes: 250_000,
    maxChartRows: 5_000,
    maxChartSeries: 100,
  },
  experience: {
    id: "atlcli.starlight",
    expectedVersion: "1.0.0",
    requiredCapabilities: ["responsive-navigation", "search-modal", "chart-islands"],
    designTokens: { "color.accent": "#0052cc", "motion.enabled": false },
    componentOverrides: {},
  },
  search: {
    provider: "pagefind",
    enabled: true,
    languages: "from-pages",
    filters: ["space", "label", "content-type", "language"],
    metadata: ["title", "description", "breadcrumbs", "image"],
    ranking: { title: 4, headings: 2, labels: 1.5, body: 1 },
    ui: "both",
    shortcut: "mod+k",
  },
  seo: {
    sitemap: true,
    robots: "noindex",
    canonical: true,
    structuredData: ["WebSite", "TechArticle", "BreadcrumbList"],
    socialCards: "metadata-only",
    feed: "disabled",
  },
  i18n: {
    defaultLocale: "en",
    locales: ["en", "de"],
    routeMode: "hide-default",
    fallback: { de: "en" },
    uiTranslations: "starlight",
  },
  media: {
    images: "verified-original",
    formats: ["original", "webp"],
    fonts: "system",
    imageZoom: true,
    code: "expressive-code",
  },
  analytics: { provider: "none" },
  editLink: { provider: "none" },
  builder: {
    builder: "astro-static",
    projectDir: "/workspace/site",
    integrationOptions: {
      bundlePath: "/workspace/bundle",
      routePrefix: "/docs",
      experienceId: "atlcli.starlight",
    },
    outputProfile: "directory",
    base: "/docs",
    buildCommand: ["bun", "run", "build"],
  },
  retention: { bundles: 3, builds: 3, graceSeconds: 86_400 },
} as const satisfies PublicationProjectV1;

const sourceSnapshot = {
  sourceDigest: "source-sha256",
  complete: true,
  deletionAuthority: "complete-scan",
  rootIds: ["100"],
  pages: [{
    sourceId: "100",
    sourceVersion: "7",
    representation: "atlas_doc_format",
    position: 0,
    depth: 0,
    title: "Guide",
    contentDigest: "content-sha256",
    metadataDigest: "metadata-sha256",
    assetMetadataDigest: "asset-metadata-sha256",
    macroDependencyDigest: "no-live-dependencies",
    state: "included",
  }],
} as const;

const page = {
  schema: PUBLICATION_PAGE_SCHEMA_V1,
  sourceId: "100",
  sourceVersion: "7",
  title: "Guide",
  position: 0,
  depth: 0,
  route: "/guide/",
  blocks: [{
    type: "paragraph",
    content: [{ type: "text", text: "Published content" }],
  }],
  notes: [{ level: "info", code: "other", message: "fixture" }],
  labels: ["guide"],
  links: [{ referenceId: "link-1", kind: "page", sourceId: "100" }],
  assetIds: ["asset-1"],
  renderDependencies: [{
    kind: "source-page",
    key: "100",
    version: "7",
    digest: "content-sha256",
    live: false,
  }],
  pageDigest: "page-sha256",
} as const satisfies PublicationPageV1;

const bundle = {
  schema: PUBLICATION_BUNDLE_SCHEMA_V1,
  bundleDigest: "bundle-sha256",
  createdBy: { name: "atlcli", version: "0.17.2" },
  sourceSnapshot,
  sourcePolicyDigest: "policy-sha256",
  chartPolicy: {
    strict: true,
    normalization: { maxRows: 2_000, maxSeries: 64, maxPoints: 20_000, maxBytes: 524_288 },
    static: { maxSvgNodes: 50_000, maxSvgBytes: 1_000_000, maxRenderMs: 1_000 },
    island: { enabled: true, maxRows: 80, maxSeries: 12, maxPoints: 800, maxBytes: 65_536 },
  },
  complete: true,
  rootIds: ["100"],
  pages: [{ sourceId: "100", path: "pages/100.json", pageDigest: "page-sha256" }],
  routes: [{
    sourceId: "100",
    route: "/guide/",
    state: "active",
    assignedBy: "generated",
    previousRoutes: [],
  }],
  assets: [{
    assetId: "asset-1",
    path: "assets/asset-1.png",
    sha256: "asset-sha256",
    byteLength: 42,
    mediaType: "image/png",
    disposition: "inline",
  }],
  issues: [],
} as const satisfies PublicationBundleV1;

const refreshPlan = {
  schema: PUBLICATION_REFRESH_PLAN_SCHEMA_V1,
  sourceSnapshot,
  changes: [{ kind: "add", sourceId: "100", nextDigest: "page-sha256" }],
  complete: true,
  issues: [],
  planDigest: "plan-sha256",
} as const satisfies PublicationRefreshPlanV1;

const experience = {
  schema: PUBLICATION_EXPERIENCE_SCHEMA_V1,
  id: "atlcli.starlight",
  version: "1.0.0",
  engine: "astro",
  capabilities: ["responsive-navigation", "search-modal", "chart-islands"],
  slots: ["header", "search-modal", "main-content", "renderer-styles"],
  designTokensSchema: "atlcli.starlight.tokens/1",
  components: {
    slots: { header: "Header", "main-content": "MainContent" },
    overrides: { search: "Search" },
    blockOverrides: { chart: "Chart" },
  },
} as const satisfies PublicationExperienceDescriptorV1;

const manifest = {
  schema: STATIC_PUBLICATION_MANIFEST_SCHEMA_V1,
  bundleDigest: "bundle-sha256",
  builder: { id: "astro-static", version: "1.0.0", astroVersion: "7.1.6" },
  projectDigest: "project-sha256",
  configDigest: "config-sha256",
  lockfileDigest: "lockfile-sha256",
  base: "/docs",
  outputProfile: "directory",
  pages: [{
    sourceId: "100",
    route: "/guide/",
    outputPath: "guide/index.html",
    sha256: "html-sha256",
    byteLength: 1_000,
  }],
  assets: [{
    assetId: "asset-1",
    outputPath: "assets/asset-1.png",
    sha256: "asset-sha256",
    byteLength: 42,
    mediaType: "image/png",
  }],
  experience: { id: "atlcli.starlight", version: "1.0.0", digest: "experience-sha256" },
  search: {
    provider: "pagefind",
    digest: "search-sha256",
    files: [{ path: "pagefind/pagefind.js", sha256: "index-sha256", byteLength: 100 }],
    languages: ["en"],
    indexedSourceIds: ["100"],
  },
  seo: { sitemapPath: "sitemap.xml", robotsPath: "robots.txt", digest: "seo-sha256" },
  analytics: { provider: "none" },
  editLinks: { provider: "none", includedSourceIds: [], omittedSourceIds: ["100"] },
  removedOwnedPaths: [],
  verification: { valid: true, checkedPages: 1, checkedAssets: 1, issues: [] },
  buildDigest: "build-sha256",
} as const satisfies StaticPublicationManifestV1;

describe("web publication runtime schemas v1", () => {
  test("accept and return the exact schema-bearing values", () => {
    const request = {
      schema: PUBLISH_RUN_REQUEST_SCHEMA_V1,
      projectRef: "projects/docs.json",
      operation: "run",
      dryRun: false,
    } as const;
    expect(parsePublicationProjectV1(project)).toBe(project);
    expect(parsePublishRunRequestV1(request)).toBe(request);
    expect(parsePublicationRefreshPlanV1(refreshPlan)).toBe(refreshPlan);
    expect(parsePublicationPageV1(page)).toBe(page);
    expect(parsePublicationBundleV1(bundle)).toBe(bundle);
    expect(parsePublicationExperienceDescriptorV1(experience)).toBe(experience);
    expect(parseStaticPublicationManifestV1(manifest)).toBe(manifest);
  });

  test("validate renderer and builder boundary values", () => {
    const renderer = {
      id: "atlcli.chart",
      version: "1.0.0",
      handles: ["chart"],
      capability: "island",
      dataSchema: "atlcli.chart/1",
      deterministic: true,
      externalRuntimeData: false,
    } as const;
    const buildRequest = {
      project,
      bundle,
      projectDigest: "project-sha256",
      configDigest: "config-sha256",
      lockfileDigest: "lockfile-sha256",
    } as const;
    const buildResult = { manifest, outputDirectory: "/workspace/site/dist" } as const;
    expect(parsePublicationRendererDescriptorV1(renderer)).toBe(renderer);
    expect(parsePublicationBuildRequestV1(buildRequest)).toBe(buildRequest);
    expect(parsePublicationBuildResultV1(buildResult)).toBe(buildResult);
  });

  test("reject unknown fields and wrong schema revisions at their exact paths", () => {
    expect(() => parsePublicationProjectV1({ ...project, token: "secret" }))
      .toThrow("$.token: unknown field");
    expect(() => parsePublicationBundleV1({ ...bundle, schema: "atlcli.publication-bundle/2" }))
      .toThrow("$.schema: expected");
    expect(() => parseStaticPublicationManifestV1({
      ...manifest,
      builder: { ...manifest.builder, privateConfig: true },
    })).toThrow("$.builder.privateConfig: unknown field");
  });

  test("reject invalid embedded ExportBlocks and closed registry values", () => {
    expect(() => parsePublicationPageV1({
      ...page,
      blocks: [{ type: "rawHtml", html: "<script>" }],
    })).toThrow("invalid ExportBlock document");
    expect(() => parsePublicationExperienceDescriptorV1({
      ...experience,
      capabilities: ["arbitrary-script"],
    })).toThrow("expected one of");
    expect(() => parsePublicationRendererDescriptorV1({
      id: "unsafe",
      version: "1",
      handles: ["chart"],
      capability: "island",
      dataSchema: "unsafe/1",
      deterministic: true,
      externalRuntimeData: true,
    })).toThrow("$.externalRuntimeData: expected false");
    expect(() => parsePublicationProjectV1({
      ...project,
      experience: {
        ...project.experience,
        componentOverrides: { arbitraryScript: "./unsafe.js" },
      },
    })).toThrow("$.experience.componentOverrides.arbitraryScript: unknown field");
    expect(parsePublicationProjectV1({
      ...project,
      macros: {
        ...project.macros,
        chartDiagnostics: { p0Codes: ["malformed-data", "renderer-fallback"] },
      },
    }).macros.chartDiagnostics?.p0Codes).toEqual(["malformed-data", "renderer-fallback"]);
    expect(() => parsePublicationProjectV1({
      ...project,
      macros: { ...project.macros, chartDiagnostics: { p0Codes: ["arbitrary-code"] } },
    })).toThrow("$.macros.chartDiagnostics.p0Codes[0]: expected one of");
    expect(() => parsePublicationProjectV1({
      ...project,
      macros: { ...project.macros, chartDiagnostics: { p0Codes: [] } },
    })).toThrow("$.macros.chartDiagnostics.p0Codes: expected at least one");
  });

  test("reject unsafe, non-canonical, and out-of-prefix routes", () => {
    expect(() => parsePublicationProjectV1({
      ...project,
      routes: { ...project.routes, prefix: "/docs/../escape" },
    })).toThrow("$.routes.prefix");
    expect(() => parsePublicationProjectV1({
      ...project,
      routes: {
        ...project.routes,
        customRoutes: [{ sourceId: "100", route: "/outside/" }],
      },
    })).toThrow("outside prefix");
    expect(() => parsePublicationProjectV1({
      ...project,
      routes: {
        ...project.routes,
        customRoutes: [{ sourceId: "100", route: "/docs/guide" }],
      },
    })).toThrow("expected canonical route \"/docs/guide/\"");
    expect(() => parsePublicationBundleV1({
      ...bundle,
      routes: [{ ...bundle.routes[0], route: "/../escape/" }],
    })).toThrow("$.routes[0].route");
    expect(() => parsePublicationBundleV1({
      ...bundle,
      assets: [{ ...bundle.assets[0], downloadName: "../escape.png" }],
    })).toThrow("$.assets[0].downloadName");
    expect(() => parsePublicationPageV1({ ...page, route: "/guide\\escape/" }))
      .toThrow("$.route");
  });

  test("reject cycles, non-finite data, non-plain objects, and resource overruns", () => {
    const cyclic: Record<string, unknown> = { ...project };
    cyclic.self = cyclic;
    expect(() => parsePublicationProjectV1(cyclic)).toThrow("cyclic value");
    expect(() => parsePublicationProjectV1({
      ...project,
      search: { ...project.search, ranking: { ...project.search.ranking, body: Number.NaN } },
    })).toThrow("expected a finite number");
    expect(() => parsePublicationProjectV1(new (class Project {})()))
      .toThrow("expected a plain object");
    const accessor = { ...project } as Record<string, unknown>;
    Object.defineProperty(accessor, "hidden", { get: () => "evaluated", enumerable: true });
    expect(() => parsePublicationProjectV1(accessor))
      .toThrow("expected a plain enumerable data property");
    const sparseLabels = new Array<string>(1);
    expect(() => parsePublicationProjectV1({
      ...project,
      sourcePolicy: { ...project.sourcePolicy, includeLabels: sparseLabels },
    })).toThrow("expected a dense array without custom fields");
    expect(() => parsePublicationProjectV1(project, {
      maxDepth: 128,
      maxNodes: 10,
      maxStringBytes: 1_000_000,
      maxArrayLength: 100,
    })).toThrow("node budget exceeded");
    expect(() => parsePublicationProjectV1(project, {
      maxDepth: 128,
      maxNodes: 100_000,
      maxStringBytes: 1_000_000,
      maxArrayLength: 1,
    })).toThrow("array-length budget exceeded");
  });
});
