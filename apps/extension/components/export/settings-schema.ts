/**
 * The template-settings schema the panel renders, and the pure functions over
 * it (spec 010 T5.2 / folder 007 Level-A).
 *
 * Three separate jobs, deliberately kept out of the React component so all of
 * them are testable without a DOM:
 *
 *  1. **Reading a schema.** {@link fromManifestSettings} coerces a template
 *     manifest's open `settings` map into the bounded widget vocabulary
 *     (`text | boolean | choice | color | number | asset`). A manifest is
 *     untrusted data — a pack could declare `type: "sudo"` or an `options`
 *     array of objects — so this is a defensive projection, not a cast.
 *  2. **Values.** {@link defaultValues} / {@link mergeValues} /
 *     {@link validateValues} own defaulting, the drop of stale keys a
 *     `template-prefs` record may still carry, and the fast local checks
 *     (number range, colour syntax, choice membership, text length).
 *  3. **Handing values to an engine.** {@link toPdfSettings} maps the flat
 *     Level-A keys onto `PdfTemplateSettings`'s *closed* shape, including the
 *     nested `watermark` object and the `logo` asset.
 *
 * **The panel's validation is a pre-check, never the authority.**
 * `resolvePdfSettings` (`packages/pdf/src/settings.ts`) rejects — it never
 * clamps — and stays the single source of truth for what a valid setting is.
 * What happens here only exists so an obviously wrong value cannot reach
 * `template-prefs` in the first place, and so the user sees the problem next to
 * the field instead of as an export failure two minutes later.
 *
 * **There is deliberately no DOCX counterpart to {@link toPdfSettings}.**
 * `ExportInput` (`packages/docx/src/export.ts`) has no `settings` field and no
 * folder currently adds one, so a DOCX template's manifest settings stay
 * *informational* in the panel. Writing them onto a DOCX export request would
 * be a promise the engine cannot keep; `tests/settings-form.test.tsx` asserts
 * the request never grows the field.
 */
import type { PdfTemplateSettings, TemplateManifest } from "@atlcli/pdf/browser";
import type { TemplateSettingValue } from "../../utils/ports/index.js";

/** The bounded Level-A widget vocabulary (folder 007 / TEMPLATE-UX §5.1). */
export const SETTING_TYPES = [
  "text",
  "boolean",
  "choice",
  "color",
  "number",
  "asset",
] as const;

export type SettingType = (typeof SETTING_TYPES)[number];

/** A form value, as persisted in `template-prefs`. */
export type SettingValue = TemplateSettingValue;

export interface SettingOption {
  value: string;
  /** Literal label from the manifest; the panel prefers `optionLabels`. */
  label?: string;
}

export interface SettingSchema {
  type: SettingType;
  default?: SettingValue;
  /** `choice` only. */
  options?: readonly SettingOption[];
  /** `number` only. */
  min?: number;
  max?: number;
  step?: number;
  /** `number` only: `min` is a strict lower bound (watermark opacity). */
  exclusiveMin?: boolean;
  /** `text` only, counted in Unicode code points. */
  maxLength?: number;
  /** `asset` only: `accept` attribute and a byte cap on the decoded payload. */
  accept?: string;
  maxBytes?: number;
  /** Literal label from the manifest; the panel prefers a translated one. */
  label?: string;
  /** Optional grouping key a manifest may declare. */
  group?: string;
}

export type SettingsSchema = Readonly<Record<string, SettingSchema>>;

/** Why one value was rejected. The panel maps these to translated copy. */
export type SettingIssueReason =
  | "not-a-number"
  | "out-of-range"
  | "not-a-color"
  | "not-an-option"
  | "too-long"
  | "asset-too-large"
  | "asset-unsupported";

export interface SettingIssue {
  key: string;
  reason: SettingIssueReason;
}

const TEXT_MAX_LENGTH = 200;

