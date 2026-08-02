const SAFE_COLOR = /^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/iu;

/** Prevent source strings from becoming CSS declarations or CSS resource loads. */
export function safeExportBlockColorV1(value: unknown): string | undefined {
  return typeof value === "string" && SAFE_COLOR.test(value) ? value : undefined;
}

/**
 * A renderer-side second line of defence. Source normalization owns the
 * canonical link policy; this package independently refuses active schemes.
 */
export function safeExportBlockHrefV1(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const href = value.replace(/[\u0000-\u001f\u007f]/gu, "");
  if (!href || href.startsWith("//")) return undefined;
  if (href.startsWith("#") || href.startsWith("/") || href.startsWith("./") || href.startsWith("../")) return href;
  try {
    const protocol = new URL(href).protocol;
    return protocol === "https:" || protocol === "http:" || protocol === "mailto:" || protocol === "tel:" ? href : undefined;
  } catch {
    return undefined;
  }
}

/** Publication assets must already be verified, local, content-addressed files. */
export function safeExportBlockAssetSrcV1(value: unknown): string | undefined {
  if (typeof value !== "string" || value.startsWith("//")) return undefined;
  return value.startsWith("/") || value.startsWith("./") ? value : undefined;
}

/** Numeric-only layout styles retain exact percentages without source CSS. */
export function safeExportBlockPercentageV1(value: unknown): string | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100 ? `${value}%` : undefined;
}
