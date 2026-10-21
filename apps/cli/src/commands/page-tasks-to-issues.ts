/**
 * `atlcli wiki page tasks-to-issues`: turn a page's task items (meeting notes)
 * into Jira issues, link both ways, and with `--sync` tick tasks whose issues
 * are done. Spec: specs/jira-content-workflows A2.
 *
 * Without `--confirm` nothing is written. Duplicates are prevented by the
 * issue link written into each converted task (the durable marker, which
 * survives `docs pull/push`) and by a page-property ledger written right
 * after every issue creation (covers a crash before the page update).
 */
import {
  ERROR_CODES,
  type OutputOptions,

  buildConfluenceUrl,
  fail,
  getActiveProfile,
  getFlag,
  getFlags,
  hasFlag,
  loadConfig,
  output,
} from "@atlcli/core";
import {
  ConfluenceClient,
  annotateTasksWithIssueLinks,
  extractPageTasks,
  setTaskStatuses,
  storageToMarkdown,
  taskFingerprint,
  type PageTask,
} from "@atlcli/confluence";
import { JiraClient, toJiraRichText } from "@atlcli/jira";
import { assertCliAuthSupported } from "./session-guard.js";
import { buildConfluencePageRemoteLink } from "./jira-confluence-link.js";

export const TASK_LEDGER_KEY = "atlcli.tasks-to-issues";

/** Page-property ledger, keyed by issue key. */
export interface TaskLedger {
  v: 1;
  issues: Record<string, { fingerprint?: string; createdAt?: string; tickedBySync?: boolean }>;
}

export type TaskAction = "create" | "skip:linked" | "skip:ledger" | "skip:done" | "skip:empty";
export interface TaskPlanEntry {
  index: number;
  action: TaskAction;
  summary: string;
  assignee?: string;
  due?: string;
  key?: string;
}

/** Decide per task whether to create an issue (pure). */
export function planTaskIssues(
  tasks: readonly PageTask[],
  ledger: TaskLedger,
  options: { includeDone: boolean }
): TaskPlanEntry[] {
  const linkedOnPage = new Set(tasks.flatMap((task) => task.linkedIssueKeys));
  // Ledger issues whose link is missing on the page, matched by task text.
  const unplaced = Object.entries(ledger.issues).filter(([key, entry]) => entry.fingerprint && !linkedOnPage.has(key));
  return tasks.map((task) => {
    const base = { index: task.index, summary: summaryOf(task), assignee: task.assigneeAccountId, due: task.dueDate };
    if (task.linkedIssueKeys.length > 0) return { ...base, action: "skip:linked", key: task.linkedIssueKeys.join(",") };
    const fingerprint = taskFingerprint(task);
    const hit = unplaced.findIndex(([, entry]) => entry.fingerprint === fingerprint);
    if (hit >= 0) {
      const key = unplaced.splice(hit, 1)[0]![0];
      return { ...base, action: "skip:ledger", key };
    }
    if (!base.summary) return { ...base, action: "skip:empty" };
    if (task.status === "complete" && !options.includeDone) return { ...base, action: "skip:done" };
    return { ...base, action: "create" };
  });
}

export type IssueState = "done" | "open" | "missing";
export type SyncAction = "complete" | "reopen" | "report:ticked-but-open" | "report:missing";
export interface SyncPlanEntry {
  index: number;
  action: SyncAction;
  keys: string[];
}

/**
 * Jira → page status sync (pure). Jira is the source of truth: a task is
 * ticked when all its linked issues are done; it is unticked only if the sync
 * ticked it before and an issue reopened. A task ticked by hand while its
 * issue is open is reported, never changed, and never transitions the issue.
 */
export function planTaskStatusSync(
  tasks: readonly PageTask[],
  states: ReadonlyMap<string, IssueState>,
  ledger: TaskLedger
): SyncPlanEntry[] {
  const plan: SyncPlanEntry[] = [];
  for (const task of tasks) {
    const keys = task.linkedIssueKeys;
    if (keys.length === 0) continue;
    const known = keys.map((key) => states.get(key) ?? "missing");
    if (known.includes("missing")) {
      plan.push({ index: task.index, action: "report:missing", keys });
      continue;
    }
    const allDone = known.every((state) => state === "done");
    if (task.status === "incomplete" && allDone) plan.push({ index: task.index, action: "complete", keys });
    if (task.status === "complete" && !allDone) {
      const tickedBySync = keys.some((key) => ledger.issues[key]?.tickedBySync);
      plan.push({ index: task.index, action: tickedBySync ? "reopen" : "report:ticked-but-open", keys });
    }
  }
  return plan;
}

