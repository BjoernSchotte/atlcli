import { describe, expect, test } from "bun:test";
import {
  PUBLICATION_EXPERIENCE_SCHEMA_V1,
  PUBLICATION_PROJECT_SCHEMA_V1,
  PUBLICATION_SEARCH_PROVIDER_SCHEMA_V1,
  PublicationRendererRegistryErrorV1,
  createPublicationRendererRegistryV1,
  negotiatePublicationExperienceV1,
  negotiatePublicationRenderersV1,
  negotiatePublicationSearchV1,
  type PublicationExperienceDescriptorV1,
  type PublicationProjectV1,
  type PublicationSearchProviderDescriptorV1,
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
});
