import type { PublicationI18nOptionsV1 } from "./contracts.js";
import { normalizePublicationRouteV1 } from "./routes.js";

const LOCALE_PATTERN = /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/u;
const RTL_LANGUAGES = new Set(["ar", "dv", "fa", "he", "ku", "ps", "ur", "yi"]);

/** Normalize and validate the deliberately small, BCP-47-like locale surface. */
export function normalizePublicationLocaleV1(value: string, name = "locale"): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
  const parts = value.trim().replaceAll("_", "-").split("-");
  const normalized = parts.map((part, index) => {
    if (index === 0) return part.toLowerCase();
    if (part.length === 4) return `${part[0]!.toUpperCase()}${part.slice(1).toLowerCase()}`;
    if (part.length === 2 || /^\d{3}$/u.test(part)) return part.toUpperCase();
    return part.toLowerCase();
  }).join("-");
  if (!LOCALE_PATTERN.test(normalized)) {
    throw new TypeError(`${name} is not a valid BCP-47-like locale`);
  }
  return normalized;
}

/** Return the writing direction required by a publication locale. */
export function publicationLocaleDirectionV1(locale: string): "ltr" | "rtl" {
  const primary = normalizePublicationLocaleV1(locale).split("-")[0]!;
  return RTL_LANGUAGES.has(primary) ? "rtl" : "ltr";
}

/** Resolve the deterministic fallback chain, including the configured default. */
export function publicationLocaleFallbackChainV1(
  locale: string,
  options: PublicationI18nOptionsV1,
): readonly string[] {
  const configured = new Set(options.locales.map((entry, index) => normalizePublicationLocaleV1(entry, `i18n.locales[${index}]`)));
  const defaultLocale = normalizePublicationLocaleV1(options.defaultLocale, "i18n.defaultLocale");
  if (!configured.has(defaultLocale)) throw new TypeError("i18n.defaultLocale must be in i18n.locales");
  const chain: string[] = [];
  const seen = new Set<string>();
  let current = normalizePublicationLocaleV1(locale);
  while (!seen.has(current)) {
    seen.add(current);
    chain.push(current);
    const next = options.fallback[current];
    if (next === undefined) break;
    if (seen.has(normalizePublicationLocaleV1(next, `i18n.fallback.${current}`))) {
      throw new TypeError(`i18n fallback cycle includes '${current}'`);
    }
    current = normalizePublicationLocaleV1(next, `i18n.fallback.${current}`);
  }
  if (!seen.has(defaultLocale)) chain.push(defaultLocale);
  return Object.freeze(chain);
}

/** Apply the configured locale route policy to one canonical logical route. */
export function publicationLocaleRouteV1(
  route: string,
  locale: string,
  options: PublicationI18nOptionsV1,
): string {
  const normalizedLocale = normalizePublicationLocaleV1(locale);
  const defaultLocale = normalizePublicationLocaleV1(options.defaultLocale, "i18n.defaultLocale");
  const prefix = options.routeMode === "prefix-all" || normalizedLocale !== defaultLocale
    ? `/${normalizedLocale}`
    : "";
  return normalizePublicationRouteV1(`${prefix}${normalizePublicationRouteV1(route)}`);
}
