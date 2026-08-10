import {
  type CanonicalJsonValue,
  type ChangeDiagnosticV1,
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

type JsonObject = { readonly [key: string]: CanonicalJsonValue };

function jsonObject(value: CanonicalJsonValue | undefined): JsonObject | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : undefined;
}

function boundedText(value: string, maxCharacters: number): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  if (normalized.length <= maxCharacters) return normalized;
  return `${normalized.slice(0, Math.max(0, maxCharacters - 1)).trimEnd()}…`;
}

function quoted(value: string, maxCharacters: number): string {
  return `“${boundedText(value, maxCharacters)}”`;
}

function nodeKind(value: CanonicalJsonValue | undefined): string | undefined {
  const kind = jsonObject(value)?.kind;
  return typeof kind === "string" ? kind : undefined;
}

function nodeChildren(value: CanonicalJsonValue | undefined): readonly CanonicalJsonValue[] {
  const children = jsonObject(value)?.children;
  return Array.isArray(children) ? children : [];
}

function findNode(
  value: CanonicalJsonValue | undefined,
  predicate: (kind: string) => boolean,
): JsonObject | undefined {
  const object = jsonObject(value);
  const kind = nodeKind(value);
  if (object && kind && predicate(kind)) return object;
  for (const child of nodeChildren(value)) {
    const found = findNode(child, predicate);
    if (found) return found;
  }
  return undefined;
}

function visibleText(value: CanonicalJsonValue | undefined, limit = 1_000): string {
  if (typeof value === "string") return value;
  const object = jsonObject(value);
  if (!object) return "";
  const direct = typeof object.text === "string" ? object.text : "";
  if (direct.length >= limit) return direct.slice(0, limit);
  let output = direct;
  for (const child of nodeChildren(value)) {
    output += visibleText(child, Math.max(0, limit - output.length));
    if (output.length >= limit) break;
  }
  return output;
}

function attributeString(value: CanonicalJsonValue | undefined, name: string): string | undefined {
  const attributes = jsonObject(jsonObject(value)?.attributes);
  const candidate = attributes?.[name];
  return typeof candidate === "string" && candidate.trim() !== "" ? candidate : undefined;
}

const KIND_LABELS: Readonly<Record<string, string>> = Object.freeze({
  blockquote: "Quote",
  card: "Link card",
  codeBlock: "Code block",
  date: "Date",
  decisionItem: "Decision",
  emoji: "Emoji",
  extension: "Macro",
  heading: "Heading",
  "line-break": "Line break",
  list: "List",
  "list-item": "List item",
  media: "Image",
  mediaInline: "Inline image",
  mediaSingle: "Image",
  mention: "Mention",
  panel: "Panel",
  paragraph: "Paragraph",
  placeholder: "Placeholder",
  rule: "Divider",
  status: "Status",
  table: "Table",
  "table-cell": "Table cell",
  tableRow: "Table row",
  text: "Text",
});

function kindLabel(kind: string | undefined): string {
  if (!kind) return "Value";
  return KIND_LABELS[kind] ?? kind.replace(/([a-z])([A-Z])/gu, "$1 $2")
    .replace(/[-_]+/gu, " ")
    .replace(/^./u, (character) => character.toUpperCase());
}

function preferredLabel(value: CanonicalJsonValue | undefined): string | undefined {
  const object = jsonObject(value);
  if (!object) return undefined;
  const direct = [object.label, object.name, object.title, object.key]
    .find((candidate) => typeof candidate === "string" && candidate.trim() !== "");
  if (typeof direct === "string") return direct;
  for (const attribute of ["alt", "text", "shortName", "title", "url"]) {
    const candidate = attributeString(value, attribute);
    if (candidate) return candidate;
  }
  const text = visibleText(value);
  return text.trim() === "" ? undefined : text;
}

function describeValue(value: CanonicalJsonValue, maxCharacters: number): string {
  if (typeof value === "string") return quoted(value, maxCharacters);
  if (value === null) return "empty value";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return `${value.length} item${value.length === 1 ? "" : "s"}`;

  const kind = nodeKind(value);
  if (kind === "mediaSingle" || kind === "media" || kind === "mediaInline") {
    const media = findNode(value, (candidate) => candidate === "media" || candidate === "mediaInline") ?? value;
    const label = preferredLabel(media);
    return label ? `${kindLabel(kind)} ${quoted(label, maxCharacters)}` : kindLabel(kind);
  }
  if (kind === "paragraph" && !preferredLabel(value)) return "Empty paragraph";
  const label = preferredLabel(value);
  if (kind) return label ? `${kindLabel(kind)} ${quoted(label, maxCharacters)}` : kindLabel(kind);

  const fallback = preferredLabel(value);
  return fallback ? quoted(fallback, maxCharacters) : "Value";
}

