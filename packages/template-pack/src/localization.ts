/**
 * `wiki.pdf-template/v1` localization model (spec 012 T6.1/T6.2).
 *
 * `localization` carries two kinds of copy as manifest data:
 * - **document-facing labels** (`document`) — strings that appear in the
 *   rendered PDF (Version, Exported, Contents, …). The resolver turns these
 *   into `settings.labels.*` for the export's document locale.
 * - **host-facing UI copy** (`template` name/description, `settingGroups`,
 *   `settings` labels/help/options) — consumed by `localizeTemplateUi` to
 *   render a generated settings form (folder 010's job, not this folder's).
 *
 * The **fallback locale must be complete** (validated at import): a missing
 * fallback label would leak an engine-hardcoded literal or render empty text.
 * Non-fallback locales may be partial, producing a *warning*, never a reject.
 *
 * Browser-safe: no `node:`/`bun:` imports.
 */

import { ManifestValidationError } from "./manifest-error.js";

/** The document-label vocabulary the `wiki.pdf-template/v1` contract defines. */
export const WIKI_PDF_V1_DOCUMENT_LABELS = [
  "version",
  "exported",
  "exporter",
  "contents",
  "endOfDocument",
  "pages",
  "generatedWith",
  "spacePrefix",
] as const;

export type WikiPdfDocumentLabelKey = (typeof WIKI_PDF_V1_DOCUMENT_LABELS)[number];

export interface LocaleTemplateCopy {
  name: string;
  description: string;
}

export interface LocaleSettingCopy {
  label?: string;
  help?: string;
  options?: Record<string, string>;
}

export interface LocaleBundle {
  template?: LocaleTemplateCopy;
  document?: Record<string, string>;
  settingGroups?: Record<string, string>;
  settings?: Record<string, LocaleSettingCopy>;
}

export interface WikiPdfTemplateLocalizationV1 {
  defaultLocale: string;
  fallbackLocale: string;
  locales: Record<string, LocaleBundle>;
}

/** Shape the completeness check needs about the manifest's declared settings. */
export interface DeclaredSettingsShape {
  /** Setting key → its declared choice option values (for `choice` settings). */
  settings: Record<string, { options?: string[] }>;
  /** Declared setting-group ids requiring a label. */
  groups: string[];
}

export interface ValidateLocalizationOptions {
  /** Document labels the fallback locale must define in full. */
  requiredDocumentLabels?: readonly string[];
  /** Declared settings/groups the fallback locale must label in full. */
  declared?: DeclaredSettingsShape;
  /** Sink for non-fatal warnings (partial non-fallback locales). */
  onWarning?: (warning: string) => void;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function fail(path: string, message: string): never {
  throw new ManifestValidationError("shape-error", `${path}: ${message}`, path);
}

function requireString(obj: Record<string, unknown>, key: string, path: string): string {
  const v = obj[key];
  if (typeof v !== "string" || v.length === 0) fail(`${path}.${key}`, "must be a non-empty string");
  return v;
}

function validateStringMap(value: unknown, path: string): Record<string, string> {
  if (!isObject(value)) fail(path, "must be an object");
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw !== "string") fail(`${path}.${key}`, "must be a string");
    out[key] = raw;
  }
  return out;
}

function validateBundle(value: unknown, path: string): LocaleBundle {
  if (!isObject(value)) fail(path, "must be an object");
  const bundle: LocaleBundle = {};
  if (value.template !== undefined) {
    if (!isObject(value.template)) fail(`${path}.template`, "must be an object");
    bundle.template = {
      name: requireString(value.template, "name", `${path}.template`),
      description: requireString(value.template, "description", `${path}.template`),
    };
  }
  if (value.document !== undefined) bundle.document = validateStringMap(value.document, `${path}.document`);
  if (value.settingGroups !== undefined) {
    bundle.settingGroups = validateStringMap(value.settingGroups, `${path}.settingGroups`);
  }
  if (value.settings !== undefined) {
    if (!isObject(value.settings)) fail(`${path}.settings`, "must be an object");
    const settings: Record<string, LocaleSettingCopy> = {};
    for (const [key, raw] of Object.entries(value.settings)) {
      if (!isObject(raw)) fail(`${path}.settings.${key}`, "must be an object");
      const copy: LocaleSettingCopy = {};
      if (raw.label !== undefined) {
        if (typeof raw.label !== "string") fail(`${path}.settings.${key}.label`, "must be a string");
        copy.label = raw.label;
      }
      if (raw.help !== undefined) {
        if (typeof raw.help !== "string") fail(`${path}.settings.${key}.help`, "must be a string");
        copy.help = raw.help;
      }
      if (raw.options !== undefined) {
        copy.options = validateStringMap(raw.options, `${path}.settings.${key}.options`);
      }
      settings[key] = copy;
    }
    bundle.settings = settings;
  }
  return bundle;
}

