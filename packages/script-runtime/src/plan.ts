import { canonicalJsonV1, digestCanonicalJsonV1, sha256HexV1 } from "@atlcli/change-set";
import { z } from "zod";
import { scriptMetaSchema, type ScriptMeta, type ScriptParams } from "./meta.js";
import { WRITE_VERBS, type PlannedOperation, type ScriptRunPlan, type SkippedWrite } from "./verbs.js";

export const SCRIPT_PLAN_SCHEMA_V1 = "atlcli.script-plan/1" as const;

/**
 * A reviewable, portable record of what a script run wants to change. It
 * names the target site and profile but never carries credentials. `digest`
 * is SHA-256 over the canonical JSON of every other field, so apply can tell
 * the reviewed plan from a modified one.
 */
export interface ScriptPlanV1 {
  schema: typeof SCRIPT_PLAN_SCHEMA_V1;
  createdAt: string;
  script: { name: string; path?: string; sha256: string; meta: ScriptMeta };
  params: ScriptParams;
  target: { baseUrl: string; profile?: string };
  operations: PlannedOperation[];
  /** Writes left out because they would change nothing. */
  skipped: SkippedWrite[];
  /** The default export's return value, for summaries. */
  value: unknown;
  digest: string;
}

export interface CreateScriptPlanOptions {
  /** Script source as run (before type stripping is fine; it is only hashed). */
  source: string;
  path?: string;
  /** Plan name when meta has none; defaults to the file name, else "script". */
  name?: string;
  baseUrl: string;
  profile?: string;
  now?: Date;
}

export class ScriptPlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScriptPlanError";
  }
}

const sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const key = z.string().min(1);
const precondition = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("jira-issue-unchanged"), key, updated: key }),
  z.strictObject({ kind: z.literal("jira-sprint-unchanged"), id: z.number().int().positive(), state: z.enum(["future", "active", "closed"]) }),
  z.strictObject({ kind: z.literal("confluence-page-unchanged"), id: key, version: z.number().int().positive() }),
  z.strictObject({ kind: z.literal("confluence-title-absent"), spaceKey: key, title: key }),
]);
const operation = z.strictObject({
  seq: z.number().int().positive(),
  verb: z.enum(WRITE_VERBS),
  args: z.record(z.string(), z.unknown()),
  precondition: precondition.optional(),
  dependsOn: z.array(z.number().int().positive()),
});
const planSchema = z.strictObject({
  schema: z.literal(SCRIPT_PLAN_SCHEMA_V1),
  createdAt: z.iso.datetime(),
  script: z.strictObject({ name: key, path: z.string().optional(), sha256, meta: scriptMetaSchema }),
  params: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
  target: z.strictObject({ baseUrl: z.url(), profile: z.string().optional() }),
  operations: z.array(operation),
  skipped: z.array(
    z.strictObject({ verb: operation.shape.verb, target: key, title: z.string().optional(), reason: z.literal("unchanged") }),
  ),
  value: z.unknown(),
  digest: sha256,
});

export async function createScriptPlan(run: ScriptRunPlan, options: CreateScriptPlanOptions): Promise<ScriptPlanV1> {
  const body: Omit<ScriptPlanV1, "digest"> = {
    schema: SCRIPT_PLAN_SCHEMA_V1,
    createdAt: (options.now ?? new Date()).toISOString(),
    script: {
      name: run.meta.name ?? options.name ?? scriptNameFromPath(options.path) ?? "script",
      ...(options.path ? { path: options.path } : {}),
      sha256: await sha256HexV1(new TextEncoder().encode(options.source)),
      meta: run.meta,
    },
    params: run.params,
    target: { baseUrl: normalizeBaseUrl(options.baseUrl), ...(options.profile ? { profile: options.profile } : {}) },
    operations: run.operations,
    skipped: run.skipped,
    value: run.value,
  };
  return { ...body, digest: await digestCanonicalJsonV1(body) };
}

/** Stable text form: canonical JSON (sorted keys), so equal plans are equal bytes. */
export function serializeScriptPlan(plan: ScriptPlanV1): string {
  return canonicalJsonV1(plan) + "\n";
}

/**
 * Parses untrusted plan input (file contents or a parsed value) and verifies
 * schema, internal consistency and digest. Throws ScriptPlanError.
 */
export async function parseScriptPlan(input: string | unknown): Promise<ScriptPlanV1> {
  let value: unknown = input;
  if (typeof input === "string") {
    try {
      value = JSON.parse(input);
    } catch {
      throw new ScriptPlanError("Plan is not valid JSON");
    }
  }
  const parsed = planSchema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    throw new ScriptPlanError(`Invalid plan at ${["plan", ...issue.path].join(".")}: ${issue.message}`);
  }
  const plan = parsed.data as ScriptPlanV1;
  plan.operations.forEach((op, index) => {
    if (op.seq !== index + 1) throw new ScriptPlanError(`Invalid plan: operation ${index + 1} has seq ${op.seq}`);
    for (const dep of op.dependsOn) {
      if (dep >= op.seq) throw new ScriptPlanError(`Invalid plan: operation ${op.seq} depends on later operation ${dep}`);
    }
  });
  const { digest, ...body } = plan;
  if ((await digestCanonicalJsonV1(body)) !== digest) {
    throw new ScriptPlanError("Plan digest mismatch: the plan was modified after it was created");
  }
  return plan;
}

function scriptNameFromPath(path: string | undefined): string | undefined {
  const base = path?.split(/[\\/]/).pop()?.replace(/\.[^.]+$/, "");
  return base || undefined;
}

export function normalizeBaseUrl(url: string): string {
  return url.replace(/\/+$/, "");
}
