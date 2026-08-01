import type { ExportBlock, ExportNote } from "@atlcli/export-blocks";

export const PUBLICATION_PROJECT_SCHEMA_V1 = "atlcli.publication-project/1" as const;
export const PUBLISH_RUN_REQUEST_SCHEMA_V1 = "atlcli.publish-run-request/1" as const;
export const PUBLICATION_REFRESH_PLAN_SCHEMA_V1 = "atlcli.publication-refresh-plan/1" as const;
export const PUBLICATION_BUNDLE_SCHEMA_V1 = "atlcli.publication-bundle/1" as const;
export const PUBLICATION_PAGE_SCHEMA_V1 = "atlcli.publication-page/1" as const;
export const PUBLICATION_EXPERIENCE_SCHEMA_V1 = "atlcli.publication-experience/1" as const;
export const PUBLICATION_SEARCH_PROVIDER_SCHEMA_V1 =
  "atlcli.publication-search-provider/1" as const;
export const STATIC_PUBLICATION_MANIFEST_SCHEMA_V1 =
  "atlcli.static-publication-manifest/1" as const;

/** Publication planning diagnostics; distinct from Confluence ExportNote codes. */
export const PUBLICATION_ISSUE_CODES_V1 = {
  PARTIAL_SOURCE: "partial-source",
  INACCESSIBLE_SOURCE: "inaccessible-source",
  CONFIRMED_DELETE: "confirmed-delete",
  EXCLUDED_SOURCE: "excluded-source",
  OUT_OF_SCOPE_SOURCE: "out-of-scope-source",
} as const;

export type PublicationScopeV1 =
  | { kind: "page"; pageId: string }
  | { kind: "tree"; rootPageId: string }
  | { kind: "space"; spaceKey: string };

export interface PublicationSourcePolicyV1 {
  representation: "adf-primary" | "storage-primary";
  includeLabels: readonly string[];
  excludeLabels: readonly string[];
  excludeMode: "prune-subtree" | "page-only";
  maxDepth?: number;
  maxPages: number;
  maxFolders: number;
}

export interface PublicationRouteOverrideV1 {
  sourceId: string;
  route: string;
}

export interface PublicationRoutePolicyV1 {
  prefix: string;
  generatedStyle: "stable-pretty";
  collisions: "stable-source-suffix";
  tombstones: "retain";
  customRoutes: readonly PublicationRouteOverrideV1[];
}

export interface PublicationMacroPolicyV1 {
  mode: "static-only" | "allow-frozen-live";
  unknown: "visible-fallback";
  liveFreshnessSeconds?: number;
  maxRows: number;
  maxNodes: number;
  maxBytes: number;
}

export interface PublicationAssetPolicyV1 {
  selfContained: true;
  external: "same-origin-only" | "allowlist";
  allowedOrigins: readonly string[];
  activeContent: "block";
  maxAssetBytes: number;
  maxTotalBytes: number;
  maxImagePixels: number;
  maxSvgNodes: number;
}

export interface PublicationRendererPolicyV1 {
  allowedRendererIds: readonly string[];
  allowIslands: boolean;
  maxIslandBytes: number;
  maxChartRows: number;
  maxChartSeries: number;
}

export type PublicationDesignTokenValueV1 = string | number | boolean;

export interface PublicationExperienceSelectionV1 {
  id: string;
  expectedVersion?: string;
  requiredCapabilities: readonly PublicationExperienceCapabilityV1[];
  designTokens: Readonly<Record<string, PublicationDesignTokenValueV1>>;
  componentOverrides: Readonly<
    Partial<Record<PublicationComponentOverrideV1, string>>
  >;
}

export interface PublicationRetentionPolicyV1 {
  bundles: number;
  builds: number;
  graceSeconds: number;
}

