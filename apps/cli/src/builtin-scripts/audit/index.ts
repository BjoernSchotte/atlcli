/** The built-in audit rules, as scripts (`atlcli audit … --print-rule <id>` prints one). Report order. */
import doneWithoutVersion from "./jira/done-without-version.script" with { type: "text" };
import dueSoon from "./jira/due-soon.script" with { type: "text" };
import flagged from "./jira/flagged.script" with { type: "text" };
import noParent from "./jira/no-parent.script" with { type: "text" };
import overdue from "./jira/overdue.script" with { type: "text" };
import resolvedNotDone from "./jira/resolved-not-done.script" with { type: "text" };
import stale from "./jira/stale.script" with { type: "text" };
import statusAging from "./jira/status-aging.script" with { type: "text" };
import stuckWip from "./jira/stuck-wip.script" with { type: "text" };
import unassignedWip from "./jira/unassigned-wip.script" with { type: "text" };
import unestimatedInSprint from "./jira/unestimated-in-sprint.script" with { type: "text" };

export const BUILTIN_JIRA_AUDIT_RULES: readonly string[] = [
  resolvedNotDone,
  stuckWip,
  statusAging,
  unassignedWip,
  overdue,
  dueSoon,
  flagged,
  stale,
  noParent,
  unestimatedInSprint,
  doneWithoutVersion,
];

/** Wiki (Confluence) rules; filled in with the wiki audit. */
export const BUILTIN_CONFLUENCE_AUDIT_RULES: readonly string[] = [];
