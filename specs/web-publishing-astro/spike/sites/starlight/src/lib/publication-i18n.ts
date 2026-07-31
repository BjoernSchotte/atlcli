import { getCollection, type CollectionEntry } from "astro:content";
import { publicationRoutePath } from "@atlcli/web-publish-astro-spike";

interface LocaleLink {
  href: string;
  label: string;
  locale: string;
}

const localeLabels: Readonly<Record<string, string>> = {
  ar: "العربية",
  de: "Deutsch",
  en: "English",
};

const cleanPath = (value: string) => value === "/" ? value : value.replace(/\/$/u, "");

function hrefFor(entry: CollectionEntry<"publicationPages">, base: string): string {
  return `${base}${publicationRoutePath(entry.data)}/`;
}

export async function publicationLocaleLinks(pathname: string, baseUrl: string): Promise<{
  alternateLinks: readonly LocaleLink[];
  currentEntry?: CollectionEntry<"publicationPages">;
  currentLocale: string;
  selectorLinks: readonly LocaleLink[];
}> {
  const base = baseUrl.replace(/\/$/u, "");
  const relativePath = cleanPath(pathname.slice(base.length) || "/");
  const pages = await getCollection("publicationPages");
  const currentEntry = pages.find((entry) => cleanPath(publicationRoutePath(entry.data)) === relativePath);
  const labelMatch = relativePath.match(/^\/(?:([a-z]{2})\/)?publish\/labels\/([a-z0-9][a-z0-9-]{0,63})$/u);
  const currentLocale = currentEntry?.data.locale ?? labelMatch?.[1] ?? "en";

  let equivalentPages: CollectionEntry<"publicationPages">[] = [];
  if (currentEntry?.data.translationKey) {
    equivalentPages = pages.filter((entry) => entry.data.translationKey === currentEntry.data.translationKey);
  } else if (currentEntry) {
    equivalentPages = [currentEntry];
  }

  const alternateLinks = labelMatch
    ? [...new Set(pages.filter((entry) => entry.data.labels.includes(labelMatch[2]!)).map((entry) => entry.data.locale))]
        .sort()
        .map((locale) => ({
          href: `${base}${locale === "en" ? "" : `/${locale}`}/publish/labels/${labelMatch[2]}/`,
          label: localeLabels[locale] ?? locale,
          locale,
        }))
    : equivalentPages
        .sort((left, right) => left.data.locale.localeCompare(right.data.locale))
        .map((entry) => ({
          href: hrefFor(entry, base),
          label: localeLabels[entry.data.locale] ?? entry.data.locale,
          locale: entry.data.locale,
        }));

  const roots = [...pages]
    .sort((left, right) => left.data.position - right.data.position)
    .filter((entry, index, entries) => entries.findIndex((candidate) => candidate.data.locale === entry.data.locale) === index)
    .map((entry) => ({
      href: hrefFor(entry, base),
      label: localeLabels[entry.data.locale] ?? entry.data.locale,
      locale: entry.data.locale,
    }))
    .sort((left, right) => left.locale.localeCompare(right.locale));

  return {
    alternateLinks,
    currentEntry,
    currentLocale,
    selectorLinks: alternateLinks.length > 1 ? alternateLinks : roots,
  };
}
