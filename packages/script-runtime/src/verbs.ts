import { z } from "zod";
import { extractScriptMeta, maxWritesOf, parseScriptMeta, resolveScriptParams, type ScriptMeta, type ScriptParams } from "./meta.js";
import type { ConfluencePageView, ScriptPort } from "./port.js";
import { runScript, ScriptError, type HostFunction, type RunScriptOptions } from "./sandbox.js";

/**
 * Write verbs are never executed while a script runs. They are recorded as
 * operations of a plan; applying the plan is a separate step. Reads go live.
 */
export type WriteVerb =
  | "jira.create"
  | "jira.update"
  | "jira.transition"
  | "jira.comment"
  | "confluence.createPage"
  | "confluence.updatePage"
  | "confluence.addLabels";

/** State the target must still be in when the plan is applied. */
export type Precondition =
  | { kind: "jira-issue-unchanged"; key: string; updated: string }
  | { kind: "confluence-page-unchanged"; id: string; version: number }
  | { kind: "confluence-title-absent"; spaceKey: string; title: string };

export interface PlannedOperation {
  /** 1-based; results of this operation are referenced as `plan:<seq>`. */
  seq: number;
  verb: WriteVerb;
  /** Execution arguments; may contain `plan:<seq>` placeholders. */
  args: Record<string, unknown>;
  /** Only on the first write to an existing object; later writes depend on it instead. */
  precondition?: Precondition;
  /** Earlier operations whose results this one needs (placeholders, same object). */
  dependsOn: number[];
}

export interface PlanScriptOptions extends Pick<RunScriptOptions, "limits" | "onLog" | "variant"> {
  port: ScriptPort;
  /** Raw parameter input, resolved against `meta.params`. */
  params?: Readonly<Record<string, unknown>>;
  /** Overrides `meta.limits.maxWrites` (e.g. from `--max-writes`). */
  maxWrites?: number;
}

/** A write the plan left out because it would change nothing. */
export interface SkippedWrite {
  verb: WriteVerb;
  /** Page id or issue key. */
  target: string;
  title?: string;
  reason: "unchanged";
}

export interface ScriptRunPlan {
  meta: ScriptMeta;
  params: ScriptParams;
  /** The default export's return value. */
  value: unknown;
  operations: PlannedOperation[];
  skipped: SkippedWrite[];
  hostCalls: number;
}

const PLACEHOLDER = /^plan:(\d+)$/;
/** Object identities end in the target id; placeholders mean "created by this plan". */
const PLANNED_OBJECT = /:plan:\d+$/;
const ISSUE_KEY = /^([A-Z][A-Z0-9_]*)-\d+$/;
const SEARCH_PAGE_SIZE = 100;

const str = z.string().min(1);
const fieldsOpt = z.strictObject({ fields: z.array(str).optional() });
const jiraCreate = z.strictObject({
  project: str,
  type: str,
  summary: str,
  description: z.string().optional(),
  fields: z.record(z.string(), z.unknown()).optional(),
});
const jiraUpdate = z
  .strictObject({
    summary: str.optional(),
    description: z.string().optional(),
    fields: z.record(z.string(), z.unknown()).optional(),
  })
  .refine((u) => Object.keys(u).length > 0, "nothing to update");
const pageInput = z.strictObject({ space: str, title: str, markdown: z.string(), parentId: str.optional() });

/** One plan recording session; every verb closes over it. */
class Recorder {
  readonly operations: PlannedOperation[] = [];
  readonly skipped: SkippedWrite[] = [];
  /** Object identity → seq of the last operation that wrote it. */
  private readonly touched = new Map<string, number>();

  constructor(
    readonly port: ScriptPort,
    private readonly meta: ScriptMeta,
    private readonly maxWrites = maxWritesOf(meta),
  ) {}

  /** Without declared permissions every verb is allowed (writes are still only planned). */
  require(permission: string): void {
    if (this.meta.permissions && !this.meta.permissions.includes(permission as never)) {
      throw new ScriptError("permission-denied", `Script meta.permissions does not grant "${permission}"`);
    }
  }

  operation(seq: number): PlannedOperation {
    const op = this.operations[seq - 1];
    if (!op) throw new Error(`Unknown plan reference: plan:${seq}`);
    return op;
  }

  /** Seq of the operation that last wrote `object` in this plan, if any. */
  lastWrite(object: string): number | undefined {
    return this.touched.get(object);
  }

