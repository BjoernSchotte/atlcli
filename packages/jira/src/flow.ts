/**
 * Kanban flow metrics: cycle time, lead time, throughput, aging WIP and the
 * cumulative flow diagram.
 *
 * Everything here is pure. Callers fetch issues, their status changelogs
 * (`JiraClient.getChangelogs`) and the site statuses (`getStatuses`), attach
 * the changelogs with `attachChangelogs`, and pass `now` explicitly. Days are
 * bucketed in UTC, like `calculateBurndown`.
 */

import type { JiraChangelogEntry, JiraIssue, JiraStatus } from "./types.js";

export type FlowCategory = "todo" | "wip" | "done";

export type StatusCategoryResolver = (status: {
  id?: string | null;
  name?: string | null;
  statusCategory?: { key?: string } | null;
}) => FlowCategory | undefined;

const DAY_MS = 24 * 60 * 60 * 1000;
const FLOW_CATEGORIES: readonly FlowCategory[] = ["todo", "wip", "done"];
const CATEGORY_BY_JIRA_KEY: Record<string, FlowCategory> = {
  new: "todo",
  indeterminate: "wip",
  done: "done",
};

/**
 * Replace each issue's `changelog.histories` with the fetched entries, keeping
 * the issue's own fields (story points, `resolutiondate`). Issues missing from
 * `logs` keep whatever changelog they carried.
 */
export function attachChangelogs(
  issues: JiraIssue[],
  logs: Map<string, JiraChangelogEntry[]>
): JiraIssue[] {
  return issues.map((issue) => {
    const histories = logs.get(issue.key) ?? issue.changelog?.histories ?? [];
    return { ...issue, changelog: { histories } };
  });
}

/**
 * Map statuses to flow categories through their Jira status category
 * (`new` → todo, `indeterminate` → wip, `done` → done). Override keys match a
 * status id or a case-insensitive status name and win over the category.
 */
export function createStatusCategoryResolver(
  statuses: JiraStatus[],
  overrides: Record<string, FlowCategory> = {}
): StatusCategoryResolver {
  const override = new Map(
    Object.entries(overrides).map(([key, value]) => [key.toLowerCase(), value])
  );
  // A known id resolves through the site's name for it: changelogs can carry
  // another name (an older or untranslated one) next to the same id.
  const byId = new Map<string, FlowCategory>();
  const byName = new Map<string, FlowCategory>();
  for (const status of statuses) {
    const category = CATEGORY_BY_JIRA_KEY[status.statusCategory?.key ?? ""];
    if (!category) continue;
    const name = status.name.toLowerCase();
    byId.set(status.id, override.get(status.id.toLowerCase()) ?? override.get(name) ?? category);
    if (!byName.has(name)) byName.set(name, category);
  }
  return (status) => {
    const id = status.id ?? undefined;
    const name = status.name?.toLowerCase();
    return (
      (id !== undefined ? (byId.get(id) ?? override.get(id.toLowerCase())) : undefined) ??
      (name !== undefined ? (override.get(name) ?? byName.get(name)) : undefined) ??
      CATEGORY_BY_JIRA_KEY[status.statusCategory?.key ?? ""]
    );
  };
}

/**
 * JQL for "not done" and "done" under the resolver, so searches agree with a
 * status map. Without overrides that move a status into or out of done, these
 * are plain `statusCategory != Done` / `statusCategory = Done`; otherwise the
 * moved statuses are listed by id as exceptions.
 */
export function statusScopeJql(
  statuses: JiraStatus[],
  resolve: StatusCategoryResolver
): { open: string; done: string } {
  const toDone: string[] = [];
  const fromDone: string[] = [];
  for (const status of statuses) {
    const jiraDone = status.statusCategory?.key === "done";
    const flowDone = resolve(status) === "done";
    if (flowDone && !jiraDone) toDone.push(status.id);
    if (jiraDone && !flowDone) fromDone.push(status.id);
  }
  const list = (ids: string[]) => ids.join(", ");
  const scope = (category: string, exclude: string[], include: string[]) => {
    let jql = `statusCategory ${category} Done`;
    if (exclude.length) jql = `(${jql} AND status not in (${list(exclude)}))`;
    return include.length ? `(${jql} OR status in (${list(include)}))` : jql;
  };
  return { open: scope("!=", toDone, fromDone), done: scope("=", fromDone, toDone) };
}

