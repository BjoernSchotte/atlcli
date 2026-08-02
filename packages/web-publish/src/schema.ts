import {
  CHART_DIAGNOSTIC_CODES_V1,
  EXPORT_BLOCK_MODEL_SCHEMA_V1,
  parseExportBlockDocumentV1,
} from "@atlcli/export-blocks";
import { normalizePublicationLocaleV1 } from "./i18n.js";
import {
  PUBLICATION_BUNDLE_SCHEMA_V1,
  PUBLICATION_EXPERIENCE_SCHEMA_V1,
  PUBLICATION_PAGE_SCHEMA_V1,
  PUBLICATION_PROJECT_SCHEMA_V1,
  PUBLICATION_REFRESH_PLAN_SCHEMA_V1,
  PUBLICATION_SEARCH_PROVIDER_SCHEMA_V1,
  PUBLISH_RUN_REQUEST_SCHEMA_V1,
  STATIC_PUBLICATION_MANIFEST_SCHEMA_V1,
  type PublicationBundleV1,
  type PublicationBuildRequestV1,
  type PublicationBuildResultV1,
  type PublicationComponentOverrideV1,
  type PublicationExperienceCapabilityV1,
  type PublicationExperienceDescriptorV1,
  type PublicationExperienceSlotV1,
  type PublicationIssueCodeV1,
  type PublicationPageV1,
  type PublicationProjectV1,
  type PublicationRefreshPlanV1,
  type PublicationRenderableKindV1,
  type PublicationRendererDescriptorV1,
  type PublicationSearchProviderDescriptorV1,
  type PublishRunRequestV1,
  type StaticPublicationManifestV1,
} from "./contracts.js";
import {
  PublicationRoutePlanningErrorV1,
  normalizePublicationRouteForPrefixV1,
  normalizePublicationRoutePrefixV1,
  validatePublicationOutputPathV1,
} from "./routes.js";

export interface PublicationValidationBudgetV1 {
  maxDepth: number;
  maxNodes: number;
  maxStringBytes: number;
  maxArrayLength: number;
}

export const DEFAULT_PUBLICATION_VALIDATION_BUDGET_V1:
Readonly<PublicationValidationBudgetV1> = Object.freeze({
  maxDepth: 128,
  maxNodes: 500_000,
  maxStringBytes: 16 * 1024 * 1024,
  maxArrayLength: 250_000,
});

export class PublicationValidationErrorV1 extends Error {
  constructor(
    public readonly path: string,
    message: string,
  ) {
    super(`${path}: ${message}`);
    this.name = "PublicationValidationErrorV1";
  }
}

type JsonRecord = Record<string, unknown>;
type Validator = (value: unknown, path: string) => void;

const EXPERIENCE_CAPABILITIES = [
  "responsive-navigation",
  "light-dark-system",
  "search-modal",
  "search-page",
  "faceted-search",
  "table-of-contents",
  "breadcrumbs",
  "previous-next",
  "chart-islands",
  "i18n",
  "print-styles",
  "seo",
  "analytics-slot",
  "edit-link",
] as const satisfies readonly PublicationExperienceCapabilityV1[];

const EXPERIENCE_SLOTS = [
  "document-head",
  "header",
  "primary-navigation",
  "left-navigation",
  "breadcrumbs",
  "search-trigger",
  "search-modal",
  "main-content",
  "page-toc",
  "previous-next",
  "footer",
  "renderer-styles",
] as const satisfies readonly PublicationExperienceSlotV1[];

const RENDERABLE_KINDS = [
  "heading",
  "paragraph",
  "smartCard",
  "codeBlock",
  "callout",
  "expand",
  "list",
  "layout",
  "table",
  "image",
  "mediaFallback",
  "blockquote",
  "divider",
  "pageBreak",
  "orientation",
  "anchor",
  "unknown",
  "chart",
  "diagram",
  "jira-table",
  "table-of-contents",
  "unknown-macro",
] as const satisfies readonly PublicationRenderableKindV1[];

const ISSUE_CODES = [
  "partial-source",
  "inaccessible-source",
  "confirmed-delete",
  "excluded-source",
  "out-of-scope-source",
  "route-collision",
  "output-path-collision",
  "unsafe-route",
  "ambiguous-link",
  "outside-scope-link",
  "unsafe-link",
  "dangling-reference",
  "blocked-asset",
  "invalid-bundle",
  "capability-mismatch",
  "chart-p0-diagnostic",
  "chart-diagnostic",
  "other",
] as const satisfies readonly PublicationIssueCodeV1[];

const COMPONENT_OVERRIDES = [
  "page-shell", "navigation", "breadcrumbs", "search", "page-toc", "previous-next",
  "footer", "edit-link", "analytics",
] as const satisfies readonly PublicationComponentOverrideV1[];

type AssertNever<T extends never> = T;
type ExperienceCapabilityCoverage = AssertNever<
  Exclude<PublicationExperienceCapabilityV1, (typeof EXPERIENCE_CAPABILITIES)[number]>
>;
type ExperienceSlotCoverage = AssertNever<
  Exclude<PublicationExperienceSlotV1, (typeof EXPERIENCE_SLOTS)[number]>
>;
type RenderableKindCoverage = AssertNever<
  Exclude<PublicationRenderableKindV1, (typeof RENDERABLE_KINDS)[number]>
>;
type IssueCodeCoverage = AssertNever<
  Exclude<PublicationIssueCodeV1, (typeof ISSUE_CODES)[number]>
>;
type ComponentOverrideCoverage = AssertNever<
  Exclude<PublicationComponentOverrideV1, (typeof COMPONENT_OVERRIDES)[number]>
>;

function fail(path: string, message: string): never {
  throw new PublicationValidationErrorV1(path, message);
}

function object(value: unknown, path: string): JsonRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return fail(path, "expected an object");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return fail(path, "expected a plain object");
  }
  return value as JsonRecord;
}

function array(value: unknown, path: string): readonly unknown[] {
  if (!Array.isArray(value)) return fail(path, "expected an array");
  return value;
}

function string(value: unknown, path: string): string {
  if (typeof value !== "string") return fail(path, "expected a string");
  return value;
}

function nonEmptyString(value: unknown, path: string): string {
  const candidate = string(value, path);
  if (candidate.length === 0) return fail(path, "expected a non-empty string");
  return candidate;
}

function boolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") return fail(path, "expected a boolean");
  return value;
}

function finiteNumber(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fail(path, "expected a finite number");
  }
  return value;
}

function nonNegativeNumber(value: unknown, path: string): number {
  const candidate = finiteNumber(value, path);
  if (candidate < 0) return fail(path, "expected a non-negative number");
  return candidate;
}