  /** Rejects reads of objects that only exist in the plan so far. */
  readable(id: string): string {
    if (PLACEHOLDER.test(id)) {
      throw new Error(`${id} is created by this plan and can only be read after it is applied`);
    }
    return id;
  }

  jiraProject(key: string): string {
    const ref = PLACEHOLDER.exec(key);
    if (ref) {
      const op = this.operation(Number(ref[1]));
      if (op.verb !== "jira.create") throw new Error(`${key} is not an issue created by this plan`);
      return op.args.project as string;
    }
    const match = ISSUE_KEY.exec(key);
    if (!match) throw new Error(`Invalid issue key: ${key}`);
    return match[1]!;
  }

  /** Space of a page, from the plan for placeholders or read live. */
  async confluencePage(id: string, signal: AbortSignal): Promise<{ spaceKey: string; title: string; live?: ConfluencePageView }> {
    const ref = PLACEHOLDER.exec(id);
    if (ref) {
      const op = this.operation(Number(ref[1]));
      if (op.verb !== "confluence.createPage") throw new Error(`${id} is not a page created by this plan`);
      return { spaceKey: op.args.spaceKey as string, title: op.args.title as string };
    }
    const live = await this.port.confluenceGetPage(id, { signal });
    return { spaceKey: live.spaceKey, title: live.title, live };
  }

  /**
   * Records a write. `object` identifies the target for chaining; `precondition`
   * is computed lazily and only for the first write to an existing object.
   */
  async record(
    verb: WriteVerb,
    args: Record<string, unknown>,
    object?: string,
    precondition?: () => Promise<Precondition | undefined>,
  ): Promise<number> {
    if (this.operations.length >= this.maxWrites) {
      throw new ScriptError(
        "write-limit",
        `Write limit exceeded (${this.maxWrites} writes; raise meta.limits.maxWrites or pass --max-writes)`,
      );
    }
    // Unknown or non-producing seqs in prose ("see plan:99") are just text.
    const dependsOn = new Set(placeholdersIn(args).filter((seq) => PRODUCERS.has(this.operations[seq - 1]?.verb as WriteVerb)));
    const previous = object ? this.touched.get(object) : undefined;
    if (previous) dependsOn.add(previous);
    for (const seq of dependsOn) this.operation(seq);
    const seq = this.operations.length + 1;
    const op: PlannedOperation = { seq, verb, args, dependsOn: [...dependsOn].sort((a, b) => a - b) };
    if (!previous && object && !PLANNED_OBJECT.test(object) && precondition) {
      const pre = await precondition();
      if (pre) op.precondition = pre;
    }
    this.operations.push(op);
    if (object) this.touched.set(object, seq);
    return seq;
  }
}

/** Operations whose result a `plan:<seq>` reference stands for (issue key, page id). */
export const PRODUCERS: ReadonlySet<WriteVerb> = new Set(["jira.create", "confluence.createPage"]);

/** `plan:<seq>` references, whole values or embedded in text (e.g. a page body naming a new issue). */
export const PLAN_REFERENCE = /\bplan:(\d+)\b/g;

function placeholdersIn(value: unknown): number[] {
  if (typeof value === "string") return [...value.matchAll(PLAN_REFERENCE)].map((m) => Number(m[1]));
  if (Array.isArray(value)) return value.flatMap(placeholdersIn);
  if (value && typeof value === "object") return Object.values(value).flatMap(placeholdersIn);
  return [];
}

type Verb = { args: z.ZodType<unknown[]>; run: (r: Recorder, args: never, signal: AbortSignal) => Promise<unknown> };

function verb<A extends unknown[]>(
  args: z.ZodType<A>,
  run: (r: Recorder, args: A, signal: AbortSignal) => Promise<unknown>,
): Verb {
  return { args: args as z.ZodType<unknown[]>, run: run as Verb["run"] };
}

