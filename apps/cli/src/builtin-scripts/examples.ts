/** Example scripts `atlcli script init --example <name>` writes; examples.test.ts plans each of them. */
import closeInactive from "./examples/close-inactive.script" with { type: "text" };
import copyField from "./examples/copy-field.script" with { type: "text" };
import epicStatusPage from "./examples/epic-status-page.script" with { type: "text" };
import fieldUsage from "./examples/field-usage.script" with { type: "text" };
import normalizeLabels from "./examples/normalize-labels.script" with { type: "text" };
import staleComment from "./examples/stale-comment.script" with { type: "text" };

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
  { name: "field-usage", mode: "run", source: fieldUsage },
  { name: "epic-status-page", mode: "run", source: epicStatusPage },
];

/** The `description` of an example's meta, for listings. */
export function exampleDescription(example: ScriptExample): string {
  return /description:\s*"([^"]*)"/.exec(example.source)?.[1] ?? "";
}
