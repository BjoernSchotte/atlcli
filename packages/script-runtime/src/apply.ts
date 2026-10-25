import { normalizeBaseUrl, ScriptPlanError, type ScriptPlanV1 } from "./plan.js";
import type { AttachmentInput, ScriptPort } from "./port.js";
import { checkExportPath, PLAN_REFERENCE, type PlannedOperation, type Precondition } from "./verbs.js";

export interface ApplyScriptPlanOptions {
  port: ScriptPort;
  /** Base URL of the profile the plan is applied with; must match the plan's target. */
  baseUrl: string;
  /** Progress callback, called after each operation settles. */
  onOperation?: (result: OperationResult) => void;
  /**
   * Operations already applied by an earlier, interrupted apply (seq → result,
   * from its journal). They are skipped; their results stand in for
   * `plan:<seq>` references and page versions, as if applied in this run.
   */
  done?: ReadonlyMap<number, Record<string, unknown>>;
  /**
   * Operations in flight at once (default 1). Order is kept where it matters:
   * an operation waits for its `dependsOn` and for every earlier operation on
   * the same issue, page or sprint.
   */
  concurrency?: number;
}

export interface DriftItem {
  seq: number;
  precondition: Precondition;
  /** What was found instead (or the read error). */
  actual: string;
}

export interface OperationResult {
  seq: number;
  verb: PlannedOperation["verb"];
  status: "applied" | "failed" | "skipped";
  /** Created/updated identity, e.g. `{ key }` or `{ id, version }`. */
  result?: Record<string, unknown>;
  error?: string;
}

export interface ApplyReport {
  /** `drift`: nothing was written. `failed`: operations before the failure were written. */
  status: "applied" | "drift" | "failed";
  drift: DriftItem[];
  operations: OperationResult[];
}


/**
 * Applies a parsed (digest-verified) plan. All preconditions are checked
 * before the first write; any drift aborts with nothing written. Operations
 * then run in order, placeholders resolve to the real ids/keys of earlier
 * results, and the first failure stops the run.
 *
 * ponytail: the gap between the precondition check and each write is not
 * atomic. Confluence page updates still fail hard on a version conflict;
 * Jira has no conditional update, so a concurrent edit in that window wins
 * silently. Add a per-write re-check if that window ever matters.
 */
