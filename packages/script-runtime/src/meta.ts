import { z } from "zod";

/** Project and space keys as Jira/Confluence issue them. */
const KEY = "[A-Z][A-Z0-9_]*";

/**
 * Default-deny capability declarations. Write grants are bound to one Jira
 * project or Confluence space. They only narrow what the script may attempt;
 * the executing user's or profile's own permissions always still apply.
 */
export const PERMISSION_PATTERN = new RegExp(`^(jira|confluence):(read|write:${KEY})$`);

export type ScriptPermission = `jira:read` | `jira:write:${string}` | `confluence:read` | `confluence:write:${string}`;

const paramSpec = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("string"), default: z.string().optional(), description: z.string().optional() }),
  z.strictObject({ type: z.literal("number"), default: z.number().optional(), description: z.string().optional() }),
  z.strictObject({ type: z.literal("boolean"), default: z.boolean().optional(), description: z.string().optional() }),
]);

export const DEFAULT_MAX_WRITES = 100;

export const scriptMetaSchema = z.strictObject({
  name: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "use lowercase letters, digits and dashes"),
  description: z.string().optional(),
  permissions: z
    .array(z.string().regex(PERMISSION_PATTERN, "expected jira:read, jira:write:<PROJECT>, confluence:read or confluence:write:<SPACE>"))
    .transform((list) => [...new Set(list)] as ScriptPermission[]),
  limits: z.strictObject({ maxWrites: z.number().int().positive().optional() }).optional(),
  params: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), paramSpec).optional(),
});

export type ScriptMeta = z.output<typeof scriptMetaSchema>;
export type ScriptParamSpec = z.output<typeof paramSpec>;
export type ScriptParams = Record<string, string | number | boolean>;

/** Validates a script's `meta` export. Messages name the offending path. */
export function parseScriptMeta(value: unknown): ScriptMeta {
  if (value === null || value === undefined) {
    throw new Error("A script must export `meta` with at least `name` and `permissions`");
  }
  const result = scriptMetaSchema.safeParse(value);
  if (!result.success) {
    const issue = result.error.issues[0]!;
    const path = ["meta", ...issue.path].join(".");
    throw new Error(`Invalid ${path}: ${issue.message}`);
  }
  return result.data;
}

/**
 * Resolves raw parameter input (CLI strings or typed values) against the
 * declared `meta.params`: coerces by type, applies defaults, rejects unknown,
 * missing and mistyped values.
 */
export function resolveScriptParams(meta: ScriptMeta, raw: Readonly<Record<string, unknown>> = {}): ScriptParams {
  const specs = meta.params ?? {};
  for (const name of Object.keys(raw)) {
    if (!Object.hasOwn(specs, name)) throw new Error(`Unknown parameter: ${name}`);
  }
  const params: ScriptParams = {};
  for (const [name, spec] of Object.entries(specs)) {
    const value = Object.hasOwn(raw, name) ? coerce(name, spec, raw[name]) : spec.default;
    if (value === undefined) throw new Error(`Missing required parameter: ${name}`);
    params[name] = value;
  }
  return params;
}

function coerce(name: string, spec: ScriptParamSpec, value: unknown): string | number | boolean {
  if (typeof value === spec.type) return value as string | number | boolean;
  if (typeof value === "string") {
    if (spec.type === "number" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
    if (spec.type === "boolean" && (value === "true" || value === "false")) return value === "true";
  }
  throw new Error(`Parameter ${name} must be a ${spec.type}`);
}

export function maxWritesOf(meta: ScriptMeta): number {
  return meta.limits?.maxWrites ?? DEFAULT_MAX_WRITES;
}
