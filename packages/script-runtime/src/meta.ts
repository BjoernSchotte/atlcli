import { z } from "zod";
import { runScript, ScriptError, type RunScriptOptions } from "./sandbox.js";

/** Project and space keys as Jira/Confluence issue them. */
const KEY = "[A-Z][A-Z0-9_]*";

/**
 * Optional capability declarations. Without `permissions` a script may call
 * every verb (writes are still only planned). With them, everything not listed
 * is denied; write grants are bound to one Jira project or Confluence space.
 * The executing user's or profile's own permissions always still apply.
 */
export const PERMISSION_PATTERN = new RegExp(`^(jira|confluence):(read|write:${KEY})$`);

export type ScriptPermission = `jira:read` | `jira:write:${string}` | `confluence:read` | `confluence:write:${string}`;

const paramSpec = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("string"), default: z.string().optional(), description: z.string().optional() }),
  z.strictObject({ type: z.literal("number"), default: z.number().optional(), description: z.string().optional() }),
  z.strictObject({ type: z.literal("boolean"), default: z.boolean().optional(), description: z.string().optional() }),
]);

export const DEFAULT_MAX_WRITES = 10_000;

export const scriptMetaSchema = z.strictObject({
  name: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "use lowercase letters, digits and dashes").optional(),
  description: z.string().optional(),
  permissions: z
    .array(z.string().regex(PERMISSION_PATTERN, "expected jira:read, jira:write:<PROJECT>, confluence:read or confluence:write:<SPACE>"))
    .transform((list) => [...new Set(list)] as ScriptPermission[])
    .optional(),
  limits: z.strictObject({ maxWrites: z.number().int().positive().optional() }).optional(),
  params: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), paramSpec).optional(),
});

export type ScriptMeta = z.output<typeof scriptMetaSchema>;
export type ScriptParamSpec = z.output<typeof paramSpec>;
export type ScriptParams = Record<string, string | number | boolean>;

/** Validates a script's `meta` (absent means `{}`). Messages name the offending path. */
export function parseScriptMeta(value: unknown): ScriptMeta {
  if (value === null || value === undefined) return {};
  const result = scriptMetaSchema.safeParse(value);
  if (!result.success) {
    const issue = result.error.issues[0]!;
    const path = ["meta", ...issue.path].join(".");
    throw new Error(`Invalid ${path}: ${issue.message}`);
  }
  return result.data;
}

/**
 * Resolves raw parameter input (CLI strings or typed values). Without declared
 * `meta.params` values pass through as given. With them: coerces by type,
 * applies defaults, rejects unknown, missing and mistyped values.
 */
export function resolveScriptParams(meta: ScriptMeta, raw: Readonly<Record<string, unknown>> = {}): ScriptParams {
  if (!meta.params) {
    const params: ScriptParams = {};
    for (const [name, value] of Object.entries(raw)) {
      if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
        throw new Error(`Parameter ${name} must be a string, number or boolean`);
      }
      params[name] = value;
    }
    return params;
  }
  const specs = meta.params;
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

const META_DECLARATION = /\bexport\s+const\s+meta\s*=\s*/;
const META_ELSEWHERE = /\bexport\s*\{[^}]*\bmeta\b|\bexport\s+(?:let|var)\s+meta\b|\bexport\s+const\s+meta\s*:/;

/**
 * Reads `export const meta = { … }` from the (type-stripped) source without
 * running the script, so declarations are validated before any code acts.
 * The initializer must be a self-contained literal; it is evaluated alone in
 * its own sandbox. Returns null when the script declares no meta.
 */
export async function extractScriptMeta(js: string, options: Pick<RunScriptOptions, "variant"> = {}): Promise<unknown> {
  const match = META_DECLARATION.exec(js);
  if (!match) {
    if (META_ELSEWHERE.test(js)) {
      throw new ScriptError("invalid-script", "Declare meta as `export const meta = { … }` at the top level of the script");
    }
    return null;
  }
  const start = match.index + match[0].length;
  if (js[start] !== "{") throw new ScriptError("invalid-script", "meta must be an object literal: export const meta = { … }");
  const literal = sliceBalanced(js, start);
  try {
    const result = await runScript(`export default (${literal});`, {
      variant: options.variant,
      limits: { deadlineMs: 1_000, memoryBytes: 8 * 1024 * 1024 },
    });
    return result.value;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ScriptError("invalid-script", `meta must be a self-contained literal (${message})`);
  }
}

/** The `{…}` starting at `start`, skipping strings and comments. */
function sliceBalanced(src: string, start: number): string {
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    const c = src[i];
    if (c === '"' || c === "'" || c === "`") {
      for (i++; i < src.length && src[i] !== c; i++) if (src[i] === "\\") i++;
    } else if (c === "/" && src[i + 1] === "/") {
      i = src.indexOf("\n", i);
      if (i < 0) break;
    } else if (c === "/" && src[i + 1] === "*") {
      i = src.indexOf("*/", i + 2) + 1;
      if (i <= 0) break;
    } else if (c === "{" || c === "[" || c === "(") {
      depth++;
    } else if (c === "}" || c === "]" || c === ")") {
      if (--depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new ScriptError("invalid-script", "meta object literal is not closed");
}
