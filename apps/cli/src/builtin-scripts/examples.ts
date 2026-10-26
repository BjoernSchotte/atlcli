/** Example scripts `atlcli script init --example <name>` writes; examples.test.ts plans each of them. */
import closeInactive from "./examples/close-inactive.script" with { type: "text" };
import closeParent from "./examples/close-parent-when-subtasks-done.script" with { type: "text" };
import copyField from "./examples/copy-field.script" with { type: "text" };
import epicStatusPage from "./examples/epic-status-page.script" with { type: "text" };
import fieldUsage from "./examples/field-usage.script" with { type: "text" };
import normalizeLabels from "./examples/normalize-labels.script" with { type: "text" };
import propagateFixVersion from "./examples/propagate-fix-version.script" with { type: "text" };
import releaseVersion from "./examples/release-version.script" with { type: "text" };
import staleComment from "./examples/stale-comment.script" with { type: "text" };
import subtasksFromChecklist from "./examples/subtasks-from-checklist.script" with { type: "text" };
import unblock from "./examples/unblock-when-blocker-done.script" with { type: "text" };
import worklogReport from "./examples/worklog-report.script" with { type: "text" };

export interface ScriptExample {
  name: string;
  /** each: runs once per issue (meta.each); run: one run over everything. */
  mode: "each" | "run";
  source: string;
}

export const SCRIPT_EXAMPLES: readonly ScriptExample[] = [
  { name: "stale-comment", mode: "each", source: staleComment },
  { name: "normalize-labels", mode: "each", source: normalizeLabels },
  { name: "close-inactive", mode: "each", source: closeInactive },
  { name: "copy-field", mode: "each", source: copyField },
  { name: "close-parent-when-subtasks-done", mode: "each", source: closeParent },
  { name: "propagate-fix-version", mode: "each", source: propagateFixVersion },
  { name: "unblock-when-blocker-done", mode: "each", source: unblock },
  { name: "subtasks-from-checklist", mode: "run", source: subtasksFromChecklist },
  { name: "field-usage", mode: "run", source: fieldUsage },
  { name: "epic-status-page", mode: "run", source: epicStatusPage },
  { name: "release-version", mode: "run", source: releaseVersion },
  { name: "worklog-report", mode: "run", source: worklogReport },
];

/** The `description` of an example's meta, for listings. */
export function exampleDescription(example: ScriptExample): string {
  return /description:\s*"([^"]*)"/.exec(example.source)?.[1] ?? "";
}
