import {
  canonicalJsonV1,
  type CanonicalJsonValue,
  type ChangeOperationV1,
  type ChangeSetV1,
  type SemanticPathV1,
} from "@atlcli/change-set";

export interface SemanticDiffRenderOptions {
  color?: boolean;
  maxValueCharacters?: number;
}

const ANSI = {
  reset: "\u001b[0m",
  cyan: "\u001b[36m",
  green: "\u001b[32m",
  red: "\u001b[31m",
  yellow: "\u001b[33m",
} as const;

function paint(value: string, color: keyof Omit<typeof ANSI, "reset">, enabled: boolean): string {
  return enabled ? `${ANSI[color]}${value}${ANSI.reset}` : value;
}

function pathLabel(path: SemanticPathV1): string {
  if (path.length === 0) return "document";
  return path
    .map((segment, index) =>
      typeof segment === "number"
        ? `[${segment}]`
        : index === 0
          ? segment
          : `.${segment}`,
    )
    .join("");
}

function boundedValue(value: CanonicalJsonValue, maxCharacters: number): string {
  const rendered = typeof value === "string" ? value : canonicalJsonV1(value);
  if (rendered.length <= maxCharacters) return rendered;
  return `${rendered.slice(0, Math.max(0, maxCharacters - 1))}…`;
}

function renderOperation(
  operation: ChangeOperationV1,
  color: boolean,
  maxValueCharacters: number,
): string {
  const path = pathLabel(operation.path);
  switch (operation.kind) {
    case "insert":
      return paint(`+ ${path}: ${boundedValue(operation.after, maxValueCharacters)}`, "green", color);
    case "delete":
      return paint(`- ${path}: ${boundedValue(operation.before, maxValueCharacters)}`, "red", color);
    case "modify":
      return paint(
        `~ ${path}: ${boundedValue(operation.before, maxValueCharacters)} -> ${boundedValue(operation.after, maxValueCharacters)}`,
        "cyan",
        color,
      );
    case "move":
      return paint(
        `> ${pathLabel(operation.fromPath)} -> ${path} [${operation.matchBasis}]`,
        "cyan",
        color,
      );
    case "collection-add":
      return paint(`+ ${path}: ${boundedValue(operation.item, maxValueCharacters)}`, "green", color);
    case "collection-remove":
      return paint(`- ${path}: ${boundedValue(operation.item, maxValueCharacters)}`, "red", color);
    case "transition": {
      const before = operation.before.label ?? operation.before.id;
      const after = operation.after.label ?? operation.after.id;
      return paint(`~ ${path}: ${before} -> ${after} [transition]`, "yellow", color);
    }
    case "opaque-change":
      return paint(`! ${operation.reason} at ${path}`, "yellow", color);
  }
}

/** Render a deterministic, bounded human view without modifying the ChangeSet. */
export function renderSemanticDiff(
  changeSet: ChangeSetV1,
  options: SemanticDiffRenderOptions = {},
): string {
  const color = options.color ?? false;
  const maxValueCharacters = options.maxValueCharacters ?? 240;
  if (!Number.isSafeInteger(maxValueCharacters) || maxValueCharacters < 16) {
    throw new TypeError("maxValueCharacters must be an integer of at least 16");
  }

  const label = changeSet.subject.label
    ? ` \"${changeSet.subject.label}\"`
    : ` ${changeSet.subject.id}`;
  const deployment = changeSet.target.deployment ?? "unknown-deployment";
  const header = `${changeSet.subject.kind === "page" ? "Wiki page" : "Jira issue"}${label}  v${changeSet.baseline.revision} -> v${changeSet.target.revision}  [${deployment} / ${changeSet.target.representation}]`;
  const lines = [header, ""];

  if (changeSet.operations.length === 0) {
    lines.push("No semantic changes.");
  } else {
    for (const operation of changeSet.operations) {
      lines.push(renderOperation(operation, color, maxValueCharacters));
    }
  }

  for (const diagnostic of changeSet.completeness.diagnostics) {
    if (diagnostic.severity === "info" && diagnostic.code === "policy-noise") continue;
    const location = diagnostic.path ? ` at ${pathLabel(diagnostic.path)}` : "";
    lines.push(paint(`! ${diagnostic.code}${location}: ${diagnostic.message}`, "yellow", color));
  }

  const summary = changeSet.summary;
  lines.push("");
  lines.push(
    `Summary: ${summary.inserts} added, ${summary.deletes} deleted, ${summary.modifies} modified, ${summary.moves} moved, ${summary.opaque} opaque`,
  );
  const completenessSuffix = changeSet.limits.truncated ? "; truncated" : "";
  lines.push(`Completeness: ${changeSet.completeness.status}${completenessSuffix}`);
  return lines.join("\n");
}