function isSettingType(value: unknown): value is SettingType {
  return typeof value === "string" && (SETTING_TYPES as readonly string[]).includes(value);
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asOptions(value: unknown): readonly SettingOption[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const options: SettingOption[] = [];
  for (const raw of value) {
    if (typeof raw === "string") options.push({ value: raw });
    else if (raw && typeof raw === "object" && typeof (raw as { value?: unknown }).value === "string") {
      const option = raw as { value: string; label?: unknown };
      options.push(
        typeof option.label === "string"
          ? { value: option.value, label: option.label }
          : { value: option.value }
      );
    }
  }
  return options.length > 0 ? options : undefined;
}

function asDefault(value: unknown): SettingValue | undefined {
  if (value === null) return null;
  const kind = typeof value;
  if (kind === "string" || kind === "number" || kind === "boolean") return value as SettingValue;
  return undefined;
}

/**
 * Project a manifest's open `settings` map onto {@link SettingsSchema}.
 *
 * Unknown types are **dropped**, not rendered as text: a widget the panel does
 * not understand cannot be edited correctly, and guessing would persist a value
 * the template never asked for.
 */
export function fromManifestSettings(
  settings: TemplateManifest["settings"] | undefined
): SettingsSchema {
  const out: Record<string, SettingSchema> = {};
  for (const [key, raw] of Object.entries(settings ?? {})) {
    if (!raw || typeof raw !== "object" || !isSettingType((raw as { type?: unknown }).type)) {
      continue;
    }
    const source = raw as Record<string, unknown>;
    const schema: SettingSchema = { type: source.type as SettingType };
    const fallback = asDefault(source.default);
    if (fallback !== undefined) schema.default = fallback;
    const options = asOptions(source.options);
    if (options) schema.options = options;
    const min = asNumber(source.min);
    if (min !== undefined) schema.min = min;
    const max = asNumber(source.max);
    if (max !== undefined) schema.max = max;
    const step = asNumber(source.step);
    if (step !== undefined) schema.step = step;
    if (source.exclusiveMin === true) schema.exclusiveMin = true;
    const maxLength = asNumber(source.maxLength);
    if (maxLength !== undefined) schema.maxLength = maxLength;
    if (typeof source.accept === "string") schema.accept = source.accept;
    const maxBytes = asNumber(source.maxBytes);
    if (maxBytes !== undefined) schema.maxBytes = maxBytes;
    if (typeof source.label === "string") schema.label = source.label;
    if (typeof source.group === "string") schema.group = source.group;
    out[key] = schema;
  }
  return out;
}

/** The value a field starts at when nothing was ever persisted. */
export function defaultValue(schema: SettingSchema): SettingValue {
  if (schema.default !== undefined) return schema.default;
  switch (schema.type) {
    case "boolean":
      return false;
    case "number":
      return schema.min ?? 0;
    case "choice":
      return schema.options?.[0]?.value ?? "";
    default:
      return "";
  }
}

/** Every declared setting at its default. */
export function defaultValues(schema: SettingsSchema): Record<string, SettingValue> {
  const out: Record<string, SettingValue> = {};
  for (const [key, setting] of Object.entries(schema)) out[key] = defaultValue(setting);
  return out;
}

function coerce(setting: SettingSchema, value: SettingValue): SettingValue | undefined {
  switch (setting.type) {
    case "boolean":
      return typeof value === "boolean" ? value : undefined;
    case "number":
      return typeof value === "number" && Number.isFinite(value) ? value : undefined;
    default:
      return typeof value === "string" ? value : undefined;
  }
}

/**
 * Overlay persisted values on the schema's defaults.
 *
 * Keys the schema no longer declares are **dropped** and values of the wrong
 * runtime type fall back to the default: a `template-prefs` record outlives the
 * template it was written for, and a stale key must not travel to an engine.
 */
export function mergeValues(
  schema: SettingsSchema,
  stored: Readonly<Record<string, SettingValue>> | undefined
): Record<string, SettingValue> {
  const out = defaultValues(schema);
  for (const [key, setting] of Object.entries(schema)) {
    const raw = stored?.[key];
    if (raw === undefined) continue;
    const coerced = coerce(setting, raw);
    if (coerced !== undefined) out[key] = coerced;
  }
  return out;
}

const HEX_COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

/** `#RGB`/`#RRGGBB` → `#RRGGBB`, or `undefined`. Mirrors the engine's intake. */
export function normalizeHexColor(value: string): string | undefined {
  const trimmed = value.trim();
  if (!HEX_COLOR.test(trimmed)) return undefined;
  if (trimmed.length === 7) return trimmed.toUpperCase();
  const [, r, g, b] = trimmed;
  return `#${r}${r}${g}${g}${b}${b}`.toUpperCase();
}

/** Validate one value against its schema. `null` when it is acceptable. */
export function validateSetting(
  key: string,
  setting: SettingSchema,
  value: SettingValue
): SettingIssue | null {
  // An empty optional text/colour field means "unset", never "invalid".
  if (value === null || value === "") return null;

  switch (setting.type) {
    case "number": {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        return { key, reason: "not-a-number" };
      }
      const aboveMin =
        setting.min === undefined
          ? true
          : setting.exclusiveMin
            ? value > setting.min
            : value >= setting.min;
      if (!aboveMin || (setting.max !== undefined && value > setting.max)) {
        return { key, reason: "out-of-range" };
      }
      return null;
    }
    case "color":
      return typeof value === "string" && normalizeHexColor(value)
        ? null
        : { key, reason: "not-a-color" };
    case "choice":
      return setting.options?.some((option) => option.value === value)
        ? null
        : { key, reason: "not-an-option" };
    case "text":
      return typeof value === "string" &&
        [...value].length > (setting.maxLength ?? TEXT_MAX_LENGTH)
        ? { key, reason: "too-long" }
        : null;
    default:
      return null;
  }
}

