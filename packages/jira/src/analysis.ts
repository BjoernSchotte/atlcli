/**
 * Sprint analytics and metrics calculation.
 *
 * Calculates velocity, burndown, scope change, and other sprint metrics
 * from issue data. These metrics must be calculated client-side as there
 * is no official Jira API for them.
 */

import type {
  JiraIssue,
  JiraSprint,
  SprintMetrics,
  BurndownDataPoint,
  VelocityTrend,
  JiraChangelogEntry,
} from "./types.js";
import type { StatusCategoryResolver } from "./flow.js";

/**
 * Get story points from an issue using the specified custom field.
 * Returns 0 if the field is not set or not a number.
 */
export function getStoryPoints(issue: JiraIssue, pointsField: string): number {
  const value = issue.fields[pointsField as keyof typeof issue.fields];
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const parsed = parseFloat(value);
    return isNaN(parsed) ? 0 : parsed;
  }
  return 0;
}

/**
 * Check if an issue is complete: its status is in the Done category, or maps
 * to done under `resolve` (a status map, see `createStatusCategoryResolver`).
 */
export function isIssueComplete(issue: JiraIssue, resolve?: StatusCategoryResolver): boolean {
  const status = issue.fields.status;
  if (!status) return false;
  return resolve ? resolve(status) === "done" : status.statusCategory?.key === "done";
}

type ChangelogItem = JiraChangelogEntry["items"][number];

/** An issue as it was at one moment of a sprint, replayed from its changelog. */
export interface SprintIssueSnapshot {
  /** In the sprint at that moment. */
  inSprint: boolean;
  /** Story points at that moment. */
  points: number;
  /** Done at that moment, under the resolver. */
  done: boolean;
}

/**
 * Replay an issue's changelog to `at`: sprint membership, estimate and status.
 * Needs `fields.created` and `fields.issuetype`: an issue created later is not
 * in the sprint, and a sub-task never is (it follows its parent, as in Jira's
 * sprint report). Without
 * `resolve`, a status the issue no longer has counts as not done (its category
 * is unknown).
 */
export function issueAt(
  issue: JiraIssue,
  sprintId: number,
  at: Date,
  pointsField: string,
  resolve?: StatusCategoryResolver
): SprintIssueSnapshot {
  const created = issue.fields.created ? Date.parse(issue.fields.created) : NaN;
  if (created > at.getTime() || issue.fields.issuetype?.subtask) return { inSprint: false, points: 0, done: false };
  const histories = [...(issue.changelog?.histories ?? [])].sort(
    (a, b) => Date.parse(a.created) - Date.parse(b.created)
  );
  const isSprint = (item: ChangelogItem) => item.field === "Sprint";
  const isPoints = (item: ChangelogItem) =>
    item.fieldId !== undefined ? item.fieldId === pointsField : /^story points?$/i.test(item.field);

  const sprint = valueAt(histories, at, isSprint);
  const points = valueAt(histories, at, isPoints);
  const status = valueAt(histories, at, (item) => item.field === "status");

  const pointsThen = points ? Number.parseFloat(points.text ?? points.id ?? "") : getStoryPoints(issue, pointsField);
  let done: boolean;
  if (!status) done = isIssueComplete(issue, resolve);
  else if (resolve) done = resolve({ id: status.id, name: status.text }) === "done";
  else done = status.id !== null && status.id === issue.fields.status?.id && isIssueComplete(issue);

  return {
    // An issue listed for the sprint is in it unless its changelog says otherwise.
    inSprint: sprint ? (sprint.id ?? "").split(",").map((id) => id.trim()).includes(String(sprintId)) : true,
    points: Number.isNaN(pointsThen) ? 0 : pointsThen,
    done,
  };
}

/**
 * When an issue joined and left a sprint between `start` and `end`, from its
 * Sprint changelog: the first join and the last leave in that window.
 */
export function sprintMoves(
  issue: JiraIssue,
  sprintId: number,
  start: Date,
  end: Date
): { joinedAt?: Date; leftAt?: Date } {
  const has = (value: string | null | undefined) => (value ?? "").split(",").map((id) => id.trim()).includes(String(sprintId));
  let joinedAt: Date | undefined;
  let leftAt: Date | undefined;
  for (const history of issue.changelog?.histories ?? []) {
    const at = Date.parse(history.created);
    if (at <= start.getTime() || at > end.getTime()) continue;
    for (const item of history.items) {
      if (item.field !== "Sprint") continue;
      if (!has(item.from) && has(item.to) && (!joinedAt || at < joinedAt.getTime())) joinedAt = new Date(at);
      if (has(item.from) && !has(item.to) && (!leftAt || at > leftAt.getTime())) leftAt = new Date(at);
    }
  }
  return { joinedAt, leftAt };
}