function safeInteger(value: unknown, path: string, minimum: number): number {
  const candidate = finiteNumber(value, path);
  if (!Number.isSafeInteger(candidate) || candidate < minimum) {
    return fail(path, `expected a safe integer greater than or equal to ${minimum}`);
  }
  return candidate;
}

function literal<T extends string | boolean>(
  value: unknown,
  path: string,
  expected: T,
): T {
  if (value !== expected) return fail(path, `expected ${JSON.stringify(expected)}`);
  return expected;
}

function oneOf<T extends string>(
  value: unknown,
  path: string,
  allowed: readonly T[],
): T {
  const candidate = string(value, path);
  if (!(allowed as readonly string[]).includes(candidate)) {
    return fail(path, `expected one of ${allowed.join(", ")}`);
  }
  return candidate as T;
}

function keys(value: JsonRecord, path: string, allowed: readonly string[]): void {
  const allow = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allow.has(key)) fail(`${path}.${key}`, "unknown field");
  }
}

function optional(value: JsonRecord, key: string, path: string, validate: Validator): void {
  if (value[key] !== undefined) validate(value[key], `${path}.${key}`);
}

function values(value: unknown, path: string, validate: Validator): void {
  array(value, path).forEach((entry, index) => validate(entry, `${path}[${index}]`));
}

function stringValues(value: unknown, path: string): void {
  values(value, path, nonEmptyString);
}

function enumValues<T extends string>(
  value: unknown,
  path: string,
  allowed: readonly T[],
): void {
  values(value, path, (entry, entryPath) => oneOf(entry, entryPath, allowed));
}

function stringRecord(value: unknown, path: string): void {
  for (const [key, entry] of Object.entries(object(value, path))) {
    if (key.length === 0) fail(path, "record keys must not be empty");
    nonEmptyString(entry, `${path}.${key}`);
  }
}

function scalarRecord(value: unknown, path: string): void {
  for (const [key, entry] of Object.entries(object(value, path))) {
    if (key.length === 0) fail(path, "record keys must not be empty");
    if (typeof entry === "string" || typeof entry === "boolean") continue;
    finiteNumber(entry, `${path}.${key}`);
  }
}

function partialStringRecord<T extends string>(
  value: unknown,
  path: string,
  allowedKeys: readonly T[],
): void {
  const candidate = object(value, path);
  keys(candidate, path, allowedKeys);
  for (const [key, entry] of Object.entries(candidate)) {
    nonEmptyString(entry, `${path}.${key}`);
  }
}

function safeRoute(value: unknown, path: string, canonical: boolean): string {
  const route = nonEmptyString(value, path);
  try {
    const normalized = normalizePublicationRouteForPrefixV1(route, "");
    if (canonical && normalized !== route) {
      fail(path, `expected canonical route ${JSON.stringify(normalized)}`);
    }
    return route;
  } catch (error) {
    if (error instanceof PublicationRoutePlanningErrorV1) fail(path, error.message);
    throw error;
  }
}

function safeRoutePrefix(value: unknown, path: string): string {
  const prefix = string(value, path);
  try {
    normalizePublicationRoutePrefixV1(prefix);
    return prefix;
  } catch (error) {
    if (error instanceof PublicationRoutePlanningErrorV1) fail(path, error.message);
    throw error;
  }
}

function jsonSafetyPass(value: unknown, budget: PublicationValidationBudgetV1): void {
  if (
    !Number.isSafeInteger(budget.maxDepth) || budget.maxDepth < 1 ||
    !Number.isSafeInteger(budget.maxNodes) || budget.maxNodes < 1 ||
    !Number.isSafeInteger(budget.maxStringBytes) || budget.maxStringBytes < 1 ||
    !Number.isSafeInteger(budget.maxArrayLength) || budget.maxArrayLength < 1
  ) {
    fail("$", "validation budgets must be positive safe integers");
  }

  const active = new WeakSet<object>();
  const encoder = new TextEncoder();
  let nodes = 0;
  let stringBytes = 0;

  const walk = (node: unknown, path: string, depth: number): void => {
    nodes += 1;
    if (nodes > budget.maxNodes) fail(path, "node budget exceeded");
    if (depth > budget.maxDepth) fail(path, "depth budget exceeded");
    if (typeof node === "string") {
      stringBytes += encoder.encode(node).byteLength;
      if (stringBytes > budget.maxStringBytes) fail(path, "string-byte budget exceeded");
      return;
    }
    if (node === null || typeof node === "boolean") return;
    if (typeof node === "number") {
      finiteNumber(node, path);
      return;
    }
    if (typeof node !== "object") fail(path, "expected JSON-compatible data");
    if (active.has(node)) fail(path, "cyclic value");
    active.add(node);
    if (Array.isArray(node)) {
      if (node.length > budget.maxArrayLength) fail(path, "array-length budget exceeded");
      if (Object.getOwnPropertySymbols(node).length > 0) {
        fail(path, "symbol keys are not JSON-compatible");
      }
      const arrayKeys = Object.keys(node);
      if (
        arrayKeys.length !== node.length ||
        arrayKeys.some((key, index) => key !== String(index))
      ) {
        fail(path, "expected a dense array without custom fields");
      }
      for (const key of arrayKeys) {
        const descriptor = Object.getOwnPropertyDescriptor(node, key);
        if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
          fail(`${path}[${key}]`, "expected a plain data property");
        }
      }
      node.forEach((entry, index) => walk(entry, `${path}[${index}]`, depth + 1));
    } else {
      const candidate = object(node, path);
      if (Object.getOwnPropertySymbols(candidate).length > 0) {
        fail(path, "symbol keys are not JSON-compatible");
      }
      for (const key of Object.getOwnPropertyNames(candidate)) {
        const descriptor = Object.getOwnPropertyDescriptor(candidate, key);
        if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
          fail(`${path}.${key}`, "expected a plain enumerable data property");
        }
      }
      for (const [key, entry] of Object.entries(candidate)) {
        stringBytes += encoder.encode(key).byteLength;
        if (stringBytes > budget.maxStringBytes) fail(path, "string-byte budget exceeded");
        walk(entry, `${path}.${key}`, depth + 1);
      }
    }
    active.delete(node);
  };

  walk(value, "$", 0);
}

function parse<T>(
  value: unknown,
  budget: PublicationValidationBudgetV1,
  validate: Validator,
): T {
  jsonSafetyPass(value, budget);
  validate(value, "$");
  return value as T;
}

function publicationScope(value: unknown, path: string): void {
  const candidate = object(value, path);
  const kind = oneOf(candidate.kind, `${path}.kind`, ["page", "tree", "space"]);
  if (kind === "page") {
    keys(candidate, path, ["kind", "pageId"]);
    nonEmptyString(candidate.pageId, `${path}.pageId`);
  } else if (kind === "tree") {
    keys(candidate, path, ["kind", "rootPageId"]);
    nonEmptyString(candidate.rootPageId, `${path}.rootPageId`);
  } else {
    keys(candidate, path, ["kind", "spaceKey"]);
    nonEmptyString(candidate.spaceKey, `${path}.spaceKey`);
  }
}

