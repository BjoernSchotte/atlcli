import { z } from "zod";
import { maxWritesOf, type ScriptMeta, type ScriptParams } from "./meta.js";
import type { ConfluencePageView, JiraBoardView, JiraFieldView, JiraLinkType, JiraSprintState, JiraUserRef, ScriptPort, TemplateWarningView } from "./port.js";
import { ScriptError, type RunScriptOptions } from "./sandbox.js";

/**
 * Write verbs are never executed while a script runs. They are recorded as
 * operations of a plan; applying the plan is a separate step. Reads go live.
 */
export const WRITE_VERBS = [
  "jira.create",
  "jira.update",
  "jira.transition",
  "jira.setStatus",
  "jira.comment",
  "jira.link",
  "jira.assign",
  "jira.addWatcher",
  "jira.removeWatcher",
  "jira.notify",
  "jira.addLabels",
  "jira.removeLabels",
  "jira.attach",
  "jira.copyAttachment",
  "jira.createSprint",
  "jira.updateSprint",
  "jira.moveToSprint",
  "confluence.createPage",
  "confluence.updatePage",
  "confluence.addLabels",
  "confluence.removeLabels",
  "confluence.comment",
  "confluence.movePage",
  "confluence.deletePage",
  "confluence.archivePage",
  "confluence.attach",
  "confluence.export",
  "confluence.copyAttachment",
  "jira.request",
  "jira.updateComment",
  "jira.deleteComment",
  "jira.addWorklog",
  "jira.createVersion",
  "jira.updateVersion",
  "jira.createComponent",
  "jira.updateComponent",
  "jira.rank",
  "jira.deleteIssue",
  "jira.clone",
  "jira.unlink",
  "confluence.request",
  "confluence.setProperty",
  "confluence.deleteProperty",
  "confluence.setRestrictions",
  "confluence.createBlogPost",
  "confluence.removeSpaceAccess",
  "jira.removeRoleActor",
  "jira.deletePermissionGrant",
  "http.request",
  "files.write",
  "state.set",
  "state.delete",
] as const;

export type WriteVerb = (typeof WRITE_VERBS)[number];

/** State the target must still be in when the plan is applied. */
export type Precondition =
  | { kind: "jira-issue-unchanged"; key: string; updated: string }
  | { kind: "jira-attachment-unchanged"; id: string; size: number }
  | { kind: "jira-sprint-unchanged"; id: number; state: JiraSprintState }
  | { kind: "confluence-page-unchanged"; id: string; version: number }
  | { kind: "confluence-title-absent"; spaceKey: string; title: string }
  /** `digest`: SHA-256 of the value's canonical JSON as planned against; null when the key was unset. */
  | { kind: "state-unchanged"; store: string; key: string; digest: string | null };

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

export interface PlanScriptOptions extends Pick<RunScriptOptions, "limits" | "onLog" | "variant" | "item" | "items" | "entry" | "prelude" | "modules"> {
  /**
   * Reads only (audits): any write verb ends the run with permission-denied
   * and this explanation.
   */
  readOnly?: string;
  /** Refuses atlcli.output with this explanation (audit rules write no files). */
  noOutput?: string;
  /**
   * Shared across runs (per-issue mode): lookups that do not depend on the
   * issue, such as link types and users, are fetched once.
   */
  memo?: Map<string, Promise<unknown>>;
  port: ScriptPort;
  /** Raw parameter input, resolved against `meta.params`. */
  params?: Readonly<Record<string, unknown>>;
  /** Overrides `meta.limits.maxWrites` (e.g. from `--max-writes`). */
  maxWrites?: number;
  /** Template vars and the frozen clock for atlcli.render (CLI --var/--vars-file/--now/--strict). */
  templating?: Templating;
  /** Name of the script's state store (atlcli.state) when meta has no name: the file name. */
  name?: string;
}

