import {
  canonicalJsonV1,
  createChangeOperationIdV1,
  diffSemanticTreesV1,
  digestSnapshotV1,
  parseChangeSetV1,
  type CanonicalJsonValue,
  type ChangeDiagnosticV1,
  type ChangeEntityRefV1,
  type ChangeOperationDraftV1,
  type ChangeOperationV1,
  type ChangeRiskTagV1,
  type ChangeSetV1,
  type SemanticPathV1,
} from "@atlcli/change-set";
import { canonicalizeAdfV1 } from "@atlcli/change-set/adf";
import type {
  AdfDocument,
  JiraIssue,
  JiraTransition,
  TransitionIssueInput,
  UpdateIssueInput,
} from "./types.js";

const JIRA_SOURCE = Object.freeze({
  baseline: "jira-fields",
  target: "jira-fields",
} as const);

const COLLECTION_FIELDS = new Set(["labels", "components", "fixVersions", "versions"]);
const ENTITY_FIELDS = new Set(["priority", "assignee", "issuetype", "project", "parent"]);
const SCALAR_FIELDS = new Set(["summary", "duedate"]);

type Intent = "fields-replace" | "update-set" | "update-add" | "update-remove";

interface NormalizedFieldValue {
  value: CanonicalJsonValue;
  opaqueReason?: string;
}

interface ActionSnapshot {
  path: SemanticPathV1;
  intent: Intent;
  value: CanonicalJsonValue;
}

interface PlanningContext {
  issue: JiraIssue;
  diagnostics: ChangeDiagnosticV1[];
  drafts: ChangeOperationDraftV1[];
  baselineActions: ActionSnapshot[];
  targetActions: ActionSnapshot[];
  state: Map<string, unknown>;
}

/** An intended transition plus the transitions observed as currently available. */
export interface JiraTransitionPlanInputV1 {
  transition: TransitionIssueInput["transition"];
  availableTransitions: readonly JiraTransition[];
}

/** A resolved transition may be supplied directly when availability was already checked. */
export type JiraTransitionChangeInputV1 = JiraTransition | JiraTransitionPlanInputV1;