/**
 * An issue at a sprint's start and end (`sprintEnd`). An issue already done at
 * the start is out of the sprint at both: it was finished before, and Jira's
 * sprint report lists it apart ("completed outside this sprint").
 */
export function sprintIssueAt(
  issue: JiraIssue,
  sprint: Pick<JiraSprint, "id" | "startDate" | "completeDate">,
  pointsField: string,
  resolve?: StatusCategoryResolver,
  end: Date = sprintEnd(sprint)
): { start: SprintIssueSnapshot; end: SprintIssueSnapshot } {
  const start = issueAt(issue, sprint.id, new Date(sprint.startDate!), pointsField, resolve);
  const atEnd = issueAt(issue, sprint.id, end, pointsField, resolve);
  if (start.inSprint && start.done) return { start: { ...start, inSprint: false }, end: { ...atEnd, inSprint: false } };
  return { start, end: atEnd };
}

/**
 * A field's value at `at`: the `to` of the last change up to `at`, else the
 * `from` of the first change after it. Undefined when the field never changed
 * (the current value holds). Bulk changelogs omit empty strings, so own
 * properties only.
 */
function valueAt(
  histories: JiraChangelogEntry[],
  at: Date,
  match: (item: ChangelogItem) => boolean
): { id: string | null; text: string | null } | undefined {
  const own = (item: ChangelogItem, key: "from" | "fromString" | "to" | "toString") =>
    Object.hasOwn(item, key) ? (item[key] ?? null) : null;
  let before: ChangelogItem | undefined;
  let after: ChangelogItem | undefined;
  for (const history of histories) {
    const items = history.items.filter(match);
    if (items.length === 0) continue;
    if (Date.parse(history.created) <= at.getTime()) before = items[items.length - 1];
    else after ??= items[0];
  }
  if (before) return { id: own(before, "to"), text: own(before, "toString") };
  if (after) return { id: own(after, "from"), text: own(after, "fromString") };
  return undefined;
}

/**
 * Calculate metrics for a single sprint.
 *
 * @param sprint - The sprint to analyze
 * @param issues - All issues that are/were in the sprint
 * @param pointsField - Custom field ID for story points (e.g., "customfield_10016")
 * @param issuesWithChangelog - The same issues with changelogs and `fields.created`.
 *   With them and a start date, the metrics are as of the sprint (see `issueAt`):
 *   committed at the start, completed at the end (`completeDate`, else now).
 *   Without them, the issues' current state counts.
 * @param resolve - Optional status resolver; without it, done means the Done category
 */
export function calculateSprintMetrics(
  sprint: JiraSprint,
  issues: JiraIssue[],
  pointsField: string,
  issuesWithChangelog?: JiraIssue[],
  resolve?: StatusCategoryResolver
): SprintMetrics {
  if (issuesWithChangelog && sprint.startDate) {
    return sprintMetricsAsOfSprint(sprint, issuesWithChangelog, pointsField, resolve);
  }
  // Calculate points and issue counts
  let committedPoints = 0;
  let completedPoints = 0;
  let completedIssues = 0;
  let incompleteIssues = 0;

  for (const issue of issues) {
    const points = getStoryPoints(issue, pointsField);
    committedPoints += points;

    if (isIssueComplete(issue, resolve)) {
      completedPoints += points;
      completedIssues++;
    } else {
      incompleteIssues++;
    }
  }

  return metricsOf(sprint, { committedPoints, completedPoints, totalIssues: issues.length, completedIssues, addedPoints: 0, removedPoints: 0, addedIssues: 0, removedIssues: 0 });
}

/** The end of a sprint for its metrics: when it was completed, else now. */
export function sprintEnd(sprint: Pick<JiraSprint, "completeDate">, now = new Date()): Date {
  return sprint.completeDate ? new Date(sprint.completeDate) : now;
}