function locationLabel(path: SemanticPathV1): string | undefined {
  const contentIndex = path.findIndex((segment) => segment === "content");
  const block = contentIndex >= 0 ? path[contentIndex + 1] : undefined;
  if (typeof block === "number") return `block ${block + 1}`;
  if (path[0] === "fields" && typeof path[1] === "string") return `field ${path[1]}`;
  return undefined;
}

function atLocation(path: SemanticPathV1): string {
  const location = locationLabel(path);
  return location ? ` (${location})` : "";
}

function changedValue(
  before: CanonicalJsonValue,
  after: CanonicalJsonValue,
  maxCharacters: number,
): string {
  const beforeKind = nodeKind(before);
  const afterKind = nodeKind(after);
  const beforeLabel = preferredLabel(before);
  const afterLabel = preferredLabel(after);
  if (beforeKind === afterKind && beforeLabel && afterLabel && beforeLabel !== afterLabel) {
    return `${kindLabel(afterKind)}: ${quoted(beforeLabel, maxCharacters)} → ${quoted(afterLabel, maxCharacters)}`;
  }
  const left = describeValue(before, maxCharacters);
  const right = describeValue(after, maxCharacters);
  return left === right ? `${right} details` : `${left} → ${right}`;
}

function representationLabel(value: ChangeSetV1["target"]["representation"]): string {
  if (value === "atlas_doc_format") return "ADF";
  if (value === "storage") return "Storage";
  return value;
}

function diagnosticText(diagnostic: ChangeDiagnosticV1): string {
  switch (diagnostic.code) {
    case "ambiguous-match":
      return "Some repeated elements could not be matched uniquely; no moves were inferred.";
    case "opaque-source-change":
      return "Some source details need manual review because their semantics are unknown.";
    case "source-fallback":
      return "The preferred source representation was unavailable; both versions used the documented fallback.";
    case "source-incomplete":
      return "The source could not be represented completely.";
    case "limit-exceeded":
      return "The diff exceeded a configured safety limit.";
    case "unavailable-transition":
      return "The requested Jira transition is unavailable.";
    case "missing-observed-value":
      return "A required observed Jira value is missing.";
    case "policy-noise":
      return diagnostic.message;
  }
}

function operationValue(operation: ChangeOperationV1): CanonicalJsonValue | undefined {
  switch (operation.kind) {
    case "insert": return operation.after;
    case "delete": return operation.before;
    case "modify": return operation.after;
    case "move": return operation.value;
    case "collection-add":
    case "collection-remove": return operation.item;
    case "opaque-change": return operation.after ?? operation.before;
    case "transition": return undefined;
  }
}

function groupableOperationKey(operation: ChangeOperationV1): string | undefined {
  if (operation.kind === "opaque-change") {
    return `${operation.kind}|${operation.reason}|${nodeKind(operationValue(operation)) ?? "value"}`;
  }
  if (operation.kind !== "insert" && operation.kind !== "delete") return undefined;
  const value = operationValue(operation);
  if (value === undefined) return undefined;
  const description = describeValue(value, 80);
  if (description.includes("“")) return undefined;
  return `${operation.kind}|${description}`;
}

function pluralDescription(description: string, count: number): string {
  const normalized = description.charAt(0).toLowerCase() + description.slice(1);
  if (count === 1) return normalized;
  if (normalized === "empty paragraph") return "empty paragraphs";
  if (normalized === "image") return "images";
  if (normalized === "inline image") return "inline images";
  if (normalized.endsWith("status")) return `${normalized}es`;
  return normalized.endsWith("s") ? normalized : `${normalized}s`;
}

function humanReviewReason(
  reason: string,
  value: CanonicalJsonValue | undefined,
  plural = false,
): string {
  if (reason === "An exact source change was not represented by the semantic projection.") {
    const kind = nodeKind(value);
    return kind === "mediaSingle" || kind === "media" || kind === "mediaInline"
      ? `Confluence did not expose enough stable media metadata to match ${plural ? "them" : "it"} safely.`
      : "Confluence source details could not be mapped safely to the semantic view.";
  }
  if (reason === "Opaque semantic content changed.") {
    return "This content type is not understood completely.";
  }
  return reason;
}

