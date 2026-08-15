import { Database } from "bun:sqlite";
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import {
  canonicalJsonV1,
  createChangeOperationIdV1,
  diffSemanticTreesV1,
  digestCanonicalJsonV1,
  parseChangeSetV1,
  type CanonicalJsonObject,
  type CanonicalJsonValue,
  type CanonicalSourceNodeV1,
  type ChangeDiagnosticV1,
  type ChangeOperationDraftV1,
  type ChangeOperationV1,
  type ChangeSetV1,
  type SemanticDiffInstrumentationV1,
  type SemanticDiffResultV1,
  type SemanticDocumentNodeV1,
  type SemanticTreeShardV1,
  type SnapshotRefV1,
  type SourceChangeV1,
} from "@atlcli/change-set";
import { visitAdfSemanticJsonShardsV1 } from "@atlcli/change-set/adf";
import {
  visitStorageSemanticShardsV1,
  type BuildPageDiffChangeSetOptionsV1,
  type PageDiffPairV1,
} from "@atlcli/confluence/internal";

const STORE_PREFIX = "atlcli-semantic-diff-";
const OWNER_FILE = ".atlcli-semantic-diff-owner";
const DATABASE_FILE = "records.sqlite";
const REFERENCE_SHARD_LIMIT = 2_000;
export const DEFAULT_SEMANTIC_DIFF_SPILL_BYTES_V1 = 512 * 1024;

type Side = "baseline" | "target";

interface StoredRow {
  index: number;
  source_json: string;
  semantic_json: string;
}

interface PairRow {
  before_index: number;
  after_index: number;
  source_equal: number;
  semantic_equal: number;
}

interface SpillSnapshot {
  side: Side;
  ref: Omit<SnapshotRefV1, "digest">;
  digest: string;
  sourceRoot: CanonicalSourceNodeV1;
  semanticRoot: SemanticDocumentNodeV1;
  diagnostics: readonly ChangeDiagnosticV1[];
  shardCount: number;
}

export class SemanticDiffSpillErrorV1 extends Error {
  constructor(
    public readonly kind:
      | "spill-ownership-invalid"
      | "spill-cleanup-failed"
      | "spill-large-shape-unsupported"
      | "spill-record-invalid",
    message: string,
  ) {
    super(message);
    this.name = "SemanticDiffSpillErrorV1";
  }
}