const VERBS: Record<string, Verb> = {
  "jira.search": verb(
    z.tuple([str, z.strictObject({ fields: z.array(str).optional(), pageToken: str.optional() }).optional()]),
    async (r, [jql, options], signal) => {
      r.require("jira:read");
      return r.port.jiraSearch(jql, { ...options, maxResults: SEARCH_PAGE_SIZE, signal });
    },
  ),
  "jira.get": verb(z.tuple([str, fieldsOpt.optional()]), async (r, [key, options], signal) => {
    r.require("jira:read");
    return r.port.jiraGetIssue(r.readable(key), { ...options, signal });
  }),
  "jira.create": verb(z.tuple([jiraCreate]), async (r, [input]) => {
    r.require(`jira:write:${input.project}`);
    const seq = await r.record("jira.create", input);
    return { id: `plan:${seq}`, key: `plan:${seq}` };
  }),
  "jira.update": verb(z.tuple([str, jiraUpdate]), async (r, [key, input], signal) => {
    r.require(`jira:write:${r.jiraProject(key)}`);
    await r.record("jira.update", { key, ...input }, `jira:${key}`, () => issueUnchanged(r, key, signal));
    return null;
  }),
  "jira.transition": verb(z.tuple([str, str]), async (r, [key, transition], signal) => {
    r.require(`jira:write:${r.jiraProject(key)}`);
    if (!PLACEHOLDER.test(key)) {
      const available = await r.port.jiraGetTransitions(key, { signal });
      if (!available.some((name) => name.toLowerCase() === transition.toLowerCase())) {
        throw new Error(`Transition "${transition}" is not available for ${key} (available: ${available.join(", ") || "none"})`);
      }
    }
    await r.record("jira.transition", { key, transition }, `jira:${key}`, () => issueUnchanged(r, key, signal));
    return null;
  }),
  "jira.comment": verb(z.tuple([str, z.string().min(1)]), async (r, [key, markdown]) => {
    r.require(`jira:write:${r.jiraProject(key)}`);
    const seq = await r.record("jira.comment", { key, markdown });
    return { id: `plan:${seq}` };
  }),
  "confluence.search": verb(
    z.tuple([str, z.strictObject({ cursor: str.optional() }).optional()]),
    async (r, [cql, options], signal) => {
      r.require("confluence:read");
      return r.port.confluenceSearch(cql, { ...options, limit: SEARCH_PAGE_SIZE, signal });
    },
  ),
  "confluence.getPage": verb(z.tuple([str]), async (r, [id], signal) => {
    r.require("confluence:read");
    return r.port.confluenceGetPage(r.readable(id), { signal });
  }),
  "confluence.createPage": verb(z.tuple([pageInput]), async (r, [input], signal) => {
    r.require(`confluence:write:${input.space}`);
    return { id: `plan:${await createPage(r, input)}` };
  }),
  "confluence.updatePage": verb(
    z.tuple([str, z.strictObject({ title: str.optional(), markdown: z.string() })]),
    async (r, [id, input], signal) => {
      const page = await r.confluencePage(id, signal);
      r.require(`confluence:write:${page.spaceKey}`);
      await updatePage(r, id, input.title ?? page.title, input.markdown, page.live);
      return { id };
    },
  ),
  "confluence.upsertPage": verb(z.tuple([pageInput]), async (r, [input], signal) => {
    r.require(`confluence:write:${input.space}`);
    const planned = r.lastWrite(titleObject(input.space, input.title));
    if (planned) {
      await updatePage(r, `plan:${planned}`, input.title, input.markdown);
      return { id: `plan:${planned}`, created: true };
    }
    const existing = await r.port.confluenceFindPage(input.space, input.title, { signal });
    if (!existing) return { id: `plan:${await createPage(r, input)}`, created: true };
    const live = await r.port.confluenceGetPage(existing.id, { signal });
    await updatePage(r, existing.id, input.title, input.markdown, live);
    return { id: existing.id, created: false };
  }),
  "confluence.addLabels": verb(z.tuple([str, z.array(str).min(1)]), async (r, [pageId, labels], signal) => {
    const page = await r.confluencePage(pageId, signal);
    r.require(`confluence:write:${page.spaceKey}`);
    await r.record("confluence.addLabels", { pageId, labels }, `confluence:${pageId}`);
    return null;
  }),
};

async function issueUnchanged(r: Recorder, key: string, signal: AbortSignal): Promise<Precondition> {
  const issue = await r.port.jiraGetIssue(key, { fields: ["updated"], signal });
  return { kind: "jira-issue-unchanged", key, updated: issue.fields.updated };
}

const titleObject = (space: string, title: string) => `confluence-title:${space}\u0000${title}`;