function sprintMetricsAsOfSprint(
  sprint: JiraSprint,
  issues: JiraIssue[],
  pointsField: string,
  resolve?: StatusCategoryResolver
): SprintMetrics {
  let committedPoints = 0;
  let completedPoints = 0;
  let totalIssues = 0;
  let completedIssues = 0;
  let addedPoints = 0;
  let removedPoints = 0;
  let addedIssues = 0;
  let removedIssues = 0;
  const start = new Date(sprint.startDate!);
  const end = sprintEnd(sprint);
  for (const issue of issues) {
    const { start: atStart, end: atEnd } = sprintIssueAt(issue, sprint, pointsField, resolve);
    if (atStart.inSprint) committedPoints += atStart.points;
    // As in Jira's sprint report: added = joined after the start, removed =
    // in the sprint at some point and out at the end. An issue added and
    // removed again during the sprint is both.
    const { joinedAt, leftAt } = issue.fields.issuetype?.subtask ? {} : sprintMoves(issue, sprint.id, start, end);
    // Created in the sprint has no Sprint change: in at the end, out at the start.
    const joined = !atStart.inSprint && (atEnd.inSprint || joinedAt !== undefined);
    if (joined) {
      addedIssues++;
      addedPoints += atEnd.inSprint ? atEnd.points : issueAt(issue, sprint.id, joinedAt!, pointsField, resolve).points;
    }
    if (!atEnd.inSprint && (atStart.inSprint || joined)) {
      removedIssues++;
      removedPoints += atStart.inSprint ? atStart.points : issueAt(issue, sprint.id, leftAt ?? end, pointsField, resolve).points;
    }
    if (!atEnd.inSprint) continue;
    totalIssues++;
    if (atEnd.done) {
      completedIssues++;
      completedPoints += atEnd.points;
    }
  }
  return metricsOf(sprint, { committedPoints, completedPoints, totalIssues, completedIssues, addedPoints, removedPoints, addedIssues, removedIssues });
}

function metricsOf(
  sprint: JiraSprint,
  m: {
    committedPoints: number;
    completedPoints: number;
    totalIssues: number;
    completedIssues: number;
    addedPoints: number;
    removedPoints: number;
    addedIssues: number;
    removedIssues: number;
  }
): SprintMetrics {
  const percentOfCommitted = (points: number) =>
    m.committedPoints > 0 ? Math.round((points / m.committedPoints) * 100) : 0;
  return {
    sprintId: sprint.id,
    sprintName: sprint.name,
    state: sprint.state,
    startDate: sprint.startDate,
    endDate: sprint.endDate,
    completeDate: sprint.completeDate,
    committedPoints: m.committedPoints,
    completedPoints: m.completedPoints,
    totalIssues: m.totalIssues,
    completedIssues: m.completedIssues,
    incompleteIssues: m.totalIssues - m.completedIssues,
    addedDuringSprint: m.addedPoints,
    removedDuringSprint: m.removedPoints,
    addedIssues: m.addedIssues,
    removedIssues: m.removedIssues,
    scopeChangePercent: percentOfCommitted(m.addedPoints + m.removedPoints),
    sayDoRatio: percentOfCommitted(m.completedPoints),
  };
}

/**
 * The `count` most recent sprints, oldest first. Jira lists a board's sprints
 * oldest first, so the first page is the wrong end for "the last N sprints".
 */
export function latestSprints<T extends Pick<JiraSprint, "startDate" | "endDate" | "completeDate">>(
  sprints: T[],
  count: number
): T[] {
  const when = (s: T) => s.completeDate ?? s.endDate ?? s.startDate ?? "";
  return [...sprints].sort((a, b) => when(a).localeCompare(when(b))).slice(-count);
}

/**
 * Calculate velocity trend across multiple sprints.
 *
 * @param boardId - The board ID
 * @param boardName - The board name
 * @param sprintMetrics - Metrics for each sprint (in chronological order)
 */
export function calculateVelocityTrend(
  boardId: number,
  boardName: string,
  sprintMetrics: SprintMetrics[]
): VelocityTrend {
  const sprints = sprintMetrics.map((m) => ({
    id: m.sprintId,
    name: m.sprintName,
    velocity: m.completedPoints,
    completedIssues: m.completedIssues,
  }));

  // Calculate average velocity
  const totalVelocity = sprints.reduce((sum, s) => sum + s.velocity, 0);
  const averageVelocity =
    sprints.length > 0 ? Math.round(totalVelocity / sprints.length) : 0;

  // Calculate trend (percentage change from first half to second half)
  let trend = 0;
  if (sprints.length >= 4) {
    const midpoint = Math.floor(sprints.length / 2);
    const firstHalf = sprints.slice(0, midpoint);
    const secondHalf = sprints.slice(midpoint);

    const firstAvg =
      firstHalf.reduce((sum, s) => sum + s.velocity, 0) / firstHalf.length;
    const secondAvg =
      secondHalf.reduce((sum, s) => sum + s.velocity, 0) / secondHalf.length;

    if (firstAvg > 0) {
      trend = Math.round(((secondAvg - firstAvg) / firstAvg) * 100 * 10) / 10;
    }
  }

  return {
    boardId,
    boardName,
    sprints,
    averageVelocity,
    trend,
  };
}

/**
 * Calculate burndown data for a sprint.
 *
 * Burns down the committed scope: the issues in the sprint at its start, at
 * their estimate then (see `issueAt`). An issue counts on the day it last
 * moved into its status, if it is in the sprint and done at the sprint's end.
 * Requires issues with changelog and `fields.created`.
 *
 * @param sprint - The sprint to analyze
 * @param issuesWithChangelog - Issues with changelog.histories populated
 * @param pointsField - Custom field ID for story points
 * @param resolve - Optional status resolver; without it, done means the Done category
 */
