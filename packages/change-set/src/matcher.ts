import { canonicalJsonV1 } from "./canonical-json.js";
import {
  createChangeOperationIdV1,
  digestCanonicalJsonV1,
  digestSnapshotV1,
} from "./digest.js";
import { parseChangeSetV1 } from "./schema.js";
import {
  DEFAULT_SEMANTIC_DIFF_LIMITS_V1,
  type CanonicalSourceNodeV1,
  type IdentityHintV1,
  type SemanticDiffInputV1,
  type SemanticDiffInstrumentationV1,
  type SemanticDiffLimitsV1,
  type SemanticDiffResultV1,
  type SemanticDocumentNodeV1,
  type SourceChangeV1,
} from "./semantic-tree.js";
import type {
  CanonicalJsonObject,
  CanonicalJsonValue,
  ChangeConfidenceV1,
  ChangeDiagnosticV1,
  ChangeMatchBasisV1,
  ChangeOperationDraftV1,
  ChangeOperationV1,
  ChangeRiskTagV1,
  ChangeSetV1,
  SemanticPathV1,
  SnapshotRefV1,
} from "./types.js";

const SOURCE_CHANGE_SCHEMA_V1 = "atlcli.source-change/1" as const;

class SemanticDiffLimitErrorV1 extends Error {}

interface Pair {
  beforeIndex: number;
  afterIndex: number;
  basis: ChangeMatchBasisV1;
  moveSafe: boolean;
}

interface SourceChangeDraft {
  kind: SourceChangeV1["kind"];
  path: SemanticPathV1;
  fromPath?: SemanticPathV1;
  before?: CanonicalJsonObject;
  after?: CanonicalJsonObject;
  classification: SourceChangeV1["classification"];
}

interface MatcherContext {
  limits: SemanticDiffLimitsV1;
  instrumentation: SemanticDiffInstrumentationV1;
  diagnostics: ChangeDiagnosticV1[];
  diagnosticKeys: Set<string>;
}

function mergeLimits(overrides: Partial<SemanticDiffLimitsV1> | undefined): SemanticDiffLimitsV1 {
  const limits = { ...DEFAULT_SEMANTIC_DIFF_LIMITS_V1, ...overrides };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new TypeError(`Semantic diff limit ${name} must be a positive safe integer.`);
    }
  }
  return limits;
}

function object(value: unknown): CanonicalJsonObject {
  // Adapter trees already carry JSON-only canonical values. Keep these views
  // structural and let canonicalJsonV1 sort keys at comparison/digest edges;
  // serializing and parsing every shallow node multiplied allocation across
  // large documents without changing the resulting canonical bytes.
  return value as CanonicalJsonObject;
}