function renderOperationGroup(
  operations: readonly ChangeOperationV1[],
  color: boolean,
  maxValueCharacters: number,
): string {
  const first = operations[0]!;
  if (operations.length === 1) return renderOperation(first, color, maxValueCharacters);
  const value = operationValue(first);
  const description = value === undefined ? "value" : describeValue(value, maxValueCharacters);
  const plural = pluralDescription(description, operations.length);
  if (first.kind === "insert") {
    return paint(`+ Added ${operations.length} ${plural}`, "green", color);
  }
  if (first.kind === "delete") {
    return paint(`- Removed ${operations.length} ${plural}`, "red", color);
  }
  if (first.kind === "opaque-change") {
    return paint(
      `! ${operations.length} ${plural} require review: ${humanReviewReason(first.reason, value, true)}`,
      "yellow",
      color,
    );
  }
  return renderOperation(first, color, maxValueCharacters);
}

function operationGroups(operations: readonly ChangeOperationV1[]): ChangeOperationV1[][] {
  const groups: ChangeOperationV1[][] = [];
  const groupedIndexes = new Map<string, number>();
  for (const operation of operations) {
    const key = groupableOperationKey(operation);
    if (key === undefined) {
      groups.push([operation]);
      continue;
    }
    const existing = groupedIndexes.get(key);
    if (existing === undefined) {
      groupedIndexes.set(key, groups.length);
      groups.push([operation]);
    } else {
      groups[existing]!.push(operation);
    }
  }
  return groups;
}

function renderOperation(
  operation: ChangeOperationV1,
  color: boolean,
  maxValueCharacters: number,
): string {
  switch (operation.kind) {
    case "insert":
      return paint(`+ Added ${describeValue(operation.after, maxValueCharacters)}${atLocation(operation.path)}`, "green", color);
    case "delete":
      return paint(`- Removed ${describeValue(operation.before, maxValueCharacters)}${atLocation(operation.path)}`, "red", color);
    case "modify":
      return paint(
        `~ Changed ${changedValue(operation.before, operation.after, maxValueCharacters)}${atLocation(operation.path)}`,
        "cyan",
        color,
      );
    case "move":
      return paint(
        `> Moved ${describeValue(operation.value, maxValueCharacters)} from ${locationLabel(operation.fromPath) ?? "its previous position"} to ${locationLabel(operation.path) ?? "its new position"}`,
        "cyan",
        color,
      );
    case "collection-add":
      return paint(`+ Added ${describeValue(operation.item, maxValueCharacters)}${atLocation(operation.path)}`, "green", color);
    case "collection-remove":
      return paint(`- Removed ${describeValue(operation.item, maxValueCharacters)}${atLocation(operation.path)}`, "red", color);
    case "transition": {
      const before = operation.before.label ?? operation.before.id;
      const after = operation.after.label ?? operation.after.id;
      return paint(`~ Changed status: ${before} → ${after}`, "yellow", color);
    }
    case "opaque-change":
      return paint(
        `! Review required: ${humanReviewReason(operation.reason, operationValue(operation))}${atLocation(operation.path)}`,
        "yellow",
        color,
      );
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
  const header = `${changeSet.subject.kind === "page" ? "Wiki page" : "Jira issue"}${label} — version ${changeSet.baseline.revision} → ${changeSet.target.revision} (${deployment === "cloud" ? "Cloud" : deployment === "data-center" ? "Data Center" : deployment}, ${representationLabel(changeSet.target.representation)})`;
  const lines = [header, ""];

  if (changeSet.operations.length === 0) {
    lines.push("No semantic changes.");
  } else {
    for (const group of operationGroups(changeSet.operations)) {
      lines.push(renderOperationGroup(group, color, maxValueCharacters));
    }
  }

  const renderedDiagnostics = new Set<string>();
  for (const diagnostic of changeSet.completeness.diagnostics) {
    if (diagnostic.severity === "info" && diagnostic.code === "policy-noise") continue;
    if (diagnostic.code === "opaque-source-change" && changeSet.summary.opaque > 0) continue;
    const text = diagnosticText(diagnostic);
    const key = diagnostic.code === "ambiguous-match" ? diagnostic.code : `${diagnostic.code}|${text}`;
    if (renderedDiagnostics.has(key)) continue;
    renderedDiagnostics.add(key);
    lines.push(paint(`! ${text}`, "yellow", color));
  }

  const summary = changeSet.summary;
  lines.push("");
  lines.push(
    `Summary: ${summary.inserts} added, ${summary.deletes} removed, ${summary.modifies} changed, ${summary.moves} moved, ${summary.opaque} requiring review`,
  );
  const completenessSuffix = changeSet.limits.truncated ? "; truncated" : "";
  lines.push(`Coverage: ${changeSet.completeness.status}${completenessSuffix}`);
  return lines.join("\n");
}
