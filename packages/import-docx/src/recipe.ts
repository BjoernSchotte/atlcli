/**
 * Versioned, shareable import recipes
 * (specs/import-docx/007-import-recipes, `atlcli.docx-import-recipe/1`).
 *
 * A recipe is PORTABLE DATA wrapping the baseline policy layer — never
 * executable configuration, never a raw target-payload escape hatch. This
 * module is pure: it validates recipe TEXT (already read by the host) and
 * produces the canonical form, digest, and policy layer. Catalog I/O lives
 * in the imperative shell.
 */
import { sha256Hex } from "@atlcli/core";
import { isAlias, parseDocument, visit } from "yaml";
import type { DocxImportOptionsV1, PolicyLayerInput, StyleMappingTarget } from "./overrides.js";
import { STYLE_MAPPING_TARGETS } from "./overrides.js";

export interface DocxImportRecipeV1 {
  schema: "atlcli.docx-import-recipe/1";
  id: string;
  version: string;
  title: string;
  description?: string;
  targets: Array<"cloud" | "data-center">;
  options?: DocxImportOptionsV1;
  overrides?: { styleMappings?: Record<string, StyleMappingTarget> };
  metadata?: { owners?: string[]; documentationUrl?: string; tags?: string[] };
}

export const RECIPE_SCHEMA = "atlcli.docx-import-recipe/1" as const;
const MAX_RECIPE_BYTES = 64 * 1024;
const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MAX_STRING = 512;

const TOP_LEVEL_KEYS = new Set([
  "schema", "id", "version", "title", "description", "targets", "options", "overrides", "metadata",
]);
const OPTION_KEYS = new Set(["revisions", "unsupported"]);
const OVERRIDE_KEYS = new Set(["styleMappings"]);
const METADATA_KEYS = new Set(["owners", "documentationUrl", "tags"]);

export interface ParsedRecipe {
  recipe: DocxImportRecipeV1;
  /** sha256 over the canonical (sorted-key) JSON form. */
  digest: string;
  /** The policy layer this recipe contributes (precedence: recipe). */
  policyLayer: PolicyLayerInput;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function checkString(
  obj: Record<string, unknown>,
  key: string,
  errors: string[],
  { required = false, pattern }: { required?: boolean; pattern?: RegExp } = {},
): string | undefined {
  const value = obj[key];
  if (value === undefined) {
    if (required) errors.push(`Missing required field "${key}".`);
    return undefined;
  }
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_STRING) {
    errors.push(`Field "${key}" must be a non-empty string (max ${MAX_STRING} chars).`);
    return undefined;
  }
  if (pattern && !pattern.test(value)) {
    errors.push(`Field "${key}" is invalid: "${value}" does not match the required format.`);
    return undefined;
  }
  return value;
}

function rejectUnknownKeys(
  obj: Record<string, unknown>,
  allowed: Set<string>,
  path: string,
  errors: string[],
): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) errors.push(`Unknown field "${path}${key}".`);
    if (key === "__proto__" || key === "constructor" || key === "prototype") {
      errors.push(`Forbidden key "${path}${key}".`);
    }
  }
}

/**
 * Parse and validate recipe YAML text. The parse is hardened per plan 007
 * rule 8: duplicate keys, anchors/aliases, custom tags, oversized input,
 * and unknown fields all fail deterministically.
 */