function sourcePolicy(value: unknown, path: string): void {
  const candidate = object(value, path);
  keys(candidate, path, [
    "representation", "includeLabels", "excludeLabels", "excludeMode", "maxDepth",
    "maxPages", "maxFolders",
  ]);
  oneOf(candidate.representation, `${path}.representation`, ["adf-primary", "storage-primary"]);
  stringValues(candidate.includeLabels, `${path}.includeLabels`);
  stringValues(candidate.excludeLabels, `${path}.excludeLabels`);
  oneOf(candidate.excludeMode, `${path}.excludeMode`, ["prune-subtree", "page-only"]);
  optional(candidate, "maxDepth", path, (entry, entryPath) => safeInteger(entry, entryPath, 0));
  safeInteger(candidate.maxPages, `${path}.maxPages`, 1);
  safeInteger(candidate.maxFolders, `${path}.maxFolders`, 1);
}

function routePolicy(value: unknown, path: string): void {
  const candidate = object(value, path);
  keys(candidate, path, ["prefix", "generatedStyle", "collisions", "tombstones", "customRoutes"]);
  const prefix = safeRoutePrefix(candidate.prefix, `${path}.prefix`);
  literal(candidate.generatedStyle, `${path}.generatedStyle`, "stable-pretty");
  literal(candidate.collisions, `${path}.collisions`, "stable-source-suffix");
  literal(candidate.tombstones, `${path}.tombstones`, "retain");
  values(candidate.customRoutes, `${path}.customRoutes`, (entry, entryPath) => {
    const override = object(entry, entryPath);
    keys(override, entryPath, ["sourceId", "route"]);
    nonEmptyString(override.sourceId, `${entryPath}.sourceId`);
    const route = safeRoute(override.route, `${entryPath}.route`, true);
    try {
      normalizePublicationRouteForPrefixV1(route, prefix);
    } catch (error) {
      if (error instanceof PublicationRoutePlanningErrorV1) {
        fail(`${entryPath}.route`, error.message);
      }
      throw error;
    }
  });
}

function macroPolicy(value: unknown, path: string): void {
  const candidate = object(value, path);
  keys(candidate, path, ["mode", "unknown", "liveFreshnessSeconds", "maxRows", "maxNodes", "maxBytes", "chartDiagnostics"]);
  oneOf(candidate.mode, `${path}.mode`, ["static-only", "allow-frozen-live"]);
  literal(candidate.unknown, `${path}.unknown`, "visible-fallback");
  optional(candidate, "liveFreshnessSeconds", path, (entry, entryPath) => safeInteger(entry, entryPath, 1));
  safeInteger(candidate.maxRows, `${path}.maxRows`, 1);
  safeInteger(candidate.maxNodes, `${path}.maxNodes`, 1);
  safeInteger(candidate.maxBytes, `${path}.maxBytes`, 1);
  optional(candidate, "chartDiagnostics", path, (entry, entryPath) => {
    const policy = object(entry, entryPath);
    keys(policy, entryPath, ["p0Codes"]);
    enumValues(policy.p0Codes, `${entryPath}.p0Codes`, CHART_DIAGNOSTIC_CODES_V1);
    if (array(policy.p0Codes, `${entryPath}.p0Codes`).length === 0) {
      fail(`${entryPath}.p0Codes`, "expected at least one diagnostic code");
    }
  });
}

function assetPolicy(value: unknown, path: string): void {
  const candidate = object(value, path);
  keys(candidate, path, [
    "selfContained", "external", "allowedOrigins", "activeContent", "maxAssetBytes",
    "maxTotalBytes", "maxImagePixels", "maxSvgNodes",
  ]);
  literal(candidate.selfContained, `${path}.selfContained`, true);
  oneOf(candidate.external, `${path}.external`, ["same-origin-only", "allowlist"]);
  stringValues(candidate.allowedOrigins, `${path}.allowedOrigins`);
  literal(candidate.activeContent, `${path}.activeContent`, "block");
  safeInteger(candidate.maxAssetBytes, `${path}.maxAssetBytes`, 1);
  safeInteger(candidate.maxTotalBytes, `${path}.maxTotalBytes`, 1);
  safeInteger(candidate.maxImagePixels, `${path}.maxImagePixels`, 1);
  safeInteger(candidate.maxSvgNodes, `${path}.maxSvgNodes`, 1);
}

function rendererPolicy(value: unknown, path: string): void {
  const candidate = object(value, path);
  keys(candidate, path, ["allowedRendererIds", "allowIslands", "maxIslandBytes", "maxChartRows", "maxChartSeries"]);
  stringValues(candidate.allowedRendererIds, `${path}.allowedRendererIds`);
  boolean(candidate.allowIslands, `${path}.allowIslands`);
  safeInteger(candidate.maxIslandBytes, `${path}.maxIslandBytes`, 1);
  safeInteger(candidate.maxChartRows, `${path}.maxChartRows`, 1);
  safeInteger(candidate.maxChartSeries, `${path}.maxChartSeries`, 1);
}

function experienceSelection(value: unknown, path: string): void {
  const candidate = object(value, path);
  keys(candidate, path, ["id", "expectedVersion", "requiredCapabilities", "designTokens", "componentOverrides"]);
  nonEmptyString(candidate.id, `${path}.id`);
  optional(candidate, "expectedVersion", path, nonEmptyString);
  enumValues(candidate.requiredCapabilities, `${path}.requiredCapabilities`, EXPERIENCE_CAPABILITIES);
  scalarRecord(candidate.designTokens, `${path}.designTokens`);
  partialStringRecord(candidate.componentOverrides, `${path}.componentOverrides`, COMPONENT_OVERRIDES);
}

function searchOptions(value: unknown, path: string): void {
  const candidate = object(value, path);
  keys(candidate, path, ["provider", "enabled", "languages", "filters", "metadata", "ranking", "ui", "shortcut"]);
  literal(candidate.provider, `${path}.provider`, "pagefind");
  literal(candidate.enabled, `${path}.enabled`, true);
  if (candidate.languages === "from-pages") {
    literal(candidate.languages, `${path}.languages`, "from-pages");
  } else {
    stringValues(candidate.languages, `${path}.languages`);
  }
  enumValues(candidate.filters, `${path}.filters`, ["space", "label", "content-type", "language"]);
  enumValues(candidate.metadata, `${path}.metadata`, ["title", "description", "breadcrumbs", "image"]);
  const ranking = object(candidate.ranking, `${path}.ranking`);
  keys(ranking, `${path}.ranking`, ["title", "headings", "labels", "body"]);
  nonNegativeNumber(ranking.title, `${path}.ranking.title`);
  nonNegativeNumber(ranking.headings, `${path}.ranking.headings`);
  nonNegativeNumber(ranking.labels, `${path}.ranking.labels`);
  nonNegativeNumber(ranking.body, `${path}.ranking.body`);
  oneOf(candidate.ui, `${path}.ui`, ["modal", "page", "both"]);
  oneOf(candidate.shortcut, `${path}.shortcut`, ["mod+k", "/", "none"]);
}