export interface PublicationProjectV1 {
  schema: typeof PUBLICATION_PROJECT_SCHEMA_V1;
  publicationKey: string;
  source: PublicationScopeV1;
  sourcePolicy: PublicationSourcePolicyV1;
  completeness: "strict" | "allow-partial";
  visibility: "internal" | "public";
  routes: PublicationRoutePolicyV1;
  macros: PublicationMacroPolicyV1;
  assets: PublicationAssetPolicyV1;
  renderers: PublicationRendererPolicyV1;
  experience: PublicationExperienceSelectionV1;
  search: PublicationSearchOptionsV1;
  seo: PublicationSeoOptionsV1;
  i18n: PublicationI18nOptionsV1;
  media: PublicationMediaOptionsV1;
  analytics: PublicationAnalyticsOptionsV1;
  editLink: PublicationEditLinkOptionsV1;
  builder: AstroPublicationBuilderOptionsV1;
  retention: PublicationRetentionPolicyV1;
  activeBundleDigest?: string;
}

export interface PublishRunRequestV1 {
  schema: typeof PUBLISH_RUN_REQUEST_SCHEMA_V1;
  projectRef: string;
  operation: "plan" | "refresh" | "build" | "verify" | "run";
  expectedActiveBundleDigest?: string;
  dryRun: boolean;
}

export interface PublicationIssueSourceV1 {
  sourceId?: string;
  assetId?: string;
  route?: string;
  path?: string;
}

export type PublicationIssueCodeV1 =
  | "partial-source"
  | "inaccessible-source"
  | "confirmed-delete"
  | "excluded-source"
  | "out-of-scope-source"
  | "route-collision"
  | "output-path-collision"
  | "unsafe-route"
  | "ambiguous-link"
  | "outside-scope-link"
  | "unsafe-link"
  | "dangling-reference"
  | "blocked-asset"
  | "invalid-bundle"
  | "capability-mismatch"
  | "other";

export interface PublicationIssueV1 {
  level: "info" | "warning" | "error";
  code: PublicationIssueCodeV1;
  message: string;
  source?: PublicationIssueSourceV1;
}

export interface PublicationSourcePageSnapshotV1 {
  sourceId: string;
  sourceVersion: string;
  representation: "atlas_doc_format" | "storage";
  parentId?: string;
  position: number;
  depth: number;
  title: string;
  contentDigest: string;
  metadataDigest: string;
  assetMetadataDigest: string;
  /** Digest of current frozen live-macro dependency metadata, or no-live sentinel. */
  macroDependencyDigest: string;
  state: "included" | "excluded" | "inaccessible" | "out-of-scope" | "deleted";
}

export interface PublicationSourceSnapshotV1 {
  sourceDigest: string;
  complete: boolean;
  deletionAuthority: "complete-scan" | "none";
  rootIds: readonly string[];
  pages: readonly PublicationSourcePageSnapshotV1[];
}

export type PublicationChangeKindV1 =
  | "add"
  | "content-change"
  | "metadata-change"
  | "move"
  | "route-change"
  | "asset-change"
  | "live-dependency-change"
  | "exclude"
  | "out-of-scope"
  | "inaccessible"
  | "confirmed-delete";

export interface PublicationChangeV1 {
  kind: PublicationChangeKindV1;
  sourceId: string;
  previousDigest?: string;
  nextDigest?: string;
  previousRoute?: string;
  nextRoute?: string;
}

export interface PublicationRefreshPlanV1 {
  schema: typeof PUBLICATION_REFRESH_PLAN_SCHEMA_V1;
  previousBundleDigest?: string;
  sourceSnapshot: PublicationSourceSnapshotV1;
  changes: readonly PublicationChangeV1[];
  complete: boolean;
  issues: readonly PublicationIssueV1[];
  planDigest: string;
}

export interface PublicationRouteRecordV1 {
  sourceId: string;
  route: string;
  state: "active" | "tombstone";
  assignedBy: "generated" | "operator";
  previousRoutes: readonly string[];
}