/** Parse `"Code Review=wip,Blocked=wip"` into an override map. */
export function parseStatusMap(spec: string): Record<string, FlowCategory> {
  const map: Record<string, FlowCategory> = {};
  for (const part of spec.split(",")) {
    const entry = part.trim();
    if (!entry) continue;
    const eq = entry.lastIndexOf("=");
    const status = eq > 0 ? entry.slice(0, eq).trim() : "";
    const category = eq > 0 ? entry.slice(eq + 1).trim().toLowerCase() : "";
    if (!status || !FLOW_CATEGORIES.includes(category as FlowCategory)) {
      throw new Error(
        `Invalid status map entry "${entry}". Use <status>=todo|wip|done, e.g. "Code Review=wip".`
      );
    }
    map[status] = category as FlowCategory;
  }
  return map;
}

/**
 * Merge status maps: the profile overrides the global map per key, the flag
 * overrides both. Keys compare case-insensitively.
 */
export function resolveStatusMap(
  ...maps: Array<Record<string, FlowCategory> | undefined>
): Record<string, FlowCategory> {
  const merged = new Map<string, [string, FlowCategory]>();
  for (const map of maps) {
    for (const [key, value] of Object.entries(map ?? {})) {
      merged.set(key.toLowerCase(), [key, value]);
    }
  }
  return Object.fromEntries(merged.values());
}

export interface StatusTransition {
  at: string;
  fromId: string | null;
  fromName: string | null;
  toId: string;
  toName: string | null;
}

/** Status changes from an issue's changelog, oldest first. */
export function extractStatusTransitions(issue: JiraIssue): StatusTransition[] {
  const transitions: StatusTransition[] = [];
  const histories = [...(issue.changelog?.histories ?? [])].sort(
    (a, b) => Date.parse(a.created) - Date.parse(b.created)
  );
  for (const entry of histories) {
    for (const item of entry.items) {
      const fieldId = (item as { fieldId?: string }).fieldId;
      if ((fieldId ?? item.field) !== "status" || item.to === null || item.to === undefined) continue;
      transitions.push({
        at: entry.created,
        fromId: item.from ?? null,
        fromName: Object.hasOwn(item, "fromString") ? item.fromString : null,
        toId: item.to,
        toName: Object.hasOwn(item, "toString") ? item.toString : null,
      });
    }
  }
  return transitions;
}

export interface FlowInterval {
  statusId: string | null;
  statusName: string | null;
  category?: FlowCategory;
  from: string;
  /** Absent for the current status. */
  to?: string;
}

export interface IssueFlowTimeline {
  key: string;
  created: string;
  currentCategory?: FlowCategory;
  /** First entry into `wip`. */
  startedAt?: string;
  /** Start of the final run of `done` statuses; only when currently done. */
  doneAt?: string;
  intervals: FlowInterval[];
  /** Status names (or ids) the resolver could not map. */
  unknownStatuses: string[];
}

/**
 * Replay an issue's status history. The initial status is the earliest
 * transition's source, or the current status when there are no transitions.
 * A reopened issue keeps its first `startedAt`.
 */
export function buildIssueFlowTimeline(
  issue: JiraIssue,
  resolve: StatusCategoryResolver
): IssueFlowTimeline {
  const created = issue.fields.created ?? issue.changelog?.histories[0]?.created ?? "";
  const current = issue.fields.status;
  const transitions = extractStatusTransitions(issue);
  const intervals: FlowInterval[] = [];
  const unknown = new Set<string>();

  const open = (statusId: string | null, statusName: string | null, from: string, fallback?: { key?: string } | null) => {
    const category = resolve({ id: statusId, name: statusName, statusCategory: fallback });
    if (!category) unknown.add(statusName ?? statusId ?? "?");
    intervals.push({ statusId, statusName, category, from });
  };

  if (transitions.length === 0) {
    open(current?.id ?? null, current?.name ?? null, created, current?.statusCategory);
  } else {
    open(transitions[0].fromId, transitions[0].fromName, created);
    for (const transition of transitions) {
      intervals[intervals.length - 1].to = transition.at;
      const isCurrent = transition === transitions[transitions.length - 1];
      open(
        transition.toId,
        transition.toName,
        transition.at,
        isCurrent && transition.toId === current?.id ? current?.statusCategory : undefined
      );
    }
  }

  const currentCategory = current
    ? resolve({ id: current.id, name: current.name, statusCategory: current.statusCategory })
    : intervals[intervals.length - 1]?.category;
  const startedAt = intervals.find((interval) => interval.category === "wip")?.from;
  let doneAt: string | undefined;
  if (currentCategory === "done") {
    let i = intervals.length - 1;
    while (i > 0 && intervals[i - 1].category === "done") i--;
    doneAt =
      intervals[i]?.category === "done" && (i > 0 || transitions.length > 0)
        ? intervals[i].from
        : issue.fields.resolutiondate ?? intervals[i]?.from;
  }

  return {
    key: issue.key,
    created,
    currentCategory,
    startedAt,
    doneAt,
    intervals,
    unknownStatuses: [...unknown].sort(),
  };
}