/** Every issue in `values`, in schema declaration order. */
export function validateValues(
  schema: SettingsSchema,
  values: Readonly<Record<string, SettingValue>>
): SettingIssue[] {
  const issues: SettingIssue[] = [];
  for (const [key, setting] of Object.entries(schema)) {
    const issue = validateSetting(key, setting, values[key] ?? null);
    if (issue) issues.push(issue);
  }
  return issues;
}

// ---------------------------------------------------------------------------
// Engine hand-off — PDF only
// ---------------------------------------------------------------------------

/** `data:` URL → bytes + media type, or `undefined` for anything unsupported. */
export function decodeAssetDataUrl(
  value: string
): { bytes: Uint8Array; mediaType: "image/png" | "image/svg+xml" } | undefined {
  const match = /^data:(image\/png|image\/svg\+xml);base64,([\s\S]*)$/.exec(value.trim());
  if (!match) return undefined;
  try {
    const binary = atob(match[2]!);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return { bytes, mediaType: match[1] as "image/png" | "image/svg+xml" };
  } catch {
    return undefined;
  }
}

function text(values: Readonly<Record<string, SettingValue>>, key: string): string | undefined {
  const value = values[key];
  return typeof value === "string" && value !== "" ? value : undefined;
}

function bool(values: Readonly<Record<string, SettingValue>>, key: string): boolean | undefined {
  const value = values[key];
  return typeof value === "boolean" ? value : undefined;
}

function num(values: Readonly<Record<string, SettingValue>>, key: string): number | undefined {
  const value = values[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Map the flat form values onto `PdfTemplateSettings`.
 *
 * Returns `undefined` when no field carries a value at all — an empty-valued
 * form must not send `settings: {}`. Note that the built-in schema *does*
 * declare defaults for page/orientation/cover/outline/accentColor, so a reset
 * form still emits those five; they are exactly `resolvePdfSettings`'s own
 * defaults, so "reset" and "never touched" resolve to the same document.
 *
 * A watermark is only emitted when its text is non-empty (`watermark.text` is
 * required by the engine), and a logo only when its bytes decode *and* an alt
 * text exists (a present logo without alt is an engine rejection, and a silent
 * one here would be worse).
 */
export function toPdfSettings(
  values: Readonly<Record<string, SettingValue>>
): PdfTemplateSettings | undefined {
  const settings: PdfTemplateSettings = {};

  const page = text(values, "page");
  if (page === "a4" || page === "letter") settings.page = page;
  const orientation = text(values, "orientation");
  if (orientation === "portrait" || orientation === "landscape") {
    settings.orientation = orientation;
  }
  const cover = bool(values, "cover");
  if (cover !== undefined) settings.cover = cover;
  const outline = bool(values, "outline");
  if (outline !== undefined) settings.outline = outline;

  const headerText = text(values, "headerText");
  if (headerText) settings.headerText = headerText;
  const footerText = text(values, "footerText");
  if (footerText) settings.footerText = footerText;
  const organizationName = text(values, "organizationName");
  if (organizationName) settings.organizationName = organizationName;

  const accentColor = text(values, "accentColor");
  const normalizedAccent = accentColor ? normalizeHexColor(accentColor) : undefined;
  if (normalizedAccent) settings.accentColor = normalizedAccent;

  const watermarkText = text(values, "watermarkText");
  if (watermarkText && watermarkText.trim() !== "") {
    settings.watermark = { text: watermarkText };
    const color = text(values, "watermarkColor");
    const normalized = color ? normalizeHexColor(color) : undefined;
    if (normalized) settings.watermark.color = normalized;
    const opacity = num(values, "watermarkOpacity");
    if (opacity !== undefined) settings.watermark.opacity = opacity;
    const angle = num(values, "watermarkAngle");
    if (angle !== undefined) settings.watermark.angle = angle;
    const size = num(values, "watermarkSize");
    if (size !== undefined) settings.watermark.size = size;
  }

  const logo = text(values, "logo");
  const alt = text(values, "logoAlt");
  const decoded = logo ? decodeAssetDataUrl(logo) : undefined;
  if (decoded && alt) {
    settings.logo = { bytes: decoded.bytes, mediaType: decoded.mediaType, alt };
  }

  return Object.keys(settings).length === 0 ? undefined : settings;
}