export type PublicationLinkReferenceV1 =
  | {
      referenceId: string;
      kind: "page";
      sourceId: string;
      anchorId?: string;
    }
  | {
      referenceId: string;
      kind: "asset";
      assetId: string;
    }
  | {
      referenceId: string;
      kind: "external";
      href: string;
    }
  | {
      referenceId: string;
      kind: "unresolved";
      reason: "ambiguous" | "outside-scope" | "unsafe" | "missing";
      label: string;
    };

export type ResolvedPublicationLinkV1 =
  | { kind: "page"; sourceId: string; route: string; anchorId?: string }
  | { kind: "asset"; assetId: string; path: string }
  | { kind: "external"; href: string }
  | { kind: "unresolved"; label: string };

/**
 * One safe, page-local HTML fragment identity. `sourceAnchor` preserves the
 * normalized source-side lookup key when an authored bookmark supplied one;
 * builders use only `anchorId` and never need to know the source format.
 */
export interface PublicationAnchorV1 {
  anchorId: string;
  sourceAnchor?: string;
  kind: "heading" | "bookmark";
  level?: 1 | 2 | 3 | 4 | 5 | 6;
  text?: string;
}

/** A resolved reference retains its owner and source-local identity. */
export interface ResolvedPublicationLinkReferenceV1 {
  referenceId: string;
  target: ResolvedPublicationLinkV1;
}

export interface PublicationAssetReferenceV1 {
  kind: "asset";
  assetId: string;
}

export interface ResolvedPublicationAssetV1 {
  assetId: string;
  path: string;
  mediaType: string;
  byteLength: number;
  sha256: string;
  disposition: PublicationAssetEntryV1["disposition"];
}

export interface ResolvedHeadingV1 {
  anchorId: string;
  level: 1 | 2 | 3 | 4 | 5 | 6;
  text: string;
}

/**
 * Builder-neutral reference material for one source page. Routes and asset
 * paths remain logical bundle paths: the Astro integration applies `base` and
 * its selected output URL profile only while it writes HTML.
 */
export interface PublicationPageReferencesV1 {
  sourceId: string;
  route: string;
  anchors: readonly PublicationAnchorV1[];
  links: readonly ResolvedPublicationLinkReferenceV1[];
  assets: readonly ResolvedPublicationAssetV1[];
}

export interface PublicationReferencePlanV1 {
  pages: readonly PublicationPageReferencesV1[];
}

export interface PublicationDependencyV1 {
  kind: "source-page" | "asset" | "macro-data" | "navigation" | "link-graph";
  key: string;
  version: string;
  digest: string;
  live: boolean;
}

export interface PublicationPageV1 {
  schema: typeof PUBLICATION_PAGE_SCHEMA_V1;
  sourceId: string;
  sourceVersion: string;
  title: string;
  parentId?: string;
  position: number;
  depth: number;
  route: string;
  blocks: readonly ExportBlock[];
  notes: readonly ExportNote[];
  labels: readonly string[];
  links: readonly PublicationLinkReferenceV1[];
  assetIds: readonly string[];
  renderDependencies: readonly PublicationDependencyV1[];
  pageDigest: string;
}

export interface PublicationPageEntryV1 {
  sourceId: string;
  path: string;
  pageDigest: string;
}

export interface PublicationAssetEntryV1 {
  assetId: string;
  path: string;
  sha256: string;
  byteLength: number;
  mediaType: string;
  disposition: "inline" | "download" | "blocked-active-content";
}

export interface PublicationBundleV1 {
  schema: typeof PUBLICATION_BUNDLE_SCHEMA_V1;
  bundleDigest: string;
  createdBy: { name: "atlcli"; version: string };
  sourceSnapshot: PublicationSourceSnapshotV1;
  sourcePolicyDigest: string;
  complete: boolean;
  rootIds: readonly string[];
  pages: readonly PublicationPageEntryV1[];
  routes: readonly PublicationRouteRecordV1[];
  assets: readonly PublicationAssetEntryV1[];
  issues: readonly PublicationIssueV1[];
}

export type PublicationRenderableKindV1 =
  | ExportBlock["type"]
  | "chart"
  | "diagram"
  | "jira-table"
  | "table-of-contents"
  | "unknown-macro";