export async function parseRecipe(text: string): Promise<{ parsed?: ParsedRecipe; errors: string[] }> {
  const errors: string[] = [];
  if (new TextEncoder().encode(text).byteLength > MAX_RECIPE_BYTES) {
    return { errors: [`Recipe exceeds ${MAX_RECIPE_BYTES} bytes.`] };
  }

  const doc = parseDocument(text, { uniqueKeys: true, version: "1.2" });
  for (const err of doc.errors) errors.push(`YAML: ${err.message.split("\n")[0]}`);
  for (const warn of doc.warnings) errors.push(`YAML: ${warn.message.split("\n")[0]}`);
  visit(doc, {
    Node(_, node) {
      if (isAlias(node)) errors.push("YAML anchors/aliases are not allowed in recipes.");
      if ("tag" in node && node.tag && !String(node.tag).startsWith("tag:yaml.org,2002:")) {
        errors.push(`Custom YAML tag ${String(node.tag)} is not allowed in recipes.`);
      }
    },
  });
  if (errors.length > 0) return { errors };

  const raw = doc.toJS({ maxAliasCount: 0 }) as unknown;
  if (!isPlainObject(raw)) return { errors: ["Recipe root must be a mapping."] };

  rejectUnknownKeys(raw, TOP_LEVEL_KEYS, "", errors);
  if (raw.schema !== RECIPE_SCHEMA) {
    errors.push(`Field "schema" must be exactly "${RECIPE_SCHEMA}".`);
  }
  const id = checkString(raw, "id", errors, { required: true, pattern: ID_RE });
  const version = checkString(raw, "version", errors, { required: true });
  const title = checkString(raw, "title", errors, { required: true });
  const description = checkString(raw, "description", errors);

  let targets: DocxImportRecipeV1["targets"] = [];
  if (!Array.isArray(raw.targets) || raw.targets.length === 0) {
    errors.push(`Field "targets" must be a non-empty array of "cloud" | "data-center".`);
  } else {
    for (const t of raw.targets) {
      if (t !== "cloud" && t !== "data-center") errors.push(`Unknown target "${String(t)}".`);
    }
    targets = raw.targets as DocxImportRecipeV1["targets"];
  }

  let options: DocxImportOptionsV1 | undefined;
  if (raw.options !== undefined) {
    if (!isPlainObject(raw.options)) errors.push(`Field "options" must be a mapping.`);
    else {
      rejectUnknownKeys(raw.options, OPTION_KEYS, "options.", errors);
      options = raw.options as DocxImportOptionsV1;
    }
  }

  let overrides: DocxImportRecipeV1["overrides"];
  if (raw.overrides !== undefined) {
    if (!isPlainObject(raw.overrides)) errors.push(`Field "overrides" must be a mapping.`);
    else {
      rejectUnknownKeys(raw.overrides, OVERRIDE_KEYS, "overrides.", errors);
      const sm = (raw.overrides as Record<string, unknown>).styleMappings;
      if (sm !== undefined) {
        if (!isPlainObject(sm)) errors.push(`Field "overrides.styleMappings" must be a mapping.`);
        else {
          for (const [key, value] of Object.entries(sm)) {
            if (typeof value !== "string" || !STYLE_MAPPING_TARGETS.includes(value as StyleMappingTarget)) {
              errors.push(
                `overrides.styleMappings["${key}"]: unknown target ${JSON.stringify(value)} (allowed: ${STYLE_MAPPING_TARGETS.join(", ")}).`,
              );
            }
          }
        }
      }
      overrides = raw.overrides as DocxImportRecipeV1["overrides"];
    }
  }

  let metadata: DocxImportRecipeV1["metadata"];
  if (raw.metadata !== undefined) {
    if (!isPlainObject(raw.metadata)) errors.push(`Field "metadata" must be a mapping.`);
    else {
      rejectUnknownKeys(raw.metadata, METADATA_KEYS, "metadata.", errors);
      metadata = raw.metadata as DocxImportRecipeV1["metadata"];
    }
  }

  if (errors.length > 0) return { errors };

  const recipe: DocxImportRecipeV1 = {
    schema: RECIPE_SCHEMA,
    id: id!,
    version: version!,
    title: title!,
    ...(description ? { description } : {}),
    targets,
    ...(options ? { options } : {}),
    ...(overrides ? { overrides } : {}),
    ...(metadata ? { metadata } : {}),
  };
  const digest = await sha256Hex(new TextEncoder().encode(canonicalRecipeJson(recipe)));
  return {
    parsed: {
      recipe,
      digest,
      policyLayer: {
        options: recipe.options,
        styleMappings: recipe.overrides?.styleMappings,
      },
    },
    errors: [],
  };
}

/** Canonical JSON: recursively sorted keys, so digests are byte-stable. */
export function canonicalRecipeJson(recipe: DocxImportRecipeV1): string {
  const sortValue = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(sortValue);
    if (isPlainObject(value)) {
      return Object.fromEntries(
        Object.keys(value)
          .sort()
          .map((key) => [key, sortValue(value[key])]),
      );
    }
    return value;
  };
  return JSON.stringify(sortValue(recipe));
}

/** Applicability check against the (Cloud-only) slice target. */
export function recipeApplicability(recipe: DocxImportRecipeV1, target: "cloud" | "data-center"): string | undefined {
  return recipe.targets.includes(target)
    ? undefined
    : `Recipe "${recipe.id}" targets [${recipe.targets.join(", ")}], not ${target}.`;
}
