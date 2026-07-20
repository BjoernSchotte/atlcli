/**
 * `wiki.pdf-template/v1` setting → design-field bindings (spec 012 T6.1/T6.2).
 *
 * A binding declares that a Level-A setting key drives one or more design
 * fields. It is the mechanism that retires the built-in template's direct
 * `settings.at("accent-color", …)` reads: after resolution the template reads
 * `settings.design.tokens.colors.accent` (already bound), never a raw Level-A
 * key.
 *
 * Only two transforms are allowed, both fully declarative:
 * - `identity` — write the setting value straight to the target.
 * - `choice-map` — map a finite set of setting values to target values.
 *
 * No computed paths, no callbacks, no generic object merge. Targets are
 * validated against a **versioned allowlist** of design paths at import time,
 * so an out-of-range target is a validation error, never a render-time failure.
 *
 * Browser-safe: no `node:`/`bun:` imports.
 */

import { ManifestValidationError } from "./manifest-error.js";

/** The versioned allowlist of design-field paths a binding may target. */
export const BINDING_TARGET_ALLOWLIST = [
  "branding.accent",
  "tokens.colors.accent",
  "branding.organizationName",
  "page.size",
  "page.orientation",
  "features.cover.enabled",
  "features.outline.enabled",
  "features.outline.depth",
  "features.header.enabled",
  "features.footer.enabled",
] as const;

export type BindingTargetPath = (typeof BINDING_TARGET_ALLOWLIST)[number];

export type BindingTransform =
  | { kind: "identity" }
  | { kind: "choice-map"; map: Record<string, unknown> };

export interface WikiPdfTemplateSettingBindingV1 {
  /** The Level-A setting key this binding reads (e.g. `accentColor`). */
  setting: string;
  /** One or more allowlisted design paths this binding writes. */
  targets: BindingTargetPath[];
  /** How the setting value maps to the target value. Defaults to `identity`. */
  transform?: BindingTransform;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function fail(path: string, message: string): never {
  throw new ManifestValidationError("shape-error", `${path}: ${message}`, path);
}

const ALLOWED_TARGETS = new Set<string>(BINDING_TARGET_ALLOWLIST);

/**
 * Validate an untrusted `bindings` array. Rejects an unknown target path, a
 * transform other than `identity`/`choice-map`, and a `choice-map` whose `map`
 * is not a plain object — at import time, not render time.
 */
export function validateBindings(
  value: unknown,
  path = "bindings"
): WikiPdfTemplateSettingBindingV1[] {
  if (!Array.isArray(value)) fail(path, "must be an array");
  return value.map((raw, i) => validateBinding(raw, `${path}[${i}]`));
}

function validateBinding(value: unknown, path: string): WikiPdfTemplateSettingBindingV1 {
  if (!isObject(value)) fail(path, "must be an object");
  if (typeof value.setting !== "string" || value.setting.length === 0) {
    fail(`${path}.setting`, "must be a non-empty string");
  }
  if (!Array.isArray(value.targets) || value.targets.length === 0) {
    fail(`${path}.targets`, "must be a non-empty array");
  }
  const targets = value.targets.map((target, i) => {
    if (typeof target !== "string" || !ALLOWED_TARGETS.has(target)) {
      fail(`${path}.targets[${i}]`, `must be one of the allowlisted design paths`);
    }
    return target as BindingTargetPath;
  });
  const binding: WikiPdfTemplateSettingBindingV1 = { setting: value.setting, targets };
  if (value.transform !== undefined) {
    binding.transform = validateTransform(value.transform, `${path}.transform`);
  }
  return binding;
}

function validateTransform(value: unknown, path: string): BindingTransform {
  if (!isObject(value)) fail(path, "must be an object");
  if (value.kind === "identity") return { kind: "identity" };
  if (value.kind === "choice-map") {
    if (!isObject(value.map)) fail(`${path}.map`, "must be an object");
    return { kind: "choice-map", map: { ...value.map } };
  }
  fail(`${path}.kind`, 'must be "identity" or "choice-map"');
}