export interface Templating {
  vars: Record<string, unknown>;
  /** ISO time today/now render as. */
  now: string;
  strict: boolean;
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
  /** Set when the run was given templating; recorded in the plan so a re-plan can repeat it. */
  templating?: { now: string; vars: Record<string, unknown> };
  /** Warnings from atlcli.render (unresolved {{…}} and others). */
  renderWarnings: TemplateWarningView[];
}

export const PLACEHOLDER = /^plan:(\d+)$/;
/** Object identities end in the target id; placeholders mean "created by this plan". */
export const PLANNED_OBJECT = /:plan:\d+$/;
export const ISSUE_KEY = /^([A-Z][A-Z0-9_]*)-\d+$/;

export const str = z.string().min(1);
export const id = z.number().int().positive();

/** Site-relative REST path; hosts check the product prefix (`/rest/`, `/api/v2/`). */
export const restPath = str.refine(
  (p) => p.startsWith("/") && !/[?#\\\u0000-\u001f]|%2[ef]/i.test(p) && !p.split("/").some((s) => s === ".." || s === "."),
  "a site-relative path like /rest/api/3/field, without query string or ..",
);
export const restOptions = z.strictObject({ query: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional() });
/** Largest REST response a script may receive (serialized JSON). */
export const MAX_REST_BYTES = 5 * 1024 * 1024;

export function capRest(value: unknown, path: string): unknown {
  const size = JSON.stringify(value ?? null).length;
  if (size > MAX_REST_BYTES) throw new Error(`Response of ${path} is ${size} bytes; the limit is ${MAX_REST_BYTES}. Page through it with query parameters.`);
  return value ?? null;
}

/** One plan recording session; every verb closes over it. */
export class Recorder {
  readonly operations: PlannedOperation[] = [];
  readonly skipped: SkippedWrite[] = [];
  /** Object identity → seq of the last operation that wrote it. */
  private readonly touched = new Map<string, number>();
  /** Pages this plan deletes; later writes to them are mistakes. */
  private readonly deleted = new Set<string>();
  /** Sprint ref → state after the plan's writes so far. */
  readonly sprintStates = new Map<string, JiraSprintState>();
  /** Sprint ref → dates after the plan's writes so far (starting needs both). */
  readonly sprintDates = new Map<string, { startDate?: string; endDate?: string }>();
  readonly exportPaths = new Set<string>();
  /** Local files this plan writes; a second write to one is a mistake. */
  readonly filePaths = new Set<string>();
  /** Why atlcli.output is not allowed in this run (audit rules); undefined allows it. */
  noOutput?: string;
  /** State keys this plan sets or deletes, with the value they will hold (undefined: deleted). */
  readonly stateWrites = new Map<string, unknown>();
  readonly renderWarnings: TemplateWarningView[] = [];
  /** Unnamed render calls so far (default unit names); `rendered` once any call ran. */
  renderCount = 0;
  rendered = false;
  private linkTypeList?: Promise<JiraLinkType[]>;
  private fieldList?: Promise<JiraFieldView[]>;

  constructor(
    readonly port: ScriptPort,
    readonly meta: ScriptMeta,
    private readonly maxWrites = maxWritesOf(meta),
    readonly templating: Templating = { vars: {}, now: new Date().toISOString(), strict: false },
    private readonly memo?: Map<string, Promise<unknown>>,
    private readonly readOnly?: string,
    /** atlcli.state store: meta.name, else the file name. */
    readonly store = "script",
  ) {}

  /**
   * Without declared permissions every Jira, Confluence and file verb is
   * allowed (writes are still only planned). `jira:write:*` and
   * `confluence:write:*` grant every project or space.
   */
  require(permission: string): void {
    const granted = this.meta.permissions;
    if (!granted || granted.includes(permission as never)) return;
    const write = /^(jira|confluence):write:/.exec(permission);
    if (write && granted.includes(`${write[1]}:write:*` as never)) return;
    throw new ScriptError("permission-denied", `Script meta.permissions does not grant "${permission}"`);
  }

  /** External HTTP is never implied: the host needs an `http:<host>` (or `http:*.<domain>`) grant. */
  requireHttp(host: string, port: string): void {
    const grants = (this.meta.permissions ?? []).filter((p) => p.startsWith("http:")).map((p) => p.slice(5));
    const ok = grants.some((grant) => {
      const [name, grantPort] = grant.split(":") as [string, string | undefined];
      if (grantPort !== undefined && grantPort !== port) return false;
      return name.startsWith("*.") ? host.endsWith(name.slice(1)) && host.length > name.length - 1 : host === name;
    });
    if (!ok) {
      throw new ScriptError("permission-denied", `HTTP to ${host}${port ? `:${port}` : ""} needs "http:${host}" in meta.permissions`);
    }
  }

  /** Write grants name a project; a board outside any project cannot be granted. */
  requireBoardWrite(board: JiraBoardView | undefined, what: string): void {
    if (board?.projectKey) return this.require(`jira:write:${board.projectKey}`);
    if (this.meta.permissions) {
      throw new ScriptError("permission-denied", `${what} belongs to no project, so meta.permissions cannot grant writes to it`);
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
      if (op.verb === "jira.clone") return (op.args.project as string | undefined) ?? this.jiraProject(op.args.key as string);
      if (op.verb !== "jira.create") throw new Error(`${key} is not an issue created by this plan`);
      return op.args.project as string;
    }
    const match = ISSUE_KEY.exec(key);
    if (!match) throw new Error(`Invalid issue key: ${key}`);
    return match[1]!;
  }

  linkTypes(signal: AbortSignal): Promise<JiraLinkType[]> {
    return (this.linkTypeList ??= this.memoized("linkTypes", () => this.port.jiraLinkTypes({ signal })));
  }

  /** The site's fields, fetched once per run (or job). */
  fields(signal: AbortSignal): Promise<JiraFieldView[]> {
    const load = this.port.jiraFields?.bind(this.port);
    if (!load) throw new Error("atlcli.jira.fields is not available on this host");
    return (this.fieldList ??= this.memoized("fields", () => load({ signal })));
  }

  findUser(query: string, signal: AbortSignal): Promise<JiraUserRef> {
    return this.memoized(`user:${query}`, () => this.port.jiraFindUser(query, { signal }));
  }

  /** Through the shared memo when there is one; failed lookups are not kept. */
  private memoized<T>(key: string, load: () => Promise<T>): Promise<T> {
    if (!this.memo) return load();
    let hit = this.memo.get(key) as Promise<T> | undefined;
    if (!hit) {
      hit = load();
      this.memo.set(key, hit);
      hit.catch(() => this.memo?.delete(key));
    }
    return hit;
  }

  /** Space of a page, from the plan for placeholders or read live. */
  async confluencePage(id: string, signal: AbortSignal): Promise<{ spaceKey: string; title: string; live?: ConfluencePageView }> {
    this.notDeleted(id);
    const ref = PLACEHOLDER.exec(id);
    if (ref) {
      const op = this.operation(Number(ref[1]));
      if (op.verb !== "confluence.createPage") throw new Error(`${id} is not a page created by this plan`);
      return { spaceKey: op.args.spaceKey as string, title: op.args.title as string };
    }
    const live = await this.port.confluenceGetPage(id, { signal });
    return { spaceKey: live.spaceKey, title: live.title, live };
  }

  markDeleted(id: string): void {
    this.deleted.add(id);
  }

  notDeleted(id: string): void {
    if (this.deleted.has(id)) throw new Error(`Page ${id} is deleted by this plan`);
  }

  /**
   * Records a write. `object` identifies the target for chaining; `precondition`
   * is computed lazily and only for the first write to an existing object.
   * Writes that do not change the object's own state (comments, labels,
   * attachments) pass no object, so they never take the precondition away
   * from a later update.
   */
  async record(
    verb: WriteVerb,
    args: Record<string, unknown>,
    object?: string,
    precondition?: () => Promise<Precondition | undefined>,
  ): Promise<number> {
    if (this.readOnly) throw new ScriptError("permission-denied", `${verb}: ${this.readOnly}`);
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

/** Operations whose result a `plan:<seq>` reference stands for (issue key, page or sprint id). */
export const PRODUCERS: ReadonlySet<WriteVerb> = new Set([
  "jira.create",
  "jira.createSprint",
  "jira.clone",
  "jira.createVersion",
  "jira.createComponent",
  "jira.request",
  "confluence.createPage",
  "confluence.createBlogPost",
  "confluence.request",
]);

/** `plan:<seq>` references, whole values or embedded in text (e.g. a page body naming a new issue). */
export const PLAN_REFERENCE = /\bplan:(\d+)\b/g;

export function placeholdersIn(value: unknown): number[] {
  if (typeof value === "string") return [...value.matchAll(PLAN_REFERENCE)].map((m) => Number(m[1]));
  if (Array.isArray(value)) return value.flatMap(placeholdersIn);
  if (value && typeof value === "object") return Object.values(value).flatMap(placeholdersIn);
  return [];
}

export type Verb = { args: z.ZodType<unknown[]>; run: (r: Recorder, args: never, signal: AbortSignal) => Promise<unknown> };

export function verb<A extends unknown[]>(
  args: z.ZodType<A>,
  run: (r: Recorder, args: A, signal: AbortSignal) => Promise<unknown>,
): Verb {
  return { args: args as z.ZodType<unknown[]>, run: run as Verb["run"] };
}

export async function issueUnchanged(r: Recorder, key: string, signal: AbortSignal): Promise<Precondition> {
  const issue = await r.port.jiraGetIssue(key, { fields: ["updated"], signal });
  return { kind: "jira-issue-unchanged", key, updated: issue.fields.updated };
}

/** The live issue when this plan has not written it yet (so its state is comparable), else undefined. */
export async function untouchedIssue(r: Recorder, key: string, fields: string[], signal: AbortSignal) {
  if (PLACEHOLDER.test(key) || r.lastWrite(`jira:${key}`) !== undefined) return undefined;
  return r.port.jiraGetIssue(key, { fields: ["updated", ...fields], signal });
}

export function sameUser(current: unknown, next: JiraUserRef | null): boolean {
  const user = current as { accountId?: string; name?: string } | null | undefined;
  if (!user || !next) return !user && !next;
  return "accountId" in next ? user.accountId === next.accountId : user.name === next.name;
}

export const pageUnchanged = async (live: ConfluencePageView | undefined): Promise<Precondition | undefined> =>
  live ? { kind: "confluence-page-unchanged", id: live.id, version: live.version } : undefined;

/** A host operation this host may not provide (optional in ScriptPort). */
export function hostOp<F>(op: F | undefined, name: string): F {
  if (!op) throw new Error(`atlcli.${name} is not available on this host`);
  return op;
}

/** Guest-side shim: a paged host verb becomes an async iterator with an optional `limit`. */
export function pagedIterator(items: string, tokenIn: string, tokenOut: string, positional = true): string {
  const call = positional ? "page(query, token === undefined ? rest : { ...rest, $IN: token })" : "page(token === undefined ? rest : { ...rest, $IN: token })";
  return `(page) => async function* (${positional ? "query, options" : "options"}) {
  const { limit = Infinity, ...rest } = options ?? {};
  let token, n = 0;
  do {
    const r = await ${call.replace("$IN", tokenIn)};
    for (const item of r.${items}) { if (n >= limit) return; n++; yield item; }
    token = r.${tokenOut} ?? undefined;
  } while (token !== undefined && n < limit);
}`;
}