function createPage(r: Recorder, input: z.output<typeof pageInput>): Promise<number> {
  if (r.lastWrite(titleObject(input.space, input.title))) {
    throw new Error(`Page "${input.title}" in ${input.space} is already created by this plan; use updatePage or upsertPage`);
  }
  const args = { spaceKey: input.space, title: input.title, markdown: input.markdown, ...(input.parentId ? { parentId: input.parentId } : {}) };
  return r.record("confluence.createPage", args, titleObject(input.space, input.title), async () => ({
    kind: "confluence-title-absent",
    spaceKey: input.space,
    title: input.title,
  }));
}

async function updatePage(r: Recorder, id: string, title: string, markdown: string, live?: ConfluencePageView): Promise<void> {
  // Reads show the state before the plan, so only a page the plan has not
  // written yet can be compared; after an earlier write, A → B → A is real.
  const untouched = live && r.lastWrite(`confluence:${id}`) === undefined;
  if (untouched && live.title === title && r.port.confluenceNormalizeMarkdown(markdown) === live.markdown) {
    r.skipped.push({ verb: "confluence.updatePage", target: id, title, reason: "unchanged" });
    return;
  }
  await r.record("confluence.updatePage", { id, title, markdown }, `confluence:${id}`, async () =>
    live ? { kind: "confluence-page-unchanged", id, version: live.version } : undefined,
  );
}

/** Guest-side shims: search verbs become async iterators with an optional `limit`. */
const WRAPPERS: Record<string, string> = {
  "jira.search": pagedIterator("issues", "pageToken", "nextPageToken"),
  "confluence.search": pagedIterator("results", "cursor", "nextCursor"),
};

function pagedIterator(items: string, tokenIn: string, tokenOut: string): string {
  return `(page) => async function* (query, options) {
  const { limit = Infinity, ...rest } = options ?? {};
  let token, n = 0;
  do {
    const r = await page(query, token === undefined ? rest : { ...rest, ${tokenIn}: token });
    for (const item of r.${items}) { if (n >= limit) return; n++; yield item; }
    token = r.${tokenOut} ?? undefined;
  } while (token !== undefined && n < limit);
}`;
}

/** Names of all `atlcli.*` functions a script can call. */
export const SCRIPT_VERBS = Object.freeze(Object.keys(VERBS));

/**
 * Runs a script in plan mode: reads go live through `port`, writes are
 * recorded as operations with preconditions. Nothing is written. `meta` is
 * read and validated before any script code runs.
 */
export async function planScript(js: string, options: PlanScriptOptions): Promise<ScriptRunPlan> {
  const meta = parseMetaOrThrow(await extractScriptMeta(js, { variant: options.variant }));
  let params: ScriptParams;
  try {
    params = resolveScriptParams(meta, options.params);
  } catch (error) {
    throw new ScriptError("invalid-script", error instanceof Error ? error.message : String(error));
  }
  const recorder = new Recorder(options.port, meta, options.maxWrites ?? maxWritesOf(meta));
  const host: Record<string, HostFunction> = {};
  for (const [name, definition] of Object.entries(VERBS)) {
    host[name] = async (rawArgs, signal) => {
      const parsed = definition.args.safeParse(trimTrailingNulls(rawArgs));
      if (!parsed.success) {
        const issue = parsed.error.issues[0]!;
        throw new TypeError(`Invalid arguments for atlcli.${name}: ${[...issue.path].join(".") || "args"}: ${issue.message}`);
      }
      return definition.run(recorder, parsed.data as never, signal);
    };
  }
  const result = await runScript(js, {
    host,
    wrappers: WRAPPERS,
    params,
    limits: options.limits,
    onLog: options.onLog,
    variant: options.variant,
  });
  return {
    meta,
    params,
    value: result.value,
    operations: recorder.operations,
    skipped: recorder.skipped,
    hostCalls: result.hostCalls,
  };
}

/** Reads and validates a script's `meta` without running any script code. */
export async function inspectScript(js: string, options: Pick<RunScriptOptions, "variant"> = {}): Promise<ScriptMeta> {
  return parseMetaOrThrow(await extractScriptMeta(js, options));
}

function parseMetaOrThrow(raw: unknown): ScriptMeta {
  try {
    return parseScriptMeta(raw);
  } catch (error) {
    throw new ScriptError("invalid-script", error instanceof Error ? error.message : String(error));
  }
}

/** Optional trailing arguments arrive as JSON null; tuples expect them absent. */
function trimTrailingNulls(args: unknown[]): unknown[] {
  let end = args.length;
  while (end > 0 && args[end - 1] === null) end--;
  return args.slice(0, end);
}
