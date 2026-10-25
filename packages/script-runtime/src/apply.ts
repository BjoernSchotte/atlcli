import { normalizeBaseUrl, ScriptPlanError, type ScriptPlanV1 } from "./plan.js";
import type { AttachmentInput, ScriptPort } from "./port.js";
import { checkExportPath, PLAN_REFERENCE, type PlannedOperation, type Precondition } from "./verbs.js";

export interface ApplyScriptPlanOptions {
  port: ScriptPort;
  /** Base URL of the profile the plan is applied with; must match the plan's target. */
  baseUrl: string;
  /** Progress callback, called after each operation settles. */
  onOperation?: (result: OperationResult) => void;
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
export async function applyScriptPlan(plan: ScriptPlanV1, options: ApplyScriptPlanOptions): Promise<ApplyReport> {
  if (normalizeBaseUrl(options.baseUrl) !== plan.target.baseUrl) {
    throw new ScriptPlanError(`Plan targets ${plan.target.baseUrl}, but the active profile is ${normalizeBaseUrl(options.baseUrl)}`);
  }
  const { port } = options;

  const drift: DriftItem[] = [];
  for (const op of plan.operations) {
    if (!op.precondition) continue;
    const actual = await checkPrecondition(port, op.precondition);
    if (actual !== undefined) drift.push({ seq: op.seq, precondition: op.precondition, actual });
  }
  if (drift.length > 0) {
    return { status: "drift", drift, operations: plan.operations.map((op) => skipped(op)) };
  }

  /** seq → value a `plan:<seq>` placeholder stands for (issue key or page id). */
  const resolved = new Map<number, string>();
  /** Page id → version after the last write in this apply. */
  const versions = new Map<string, number>();
  for (const op of plan.operations) {
    if (op.precondition?.kind === "confluence-page-unchanged") versions.set(op.precondition.id, op.precondition.version);
  }

  const results: OperationResult[] = [];
  for (const [index, op] of plan.operations.entries()) {
    let result: OperationResult;
    try {
      const args = resolve(op.args, resolved) as Record<string, any>;
      const value = await execute(port, op, args, versions);
      if (op.verb === "jira.create") resolved.set(op.seq, value.key as string);
      if (op.verb === "jira.createSprint" || op.verb === "confluence.createPage") resolved.set(op.seq, String(value.id));
      result = { seq: op.seq, verb: op.verb, status: "applied", result: value };
    } catch (error) {
      result = { seq: op.seq, verb: op.verb, status: "failed", error: error instanceof Error ? error.message : String(error) };
    }
    results.push(result);
    options.onOperation?.(result);
    if (result.status === "failed") {
      results.push(...plan.operations.slice(index + 1).map((rest) => skipped(rest)));
      return { status: "failed", drift: [], operations: results };
    }
  }
  return { status: "applied", drift: [], operations: results };
}

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
      await port.jiraTransitionIssue(args.key, args.transition);
      return { key: args.key };
    case "jira.setStatus":
      return { key: args.key, status: args.status, ...(await port.jiraSetStatus(args.key, args.status)) };
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
