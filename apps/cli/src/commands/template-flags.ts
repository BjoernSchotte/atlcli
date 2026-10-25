/**
 * The template flags every templated operation shares: --var, --vars-file,
 * --now and --strict. Prompts only for declared required variables, and only
 * at an interactive terminal; otherwise it fails listing what is missing.
 */
import { readFile } from "node:fs/promises";
import {
  ERROR_CODES,
  fail,
  getFlag,
  getFlags,
  checkFieldValue,
  createTemplateScope,
  hasFlag,
  isInteractive,
  parseVarsFile,
  promptInput,
  RenderBudget,
  renderBody,
  resolveTemplateValues,
  type OutputOptions,
  type TemplateVariable,
  type VarsFile,
} from "@atlcli/core";
import type { ScriptPort } from "@atlcli/script-runtime";

type Flags = Record<string, string | boolean | string[]>;

export interface TemplateRunInput {
  values: Record<string, unknown>;
  declarations: TemplateVariable[];
  /** Frozen clock for built-ins (--now, else the time of parsing). */
  now: Date;
  strict: boolean;
  /** --var or --vars-file was given. */
  requested: boolean;
  /** Declared required variables without a value. */
  missing: TemplateVariable[];
}

export const TEMPLATE_FLAGS_HELP = `Templates:
  --var <name=value>     Template variable, repeatable (a.b=v nests; JSON values allowed)
  --vars-file <file>     YAML file with values (and optional variables: declarations)
  --now <iso>            Freeze the clock for @today/@now (repeat a plan exactly)
  --strict               Fail on any template warning (unresolved {{…}} and others)`;

/** `key` alone is true, JSON values are parsed, anything else is a string; `a.b=v` nests. */
export function parseVarAssignments(assignments: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const assignment of assignments) {
    const eq = assignment.indexOf("=");
    const key = eq === -1 ? assignment : assignment.slice(0, eq);
    let value: unknown = true;
    if (eq !== -1) {
      const raw = assignment.slice(eq + 1);
      try {
        value = JSON.parse(raw);
      } catch {
        value = raw;
      }
    }
    const parts = key.split(".");
    let node = out;
    for (const part of parts.slice(0, -1)) {
      const next = node[part];
      node = (next && typeof next === "object" && !Array.isArray(next) ? next : (node[part] = {})) as Record<string, unknown>;
    }
    node[parts.at(-1)!] = value;
  }
  return out;
}

export async function parseTemplateFlags(
  flags: Flags,
  opts: OutputOptions,
  extra: { declarations?: TemplateVariable[] } = {},
): Promise<TemplateRunInput> {
  const path = getFlag(flags, "vars-file");
  let file: VarsFile | undefined;
  if (path) {
    try {
      file = parseVarsFile(await readFile(path, "utf8"));
    } catch (error) {
      fail(opts, 1, ERROR_CODES.USAGE, `--vars-file ${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const nowFlag = getFlag(flags, "now");
  const now = nowFlag ? new Date(nowFlag) : new Date();
  if (Number.isNaN(now.getTime())) fail(opts, 1, ERROR_CODES.USAGE, `--now expects an ISO date or datetime, got "${nowFlag}"`);
  const assignments = getFlags(flags, "var");
  const resolved = resolveTemplateValues({ cli: parseVarAssignments(assignments), file, declarations: extra.declarations });
  if (resolved.errors.length > 0) fail(opts, 1, ERROR_CODES.USAGE, resolved.errors.join("\n"));
  return {
    values: resolved.values,
    declarations: resolved.declarations,
    now,
    strict: hasFlag(flags, "strict"),
    requested: Boolean(path) || assignments.length > 0,
    missing: resolved.missing,
  };
}

export async function completeTemplateValues(input: TemplateRunInput, flags: Flags, opts: OutputOptions): Promise<TemplateRunInput> {
  if (input.missing.length === 0) return input;
  const label = (v: TemplateVariable) => `${v.name}${v.description ? ` (${v.description})` : ""}`;
  if (opts.json || hasFlag(flags, "yes") || !isInteractive()) {
    fail(
      opts,
      1,
      ERROR_CODES.USAGE,
      `Missing required template variables: ${input.missing.map(label).join(", ")}. Pass --var name=value or --vars-file.`,
    );
  }
  const values = { ...input.values };
  for (const v of input.missing) {
    const answer = await promptInput(`${label(v)}: `);
    const r = resolveTemplateValues({ cli: { [v.name]: answer }, declarations: [v] });
    if (r.errors.length > 0) fail(opts, 1, ERROR_CODES.USAGE, r.errors.join("\n"));
    values[v.name] = r.values[v.name];
  }
  return { ...input, values, missing: [] };
}

/**
 * The script runtime's `render` port operation over the core engine. One
 * budget per renderer, so a run shares the 16 MB output limit.
 */
export function createTemplateRenderer(profile?: string): NonNullable<ScriptPort["render"]> {
  const budget = new RenderBudget();
  return (input, o) => {
    const scope = createTemplateScope({ vars: o.vars, now: new Date(o.now), profile, source: o.source, parent: o.parent, seed: o.unit });
    const out = renderBody(input, scope, { unit: o.unit, format: o.format, strict: o.strict, budget });
    // Field checks at plan time, so an invalid label fails the plan, not the apply halfway through.
    if (o.kind && typeof out.value === "string" && out.value !== input) checkFieldValue(o.kind, out.value, o.unit);
    return out;
  };
}

/** The script runtime's `templating` option. */
export function templateValuesFrom(input: TemplateRunInput): { vars: Record<string, unknown>; now: string; strict: boolean } {
  return { vars: input.values, now: input.now.toISOString(), strict: input.strict };
}
