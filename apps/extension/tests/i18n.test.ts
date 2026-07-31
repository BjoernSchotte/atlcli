/**
 * i18n contract (spec 010 Phase 0).
 *
 * `MessageCatalog = Record<MessageKey, string>` already makes a *missing*
 * German key a compile error. It does NOT catch an EXTRA key (a stale entry
 * left behind after an English key was renamed), and it says nothing about
 * placeholder parity — a German string that dropped `{count}` compiles fine and
 * renders a sentence with a hole in it. Both are pinned here.
 */
import { describe, expect, it } from "bun:test";
import {
  CATALOGS,
  FALLBACK_LOCALE,
  LOCALES,
  isLocale,
  resolveLocale,
  translate,
  type Locale,
  type MessageKey,
} from "../utils/i18n/messages.js";

const englishKeys = Object.keys(CATALOGS.en) as MessageKey[];

/** Placeholder names used by a template, sorted for comparison. */
function placeholders(template: string): string[] {
  return [...template.matchAll(/\{(\w+)\}/g)].map((match) => match[1]!).sort();
}

describe("message catalogues", () => {
  it("ships every declared locale", () => {
    expect(Object.keys(CATALOGS).sort()).toEqual([...LOCALES].sort());
  });

  for (const locale of LOCALES) {
    it(`${locale} has exactly the English key set — no missing, no stale`, () => {
      expect(Object.keys(CATALOGS[locale]).sort()).toEqual([...englishKeys].sort());
    });

    it(`${locale} keeps the same placeholders as English`, () => {
      const mismatched = englishKeys.filter(
        (key) =>
          placeholders(CATALOGS.en[key]).join(",") !==
          placeholders(CATALOGS[locale][key]).join(",")
      );
      expect(mismatched).toEqual([]);
    });

    it(`${locale} has no empty strings`, () => {
      const empty = englishKeys.filter((key) => CATALOGS[locale][key].trim() === "");
      expect(empty).toEqual([]);
    });
  }

  it("actually translates — German differs from English where it should", () => {
    expect(CATALOGS.de["nav.sections"]).toBe("Bereiche");
    expect(CATALOGS.de["screen.settings.label"]).toBe("Einstellungen");
    expect(CATALOGS.de["screen.activity.label"]).toBe("Verlauf");
  });
});

describe("translate", () => {
  it("substitutes named placeholders", () => {
    expect(translate("en", "docx.report.resolved", { count: 3 })).toBe("3 placeholder(s) resolved");
    expect(translate("de", "docx.report.resolved", { count: 3 })).toBe("3 Platzhalter aufgelöst");
  });

  it("substitutes every occurrence of the same placeholder set", () => {
    expect(
      translate("en", "pdf.report.timings", { prepare: "1 ms", compile: "2 ms", emit: "3 ms" })
    ).toBe("Prepare 1 ms · Compile 2 ms · Download 3 ms");
  });

  it("leaves an unmatched placeholder verbatim rather than printing undefined", () => {
    expect(translate("en", "docx.report.resolved", {})).toBe("{count} placeholder(s) resolved");
  });

  it("returns the template untouched when no params are given", () => {
    expect(translate("en", "app.version")).toBe("v{version}");
  });

  it("falls back to English for an unknown locale", () => {
    expect(translate("fr" as Locale, "nav.sections")).toBe(CATALOGS.en["nav.sections"]);
  });
});

describe("resolveLocale", () => {
  it("matches on the primary subtag", () => {
    expect(resolveLocale(["de-AT"])).toBe("de");
    expect(resolveLocale(["en-GB"])).toBe("en");
  });

  it("takes the first supported candidate and skips unknown ones", () => {
    expect(resolveLocale([null, undefined, "fr-FR", "de"])).toBe("de");
  });

  it("falls back when nothing matches", () => {
    expect(resolveLocale(["fr", "ja"])).toBe(FALLBACK_LOCALE);
    expect(resolveLocale([])).toBe(FALLBACK_LOCALE);
  });

  it("is case-insensitive", () => {
    expect(resolveLocale(["DE-CH"])).toBe("de");
  });
});

describe("isLocale", () => {
  it("accepts shipped locales and rejects everything else", () => {
    expect(isLocale("de")).toBe(true);
    expect(isLocale("en")).toBe(true);
    expect(isLocale("de-AT")).toBe(false);
    expect(isLocale(null)).toBe(false);
    expect(isLocale(42)).toBe(false);
  });
});