function seoOptions(value: unknown, path: string): void {
  const candidate = object(value, path);
  keys(candidate, path, ["sitemap", "robots", "canonical", "structuredData", "socialCards", "feed"]);
  literal(candidate.sitemap, `${path}.sitemap`, true);
  oneOf(candidate.robots, `${path}.robots`, ["index", "noindex"]);
  literal(candidate.canonical, `${path}.canonical`, true);
  enumValues(candidate.structuredData, `${path}.structuredData`, ["WebSite", "TechArticle", "BreadcrumbList"]);
  oneOf(candidate.socialCards, `${path}.socialCards`, ["metadata-only", "generated"]);
  oneOf(candidate.feed, `${path}.feed`, ["disabled", "rss", "atom"]);
}

function i18nOptions(value: unknown, path: string): void {
  const candidate = object(value, path);
  keys(candidate, path, ["defaultLocale", "locales", "routeMode", "fallback", "uiTranslations"]);
  nonEmptyString(candidate.defaultLocale, `${path}.defaultLocale`);
  stringValues(candidate.locales, `${path}.locales`);
  oneOf(candidate.routeMode, `${path}.routeMode`, ["prefix-all", "hide-default"]);
  stringRecord(candidate.fallback, `${path}.fallback`);
  if (candidate.uiTranslations === "starlight") {
    literal(candidate.uiTranslations, `${path}.uiTranslations`, "starlight");
  } else {
    stringRecord(candidate.uiTranslations, `${path}.uiTranslations`);
  }
}

function mediaOptions(value: unknown, path: string): void {
  const candidate = object(value, path);
  keys(candidate, path, ["images", "formats", "fonts", "imageZoom", "code"]);
  oneOf(candidate.images, `${path}.images`, ["verified-original", "astro-responsive"]);
  enumValues(candidate.formats, `${path}.formats`, ["original", "avif", "webp"]);
  oneOf(candidate.fonts, `${path}.fonts`, ["system", "vendored-local"]);
  boolean(candidate.imageZoom, `${path}.imageZoom`);
  literal(candidate.code, `${path}.code`, "expressive-code");
}

function analyticsOptions(value: unknown, path: string): void {
  const candidate = object(value, path);
  const provider = oneOf(candidate.provider, `${path}.provider`, ["none", "plausible"]);
  if (provider === "none") {
    keys(candidate, path, ["provider"]);
    return;
  }
  keys(candidate, path, ["provider", "endpoint", "siteDomain", "pageviews", "events", "respectDoNotTrack", "searchTerms"]);
  nonEmptyString(candidate.endpoint, `${path}.endpoint`);
  nonEmptyString(candidate.siteDomain, `${path}.siteDomain`);
  literal(candidate.pageviews, `${path}.pageviews`, true);
  enumValues(candidate.events, `${path}.events`, ["outbound-link", "download", "search-open"]);
  literal(candidate.respectDoNotTrack, `${path}.respectDoNotTrack`, true);
  literal(candidate.searchTerms, `${path}.searchTerms`, false);
}

function editLinkOptions(value: unknown, path: string): void {
  const candidate = object(value, path);
  const provider = oneOf(candidate.provider, `${path}.provider`, ["none", "confluence"]);
  if (provider === "none") {
    keys(candidate, path, ["provider"]);
    return;
  }
  keys(candidate, path, [
    "provider", "label", "placement", "visibility", "fallback",
    "publicTenantDisclosureAcknowledged",
  ]);
  nonEmptyString(candidate.label, `${path}.label`);
  oneOf(candidate.placement, `${path}.placement`, ["page-footer", "page-actions"]);
  oneOf(candidate.visibility, `${path}.visibility`, ["internal", "all"]);
  oneOf(candidate.fallback, `${path}.fallback`, ["open-page", "omit"]);
  optional(candidate, "publicTenantDisclosureAcknowledged", path, (entry, entryPath) => literal(entry, entryPath, true));
}

function builderOptions(value: unknown, path: string): void {
  const candidate = object(value, path);
  keys(candidate, path, ["builder", "projectDir", "integrationOptions", "outputProfile", "base", "site", "buildCommand"]);
  literal(candidate.builder, `${path}.builder`, "astro-static");
  nonEmptyString(candidate.projectDir, `${path}.projectDir`);
  const integration = object(candidate.integrationOptions, `${path}.integrationOptions`);
  keys(integration, `${path}.integrationOptions`, ["bundlePath", "routePrefix", "experienceId", "trustedLayoutEntrypoint"]);
  nonEmptyString(integration.bundlePath, `${path}.integrationOptions.bundlePath`);
  string(integration.routePrefix, `${path}.integrationOptions.routePrefix`);
  nonEmptyString(integration.experienceId, `${path}.integrationOptions.experienceId`);
  optional(integration, "trustedLayoutEntrypoint", `${path}.integrationOptions`, nonEmptyString);
  oneOf(candidate.outputProfile, `${path}.outputProfile`, ["directory", "portable-file"]);
  nonEmptyString(candidate.base, `${path}.base`);
  optional(candidate, "site", path, nonEmptyString);
  const command = array(candidate.buildCommand, `${path}.buildCommand`);
  if (command.length === 0) fail(`${path}.buildCommand`, "expected a non-empty command tuple");
  command.forEach((entry, index) => nonEmptyString(entry, `${path}.buildCommand[${index}]`));
}

function retentionPolicy(value: unknown, path: string): void {
  const candidate = object(value, path);
  keys(candidate, path, ["bundles", "builds", "graceSeconds"]);
  safeInteger(candidate.bundles, `${path}.bundles`, 1);
  safeInteger(candidate.builds, `${path}.builds`, 1);
  safeInteger(candidate.graceSeconds, `${path}.graceSeconds`, 0);
}