export interface PublicationRendererDescriptorV1 {
  id: string;
  version: string;
  handles: readonly PublicationRenderableKindV1[];
  capability: "static" | "island";
  dataSchema: string;
  deterministic: boolean;
  externalRuntimeData: false;
}

export type PublicationExperienceCapabilityV1 =
  | "responsive-navigation"
  | "light-dark-system"
  | "search-modal"
  | "search-page"
  | "faceted-search"
  | "table-of-contents"
  | "breadcrumbs"
  | "previous-next"
  | "chart-islands"
  | "i18n"
  | "print-styles"
  | "seo"
  | "analytics-slot"
  | "edit-link";

export type PublicationExperienceSlotV1 =
  | "document-head"
  | "header"
  | "primary-navigation"
  | "left-navigation"
  | "breadcrumbs"
  | "search-trigger"
  | "search-modal"
  | "main-content"
  | "page-toc"
  | "previous-next"
  | "footer"
  | "renderer-styles";

export type PublicationComponentOverrideV1 =
  | "page-shell"
  | "navigation"
  | "breadcrumbs"
  | "search"
  | "page-toc"
  | "previous-next"
  | "footer"
  | "edit-link"
  | "analytics";

export interface PublicationExperienceComponentsV1 {
  slots: Readonly<Partial<Record<PublicationExperienceSlotV1, string>>>;
  overrides: Readonly<Partial<Record<PublicationComponentOverrideV1, string>>>;
  blockOverrides: Readonly<Partial<Record<PublicationRenderableKindV1, string>>>;
}

export interface PublicationExperienceDescriptorV1 {
  schema: typeof PUBLICATION_EXPERIENCE_SCHEMA_V1;
  id: string;
  version: string;
  engine: "astro";
  capabilities: readonly PublicationExperienceCapabilityV1[];
  slots: readonly PublicationExperienceSlotV1[];
  designTokensSchema: string;
  components: PublicationExperienceComponentsV1;
}

export interface PublicationSearchRankingV1 {
  title: number;
  headings: number;
  labels: number;
  body: number;
}

export interface PublicationSearchOptionsV1 {
  provider: "pagefind";
  enabled: true;
  languages: "from-pages" | readonly string[];
  filters: readonly ("space" | "label" | "content-type" | "language")[];
  metadata: readonly ("title" | "description" | "breadcrumbs" | "image")[];
  ranking: PublicationSearchRankingV1;
  ui: "modal" | "page" | "both";
  shortcut: "mod+k" | "/" | "none";
}

export interface PublicationSearchProviderDescriptorV1 {
  schema: typeof PUBLICATION_SEARCH_PROVIDER_SCHEMA_V1;
  id: "pagefind";
  version: string;
  execution: "static-post-build";
  runtimeNetwork: false;
  languagePartitions: boolean;
  supportedFilters: readonly PublicationSearchOptionsV1["filters"][number][];
  supportedMetadata: readonly PublicationSearchOptionsV1["metadata"][number][];
  supportedUi: readonly PublicationSearchOptionsV1["ui"][];
  supportedShortcuts: readonly PublicationSearchOptionsV1["shortcut"][];
}

export interface PublicationSeoOptionsV1 {
  sitemap: true;
  robots: "index" | "noindex";
  canonical: true;
  structuredData: readonly ("WebSite" | "TechArticle" | "BreadcrumbList")[];
  socialCards: "metadata-only" | "generated";
  feed: "disabled" | "rss" | "atom";
}

export interface PublicationI18nOptionsV1 {
  defaultLocale: string;
  locales: readonly string[];
  routeMode: "prefix-all" | "hide-default";
  fallback: Readonly<Record<string, string>>;
  uiTranslations: "starlight" | Readonly<Record<string, string>>;
}

export interface PublicationMediaOptionsV1 {
  images: "verified-original" | "astro-responsive";
  formats: readonly ("original" | "avif" | "webp")[];
  fonts: "system" | "vendored-local";
  imageZoom: boolean;
  code: "expressive-code";
}

