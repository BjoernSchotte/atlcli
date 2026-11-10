import type { PdfExportMetadata } from "./types.js";

/**
 * The document locale as a BCP-47 tag `Intl` accepts. A region is appended
 * only to a bare language; a tag `Intl` rejects (`de_DE`) falls back to
 * English instead of failing the export.
 */
export function documentLocale(language?: string, region?: string): string {
  const requested = language
    ? region && !language.includes("-") ? `${language}-${region}` : language
    : "en";
  try {
    new Intl.DateTimeFormat(requested);
    return requested;
  } catch {
    return "en";
  }
}

/** The cover/running-head export date, e.g. `7 August 2026`. */
export function exportedDateLabel(
  metadata: Pick<PdfExportMetadata, "exportedAt" | "language" | "region">,
): string {
  return new Intl.DateTimeFormat(documentLocale(metadata.language, metadata.region), {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(metadata.exportedAt);
}
