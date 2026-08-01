import { describe, expect, test } from "bun:test";
import {
  PUBLICATION_BUNDLE_SCHEMA_V1,
  PUBLICATION_EXPERIENCE_SCHEMA_V1,
  PUBLICATION_PROJECT_SCHEMA_V1,
  PUBLICATION_SEARCH_PROVIDER_SCHEMA_V1,
  STATIC_PUBLICATION_MANIFEST_SCHEMA_V1,
  PublicationBuilderContractErrorV1,
  PublicationRendererRegistryErrorV1,
  createPublicationRendererRegistryV1,
  negotiatePublicationExperienceV1,
  negotiatePublicationRenderersV1,
  negotiatePublicationSearchV1,
  planPublicationWebQualityV1,
  runPublicationBuildV1,
  type PublicationBuilderV1,
  type PublicationExperienceDescriptorV1,
  type PublicationProjectV1,
  type PublicationSearchProviderDescriptorV1,
  type StaticPublicationManifestV1,
} from "./index.js";

const project = {
  schema: PUBLICATION_PROJECT_SCHEMA_V1,
  publicationKey: "docs",
  source: { kind: "page", pageId: "100" },
  sourcePolicy: {
    representation: "adf-primary",
    includeLabels: [],
    excludeLabels: [],
    excludeMode: "page-only",
    maxPages: 100,
    maxFolders: 10,
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
    mode: "static-only",
    unknown: "visible-fallback",
    maxRows: 1_000,
    maxNodes: 10_000,
    maxBytes: 1_000_000,
  },
  assets: {
    selfContained: true,
    external: "same-origin-only",
    allowedOrigins: [],
    activeContent: "block",
    maxAssetBytes: 10_000_000,
    maxTotalBytes: 100_000_000,
    maxImagePixels: 20_000_000,
    maxSvgNodes: 10_000,
  },
  renderers: {
    allowedRendererIds: ["atlcli.chart", "atlcli.diagram"],
    allowIslands: true,
    maxIslandBytes: 200_000,
    maxChartRows: 1_000,
    maxChartSeries: 50,
  },
  experience: {
    id: "atlcli.starlight",
    expectedVersion: "1.0.0",
    requiredCapabilities: [
      "responsive-navigation", "search-modal", "search-page", "faceted-search",
      "chart-islands",
    ],
    designTokens: { accent: "#0052cc" },
    componentOverrides: { search: "CustomSearch" },
  },
  search: {
    provider: "pagefind",
    enabled: true,
    languages: ["en", "de"],
    filters: ["space", "label"],
    metadata: ["title", "breadcrumbs"],
    ranking: { title: 4, headings: 2, labels: 1, body: 1 },
    ui: "both",
    shortcut: "mod+k",
  },
  seo: {
    sitemap: true,
    robots: "noindex",
    canonical: true,
    structuredData: ["WebSite"],
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
    formats: ["original"],
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
  retention: { bundles: 2, builds: 2, graceSeconds: 60 },
} as const satisfies PublicationProjectV1;

const experience = {
  schema: PUBLICATION_EXPERIENCE_SCHEMA_V1,
  id: "atlcli.starlight",
  version: "1.0.0",
  engine: "astro",
  capabilities: [
    "responsive-navigation", "search-modal", "search-page", "faceted-search",
    "chart-islands",
  ],
  slots: [
    "primary-navigation", "left-navigation", "search-trigger", "search-modal",
    "main-content", "renderer-styles",
  ],
  designTokensSchema: "atlcli.starlight.tokens/1",
  components: {
    slots: {
      "primary-navigation": "PrimaryNavigation",
      "left-navigation": "LeftNavigation",
      "search-trigger": "SearchTrigger",
      "search-modal": "SearchModal",
      "main-content": "MainContent",
      "renderer-styles": "RendererStyles",
    },
    overrides: { search: "Search" },
    blockOverrides: { chart: "Chart" },
  },
} as const satisfies PublicationExperienceDescriptorV1;

const tokens = {
  schema: "atlcli.starlight.tokens/1",
  validate(values: Readonly<Record<string, string | number | boolean>>) {
    return typeof values.accent === "string"
      ? []
      : [{ token: "accent", message: "accent must be a string" }];
  },
} as const;

const pagefind = {
  schema: PUBLICATION_SEARCH_PROVIDER_SCHEMA_V1,
  id: "pagefind",
  version: "1.4.0",
  execution: "static-post-build",
  runtimeNetwork: false,
  languagePartitions: true,
  supportedFilters: ["space", "label", "content-type", "language"],
  supportedMetadata: ["title", "description", "breadcrumbs", "image"],
  supportedUi: ["modal", "page", "both"],
  supportedShortcuts: ["mod+k", "/", "none"],
} as const satisfies PublicationSearchProviderDescriptorV1;

const chartRenderer = {
  id: "atlcli.chart",
  version: "1.0.0",
  handles: ["chart"],
  capability: "island",
  dataSchema: "atlcli.chart/1",
  deterministic: true,
  externalRuntimeData: false,
} as const;

const diagramRenderer = {
  id: "atlcli.diagram",
  version: "1.0.0",
  handles: ["diagram"],
  capability: "static",
  dataSchema: "atlcli.diagram/1",
  deterministic: true,
  externalRuntimeData: false,
} as const;

const sourceSnapshot = {
  sourceDigest: "source-sha256",
  complete: true,
  deletionAuthority: "complete-scan",
  rootIds: ["100"],
  pages: [{
    sourceId: "100",
    sourceVersion: "1",
    representation: "atlas_doc_format",
    position: 0,
    depth: 0,
    title: "Guide",
    contentDigest: "content-sha256",
    metadataDigest: "metadata-sha256",
    assetMetadataDigest: "assets-sha256",
    macroDependencyDigest: "no-live-dependencies",
    state: "included",
  }],
} as const;

const bundle = {
  schema: PUBLICATION_BUNDLE_SCHEMA_V1,
  bundleDigest: "bundle-sha256",
  createdBy: { name: "atlcli", version: "0.17.2" },
  sourceSnapshot,
  sourcePolicyDigest: "policy-sha256",
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
  assets: [],
  issues: [],
} as const;

const manifest = {
  schema: STATIC_PUBLICATION_MANIFEST_SCHEMA_V1,
  bundleDigest: "bundle-sha256",
  builder: { id: "astro-static", version: "1.0.0", astroVersion: "7.1.6" },
  projectDigest: "project-sha256",
  configDigest: "config-sha256",
  lockfileDigest: "lockfile-sha256",
  base: "/docs",
  outputProfile: "directory",
  pages: [],
  assets: [],
  experience: { id: "atlcli.starlight", version: "1.0.0", digest: "experience-sha256" },
  search: {
    provider: "pagefind",
    digest: "search-sha256",
    files: [],
    languages: ["en", "de"],
    indexedSourceIds: ["100"],
  },
  seo: { digest: "seo-sha256" },
  analytics: { provider: "none" },
  editLinks: { provider: "none", includedSourceIds: [], omittedSourceIds: ["100"] },
  removedOwnedPaths: [],
  verification: { valid: true, checkedPages: 0, checkedAssets: 0, issues: [] },
  buildDigest: "build-sha256",
} as const satisfies StaticPublicationManifestV1;

describe("publication experience and adapter contracts", () => {
  test("negotiate a complete experience, Pagefind provider, and renderer set", () => {
    const negotiatedExperience = negotiatePublicationExperienceV1(
      project.experience,
      experience,
      tokens,
    );
    expect(negotiatedExperience.compatible).toBe(true);
    expect(negotiatedExperience.issues).toEqual([]);

    const search = negotiatePublicationSearchV1(project.search, pagefind, experience);
    expect(search.compatible).toBe(true);

    const registry = createPublicationRendererRegistryV1([chartRenderer, diagramRenderer]);
    const renderers = negotiatePublicationRenderersV1(project.renderers, registry, experience);
    expect(renderers.compatible).toBe(true);
    expect(renderers.selected.map((renderer) => renderer.id))
      .toEqual(["atlcli.chart", "atlcli.diagram"]);
    expect(renderers.byKind.chart).toBe(chartRenderer);
    expect(renderers.byKind.diagram).toBe(diagramRenderer);
    expect(Object.isFrozen(registry.descriptors)).toBe(true);
    expect(Object.isFrozen(renderers.byKind)).toBe(true);
  });

  test("report id/version/capability/slot/override/token mismatches without guessing", () => {
    const result = negotiatePublicationExperienceV1(
      {
        ...project.experience,
        id: "other",
        expectedVersion: "2.0.0",
        requiredCapabilities: [...project.experience.requiredCapabilities, "seo"],
        componentOverrides: { footer: "Footer" },
        designTokens: { accent: 42 },
      },
      {
        ...experience,
        slots: experience.slots.filter((slot) => slot !== "renderer-styles"),
      },
      tokens,
    );
    expect(result.compatible).toBe(false);
    expect(new Set(result.issues.map((issue) => issue.code))).toEqual(new Set([
      "experience-id-mismatch",
      "experience-version-mismatch",
      "missing-capability",
      "missing-slot",
      "undeclared-slot-component",
      "unsupported-component-override",
      "invalid-design-token",
    ]));
  });

  test("make search UI and facets explicit experience capabilities", () => {
    const result = negotiatePublicationSearchV1(
      project.search,
      { ...pagefind, languagePartitions: false, supportedFilters: ["space"] },
      { ...experience, capabilities: [] },
    );
    expect(result.compatible).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toContain("unsupported-search-feature");
    expect(result.issues.filter((issue) => issue.code === "missing-capability"))
      .toHaveLength(3);
    expect(() => negotiatePublicationSearchV1(
      project.search,
      { ...pagefind, runtimeNetwork: true },
      experience,
    )).toThrow("$.runtimeNetwork: expected false");
  });

  test("reject malformed or ambiguous renderer registries", () => {
    expect(() => createPublicationRendererRegistryV1([chartRenderer, chartRenderer]))
      .toThrow(PublicationRendererRegistryErrorV1);
    expect(() => createPublicationRendererRegistryV1([{
      ...chartRenderer,
      id: "duplicate-handles",
      handles: ["chart", "chart"],
    }])).toThrow("repeats handles");
  });

  test("fail renderer negotiation for unknown, disabled, or nondeterministic islands", () => {
    const registry = createPublicationRendererRegistryV1([{
      ...chartRenderer,
      deterministic: false,
    }]);
    const result = negotiatePublicationRenderersV1(
      { ...project.renderers, allowedRendererIds: ["missing", "atlcli.chart"], allowIslands: false },
      registry,
      { ...experience, capabilities: [] },
    );
    expect(result.compatible).toBe(false);
    expect(new Set(result.issues.map((issue) => issue.code))).toEqual(new Set([
      "unknown-renderer",
      "renderer-island-disabled",
      "renderer-island-capability-mismatch",
      "renderer-nondeterministic",
    ]));
  });

  test("validate builder input, output, and identity invariants around the port", async () => {
    const request = {
      project,
      bundle,
      projectDigest: "project-sha256",
      configDigest: "config-sha256",
      lockfileDigest: "lockfile-sha256",
    } as const;
    const builder: PublicationBuilderV1 = {
      id: "astro-static",
      version: "1.0.0",
      async build() { return { manifest, outputDirectory: "/workspace/site/dist" }; },
    };
    expect(await runPublicationBuildV1(builder, request))
      .toEqual({ manifest, outputDirectory: "/workspace/site/dist" });

    await expect(runPublicationBuildV1({
      ...builder,
      async build() {
        return {
          manifest: { ...manifest, bundleDigest: "wrong" },
          outputDirectory: "/workspace/site/dist",
        };
      },
    }, request)).rejects.toThrow("requested bundle digest");
    await expect(runPublicationBuildV1({ ...builder, id: "other" }, request))
      .rejects.toBeInstanceOf(PublicationBuilderContractErrorV1);
  });

  test("plan SEO, i18n, media, privacy analytics, and public edit links together", () => {
    const qualityExperience = {
      ...experience,
      capabilities: [
        ...experience.capabilities,
        "seo",
        "i18n",
        "analytics-slot",
        "edit-link",
      ],
    } as const;
    const qualityProject = {
      ...project,
      visibility: "public",
      seo: { ...project.seo, robots: "index" },
      builder: { ...project.builder, site: "https://docs.example.com/" },
      analytics: {
        provider: "plausible",
        endpoint: "https://analytics.example.com/api/event",
        siteDomain: "docs.example.com",
        pageviews: true,
        events: ["outbound-link", "download"],
        respectDoNotTrack: true,
        searchTerms: false,
      },
      editLink: {
        provider: "confluence",
        label: "Edit in Confluence",
        placement: "page-actions",
        visibility: "all",
        fallback: "open-page",
        publicTenantDisclosureAcknowledged: true,
      },
    } as const;
    const result = planPublicationWebQualityV1(qualityProject, qualityExperience);
    expect(result.compatible).toBe(true);
    expect(result.canonicalSite).toBe("https://docs.example.com");
    expect(result.requiredExperienceCapabilities).toEqual([
      "seo", "i18n", "analytics-slot", "edit-link",
    ]);
  });

  test("reject unsafe or contradictory web-quality configuration", () => {
    const result = planPublicationWebQualityV1({
      ...project,
      seo: { ...project.seo, robots: "index", feed: "rss" },
      i18n: {
        ...project.i18n,
        defaultLocale: "fr",
        locales: ["en", "de", "de"],
        fallback: { en: "de", de: "en" },
      },
      media: { ...project.media, formats: ["webp", "webp"] },
      analytics: {
        provider: "plausible",
        endpoint: "http://user:pass@analytics.example.com/event?secret=yes",
        siteDomain: "https://docs.example.com/path",
        pageviews: true,
        events: ["search-open"],
        respectDoNotTrack: true,
        searchTerms: false,
      },
    }, { ...experience, capabilities: [] });
    expect(result.compatible).toBe(false);
    expect(new Set(result.issues.map((entry) => entry.code))).toEqual(new Set([
      "site-required",
      "internal-indexing",
      "feed-requires-public",
      "locale-set-invalid",
      "locale-fallback-invalid",
      "media-profile-mismatch",
      "analytics-endpoint-invalid",
      "analytics-domain-invalid",
      "experience-capability-required",
    ]));
  });

  test("require an explicit tenant disclosure before public Confluence edit links", () => {
    const result = planPublicationWebQualityV1({
      ...project,
      visibility: "public",
      builder: { ...project.builder, site: "https://docs.example.com" },
      editLink: {
        provider: "confluence",
        label: "Edit in Confluence",
        placement: "page-footer",
        visibility: "all",
        fallback: "omit",
      },
    }, { ...experience, capabilities: [...experience.capabilities, "seo", "i18n", "edit-link"] });
    expect(result.issues.map((entry) => entry.code))
      .toContain("public-edit-link-disclosure-required");
  });
});
