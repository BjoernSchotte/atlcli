/**
 * The Level-A settings schema the panel renders for PDF (spec 010 T5.2,
 * folder 007).
 *
 * **Why this lives in the panel and not in a manifest.** `PdfTemplateSettings`
 * (`packages/pdf/src/types.ts`) is a *closed* set of named fields the built-in
 * `atlcli-doc` template consumes directly, and no shipped manifest declares an
 * equivalent open `settings` map — `BUILTIN_PDF_TEMPLATE_MANIFEST` has
 * `design`, `bindings` and `localization`, but no `settings`. So the schema
 * below is the panel's declaration of that closed set in the *same* widget
 * vocabulary a manifest would use. The renderer stays generic: the moment a
 * template pack does declare `settings`, `fromManifestSettings` produces the
 * same shape and `SettingsForm` renders it with no change.
 *
 * Every bound here mirrors `resolvePdfSettings`
 * (`packages/pdf/src/settings.ts`) — `opacity` in `(0, 1]`, `angle` in
 * `[-180, 180]`, `size` in `[8, 400]`, text capped at 200 code points. The
 * engine remains the authority and rejects rather than clamps; these bounds
 * exist so the panel can say so next to the field.
 *
 * `watermark` is flattened into `watermark*` keys because a manifest settings
 * map is flat by contract; `toPdfSettings` re-nests them.
 */
import type { MessageKey } from "../../utils/i18n/messages.js";
import {
  CODE_THEME_METADATA,
  DEFAULT_CODE_THEME,
} from "@atlcli/code-highlight/registry";
import type { SettingsSchema } from "./settings-schema.js";

/** Byte cap on an uploaded logo, matching the engine's `LOGO_MAX_BYTES`. */
export const PDF_LOGO_MAX_BYTES = 5 * 1024 * 1024;

export const CODE_THEME_SETTINGS: SettingsSchema = {
  codeTheme: {
    type: "choice",
    default: DEFAULT_CODE_THEME,
    options: CODE_THEME_METADATA.map((theme) => ({
      value: theme.id,
      label: `${theme.displayName} (${theme.type})`,
    })),
    label: "Code theme",
    group: "code",
  },
};

export const PDF_LEVEL_A_SETTINGS: SettingsSchema = {
  ...CODE_THEME_SETTINGS,
  page: {
    type: "choice",
    default: "a4",
    options: [{ value: "a4" }, { value: "letter" }],
    group: "layout",
  },
  orientation: {
    type: "choice",
    default: "portrait",
    options: [{ value: "portrait" }, { value: "landscape" }],
    group: "layout",
  },
  cover: { type: "boolean", default: true, group: "layout" },
  outline: { type: "boolean", default: true, group: "layout" },

  headerText: { type: "text", default: "", maxLength: 200, group: "branding" },
  footerText: { type: "text", default: "", maxLength: 200, group: "branding" },
  organizationName: { type: "text", default: "", maxLength: 200, group: "branding" },
  accentColor: { type: "color", default: "#4B57A3", group: "branding" },
  logo: {
    type: "asset",
    default: "",
    accept: "image/png,image/svg+xml",
    maxBytes: PDF_LOGO_MAX_BYTES,
    group: "branding",
  },
  logoAlt: { type: "text", default: "", maxLength: 200, group: "branding" },

  watermarkText: { type: "text", default: "", maxLength: 200, group: "watermark" },
  watermarkColor: { type: "color", default: "#DE350B", group: "watermark" },
  watermarkOpacity: {
    type: "number",
    default: 0.08,
    min: 0,
    exclusiveMin: true,
    max: 1,
    step: 0.01,
    group: "watermark",
  },
  watermarkAngle: { type: "number", default: -54, min: -180, max: 180, step: 1, group: "watermark" },
  watermarkSize: { type: "number", default: 96, min: 8, max: 400, step: 1, group: "watermark" },
};

/** Translated field labels for {@link PDF_LEVEL_A_SETTINGS}. */
export const PDF_SETTING_LABEL_KEYS: Readonly<Record<string, MessageKey>> = {
  codeTheme: "export.codeTheme",
  page: "pdf.settings.page",
  orientation: "pdf.settings.orientation",
  cover: "pdf.settings.cover",
  outline: "pdf.settings.outline",
  headerText: "pdf.settings.headerText",
  footerText: "pdf.settings.footerText",
  organizationName: "pdf.settings.organizationName",
  accentColor: "pdf.settings.accentColor",
  logo: "pdf.settings.logo",
  logoAlt: "pdf.settings.logoAlt",
  watermarkText: "pdf.settings.watermarkText",
  watermarkColor: "pdf.settings.watermarkColor",
  watermarkOpacity: "pdf.settings.watermarkOpacity",
  watermarkAngle: "pdf.settings.watermarkAngle",
  watermarkSize: "pdf.settings.watermarkSize",
};

/** Translated `choice` option labels, keyed `<setting>.<option>`. */
export const PDF_SETTING_OPTION_LABEL_KEYS: Readonly<Record<string, MessageKey>> = {
  "page.a4": "pdf.settings.page.a4",
  "page.letter": "pdf.settings.page.letter",
  "orientation.portrait": "pdf.settings.orientation.portrait",
  "orientation.landscape": "pdf.settings.orientation.landscape",
};