function publicationProject(value: unknown, path: string): void {
  const candidate = object(value, path);
  keys(candidate, path, [
    "schema", "publicationKey", "source", "sourcePolicy", "completeness", "visibility",
    "routes", "macros", "assets", "renderers", "experience", "search", "seo", "i18n",
    "media", "analytics", "editLink", "builder", "retention", "activeBundleDigest",
  ]);
  literal(candidate.schema, `${path}.schema`, PUBLICATION_PROJECT_SCHEMA_V1);
  nonEmptyString(candidate.publicationKey, `${path}.publicationKey`);
  publicationScope(candidate.source, `${path}.source`);
  sourcePolicy(candidate.sourcePolicy, `${path}.sourcePolicy`);
  oneOf(candidate.completeness, `${path}.completeness`, ["strict", "allow-partial"]);
  oneOf(candidate.visibility, `${path}.visibility`, ["internal", "public"]);
  routePolicy(candidate.routes, `${path}.routes`);
  macroPolicy(candidate.macros, `${path}.macros`);
  assetPolicy(candidate.assets, `${path}.assets`);
  rendererPolicy(candidate.renderers, `${path}.renderers`);
  experienceSelection(candidate.experience, `${path}.experience`);
  searchOptions(candidate.search, `${path}.search`);
  seoOptions(candidate.seo, `${path}.seo`);
  i18nOptions(candidate.i18n, `${path}.i18n`);
  mediaOptions(candidate.media, `${path}.media`);
  analyticsOptions(candidate.analytics, `${path}.analytics`);
  editLinkOptions(candidate.editLink, `${path}.editLink`);
  builderOptions(candidate.builder, `${path}.builder`);
  retentionPolicy(candidate.retention, `${path}.retention`);
  optional(candidate, "activeBundleDigest", path, nonEmptyString);
}

function publishRunRequest(value: unknown, path: string): void {
  const candidate = object(value, path);
  keys(candidate, path, ["schema", "projectRef", "operation", "expectedActiveBundleDigest", "dryRun"]);
  literal(candidate.schema, `${path}.schema`, PUBLISH_RUN_REQUEST_SCHEMA_V1);
  nonEmptyString(candidate.projectRef, `${path}.projectRef`);
  oneOf(candidate.operation, `${path}.operation`, ["plan", "refresh", "build", "verify", "run"]);
  optional(candidate, "expectedActiveBundleDigest", path, nonEmptyString);
  boolean(candidate.dryRun, `${path}.dryRun`);
}

export function parsePublicationProjectV1(
  value: unknown,
  budget: PublicationValidationBudgetV1 = DEFAULT_PUBLICATION_VALIDATION_BUDGET_V1,
): PublicationProjectV1 {
  return parse(value, budget, publicationProject);
}

export function parsePublishRunRequestV1(
  value: unknown,
  budget: PublicationValidationBudgetV1 = DEFAULT_PUBLICATION_VALIDATION_BUDGET_V1,
): PublishRunRequestV1 {
  return parse(value, budget, publishRunRequest);
}

function issueSource(value: unknown, path: string): void {
  const candidate = object(value, path);
  keys(candidate, path, ["sourceId", "assetId", "route", "path"]);
  optional(candidate, "sourceId", path, nonEmptyString);
  optional(candidate, "assetId", path, nonEmptyString);
  optional(candidate, "route", path, nonEmptyString);
  optional(candidate, "path", path, nonEmptyString);
}

function publicationIssue(value: unknown, path: string): void {
  const candidate = object(value, path);
  keys(candidate, path, ["level", "code", "message", "source"]);
  oneOf(candidate.level, `${path}.level`, ["info", "warning", "error"]);
  oneOf(candidate.code, `${path}.code`, ISSUE_CODES);
  nonEmptyString(candidate.message, `${path}.message`);
  optional(candidate, "source", path, issueSource);
}

function sourcePageSnapshot(value: unknown, path: string): void {
  const candidate = object(value, path);
  keys(candidate, path, [
    "sourceId", "sourceVersion", "representation", "parentId", "position", "depth",
    "title", "contentDigest", "metadataDigest", "assetMetadataDigest", "macroDependencyDigest", "state",
  ]);
  nonEmptyString(candidate.sourceId, `${path}.sourceId`);
  nonEmptyString(candidate.sourceVersion, `${path}.sourceVersion`);
  oneOf(candidate.representation, `${path}.representation`, ["atlas_doc_format", "storage"]);
  optional(candidate, "parentId", path, nonEmptyString);
  safeInteger(candidate.position, `${path}.position`, 0);
  safeInteger(candidate.depth, `${path}.depth`, 0);
  nonEmptyString(candidate.title, `${path}.title`);
  nonEmptyString(candidate.contentDigest, `${path}.contentDigest`);
  nonEmptyString(candidate.metadataDigest, `${path}.metadataDigest`);
  nonEmptyString(candidate.assetMetadataDigest, `${path}.assetMetadataDigest`);
  nonEmptyString(candidate.macroDependencyDigest, `${path}.macroDependencyDigest`);
  oneOf(candidate.state, `${path}.state`, [
    "included", "excluded", "inaccessible", "out-of-scope", "deleted",
  ]);
}

function sourceSnapshot(value: unknown, path: string): void {
  const candidate = object(value, path);
  keys(candidate, path, ["sourceDigest", "complete", "deletionAuthority", "rootIds", "pages"]);
  nonEmptyString(candidate.sourceDigest, `${path}.sourceDigest`);
  boolean(candidate.complete, `${path}.complete`);
  oneOf(candidate.deletionAuthority, `${path}.deletionAuthority`, ["complete-scan", "none"]);
  stringValues(candidate.rootIds, `${path}.rootIds`);
  values(candidate.pages, `${path}.pages`, sourcePageSnapshot);
}

function publicationChange(value: unknown, path: string): void {
  const candidate = object(value, path);
  keys(candidate, path, [
    "kind", "sourceId", "previousDigest", "nextDigest", "previousRoute", "nextRoute",
  ]);
  oneOf(candidate.kind, `${path}.kind`, [
    "add", "content-change", "metadata-change", "move", "route-change", "asset-change", "live-dependency-change",
    "exclude", "out-of-scope", "inaccessible", "confirmed-delete",
  ]);
  nonEmptyString(candidate.sourceId, `${path}.sourceId`);
  optional(candidate, "previousDigest", path, nonEmptyString);
  optional(candidate, "nextDigest", path, nonEmptyString);
  optional(candidate, "previousRoute", path, nonEmptyString);
  optional(candidate, "nextRoute", path, nonEmptyString);
}

function refreshPlan(value: unknown, path: string): void {
  const candidate = object(value, path);
  keys(candidate, path, [
    "schema", "previousBundleDigest", "sourceSnapshot", "changes", "complete", "issues",
    "planDigest",
  ]);
  literal(candidate.schema, `${path}.schema`, PUBLICATION_REFRESH_PLAN_SCHEMA_V1);
  optional(candidate, "previousBundleDigest", path, nonEmptyString);
  sourceSnapshot(candidate.sourceSnapshot, `${path}.sourceSnapshot`);
  values(candidate.changes, `${path}.changes`, publicationChange);
  boolean(candidate.complete, `${path}.complete`);
  values(candidate.issues, `${path}.issues`, publicationIssue);
  nonEmptyString(candidate.planDigest, `${path}.planDigest`);
}