/**
 * Validate an untrusted `localization` block. The fallback locale is checked
 * for completeness (hard reject); every other locale that omits a required
 * field emits a warning through {@link ValidateLocalizationOptions.onWarning}.
 */
export function validateLocalization(
  value: unknown,
  options: ValidateLocalizationOptions = {},
  path = "localization"
): WikiPdfTemplateLocalizationV1 {
  if (!isObject(value)) fail(path, "must be an object");
  const defaultLocale = requireString(value, "defaultLocale", path);
  const fallbackLocale = requireString(value, "fallbackLocale", path);
  if (!isObject(value.locales)) fail(`${path}.locales`, "must be an object");

  const locales: Record<string, LocaleBundle> = {};
  for (const [locale, raw] of Object.entries(value.locales)) {
    locales[locale] = validateBundle(raw, `${path}.locales.${locale}`);
  }

  if (!locales[fallbackLocale]) {
    fail(`${path}.fallbackLocale`, `no "${fallbackLocale}" entry in locales`);
  }
  if (!locales[defaultLocale]) {
    fail(`${path}.defaultLocale`, `no "${defaultLocale}" entry in locales`);
  }

  const requiredDocs = options.requiredDocumentLabels ?? [];
  const declared = options.declared;

  // Hard-check the fallback locale for completeness.
  assertCompleteLocale(locales[fallbackLocale]!, `${path}.locales.${fallbackLocale}`, {
    requiredDocs,
    declared,
    reporter: (message) => fail(message.path, message.text),
  });

  // Warn (never reject) for partial non-fallback locales.
  if (options.onWarning) {
    for (const [locale, bundle] of Object.entries(locales)) {
      if (locale === fallbackLocale) continue;
      assertCompleteLocale(bundle, `${path}.locales.${locale}`, {
        requiredDocs,
        declared,
        reporter: (message) => options.onWarning!(`${message.path}: ${message.text}`),
      });
    }
  }

  return { defaultLocale, fallbackLocale, locales };
}

interface CompletenessReport {
  path: string;
  text: string;
}

function assertCompleteLocale(
  bundle: LocaleBundle,
  path: string,
  ctx: {
    requiredDocs: readonly string[];
    declared?: DeclaredSettingsShape;
    reporter: (message: CompletenessReport) => void;
  }
): void {
  if (!bundle.template?.name || !bundle.template?.description) {
    ctx.reporter({ path: `${path}.template`, text: "must define a non-empty name and description" });
  }
  for (const label of ctx.requiredDocs) {
    if (!bundle.document || typeof bundle.document[label] !== "string" || bundle.document[label] === "") {
      ctx.reporter({ path: `${path}.document.${label}`, text: "missing document label" });
    }
  }
  if (ctx.declared) {
    for (const group of ctx.declared.groups) {
      if (!bundle.settingGroups || !bundle.settingGroups[group]) {
        ctx.reporter({ path: `${path}.settingGroups.${group}`, text: "missing group label" });
      }
    }
    for (const [key, meta] of Object.entries(ctx.declared.settings)) {
      const copy = bundle.settings?.[key];
      if (!copy?.label) {
        ctx.reporter({ path: `${path}.settings.${key}.label`, text: "missing setting label" });
      }
      for (const option of meta.options ?? []) {
        if (!copy?.options || !copy.options[option]) {
          ctx.reporter({
            path: `${path}.settings.${key}.options.${option}`,
            text: "missing option label",
          });
        }
      }
    }
  }
}

/**
 * The ordered locale-fallback chain for a requested locale: exact locale
 * (incl. region) → base language → `defaultLocale` → `fallbackLocale`. Returns
 * the bundles that exist, in precedence order (first = highest priority).
 */
export function localeChain(
  localization: WikiPdfTemplateLocalizationV1,
  requested: string | undefined
): LocaleBundle[] {
  const order: string[] = [];
  const push = (locale: string | undefined): void => {
    if (locale && !order.includes(locale)) order.push(locale);
  };
  const normalized = (requested ?? "").trim();
  push(normalized || undefined);
  const base = normalized.split(/[-_]/)[0];
  push(base || undefined);
  push(localization.defaultLocale);
  push(localization.fallbackLocale);
  return order.map((locale) => localization.locales[locale]).filter((b): b is LocaleBundle => Boolean(b));
}
