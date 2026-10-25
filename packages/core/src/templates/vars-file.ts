/**
 * `--vars-file`: one YAML file for values and optional declarations, shared
 * by every templated operation. Without top-level `variables:`/`values:` the
 * whole file is values.
 */
import { parse } from "yaml";
import type { TemplateVariable, VariableType } from "./types.js";
import { validateVariableValue } from "./validation.js";

export interface VarsFile {
  variables: TemplateVariable[];
  values: Record<string, unknown>;
}

const TYPES: readonly VariableType[] = ["string", "number", "date", "boolean", "select"];
const isMapping = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

export function parseVarsFile(yamlText: string): VarsFile {
  const doc: unknown = parse(yamlText) ?? {};
  if (!isMapping(doc)) throw new Error("a vars file must be a YAML mapping");
  const full = "variables" in doc || "values" in doc;
  const values = full ? (doc.values ?? {}) : doc;
  const declared = full ? (doc.variables ?? {}) : {};
  if (!isMapping(values)) throw new Error("values must be a mapping");
  if (!isMapping(declared)) throw new Error("variables must be a mapping");
  const variables = Object.entries(declared).map(([name, raw]): TemplateVariable => {
    const d = isMapping(raw) ? raw : {};
    const type = (d.type ?? "string") as VariableType;
    if (!TYPES.includes(type)) throw new Error(`variable ${name} has unknown type "${String(d.type)}" (use ${TYPES.join(", ")})`);
    if (type === "select" && !Array.isArray(d.options)) throw new Error(`select variable ${name} needs options`);
    return {
      name,
      type,
      ...(d.required === true ? { required: true } : {}),
      ...(d.default !== undefined ? { default: String(d.default) } : {}),
      ...(typeof d.description === "string" ? { description: d.description } : {}),
      ...(Array.isArray(d.options) ? { options: d.options.map(String) } : {}),
    };
  });
  return { variables, values };
}

/**
 * Precedence: `cli` > file values > declared default. Declared values are
 * converted to their type; a declared required variable without a value is
 * `missing`. File declarations win over the operation's (`declarations`).
 */
export function resolveTemplateValues(input: { cli: Record<string, unknown>; file?: VarsFile; declarations?: TemplateVariable[] }): {
  values: Record<string, unknown>;
  missing: TemplateVariable[];
  errors: string[];
  declarations: TemplateVariable[];
} {
  const byName = new Map<string, TemplateVariable>();
  for (const d of input.declarations ?? []) byName.set(d.name, d);
  for (const d of input.file?.variables ?? []) byName.set(d.name, d);
  const given: Record<string, unknown> = { ...(input.file?.values ?? {}), ...input.cli };
  const values: Record<string, unknown> = {};
  const missing: TemplateVariable[] = [];
  const errors: string[] = [];
  for (const [name, value] of Object.entries(given)) {
    const d = byName.get(name);
    if (!d || (value !== null && typeof value === "object")) {
      values[name] = value;
      continue;
    }
    const r = validateVariableValue(value, d);
    if (r.valid) values[name] = r.coerced;
    else errors.push(r.error ?? `Invalid value for ${name}`);
  }
  for (const d of byName.values()) {
    if (d.name in given) continue;
    if (d.default !== undefined) values[d.name] = validateVariableValue(d.default, d).coerced;
    else if (d.required) missing.push(d);
  }
  return { values, missing, errors, declarations: [...byName.values()] };
}

/** Names given or declared but never used, so a `--var` typo shows up. */
export function unusedVariables(values: Record<string, unknown>, declarations: TemplateVariable[], used: Set<string>): string[] {
  const names = new Set([...Object.keys(values), ...declarations.map((d) => d.name)]);
  return [...names].filter((n) => !used.has(n)).sort();
}