function routeRecord(value: unknown, path: string): void {
  const candidate = object(value, path);
  keys(candidate, path, ["sourceId", "route", "state", "assignedBy", "previousRoutes"]);
  nonEmptyString(candidate.sourceId, `${path}.sourceId`);
  safeRoute(candidate.route, `${path}.route`, true);
  oneOf(candidate.state, `${path}.state`, ["active", "tombstone"]);
  oneOf(candidate.assignedBy, `${path}.assignedBy`, ["generated", "operator"]);
  values(candidate.previousRoutes, `${path}.previousRoutes`, (entry, entryPath) => {
    safeRoute(entry, entryPath, true);
  });
}

function linkReference(value: unknown, path: string): void {
  const candidate = object(value, path);
  const kind = oneOf(candidate.kind, `${path}.kind`, ["page", "asset", "external", "unresolved"]);
  if (kind === "page") {
    keys(candidate, path, ["referenceId", "kind", "sourceId", "anchorId"]);
    nonEmptyString(candidate.referenceId, `${path}.referenceId`);
    nonEmptyString(candidate.sourceId, `${path}.sourceId`);
    optional(candidate, "anchorId", path, nonEmptyString);
  } else if (kind === "asset") {
    keys(candidate, path, ["referenceId", "kind", "assetId"]);
    nonEmptyString(candidate.referenceId, `${path}.referenceId`);
    nonEmptyString(candidate.assetId, `${path}.assetId`);
  } else if (kind === "external") {
    keys(candidate, path, ["referenceId", "kind", "href"]);
    nonEmptyString(candidate.referenceId, `${path}.referenceId`);
    nonEmptyString(candidate.href, `${path}.href`);
  } else {
    keys(candidate, path, ["referenceId", "kind", "reason", "label"]);
    nonEmptyString(candidate.referenceId, `${path}.referenceId`);
    oneOf(candidate.reason, `${path}.reason`, ["ambiguous", "outside-scope", "unsafe", "missing"]);
    nonEmptyString(candidate.label, `${path}.label`);
  }
}

function publicationDependency(value: unknown, path: string): void {
  const candidate = object(value, path);
  keys(candidate, path, ["kind", "key", "version", "digest", "live"]);
  oneOf(candidate.kind, `${path}.kind`, [
    "source-page", "asset", "macro-data", "navigation", "link-graph",
  ]);
  nonEmptyString(candidate.key, `${path}.key`);
  nonEmptyString(candidate.version, `${path}.version`);
  nonEmptyString(candidate.digest, `${path}.digest`);
  boolean(candidate.live, `${path}.live`);
}

function publicationPage(value: unknown, path: string): void {
  const candidate = object(value, path);
  keys(candidate, path, [
    "schema", "sourceId", "sourceVersion", "title", "locale", "translationKey", "parentId", "position", "depth",
    "route", "blocks", "notes", "labels", "links", "assetIds", "renderDependencies",
    "pageDigest",
  ]);
  literal(candidate.schema, `${path}.schema`, PUBLICATION_PAGE_SCHEMA_V1);
  nonEmptyString(candidate.sourceId, `${path}.sourceId`);
  nonEmptyString(candidate.sourceVersion, `${path}.sourceVersion`);
  nonEmptyString(candidate.title, `${path}.title`);
  optional(candidate, "locale", path, (value, valuePath) => {
    normalizePublicationLocaleV1(nonEmptyString(value, valuePath), valuePath);
  });
  optional(candidate, "translationKey", path, nonEmptyString);
  optional(candidate, "parentId", path, nonEmptyString);
  safeInteger(candidate.position, `${path}.position`, 0);
  safeInteger(candidate.depth, `${path}.depth`, 0);
  safeRoute(candidate.route, `${path}.route`, true);
  try {
    parseExportBlockDocumentV1({
      schema: EXPORT_BLOCK_MODEL_SCHEMA_V1,
      blocks: candidate.blocks,
      notes: candidate.notes,
    });
  } catch (error) {
    fail(`${path}.blocks`, `invalid ExportBlock document: ${error instanceof Error ? error.message : "unknown error"}`);
  }
  stringValues(candidate.labels, `${path}.labels`);
  values(candidate.links, `${path}.links`, linkReference);
  stringValues(candidate.assetIds, `${path}.assetIds`);
  values(candidate.renderDependencies, `${path}.renderDependencies`, publicationDependency);
  nonEmptyString(candidate.pageDigest, `${path}.pageDigest`);
}

function pageEntry(value: unknown, path: string): void {
  const candidate = object(value, path);
  keys(candidate, path, ["sourceId", "path", "pageDigest"]);
  nonEmptyString(candidate.sourceId, `${path}.sourceId`);
  nonEmptyString(candidate.path, `${path}.path`);
  nonEmptyString(candidate.pageDigest, `${path}.pageDigest`);
}

function assetEntry(value: unknown, path: string): void {
  const candidate = object(value, path);
  keys(candidate, path, ["assetId", "path", "sha256", "byteLength", "mediaType", "disposition", "downloadName"]);
  nonEmptyString(candidate.assetId, `${path}.assetId`);
  nonEmptyString(candidate.path, `${path}.path`);
  nonEmptyString(candidate.sha256, `${path}.sha256`);
  safeInteger(candidate.byteLength, `${path}.byteLength`, 0);
  nonEmptyString(candidate.mediaType, `${path}.mediaType`);
  oneOf(candidate.disposition, `${path}.disposition`, [
    "inline", "download", "blocked-active-content",
  ]);
  if (candidate.downloadName !== undefined) {
    const downloadName = nonEmptyString(candidate.downloadName, `${path}.downloadName`);
    try {
      const candidatePath = validatePublicationOutputPathV1(`assets/download/${downloadName}`);
      if (candidatePath.split("/").length !== 3) {
        fail(`${path}.downloadName`, "expected one safe filename, not a path");
      }
    } catch {
      fail(`${path}.downloadName`, "expected one safe filename, not a path");
    }
  }
}

function publicationBundle(value: unknown, path: string): void {
  const candidate = object(value, path);
  keys(candidate, path, [
    "schema", "bundleDigest", "createdBy", "sourceSnapshot", "sourcePolicyDigest",
    "complete", "rootIds", "pages", "routes", "assets", "issues",
  ]);
  literal(candidate.schema, `${path}.schema`, PUBLICATION_BUNDLE_SCHEMA_V1);
  nonEmptyString(candidate.bundleDigest, `${path}.bundleDigest`);
  const createdBy = object(candidate.createdBy, `${path}.createdBy`);
  keys(createdBy, `${path}.createdBy`, ["name", "version"]);
  literal(createdBy.name, `${path}.createdBy.name`, "atlcli");
  nonEmptyString(createdBy.version, `${path}.createdBy.version`);
  sourceSnapshot(candidate.sourceSnapshot, `${path}.sourceSnapshot`);
  nonEmptyString(candidate.sourcePolicyDigest, `${path}.sourcePolicyDigest`);
  boolean(candidate.complete, `${path}.complete`);
  stringValues(candidate.rootIds, `${path}.rootIds`);
  values(candidate.pages, `${path}.pages`, pageEntry);
  values(candidate.routes, `${path}.routes`, routeRecord);
  values(candidate.assets, `${path}.assets`, assetEntry);
  values(candidate.issues, `${path}.issues`, publicationIssue);
}