function summaryOf(task: PageTask): string {
  return task.text.length > 255 ? `${task.text.slice(0, 254)}…` : task.text;
}

function parseLedger(value: unknown): TaskLedger {
  if (value && typeof value === "object" && (value as TaskLedger).v === 1 && typeof (value as TaskLedger).issues === "object") {
    return value as TaskLedger;
  }
  return { v: 1, issues: {} };
}

// ============ Shell ============

export async function handlePageTasksToIssues(
  flags: Record<string, string | boolean | string[]>,
  opts: OutputOptions
): Promise<void> {
  const pageId = getFlag(flags, "id");
  const project = getFlag(flags, "project");
  const sync = hasFlag(flags, "sync");
  const confirm = hasFlag(flags, "confirm");
  if (!pageId || !/^\d+$/.test(pageId)) fail(opts, 1, ERROR_CODES.USAGE, "--id <numeric page id> is required.");
  if (!project && !sync) fail(opts, 1, ERROR_CODES.USAGE, "--project is required (or use --sync on its own).");

  const config = await loadConfig();
  const profile = getActiveProfile(config, getFlag(flags, "profile"));
  if (!profile) fail(opts, 1, ERROR_CODES.AUTH, "No active profile found. Run `atlcli auth login`.");
  assertCliAuthSupported(profile, opts);
  const confluence = new ConfluenceClient(profile);
  const jira = new JiraClient(profile);
  const warnings: string[] = [];
  const warn = (message: string) => {
    if (!warnings.includes(message)) warnings.push(message);
  };
  const ledgerWritable = confluence.deploymentType === "cloud";
  if (!ledgerWritable) warn("Data Center: no ledger page property; the issue links in the tasks alone prevent duplicates.");
  if (!jira.isCloudSite) warn("Jira Data Center: assignees are not set (no account IDs).");

  const page = await confluence.getPage(pageId);
  const pageUrl = page.url ?? buildConfluenceUrl(profile, `/pages/${page.id}`);
  const ledger = parseLedger(await confluence.getPagePropertyByKey(pageId, TASK_LEDGER_KEY));
  const tasks = extractPageTasks(page.storage);

  const plan = project ? planTaskIssues(tasks, ledger, { includeDone: hasFlag(flags, "include-done") }) : [];
  const states = sync ? await fetchIssueStates(jira, tasks.flatMap((t) => t.linkedIssueKeys)) : new Map<string, IssueState>();
  const syncPlan = sync ? planTaskStatusSync(tasks, states, ledger) : [];

  if (!confirm) {
    output(result({ pageId, dryRun: true, plan, syncPlan, created: [], failed: [], pageUpdated: false, warnings }), opts);
    return;
  }

  // 1. Create issues; persist each to the ledger before anything else can fail.
  const created: Array<{ index: number; key: string }> = [];
  const failed: Array<{ index: number; error: string }> = [];
  const linkedPage = { id: page.id, title: page.title, url: pageUrl, spaceKey: page.spaceKey };
  for (const entry of plan.filter((e) => e.action === "create")) {
    const task = tasks[entry.index]!;
    try {
      const key = await createIssueForTask(jira, task, entry, { project: project!, flags, pageTitle: page.title, pageUrl, warn });
      created.push({ index: entry.index, key });
      ledger.issues[key] = { fingerprint: taskFingerprint(task), createdAt: new Date().toISOString() };
      if (ledgerWritable) await confluence.upsertPageProperty(pageId, TASK_LEDGER_KEY, ledger);
      if (!hasFlag(flags, "no-link")) await jira.createRemoteLink(key, buildConfluencePageRemoteLink(profile, linkedPage));
    } catch (err) {
      failed.push({ index: entry.index, error: err instanceof Error ? err.message : String(err) });
    }
  }

  // 2. One page update: tick/untick, then link converted tasks. Re-read the
  //    page so concurrent edits are not overwritten; retry once on conflict.
  const pageUpdated = await updatePageTasks(confluence, jira, pageId, ledger, states, {
    mark: !hasFlag(flags, "no-mark"),
    sync,
  });
  if (sync && ledgerWritable && pageUpdated.ticked.length > 0) {
    for (const key of pageUpdated.ticked) ledger.issues[key] = { ...ledger.issues[key], tickedBySync: true };
    await confluence.upsertPageProperty(pageId, TASK_LEDGER_KEY, ledger);
  }

  output(
    result({ pageId, dryRun: false, plan, syncPlan, created, failed, pageUpdated: pageUpdated.updated, warnings }),
    opts
  );
  if (failed.length > 0) process.exitCode = 1;
}

