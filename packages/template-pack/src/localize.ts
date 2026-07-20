/**
 * `localizeTemplateUi` (spec 012 T6.2) — resolve a template manifest's
 * host-facing UI copy for a requested UI locale.
 *
 * Pure. Follows the locale-fallback chain (exact locale incl. region → base
 * language → `defaultLocale` → `fallbackLocale`) and merges bundles so a
 * higher-priority locale's copy wins field-by-field, with the complete
 * fallback locale guaranteeing no field is ever empty.
 *
 * This is the function folder 010 calls to render a generated settings form;
 * this folder produces the data, it does not build the form.
 *
 * Browser-safe: no `node:`/`bun:` imports.
 */

import { localeChain, type LocaleSettingCopy } from "./localization.js";
import type { TemplateManifest } from "./manifest.js";

export interface LocalizedTemplateUi {
  name: string;
  description: string;
  settingGroups: Record<string, string>;
  settings: Record<string, LocaleSettingCopy>;
}

/**
 * Resolve the UI-facing copy (template name/description, setting/group/option
 * labels) for `uiLocale`. Falls back to the manifest's own `name` when no
 * localization block is present.
 */
export function localizeTemplateUi(
  manifest: TemplateManifest,
  uiLocale: string | undefined
): LocalizedTemplateUi {
  const result: LocalizedTemplateUi = {
    name: manifest.name,
    description: "",
    settingGroups: {},
    settings: {},
  };
  if (!manifest.localization) return result;

  // Walk the chain from LOWEST to HIGHEST priority so higher-priority copy
  // overwrites lower-priority copy on merge.
  const chain = localeChain(manifest.localization, uiLocale).reverse();
  for (const bundle of chain) {
    if (bundle.template?.name) result.name = bundle.template.name;
    if (bundle.template?.description) result.description = bundle.template.description;
    for (const [group, label] of Object.entries(bundle.settingGroups ?? {})) {
      result.settingGroups[group] = label;
    }
    for (const [key, copy] of Object.entries(bundle.settings ?? {})) {
      const merged = { ...result.settings[key] };
      if (copy.label !== undefined) merged.label = copy.label;
      if (copy.help !== undefined) merged.help = copy.help;
      if (copy.options !== undefined) merged.options = { ...merged.options, ...copy.options };
      result.settings[key] = merged;
    }
  }
  return result;
}
