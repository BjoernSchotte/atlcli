import {
  type PublicationAnalyticsOptionsV1,
  type PublicationEditLinkOptionsV1,
  type PublicationExperienceCapabilityV1,
  type PublicationExperienceDescriptorV1,
  type PublicationProjectV1,
} from "./contracts.js";
import {
  parsePublicationExperienceDescriptorV1,
  parsePublicationProjectV1,
} from "./schema.js";

export type PublicationWebQualityIssueCodeV1 =
  | "site-required"
  | "invalid-site"
  | "internal-indexing"
  | "feed-requires-public"
  | "locale-set-invalid"
  | "locale-fallback-invalid"
  | "media-profile-mismatch"
  | "analytics-endpoint-invalid"
  | "analytics-domain-invalid"
  | "public-edit-link-disclosure-required"
  | "experience-capability-required";

export interface PublicationWebQualityIssueV1 {
  code: PublicationWebQualityIssueCodeV1;
  path: string;
  message: string;
}

export interface PublicationWebQualityPlanV1 {
  compatible: boolean;
  issues: readonly PublicationWebQualityIssueV1[];
  canonicalSite?: string;
  locales: readonly string[];
  requiredExperienceCapabilities: readonly PublicationExperienceCapabilityV1[];
  analytics: PublicationAnalyticsOptionsV1;
  editLink: PublicationEditLinkOptionsV1;
}

function issue(
  code: PublicationWebQualityIssueCodeV1,
  path: string,
  message: string,
): PublicationWebQualityIssueV1 {
  return { code, path, message };
}

function duplicates(values: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const duplicate = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) duplicate.add(value);
    seen.add(value);
  }
  return [...duplicate].sort();
}

function validatedSite(
  project: PublicationProjectV1,
  issues: PublicationWebQualityIssueV1[],
): string | undefined {
  const site = project.builder.site;
  if (!site) {
    issues.push(issue(
      "site-required",
      "$.builder.site",
      "Canonical URLs and the required sitemap need an explicit absolute site URL.",
    ));
    return undefined;
  }
  try {
    const parsed = new URL(site);
    if (
      (parsed.protocol !== "https:" && parsed.protocol !== "http:") ||
      (project.visibility === "public" && parsed.protocol !== "https:") ||
      parsed.username !== "" || parsed.password !== "" ||
      parsed.search !== "" || parsed.hash !== ""
    ) {
      throw new Error("invalid site authority");
    }
    return parsed.href.replace(/\/$/u, "");
  } catch {
    issues.push(issue(
      "invalid-site",
      "$.builder.site",
      "Site must be an absolute HTTP(S) URL without credentials, query, or fragment.",
    ));
    return undefined;
  }
}

function validateLocales(
  project: PublicationProjectV1,
  issues: PublicationWebQualityIssueV1[],
): void {
  const locales = new Set(project.i18n.locales);
  if (project.i18n.locales.length === 0) {
    issues.push(issue(
      "locale-set-invalid",
      "$.i18n.locales",
      "At least one explicit locale is required.",
    ));
  }
  for (const duplicate of duplicates(project.i18n.locales)) {
    issues.push(issue(
      "locale-set-invalid",
      "$.i18n.locales",
      `Locale ${duplicate} is declared more than once.`,
    ));
  }
  if (!locales.has(project.i18n.defaultLocale)) {
    issues.push(issue(
      "locale-set-invalid",
      "$.i18n.defaultLocale",
      `Default locale ${project.i18n.defaultLocale} is not in the locale set.`,
    ));
  }

  for (const [from, to] of Object.entries(project.i18n.fallback)) {
    if (!locales.has(from) || !locales.has(to) || from === to) {
      issues.push(issue(
        "locale-fallback-invalid",
        `$.i18n.fallback.${from}`,
        `Fallback ${from} -> ${to} must connect two distinct configured locales.`,
      ));
    }
  }
  for (const locale of project.i18n.locales) {
    const visited = new Set<string>();
    let current: string | undefined = locale;
    while (current !== undefined) {
      if (visited.has(current)) {
        issues.push(issue(
          "locale-fallback-invalid",
          `$.i18n.fallback.${locale}`,
          `Locale fallback chain for ${locale} contains a cycle.`,
        ));
        break;
      }
      visited.add(current);
      current = project.i18n.fallback[current];
    }
  }
}