export async function applyScriptPlan(
  plan: Pick<ScriptPlanV1, "target" | "operations">,
  options: ApplyScriptPlanOptions,
): Promise<ApplyReport> {
  if (normalizeBaseUrl(options.baseUrl) !== plan.target.baseUrl) {
    throw new ScriptPlanError(`Plan targets ${plan.target.baseUrl}, but the active profile is ${normalizeBaseUrl(options.baseUrl)}`);
  }
  const { port } = options;
  const done = options.done ?? new Map<number, Record<string, unknown>>();
  const concurrency = Math.max(1, Math.floor(options.concurrency ?? 1));
  const open = plan.operations.filter((op) => !done.has(op.seq));

  const drift: DriftItem[] = [];
  await pool(
    open.filter((op) => op.precondition),
    concurrency,
    async (op) => {
      const actual = await checkPrecondition(port, op.precondition!);
      if (actual !== undefined) drift.push({ seq: op.seq, precondition: op.precondition!, actual });
    },
  );
  if (drift.length > 0) {
    drift.sort((a, b) => a.seq - b.seq);
    return { status: "drift", drift, operations: plan.operations.map((op) => (done.has(op.seq) ? resumed(op, done) : skipped(op))) };
  }

  /** seq → value a `plan:<seq>` placeholder stands for (issue key or page id). */
  const resolved = new Map<number, string>();
  /** Page id → version after the last write in this apply. */
  const versions = new Map<string, number>();
  for (const op of plan.operations) {
    if (op.precondition?.kind === "confluence-page-unchanged") versions.set(op.precondition.id, op.precondition.version);
  }
  for (const op of plan.operations) {
    const result = done.get(op.seq);
    if (result) remember(op, result, resolved, versions);
  }

  const results = new Map<number, OperationResult>();
  for (const op of plan.operations) if (done.has(op.seq)) results.set(op.seq, resumed(op, done));
  const waitFor = orderingDependencies(plan.operations);
  if (concurrency === 1) {
    // One at a time means plan order, as before: each operation waits for the previous one.
    open.forEach((op, i) => i > 0 && waitFor.set(op.seq, [open[i - 1]!.seq]));
  }
  const settled = new Map<number, Promise<boolean>>();
  for (const seq of done.keys()) settled.set(seq, Promise.resolve(true));
  let failed = false;

  const slots = semaphore(concurrency);
  const runOne = async (op: PlannedOperation): Promise<boolean> => {
    const ok = await Promise.all((waitFor.get(op.seq) ?? []).map((seq) => settled.get(seq) ?? Promise.resolve(true)));
    if (!failed && !ok.includes(false)) await slots.acquire();
    else {
      results.set(op.seq, skipped(op));
      return false;
    }
    let result: OperationResult;
    try {
      if (failed) {
        results.set(op.seq, skipped(op));
        return false;
      }
      const args = resolve(op.args, resolved) as Record<string, any>;
      const value = await execute(port, op, args, versions);
      remember(op, value, resolved, versions);
      result = { seq: op.seq, verb: op.verb, status: "applied", result: value };
    } catch (error) {
      failed = true;
      result = { seq: op.seq, verb: op.verb, status: "failed", error: error instanceof Error ? error.message : String(error) };
    } finally {
      slots.release();
    }
    results.set(op.seq, result);
    options.onOperation?.(result);
    return result.status === "applied";
  };

  // Every operation is scheduled up front, in seq order (so the ones it waits
  // for are registered first); the semaphore bounds how many execute at once,
  // and a waiting operation holds no slot.
  for (const op of open) settled.set(op.seq, runOne(op));
  await Promise.all(settled.values());

  const operations = plan.operations.map((op) => results.get(op.seq) ?? skipped(op));
  return { status: failed ? "failed" : "applied", drift: [], operations };
}

/** Records what later operations need from an applied one: created keys/ids and page versions. */
function remember(op: PlannedOperation, value: Record<string, unknown>, resolved: Map<number, string>, versions: Map<string, number>): void {
  if (op.verb === "jira.create") resolved.set(op.seq, value.key as string);
  if (op.verb === "jira.createSprint" || op.verb === "confluence.createPage") resolved.set(op.seq, String(value.id));
  if (op.verb === "confluence.deletePage") versions.delete(String(value.id));
  else if (op.verb.startsWith("confluence.") && typeof value.version === "number" && value.id !== undefined) {
    versions.set(String(value.id), value.version);
  }
}

/** Argument names that name the object an operation acts on. */
const TARGET_ARGS = ["key", "from", "to", "pageId", "id", "toPageId", "parentId", "sprintId", "boardId"] as const;

/**
 * For each operation, the earlier ones it must wait for: its `dependsOn` plus
 * the last earlier operation touching the same target. `dependsOn` alone does
 * not order writes that carry no object identity (two labels or comments on
 * one issue), and those must still land in plan order.
 */
export function orderingDependencies(operations: readonly PlannedOperation[]): Map<number, number[]> {
  const last = new Map<string, number>();
  const deps = new Map<number, number[]>();
  for (const op of operations) {
    const wait = new Set(op.dependsOn);
    const targets = new Set<string>();
    for (const name of TARGET_ARGS) {
      const value = (op.args as Record<string, unknown>)[name];
      if (typeof value === "string" || typeof value === "number") targets.add(String(value));
    }
    if (Array.isArray((op.args as Record<string, unknown>).keys)) {
      for (const key of (op.args as { keys: unknown[] }).keys) targets.add(String(key));
    }
    for (const target of targets) {
      const previous = last.get(target);
      if (previous !== undefined) wait.add(previous);
      last.set(target, op.seq);
    }
    deps.set(op.seq, [...wait].sort((a, b) => a - b));
  }
  return deps;
}