function rendererDescriptor(value: unknown, path: string): void {
  const candidate = object(value, path);
  keys(candidate, path, [
    "id", "version", "handles", "capability", "dataSchema", "deterministic",
    "externalRuntimeData",
  ]);
  nonEmptyString(candidate.id, `${path}.id`);
  nonEmptyString(candidate.version, `${path}.version`);
  enumValues(candidate.handles, `${path}.handles`, RENDERABLE_KINDS);
  oneOf(candidate.capability, `${path}.capability`, ["static", "island"]);
  nonEmptyString(candidate.dataSchema, `${path}.dataSchema`);
  boolean(candidate.deterministic, `${path}.deterministic`);
  literal(candidate.externalRuntimeData, `${path}.externalRuntimeData`, false);
}

function experienceComponents(value: unknown, path: string): void {
  const candidate = object(value, path);
  keys(candidate, path, ["slots", "overrides", "blockOverrides"]);
  partialStringRecord(candidate.slots, `${path}.slots`, EXPERIENCE_SLOTS);
  partialStringRecord(candidate.overrides, `${path}.overrides`, COMPONENT_OVERRIDES);
  partialStringRecord(candidate.blockOverrides, `${path}.blockOverrides`, RENDERABLE_KINDS);
}

function experienceDescriptor(value: unknown, path: string): void {
  const candidate = object(value, path);
  keys(candidate, path, [
    "schema", "id", "version", "engine", "capabilities", "slots", "designTokensSchema",
    "components",
  ]);
  literal(candidate.schema, `${path}.schema`, PUBLICATION_EXPERIENCE_SCHEMA_V1);
  nonEmptyString(candidate.id, `${path}.id`);
  nonEmptyString(candidate.version, `${path}.version`);
  literal(candidate.engine, `${path}.engine`, "astro");
  enumValues(candidate.capabilities, `${path}.capabilities`, EXPERIENCE_CAPABILITIES);
  enumValues(candidate.slots, `${path}.slots`, EXPERIENCE_SLOTS);
  nonEmptyString(candidate.designTokensSchema, `${path}.designTokensSchema`);
  experienceComponents(candidate.components, `${path}.components`);
}

function searchProviderDescriptor(value: unknown, path: string): void {
  const candidate = object(value, path);
  keys(candidate, path, [
    "schema", "id", "version", "execution", "runtimeNetwork", "languagePartitions",
    "supportedFilters", "supportedMetadata", "supportedUi", "supportedShortcuts",
  ]);
  literal(candidate.schema, `${path}.schema`, PUBLICATION_SEARCH_PROVIDER_SCHEMA_V1);
  literal(candidate.id, `${path}.id`, "pagefind");
  nonEmptyString(candidate.version, `${path}.version`);
  literal(candidate.execution, `${path}.execution`, "static-post-build");
  literal(candidate.runtimeNetwork, `${path}.runtimeNetwork`, false);
  boolean(candidate.languagePartitions, `${path}.languagePartitions`);
  enumValues(candidate.supportedFilters, `${path}.supportedFilters`, [
    "space", "label", "content-type", "language",
  ]);
  enumValues(candidate.supportedMetadata, `${path}.supportedMetadata`, [
    "title", "description", "breadcrumbs", "image",
  ]);
  enumValues(candidate.supportedUi, `${path}.supportedUi`, ["modal", "page", "both"]);
  enumValues(candidate.supportedShortcuts, `${path}.supportedShortcuts`, [
    "mod+k", "/", "none",
  ]);
}

function builtPage(value: unknown, path: string): void {
  const candidate = object(value, path);
  keys(candidate, path, ["sourceId", "route", "outputPath", "sha256", "byteLength"]);
  nonEmptyString(candidate.sourceId, `${path}.sourceId`);
  safeRoute(candidate.route, `${path}.route`, true);
  nonEmptyString(candidate.outputPath, `${path}.outputPath`);
  nonEmptyString(candidate.sha256, `${path}.sha256`);
  safeInteger(candidate.byteLength, `${path}.byteLength`, 0);
}

function builtAsset(value: unknown, path: string): void {
  const candidate = object(value, path);
  keys(candidate, path, ["assetId", "outputPath", "sha256", "byteLength", "mediaType"]);
  nonEmptyString(candidate.assetId, `${path}.assetId`);
  nonEmptyString(candidate.outputPath, `${path}.outputPath`);
  nonEmptyString(candidate.sha256, `${path}.sha256`);
  safeInteger(candidate.byteLength, `${path}.byteLength`, 0);
  nonEmptyString(candidate.mediaType, `${path}.mediaType`);
}

function builtSearchIndex(value: unknown, path: string): void {
  const candidate = object(value, path);
  keys(candidate, path, ["provider", "digest", "files", "languages", "indexedSourceIds"]);
  literal(candidate.provider, `${path}.provider`, "pagefind");
  nonEmptyString(candidate.digest, `${path}.digest`);
  values(candidate.files, `${path}.files`, (entry, entryPath) => {
    const file = object(entry, entryPath);
    keys(file, entryPath, ["path", "sha256", "byteLength"]);
    nonEmptyString(file.path, `${entryPath}.path`);
    nonEmptyString(file.sha256, `${entryPath}.sha256`);
    safeInteger(file.byteLength, `${entryPath}.byteLength`, 0);
  });
  stringValues(candidate.languages, `${path}.languages`);
  stringValues(candidate.indexedSourceIds, `${path}.indexedSourceIds`);
}

function builtSeoArtifacts(value: unknown, path: string): void {
  const candidate = object(value, path);
  keys(candidate, path, ["sitemapPath", "robotsPath", "feedPath", "digest"]);
  optional(candidate, "sitemapPath", path, nonEmptyString);
  optional(candidate, "robotsPath", path, nonEmptyString);
  optional(candidate, "feedPath", path, nonEmptyString);
  nonEmptyString(candidate.digest, `${path}.digest`);
}

function builtAnalytics(value: unknown, path: string): void {
  const candidate = object(value, path);
  const provider = oneOf(candidate.provider, `${path}.provider`, ["none", "plausible"]);
  if (provider === "none") {
    keys(candidate, path, ["provider"]);
    return;
  }
  keys(candidate, path, ["provider", "endpointOrigin", "events"]);
  nonEmptyString(candidate.endpointOrigin, `${path}.endpointOrigin`);
  stringValues(candidate.events, `${path}.events`);
}

