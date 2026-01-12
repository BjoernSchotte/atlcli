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
 * Check if an issue is complete (done status category).
 */
export function isIssueComplete(issue: JiraIssue): boolean {
  return issue.fields.status?.statusCategory?.key === "done";
}

/**
 * Calculate metrics for a single sprint.
 *
 * @param sprint - The sprint to analyze
 * @param issues - All issues that are/were in the sprint
 * @param pointsField - Custom field ID for story points (e.g., "customfield_10016")
 * @param issuesWithChangelog - Optional issues with changelog for scope change calculation
 */
export function calculateSprintMetrics(
  sprint: JiraSprint,
  issues: JiraIssue[],
  pointsField: string,
  issuesWithChangelog?: JiraIssue[]
): SprintMetrics {
  // Calculate points and issue counts
  let committedPoints = 0;
  let completedPoints = 0;
  let completedIssues = 0;
  let incompleteIssues = 0;

  for (const issue of issues) {
    const points = getStoryPoints(issue, pointsField);
    committedPoints += points;

    if (isIssueComplete(issue)) {
      completedPoints += points;
      completedIssues++;
    } else {
      incompleteIssues++;
    }
  }

  // Calculate scope change if changelog is available
  let addedDuringSprint = 0;
  let removedDuringSprint = 0;

  if (issuesWithChangelog && sprint.startDate) {
    const sprintStart = new Date(sprint.startDate);
    const sprintEnd = sprint.endDate ? new Date(sprint.endDate) : new Date();

    for (const issue of issuesWithChangelog) {
      const scopeChange = analyzeSprintScopeChange(
        issue,
        sprint.id,
        sprintStart,
        sprintEnd,
        pointsField
      );
      addedDuringSprint += scopeChange.added;
      removedDuringSprint += scopeChange.removed;
    }
  }

  // Calculate derived metrics
  const scopeChangePercent =
    committedPoints > 0
      ? Math.round(((addedDuringSprint + removedDuringSprint) / committedPoints) * 100)
      : 0;

  const sayDoRatio =
    committedPoints > 0
      ? Math.round((completedPoints / committedPoints) * 100)
      : 0;

  return {
    sprintId: sprint.id,
    sprintName: sprint.name,
    state: sprint.state,
    startDate: sprint.startDate,
    endDate: sprint.endDate,
    completeDate: sprint.completeDate,
    committedPoints,
    completedPoints,
    totalIssues: issues.length,
    completedIssues,
    incompleteIssues,
    addedDuringSprint,
    removedDuringSprint,
    scopeChangePercent,
    sayDoRatio,
  };
}

/**
 * Analyze changelog to detect scope changes during a sprint.
 */
function analyzeSprintScopeChange(
  issue: JiraIssue,
  sprintId: number,
  sprintStart: Date,
  sprintEnd: Date,
  pointsField: string
): { added: number; removed: number } {
  const changelog = issue.changelog?.histories;
  if (!changelog) return { added: 0, removed: 0 };

  let added = 0;
  let removed = 0;
  const points = getStoryPoints(issue, pointsField);

  for (const entry of changelog) {
    const changeDate = new Date(entry.created);

    // Only consider changes during the sprint
    if (changeDate < sprintStart || changeDate > sprintEnd) continue;

    for (const item of entry.items) {
      // Check for Sprint field changes
      if (item.field === "Sprint") {
        const fromSprints = parseSprintIds(item.fromString);
        const toSprints = parseSprintIds(item.toString);

        const wasInSprint = fromSprints.includes(sprintId);
        const isInSprint = toSprints.includes(sprintId);

        if (!wasInSprint && isInSprint) {
          // Added to sprint during sprint
          added += points;
        } else if (wasInSprint && !isInSprint) {
          // Removed from sprint during sprint
          removed += points;
        }
      }
    }
  }

  return { added, removed };
}

/**
 * Parse sprint IDs from a sprint field string value.
 * Format varies: "Sprint 1, Sprint 2" or just sprint names/IDs.
 */
function parseSprintIds(value: string | null): number[] {
  if (!value) return [];

  // Try to extract sprint IDs from the string
  // Common formats: "com.atlassian.greenhopper.service.sprint.Sprint@...[id=123,...]"
  // or just "Sprint 1, Sprint 2"
  const ids: number[] = [];

  // Match id=<number> pattern
  const idMatches = value.matchAll(/id=(\d+)/g);
  for (const match of idMatches) {
    ids.push(parseInt(match[1], 10));
  }

  return ids;
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
 * Requires issues with changelog expanded to track when work was completed.
 *
 * @param sprint - The sprint to analyze
 * @param issuesWithChangelog - Issues with changelog.histories populated
 * @param pointsField - Custom field ID for story points
 */
export function calculateBurndown(
  sprint: JiraSprint,
  issuesWithChangelog: JiraIssue[],
  pointsField: string
): BurndownDataPoint[] {
  if (!sprint.startDate || !sprint.endDate) {
    return [];
  }

  const startDate = new Date(sprint.startDate);
  const endDate = sprint.completeDate
    ? new Date(sprint.completeDate)
    : new Date(sprint.endDate);

  // Calculate total committed points at sprint start
  const totalPoints = issuesWithChangelog.reduce(
    (sum, issue) => sum + getStoryPoints(issue, pointsField),
    0
  );

  // Build a map of completion dates
  const completionEvents = buildCompletionTimeline(
    issuesWithChangelog,
    pointsField
  );

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

/**
 * Build a timeline of when issues were completed (moved to Done status).
 * Returns a map of date string -> points completed that day.
 */
function buildCompletionTimeline(
  issues: JiraIssue[],
  pointsField: string
): Map<string, number> {
  const timeline = new Map<string, number>();

  for (const issue of issues) {
    const points = getStoryPoints(issue, pointsField);
    if (points === 0) continue;

    const completionDate = findCompletionDate(issue);
    if (completionDate) {
      const dateStr = completionDate.toISOString().split("T")[0];
      timeline.set(dateStr, (timeline.get(dateStr) || 0) + points);
    }
  }

  return timeline;
}

/**
 * Find when an issue was moved to Done status (from changelog).
 */
function findCompletionDate(issue: JiraIssue): Date | null {
  // If currently complete, look for when it transitioned to Done
  if (!isIssueComplete(issue)) return null;

  const changelog = issue.changelog?.histories;
  if (!changelog) {
    // No changelog, use resolution date if available
    if (issue.fields.resolutiondate) {
      return new Date(issue.fields.resolutiondate);
    }
    return null;
  }

  // Find the most recent transition to a Done status
  for (let i = changelog.length - 1; i >= 0; i--) {
    const entry = changelog[i];
    for (const item of entry.items) {
      if (item.field === "status") {
        // Check if this was a transition to Done
        // We look for Done status category in the "to" value
        // Note: The changelog toString is just the status name, not category
        // We need to trust that the current status is Done and this was the transition
        if (isIssueComplete(issue)) {
          return new Date(entry.created);
        }
      }
    }
  }

  // Fallback to resolution date
  if (issue.fields.resolutiondate) {
    return new Date(issue.fields.resolutiondate);
  }

  return null;
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
    lines.push(`  Added: ${metrics.addedDuringSprint} points`);
    lines.push(`  Removed: ${metrics.removedDuringSprint} points`);
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