function pathKey(path: SemanticPathV1): string {
  return canonicalJsonV1(path);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function pathRelated(left: SemanticPathV1, right: SemanticPathV1): boolean {
  const prefix = (shorter: SemanticPathV1, longer: SemanticPathV1): boolean =>
    shorter.length <= longer.length && shorter.every((segment, index) => segment === longer[index]);
  return prefix(left, right) || prefix(right, left);
}

function sourceShallow(node: CanonicalSourceNodeV1, semantic: boolean): CanonicalJsonObject {
  const attributes: Record<string, CanonicalJsonValue> = {};
  for (const [key, value] of Object.entries(node.attributes)) {
    const hint = node.identityHints.find((candidate) =>
      candidate.attribute === key && candidate.semantic === false);
    if (!semantic || !hint) attributes[key] = value;
  }
  return object({
    kind: node.kind,
    attributes,
    ...(node.text !== undefined ? { text: node.text } : {}),
    ...(node.marks ? {
      marks: node.marks.map((mark) => semantic
        ? {
            type: mark.type,
            attributes: mark.semanticAttributes ?? mark.attributes,
            opaque: mark.opaque,
          }
        : mark),
    } : {}),
  });
}

function sourceSubtree(node: CanonicalSourceNodeV1): CanonicalJsonObject {
  return object({
    ...sourceShallow(node, false),
    children: node.children.map(sourceSubtree),
  });
}

function semanticShallow(node: SemanticDocumentNodeV1): CanonicalJsonObject {
  return object({
    kind: node.kind,
    ...(node.label !== undefined ? { label: node.label } : {}),
    attributes: node.attributes,
    ...(node.text !== undefined ? { text: node.text } : {}),
    coverage: node.coverage,
  });
}

function semanticSubtree(node: SemanticDocumentNodeV1): CanonicalJsonObject {
  return object({
    ...semanticShallow(node),
    children: node.children.map(semanticSubtree),
  });
}

function stableKeys(node: { kind: string; identityHints: readonly IdentityHintV1[] }): string[] {
  return node.identityHints
    .filter((hint) => hint.stability === "stable")
    .map((hint) => `${node.kind}\u0000${hint.kind}\u0000${hint.value}`)
    .sort();
}

function addDiagnostic(
  context: MatcherContext,
  diagnostic: ChangeDiagnosticV1,
  key = `${diagnostic.code}|${pathKey(diagnostic.path ?? [])}|${diagnostic.message}`,
): void {
  if (context.diagnosticKeys.has(key)) return;
  if (context.diagnostics.length < Math.max(0, context.limits.maxDiagnostics - 1)) {
    context.diagnosticKeys.add(key);
    context.diagnostics.push(diagnostic);
  }
}

function addMandatoryDiagnostic(
  context: MatcherContext,
  diagnostic: ChangeDiagnosticV1,
  key: string,
): void {
  if (context.diagnosticKeys.has(key)) return;
  if (context.diagnostics.length >= context.limits.maxDiagnostics) {
    context.diagnostics.pop();
  }
  context.diagnosticKeys.add(key);
  context.diagnostics.push(diagnostic);
}

function compareCandidate(context: MatcherContext): void {
  context.instrumentation.candidateComparisons += 1;
  if (context.instrumentation.candidateComparisons > context.limits.maxCandidateComparisons) {
    throw new SemanticDiffLimitErrorV1("candidate comparison limit exceeded");
  }
}

function group<T>(
  nodes: readonly T[],
  indexes: readonly number[],
  keysFor: (node: T) => readonly string[],
): Map<string, number[]> {
  const groups = new Map<string, number[]>();
  for (const index of indexes) {
    for (const key of keysFor(nodes[index]!)) {
      const values = groups.get(key) ?? [];
      values.push(index);
      groups.set(key, values);
    }
  }
  return groups;
}

function alignChildren<T extends { kind: string; identityHints: readonly IdentityHintV1[] }>(
  before: readonly T[],
  after: readonly T[],
  context: MatcherContext,
  subtreeSignature: (node: T) => string,
  shallowSignature: (node: T) => string,
  parentPath: SemanticPathV1,
): Pair[] {
  const ambiguityAtStart = context.instrumentation.ambiguousGroups;
  const unmatchedBefore = new Set(before.map((_, index) => index));
  const unmatchedAfter = new Set(after.map((_, index) => index));
  const ambiguousBefore = new Set<number>();
  const ambiguousAfter = new Set<number>();
  const pairs: Pair[] = [];
  const claim = (beforeIndex: number, afterIndex: number, basis: ChangeMatchBasisV1): void => {
    if (!unmatchedBefore.has(beforeIndex) || !unmatchedAfter.has(afterIndex)) return;
    unmatchedBefore.delete(beforeIndex);
    unmatchedAfter.delete(afterIndex);
    pairs.push({ beforeIndex, afterIndex, basis, moveSafe: false });
  };

  const stableBefore = group(before, [...unmatchedBefore], stableKeys);
  const stableAfter = group(after, [...unmatchedAfter], stableKeys);
  for (const key of [...new Set([...stableBefore.keys(), ...stableAfter.keys()])].sort()) {
    compareCandidate(context);
    const left = stableBefore.get(key) ?? [];
    const right = stableAfter.get(key) ?? [];
    if (left.length === 1 && right.length === 1 && before[left[0]]!.kind === after[right[0]]!.kind) {
      claim(left[0]!, right[0]!, "stable-id");
      context.instrumentation.stableIdMatches += 1;
    } else if (left.length > 0 && right.length > 0 && (left.length > 1 || right.length > 1)) {
      left.forEach((index) => ambiguousBefore.add(index));
      right.forEach((index) => ambiguousAfter.add(index));
      context.instrumentation.ambiguousGroups += 1;
      addDiagnostic(context, {
        code: "ambiguous-match",
        severity: "warning",
        message: "Repeated stable identities were not used to claim a move.",
        path: parentPath,
      }, `stable|${pathKey(parentPath)}`);
    }
  }

  // A one-to-one remainder cannot be a sibling move. Aligning compatible
  // kinds positionally here is the conservative gap rule and avoids building
  // exact-subtree indexes for the overwhelmingly common paragraph -> text
  // shape in large documents.
  if (unmatchedBefore.size === 1 && unmatchedAfter.size === 1) {
    const beforeIndex = unmatchedBefore.values().next().value as number;
    const afterIndex = unmatchedAfter.values().next().value as number;
    if (before[beforeIndex]!.kind === after[afterIndex]!.kind) {
      compareCandidate(context);
      claim(beforeIndex, afterIndex, "position");
      context.instrumentation.positionalMatches += 1;
      return pairs.map((pair) => ({ ...pair, moveSafe: true }));
    }
  }

  const exactBefore = group(before, [...unmatchedBefore], (node) => [subtreeSignature(node)]);
  const exactAfter = group(after, [...unmatchedAfter], (node) => [subtreeSignature(node)]);
  for (const key of [...new Set([...exactBefore.keys(), ...exactAfter.keys()])].sort()) {
    compareCandidate(context);
    const left = exactBefore.get(key) ?? [];
    const right = exactAfter.get(key) ?? [];
    if (left.length === 1 && right.length === 1 && before[left[0]]!.kind === after[right[0]]!.kind) {
      claim(left[0]!, right[0]!, "exact-subtree");
      context.instrumentation.exactSubtreeMatches += 1;
    } else if (left.length > 0 && right.length > 0 && (left.length > 1 || right.length > 1)) {
      left.forEach((index) => ambiguousBefore.add(index));
      right.forEach((index) => ambiguousAfter.add(index));
      context.instrumentation.ambiguousGroups += 1;
      addDiagnostic(context, {
        code: "ambiguous-match",
        severity: "warning",
        message: "Repeated equal subtrees were aligned conservatively without move claims.",
        path: parentPath,
      }, `exact|${pathKey(parentPath)}`);
    }
  }

  const sequenceBefore = group(before, [...unmatchedBefore], (node) => [shallowSignature(node)]);
  const sequenceAfter = group(after, [...unmatchedAfter], (node) => [shallowSignature(node)]);
  const candidates: Array<{ beforeIndex: number; afterIndex: number }> = [];
  for (const key of [...new Set([...sequenceBefore.keys(), ...sequenceAfter.keys()])].sort()) {
    compareCandidate(context);
    const left = sequenceBefore.get(key) ?? [];
    const right = sequenceAfter.get(key) ?? [];
    if (left.length === 1 && right.length === 1 && before[left[0]]!.kind === after[right[0]]!.kind) {
      candidates.push({ beforeIndex: left[0]!, afterIndex: right[0]! });
    } else if (left.length > 0 && right.length > 0 && (left.length > 1 || right.length > 1)) {
      left.forEach((index) => ambiguousBefore.add(index));
      right.forEach((index) => ambiguousAfter.add(index));
      context.instrumentation.ambiguousGroups += 1;
      addDiagnostic(context, {
        code: "ambiguous-match",
        severity: "warning",
        message: "Repeated shallow matches were aligned conservatively without move claims.",
        path: parentPath,
      }, `sequence|${pathKey(parentPath)}`);
    }
  }
  candidates.sort((left, right) => left.beforeIndex - right.beforeIndex);
  let lastAfter = -1;
  for (const candidate of candidates) {
    if (candidate.afterIndex <= lastAfter) continue;
    claim(candidate.beforeIndex, candidate.afterIndex, "sequence");
    lastAfter = candidate.afterIndex;
    context.instrumentation.sequenceMatches += 1;
  }

  // Repeated equal nodes are intentionally not move anchors, but an equal
  // node that stayed at the same sibling index is still an unambiguous
  // no-change alignment. Pairing it here removes delete+insert churn for
  // repeated hard breaks and empty paragraphs without manufacturing moves.
  const sameIndexLimit = Math.min(before.length, after.length);
  for (let index = 0; index < sameIndexLimit; index += 1) {
    if (!unmatchedBefore.has(index) || !unmatchedAfter.has(index)) continue;
    if (!ambiguousBefore.has(index) || !ambiguousAfter.has(index)) continue;
    compareCandidate(context);
    if (subtreeSignature(before[index]!) !== subtreeSignature(after[index]!)) continue;
    claim(index, index, "sequence");
    context.instrumentation.sequenceMatches += 1;
  }

  const remainingBefore = [...unmatchedBefore]
    .filter((index) => !ambiguousBefore.has(index))
    .sort((left, right) => left - right);
  const remainingAfter = [...unmatchedAfter]
    .filter((index) => !ambiguousAfter.has(index))
    .sort((left, right) => left - right);
  const positional = Math.min(remainingBefore.length, remainingAfter.length);
  for (let index = 0; index < positional; index += 1) {
    compareCandidate(context);
    const beforeIndex = remainingBefore[index]!;
    const afterIndex = remainingAfter[index]!;
    if (before[beforeIndex]!.kind !== after[afterIndex]!.kind) continue;
    claim(beforeIndex, afterIndex, "position");
    context.instrumentation.positionalMatches += 1;
  }
  const moveSafe = context.instrumentation.ambiguousGroups === ambiguityAtStart;
  return pairs
    .map((pair) => ({ ...pair, moveSafe }))
    .sort((left, right) => left.afterIndex - right.afterIndex || left.beforeIndex - right.beforeIndex);
}

function reorderedPairs(pairs: readonly Pair[], context: MatcherContext): Set<Pair> {
  const reordered = new Set<Pair>();
  if (pairs.length < 2) return reordered;
  const prefixMax: number[] = [];
  const suffixMin: number[] = [];
  for (let index = 0; index < pairs.length; index += 1) {
    prefixMax[index] = Math.max(prefixMax[index - 1] ?? -1, pairs[index]!.beforeIndex);
  }
  for (let index = pairs.length - 1; index >= 0; index -= 1) {
    suffixMin[index] = Math.min(suffixMin[index + 1] ?? Number.MAX_SAFE_INTEGER, pairs[index]!.beforeIndex);
  }
  for (let index = 0; index < pairs.length; index += 1) {
    compareCandidate(context);
    const pair = pairs[index]!;
    if (
      (prefixMax[index - 1] ?? -1) > pair.beforeIndex ||
      (suffixMin[index + 1] ?? Number.MAX_SAFE_INTEGER) < pair.beforeIndex
    ) {
      reordered.add(pair);
    }
  }
  return reordered;
}

function assertNodeBudget(
  root: { children: readonly unknown[] },
  maxNodes: number,
  label: string,
): void {
  const stack: Array<{ children: readonly unknown[] }> = [root];
  let nodes = 0;
  while (stack.length > 0) {
    const node = stack.pop()!;
    nodes += 1;
    if (nodes > maxNodes) {
      throw new SemanticDiffLimitErrorV1(`${label} node limit exceeded`);
    }
    for (const child of node.children) {
      stack.push(child as { children: readonly unknown[] });
    }
  }
}

async function materializeSourceChanges(drafts: readonly SourceChangeDraft[]): Promise<SourceChangeV1[]> {
  const out: SourceChangeV1[] = [];
  for (const draft of drafts) {
    out.push({
      id: await digestCanonicalJsonV1({ schema: SOURCE_CHANGE_SCHEMA_V1, ...draft }),
      ...draft,
    });
  }
  return out;
}

function diffSourceTrees(
  before: CanonicalSourceNodeV1,
  after: CanonicalSourceNodeV1,
  context: MatcherContext,
): SourceChangeDraft[] {
  const changes: SourceChangeDraft[] = [];
  const visit = (left: CanonicalSourceNodeV1, right: CanonicalSourceNodeV1): void => {
    context.instrumentation.sourceNodesVisited += 2;
    if (context.instrumentation.sourceNodesVisited > context.limits.maxNodes * 2) {
      throw new SemanticDiffLimitErrorV1("source node limit exceeded");
    }
    const beforeShallow = sourceShallow(left, false);
    const afterShallow = sourceShallow(right, false);
    if (canonicalJsonV1(beforeShallow) !== canonicalJsonV1(afterShallow)) {
      changes.push({
        kind: "modify",
        path: right.sourcePath,
        before: beforeShallow,
        after: afterShallow,
        classification:
          canonicalJsonV1(sourceShallow(left, true)) === canonicalJsonV1(sourceShallow(right, true))
            ? "policy-noise"
            : "meaningful",
      });
    }
    const pairs = alignChildren(
      left.children,
      right.children,
      context,
      (node) => canonicalJsonV1(sourceSubtree(node)),
      (node) => canonicalJsonV1(sourceShallow(node, false)),
      right.sourcePath,
    );
    const matchedBefore = new Set(pairs.map((pair) => pair.beforeIndex));
    const matchedAfter = new Set(pairs.map((pair) => pair.afterIndex));
    const reordered = reorderedPairs(pairs, context);
    if ([...reordered].some((pair) => !pair.moveSafe)) {
      changes.push({
        kind: "modify",
        path: right.sourcePath,
        before: sourceSubtree(left),
        after: sourceSubtree(right),
        classification: "meaningful",
      });
    }
    for (const pair of pairs) {
      const beforeChild = left.children[pair.beforeIndex]!;
      const afterChild = right.children[pair.afterIndex]!;
      if (
        pair.moveSafe && reordered.has(pair) &&
        (pair.basis === "stable-id" || pair.basis === "exact-subtree") &&
        pathKey(beforeChild.sourcePath) !== pathKey(afterChild.sourcePath)
      ) {
        changes.push({
          kind: "move",
          fromPath: beforeChild.sourcePath,
          path: afterChild.sourcePath,
          before: sourceSubtree(beforeChild),
          after: sourceSubtree(afterChild),
          classification: "meaningful",
        });
      }
      visit(beforeChild, afterChild);
    }
    left.children.forEach((child, index) => {
      if (!matchedBefore.has(index)) {
        changes.push({
          kind: "delete",
          path: child.sourcePath,
          before: sourceSubtree(child),
          classification: "meaningful",
        });
      }
    });
    right.children.forEach((child, index) => {
      if (!matchedAfter.has(index)) {
        changes.push({
          kind: "insert",
          path: child.sourcePath,
          after: sourceSubtree(child),
          classification: "meaningful",
        });
      }
    });
  };
  visit(before, after);
  return changes;
}

function confidence(basis: ChangeMatchBasisV1): ChangeConfidenceV1 {
  if (basis === "exact-subtree") return "exact";
  if (basis === "stable-id") return "anchored";
  return "conservative";
}

function sourcePaths(node: SemanticDocumentNodeV1): SemanticPathV1[] {
  return node.sourcePaths.length > 0 ? [...node.sourcePaths] : [[]];
}

const inlineSemanticKinds = new Set([
  "card",
  "date",
  "emoji",
  "extension",
  "line-break",
  "mediaInline",
  "mention",
  "placeholder",
  "status",
  "text",
]);

function isBlockMoveCandidate(node: SemanticDocumentNodeV1): boolean {
  return !inlineSemanticKinds.has(node.kind);
}

function claimSourceChanges(
  sourceChanges: readonly SourceChangeV1[],
  claimed: Set<string>,
  paths: readonly SemanticPathV1[],
): string[] {
  const ids: string[] = [];
  for (const sourceChange of sourceChanges) {
    if (sourceChange.classification !== "meaningful" || claimed.has(sourceChange.id)) continue;
    const changePaths = [sourceChange.path, ...(sourceChange.fromPath ? [sourceChange.fromPath] : [])];
    if (!paths.some((path) => changePaths.some((changePath) => pathRelated(path, changePath)))) continue;
    claimed.add(sourceChange.id);
    ids.push(sourceChange.id);
  }
  return ids.sort();
}

function baseDraft(
  path: SemanticPathV1,
  basis: ChangeMatchBasisV1,
  riskTags: readonly ChangeRiskTagV1[],
  source: { baseline: SnapshotRefV1["representation"]; target: SnapshotRefV1["representation"] },
  coveredSourceChangeIds: readonly string[],
): Pick<
  ChangeOperationDraftV1,
  "path" | "matchBasis" | "confidence" | "riskTags" | "source" | "coveredSourceChangeIds"
> {
  return {
    path,
    matchBasis: basis,
    confidence: basis === "opaque" ? "ambiguous" : confidence(basis),
    riskTags,
    source,
    coveredSourceChangeIds,
  };
}

function diffSemanticTrees(
  before: SemanticDocumentNodeV1,
  after: SemanticDocumentNodeV1,
  sourceChanges: readonly SourceChangeV1[],
  context: MatcherContext,
  representations: {
    baseline: SnapshotRefV1["representation"];
    target: SnapshotRefV1["representation"];
  },
): ChangeOperationDraftV1[] {
  const drafts: ChangeOperationDraftV1[] = [];
  const claimed = new Set<string>();
  const source = representations;
  const push = (draft: ChangeOperationDraftV1): void => {
    if (drafts.length >= context.limits.maxOperations) {
      throw new SemanticDiffLimitErrorV1("operation limit exceeded");
    }
    drafts.push(draft);
  };

  const visit = (
    left: SemanticDocumentNodeV1,
    right: SemanticDocumentNodeV1,
    basis: ChangeMatchBasisV1,
    opaqueAncestor = false,
  ): void => {
    context.instrumentation.semanticNodesVisited += 2;
    if (context.instrumentation.semanticNodesVisited > context.limits.maxNodes * 2) {
      throw new SemanticDiffLimitErrorV1("semantic node limit exceeded");
    }
    const leftShallow = semanticShallow(left);
    const rightShallow = semanticShallow(right);
    const opaqueContext = opaqueAncestor || left.coverage === "opaque" || right.coverage === "opaque";
    if (canonicalJsonV1(leftShallow) !== canonicalJsonV1(rightShallow)) {
      const paths = [...sourcePaths(left), ...sourcePaths(right)];
      const covered = claimSourceChanges(sourceChanges, claimed, paths);
      if (opaqueContext) {
        push({
          kind: "opaque-change",
          ...baseDraft(right.sourcePaths[0] ?? [], "opaque", ["opaque"], source, covered),
          reason: "Opaque semantic content changed.",
          before: leftShallow,
          after: rightShallow,
        });
      } else {
        push({
          kind: "modify",
          ...baseDraft(right.sourcePaths[0] ?? [], basis, ["content-change"], source, covered),
          before: leftShallow,
          after: rightShallow,
        });
      }
    }

    const pairs = alignChildren(
      left.children,
      right.children,
      context,
      (node) => canonicalJsonV1(semanticSubtree(node)),
      (node) => canonicalJsonV1(semanticShallow(node)),
      right.sourcePaths[0] ?? [],
    );
    const matchedBefore = new Set(pairs.map((pair) => pair.beforeIndex));
    const matchedAfter = new Set(pairs.map((pair) => pair.afterIndex));
    const reordered = reorderedPairs(pairs, context);
    for (const pair of pairs) {
      const beforeChild = left.children[pair.beforeIndex]!;
      const afterChild = right.children[pair.afterIndex]!;
      if (
        pair.moveSafe && reordered.has(pair) &&
        (pair.basis === "stable-id" || pair.basis === "exact-subtree") &&
        pathKey(beforeChild.sourcePaths[0] ?? []) !== pathKey(afterChild.sourcePaths[0] ?? [])
      ) {
        const paths = [...sourcePaths(beforeChild), ...sourcePaths(afterChild)];
        const covered = claimSourceChanges(sourceChanges, claimed, paths);
        if (opaqueContext) {
          push({
            kind: "opaque-change",
            ...baseDraft(afterChild.sourcePaths[0] ?? [], "opaque", ["opaque"], source, covered),
            reason: "Content moved within opaque semantic coverage.",
            before: semanticSubtree(beforeChild),
            after: semanticSubtree(afterChild),
          });
        } else if (!isBlockMoveCandidate(afterChild)) {
          push({
            kind: "delete",
            ...baseDraft(
              beforeChild.sourcePaths[0] ?? [],
              pair.basis,
              ["structure-change", "destructive"],
              source,
              covered,
            ),
            before: semanticSubtree(beforeChild),
          });
          push({
            kind: "insert",
            ...baseDraft(
              afterChild.sourcePaths[0] ?? [],
              pair.basis,
              ["structure-change"],
              source,
              [],
            ),
            after: semanticSubtree(afterChild),
          });
          continue;
        } else {
          push({
            kind: "move",
            ...baseDraft(
              afterChild.sourcePaths[0] ?? [],
              pair.basis,
              ["structure-change"],
              source,
              covered,
            ),
            fromPath: beforeChild.sourcePaths[0] ?? [],
            value: semanticSubtree(afterChild),
          });
        }
      }
      visit(beforeChild, afterChild, pair.basis, opaqueContext);
    }
    left.children.forEach((child, index) => {
      if (matchedBefore.has(index)) return;
      const covered = claimSourceChanges(sourceChanges, claimed, sourcePaths(child));
      if (opaqueContext || child.coverage === "opaque") {
        push({
          kind: "opaque-change",
          ...baseDraft(child.sourcePaths[0] ?? [], "opaque", ["opaque", "destructive"], source, covered),
          reason: "Opaque semantic content was removed.",
          before: semanticSubtree(child),
        });
      } else {
        push({
          kind: "delete",
          ...baseDraft(child.sourcePaths[0] ?? [], "position", ["structure-change", "destructive"], source, covered),
          before: semanticSubtree(child),
        });
      }
    });
    right.children.forEach((child, index) => {
      if (matchedAfter.has(index)) return;
      const covered = claimSourceChanges(sourceChanges, claimed, sourcePaths(child));
      if (opaqueContext || child.coverage === "opaque") {
        push({
          kind: "opaque-change",
          ...baseDraft(child.sourcePaths[0] ?? [], "opaque", ["opaque"], source, covered),
          reason: "Opaque semantic content was inserted.",
          after: semanticSubtree(child),
        });
      } else {
        push({
          kind: "insert",
          ...baseDraft(child.sourcePaths[0] ?? [], "position", ["structure-change"], source, covered),
          after: semanticSubtree(child),
        });
      }
    });
  };

  visit(before, after, "position");
  for (const sourceChange of sourceChanges) {
    if (sourceChange.classification === "policy-noise") {
      addDiagnostic(context, {
        code: "policy-noise",
        severity: "info",
        message: "An exact source change was classified as identity-only policy noise.",
        path: sourceChange.path,
        sourceChangeIds: [sourceChange.id],
      }, `noise|${sourceChange.id}`);
      continue;
    }
    if (claimed.has(sourceChange.id)) continue;
    claimed.add(sourceChange.id);
    push({
      kind: "opaque-change",
      ...baseDraft(sourceChange.path, "opaque", ["opaque"], source, [sourceChange.id]),
      reason: "An exact source change was not represented by the semantic projection.",
      ...(sourceChange.before ? { before: sourceChange.before } : {}),
      ...(sourceChange.after ? { after: sourceChange.after } : {}),
    });
  }
  return drafts;
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

async function refs(input: SemanticDiffInputV1): Promise<{
  baseline: SnapshotRefV1;
  target: SnapshotRefV1;
}> {
  const baselineDigest = await digestSnapshotV1(
    input.baseline.ref.representation,
    input.baseline.sourceTree,
  );
  const targetDigest = await digestSnapshotV1(
    input.target.ref.representation,
    input.target.sourceTree,
  );
  return {
    baseline: { ...input.baseline.ref, digest: baselineDigest },
    target: { ...input.target.ref, digest: targetDigest },
  };
}

function instrumentation(): SemanticDiffInstrumentationV1 {
  return {
    sourceNodesVisited: 0,
    semanticNodesVisited: 0,
    candidateComparisons: 0,
    stableIdMatches: 0,
    exactSubtreeMatches: 0,
    sequenceMatches: 0,
    positionalMatches: 0,
    ambiguousGroups: 0,
  };
}

/** Build a deterministic, completeness-checked ChangeSet from two adapter trees. */
export async function diffSemanticTreesV1(
  input: SemanticDiffInputV1,
): Promise<SemanticDiffResultV1> {
  const limits = mergeLimits(input.limits);
  const measured = instrumentation();
  const context: MatcherContext = {
    limits,
    instrumentation: measured,
    diagnostics: [],
    diagnosticKeys: new Set(),
  };
  const snapshots = await refs(input);
  for (const diagnostic of [...(input.baseline.diagnostics ?? []), ...(input.target.diagnostics ?? [])]) {
    addDiagnostic(context, diagnostic);
  }
  let sourceChanges: SourceChangeV1[] = [];
  try {
    assertNodeBudget(input.baseline.sourceTree, limits.maxNodes, "baseline source");
    assertNodeBudget(input.target.sourceTree, limits.maxNodes, "target source");
    assertNodeBudget(input.baseline.semanticTree, limits.maxNodes, "baseline semantic");
    assertNodeBudget(input.target.semanticTree, limits.maxNodes, "target semantic");
    sourceChanges = await materializeSourceChanges(
      diffSourceTrees(input.baseline.sourceTree, input.target.sourceTree, context),
    );
    const drafts = diffSemanticTrees(
      input.baseline.semanticTree,
      input.target.semanticTree,
      sourceChanges,
      context,
      {
        baseline: snapshots.baseline.representation,
        target: snapshots.target.representation,
      },
    );
    const operations: ChangeOperationV1[] = [];
    for (const draft of drafts) {
      operations.push({
        id: await createChangeOperationIdV1({
          subject: input.subject,
          baselineDigest: snapshots.baseline.digest,
          targetDigest: snapshots.target.digest,
        }, draft),
        ...draft,
      } as ChangeOperationV1);
    }
    operations.sort((left, right) => compareText(
      canonicalJsonV1([left.path, left.kind, left.id]),
      canonicalJsonV1([right.path, right.kind, right.id]),
    ));
    if (operations.some((operation) => operation.kind === "opaque-change")) {
      addMandatoryDiagnostic(context, {
        code: "opaque-source-change",
        severity: "warning",
        message: "One or more exact source changes require opaque review.",
      }, "opaque-summary");
    }
    const degraded =
      operations.some((operation) => operation.kind === "opaque-change") ||
      context.diagnostics.some((diagnostic) =>
        diagnostic.code === "source-incomplete" || diagnostic.severity === "error");
    const changeSet = parseChangeSetV1({
      schema: "atlcli.change-set/1",
      subject: input.subject,
      baseline: snapshots.baseline,
      target: snapshots.target,
      completeness: {
        status: degraded ? "degraded" : "complete",
        diagnostics: context.diagnostics,
      },
      summary: summary(operations),
      operations,
      limits: { truncated: false, emittedOperations: operations.length },
    });
    return { changeSet, sourceChanges, instrumentation: measured };
  } catch (error) {
    if (!(error instanceof SemanticDiffLimitErrorV1)) throw error;
    const diagnostic: ChangeDiagnosticV1 = {
      code: "limit-exceeded",
      severity: "warning",
      message: error.message,
    };
    const adapterDiagnostics = [
      ...(input.baseline.diagnostics ?? []),
      ...(input.target.diagnostics ?? []),
    ];
    const diagnostics = [...adapterDiagnostics.slice(0, Math.max(0, limits.maxDiagnostics - 1)), diagnostic];
    const changeSet = parseChangeSetV1({
      schema: "atlcli.change-set/1",
      subject: input.subject,
      baseline: snapshots.baseline,
      target: snapshots.target,
      completeness: { status: "degraded", diagnostics },
      summary: { inserts: 0, deletes: 0, modifies: 0, moves: 0, opaque: 1, noOp: false },
      operations: [],
      limits: { truncated: true, emittedOperations: 0, totalOperations: 1 },
    });
    return { changeSet, sourceChanges, instrumentation: measured };
  }
}
