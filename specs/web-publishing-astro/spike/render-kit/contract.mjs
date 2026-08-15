const ALLOWED_PROTOCOLS = new Set(["http:", "https:", "mailto:", "tel:"]);

export function safePublicHref(value) {
  if (typeof value !== "string" || value.length === 0) return undefined;
  if (value.startsWith("/") && !value.startsWith("//")) return value;
  if (value.startsWith("#")) return value;
  try {
    const parsed = new URL(value);
    return ALLOWED_PROTOCOLS.has(parsed.protocol) ? parsed.href : undefined;
  } catch {
    return undefined;
  }
}

export function safeHtmlId(value) {
  if (typeof value !== "string") return undefined;
  const normalized = value
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 96);
  return normalized || undefined;
}

export function assertT0ChartModel(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("chart model must be an object");
  }
  if (value.schema !== "atlcli.chart-model/1-t0") {
    throw new TypeError("unsupported chart model schema");
  }
  if (typeof value.title !== "string" || typeof value.description !== "string") {
    throw new TypeError("chart title and description must be strings");
  }
  if (!Array.isArray(value.categories) || value.categories.length === 0 || value.categories.length > 24) {
    throw new TypeError("chart categories must contain 1..24 entries");
  }
  if (!value.categories.every((entry) => typeof entry === "string" && entry.length <= 80)) {
    throw new TypeError("chart categories must be bounded strings");
  }
  if (!Array.isArray(value.series) || value.series.length === 0 || value.series.length > 8) {
    throw new TypeError("chart series must contain 1..8 entries");
  }
  const keys = new Set();
  for (const series of value.series) {
    if (!series || typeof series !== "object" || Array.isArray(series)) {
      throw new TypeError("chart series entries must be objects");
    }
    if (typeof series.key !== "string" || !/^[a-z0-9-]{1,40}$/u.test(series.key)) {
      throw new TypeError("chart series key is invalid");
    }
    if (keys.has(series.key)) throw new TypeError("chart series keys must be unique");
    keys.add(series.key);
    if (typeof series.label !== "string" || series.label.length > 80) {
      throw new TypeError("chart series labels must be bounded strings");
    }
    if (!Array.isArray(series.values) || series.values.length !== value.categories.length) {
      throw new TypeError("chart values must align with categories");
    }
    if (!series.values.every((entry) => Number.isFinite(entry) && Math.abs(entry) <= 1_000_000_000)) {
      throw new TypeError("chart values must be finite and bounded");
    }
  }
}