function semaphore(limit: number): { acquire(): Promise<void>; release(): void } {
  let free = limit;
  const queue: Array<() => void> = [];
  return {
    acquire: () => (free > 0 ? (free--, Promise.resolve()) : new Promise<void>((resolve) => queue.push(resolve))),
    release: () => {
      const next = queue.shift();
      if (next) next();
      else free++;
    },
  };
}

/** Runs `work` over `items` with at most `limit` in flight, started in item order. */
export async function pool<T>(items: readonly T[], limit: number, work: (item: T) => Promise<unknown>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await work(items[next++]!);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

const resumed = (op: PlannedOperation, done: ReadonlyMap<number, Record<string, unknown>>): OperationResult => ({
  seq: op.seq,
  verb: op.verb,
  status: "applied",
  result: done.get(op.seq),
});

async function checkPrecondition(port: ScriptPort, pre: Precondition): Promise<string | undefined> {
  try {
    switch (pre.kind) {
      case "jira-issue-unchanged": {
        const issue = await port.jiraGetIssue(pre.key, { fields: ["updated"] });
        return issue.fields.updated === pre.updated ? undefined : `updated ${issue.fields.updated}`;
      }
      case "jira-attachment-unchanged": {
        const attachment = await port.jiraAttachmentInfo(pre.id, {});
        return attachment.size === pre.size ? undefined : `size ${attachment.size}`;
      }
      case "jira-sprint-unchanged": {
        const sprint = await port.jiraGetSprint(pre.id, {});
        return sprint.state === pre.state ? undefined : `state ${sprint.state}`;
      }
      case "confluence-page-unchanged": {
        const page = await port.confluenceGetPage(pre.id, {});
        return page.version === pre.version ? undefined : `version ${page.version}`;
      }
      case "confluence-title-absent": {
        const page = await port.confluenceFindPage(pre.spaceKey, pre.title, {});
        return page ? `page ${page.id} exists` : undefined;
      }
    }
  } catch (error) {
    return `unreadable: ${error instanceof Error ? error.message : String(error)}`;
  }
}

async function execute(
  port: ScriptPort,
  op: PlannedOperation,
  args: Record<string, any>,
  versions: Map<string, number>,
): Promise<Record<string, unknown>> {
  switch (op.verb) {
    case "jira.create":
      return port.jiraCreateIssue(args as never);
    case "jira.update": {
      const { key, ...update } = args;
      await port.jiraUpdateIssue(key, update);
      return { key };
    }
    case "jira.transition":
      await port.jiraTransitionIssue(args.key, args.transition, transitionOptions(args));
      return { key: args.key };
    case "jira.setStatus":
      return { key: args.key, status: args.status, ...(await port.jiraSetStatus(args.key, args.status, transitionOptions(args))) };
    case "jira.addWatcher":
      await required(port.jiraAddWatcher, "jira.addWatcher").call(port, args.key, args.user);
      return { key: args.key };
    case "jira.removeWatcher":
      await required(port.jiraRemoveWatcher, "jira.removeWatcher").call(port, args.key, args.user);
      return { key: args.key };
    case "jira.notify":
      await required(port.jiraNotify, "jira.notify").call(port, args.key, { subject: args.subject, markdown: args.markdown, to: args.to });
      return { key: args.key };
    case "jira.comment":
      return { key: args.key, ...(await port.jiraAddComment(args.key, "raw" in args ? { raw: args.raw } : args.markdown)) };
    case "confluence.createPage": {
      const page = await port.confluenceCreatePage(args as never);
      versions.set(page.id, page.version);
      return page;
    }
    case "confluence.updatePage": {
      const version = versions.get(args.id);
      if (version === undefined) throw new Error(`No known version for page ${args.id}`);
      const page = await port.confluenceUpdatePage({ id: args.id, title: args.title, markdown: args.markdown, version });
      versions.set(page.id, page.version);
      return page;
    }
    case "confluence.addLabels":
      await port.confluenceAddLabels(args.pageId, args.labels);
      return { pageId: args.pageId };
    case "jira.link":
      await port.jiraLinkIssues({ type: args.type, from: args.from, to: args.to });
      return { from: args.from, to: args.to };
    case "jira.assign":
      await port.jiraAssignIssue(args.key, args.assignee);
      return { key: args.key };
    case "jira.addLabels":
      await port.jiraEditLabels(args.key, { add: args.labels });
      return { key: args.key };
    case "jira.removeLabels":
      await port.jiraEditLabels(args.key, { remove: args.labels });
      return { key: args.key };
    case "jira.attach":
      return { key: args.key, ...(await port.jiraAttach(args.key, attachment(args))) };
    case "jira.copyAttachment":
      return { key: args.to, ...(await port.jiraCopyAttachment(args.id, args.to)) };
    case "jira.createSprint": {
      const { boardId, ...input } = args;
      return port.jiraCreateSprint({ boardId: Number(boardId), ...input } as never);
    }
    case "jira.updateSprint": {
      const { id, ...input } = args;
      await port.jiraUpdateSprint(Number(id), input);
      return { id: Number(id) };
    }
    case "jira.moveToSprint":
      await port.jiraMoveToSprint(Number(args.sprintId), args.keys);
      return { sprintId: Number(args.sprintId) };
    case "confluence.removeLabels":
      await port.confluenceRemoveLabels(args.pageId, args.labels);
      return { pageId: args.pageId };
    case "confluence.comment":
      return { pageId: args.pageId, ...(await port.confluenceAddComment(args.pageId, args.markdown)) };
    case "confluence.movePage": {
      const page = await port.confluenceMovePage(args.id, args.parentId);
      versions.set(page.id, page.version);
      return page;
    }
    case "confluence.deletePage":
      await port.confluenceDeletePage(args.id);
      versions.delete(args.id);
      return { id: args.id };
    case "confluence.attach":
      return { pageId: args.pageId, ...(await port.confluenceAttach(args.pageId, attachment(args))) };
    case "confluence.copyAttachment": {
      if (!port.confluenceCopyAttachment) throw new Error("This host cannot copy Confluence attachments");
      return { pageId: args.toPageId, ...(await port.confluenceCopyAttachment(args.attachmentId, args.sourcePageId, args.toPageId)) };
    }
    case "confluence.export":
      // A plan file is editable, so the path is checked again right before writing.
      return port.confluenceExport({ pageId: args.pageId, format: args.format, path: checkExportPath(args.path, args.format) });
  }
}

/** Only the options a plan recorded, so hosts see `undefined` for a plain transition. */
const transitionOptions = (args: Record<string, any>) =>
  args.fields || args.comment ? { ...(args.fields ? { fields: args.fields } : {}), ...(args.comment ? { comment: args.comment } : {}) } : undefined;

function required<F>(fn: F | undefined, verb: string): F {
  if (!fn) throw new Error(`This host cannot apply ${verb}`);
  return fn;
}

const attachment = (args: Record<string, any>): AttachmentInput => ({ name: args.name, content: args.content, encoding: args.encoding });

/** Replaces `plan:<seq>` references to created objects, also inside text; other text stays as written. */
function resolve(value: unknown, resolved: Map<number, string>): unknown {
  if (typeof value === "string") return value.replace(PLAN_REFERENCE, (ref, seq) => resolved.get(Number(seq)) ?? ref);
  if (Array.isArray(value)) return value.map((item) => resolve(item, resolved));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolve(v, resolved)]));
  }
  return value;
}

const skipped = (op: PlannedOperation): OperationResult => ({ seq: op.seq, verb: op.verb, status: "skipped" });