function validateMedia(
  project: PublicationProjectV1,
  issues: PublicationWebQualityIssueV1[],
): void {
  for (const duplicate of duplicates(project.media.formats)) {
    issues.push(issue(
      "media-profile-mismatch",
      "$.media.formats",
      `Image format ${duplicate} is configured more than once.`,
    ));
  }
  if (!project.media.formats.includes("original")) {
    issues.push(issue(
      "media-profile-mismatch",
      "$.media.formats",
      "Every media profile must preserve a verified original/download path.",
    ));
  }
  if (
    project.media.images === "verified-original" &&
    project.media.formats.some((format) => format !== "original")
  ) {
    issues.push(issue(
      "media-profile-mismatch",
      "$.media.formats",
      "Derived AVIF/WebP formats require the explicit astro-responsive image profile.",
    ));
  }
}

function validateAnalytics(
  project: PublicationProjectV1,
  issues: PublicationWebQualityIssueV1[],
): void {
  if (project.analytics.provider === "none") return;
  try {
    const endpoint = new URL(project.analytics.endpoint);
    if (
      endpoint.protocol !== "https:" || endpoint.username !== "" || endpoint.password !== "" ||
      endpoint.search !== "" || endpoint.hash !== ""
    ) {
      throw new Error("invalid analytics endpoint");
    }
  } catch {
    issues.push(issue(
      "analytics-endpoint-invalid",
      "$.analytics.endpoint",
      "Plausible endpoint must be absolute HTTPS without credentials, query, or fragment.",
    ));
  }

  const domain = project.analytics.siteDomain;
  try {
    const parsed = new URL(`https://${domain}`);
    if (
      parsed.hostname !== domain || parsed.pathname !== "/" || parsed.port !== "" ||
      domain.includes("@")
    ) {
      throw new Error("invalid analytics site domain");
    }
  } catch {
    issues.push(issue(
      "analytics-domain-invalid",
      "$.analytics.siteDomain",
      "Plausible siteDomain must be a bare hostname without scheme, port, or path.",
    ));
  }
}

export function planPublicationWebQualityV1(
  projectValue: unknown,
  experienceValue: unknown,
): PublicationWebQualityPlanV1 {
  const project = parsePublicationProjectV1(projectValue);
  const experience: PublicationExperienceDescriptorV1 =
    parsePublicationExperienceDescriptorV1(experienceValue);
  const issues: PublicationWebQualityIssueV1[] = [];
  const canonicalSite = validatedSite(project, issues);

  if (project.visibility === "internal" && project.seo.robots === "index") {
    issues.push(issue(
      "internal-indexing",
      "$.seo.robots",
      "Internal publications must not opt into search-engine indexing.",
    ));
  }
  if (project.seo.feed !== "disabled" && project.visibility !== "public") {
    issues.push(issue(
      "feed-requires-public",
      "$.seo.feed",
      "RSS/Atom feeds are supported only for explicit public publications.",
    ));
  }

  validateLocales(project, issues);
  validateMedia(project, issues);
  validateAnalytics(project, issues);

  if (
    project.visibility === "public" &&
    project.editLink.provider === "confluence" &&
    project.editLink.visibility === "all" &&
    project.editLink.publicTenantDisclosureAcknowledged !== true
  ) {
    issues.push(issue(
      "public-edit-link-disclosure-required",
      "$.editLink.publicTenantDisclosureAcknowledged",
      "Public Confluence edit links require explicit tenant-disclosure acknowledgement.",
    ));
  }

  const requiredCapabilities = new Set<PublicationExperienceCapabilityV1>(["seo"]);
  if (project.i18n.locales.length > 1) requiredCapabilities.add("i18n");
  if (project.analytics.provider !== "none") requiredCapabilities.add("analytics-slot");
  if (project.editLink.provider !== "none") requiredCapabilities.add("edit-link");
  const providedCapabilities = new Set(experience.capabilities);
  for (const capability of requiredCapabilities) {
    if (!providedCapabilities.has(capability)) {
      issues.push(issue(
        "experience-capability-required",
        "$.experience.capabilities",
        `Configured web-quality features require experience capability ${capability}.`,
      ));
    }
  }

  return {
    compatible: issues.length === 0,
    issues,
    canonicalSite,
    locales: project.i18n.locales,
    requiredExperienceCapabilities: [...requiredCapabilities],
    analytics: project.analytics,
    editLink: project.editLink,
  };
}
