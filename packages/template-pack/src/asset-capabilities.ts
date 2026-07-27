/**
 * Engine-neutral limits for visual assets accepted by a template renderer.
 *
 * The renderer owns the concrete values. Importers and pack validators consume
 * the same descriptor so an asset cannot pass intake and fail later under a
 * different budget.
 */
export const TEMPLATE_ASSET_CAPABILITIES_SCHEMA_V1 =
  "atlcli.template-asset-capabilities/1" as const;

export interface TemplateAssetCapabilitiesV1 {
  schema: typeof TEMPLATE_ASSET_CAPABILITIES_SCHEMA_V1;
  id: string;
  version: number;
  mediaTypes: readonly ("image/jpeg" | "image/png" | "image/svg+xml")[];
  maxBytes: number;
  maxWidth: number;
  maxHeight: number;
  maxPixels: number;
  svg: {
    maxElements: number;
    maxPathElements: number;
    maxFilterPrimitives: number;
  };
}

const STABLE_ID_RE = /^[A-Za-z][A-Za-z0-9._-]{0,127}$/;

function positiveSafeInteger(value: unknown, label: string): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value <= 0
  ) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
  return value;
}

/** Fail-closed structural validation shared by every host. */
export function validateTemplateAssetCapabilitiesV1(
  value: unknown
): TemplateAssetCapabilitiesV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Template asset capabilities must be an object");
  }
  const candidate = value as Partial<TemplateAssetCapabilitiesV1>;
  if (candidate.schema !== TEMPLATE_ASSET_CAPABILITIES_SCHEMA_V1) {
    throw new TypeError("Unsupported template asset capability schema");
  }
  if (typeof candidate.id !== "string" || !STABLE_ID_RE.test(candidate.id)) {
    throw new TypeError("Template asset capability id is invalid");
  }
  positiveSafeInteger(candidate.version, "version");
  const permitted = new Set([
    "image/jpeg",
    "image/png",
    "image/svg+xml",
  ]);
  if (
    !Array.isArray(candidate.mediaTypes) ||
    candidate.mediaTypes.length === 0 ||
    new Set(candidate.mediaTypes).size !== candidate.mediaTypes.length ||
    candidate.mediaTypes.some(
      (mediaType) =>
        typeof mediaType !== "string" || !permitted.has(mediaType)
    )
  ) {
    throw new TypeError("Template asset media types are invalid");
  }
  positiveSafeInteger(candidate.maxBytes, "maxBytes");
  positiveSafeInteger(candidate.maxWidth, "maxWidth");
  positiveSafeInteger(candidate.maxHeight, "maxHeight");
  positiveSafeInteger(candidate.maxPixels, "maxPixels");
  if (!candidate.svg || typeof candidate.svg !== "object") {
    throw new TypeError("Template SVG capabilities are required");
  }
  positiveSafeInteger(candidate.svg.maxElements, "svg.maxElements");
  positiveSafeInteger(candidate.svg.maxPathElements, "svg.maxPathElements");
  positiveSafeInteger(
    candidate.svg.maxFilterPrimitives,
    "svg.maxFilterPrimitives"
  );
  return candidate as TemplateAssetCapabilitiesV1;
}
