import { expect, test } from "bun:test";
import {
  normalizePublicationLocaleV1,
  publicationLocaleDirectionV1,
  publicationLocaleFallbackChainV1,
  publicationLocaleRouteV1,
} from "./i18n.js";

const options = {
  defaultLocale: "en",
  locales: ["en", "de-DE", "ar"],
  routeMode: "hide-default" as const,
  fallback: { "de-DE": "en", ar: "en" },
  uiTranslations: "starlight" as const,
};

test("normalizes locale metadata, direction, fallback, and route policy consistently", () => {
  expect(normalizePublicationLocaleV1(" EN_us ")).toBe("en-US");
  expect(publicationLocaleDirectionV1("ar-EG")).toBe("rtl");
  expect(publicationLocaleDirectionV1("de-DE")).toBe("ltr");
  expect(publicationLocaleFallbackChainV1("de-DE", options)).toEqual(["de-DE", "en"]);
  expect(publicationLocaleRouteV1("/guide/", "en", options)).toBe("/guide/");
  expect(publicationLocaleRouteV1("/guide/", "ar", options)).toBe("/ar/guide/");
  expect(publicationLocaleRouteV1("/guide/", "en", { ...options, routeMode: "prefix-all" })).toBe("/en/guide/");
});

test("fails closed for invalid or cyclic locale configuration", () => {
  expect(() => normalizePublicationLocaleV1("not a locale")).toThrow("valid BCP-47-like locale");
  expect(() => publicationLocaleFallbackChainV1("de-DE", {
    ...options,
    fallback: { "de-DE": "ar", ar: "de-DE" },
  })).toThrow("fallback cycle");
});