/** Nearest-rank percentile of ascending values; `undefined` when empty. */
export function percentile(sortedValues: number[], p: number): number | undefined {
  if (sortedValues.length === 0) return undefined;
  const rank = Math.ceil((p / 100) * sortedValues.length);
  return sortedValues[Math.min(sortedValues.length, Math.max(rank, 1)) - 1];
}

export interface FlowStats {
  count: number;
  min: number | null;
  p50: number | null;
  /** `null` below five samples. */
  p85: number | null;
  /** `null` below five samples. */
  p95: number | null;
  max: number | null;
  mean: number | null;
}

/** Below this many completions P85/P95 are not reported. */
export const FLOW_MIN_PERCENTILE_SAMPLES = 5;

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function daysBetween(from: string, to: string | Date): number {
  const end = typeof to === "string" ? Date.parse(to) : to.getTime();
  return round1((end - Date.parse(from)) / DAY_MS);
}

export function flowStats(values: number[]): FlowStats {
  const sorted = [...values].sort((a, b) => a - b);
  const enough = sorted.length >= FLOW_MIN_PERCENTILE_SAMPLES;
  return {
    count: sorted.length,
    min: sorted[0] ?? null,
    p50: percentile(sorted, 50) ?? null,
    p85: enough ? percentile(sorted, 85) ?? null : null,
    p95: enough ? percentile(sorted, 95) ?? null : null,
    max: sorted[sorted.length - 1] ?? null,
    mean: sorted.length ? round1(sorted.reduce((sum, v) => sum + v, 0) / sorted.length) : null,
  };
}

export interface FlowCompletedIssue {
  key: string;
  type: string;
  summary: string;
  created: string;
  startedAt: string | null;
  doneAt: string;
  leadDays: number;
  /** `null` when the issue skipped wip or passed an unmapped status. */
  cycleDays: number | null;
}

export interface FlowAgingIssue {
  key: string;
  summary: string;
  status: string;
  startedAt: string;
  ageDays: number;
  /** `null` when there is no P85 (fewer than five completions). */
  overP85: boolean | null;
}

export interface FlowMetricsV1 {
  window: { from: string; to: string };
  leadTime: FlowStats;
  cycleTime: FlowStats;
  throughput: {
    daily: Array<{ date: string; count: number }>;
    weekly: Array<{ week: string; count: number }>;
  };
  wip: { count: number; aging: FlowAgingIssue[] };
  completed: FlowCompletedIssue[];
  diagnostics: {
    issues: number;
    skippedWip: number;
    excludedFromCycleTime: number;
    unknownStatuses: string[];
  };
}

/** UTC calendar days from `from` to `to`, inclusive. */
function utcDays(from: Date, to: Date): string[] {
  const days: string[] = [];
  let t = Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate());
  for (; t <= to.getTime(); t += DAY_MS) days.push(new Date(t).toISOString().slice(0, 10));
  return days;
}