function builtEditLinks(value: unknown, path: string): void {
  const candidate = object(value, path);
  keys(candidate, path, ["provider", "includedSourceIds", "omittedSourceIds"]);
  oneOf(candidate.provider, `${path}.provider`, ["none", "confluence"]);
  stringValues(candidate.includedSourceIds, `${path}.includedSourceIds`);
  stringValues(candidate.omittedSourceIds, `${path}.omittedSourceIds`);
}

function verificationSummary(value: unknown, path: string): void {
  const candidate = object(value, path);
  keys(candidate, path, ["valid", "checkedPages", "checkedAssets", "issues"]);
  boolean(candidate.valid, `${path}.valid`);
  safeInteger(candidate.checkedPages, `${path}.checkedPages`, 0);
  safeInteger(candidate.checkedAssets, `${path}.checkedAssets`, 0);
  values(candidate.issues, `${path}.issues`, publicationIssue);
}

function staticManifest(value: unknown, path: string): void {
  const candidate = object(value, path);
  keys(candidate, path, [
    "schema", "bundleDigest", "builder", "projectDigest", "configDigest", "lockfileDigest",
    "base", "outputProfile", "pages", "assets", "experience", "search", "seo",
    "analytics", "editLinks", "removedOwnedPaths", "verification", "buildDigest",
  ]);
  literal(candidate.schema, `${path}.schema`, STATIC_PUBLICATION_MANIFEST_SCHEMA_V1);
  nonEmptyString(candidate.bundleDigest, `${path}.bundleDigest`);
  const builder = object(candidate.builder, `${path}.builder`);
  keys(builder, `${path}.builder`, ["id", "version", "astroVersion"]);
  literal(builder.id, `${path}.builder.id`, "astro-static");
  nonEmptyString(builder.version, `${path}.builder.version`);
  nonEmptyString(builder.astroVersion, `${path}.builder.astroVersion`);
  nonEmptyString(candidate.projectDigest, `${path}.projectDigest`);
  nonEmptyString(candidate.configDigest, `${path}.configDigest`);
  nonEmptyString(candidate.lockfileDigest, `${path}.lockfileDigest`);
  nonEmptyString(candidate.base, `${path}.base`);
  oneOf(candidate.outputProfile, `${path}.outputProfile`, ["directory", "portable-file"]);
  values(candidate.pages, `${path}.pages`, builtPage);
  values(candidate.assets, `${path}.assets`, builtAsset);
  const experience = object(candidate.experience, `${path}.experience`);
  keys(experience, `${path}.experience`, ["id", "version", "digest"]);
  nonEmptyString(experience.id, `${path}.experience.id`);
  nonEmptyString(experience.version, `${path}.experience.version`);
  nonEmptyString(experience.digest, `${path}.experience.digest`);
  builtSearchIndex(candidate.search, `${path}.search`);
  builtSeoArtifacts(candidate.seo, `${path}.seo`);
  builtAnalytics(candidate.analytics, `${path}.analytics`);
  builtEditLinks(candidate.editLinks, `${path}.editLinks`);
  stringValues(candidate.removedOwnedPaths, `${path}.removedOwnedPaths`);
  verificationSummary(candidate.verification, `${path}.verification`);
  nonEmptyString(candidate.buildDigest, `${path}.buildDigest`);
}

function buildRequest(value: unknown, path: string): void {
  const candidate = object(value, path);
  keys(candidate, path, ["project", "bundle", "projectDigest", "configDigest", "lockfileDigest"]);
  publicationProject(candidate.project, `${path}.project`);
  publicationBundle(candidate.bundle, `${path}.bundle`);
  nonEmptyString(candidate.projectDigest, `${path}.projectDigest`);
  nonEmptyString(candidate.configDigest, `${path}.configDigest`);
  nonEmptyString(candidate.lockfileDigest, `${path}.lockfileDigest`);
}

function buildResult(value: unknown, path: string): void {
  const candidate = object(value, path);
  keys(candidate, path, ["manifest", "outputDirectory"]);
  staticManifest(candidate.manifest, `${path}.manifest`);
  nonEmptyString(candidate.outputDirectory, `${path}.outputDirectory`);
}

export function parsePublicationRefreshPlanV1(
  value: unknown,
  budget: PublicationValidationBudgetV1 = DEFAULT_PUBLICATION_VALIDATION_BUDGET_V1,
): PublicationRefreshPlanV1 {
  return parse(value, budget, refreshPlan);
}

export function parsePublicationPageV1(
  value: unknown,
  budget: PublicationValidationBudgetV1 = DEFAULT_PUBLICATION_VALIDATION_BUDGET_V1,
): PublicationPageV1 {
  return parse(value, budget, publicationPage);
}

export function parsePublicationBundleV1(
  value: unknown,
  budget: PublicationValidationBudgetV1 = DEFAULT_PUBLICATION_VALIDATION_BUDGET_V1,
): PublicationBundleV1 {
  return parse(value, budget, publicationBundle);
}

export function parsePublicationRendererDescriptorV1(
  value: unknown,
  budget: PublicationValidationBudgetV1 = DEFAULT_PUBLICATION_VALIDATION_BUDGET_V1,
): PublicationRendererDescriptorV1 {
  return parse(value, budget, rendererDescriptor);
}

export function parsePublicationExperienceDescriptorV1(
  value: unknown,
  budget: PublicationValidationBudgetV1 = DEFAULT_PUBLICATION_VALIDATION_BUDGET_V1,
): PublicationExperienceDescriptorV1 {
  return parse(value, budget, experienceDescriptor);
}

export function parsePublicationSearchProviderDescriptorV1(
  value: unknown,
  budget: PublicationValidationBudgetV1 = DEFAULT_PUBLICATION_VALIDATION_BUDGET_V1,
): PublicationSearchProviderDescriptorV1 {
  return parse(value, budget, searchProviderDescriptor);
}

export function parseStaticPublicationManifestV1(
  value: unknown,
  budget: PublicationValidationBudgetV1 = DEFAULT_PUBLICATION_VALIDATION_BUDGET_V1,
): StaticPublicationManifestV1 {
  return parse(value, budget, staticManifest);
}

export function parsePublicationBuildRequestV1(
  value: unknown,
  budget: PublicationValidationBudgetV1 = DEFAULT_PUBLICATION_VALIDATION_BUDGET_V1,
): PublicationBuildRequestV1 {
  return parse(value, budget, buildRequest);
}

export function parsePublicationBuildResultV1(
  value: unknown,
  budget: PublicationValidationBudgetV1 = DEFAULT_PUBLICATION_VALIDATION_BUDGET_V1,
): PublicationBuildResultV1 {
  return parse(value, budget, buildResult);
}
