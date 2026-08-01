import {
  normalizePublicationRoutePrefixV1,
  normalizePublicationRouteV1,
  type PublicationI18nOptionsV1,
  type PublicationSeoOptionsV1,
} from "@atlcli/web-publish";

const LOCALE_PATTERN = /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/u;
const RTL_LANGUAGES = new Set(["ar", "dv", "fa", "he", "ku", "ps", "ur", "yi"]);

export interface PublicationSeoPageInputV1 {
  sourceId: string;
  title: string;
  route: string;
  /** Explicit page locale; omitted pages use the configured default locale. */
  locale?: string;
  /** Pages with the same key receive alternate-language links. */
  translationKey?: string;
  description?: string;
  imageUrl?: string;
  breadcrumbs?: readonly { title: string; route: string }[];
}

export interface PublicationSeoAlternateV1 {
  locale: string;
  href: string;
}

export interface PublicationSeoPageMetadataV1 {
  sourceId: string;
  title: string;
  description: string;
  locale: string;
  direction: "ltr" | "rtl";
  canonicalUrl: string;
  alternates: readonly PublicationSeoAlternateV1[];
  imageUrl?: string;
  structuredData: readonly Record<string, unknown>[];
  /** JSON-safe text for a trusted JSON-LD script element. */
  structuredDataJson: string;
}

/** Trusted tag records for an experience-owned document head. */
export interface PublicationSeoHeadTagV1 {
  tag: "title" | "meta" | "link" | "script";
  attrs?: Readonly<Record<string, string>>;
  content?: string;
}

export interface PublicationSeoPlanOptionsV1 {
  site: string;
  base: string;
  seo: PublicationSeoOptionsV1;
  i18n: PublicationI18nOptionsV1;
  pages: readonly PublicationSeoPageInputV1[];
  siteName?: string;
}

export interface PublicationSeoArtifactsV1 {
  pages: readonly PublicationSeoPageMetadataV1[];
  sitemap: string;
  robots: string;
  feed?: string;
  feedPath?: "feed.xml" | "feed.atom.xml";
  site: string;
  siteName: string;
}

/**
 * Convert shared SEO metadata into a framework-neutral head description. The
 * JSON-LD value is produced by this module and is safe for a trusted head
 * renderer's explicit raw-content boundary; page content never reaches it.
 */
export function createPublicationSeoHeadTagsV1(
  metadata: PublicationSeoPageMetadataV1,
  siteName?: string,
): readonly PublicationSeoHeadTagV1[] {
  const tags: PublicationSeoHeadTagV1[] = [
    { tag: "title", content: siteName === undefined ? metadata.title : `${metadata.title} | ${siteName}` },
    { tag: "meta", attrs: { name: "description", content: metadata.description } },
    { tag: "meta", attrs: { property: "og:title", content: metadata.title } },
    { tag: "meta", attrs: { property: "og:description", content: metadata.description } },
    { tag: "meta", attrs: { property: "og:type", content: "article" } },
    { tag: "meta", attrs: { property: "og:url", content: metadata.canonicalUrl } },
    { tag: "meta", attrs: { property: "og:locale", content: metadata.locale } },
    { tag: "meta", attrs: { property: "og:site_name", content: siteName ?? metadata.canonicalUrl } },
    { tag: "meta", attrs: { name: "twitter:card", content: metadata.imageUrl === undefined ? "summary" : "summary_large_image" } },
    { tag: "meta", attrs: { name: "twitter:title", content: metadata.title } },
    { tag: "meta", attrs: { name: "twitter:description", content: metadata.description } },
    { tag: "link", attrs: { rel: "canonical", href: metadata.canonicalUrl } },
  ];
  if (metadata.imageUrl !== undefined) {
    tags.push(
      { tag: "meta", attrs: { property: "og:image", content: metadata.imageUrl } },
      { tag: "meta", attrs: { name: "twitter:image", content: metadata.imageUrl } },
    );
  }
  for (const alternate of metadata.alternates) {
    tags.push({ tag: "link", attrs: { rel: "alternate", hreflang: alternate.locale, href: alternate.href } });
  }
  tags.push({ tag: "script", attrs: { type: "application/ld+json" }, content: metadata.structuredDataJson });
  return Object.freeze(tags);
}