function result(data: {
  pageId: string;
  dryRun: boolean;
  plan: TaskPlanEntry[];
  syncPlan: SyncPlanEntry[];
  created: Array<{ index: number; key: string }>;
  failed: Array<{ index: number; error: string }>;
  pageUpdated: boolean;
  warnings: string[];
}) {
  return {
    schemaVersion: "1",
    ...data,
    summary: {
      create: data.plan.filter((e) => e.action === "create").length,
      skipped: data.plan.filter((e) => e.action !== "create").length,
      created: data.created.length,
      failed: data.failed.length,
      statusChanges: data.syncPlan.filter((e) => e.action === "complete" || e.action === "reopen").length,
    },
  };
}

async function fetchIssueStates(jira: JiraClient, keys: string[]): Promise<Map<string, IssueState>> {
  const unique = [...new Set(keys)];
  const states = new Map<string, IssueState>();
  for (let i = 0; i < unique.length; i += 100) {
    const chunk = unique.slice(i, i + 100);
    const found = await jira.search(`key in (${chunk.join(", ")})`, { maxResults: 100, fields: ["status"] });
    for (const issue of found.issues) {
      states.set(issue.key, issue.fields.status?.statusCategory?.key === "done" ? "done" : "open");
    }
  }
  return states;
}

async function createIssueForTask(
  jira: JiraClient,
  task: PageTask,
  entry: TaskPlanEntry,
  context: {
    project: string;
    flags: Record<string, string | boolean | string[]>;
    pageTitle: string;
    pageUrl: string;
    warn: (message: string) => void;
  }
): Promise<string> {
  const title = context.pageTitle.replace(/[\\[\]]/g, "\\$&");
  const body = storageToMarkdown(task.bodyStorage).trim();
  const description = `${body}\n\n_Created from [${title}](${context.pageUrl.replace(/[()\s]/g, encodeURIComponent)})_`;
  const labels = getFlags(context.flags, "label");
  const parent = getFlag(context.flags, "parent");
  const issue = await jira.createIssue({
    fields: {
      project: { key: context.project },
      issuetype: { name: getFlag(context.flags, "type") ?? "Task" },
      summary: entry.summary,
      description: toJiraRichText(jira, description, { onWarning: context.warn }),
      assignee: jira.isCloudSite && task.assigneeAccountId ? { accountId: task.assigneeAccountId } : undefined,
      duedate: task.dueDate,
      labels: labels.length > 0 ? labels : undefined,
      parent: parent ? { key: parent } : undefined,
    },
  });
  return issue.key;
}

async function updatePageTasks(
  confluence: ConfluenceClient,
  jira: JiraClient,
  pageId: string,
  ledger: TaskLedger,
  states: ReadonlyMap<string, IssueState>,
  options: { mark: boolean; sync: boolean }
): Promise<{ updated: boolean; ticked: string[] }> {
  for (let attempt = 0; ; attempt++) {
    const page = await confluence.getPage(pageId);
    let storage = page.storage;
    const ticked: string[] = [];

    if (options.sync) {
      const statuses = new Map<number, PageTask["status"]>();
      for (const entry of planTaskStatusSync(extractPageTasks(storage), states, ledger)) {
        if (entry.action === "complete") {
          statuses.set(entry.index, "complete");
          ticked.push(...entry.keys);
        } else if (entry.action === "reopen") {
          statuses.set(entry.index, "incomplete");
        }
      }
      storage = setTaskStatuses(storage, extractPageTasks(storage), statuses);
    }

    if (options.mark) {
      const tasks = extractPageTasks(storage);
      const links = new Map<number, string>();
      for (const entry of planTaskIssues(tasks, ledger, { includeDone: true })) {
        if (entry.action === "skip:ledger" && entry.key) links.set(entry.index, `${jira.siteUrl}/browse/${entry.key}`);
      }
      storage = annotateTasksWithIssueLinks(storage, tasks, links);
    }

    if (storage === page.storage) return { updated: false, ticked: [] };
    try {
      await confluence.updatePage({ id: pageId, title: page.title, storage, version: (page.version ?? 1) + 1 });
      return { updated: true, ticked };
    } catch (err) {
      // Someone saved the page in between: re-read and redo once.
      if (attempt === 0 && (err as { status?: number }).status === 409) continue;
      throw err;
    }
  }
}