function own(value: object, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function canonical(value: unknown): CanonicalJsonValue {
  return JSON.parse(canonicalJsonV1(value)) as CanonicalJsonValue;
}

function equal(left: CanonicalJsonValue, right: CanonicalJsonValue): boolean {
  return canonicalJsonV1(left) === canonicalJsonV1(right);
}

function entityIdentityValue(value: CanonicalJsonValue): CanonicalJsonValue {
  if (value === null) return null;
  if (isRecord(value) && typeof value.id === "string") return value.id;
  return value;
}

function fieldEqual(
  field: string,
  left: CanonicalJsonValue,
  right: CanonicalJsonValue,
): boolean {
  if (ENTITY_FIELDS.has(field)) {
    return equal(entityIdentityValue(left), entityIdentityValue(right));
  }
  if (COLLECTION_FIELDS.has(field) && field !== "labels" &&
      Array.isArray(left) && Array.isArray(right)) {
    const identities = (values: readonly CanonicalJsonValue[]): CanonicalJsonValue =>
      values.map(entityIdentityValue).sort((a, b) => canonicalJsonV1(a).localeCompare(canonicalJsonV1(b)));
    return equal(identities(left), identities(right));
  }
  return equal(left, right);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAdfDocument(value: unknown): value is AdfDocument {
  return isRecord(value) && value.type === "doc" && value.version === 1 && Array.isArray(value.content);
}

function entity(value: unknown, field: string): ChangeEntityRefV1 | undefined {
  if (!isRecord(value)) return undefined;
  const id = field === "assignee"
    ? typeof value.accountId === "string" && value.accountId.length > 0
      ? value.accountId
      : typeof value.name === "string" && value.name.length > 0
        ? value.name
        : undefined
    : typeof value.id === "string" && value.id.length > 0
      ? value.id
      : undefined;
  if (!id) return undefined;
  const label = typeof value.displayName === "string"
    ? value.displayName
    : typeof value.name === "string"
      ? value.name
      : typeof value.key === "string"
        ? value.key
        : undefined;
  return { id, ...(label !== undefined ? { label } : {}) };
}

function normalizeCollection(field: string, value: unknown): NormalizedFieldValue {
  if (!Array.isArray(value)) {
    return {
      value: canonical(value),
      opaqueReason: `Jira field ${field} was expected to be a set-like collection.`,
    };
  }
  if (field === "labels") {
    if (!value.every((item) => typeof item === "string")) {
      return {
        value: canonical(value),
        opaqueReason: "Jira labels contained a non-string value.",
      };
    }
    return { value: [...new Set(value as string[])].sort() };
  }
  const entities = value.map((item) => entity(item, field));
  if (entities.some((item) => item === undefined)) {
    return {
      value: canonical(value),
      opaqueReason: `Jira field ${field} contained an entity without a stable id.`,
    };
  }
  const byId = new Map<string, ChangeEntityRefV1>();
  for (const item of entities as ChangeEntityRefV1[]) byId.set(item.id, item);
  return {
    value: canonical([...byId.values()].sort((left, right) => left.id.localeCompare(right.id))),
  };
}

function normalizeField(field: string, value: unknown): NormalizedFieldValue {
  if (COLLECTION_FIELDS.has(field)) return normalizeCollection(field, value);
  if (ENTITY_FIELDS.has(field)) {
    if (value === null && field === "assignee") return { value: null };
    const reference = entity(value, field);
    return reference
      ? { value: canonical(reference) }
      : {
          value: canonical(value),
          opaqueReason: `Jira field ${field} did not provide a stable entity id.`,
        };
  }
  if (SCALAR_FIELDS.has(field) || field === "description") {
    return { value: canonical(value) };
  }
  return {
    value: canonical(value),
    opaqueReason: `Jira field ${field} has no reviewed semantic adapter.`,
  };
}

function operationBase(
  path: SemanticPathV1,
  riskTags: readonly ChangeRiskTagV1[],
  matchBasis: "stable-id" | "position" | "opaque" = "position",
): Omit<ChangeOperationDraftV1, "kind"> {
  return {
    path,
    matchBasis,
    confidence: matchBasis === "stable-id" ? "anchored" : "conservative",
    riskTags,
    source: JIRA_SOURCE,
    coveredSourceChangeIds: [],
  };
}

function pushDiagnostic(context: PlanningContext, diagnostic: ChangeDiagnosticV1): void {
  context.diagnostics.push(diagnostic);
}

function pushOpaque(
  context: PlanningContext,
  path: SemanticPathV1,
  reason: string,
  before: CanonicalJsonValue,
  after: CanonicalJsonValue,
): void {
  if (equal(before, after)) return;
  context.drafts.push({
    kind: "opaque-change",
    ...operationBase(path, ["opaque"], "opaque"),
    reason,
    before,
    after,
  });
  pushDiagnostic(context, {
    code: "source-incomplete",
    severity: "warning",
    message: reason,
    path,
  });
}

function observedField(context: PlanningContext, field: string): { present: boolean; value: unknown } {
  if (context.state.has(field)) return { present: true, value: context.state.get(field) };
  const fields = context.issue.fields as unknown as Record<string, unknown>;
  return { present: own(fields, field) && fields[field] !== undefined, value: fields[field] };
}

function recordMissing(
  context: PlanningContext,
  field: string,
  path: SemanticPathV1,
  intent: Intent,
  intended: unknown,
): void {
  const missing = canonical({ missing: true });
  context.baselineActions.push({ path, intent, value: missing });
  context.targetActions.push({
    path,
    intent,
    value: intended === undefined ? canonical({ unavailable: true }) : canonical(intended),
  });
  pushDiagnostic(context, {
    code: "missing-observed-value",
    severity: "error",
    message: `Observed Jira field ${field} is missing; the intended operation was not planned.`,
    path,
  });
}

function prefixDiagnostic(
  diagnostic: ChangeDiagnosticV1,
  prefix: SemanticPathV1,
): ChangeDiagnosticV1 {
  return {
    ...diagnostic,
    ...(diagnostic.path ? { path: [...prefix, ...diagnostic.path] } : {}),
  };
}

async function planAdfReplacement(
  context: PlanningContext,
  path: SemanticPathV1,
  before: AdfDocument,
  after: AdfDocument,
): Promise<{ before: CanonicalJsonValue; after: CanonicalJsonValue }> {
  const baseline = canonicalizeAdfV1(before);
  const target = canonicalizeAdfV1(after);
  const result = await diffSemanticTreesV1({
    subject: { provider: "jira", kind: "issue", id: context.issue.id, label: context.issue.key },
    baseline: {
      ref: {
        revision: `${context.issue.id}:description:observed`,
        representation: "jira-fields",
        acquisition: "planned-operation",
      },
      ...baseline,
    },
    target: {
      ref: {
        revision: `${context.issue.id}:description:planned`,
        representation: "jira-fields",
        acquisition: "planned-operation",
      },
      ...target,
    },
  });
  for (const diagnostic of result.changeSet.completeness.diagnostics) {
    context.diagnostics.push(prefixDiagnostic(diagnostic, path));
  }
  for (const operation of result.changeSet.operations) {
    const { id: _discardedDescriptionId, ...draft } = operation;
    context.drafts.push({ ...draft, path: [...path, ...operation.path] } as ChangeOperationDraftV1);
  }
  return { before: canonical(baseline.sourceTree), after: canonical(target.sourceTree) };
}

async function planReplacement(
  context: PlanningContext,
  field: string,
  path: SemanticPathV1,
  intent: "fields-replace" | "update-set",
  beforeRaw: unknown,
  afterRaw: unknown,
): Promise<void> {
  if (field === "description" && isAdfDocument(beforeRaw) && isAdfDocument(afterRaw)) {
    const values = await planAdfReplacement(context, path, beforeRaw, afterRaw);
    context.baselineActions.push({ path, intent, value: values.before });
    context.targetActions.push({ path, intent, value: values.after });
    context.state.set(field, afterRaw);
    return;
  }

  const before = normalizeField(field, beforeRaw);
  const after = normalizeField(field, afterRaw);
  context.baselineActions.push({ path, intent, value: before.value });
  context.targetActions.push({ path, intent, value: after.value });
  context.state.set(field, afterRaw);
  if (before.opaqueReason || after.opaqueReason ||
      (field === "description" && (isAdfDocument(beforeRaw) || isAdfDocument(afterRaw)))) {
    pushOpaque(
      context,
      path,
      before.opaqueReason ?? after.opaqueReason ??
        "Jira description changed between ADF and a non-ADF representation.",
      before.value,
      after.value,
    );
    return;
  }
  if (fieldEqual(field, before.value, after.value)) return;
  context.drafts.push({
    kind: "modify",
    ...operationBase(
      path,
      field === "description"
        ? ["content-change"]
        : ENTITY_FIELDS.has(field)
          ? ["identity-change"]
          : COLLECTION_FIELDS.has(field)
            ? ["collection-change"]
            : [],
      ENTITY_FIELDS.has(field) ? "stable-id" : "position",
    ),
    before: before.value,
    after: after.value,
  });
}

function collectionItem(field: string, value: unknown): NormalizedFieldValue {
  if (field === "labels") {
    return typeof value === "string"
      ? { value }
      : { value: canonical(value), opaqueReason: "A Jira label operation used a non-string item." };
  }
  const reference = entity(value, field);
  return reference
    ? { value: canonical(reference) }
    : {
        value: canonical(value),
        opaqueReason: `Jira field ${field} used a collection item without a stable id.`,
      };
}

function collectionIdentity(field: string, value: CanonicalJsonValue): string {
  if (field !== "labels" && isRecord(value) && typeof value.id === "string") {
    return `id:${value.id}`;
  }
  return canonicalJsonV1(value);
}

function applyCollectionIntent(
  context: PlanningContext,
  field: string,
  path: SemanticPathV1,
  intent: "update-add" | "update-remove",
  currentRaw: unknown,
  itemRaw: unknown,
): void {
  const before = normalizeField(field, currentRaw);
  const item = collectionItem(field, itemRaw);
  if (!COLLECTION_FIELDS.has(field) || before.opaqueReason || item.opaqueReason || !Array.isArray(before.value)) {
    const after = canonical({ intent, item: item.value });
    context.baselineActions.push({ path, intent, value: before.value });
    context.targetActions.push({ path, intent, value: after });
    pushOpaque(
      context,
      path,
      before.opaqueReason ?? item.opaqueReason ??
        `Jira field ${field} has no reviewed add/remove collection semantics.`,
      before.value,
      after,
    );
    return;
  }

  const items = [...before.value];
  const itemKey = collectionIdentity(field, item.value);
  const existingIndex = items.findIndex((candidate) =>
    collectionIdentity(field, candidate) === itemKey);
  if (intent === "update-add" && existingIndex < 0) items.push(item.value);
  if (intent === "update-remove" && existingIndex >= 0) items.splice(existingIndex, 1);
  items.sort((left, right) => canonicalJsonV1(left).localeCompare(canonicalJsonV1(right)));
  const after = canonical(items);
  context.baselineActions.push({ path, intent, value: before.value });
  context.targetActions.push({ path, intent, value: after });
  context.state.set(field, after);
  if (equal(before.value, after)) return;
  context.drafts.push({
    kind: intent === "update-add" ? "collection-add" : "collection-remove",
    ...operationBase(path, ["collection-change"], field === "labels" ? "position" : "stable-id"),
    item: item.value,
  });
}

function summary(operations: readonly ChangeOperationV1[]): ChangeSetV1["summary"] {
  const result = { inserts: 0, deletes: 0, modifies: 0, moves: 0, opaque: 0, noOp: false };
  for (const operation of operations) {
    if (operation.kind === "insert" || operation.kind === "collection-add") result.inserts += 1;
    else if (operation.kind === "delete" || operation.kind === "collection-remove") result.deletes += 1;
    else if (operation.kind === "modify" || operation.kind === "transition") result.modifies += 1;
    else if (operation.kind === "move") result.moves += 1;
    else result.opaque += 1;
  }
  result.noOp = operations.length === 0;
  return result;
}

function uniqueDiagnostics(diagnostics: readonly ChangeDiagnosticV1[]): ChangeDiagnosticV1[] {
  const unique = new Map<string, ChangeDiagnosticV1>();
  for (const diagnostic of diagnostics) unique.set(canonicalJsonV1(diagnostic), diagnostic);
  return [...unique.values()].sort((left, right) =>
    canonicalJsonV1(left).localeCompare(canonicalJsonV1(right)));
}

async function finishPlan(
  context: PlanningContext,
  kind: "fields" | "transition",
  baselineTree: unknown,
  targetTree: unknown,
): Promise<ChangeSetV1> {
  const subject = {
    provider: "jira" as const,
    kind: "issue" as const,
    id: context.issue.id,
    label: context.issue.key,
  };
  const baselineDigest = await digestSnapshotV1("jira-fields", baselineTree);
  const targetDigest = await digestSnapshotV1("jira-fields", targetTree);
  const operations: ChangeOperationV1[] = [];
  for (const draft of context.drafts) {
    operations.push({
      id: await createChangeOperationIdV1({ subject, baselineDigest, targetDigest }, draft),
      ...draft,
    } as ChangeOperationV1);
  }
  operations.sort((left, right) =>
    canonicalJsonV1([left.path, left.kind, left.id])
      .localeCompare(canonicalJsonV1([right.path, right.kind, right.id])));

  const diagnostics = [...context.diagnostics];
  if (operations.some((operation) => operation.kind === "opaque-change") &&
      !diagnostics.some((diagnostic) => diagnostic.code === "opaque-source-change")) {
    diagnostics.push({
      code: "opaque-source-change",
      severity: "warning",
      message: "One or more Jira field changes require opaque review.",
    });
  }
  const completeDiagnostics = uniqueDiagnostics(diagnostics);
  const degraded = operations.some((operation) => operation.kind === "opaque-change") ||
    completeDiagnostics.some((diagnostic) =>
      diagnostic.severity === "error" ||
      diagnostic.code === "source-incomplete" ||
      diagnostic.code === "missing-observed-value" ||
      diagnostic.code === "unavailable-transition");

  return parseChangeSetV1({
    schema: "atlcli.change-set/1",
    subject,
    baseline: {
      revision: `${context.issue.id}:observed:${kind}`,
      digest: baselineDigest,
      representation: "jira-fields",
      acquisition: "planned-operation",
    },
    target: {
      revision: `${context.issue.id}:planned:${kind}`,
      digest: targetDigest,
      representation: "jira-fields",
      acquisition: "planned-operation",
    },
    completeness: { status: degraded ? "degraded" : "complete", diagnostics: completeDiagnostics },
    summary: summary(operations),
    operations,
    limits: { truncated: false, emittedOperations: operations.length },
  });
}

/**
 * Convert one observed Jira issue and one intended REST update into a pure,
 * review-only ChangeSet. This function performs no I/O and does not authorize execution.
 */
export async function planJiraFieldChangesV1(
  issue: JiraIssue,
  updateInput: UpdateIssueInput,
): Promise<ChangeSetV1> {
  const context: PlanningContext = {
    issue,
    diagnostics: [],
    drafts: [],
    baselineActions: [],
    targetActions: [],
    state: new Map(),
  };

  for (const field of Object.keys(updateInput.fields ?? {}).sort()) {
    const path: SemanticPathV1 = ["fields", field];
    const intended = (updateInput.fields as Record<string, unknown>)[field];
    const observed = observedField(context, field);
    if (!observed.present) {
      recordMissing(context, field, path, "fields-replace", intended);
      continue;
    }
    await planReplacement(context, field, path, "fields-replace", observed.value, intended);
  }

  for (const field of Object.keys(updateInput.update ?? {}).sort()) {
    const entries = updateInput.update![field] ?? [];
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index]!;
      for (const action of ["set", "add", "remove"] as const) {
        if (!own(entry, action)) continue;
        const path: SemanticPathV1 = ["update", field, index, action];
        const intended = entry[action];
        const observed = observedField(context, field);
        if (!observed.present) {
          recordMissing(context, field, path, `update-${action}`, intended);
          continue;
        }
        if (action === "set") {
          await planReplacement(context, field, path, "update-set", observed.value, intended);
        } else {
          applyCollectionIntent(
            context,
            field,
            path,
            action === "add" ? "update-add" : "update-remove",
            observed.value,
            intended,
          );
        }
      }
    }
  }

  return finishPlan(
    context,
    "fields",
    canonical({ actions: context.baselineActions }),
    canonical({ actions: context.targetActions }),
  );
}