function emptyInstrumentation(): SemanticDiffInstrumentationV1 {
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

function addInstrumentation(
  target: SemanticDiffInstrumentationV1,
  source: SemanticDiffInstrumentationV1,
): void {
  for (const key of Object.keys(target) as Array<keyof SemanticDiffInstrumentationV1>) {
    target[key] += source[key];
  }
}

function stableKey(node: CanonicalSourceNodeV1): string | null {
  const hints = node.identityHints
    .filter((hint) => hint.stability === "stable")
    .map((hint) => `${node.kind}\u0000${hint.kind}\u0000${hint.value}`)
    .sort();
  return hints.length > 0 ? JSON.stringify(hints) : null;
}

/** Adapter nodes are already validated JSON; emit the exact sorted-key source shape cheaply. */
function canonicalSourceJson(node: CanonicalSourceNodeV1): string {
  const fields = [
    `"attributes":${canonicalJsonV1(node.attributes)}`,
    `"children":[${node.children.map(canonicalSourceJson).join(",")}]`,
    `"identityHints":${canonicalJsonV1(node.identityHints)}`,
    `"kind":${JSON.stringify(node.kind)}`,
    ...(node.marks ? [`"marks":${canonicalJsonV1(node.marks)}`] : []),
    `"sourcePath":${JSON.stringify(node.sourcePath)}`,
    ...(node.text !== undefined ? [`"text":${JSON.stringify(node.text)}`] : []),
  ];
  return `{${fields.join(",")}}`;
}

function sourceSubtree(node: CanonicalSourceNodeV1): CanonicalJsonObject {
  return {
    kind: node.kind,
    attributes: node.attributes,
    ...(node.text !== undefined ? { text: node.text } : {}),
    ...(node.marks ? { marks: node.marks as unknown as CanonicalJsonValue } : {}),
    children: node.children.map(sourceSubtree),
  };
}

function semanticSubtree(node: SemanticDocumentNodeV1): CanonicalJsonObject {
  return {
    kind: node.kind,
    ...(node.label !== undefined ? { label: node.label } : {}),
    attributes: node.attributes,
    ...(node.text !== undefined ? { text: node.text } : {}),
    coverage: node.coverage,
    children: node.children.map(semanticSubtree),
  };
}

function isOpaque(node: SemanticDocumentNodeV1): boolean {
  if (node.coverage === "opaque") return true;
  return node.children.some(isOpaque);
}

function summary(operations: readonly ChangeOperationV1[]): ChangeSetV1["summary"] {
  const out = { inserts: 0, deletes: 0, modifies: 0, moves: 0, opaque: 0, noOp: false };
  for (const operation of operations) {
    if (operation.kind === "insert" || operation.kind === "collection-add") out.inserts += 1;
    else if (operation.kind === "delete" || operation.kind === "collection-remove") out.deletes += 1;
    else if (operation.kind === "modify" || operation.kind === "transition") out.modifies += 1;
    else if (operation.kind === "move") out.moves += 1;
    else out.opaque += 1;
  }
  out.noOp = operations.length === 0;
  return out;
}

function pathEqual(left: readonly (string | number)[], right: readonly (string | number)[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

/**
 * CLI-owned, single-use SQLite spill. Paths never cross the class boundary.
 * `dispose()` verifies its random ownership marker before recursive cleanup.
 */
class SqliteSemanticDiffSpillV1 {
  private readonly directory: string;
  private readonly owner: string;
  private readonly databasePath: string;
  private db: Database | null;
  private disposed = false;

  constructor() {
    this.directory = mkdtempSync(join(tmpdir(), STORE_PREFIX));
    chmodSync(this.directory, 0o700);
    this.owner = randomBytes(32).toString("hex");
    const markerPath = join(this.directory, OWNER_FILE);
    const descriptor = openSync(markerPath, "wx", 0o600);
    try {
      writeFileSync(descriptor, this.owner, { encoding: "utf8" });
    } finally {
      closeSync(descriptor);
    }
    this.databasePath = join(this.directory, DATABASE_FILE);
    this.db = new Database(this.databasePath, { create: true, strict: true });
    chmodSync(this.databasePath, 0o600);
    // This database is single-process, disposable, and never recovered after a
    // crash. Avoid journal/fsync work while retaining an on-disk spill file.
    this.db.exec("PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF; PRAGMA locking_mode=EXCLUSIVE; PRAGMA temp_store=FILE;");
    this.db.exec(`
      CREATE TABLE records (
        side TEXT NOT NULL CHECK(side IN ('baseline','target')),
        child_index INTEGER NOT NULL,
        stable_key TEXT,
        kind TEXT NOT NULL,
        source_json TEXT NOT NULL,
        semantic_json TEXT NOT NULL,
        PRIMARY KEY (side, child_index)
      );
    `);
  }

  private requireDb(): Database {
    if (!this.db || this.disposed) throw new SemanticDiffSpillErrorV1("spill-record-invalid", "Semantic diff spill is closed.");
    return this.db;
  }

  ingest(side: Side, visit: (visitor: (shard: SemanticTreeShardV1) => void) => {
    sourceRoot: CanonicalSourceNodeV1;
    semanticRoot: SemanticDocumentNodeV1;
    shardCount: number;
    diagnostics: readonly ChangeDiagnosticV1[];
  }): Omit<SpillSnapshot, "ref" | "digest"> {
    const db = this.requireDb();
    const insert = db.prepare(`
      INSERT INTO records(side, child_index, stable_key, kind, source_json, semantic_json)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    let result!: ReturnType<Parameters<typeof this.ingest>[1]>;
    const transaction = db.transaction(() => {
      result = visit((shard) => {
        const sourceJson = canonicalSourceJson(shard.sourceTree);
        const semanticJson = JSON.stringify(shard.semanticNodes);
        insert.run(side, shard.index, stableKey(shard.sourceTree), shard.sourceTree.kind, sourceJson, semanticJson);
      });
    });
    transaction();
    return { side, ...result };
  }

  snapshotDigest(
    side: Side,
    representation: SnapshotRefV1["representation"],
    sourceRoot: CanonicalSourceNodeV1,
  ): string {
    const hash = createHash("sha256");
    hash.update("{");
    hash.update(`${JSON.stringify("representation")}:${canonicalJsonV1(representation)},`);
    hash.update(`${JSON.stringify("schema")}:${canonicalJsonV1("atlcli.canonical-source/1")},`);
    hash.update(`${JSON.stringify("tree")}:{`);
    const keys = Object.keys(sourceRoot).sort();
    keys.forEach((key, keyIndex) => {
      if (keyIndex > 0) hash.update(",");
      hash.update(`${JSON.stringify(key)}:`);
      if (key === "children") {
        hash.update("[");
        let index = 0;
        const rows = this.requireDb().prepare(
          "SELECT source_json FROM records WHERE side = ? ORDER BY child_index",
        ).iterate(side) as Iterable<{ source_json: string }>;
        for (const row of rows) {
          if (index > 0) hash.update(",");
          hash.update(row.source_json);
          index += 1;
        }
        hash.update("]");
      } else {
        hash.update(canonicalJsonV1((sourceRoot as unknown as Record<string, unknown>)[key]));
      }
    });
    hash.update("}}");
    return hash.digest("hex");
  }

  count(side: Side): number {
    return Number((this.requireDb().prepare(
      "SELECT COUNT(*) AS count FROM records WHERE side = ?",
    ).get(side) as { count: number }).count);
  }

  prepareForMatch(): void {
    this.requireDb().exec("CREATE INDEX records_stable ON records(side, stable_key);");
  }

  allHaveUniqueStableKeys(side: Side): boolean {
    const db = this.requireDb();
    const missing = Number((db.prepare(
      "SELECT COUNT(*) AS count FROM records WHERE side = ? AND stable_key IS NULL",
    ).get(side) as { count: number }).count);
    const duplicate = db.prepare(`
      SELECT 1 AS found FROM records
      WHERE side = ? AND stable_key IS NOT NULL
      GROUP BY stable_key HAVING COUNT(*) > 1 LIMIT 1
    `).get(side) as { found: number } | null;
    return missing === 0 && !duplicate;
  }

  private stablePairQuery(extraWhere = ""): ReturnType<Database["prepare"]> {
    return this.requireDb().prepare(`
      SELECT b.child_index AS before_index, t.child_index AS after_index,
        b.source_json = t.source_json AS source_equal,
        b.semantic_json = t.semantic_json AS semantic_equal
      FROM records b JOIN records t ON t.side='target' AND t.stable_key=b.stable_key
      WHERE b.side='baseline' ${extraWhere}
      ORDER BY t.child_index, b.child_index
    `);
  }

  stablePairStats(): { count: number; reordered: boolean } {
    let count = 0;
    let lastBefore = -1;
    let reordered = false;
    const rows = this.requireDb().prepare(`
      SELECT b.child_index AS before_index, t.child_index AS after_index
      FROM records b JOIN records t ON t.side='target' AND t.stable_key=b.stable_key
      WHERE b.side='baseline'
      ORDER BY t.child_index, b.child_index
    `).iterate() as Iterable<Pick<PairRow, "before_index" | "after_index">>;
    for (const row of rows) {
      if (row.before_index < lastBefore) reordered = true;
      lastBefore = row.before_index;
      count += 1;
    }
    return { count, reordered };
  }

  stablePairs(changedOnly: boolean): PairRow[] {
    return this.stablePairQuery(changedOnly
      ? "AND (b.source_json <> t.source_json OR b.semantic_json <> t.semantic_json)"
      : "").all() as PairRow[];
  }

  positionalPairCount(): number {
    return Number((this.requireDb().prepare(`
      SELECT COUNT(*) AS count FROM records b
      JOIN records t ON t.side='target' AND t.child_index=b.child_index
      WHERE b.side='baseline' AND b.kind=t.kind
    `).get() as { count: number }).count);
  }

  positionalPairs(changedOnly = true): PairRow[] {
    return this.requireDb().prepare(`
      SELECT b.child_index AS before_index, t.child_index AS after_index,
        b.source_json = t.source_json AS source_equal,
        b.semantic_json = t.semantic_json AS semantic_equal
      FROM records b JOIN records t ON t.side='target' AND t.child_index=b.child_index
      WHERE b.side='baseline' AND b.kind=t.kind
        ${changedOnly ? "AND (b.source_json <> t.source_json OR b.semantic_json <> t.semantic_json)" : ""}
      ORDER BY t.child_index
    `).all() as PairRow[];
  }

  row(side: Side, index: number): { source: CanonicalSourceNodeV1; semantic: SemanticDocumentNodeV1[] } {
    const row = this.requireDb().prepare(`
      SELECT child_index AS 'index', source_json, semantic_json
      FROM records WHERE side = ? AND child_index = ?
    `).get(side, index) as StoredRow | null;
    if (!row) throw new SemanticDiffSpillErrorV1("spill-record-invalid", "Semantic diff spill record is missing.");
    return {
      source: JSON.parse(row.source_json) as CanonicalSourceNodeV1,
      semantic: JSON.parse(row.semantic_json) as SemanticDocumentNodeV1[],
    };
  }

  unmatched(side: Side): number[] {
    const other = side === "baseline" ? "target" : "baseline";
    return (this.requireDb().prepare(`
      SELECT own.child_index AS 'index' FROM records own
      LEFT JOIN records peer ON peer.side = ? AND peer.stable_key = own.stable_key
      WHERE own.side = ? AND peer.child_index IS NULL
      ORDER BY own.child_index
    `).all(other, side) as Array<{ index: number }>).map((row) => row.index);
  }

  reconstruct(snapshot: SpillSnapshot): {
    sourceTree: CanonicalSourceNodeV1;
    semanticTree: SemanticDocumentNodeV1;
  } {
    const sourceChildren: CanonicalSourceNodeV1[] = [];
    const semanticChildren: SemanticDocumentNodeV1[] = [];
    for (let index = 0; index < snapshot.shardCount; index += 1) {
      const row = this.row(snapshot.side, index);
      sourceChildren.push(row.source);
      semanticChildren.push(...row.semantic);
    }
    return {
      sourceTree: { ...snapshot.sourceRoot, children: sourceChildren },
      semanticTree: { ...snapshot.semanticRoot, children: semanticChildren },
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.db?.close();
    this.db = null;
    const markerPath = join(this.directory, OWNER_FILE);
    try {
      const resolvedDirectory = resolve(this.directory);
      const resolvedRoot = resolve(tmpdir());
      const insideRoot = relative(resolvedRoot, resolvedDirectory);
      if (
        !insideRoot || insideRoot.startsWith(`..${sep}`) || insideRoot === ".." ||
        !resolvedDirectory.startsWith(resolve(tmpdir(), STORE_PREFIX)) ||
        !existsSync(markerPath) || lstatSync(markerPath).isSymbolicLink() ||
        readFileSync(markerPath, "utf8") !== this.owner
      ) {
        throw new SemanticDiffSpillErrorV1("spill-ownership-invalid", "Semantic diff spill ownership verification failed.");
      }
      rmSync(resolvedDirectory, { recursive: true, force: false });
    } catch (error) {
      if (error instanceof SemanticDiffSpillErrorV1) throw error;
      throw new SemanticDiffSpillErrorV1("spill-cleanup-failed", "Semantic diff spill cleanup failed.");
    }
  }
}

function refFor(pair: PageDiffPairV1, side: Side): Omit<SnapshotRefV1, "digest"> {
  const source = side === "baseline" ? pair.from : pair.to;
  return {
    revision: String(source.version),
    representation: pair.representation,
    deployment: source.deployment,
    acquisition: pair.representation === "atlas_doc_format" ? "rest-v2" : "rest-v1",
  };
}

function ingestSnapshot(
  store: SqliteSemanticDiffSpillV1,
  pair: PageDiffPairV1,
  side: Side,
  options: BuildPageDiffChangeSetOptionsV1,
): SpillSnapshot {
  const source = side === "baseline" ? pair.from : pair.to;
  const visited = store.ingest(side, (visitor) => pair.representation === "atlas_doc_format"
    ? visitAdfSemanticJsonShardsV1(
        source.body.value,
        visitor,
        options.adfBudget ? { budget: options.adfBudget } : {},
      )
    : visitStorageSemanticShardsV1(
        source.body.value,
        visitor,
        options.storageBudget ? { budget: options.storageBudget } : {},
      ));
  const diagnostics = [...visited.diagnostics];
  if (
    side === "baseline" &&
    (pair.from.fallbackReason === "adf-version-unavailable" ||
      pair.to.fallbackReason === "adf-version-unavailable")
  ) {
    diagnostics.push({
      code: "source-fallback",
      severity: "warning",
      message: "Historical Cloud ADF was unavailable; both versions use exact Storage.",
      path: [],
    });
  }
  const ref = refFor(pair, side);
  return {
    ...visited,
    diagnostics,
    ref,
    digest: store.snapshotDigest(side, ref.representation, visited.sourceRoot),
  };
}

async function sourceChange(
  draft: Omit<SourceChangeV1, "id">,
): Promise<SourceChangeV1> {
  return {
    id: await digestCanonicalJsonV1({ schema: "atlcli.source-change/1", ...draft }),
    ...draft,
  };
}

function semanticNodeForOperation(nodes: readonly SemanticDocumentNodeV1[]): SemanticDocumentNodeV1 {
  if (nodes.length === 1) return nodes[0]!;
  return {
    kind: "fragment",
    attributes: {},
    children: nodes,
    sourcePaths: nodes.flatMap((node) => node.sourcePaths),
    identityHints: [],
    coverage: nodes.some(isOpaque) ? "opaque" : "projected",
  };
}

async function operation(
  subject: ChangeSetV1["subject"],
  baselineDigest: string,
  targetDigest: string,
  draft: ChangeOperationDraftV1,
): Promise<ChangeOperationV1> {
  return {
    id: await createChangeOperationIdV1({ subject, baselineDigest, targetDigest }, draft),
    ...draft,
  } as ChangeOperationV1;
}

function reorderedPairs(pairs: readonly PairRow[]): Set<string> {
  const reordered = new Set<string>();
  const prefixMax: number[] = [];
  const suffixMin: number[] = [];
  for (let index = 0; index < pairs.length; index += 1) {
    prefixMax[index] = Math.max(prefixMax[index - 1] ?? -1, pairs[index]!.before_index);
  }
  for (let index = pairs.length - 1; index >= 0; index -= 1) {
    suffixMin[index] = Math.min(suffixMin[index + 1] ?? Number.MAX_SAFE_INTEGER, pairs[index]!.before_index);
  }
  for (let index = 0; index < pairs.length; index += 1) {
    const pair = pairs[index]!;
    if (
      (prefixMax[index - 1] ?? -1) > pair.before_index ||
      (suffixMin[index + 1] ?? Number.MAX_SAFE_INTEGER) < pair.before_index
    ) reordered.add(`${pair.before_index}:${pair.after_index}`);
  }
  return reordered;
}

async function diffIndexedSnapshots(
  store: SqliteSemanticDiffSpillV1,
  pair: PageDiffPairV1,
  baseline: SpillSnapshot,
  target: SpillSnapshot,
  options: BuildPageDiffChangeSetOptionsV1,
): Promise<SemanticDiffResultV1> {
  const subject: ChangeSetV1["subject"] = {
    provider: "confluence",
    kind: "page",
    id: pair.to.id,
    label: pair.to.title,
  };
  const baseRef: SnapshotRefV1 = { ...baseline.ref, digest: baseline.digest };
  const targetRef: SnapshotRefV1 = { ...target.ref, digest: target.digest };
  if (Math.max(baseline.shardCount, target.shardCount) <= REFERENCE_SHARD_LIMIT) {
    const before = store.reconstruct(baseline);
    const after = store.reconstruct(target);
    return diffSemanticTreesV1({
      subject,
      baseline: { ref: baseline.ref, ...before, diagnostics: baseline.diagnostics },
      target: { ref: target.ref, ...after, diagnostics: target.diagnostics },
      ...(options.matcherLimits ? { limits: options.matcherLimits } : {}),
    });
  }

  const instrumentation = emptyInstrumentation();
  const diagnostics: ChangeDiagnosticV1[] = [
    ...baseline.diagnostics,
    ...target.diagnostics,
  ];
  const sourceChanges: SourceChangeV1[] = [];
  const operations: ChangeOperationV1[] = [];
  const stable = store.allHaveUniqueStableKeys("baseline") &&
    store.allHaveUniqueStableKeys("target");
  const stableStats = stable ? store.stablePairStats() : undefined;
  const positionalCount = stable ? 0 : store.positionalPairCount();
  const pairs = stable
    ? store.stablePairs(stableStats!.reordered ? false : true)
    : store.positionalPairs(true);
  instrumentation.candidateComparisons += stableStats?.count ?? positionalCount;
  if (!stable && positionalCount !== Math.min(baseline.shardCount, target.shardCount)) {
    throw new SemanticDiffSpillErrorV1(
      "spill-large-shape-unsupported",
      "Large semantic diff cannot be aligned conservatively within the spill matcher limits.",
    );
  }
  const reordered = stable && stableStats!.reordered ? reorderedPairs(pairs) : new Set<string>();

  for (const candidate of pairs) {
    const moved = reordered.has(`${candidate.before_index}:${candidate.after_index}`);
    if (candidate.source_equal && candidate.semantic_equal && !moved) continue;
    const before = store.row("baseline", candidate.before_index);
    const after = store.row("target", candidate.after_index);
    const beforeSemantic = semanticNodeForOperation(before.semantic);
    const afterSemantic = semanticNodeForOperation(after.semantic);
    if (moved) {
      const change = await sourceChange({
        kind: "move",
        fromPath: before.source.sourcePath,
        path: after.source.sourcePath,
        before: sourceSubtree(before.source),
        after: sourceSubtree(after.source),
        classification: "meaningful",
      });
      sourceChanges.push(change);
      const opaque = isOpaque(beforeSemantic) || isOpaque(afterSemantic);
      operations.push(await operation(subject, baseline.digest, target.digest, opaque ? {
        kind: "opaque-change",
        path: after.source.sourcePath,
        matchBasis: "opaque",
        confidence: "ambiguous",
        riskTags: ["opaque"],
        source: { baseline: pair.representation, target: pair.representation },
        coveredSourceChangeIds: [change.id],
        reason: "Content moved within opaque semantic coverage.",
        before: semanticSubtree(beforeSemantic),
        after: semanticSubtree(afterSemantic),
      } : {
        kind: "move",
        path: after.source.sourcePath,
        fromPath: before.source.sourcePath,
        value: semanticSubtree(afterSemantic),
        matchBasis: "stable-id",
        confidence: "anchored",
        riskTags: ["structure-change"],
        source: { baseline: pair.representation, target: pair.representation },
        coveredSourceChangeIds: [change.id],
      }));
      instrumentation.stableIdMatches += 1;
    }
    if (!candidate.source_equal || !candidate.semantic_equal) {
      const child = await diffSemanticTreesV1({
        subject,
        baseline: {
          ref: baseline.ref,
          sourceTree: before.source,
          semanticTree: beforeSemantic,
        },
        target: {
          ref: target.ref,
          sourceTree: after.source,
          semanticTree: afterSemantic,
        },
        ...(options.matcherLimits ? { limits: options.matcherLimits } : {}),
      });
      sourceChanges.push(...child.sourceChanges);
      addInstrumentation(instrumentation, child.instrumentation);
      for (const current of child.changeSet.operations) {
        const { id: _id, ...rawDraft } = current;
        let draft = rawDraft as ChangeOperationDraftV1;
        if (
          stable && pathEqual(current.path, after.source.sourcePath) &&
          current.matchBasis === "position" && current.kind !== "opaque-change"
        ) {
          draft = { ...draft, matchBasis: "stable-id", confidence: "anchored" } as ChangeOperationDraftV1;
        }
        operations.push(await operation(subject, baseline.digest, target.digest, draft));
      }
      diagnostics.push(...child.changeSet.completeness.diagnostics);
    }
  }

  if (stable) {
    for (const [side, kind] of [["baseline", "delete"], ["target", "insert"]] as const) {
      for (const index of store.unmatched(side)) {
        const row = store.row(side, index);
        const semantic = semanticNodeForOperation(row.semantic);
        const change = await sourceChange({
          kind,
          path: row.source.sourcePath,
          ...(kind === "delete"
            ? { before: sourceSubtree(row.source) }
            : { after: sourceSubtree(row.source) }),
          classification: "meaningful",
        });
        sourceChanges.push(change);
        const opaque = isOpaque(semantic);
        const draft: ChangeOperationDraftV1 = opaque
          ? {
              kind: "opaque-change",
              path: row.source.sourcePath,
              matchBasis: "opaque",
              confidence: "ambiguous",
              riskTags: kind === "delete" ? ["opaque", "destructive"] : ["opaque"],
              source: { baseline: pair.representation, target: pair.representation },
              coveredSourceChangeIds: [change.id],
              reason: `Opaque semantic content was ${kind === "delete" ? "removed" : "inserted"}.`,
              ...(kind === "delete"
                ? { before: semanticSubtree(semantic) }
                : { after: semanticSubtree(semantic) }),
            }
          : kind === "delete"
            ? {
                kind: "delete",
                path: row.source.sourcePath,
                matchBasis: "position",
                confidence: "conservative",
                riskTags: ["structure-change", "destructive"],
                source: { baseline: pair.representation, target: pair.representation },
                coveredSourceChangeIds: [change.id],
                before: semanticSubtree(semantic),
              }
            : {
                kind: "insert",
                path: row.source.sourcePath,
                matchBasis: "position",
                confidence: "conservative",
                riskTags: ["structure-change"],
                source: { baseline: pair.representation, target: pair.representation },
                coveredSourceChangeIds: [change.id],
                after: semanticSubtree(semantic),
              };
        operations.push(await operation(subject, baseline.digest, target.digest, draft));
      }
    }
  }

  operations.sort((left, right) => canonicalJsonV1([left.path, left.kind, left.id])
    .localeCompare(canonicalJsonV1([right.path, right.kind, right.id])));
  const degraded = operations.some((item) => item.kind === "opaque-change") ||
    diagnostics.some((item) => item.code === "source-incomplete" || item.severity === "error");
  if (operations.some((item) => item.kind === "opaque-change")) {
    diagnostics.push({
      code: "opaque-source-change",
      severity: "warning",
      message: "One or more exact source changes require opaque review.",
    });
  }
  const changeSet = parseChangeSetV1({
    schema: "atlcli.change-set/1",
    subject,
    baseline: baseRef,
    target: targetRef,
    completeness: { status: degraded ? "degraded" : "complete", diagnostics },
    summary: summary(operations),
    operations,
    limits: { truncated: false, emittedOperations: operations.length },
  });
  return { changeSet, sourceChanges, instrumentation };
}

export function shouldUseSemanticDiffSpillV1(
  pair: PageDiffPairV1,
  thresholdBytes = DEFAULT_SEMANTIC_DIFF_SPILL_BYTES_V1,
): boolean {
  if (!Number.isSafeInteger(thresholdBytes) || thresholdBytes < 0) {
    throw new RangeError("Semantic diff spill threshold must be a non-negative safe integer.");
  }
  const bytes = Buffer.byteLength(pair.from.body.value) +
    (pair.from === pair.to ? 0 : Buffer.byteLength(pair.to.body.value));
  return bytes >= thresholdBytes;
}

/** Build one ChangeSet through an owned, finally-cleaned temporary spill. */
export async function buildPageDiffChangeSetWithSpillV1(
  pair: PageDiffPairV1,
  options: BuildPageDiffChangeSetOptionsV1 = {},
): Promise<SemanticDiffResultV1> {
  if (
    pair.from.body.representation !== pair.representation ||
    pair.to.body.representation !== pair.representation
  ) {
    throw new SemanticDiffSpillErrorV1("spill-record-invalid", "Page diff pair representations disagree.");
  }
  const store = new SqliteSemanticDiffSpillV1();
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
  const signalNumbers: Record<(typeof signals)[number], number> = {
    SIGINT: 2,
    SIGTERM: 15,
    SIGHUP: 1,
  };
  const handlers = new Map<(typeof signals)[number], () => void>();
  for (const signal of signals) {
    const handler = (): void => {
      for (const [name, current] of handlers) process.off(name, current);
      try {
        store.dispose();
      } finally {
        process.exit(128 + signalNumbers[signal]);
      }
    };
    handlers.set(signal, handler);
    process.once(signal, handler);
  }
  let primaryError: unknown;
  try {
    const baseline = ingestSnapshot(store, pair, "baseline", options);
    // The visitor has released its validated JSON/XML object graph; collect it
    // before parsing the second version so both representation trees cannot
    // overlap at the process peak. This host adapter is deliberately Bun-only.
    if (baseline.shardCount >= 20_000) Bun.gc(true);
    const target = pair.from === pair.to
      ? { ...baseline, side: "target" as const }
      : ingestSnapshot(store, pair, "target", options);
    if (pair.from === pair.to) {
      // Equal-version reads are acquired once; duplicate only compact spill rows.
      store.ingest("target", (visitor) => {
        for (let index = 0; index < baseline.shardCount; index += 1) {
          const row = store.row("baseline", index);
          visitor({ index, sourceTree: row.source, semanticNodes: row.semantic });
        }
        return {
          sourceRoot: baseline.sourceRoot,
          semanticRoot: baseline.semanticRoot,
          shardCount: baseline.shardCount,
          diagnostics: baseline.diagnostics,
        };
      });
    }
    store.prepareForMatch();
    return await diffIndexedSnapshots(store, pair, baseline, target, options);
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    for (const [signal, handler] of handlers) process.off(signal, handler);
    try {
      store.dispose();
    } catch (cleanupError) {
      if (primaryError === undefined) throw cleanupError;
    }
  }
}

/** Test-only observable that never exposes an execution path. */
export function countSemanticDiffSpillDirectoriesForTestV1(): number {
  return readdirSync(tmpdir(), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(STORE_PREFIX)).length;
}