/** ISO-8601 week label, e.g. `2026-W43`. */
export function isoWeek(date: string | Date): string {
  const d = new Date(typeof date === "string" ? Date.parse(date) : date.getTime());
  const day = d.getUTCDay() || 7;
  const thursday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 4 - day));
  const yearStart = Date.UTC(thursday.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((thursday.getTime() - yearStart) / DAY_MS + 1) / 7);
  return `${thursday.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

export function computeFlowMetrics(input: {
  issues: JiraIssue[];
  resolve: StatusCategoryResolver;
  from: Date;
  to: Date;
  now: Date;
}): FlowMetricsV1 {
  const { issues, resolve, from, to, now } = input;
  const completed: FlowCompletedIssue[] = [];
  const wipTimelines: Array<{ issue: JiraIssue; timeline: IssueFlowTimeline }> = [];
  const unknown = new Set<string>();
  let skippedWip = 0;
  let excluded = 0;

  for (const issue of issues) {
    const timeline = buildIssueFlowTimeline(issue, resolve);
    timeline.unknownStatuses.forEach((status) => unknown.add(status));
    if (timeline.currentCategory === "wip") wipTimelines.push({ issue, timeline });
    if (!timeline.doneAt) continue;
    const doneMs = Date.parse(timeline.doneAt);
    if (doneMs < from.getTime() || doneMs > to.getTime()) continue;
    const reliable = timeline.unknownStatuses.length === 0;
    if (!timeline.startedAt) skippedWip++;
    else if (!reliable) excluded++;
    completed.push({
      key: issue.key,
      type: issue.fields.issuetype?.name ?? "",
      summary: issue.fields.summary ?? "",
      created: timeline.created,
      startedAt: timeline.startedAt ?? null,
      doneAt: timeline.doneAt,
      leadDays: daysBetween(timeline.created, timeline.doneAt),
      cycleDays: timeline.startedAt && reliable ? daysBetween(timeline.startedAt, timeline.doneAt) : null,
    });
  }
  completed.sort((a, b) => a.doneAt.localeCompare(b.doneAt) || a.key.localeCompare(b.key));

  const cycleTime = flowStats(completed.flatMap((c) => (c.cycleDays === null ? [] : [c.cycleDays])));
  const daily = new Map(utcDays(from, to).map((day) => [day, 0]));
  const weekly = new Map<string, number>();
  for (const day of daily.keys()) weekly.set(isoWeek(`${day}T00:00:00Z`), 0);
  for (const c of completed) {
    const day = new Date(Date.parse(c.doneAt)).toISOString().slice(0, 10);
    if (daily.has(day)) daily.set(day, (daily.get(day) ?? 0) + 1);
    const week = isoWeek(c.doneAt);
    if (weekly.has(week)) weekly.set(week, (weekly.get(week) ?? 0) + 1);
  }

  const aging = wipTimelines
    .map(({ issue, timeline }): FlowAgingIssue => {
      const startedAt = timeline.startedAt ?? timeline.created;
      const ageDays = daysBetween(startedAt, now);
      return {
        key: issue.key,
        summary: issue.fields.summary ?? "",
        status: issue.fields.status?.name ?? "",
        startedAt,
        ageDays,
        overP85: cycleTime.p85 === null ? null : ageDays > cycleTime.p85,
      };
    })
    .sort((a, b) => b.ageDays - a.ageDays || a.key.localeCompare(b.key));

  return {
    window: { from: from.toISOString(), to: to.toISOString() },
    leadTime: flowStats(completed.map((c) => c.leadDays)),
    cycleTime,
    throughput: {
      daily: [...daily].map(([date, count]) => ({ date, count })),
      weekly: [...weekly].map(([week, count]) => ({ week, count })),
    },
    wip: { count: aging.length, aging },
    completed,
    diagnostics: {
      issues: issues.length,
      skippedWip,
      excludedFromCycleTime: excluded,
      unknownStatuses: [...unknown].sort(),
    },
  };
}

export interface CumulativeFlowV1 {
  groupBy: "status" | "category";
  columns: Array<{ name: string; category?: FlowCategory }>;
  days: Array<{ date: string; counts: Record<string, number> }>;
}

/**
 * Count each issue's status at 23:59:59Z of every UTC day in the window.
 * The Done band only holds issues the query found, so it starts at the window
 * start rather than at zero history.
 */
export function computeCumulativeFlow(input: {
  issues: JiraIssue[];
  resolve: StatusCategoryResolver;
  from: Date;
  to: Date;
  groupBy: "status" | "category";
}): CumulativeFlowV1 {
  const { resolve, from, to, groupBy } = input;
  const timelines = input.issues.map((issue) => buildIssueFlowTimeline(issue, resolve));
  const columns = new Map<string, { name: string; category?: FlowCategory; firstSeen: number }>();
  const days = utcDays(from, to).map((date, dayIndex) => {
    const at = Date.parse(`${date}T23:59:59.999Z`);
    const counts: Record<string, number> = {};
    for (const timeline of timelines) {
      if (Date.parse(timeline.created) > at) continue;
      const interval = timeline.intervals.find(
        (i) => Date.parse(i.from) <= at && (i.to === undefined || Date.parse(i.to) > at)
      );
      if (!interval) continue;
      const name =
        groupBy === "category"
          ? interval.category ?? "unknown"
          : interval.statusName ?? interval.statusId ?? "unknown";
      counts[name] = (counts[name] ?? 0) + 1;
      if (!columns.has(name)) columns.set(name, { name, category: interval.category, firstSeen: dayIndex });
    }
    return { date, counts };
  });
  const rank = (category?: FlowCategory) =>
    category ? FLOW_CATEGORIES.indexOf(category) : FLOW_CATEGORIES.length;
  const ordered = [...columns.values()].sort(
    (a, b) => rank(a.category) - rank(b.category) || a.firstSeen - b.firstSeen || a.name.localeCompare(b.name)
  );
  return {
    groupBy,
    columns: ordered.map(({ name, category }) => (category ? { name, category } : { name })),
    days: days.map(({ date, counts }) => ({
      date,
      counts: Object.fromEntries(ordered.map((c) => [c.name, counts[c.name] ?? 0])),
    })),
  };
}

const SPARK = "▁▂▃▄▅▆▇█";

/** ASCII sparkline, scaled to the largest value. */
export function renderSparkline(values: number[]): string {
  const max = Math.max(0, ...values);
  return values
    .map((value) => SPARK[max === 0 ? 0 : Math.round((Math.max(0, value) / max) * (SPARK.length - 1))])
    .join("");
}

function fmt(value: number | null): string {
  return value === null ? "n/a" : value.toFixed(1);
}

function table(header: string[], rows: string[][]): string[] {
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const line = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i])).join("  ").trimEnd();
  return [line(header), line(widths.map((w) => "-".repeat(w))), ...rows.map(line)];
}

/** Text report for `jira analyze flow`. */
export function renderFlowText(metrics: FlowMetricsV1, query: string): string {
  const lines = [
    `Flow metrics ${metrics.window.from.slice(0, 10)} – ${metrics.window.to.slice(0, 10)}`,
    `Query: ${query}`,
    "",
    ...table(
      ["", "count", "min", "P50", "P85", "P95", "max", "mean"],
      (["cycleTime", "leadTime"] as const).map((k) => {
        const s = metrics[k];
        return [
          k === "cycleTime" ? "Cycle time (d)" : "Lead time (d)",
          String(s.count),
          fmt(s.min), fmt(s.p50), fmt(s.p85), fmt(s.p95), fmt(s.max), fmt(s.mean),
        ];
      })
    ),
    "",
    `Throughput per week: ${renderSparkline(metrics.throughput.weekly.map((w) => w.count))}  ` +
      metrics.throughput.weekly.map((w) => `${w.week.slice(5)}:${w.count}`).join(" "),
    `Work in progress: ${metrics.wip.count}`,
  ];
  lines.push(...flowDiagnosticLines(metrics));
  return lines.join("\n");
}

function flowDiagnosticLines(metrics: FlowMetricsV1): string[] {
  const d = metrics.diagnostics;
  const lines: string[] = [];
  if (metrics.cycleTime.p85 === null) {
    lines.push(`Note: fewer than ${FLOW_MIN_PERCENTILE_SAMPLES} completed issues, so no P85/P95.`);
  }
  if (d.skippedWip > 0) lines.push(`Note: ${d.skippedWip} issue(s) skipped in-progress (lead time only).`);
  if (d.unknownStatuses.length > 0) {
    lines.push(
      `Note: unmapped statuses ${d.unknownStatuses.join(", ")}; use --status-map or flow.statusMap.`
    );
  }
  return lines.length ? ["", ...lines] : [];
}

/** Text report for `jira analyze aging`. */
export function renderAgingText(metrics: FlowMetricsV1): string {
  const p85 = metrics.cycleTime.p85;
  const lines = [
    `Aging work in progress: ${metrics.wip.count} issue(s); cycle time P85 ${fmt(p85)} d`,
    "",
  ];
  if (metrics.wip.aging.length === 0) {
    lines.push("No issues in progress.");
  } else {
    lines.push(
      ...table(
        ["", "key", "age (d)", "status", "summary"],
        metrics.wip.aging.map((a) => [
          a.overP85 ? "!" : "",
          a.key,
          a.ageDays.toFixed(1),
          a.status,
          a.summary.length > 60 ? `${a.summary.slice(0, 59)}…` : a.summary,
        ])
      )
    );
    if (p85 !== null) lines.push("", "! = older than the cycle-time P85");
  }
  lines.push(...flowDiagnosticLines(metrics));
  return lines.join("\n");
}

/** Text report for `jira analyze cfd`. */
export function renderCfdText(cfd: CumulativeFlowV1): string {
  const header = ["date", ...cfd.columns.map((c) => c.name)];
  return table(
    header,
    cfd.days.map((day) => [day.date, ...cfd.columns.map((c) => String(day.counts[c.name] ?? 0))])
  ).join("\n");
}