function resolveTransition(input: JiraTransitionChangeInputV1): JiraTransition | undefined {
  if ("to" in input) return input;
  const requested = input.transition;
  if ("id" in requested) {
    return input.availableTransitions.find((candidate) => candidate.id === requested.id);
  }
  const matches = input.availableTransitions.filter((candidate) =>
    candidate.name === requested.name);
  return matches.length === 1 ? matches[0] : undefined;
}

/** Plan one workflow transition separately from field edits, without performing I/O. */
export async function planJiraTransitionV1(
  issue: JiraIssue,
  input: JiraTransitionChangeInputV1,
): Promise<ChangeSetV1> {
  const context: PlanningContext = {
    issue,
    diagnostics: [],
    drafts: [],
    baselineActions: [],
    targetActions: [],
    state: new Map(),
  };
  const path: SemanticPathV1 = ["transition"];
  const status = entity((issue.fields as unknown as Record<string, unknown>).status, "status");
  const resolved = resolveTransition(input);
  const requested = "to" in input ? { id: input.id, name: input.name } : input.transition;

  if (!status) {
    context.diagnostics.push({
      code: "missing-observed-value",
      severity: "error",
      message: "Observed Jira status is missing a stable id; the transition was not planned.",
      path,
    });
  } else if (!resolved) {
    context.diagnostics.push({
      code: "unavailable-transition",
      severity: "error",
      message: "The requested Jira transition is not currently available.",
      path,
    });
  } else {
    const target = entity(resolved.to, "status");
    if (!target) {
      context.diagnostics.push({
        code: "source-incomplete",
        severity: "error",
        message: "The requested Jira transition target is missing a stable status id.",
        path,
      });
    } else if (status.id !== target.id) {
      context.drafts.push({
        kind: "transition",
        ...operationBase(path, ["workflow-transition"], "stable-id"),
        before: status,
        after: target,
      });
    }
  }

  const baselineTree = canonical({ status: status ?? { missing: true } });
  const targetTree = canonical({
    status: resolved ? entity(resolved.to, "status") ?? { unavailable: true } : { requested },
  });
  return finishPlan(context, "transition", baselineTree, targetTree);
}