export function calculateBurndown(
  sprint: JiraSprint,
  issuesWithChangelog: JiraIssue[],
  pointsField: string,
  resolve?: StatusCategoryResolver
): BurndownDataPoint[] {
  if (!sprint.startDate || !sprint.endDate) {
    return [];
  }

  const startDate = new Date(sprint.startDate);
  const endDate = sprint.completeDate
    ? new Date(sprint.completeDate)
    : new Date(sprint.endDate);

  const snapshotEnd = sprintEnd(sprint);
  let totalPoints = 0;
  const completionEvents = new Map<string, number>();
  for (const issue of issuesWithChangelog) {
    const { start: atStart, end: atEnd } = sprintIssueAt(issue, sprint, pointsField, resolve, snapshotEnd);
    if (!atStart.inSprint) continue;
    totalPoints += atStart.points;
    const doneAt = atEnd.inSprint && atEnd.done ? lastStatusChange(issue, snapshotEnd) : null;
    if (doneAt && atStart.points > 0) {
      const dateStr = doneAt.toISOString().split("T")[0];
      completionEvents.set(dateStr, (completionEvents.get(dateStr) || 0) + atStart.points);
    }
  }

  // Generate daily burndown data
  const burndown: BurndownDataPoint[] = [];
  const dayMs = 24 * 60 * 60 * 1000;
  const totalDays = Math.ceil((endDate.getTime() - startDate.getTime()) / dayMs);

  let completedSoFar = 0;

  for (let day = 0; day <= totalDays; day++) {
    const currentDate = new Date(startDate.getTime() + day * dayMs);
    const dateStr = currentDate.toISOString().split("T")[0];

    // Add points completed on this day
    const completedToday = completionEvents.get(dateStr) || 0;
    completedSoFar += completedToday;

    const remaining = totalPoints - completedSoFar;
    const ideal = totalPoints * (1 - day / totalDays);

    burndown.push({
      date: dateStr,
      remaining: Math.max(0, remaining),
      ideal: Math.max(0, Math.round(ideal * 10) / 10),
      completed: completedSoFar,
    });
  }

  return burndown;
}

/** When the issue last changed status up to `at`; the resolution date without a changelog. */
function lastStatusChange(issue: JiraIssue, at: Date): Date | null {
  const histories = issue.changelog?.histories;
  if (!histories) return issue.fields.resolutiondate ? new Date(issue.fields.resolutiondate) : null;
  let last: Date | null = null;
  for (const entry of histories) {
    const created = new Date(entry.created);
    if (created <= at && entry.items.some((item) => item.field === "status") && (!last || created > last)) last = created;
  }
  return last;
}

/**
 * Format sprint metrics for display.
 */
export function formatSprintMetrics(metrics: SprintMetrics): string {
  const lines: string[] = [];

  lines.push(`Sprint: ${metrics.sprintName}`);
  lines.push(`State: ${metrics.state}`);

  if (metrics.startDate && metrics.endDate) {
    const start = new Date(metrics.startDate).toLocaleDateString();
    const end = new Date(metrics.endDate).toLocaleDateString();
    lines.push(`Dates: ${start} - ${end}`);
  }

  lines.push("");
  lines.push("Points:");
  lines.push(`  Committed: ${metrics.committedPoints}`);
  lines.push(`  Completed: ${metrics.completedPoints}`);
  lines.push(`  Say-Do Ratio: ${metrics.sayDoRatio}%`);

  lines.push("");
  lines.push("Issues:");
  lines.push(`  Total: ${metrics.totalIssues}`);
  lines.push(`  Completed: ${metrics.completedIssues}`);
  lines.push(`  Incomplete: ${metrics.incompleteIssues}`);

  if (metrics.addedDuringSprint > 0 || metrics.removedDuringSprint > 0) {
    lines.push("");
    lines.push("Scope Change:");
    lines.push(`  Added: ${metrics.addedDuringSprint} points (${metrics.addedIssues} issues)`);
    lines.push(`  Removed: ${metrics.removedDuringSprint} points (${metrics.removedIssues} issues)`);
    lines.push(`  Change: ${metrics.scopeChangePercent}%`);
  }

  return lines.join("\n");
}

/**
 * Generate a simple ASCII progress bar.
 */
export function generateProgressBar(
  completed: number,
  total: number,
  width: number = 20
): string {
  if (total === 0) return `[${"─".repeat(width)}] 0%`;

  const percent = Math.round((completed / total) * 100);
  const filled = Math.round((completed / total) * width);
  const empty = width - filled;

  return `[${"█".repeat(filled)}${"─".repeat(empty)}] ${percent}%`;
}