function nonEmpty(value: string, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
  return value.trim();
}

function locale(value: string, name: string): string {
  const normalized = nonEmpty(value, name).replaceAll("_", "-");
  if (!LOCALE_PATTERN.test(normalized)) throw new TypeError(`${name} is not a valid BCP-47-like locale`);
  return normalized;
}

function primaryLanguage(value: string): string {
  return value.split("-")[0]!.toLowerCase();
}

function directionForLocale(value: string): "ltr" | "rtl" {
  return RTL_LANGUAGES.has(primaryLanguage(value)) ? "rtl" : "ltr";
}

function compactDescription(value: string | undefined, fallback: string): string {
  const normalized = (value ?? fallback).replace(/\s+/gu, " ").trim();
  return normalized.slice(0, 160);
}

function xml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}

function jsonLd(value: readonly Record<string, unknown>[]): string {
  return JSON.stringify(value).replaceAll("<", "\\u003c").replaceAll(">", "\\u003e")
    .replaceAll("&", "\\u0026").replaceAll("\u2028", "\\u2028").replaceAll("\u2029", "\\u2029");
}

function siteAuthority(value: string): string {
  const parsed = new URL(nonEmpty(value, "site"));
  if ((parsed.protocol !== "https:" && parsed.protocol !== "http:") || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new TypeError("site must be an absolute HTTP(S) URL without credentials, query, or fragment");
  }
  if (parsed.pathname !== "/") throw new TypeError("site must not include a path; configure the Astro base separately");
  return parsed.origin;
}

function safeImage(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const parsed = new URL(nonEmpty(value, "imageUrl"));
  if ((parsed.protocol !== "https:" && parsed.protocol !== "http:") || parsed.username || parsed.password) {
    throw new TypeError("imageUrl must be an absolute HTTP(S) URL without credentials");
  }
  return parsed.href;
}

function pagePath(base: string, localeValue: string, route: string, options: PublicationI18nOptionsV1): string {
  const localePrefix = options.routeMode === "prefix-all" || localeValue !== options.defaultLocale
    ? `/${localeValue}`
    : "";
  const path = normalizePublicationRouteV1(`${localePrefix}${route}`);
  return `${base}${path}` || "/";
}

function absolute(site: string, path: string): string {
  return new URL(path, `${site}/`).href;
}

function feedFor(
  format: "rss" | "atom",
  site: string,
  siteName: string,
  pages: readonly PublicationSeoPageMetadataV1[],
): string {
  if (format === "rss") {
    return `<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0"><channel><title>${xml(siteName)}</title><link>${xml(site)}</link>${pages.map((page) => `<item><title>${xml(page.title)}</title><link>${xml(page.canonicalUrl)}</link><guid>${xml(page.canonicalUrl)}</guid><description>${xml(page.description)}</description></item>`).join("")}</channel></rss>\n`;
  }
  return `<?xml version="1.0" encoding="UTF-8"?>\n<feed xmlns="http://www.w3.org/2005/Atom"><title>${xml(siteName)}</title><id>${xml(site)}</id><link href="${xml(site)}" rel="alternate"/>${pages.map((page) => `<entry><title>${xml(page.title)}</title><id>${xml(page.canonicalUrl)}</id><link href="${xml(page.canonicalUrl)}"/><summary>${xml(page.description)}</summary><updated>1970-01-01T00:00:00Z</updated></entry>`).join("")}</feed>\n`;
}