export type PublicationAnalyticsOptionsV1 =
  | { provider: "none" }
  | {
      provider: "plausible";
      endpoint: string;
      siteDomain: string;
      pageviews: true;
      events: readonly ("outbound-link" | "download" | "search-open")[];
      respectDoNotTrack: true;
      searchTerms: false;
    };

export type PublicationEditLinkOptionsV1 =
  | { provider: "none" }
  | {
      provider: "confluence";
      label: string;
      placement: "page-footer" | "page-actions";
      visibility: "internal" | "all";
      fallback: "open-page" | "omit";
      publicTenantDisclosureAcknowledged?: true;
    };

export interface AstroAtlcliIntegrationOptionsV1 {
  bundlePath: string;
  routePrefix: string;
  experienceId: string;
  trustedLayoutEntrypoint?: string;
}

/** Builder-neutral static URL/file profile applied after route planning. */
export type PublicationOutputProfileV1 = "directory" | "portable-file";

export interface AstroPublicationBuilderOptionsV1 {
  builder: "astro-static";
  projectDir: string;
  integrationOptions: AstroAtlcliIntegrationOptionsV1;
  outputProfile: PublicationOutputProfileV1;
  base: string;
  site?: string;
  buildCommand: readonly [string, ...string[]];
}

export interface PublicationBuildRequestV1 {
  project: PublicationProjectV1;
  bundle: PublicationBundleV1;
  projectDigest: string;
  configDigest: string;
  lockfileDigest: string;
}

export interface PublicationBuildResultV1 {
  manifest: StaticPublicationManifestV1;
  outputDirectory: string;
}

export interface PublicationBuilderV1 {
  readonly id: string;
  readonly version: string;
  build(request: PublicationBuildRequestV1): Promise<PublicationBuildResultV1>;
}

export interface BuiltPageV1 {
  sourceId: string;
  route: string;
  outputPath: string;
  sha256: string;
  byteLength: number;
}

export interface BuiltAssetV1 {
  assetId: string;
  outputPath: string;
  sha256: string;
  byteLength: number;
  mediaType: string;
}

export interface BuiltSearchIndexV1 {
  provider: "pagefind";
  digest: string;
  files: readonly { path: string; sha256: string; byteLength: number }[];
  languages: readonly string[];
  indexedSourceIds: readonly string[];
}

export interface BuiltSeoArtifactsV1 {
  sitemapPath?: string;
  robotsPath?: string;
  feedPath?: string;
  digest: string;
}

export type BuiltAnalyticsDeclarationV1 =
  | { provider: "none" }
  | { provider: "plausible"; endpointOrigin: string; events: readonly string[] };

export interface BuiltEditLinkSummaryV1 {
  provider: "none" | "confluence";
  includedSourceIds: readonly string[];
  omittedSourceIds: readonly string[];
}

export interface PublicationVerificationSummaryV1 {
  valid: boolean;
  checkedPages: number;
  checkedAssets: number;
  issues: readonly PublicationIssueV1[];
}

export interface StaticPublicationManifestV1 {
  schema: typeof STATIC_PUBLICATION_MANIFEST_SCHEMA_V1;
  bundleDigest: string;
  builder: { id: "astro-static"; version: string; astroVersion: string };
  projectDigest: string;
  configDigest: string;
  lockfileDigest: string;
  base: string;
  outputProfile: PublicationOutputProfileV1;
  pages: readonly BuiltPageV1[];
  assets: readonly BuiltAssetV1[];
  experience: { id: string; version: string; digest: string };
  search: BuiltSearchIndexV1;
  seo: BuiltSeoArtifactsV1;
  analytics: BuiltAnalyticsDeclarationV1;
  editLinks: BuiltEditLinkSummaryV1;
  removedOwnedPaths: readonly string[];
  verification: PublicationVerificationSummaryV1;
  buildDigest: string;
}
