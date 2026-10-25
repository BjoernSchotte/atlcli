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
import c_stale from "./confluence/stale.script" with { type: "text" };
import c_orphan from "./confluence/orphan.script" with { type: "text" };
import c_brokenLinks from "./confluence/broken-links.script" with { type: "text" };
import c_externalLinks from "./confluence/external-links.script" with { type: "text" };
import c_externalBroken from "./confluence/external-broken.script" with { type: "text" };
import c_singleContributor from "./confluence/single-contributor.script" with { type: "text" };
import c_inactiveContributors from "./confluence/inactive-contributors.script" with { type: "text" };
import c_missingLabel from "./confluence/missing-label.script" with { type: "text" };
import c_restricted from "./confluence/restricted.script" with { type: "text" };
import c_drafts from "./confluence/drafts.script" with { type: "text" };
import c_archived from "./confluence/archived.script" with { type: "text" };
import c_highChurn from "./confluence/high-churn.script" with { type: "text" };
import c_folders from "./confluence/folders.script" with { type: "text" };
import c_unsynced from "./confluence/unsynced.script" with { type: "text" };

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

/** Wiki (Confluence) rules, in report order. */
export const BUILTIN_CONFLUENCE_AUDIT_RULES: readonly string[] = [
  c_stale,
  c_orphan,
  c_brokenLinks,
  c_externalLinks,
  c_externalBroken,
  c_singleContributor,
  c_inactiveContributors,
  c_missingLabel,
  c_restricted,
  c_drafts,
  c_archived,
  c_highChurn,
  c_folders,
  c_unsynced,
];