/** Build deterministic, locale-aware discovery artifacts from trusted page metadata. */
export function createPublicationSeoPlanV1(options: PublicationSeoPlanOptionsV1): PublicationSeoArtifactsV1 {
  const site = siteAuthority(options.site);
  const suppliedBase = options.base.length > 1 && options.base.endsWith("/")
    ? options.base.slice(0, -1)
    : options.base;
  const base = normalizePublicationRoutePrefixV1(suppliedBase);
  const defaultLocale = locale(options.i18n.defaultLocale, "i18n.defaultLocale");
  const locales = options.i18n.locales.map((value, index) => locale(value, `i18n.locales[${index}]`));
  if (locales.length === 0 || !locales.includes(defaultLocale)) throw new TypeError("i18n.defaultLocale must be in i18n.locales");
  if (new Set(locales).size !== locales.length) throw new TypeError("i18n.locales must not contain duplicates");
  const siteName = nonEmpty(options.siteName ?? new URL(site).hostname, "siteName");
  const seenSources = new Set<string>();
  const seenRoutes = new Set<string>();
  const pageInputs = options.pages.map((input) => {
    const sourceId = nonEmpty(input.sourceId, "page.sourceId");
    if (seenSources.has(sourceId)) throw new TypeError(`duplicate SEO source ID '${sourceId}'`);
    seenSources.add(sourceId);
    const title = nonEmpty(input.title, `page[${sourceId}].title`);
    const route = normalizePublicationRouteV1(input.route);
    const pageLocale = locale(input.locale ?? defaultLocale, `page[${sourceId}].locale`);
    if (!locales.includes(pageLocale)) throw new TypeError(`page[${sourceId}].locale is not configured`);
    const path = pagePath(base, pageLocale, route, { ...options.i18n, defaultLocale });
    if (seenRoutes.has(path)) throw new TypeError(`duplicate SEO route '${path}'`);
    seenRoutes.add(path);
    return { ...input, sourceId, title, route, locale: pageLocale, path, translationKey: input.translationKey ?? sourceId };
  });
  const groups = new Map<string, typeof pageInputs>();
  for (const input of pageInputs) groups.set(input.translationKey, [...(groups.get(input.translationKey) ?? []), input]);
  const pages = pageInputs.map((input): PublicationSeoPageMetadataV1 => {
    const canonicalUrl = absolute(site, input.path);
    const alternates = Object.freeze((groups.get(input.translationKey) ?? []).map((alternate) => ({
      locale: alternate.locale,
      href: absolute(site, alternate.path),
    })).sort((left, right) => left.locale.localeCompare(right.locale)));
    const description = compactDescription(input.description, input.title);
    const imageUrl = safeImage(input.imageUrl);
    const structuredData: Record<string, unknown>[] = [];
    if (options.seo.structuredData.includes("WebSite")) {
      structuredData.push({ "@context": "https://schema.org", "@type": "WebSite", "name": siteName, "url": site, "inLanguage": input.locale });
    }
    if (options.seo.structuredData.includes("TechArticle")) {
      structuredData.push({ "@context": "https://schema.org", "@type": "TechArticle", "headline": input.title, "description": description, "url": canonicalUrl, "inLanguage": input.locale, ...(imageUrl === undefined ? {} : { image: imageUrl }) });
    }
    if (options.seo.structuredData.includes("BreadcrumbList")) {
      const breadcrumbs = input.breadcrumbs === undefined || input.breadcrumbs.length === 0
        ? [{ title: input.title, route: input.route }]
        : input.breadcrumbs;
      structuredData.push({ "@context": "https://schema.org", "@type": "BreadcrumbList", itemListElement: breadcrumbs.map((breadcrumb, index) => ({ "@type": "ListItem", position: index + 1, name: nonEmpty(breadcrumb.title, "breadcrumb.title"), item: absolute(site, `${base}${normalizePublicationRouteV1(breadcrumb.route)}`) })) });
    }
    return Object.freeze({
      sourceId: input.sourceId,
      title: input.title,
      description,
      locale: input.locale,
      direction: directionForLocale(input.locale),
      canonicalUrl,
      alternates,
      ...(imageUrl === undefined ? {} : { imageUrl }),
      structuredData: Object.freeze(structuredData),
      structuredDataJson: jsonLd(structuredData),
    });
  });
  const sitemap = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${pages.map((page) => `<url><loc>${xml(page.canonicalUrl)}</loc></url>`).join("")}</urlset>\n`;
  const sitemapUrl = absolute(site, `${base}/sitemap.xml`);
  const robots = options.seo.robots === "index"
    ? `User-agent: *\nAllow: ${base || "/"}\nSitemap: ${sitemapUrl}\n`
    : `User-agent: *\nDisallow: ${base || "/"}\n`;
  const feed = options.seo.feed === "disabled" ? undefined : feedFor(options.seo.feed, site, siteName, pages);
  return Object.freeze({
    pages: Object.freeze(pages), sitemap, robots, ...(feed === undefined ? {} : { feed, feedPath: options.seo.feed === "rss" ? "feed.xml" as const : "feed.atom.xml" as const }), site, siteName,
  });
}
