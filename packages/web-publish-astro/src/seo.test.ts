import { expect, test } from "bun:test";
import { createPublicationSeoHeadTagsV1, createPublicationSeoPlanV1 } from "./seo.js";

const options = {
  site: "https://docs.example.test",
  base: "/docs",
  seo: { sitemap: true, robots: "index", canonical: true, structuredData: ["WebSite", "TechArticle", "BreadcrumbList"], socialCards: "metadata-only", feed: "rss" },
  i18n: { defaultLocale: "en", locales: ["en", "de", "ar"], routeMode: "prefix-all", fallback: {}, uiTranslations: "starlight" },
  pages: [
    { sourceId: "guide-en", translationKey: "guide", title: "Guide <safe>", route: "/guide/", locale: "en", description: "A guide", breadcrumbs: [{ title: "Home", route: "/" }] },
    { sourceId: "guide-de", translationKey: "guide", title: "Anleitung", route: "/guide/", locale: "de" },
    { sourceId: "guide-ar", translationKey: "guide", title: "دليل", route: "/guide/", locale: "ar" },
  ],
} as const;

test("plans canonical, alternate, RTL, sitemap, robots, JSON-LD, and feed output together", () => {
  const result = createPublicationSeoPlanV1(options);
  const page = result.pages[0]!;
  expect(page.canonicalUrl).toBe("https://docs.example.test/docs/en/guide/");
  expect(page.alternates).toEqual([
    { locale: "ar", href: "https://docs.example.test/docs/ar/guide/" },
    { locale: "de", href: "https://docs.example.test/docs/de/guide/" },
    { locale: "en", href: "https://docs.example.test/docs/en/guide/" },
  ]);
  expect(page.direction).toBe("ltr");
  expect(result.pages[2]!.direction).toBe("rtl");
  expect(result.sitemap).toContain("https://docs.example.test/docs/en/guide/");
  expect(result.robots).toContain("Sitemap: https://docs.example.test/docs/sitemap.xml");
  expect(page.structuredDataJson).not.toContain("<safe>");
  expect(page.structuredDataJson).toContain("\\u003c");
  expect(result.feedPath).toBe("feed.xml");
  expect(result.feed).toContain("Anleitung");
  const tags = createPublicationSeoHeadTagsV1(page, "Docs");
  expect(tags.find((tag) => tag.tag === "title")?.content).toBe("Guide <safe> | Docs");
  expect(tags.find((tag) => tag.tag === "script")?.content).toBe(page.structuredDataJson);
});

test("fails closed for unsafe site, duplicate route identity, unknown locale, and malformed locale", () => {
  expect(() => createPublicationSeoPlanV1({ ...options, site: "javascript:alert(1)" })).toThrow("site");
  expect(() => createPublicationSeoPlanV1({ ...options, pages: [...options.pages, { ...options.pages[0]!, sourceId: "other", translationKey: "other" }] })).toThrow("duplicate SEO route");
  expect(() => createPublicationSeoPlanV1({ ...options, pages: [{ ...options.pages[0]!, locale: "fr" }] })).toThrow("not configured");
  expect(() => createPublicationSeoPlanV1({ ...options, i18n: { ...options.i18n, locales: ["en", "not a locale"] } })).toThrow("valid BCP-47-like locale");
});
