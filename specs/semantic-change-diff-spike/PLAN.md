# Semantic Change Diff Spike

Status: draft for iteration

Plan date: 2026-08-10

Planned against: `8b664e33`

Priority: P1

Estimated effort: L, approximately 2-3 focused development weeks across three
independently reviewable phases, including the ADF contract extraction, two
document-source adapters, Jira compatibility proof, tests, the dependency
bake-off, and the required Cloud live proof

Risk: MED for the opt-in read-only spike; HIGH if its matching result is later
used to authorize writes without a separate baseline/apply contract

## 1. Outcome

Add an opt-in semantic version diff to `atlcli wiki page diff` that:

- compares any two explicit Confluence page versions, or one historical version
  with the current version;
- uses version-bound ADF for Confluence Cloud when the documented endpoint is
  proven by the live gate;
- uses version-bound Storage XHTML for Confluence Data Center and never probes
  a Cloud-only ADF endpoint there;
- produces a readable tree-oriented terminal diff;
- emits the same host- and renderer-neutral Atlassian `ChangeSetV1` as JSON
  through the existing global `--json` flag;
- keeps the existing unified Markdown diff byte-compatible unless the caller
  explicitly requests `--format semantic`;
- proves that the same `ChangeSetV1` can express Jira field, collection, and
  transition plans without making Jira depend on Confluence or export models;
- remains read-only: this spike does not apply, restore, transition, or bulk-edit
  anything.

The spike is successful when the following commands work:

```bash
# Existing behavior remains the default.
atlcli wiki page diff --id 12345 --version 3

# Semantic historical version -> current version.
atlcli wiki page diff --id 12345 --version 3 --format semantic

# Semantic arbitrary version -> version comparison.
atlcli wiki page diff --id 12345 --from 3 --to 7 --format semantic

# Exactly one machine-readable JSON document containing the ChangeSet.
atlcli wiki page diff --id 12345 --from 3 --to 7 --format semantic --json
```

Data Center support in this spike is **implemented and contract-tested, but not
project-live-certified**. Cloud is additionally certified through the existing
private `mayflower` / `DOCSY` E2E lane. This distinction must appear in the
evidence and documentation.

## 2. Executive architecture decision

ADF is already an ordered JSON document tree. Do not add Tree-sitter, an ADF
grammar, ProseMirror, or the Atlaskit editor diff plugins to the runtime.

Build the capability as six explicit layers:

```text
Confluence Cloud                         Confluence Data Center
version-bound ADF + Storage sidecar      version-bound Storage XHTML
        |                                        |
        v                                        v
bounded ADF validation                    bounded XML parsing
        |                                        |
        +------------- source adapters ----------+
                              |
                              v
          canonical source tree after documented noise policy
                              |
                              +---- exact-change completeness check
                              |
                              v
                    semantic document tree
                              |
                              v
              bounded conservative tree matcher
                              |
                              v
        host- and renderer-neutral Atlassian ChangeSetV1
                    /                     \
                   v                       v
          terminal tree renderer       JSON envelope

Jira observed issue + intended operation
                              |
                              v
                Jira ChangeSetV1 adapter proof
```

The canonical source tree and semantic tree are intentionally separate:

- The canonical source tree must retain all validated ADF nodes, marks,
  attributes, unknown content, or Storage elements/attributes needed to prove
  that a source change was not lost.
- The semantic tree exists to present understandable document concepts such as
  headings, paragraphs, lists, table rows/cells, panels, macros, links, and
  media.
- `ExportBlock[]` may supply projection patterns and paired fixtures, but it is
  not the canonical SafeOps truth. Export decoding is allowed to approximate or
  omit representation details that a change review must still report.
- Any exact source change that cannot be represented semantically becomes an
  explicit `opaque-change` operation or a degraded-completeness diagnostic. It
  must never disappear as a no-op.

Large documents add a second execution shape with the same ChangeSet contract:

```text
validated source, one version at a time
              |
              v
browser-neutral canonical node/event projection
              |
              +---- incremental canonical-source SHA-256 sink
              |
              v
injected bounded SpillStore (CLI: owned temporary SQLite file)
              |
              v
parent-window matcher + completeness accounting -> ChangeSetV1
```

The in-memory tree path remains the reference implementation for small inputs.
Above a calibrated threshold the CLI must not retain source and semantic trees
for both versions. It ingests one exact-version source at a time into the
injected store, releases the source, and then performs bounded parent-window
matching. The portable package defines events, records, limits, and store/hash
ports only; filesystem, SQLite, Node, and Bun stay in the CLI host adapter.

## 3. Current state and evidence

The executor must re-open these files before changing anything. If these seams
have materially drifted from the descriptions below, stop and update this plan
before implementation.

### 3.1 Existing page diff

- `apps/cli/src/commands/page.ts:645-710` implements `handleDiff`. It requires
  `--id`, reads current and historical Storage, converts both bodies to Markdown,
  and calls the line-oriented diff.
- `packages/confluence/src/diff.ts:1-172` owns the current `DiffResult`, unified
  patch generation, summary, and ANSI renderer.
- `packages/confluence/src/diff.test.ts:9-177` covers only text/unified behavior.
- The JSON branch in `apps/cli/src/commands/page.ts:686-697` emits the existing
  `schemaVersion: "1"` text-diff shape.

This existing path must remain unchanged when `--format` is absent or equals
`unified`.

### 3.2 CLI/documentation drift to fix in the same slice

- `apps/cli/src/commands/page.ts:645-684` currently accepts only `--version`.
- `apps/cli/src/index.ts:44-46` currently treats any `--version` flag anywhere
  in the argv as the global CLI-version request. Consequently
  `wiki page diff --version N` exits before `handleDiff`; WP0 must characterize
  this bug and WP6 must narrow the global shortcut to the root invocation.
- `apps/cli/src/commands/page.ts:1995-2035` documents only part of the live
  command contract in built-in help.
- `src/content/docs/confluence/history.md:65-99` already documents `--from`,
  `--to`, `--context`, and `--no-color`, although `--from`/`--to` are not
  implemented by the command.
- `src/content/docs/reference/cli-commands.md` also advertises arbitrary version
  comparisons.

The spike must implement the documented `--from`/`--to` contract and correct
examples that currently use a positional page ID even though `handleDiff`
requires `--id`.

### 3.3 Existing Cloud/Data Center layering

- `packages/core/src/types.ts:8-33` defines `DeploymentType = "cloud" |
  "data-center"`.
- `packages/core/src/confluence-url.ts:18-42` resolves explicit and legacy
  deployment types and preserves Data Center context paths.
- `packages/confluence/src/page-body.ts:19-64` models ADF and Storage as a
  discriminated `PageBody` union with source version and fallback provenance.
- `packages/confluence/src/client.ts:1008-1038` reads the current Cloud page as
  ADF via REST v2.
- `packages/confluence/src/client.ts:1191-1288` is the required layering model:
  Cloud performs a version-consistent ADF/Storage dual read; Data Center selects
  Storage without probing Cloud v2; mismatched versions fail closed.
- `packages/confluence/src/client.ts:3143-3175` reads a historical page version
  only as Storage today.
- `packages/confluence/src/page-body.test.ts` contains paired ADF/Storage fixtures
  that already prove visible neutral projection parity for supported content.

Do not reuse an export-named contract when that would make page-diff semantics
misleading. Reuse the policy and low-level `PageBody` types where appropriate,
but introduce a version-diff-specific source envelope.

### 3.4 Existing ADF and Storage trees

- `packages/confluence/src/adf-types.ts:1-112` contains the generic ADF JSON
  tree, parse budgets, diagnostics, and validated-document type.
- `packages/confluence/src/adf-coverage.ts` pins
  `@atlaskit/adf-schema@56.1.15` and distinguishes stable from Stage-0 surface.
- `packages/confluence/src/adf-validate.ts:1030-1234` performs iterative,
  bounded, fail-closed structural validation and retains unknown-node/mark/attr
  diagnostics.
- `packages/confluence/src/export-blocks.ts:155-350` contains the bounded,
  browser-safe Storage XML tree (`XmlNode`) and `parseXml()`.
- `packages/confluence/src/adf-to-blocks.ts` and
  `packages/confluence/src/page-body-to-blocks.ts` show how the two
  representations are projected into shared visible semantics for export.

The spike must reuse these parsers and the ADF safety budget. Storage diffing
must pass its own calibrated tighter budget to `parseXml()` rather than inherit
the export-scale default. It must not parse ADF via JSON text diffing,
Tree-sitter, Markdown, or Storage round-trips.

### 3.5 Jira seam

- `packages/jira/src/types.ts:167-219` currently duplicates a weaker ADF type and
  models issue description as ADF, string, or null.
- `packages/jira/src/types.ts:391-400` distinguishes field replacements from
  Jira `set`/`add`/`remove` update operations.
- `packages/jira/src/client.ts:871-927` keeps update and transition requests
  separate.
- `apps/cli/src/commands/jira.ts:3364-3587` emits dry-run summaries but not
  concrete per-issue old -> new ChangeSets.

The spike must prove the shared model here, but it must not alter existing Jira
bulk execution, batching, or mutation commands.

### 3.6 External contracts to re-verify at implementation start

- [Atlassian Document Format structure](https://developer.atlassian.com/cloud/jira/platform/apis/document/structure/)
  confirms that ADF is an ordered JSON document tree; it is not a text language
  needing a Tree-sitter grammar.
- [Confluence Cloud REST v2 page API](https://developer.atlassian.com/cloud/confluence/rest/v2/api-group-page/)
  and [version API](https://developer.atlassian.com/cloud/confluence/rest/v2/api-group-version/)
  are the documented Cloud contracts to verify for exact historical ADF
  acquisition. Endpoint behavior remains subject to the live gate.
- [`jsondiffpatch`](https://github.com/benjamine/jsondiffpatch) is only a
  candidate tree-delta engine. Its generic delta contract is not the product
  contract and does not by itself establish semantic correctness.

Record the checked documentation date and any endpoint/schema drift in
`EVIDENCE.md`; do not turn an undocumented behavior observed in one tenant into
a product contract.

## 4. Public and internal contracts

### 4.1 New `@atlcli/change-set` package

Create `packages/change-set/` as a dependency-free, side-effect-free,
browser-safe, experimental `public-0.x` package following
`packages/export-blocks/` conventions.

Required entrypoints:

```text
@atlcli/change-set       Atlassian change contracts, validation, matcher, digest
@atlcli/change-set/adf   ADF types, validation, normalization, and projection
```

The root entrypoint must not import Confluence, Jira, CLI, React, Forge, WXT,
DOM, Node, Bun, or third-party runtime modules. The ADF subpath may contain
Atlassian document semantics but must remain browser-safe and host-neutral. Put
the ADF entry in `packages/change-set/src/adf/index.ts` and declare the `./adf`
subpath explicitly in `packages/change-set/package.json`.

Move the generic ADF types, pinned schema inventory, pure validator, and the
`trustValidatedAdf()` / `isTrustedValidatedAdf()` trust-branding functions from
`packages/confluence` into `@atlcli/change-set/adf`; do not duplicate them.
Retain compatibility re-exports from `@atlcli/confluence` so its frozen public
surface does not silently lose symbols. Keep only the `sourceDocuments` WeakMap
and its source-object lookup helpers Confluence-local: that cache is a caller
optimization, while the trusted validated-document brand is part of the shared
ADF contract.

Do **not** move all of `packages/confluence/src/adf-coverage.ts`. Its
`ADF_NODE_DECODE_MODES`, `ADF_STAGE0_NODE_DECODE_MODES`,
`ADF_MARK_DECODE_MODES`, DOCX/PDF coverage, and export-decoder policy remain
owned by Confluence/export. Extract only the schema inventory and validator
policy needed to decide whether an ADF document is valid and complete enough
for canonicalization.

If extracting the validator would require changing its validation behavior or
the pinned schema inventory in the same commit, stop and split the extraction
from the semantic-diff implementation. A pure relocation with compatibility
re-exports is acceptable; a schema-policy migration is not part of this spike.

### 4.2 `ChangeSetV1`

Use an owned versioned contract. Do not expose a `jsondiffpatch`, ProseMirror,
or renderer-specific delta.

Target shape:

```ts
export interface ChangeSetV1 {
  schema: "atlcli.change-set/1";
  subject: {
    provider: "confluence" | "jira";
    kind: "page" | "issue";
    id: string;
    label?: string;
  };
  baseline: SnapshotRefV1;
  target: SnapshotRefV1;
  completeness: {
    status: "complete" | "degraded";
    diagnostics: ChangeDiagnosticV1[];
  };
  summary: {
    inserts: number;
    deletes: number;
    modifies: number;
    moves: number;
    opaque: number;
    noOp: boolean;
  };
  operations: ChangeOperationV1[];
  limits: {
    truncated: boolean;
    emittedOperations: number;
    totalOperations?: number;
  };
}

export interface SnapshotRefV1 {
  revision: string;
  digest: string;
  representation: "atlas_doc_format" | "storage" | "jira-fields";
  deployment?: "cloud" | "data-center";
  acquisition:
    | "rest-v2"
    | "rest-v1"
    | "planned-operation"
    | "synthetic-fixture"
    | "local-file";
}

export type ChangeOperationV1 =
  | InsertOperationV1
  | DeleteOperationV1
  | ModifyOperationV1
  | MoveOperationV1
  | CollectionAddOperationV1
  | CollectionRemoveOperationV1
  | TransitionOperationV1
  | OpaqueChangeOperationV1;
```

Every operation must include:

- a deterministic operation ID derived from the subject, both snapshot
  digests, the operation kind, semantic paths, and canonical before/after
  values;
- a host- and renderer-neutral semantic path represented as JSON-safe path
  segments;
- bounded `before` and/or `after` values where relevant;
- `matchBasis: "stable-id" | "exact-subtree" | "sequence" | "position" |
  "opaque"`;
- `confidence: "exact" | "anchored" | "conservative" | "ambiguous"`;
- zero or more typed risk tags;
- source representation provenance.

The contract may reserve optional `baselineDigest` and `planDigest` fields for
future SafeOps binding, but this spike must not claim that a ChangeSet is an
executable plan or implement apply/CAS behavior.

No raw complete source document may be repeated inside operations. A diff is
allowed to contain changed user text because that is its purpose, but it must
not put raw bodies into logs, progress events, errors, or durable fixtures.

### 4.3 Canonical JSON and digest

Implement deterministic JSON serialization with:

- lexicographically sorted object keys;
- array order preserved unless a domain adapter explicitly declares set
  semantics;
- no `undefined`, functions, classes, `Map`, `Set`, cyclic values, NaN, or
  infinity;
- UTF-8 SHA-256 through browser-compatible Web Crypto for snapshot and plan
  digests;
- a chunked canonical serializer plus injected incremental digest sink for the
  spill lane; the CLI sink must use cryptographic SHA-256 and produce the exact
  same digest as the Web Crypto one-shot reference path;
- byte-identical output across repeated Bun and Node-compatible runs;
- browser build safety for both package entrypoints, without claiming browser
  runtime determinism until a real browser execution harness exists.

Define `SnapshotRefV1.digest` exactly as SHA-256 over the canonical JSON bytes
of:

```ts
{
  schema: "atlcli.canonical-source/1",
  representation,
  tree: canonicalSourceTree,
}
```

It is not a digest of raw REST bytes, the semantic tree, the rendered output,
or the whole ChangeSet envelope. This definition plus both snapshot digests in
operation IDs prevents equal-looking operations from colliding across distinct
baselines.

Digest failures are fatal. Do not fall back to a non-cryptographic digest for a
field that will later be used as a SafeOps baseline token.

### 4.4 Canonical source and semantic document nodes

Use two internal types:

```ts
interface CanonicalSourceNodeV1 {
  kind: string;
  attributes: CanonicalJsonObject;
  text?: string;
  marks?: CanonicalMarkV1[];
  children: CanonicalSourceNodeV1[];
  sourcePath: SemanticPathV1;
  identityHints: IdentityHintV1[];
}

interface SemanticDocumentNodeV1 {
  kind: string;
  label?: string;
  attributes: CanonicalJsonObject;
  text?: string;
  children: SemanticDocumentNodeV1[];
  sourcePaths: SemanticPathV1[];
  identityHints: IdentityHintV1[];
  coverage: "exact" | "projected" | "opaque";
}
```

The semantic node is the user-facing alignment input. The canonical source node
is the completeness oracle. A semantic no-op is permitted only when the exact
source comparison is also a no-op or every exact difference is explicitly
classified as policy-defined noise.

Make completeness mechanically checkable:

1. Diff the canonical source trees into stable internal `SourceChangeV1`
   records before semantic rendering.
2. Give every semantic operation a bounded `coveredSourceChangeIds` array.
3. Mark policy-defined noise as an explicit source-change classification rather
   than deleting it during canonicalization.
4. Convert every unclaimed non-noise source change into an `opaque-change`
   operation and degrade completeness.
5. Assert in tests that the union of covered, noise-classified, and opaque
   source-change IDs equals the complete exact-source change set.

## 5. Source acquisition policy

### 5.1 Version selection

Parse flags before constructing a client:

| Flags | Meaning |
| --- | --- |
| none | previous version -> current version |
| `--version N` | backward-compatible alias for `--from N`, target current |
| `--from N` | version N -> current |
| `--from N --to M` | version N -> version M |
| `--to M` without `--from` | usage error |
| `--version` combined with `--from` or `--to` | usage error |
| non-positive/non-integer version | usage error |

Do not require `from < to`; reverse comparisons are valid for rollback review.
When the target is current, first resolve its numeric version, then fetch that
exact version. Never compare one unversioned moving current body with one frozen
historical body.

### 5.2 New version-bound source envelope

Add a narrow Confluence contract such as:

```ts
export interface PageDiffSourceV1 {
  id: string;
  title: string;
  version: number;
  deployment: "cloud" | "data-center";
  body: PageBody;
  storageSidecar?: string;
  fallbackReason?: "data-center" | "adf-version-unavailable";
}
```

The source acquisition API must accept an explicit version and return metadata
plus one selected representation. Suggested symbols:

```ts
ConfluenceClient.getPageAdfAtVersion(id, version, options)
ConfluenceClient.getPageDiffSource(id, version, options)
readPageDiffPair(client, id, fromVersion, toVersion)
```

Names may be adjusted to match the implementation, but the responsibilities
must remain separate: HTTP read, per-version source construction, and pairwise
representation policy.

### 5.3 Cloud policy

For Cloud:

1. Request the exact version from REST v2 using
   `body-format=atlas_doc_format&version=N`.
2. Read the exact Storage version through the existing v1 version endpoint as
   a compatibility sidecar and permission/version proof.
3. Require both responses to identify version N. A mismatch is
   `page-version-mismatch` and fails closed.
4. If both ADF versions are available, select ADF for both sides.
5. If the documented versioned ADF capability is unavailable after successful
   Storage identity/permission reads, select the already acquired exact Storage
   sidecars for both sides and emit
   `fallbackReason: "adf-version-unavailable"`.
6. Authentication, authorization, rate-limit, timeout, 5xx, malformed ADF, or
   budget failures must not be disguised as representation fallback.

The pair must use one representation. Never compare ADF on one side with
Storage on the other. If pairwise selection cannot establish one trustworthy
representation, fail rather than reconstructing content.

### 5.4 Data Center policy

For Data Center:

1. Use `resolveDeploymentType(profile)` as the authoritative routing decision.
2. Read both exact versions through the existing v1 Storage endpoint.
3. Do not call `/api/v2`, request `atlas_doc_format`, or infer ADF support.
4. Parse Storage with the existing bounded `parseXml()` implementation.
5. Mark both snapshot refs as `representation: "storage"`,
   `deployment: "data-center"`, and `acquisition: "rest-v1"`.

DC tests must exercise a base URL with a non-root context path and Bearer auth,
because these are established compatibility cases. No live DC certification is
claimed without an operator-provided environment.

## 6. Canonicalization policy

### 6.1 ADF

After `validateAdf()` succeeds:

- preserve document child order;
- sort attribute object keys recursively;
- sort marks deterministically only when their order has no documented semantic
  meaning; record this rule in one explicit policy table;
- merge adjacent text nodes only when they have exactly equal canonical marks
  and doing so does not cross a semantic boundary;
- retain unknown nodes, marks, and attributes as opaque canonical data with
  bounded diagnostics;
- treat `localId` and comparable identifiers as identity hints, not sufficient
  proof by themselves and not normally as user-visible content changes;
- keep macro/extension keys, parameters, link destinations, task/status state,
  table structure, media identity, and meaningful layout attributes semantic;
- do not normalize by round-tripping through Markdown or Storage.

Create a reviewed policy table for attributes classified as:

- semantic and diff-visible;
- identity-only;
- proven representation noise;
- unknown and therefore preserved/opaque.

The default for an unclassified attribute is preserved and diff-visible, not
ignored.

### 6.2 Storage XHTML

The current `parseXml()` tree is not a byte-lossless XML AST: it discards
comments, XML declarations, DOCTYPEs, and processing instructions; decodes
entities; strips XML-illegal control characters; and does not retain source
attribute order. Therefore the spike promises **canonical source exactness
after a documented Storage noise policy**, not raw-byte exactness.

Before semantic matching, define and test that policy explicitly:

- comments, declarations, DOCTYPEs, processing instructions, and source
  attribute order are representation noise only if the corpus proves they
  cannot carry Confluence meaning;
- entity spelling is noise, while its decoded character remains meaningful;
- stripping XML-illegal controls is recorded as a canonicalization diagnostic;
- if any discarded construct is shown to affect Confluence semantics, stop and
  adopt or write a parser that preserves it instead of claiming completeness.

Apply a diff-specific input-byte, node, depth, and decoded-text budget before
matching. Do not silently inherit the export parser's two-million-node default,
which can materialize hundreds of MiB. Calibrate and pin the tighter limits from
the synthetic and representative corpus. A `StorageParseError` or input-byte
budget failure is fatal and distinct from later ChangeSet operation or renderer
truncation; it must never yield a partial, complete-looking ChangeSet.

After bounded `parseXml()` succeeds:

- normalize namespace-aware element and attribute names without losing the
  original semantic namespace;
- ignore source attribute order and insignificant formatting whitespace only
  where tests prove equivalence;
- retain macro names/IDs/parameters, link destinations, structured bodies,
  table/list hierarchy, embedded resource identity, and unknown elements;
- classify unsupported constructs as opaque rather than flattening them to
  Markdown;
- do not attempt Storage -> ADF conversion.

### 6.3 Cross-representation projection

ADF and Storage adapters should project equivalent supported content to the
same semantic node vocabulary. Extend the existing paired fixtures to prove
this property. Source-exact trees remain representation-specific and are not
expected to be equal across ADF and Storage.

## 7. Matching policy

Implement a bounded, conservative matcher. A false delete+insert is acceptable
in ambiguous cases; a false move is not.

Within each already matched parent:

1. Match identity hints only when the value is unique on both sides and the
   node kinds are compatible.
2. Match unmatched nodes with unique, exactly equal canonical subtree digests.
3. Align remaining ordered siblings with a patience/Myers-style sequence
   algorithm over shallow structural signatures.
4. Inside one-to-one unmatched gaps, align same-kind nodes positionally and
   emit modifications.
5. Leave multi-candidate or repeated ambiguous gaps as delete+insert and add an
   ambiguity diagnostic.

For the spike:

- report moves only for unique stable identities or unique exact subtree
  matches;
- support intra-parent block moves;
- represent cross-parent moves, inline-node moves, paragraph split/merge, and
  table split/merge conservatively as delete+insert;
- keep canonical `before`/`after` text in the host- and renderer-neutral
  Atlassian operation; apply
  the existing `diff` package only in the Confluence terminal renderer at the
  presentation edge after block matching;
- report mark-only and attribute-only changes as modifications;
- instrument candidate comparison counts;
- never allocate an unbounded global `N x M` matrix.

Provide configurable limits for maximum nodes, candidate comparisons,
operations, and rendered payload bytes. Limit exhaustion must set
`limits.truncated` and add a diagnostic. It must never silently return a
complete-looking partial ChangeSet. A future SafeOps apply path must reject a
truncated or degraded ChangeSet by default.

## 8. Terminal and JSON output

### 8.1 Compatibility rule

`--format` accepts `unified | semantic`:

- omitted or `unified`: preserve current terminal and JSON behavior;
- `semantic`: use the new ChangeSet and tree renderer;
- any other value: usage error;
- `--context` applies only to `unified`; reject it with `semantic` rather than
  silently ignoring it.

Do not change the default to semantic during this spike. Promotion requires a
separate decision after corpus and live evidence are reviewed.

### 8.2 Semantic terminal shape

The renderer should produce a stable, compact outline similar to:

```text
Wiki page "API Reference"  v3 -> v7  [cloud / atlas_doc_format]

~ heading "Authentication"
  ~ paragraph
    - Use API tokens.
    + Use scoped API tokens.
+ panel "Migration warning"
> table row moved 4 -> 2  [exact-subtree]
! opaque macro attribute changed at content[8]

Summary: 1 added, 0 deleted, 2 modified, 1 moved, 1 opaque
Completeness: degraded (1 opaque source change)
```

Requirements:

- deterministic ordering;
- ANSI only in human terminal mode; `--no-color` and `NO_COLOR` disable it for
  both unified and semantic renderers;
- explicit source representation and version provenance;
- changed text bounded in the renderer without changing the underlying
  ChangeSet;
- visible warnings for ambiguity, opaque changes, fallback, and truncation.

### 8.3 JSON shape

With `--format semantic --json`, emit exactly one stdout document:

```json
{
  "schemaVersion": "1",
  "changeSet": {
    "schema": "atlcli.change-set/1",
    "subject": {
      "provider": "confluence",
      "kind": "page",
      "id": "12345",
      "label": "API Reference"
    },
    "baseline": {},
    "target": {},
    "completeness": {},
    "summary": {},
    "operations": [],
    "limits": {}
  }
}
```

There must be no ANSI, progress text, logging, raw full ADF/Storage body, auth
material, or tenant-derived fixture data in the envelope. Stable error paths
must use the existing JSON error envelope from `fail()`.

Exit behavior:

- valid no-op diff: exit 0 with `summary.noOp: true`;
- valid diff with changes: exit 0;
- invalid flags, validation/budget failure, representation failure, or version
  mismatch: non-zero with a stable error code;
- truncation may render for exploratory CLI use but must be visibly marked and
  must never claim completeness.

## 9. Jira compatibility proof

Add a pure adapter in `packages/jira/src/change-set.ts`. It may depend on
`@atlcli/change-set` and `@atlcli/change-set/adf`; it must not depend on
`@atlcli/confluence`, `@atlcli/export-blocks`, CLI code, or a host framework.

Required pure functions, with final names adjusted to repository conventions:

```ts
planJiraFieldChangesV1(issue, updateInput): Promise<ChangeSetV1>
planJiraTransitionV1(issue, transition): Promise<ChangeSetV1>
```

The proof must model:

- scalar replacement such as priority;
- entity references by stable ID, with display name used only as a label;
- set-like labels/components/version collections with add/remove/no-op;
- Jira `fields` replacement separately from `update.set/add/remove` intent;
- ADF description changes through the shared ADF adapter;
- transitions as a distinct operation with higher risk than a field edit;
- unavailable transition or missing observed field data as a diagnostic, not an
  executable-looking change;
- unknown custom fields as bounded opaque before/after values with degraded
  semantics.

This proves model fitness only. Do not wire the adapter into bulk commands, do
not add a plan store, and do not mutate issues in this spike.

## 9.1 Streaming and spill execution contract

`@atlcli/change-set` must expose a browser-neutral `SpillStoreV1` port and
canonical event/record types. The port is an ephemeral execution detail, not a
durable audit database and not part of ChangeSet JSON. Its minimum operations
must support:

- beginning baseline and target snapshots;
- appending bounded canonical/semantic node records in deterministic order;
- finalizing each snapshot with its exact canonical-source digest;
- reading one parent's ordered child window and unique stable-ID/subtree-hash
  candidates without loading the complete document;
- reconstructing only a bounded changed subtree/value for an emitted operation;
- closing and erasing the execution store in `finally`, including parse,
  matching, render, abort, and signal/error paths.

The CLI implementation owns a freshly-created private temp directory and a
single SQLite file below it. It must create an ownership marker containing a
random execution nonce, use only resolved paths below that directory, never
reuse caller-supplied paths, and verify ownership before recursive cleanup.
Raw Atlassian response bodies are not stored in SQLite. Stored records contain
only the bounded canonical node fields needed for matching and completeness.
Temp paths and records must not appear in output, diagnostics, logs, fixtures,
or evidence.

Spill selection is deterministic and representation-neutral. The default lane
uses the in-memory matcher below the calibrated source-byte/node threshold and
the spill lane at or above it. Tests must allow the threshold to be forced so
the same ADF and Storage goldens exercise both implementations. A spill failure
is fatal; it must not silently retry through the high-memory path.

## 10. Dependency bake-off

### 10.1 Decisions fixed for the spike

- Keep the pinned `@atlaskit/adf-schema` fixtures as the schema source of truth.
- Keep the existing `diff` package for inline/text leaf changes.
- Reject Tree-sitter for ADF.
- Reject runtime ProseMirror and Atlaskit `show-diff` / `track-changes` plugins.
- Reject Markdown/MDAST as the canonical diff representation.
- Do not embed GumTree; it may be used manually as a non-product oracle only.

### 10.2 `jsondiffpatch` experiment

Add `jsondiffpatch` only as a dev dependency for an isolated bake-off. It must
consume the same canonical source/semantic inputs. It does not natively emit
`ChangeSetV1`, so do not pretend its delta is directly golden-compatible.

Record a normalized `CandidateObservation` for each matcher with at least:

- whether it detected a change;
- changed semantic paths;
- move claims and false-positive moves;
- unknown-node/attribute preservation;
- diagnostics, candidate comparisons, wall time, and peak RSS.

Any experimental translation from a `jsondiffpatch` delta into `ChangeSetV1`
is a separate adapter with its own tests; adapter defects must not be scored as
library matcher behavior or hidden inside the benchmark.

Create `scripts/bench/semantic-diff-bakeoff.ts` and record results in
`specs/semantic-change-diff-spike/EVIDENCE.md`.

Adopt it as a runtime dependency only in a follow-up decision if it:

- passes every correctness golden without a new false-positive move;
- preserves unknown-node and attribute completeness;
- is deterministic in repeated Bun/Node-compatible runs and browser-build safe;
- materially improves matching quality, measured p95 runtime, or owned code
  complexity;
- adds no more than 50 KiB minified+gzip to the browser change-core entrypoint.

The initial production spike should use the owned conservative matcher. Do not
conditionally select matchers at runtime.

## 11. Fixture and goldset plan

Create synthetic, tenant-neutral pairs under their owning packages:

```text
packages/change-set/test-fixtures/
  adf/<case>/before.json
  adf/<case>/after.json
  adf/<case>/expected.change-set.json
packages/confluence/test-fixtures/semantic-diff/
  storage/<case>/before.xml
  storage/<case>/after.xml
  storage/<case>/expected.change-set.json
packages/jira/test-fixtures/change-set/
  <case>/observed.json
  <case>/operation.json
  <case>/expected.change-set.json
```

Required cases:

- identical content;
- object-key, attribute-order, and explicitly approved noise-only changes;
- paragraph/heading text change;
- mark-only change;
- link target change;
- status/task-state change;
- insert/delete/move paragraph;
- repeated identical paragraphs where move matching must abstain;
- nested ordered/unordered/task lists;
- table cell, row, order, colspan/rowspan, and layout changes;
- panels, expands, cards, media, mentions, and annotations;
- macro/extension key and parameter changes;
- unknown node, mark, attribute, and Storage element changes;
- changed/duplicated/missing `localId`;
- deliberately ambiguous split/merge;
- invalid/over-budget ADF and Storage;
- Jira scalar, set, entity, ADF description, transition, no-op, and unknown
  custom-field cases;
- generated 10k- and 100k-node stress documents kept as deterministic fixture
  generators rather than huge committed files.

Private live page bodies, page IDs, account IDs, site URLs, or derived tenant
artifacts must never be committed. Live evidence records only synthetic resource
names, versions, counts, digests, timings, classifications, and cleanup receipts.

## 12. Implementation work packages

Execute the work packages in three reviewable phases:

| Phase | Work packages | Reviewable outcome | Exit gate |
| --- | --- | --- | --- |
| A - Contract and matcher | WP0-WP3 | frozen legacy behavior, extracted ADF trust boundary, owned ChangeSet, goldset-backed matcher | contract/API review plus focused offline gates |
| B - Confluence product slice | WP4-WP6 plus the Cloud portion of WP9 | Cloud ADF and DC Storage acquisition, terminal/JSON CLI diff | full offline matrix plus cleaned-up `mayflower` / `DOCSY` Cloud E2E |
| C - Jira and decision evidence | WP7-WP10 plus final WP9 docs/gates | Jira SafeOps-format proof, dependency verdict, and bounded large-document execution | Jira goldens, streaming/spill goldens, green 10k/100k gates, bake-off evidence, full repository gates, second cleaned-up Cloud E2E if code changed after Phase B |

Each work package ends in a green focused test gate, but the repository rule is
stronger: **do not create an implementation commit before the relevant Cloud
live E2E has passed and cleanup is proven**. Keep Phase A/B changes uncommitted
until the Phase B live gate; then form the suggested logical conventional
commits from that verified tree. If Phase C changes source code, repeat the live
gate before committing those changes. Read-only feature execution does not
mutate content, but E2E setup and cleanup use the repository's already
authorized synthetic-page write paths. Do not push unless explicitly
instructed.

### WP0 - Characterize the current command before changing it

Files:

- create `apps/cli/src/commands/page-diff-legacy.test.ts`
- read only, then later update `apps/cli/src/commands/page.ts`

Tasks:

1. Start the real CLI in a subprocess using
   `--conditions=development`, an isolated temporary home, and a local HTTP
   stub, following `apps/cli/src/commands/export-report-flag.test.ts`.
2. Pin current unified terminal and JSON output for `--version N`.
3. Assert only GET requests occur.
4. Pin invalid/missing `--id` and version error behavior.
5. Pin that stdout contains exactly one JSON document under `--json`.

Verify:

```bash
bun run test apps/cli/src/commands/page-diff-legacy.test.ts
```

Expected: all characterization tests pass before product behavior is changed.

Suggested commit: `test(confluence): characterize page diff CLI`

### WP1 - Create the portable ChangeSet package

Files:

- create `packages/change-set/package.json`
- create `packages/change-set/tsconfig.build.json`
- create `packages/change-set/src/index.ts`
- create `packages/change-set/src/types.ts`
- create `packages/change-set/src/schema.ts`
- create `packages/change-set/src/canonical-json.ts`
- create `packages/change-set/src/digest.ts`
- create corresponding tests
- update `bun.lock`
- update `scripts/check-browser-build.ts`
- update `scripts/api-closure.ts`

Tasks:

1. Define the exact `ChangeSetV1`, operation unions, diagnostics, limits, paths,
   values, and runtime validator.
2. Enforce JSON-only values, resource budgets, closed operation discriminants,
   and stable schema namespace.
3. Implement canonical JSON and SHA-256 digest.
4. Add the package root to `BROWSER_ENTRYPOINTS`; WP2 adds the `./adf`
   entrypoint once it exists.
5. Classify the new package as experimental `0.x` in API-closure policy.
6. Generate and review its API report/closure after build. The update commands
   intentionally write generated contract artifacts; run the non-update commands
   immediately afterwards as the verification pass.

Verify:

```bash
bun run test packages/change-set/src
bun run typecheck
bun run check:browser
bun run build
bun scripts/api-report.ts --update
bun scripts/api-closure.ts --update
bun scripts/api-report.ts
bun scripts/api-closure.ts
```

Expected: focused tests pass; browser check reports no host-only imports; build
and typecheck exit 0; generated API/closure checks match committed reports.

Suggested commit: `feat(changeset): add portable change contract`

### WP2 - Extract the shared ADF core without changing behavior

Files:

- create `packages/change-set/src/adf/`
- move/refactor generic types and validation from
  `packages/confluence/src/adf-types.ts`,
  `packages/confluence/src/adf-validate.ts`, and only the schema-inventory
  portion of `packages/confluence/src/adf-coverage.ts`
- retain compatibility re-export modules or barrel exports in
  `packages/confluence/src/`
- update `packages/confluence/package.json`
- update `packages/jira/package.json` and remove duplicated type ownership only
  when public aliases remain compatible
- update `scripts/adf-drift.ts` and fixture paths only if fixtures move
- update API reports/closure

Tasks:

1. Move the trusted validated-document brand together with `validateAdf()`;
   keep only source-object lookup caching Confluence-local.
2. Add both the package root and `@atlcli/change-set/adf` to
   `BROWSER_ENTRYPOINTS`.
3. Keep all error codes, budgets, known-node checks, and drift diagnostics
   unchanged.
4. Keep `@atlcli/confluence` ADF exports source-compatible through re-export.
5. Keep decoder/DOCX/PDF coverage policy in `@atlcli/confluence`.
6. Use the shared ADF types from Jira rather than maintaining a third shape.
7. Add a migration-chain regression proving
   `validateAdf() -> adfToBlocks() -> collectAdfMediaFileIds()` still accepts the
   same trusted value across package boundaries.
8. Run the complete existing ADF validator/decoder suite before adding new
   canonicalization behavior.

Verify:

```bash
bun run test packages/confluence/src/adf-validate.test.ts \
  packages/confluence/src/adf-direct-fixtures.test.ts \
  packages/confluence/src/adf-to-blocks.test.ts \
  packages/confluence/src/adf-media.test.ts \
  packages/confluence/src/page-body.test.ts
bun run check:adf-pinned
bun run typecheck
bun run check:browser
```

Expected: no existing ADF behavior or public Confluence symbol disappears; all
commands exit 0.

Suggested commit: `refactor(adf): extract shared browser-safe contract`

### WP3 - Add canonical trees, completeness, and bounded matching

Files:

- create `packages/change-set/src/adf/canonicalize.ts`
- create `packages/change-set/src/semantic-tree.ts`
- create `packages/change-set/src/matcher.ts`
- create `packages/change-set/test-fixtures/**`
- create focused unit/golden tests

Tasks:

1. Implement the explicit ADF canonicalization policy.
2. Implement semantic projection with exact/projected/opaque coverage.
3. Implement the bounded conservative matcher and candidate instrumentation.
4. Generate deterministic ChangeSet operation IDs and summaries.
5. Compare source-exact and semantic outcomes so unsupported changes cannot
   vanish.
6. Add ambiguity, truncation, and opaque diagnostics.

Verify:

```bash
bun run test packages/change-set/src
```

Expected: all goldens pass; repeated runs serialize byte-identically; the
ambiguous corpus has zero false-positive moves; every meaning-change case is
non-no-op and every approved noise case is a no-op.

Suggested commit: `feat(changeset): add bounded semantic tree matcher`

### WP4 - Add the Storage source adapter

Files:

- create `packages/confluence/src/storage-change-tree.ts`
- create `packages/confluence/src/storage-change-tree.test.ts`
- extend neutral paired fixtures under
  `packages/confluence/test-fixtures/adf-pairs/`
- add Storage-only change goldens under
  `packages/confluence/test-fixtures/semantic-diff/storage/`

Tasks:

1. Enforce a diff-specific raw-input, node, depth, and decoded-text budget
   before matching; preserve typed `StorageParseError` failure reasons.
2. Project bounded `XmlNode[]` into canonical source and semantic document
   trees without Markdown conversion.
3. Preserve unknown Storage elements and attributes as opaque nodes.
4. Pin the documented Storage noise policy for comments, declarations,
   DOCTYPE/processing instructions, entity spelling, attribute order, and
   illegal controls.
5. Reuse the same semantic vocabulary as the ADF projection.
6. Prove paired ADF/Storage fixtures yield equivalent semantic trees for
   supported features while retaining representation-specific exact trees.
7. Add generated dense-table, deep-nesting, and text-heavy Storage stress cases
   that distinguish parse-budget failure from ChangeSet/render truncation.

Verify:

```bash
bun run test packages/confluence/src/storage-change-tree.test.ts \
  packages/confluence/src/page-body.test.ts
```

Expected: supported paired fixtures match semantically; unknown differences are
visible; all tests pass.

Suggested commit: `feat(confluence): add Storage semantic change adapter`

### WP5 - Add version-bound Cloud/DC acquisition

Files:

- update `packages/confluence/src/client.ts`
- update `packages/confluence/src/page-body.ts` or create
  `packages/confluence/src/page-diff-source.ts`
- create/update focused client tests
- export browser-safe public types only where needed

Tasks:

1. Add an exact-version ADF read using documented REST v2 query parameters.
2. Add a version-specific diff source builder following the existing export
   source policy.
3. Add pairwise one-representation selection.
4. Enforce DC Storage-only routing and context-path behavior.
5. Preserve meta-only logging for all body endpoints.
6. Add stable error classifications for invalid selection and version mismatch.

Verify:

```bash
bun run test packages/confluence/src/client.test.ts \
  packages/confluence/src/page-body.test.ts
bun run check:browser
```

Expected: Cloud stubs receive exact v2/v1 version requests; DC stubs receive no
v2 request; mixed representations are never returned; tests and browser gate
pass.

Suggested commit: `feat(confluence): read version-bound diff sources`

### WP6 - Integrate opt-in CLI and JSON rendering

Files:

- create `packages/confluence/src/render-semantic-diff.ts`
- create `packages/confluence/src/render-semantic-diff.test.ts`
- update `apps/cli/src/index.ts` only to stop a subcommand-local `--version`
  value from triggering the root version banner
- update `apps/cli/src/commands/page.ts`
- create `apps/cli/src/commands/page-diff-semantic.test.ts`
- update built-in help

Tasks:

1. Narrow the global version-banner shortcut to a root-level `atlcli --version`
   invocation; prove `wiki page diff --version N` reaches the page command.
2. Parse `--from`, `--to`, `--format`, the documented `--context` option, and
   command-local `--no-color` fail-closed according to section 5.1 and section
   8.1. `OutputOptions` currently contains only `json`, so do not pretend there
   is a global color policy: pass an explicit renderer option derived from
   `--no-color` and the conventional `NO_COLOR` environment variable. Preserve
   today's colored default when neither is present.
3. Leave legacy unified output behavior unchanged by default once the
   documented subcommand-local `--version` route is made reachable.
4. Orchestrate exact version selection, source acquisition, adapter projection,
   matcher, and renderer in testable pure functions around the IO shell.
5. Emit the versioned ChangeSet JSON envelope exactly once.
6. Add real-process Cloud and DC HTTP-stub tests and assert no non-GET request.

Verify:

```bash
bun run test apps/cli/src/commands/page-diff-legacy.test.ts \
  apps/cli/src/commands/page-diff-semantic.test.ts \
  packages/confluence/src/render-semantic-diff.test.ts
```

Expected: legacy goldens are unchanged; semantic terminal/JSON goldens pass;
invalid flag combinations fail; stdout/stderr boundaries are clean.

Suggested commit: `feat(confluence): add opt-in semantic page version diff`

### WP7 - Prove Jira SafeOps compatibility

Files:

- create `packages/jira/src/change-set.ts`
- create `packages/jira/src/change-set.test.ts`
- update `packages/jira/src/index.browser.ts`
- update `packages/jira/package.json`
- update API reports/closure

Tasks:

1. Map observed issue fields and intended update operations into ChangeSetV1.
2. Preserve replace/set/add/remove/transition intent.
3. Use shared ADF semantics for description changes.
4. Mark unavailable data and unknown custom fields degraded/opaque.
5. Prove the adapter is pure, browser-safe, and makes no HTTP request.

Verify:

```bash
bun run test packages/jira/src/change-set.test.ts
bun run check:browser
bun run typecheck
```

Expected: Jira cases validate against the same ChangeSet schema; no Confluence
or export dependency enters Jira's graph.

Suggested commit: `feat(jira): prove semantic SafeOps change planning`

### WP8 - Run dependency bake-off and performance gates

Files:

- create `scripts/bench/semantic-diff-bakeoff.ts`
- create/update generated stress fixtures
- create `specs/semantic-change-diff-spike/EVIDENCE.md`
- add `jsondiffpatch` as dev-only dependency and update `bun.lock`

Tasks:

1. Run owned matcher and `jsondiffpatch` over identical inputs and goldens.
2. Record `CandidateObservation` correctness, false moves, candidate
   comparisons, p50/p95 wall time, peak RSS, and browser bundle delta.
3. Execute each deterministic corpus twice and compare canonical bytes.
4. Record an explicit keep-owned/adopt-library recommendation without changing
   the runtime matcher in this work package.

Initial gates, measured on a documented machine/CI runner:

- 100% of meaning-change goldens produce at least one operation;
- 100% of approved noise goldens are no-op;
- zero false-positive moves in ambiguity fixtures;
- byte-identical repeated output in Bun and a Node-compatible runtime;
- representative 10k-node ADF and Storage document targets below 250 ms;
- 100k-node / 8 MiB ADF and Storage targets below 2 s and below 256 MiB
  additional RSS;
- calibrated Storage parse budgets reject dense, deeply nested, or text-heavy
  inputs before the matcher budget and with a typed fatal diagnostic;
- no global quadratic matrix and candidate comparisons remain within configured
  budget;
- browser bundle delta for a promoted dependency no greater than 50 KiB
  minified+gzip, measured by an isolated `Bun.build` entry with minification and
  an explicit gzip-size step rather than inferred from `check:browser`.

If existing CI hardware cannot make stable absolute-time assertions, record
hardware and distributions, keep correctness/budget gates blocking, and replace
absolute timing with a reviewed regression ratio. Do not invent a green number.

Verify:

```bash
bun --conditions=development scripts/bench/semantic-diff-bakeoff.ts
bun run check:browser
```

Expected: script exits 0 only when correctness gates pass; evidence contains no
tenant data and records an explicit dependency verdict.

Suggested commit: `test(changeset): add semantic diff bake-off evidence`

### WP10 - Add streaming canonicalization and safe spill execution

Files:

- create `packages/change-set/src/streaming.ts`
- create `packages/change-set/src/streaming.test.ts`
- update ADF and Storage adapters with one-version-at-a-time event projection
- create `apps/cli/src/semantic-diff-spill.ts`
- create `apps/cli/src/semantic-diff-spill.test.ts`
- update `apps/cli/src/commands/page.ts`
- update `scripts/bench/semantic-diff-bakeoff.ts`
- finalize `specs/semantic-change-diff-spike/EVIDENCE.md`

Tasks:

1. Define browser-neutral canonical events, bounded flat records,
   `SpillStoreV1`, and incremental SHA-256 sink ports in the portable package.
2. Project one validated ADF or parsed Storage version directly into records;
   do not first construct and retain both source and semantic trees.
3. Implement the CLI-owned private temporary SQLite store, deterministic
   indexes, ownership marker, and verified cleanup in `finally`.
4. Match parent windows conservatively using the same stable-ID,
   exact-subtree, sequence, position, ambiguity, and completeness rules as the
   reference matcher. Do not introduce a quadratic global matrix.
5. Prove digest and ChangeSet byte parity with the reference path on the full
   small goldset, including moves, ambiguity, opaque changes, and policy noise.
6. Force spill failure/abort/render-error cases and prove no owned temp
   directory remains and no path or body leaks to stdout/stderr/JSON.
7. Switch the CLI deterministically to spill above the calibrated threshold;
   keep small documents on the reference lane.
8. Rerun the isolated 10k and 100k ADF/Storage workers. Both 10k p95 values
   must be below 250 ms; both 100k p95 values below 2 s and additional peak RSS
   below 256 MiB. Treat any red gate as an unfinished spike.

Verify:

```bash
bun run test packages/change-set/src/streaming.test.ts \
  apps/cli/src/semantic-diff-spill.test.ts \
  apps/cli/src/commands/page-diff-semantic.test.ts
bun --conditions=development scripts/bench/semantic-diff-bakeoff.ts
bun run check:browser
bun run typecheck
```

Expected: reference/spill parity is byte-identical on small goldens, all temp
stores are removed on success and failure, and every 10k/100k time/RSS gate is
green on the documented machine.

Suggested commit: `feat(changeset): add streaming semantic diff spill lane`

### WP9 - Documentation, full gates, and live Cloud proof

Files:

- update `src/content/docs/confluence/history.md`
- update `src/content/docs/reference/cli-commands.md`
- update `src/content/docs/jira/bulk-operations.md` with a clearly labeled
  future SafeOps compatibility note only if useful
- finalize `specs/semantic-change-diff-spike/EVIDENCE.md`

Tasks:

1. Document both unified and semantic paths, prerequisites, JSON schema,
   examples, diagnostics, limits, Cloud/DC behavior, and troubleshooting.
2. Correct stale positional-ID and unimplemented-flag examples.
3. Run focused, full, type, browser, package, and docs gates.
4. Run the required Cloud live E2E described below and clean up every resource.
5. Perform staged-diff privacy and scope review before commit.

Verify:

```bash
bun run test packages/change-set/src \
  packages/confluence/src/storage-change-tree.test.ts \
  packages/jira/src/change-set.test.ts \
  apps/cli/src/commands/page-diff-legacy.test.ts \
  apps/cli/src/commands/page-diff-semantic.test.ts
bun run check:adf-pinned
bun run check:browser
bun run typecheck
bun run docs:check
bun run build
bun run test
git diff --check
```

Expected: every command exits 0; full suite has no new skips/failures; docs
compile; worktree changes remain in scope.

Suggested commit: `docs(confluence): document semantic version diffs`

## 13. Offline integration matrix

`apps/cli/src/commands/page-diff-semantic.test.ts` must run the real CLI against
local HTTP stubs and cover:

| Lane | Required proof |
| --- | --- |
| Cloud ADF | Two exact versions requested; same page/version metadata; semantic terminal and JSON outputs |
| Cloud fallback | Versioned ADF capability unavailable after successful Storage read; both sides use Storage; fallback visible |
| Cloud race/error | Version mismatch, malformed ADF, 401/403, 429, and 5xx fail closed; no silent Storage fallback |
| Data Center | Bearer profile and context path; v1 Storage only; zero `/api/v2` requests |
| Legacy | Default unified terminal and JSON outputs unchanged |
| Reverse | `--from 7 --to 3` produces target-directed changes without rejection |
| No-op | Exact equal versions/content yield exit 0 and `noOp: true` |
| JSON hygiene | Exactly one JSON document; no ANSI/log text/raw complete body |
| Read-only | Every observed HTTP method is GET |

## 14. Required Cloud live E2E

Before committing implementation, use profile `mayflower` and space `DOCSY`.
The operator may override the page/title prefix, but not the cleanup and privacy
rules.

Procedure:

1. Create one uniquely named temporary page with synthetic content.
2. Record its initial numeric version outside Git.
3. Apply controlled edits producing at least:
   - text modification;
   - mark-only or link-target change;
   - inserted block;
   - reordered block with a trustworthy identity if the editor/API preserves
     one.
4. Record the resulting numeric versions.
5. Run semantic terminal diff for an adjacent and non-adjacent pair.
6. Run semantic JSON twice for the same pair and compare canonical bytes.
7. Confirm the JSON provenance says Cloud/ADF, or record the explicit common
   Storage fallback if the documented historical ADF request fails.
8. Inspect that every intentional meaning change appears and no ambiguous false
   move is asserted.
9. Run the existing unified diff to prove its path still works.
10. Delete the temporary page and verify cleanup/absence.

The committed evidence may contain only:

- synthetic test title prefix, not the final tenant URL or page ID;
- version numbers if they are not linkable to tenant identity;
- operation classifications/counts;
- digests and timings;
- representation/fallback classification;
- cleanup receipt without private identifiers.

If historical ADF is not available through the documented endpoint, the spike
may still pass using the explicit common-Storage Cloud fallback, but the evidence
must label Cloud ADF version diff as **not live proven**. Do not use private APIs,
UI scraping, browser automation of the native diff screen, or undocumented
collaboration endpoints.

## 15. Scope

### In scope

- new experimental `@atlcli/change-set` package;
- extraction/re-export of generic ADF contracts needed by both Confluence and
  Jira;
- ADF and Storage canonical/semantic adapters;
- bounded conservative matcher and terminal renderer;
- arbitrary page-version source selection;
- opt-in Confluence CLI/JSON integration;
- pure Jira compatibility adapter and tests;
- dependency bake-off, fixtures, docs, and evidence;
- Cloud live E2E and offline DC contract tests.

### Explicitly out of scope

- changing semantic output to the default;
- modifying `wiki docs diff` or sync/merge behavior;
- restoring/publishing pages or applying any ChangeSet;
- Jira bulk command integration, canary execution, checkpointing, compensation,
  or retries;
- persistence, audit databases, approvals, or plan signing;
- browser/extension/Forge UI;
- general cross-parent move, split/merge, or arbitrary tree-edit-distance
  inference;
- full comparison of labels, permissions, restrictions, attachments, or other
  page metadata in this content-version spike;
- Data Center live certification without an operator-supplied environment;
- Tree-sitter, ProseMirror runtime, Atlaskit editor plugins, GumTree runtime,
  or Markdown/MDAST as the canonical model.

## 16. Files expected to change

The executor may create or modify only these areas without returning for plan
revision:

```text
packages/change-set/**
packages/confluence/src/adf-*.ts
packages/confluence/src/page-body*.ts
packages/confluence/src/client.ts
packages/confluence/src/index.browser.ts
packages/confluence/src/internal.ts
packages/confluence/src/storage-change-tree*.ts
packages/confluence/src/export-blocks.ts
packages/confluence/test-fixtures/adf*/**
packages/confluence/package.json
packages/confluence/etc/**
packages/jira/src/change-set*.ts
packages/jira/src/types.ts
packages/jira/src/index.browser.ts
packages/jira/package.json
packages/jira/etc/**
apps/cli/src/commands/page.ts
apps/cli/src/commands/page-diff-*.test.ts
apps/cli/src/index.ts
apps/cli/src/semantic-diff-spill*.ts
scripts/adf-drift.ts
scripts/api-closure.ts
scripts/check-browser-build.ts
scripts/check-browser-build.test.ts
scripts/export-note-codes.test.ts
scripts/bench/semantic-diff-bakeoff.ts
src/content/docs/confluence/history.md
src/content/docs/reference/cli-commands.md
src/content/docs/jira/bulk-operations.md
specs/semantic-change-diff-spike/EVIDENCE.md
bun.lock
```

Generated API report/closure paths for the new package are also in scope. If an
implementation requires changes to export renderers, sync state, mutation
clients, extension/Forge code, or unrelated packages, stop and revise the plan.

## 17. Git workflow

- Branch name when implementation starts: `codex/semantic-change-diff-spike`.
- Use conventional commits shown per work package.
- Treat the per-WP commit labels as the intended history, not permission to
  commit early: create no implementation commit until the relevant Phase B/C
  Cloud live gate, cleanup proof, focused gates, and privacy review pass.
- After that proof, stage and commit the verified tree in the suggested logical
  units without editing behavior between proof and commit.
- Never release automatically.
- Do not push or open a PR until explicitly instructed.
- Before any eventual push, run `bun run typecheck` and all full gates.
- Before each commit, run `git status --short`, `git diff --check`, and inspect
  the staged diff for tenant identifiers, page content, credentials, and private
  evidence.

Drift check before implementation:

```bash
git diff --stat 8b664e33..HEAD -- \
  packages/confluence packages/jira apps/cli/src/commands/page.ts \
  scripts src/content/docs/confluence/history.md
```

If the current diff/source/client seams have changed materially, stop and update
this plan rather than mechanically applying stale steps.

## 18. Done criteria

All boxes must be checked:

- [x] Existing unified `wiki page diff` terminal and JSON goldens are unchanged
      when `--format` is absent.
- [x] `--from`/`--to` work according to the documented compatibility matrix.
- [x] `--format semantic` emits a readable deterministic tree diff.
- [x] `--format semantic --json` emits exactly one valid
      `atlcli.change-set/1` envelope with no ANSI/log contamination.
- [x] Cloud compares two exact same-representation snapshots and records
      ADF/Storage provenance.
- [x] Data Center uses Storage only and performs zero Cloud v2 requests.
- [x] ADF and Storage validation budgets remain enforced.
- [x] No exact source meaning change can disappear as a semantic no-op.
- [x] The ambiguity corpus has zero false-positive moves.
- [x] Large ADF and Storage diffs stream one version at a time through the
      injected spill store instead of retaining four complete trees.
- [x] The CLI spill store is private, ownership-checked, removed on every exit,
      and absent from terminal/JSON/log/evidence output.
- [x] Spill and reference lanes emit byte-identical ChangeSets for the shared
      correctness goldset.
- [x] ADF and Storage satisfy the blocking 10k/100k time and RSS gates.
- [x] Jira field/set/ADF/transition proofs validate against the same ChangeSet
      schema without a Confluence/export dependency.
- [x] `jsondiffpatch` remains dev-only unless a separately reviewed promotion
      decision is recorded.
- [x] Focused, full, typecheck, browser, build, package-contract, and docs gates
      pass.
- [x] Cloud live E2E is recorded and its temporary page is verifiably cleaned.
- [x] DC is labeled `implemented · contract-tested · not project-live-certified`.
- [x] Documentation describes current behavior rather than planned flags.
- [x] No private/live source bodies or identifiers are committed.

## 19. STOP conditions

Stop and report; do not improvise if any of these occurs:

- Historical Cloud ADF requires an undocumented/private endpoint, native UI
  automation, or browser scraping.
- The two bodies cannot be proven to represent the requested exact versions.
- Pairwise acquisition would compare ADF against Storage.
- A malformed/over-budget ADF or authorization/rate-limit/server error would be
  hidden by Storage fallback.
- An unknown/opaque source change is emitted as no-op.
- A move requires ambiguous identity, unbounded fuzzy matching, or a global
  quadratic matrix.
- The neutral package would depend on Confluence, Jira, CLI, export models,
  React, Forge, WXT, DOM, Node, or Bun.
- A spill-store or digest-sink failure would fall back to the retained-tree
  path, leave an owned temp directory behind, or expose a temp path/body.
- Jira would need to import Confluence or `@atlcli/export-blocks`.
- Existing frozen Confluence public symbols would disappear during ADF
  extraction.
- The full source body would enter logs, errors, durable fixtures, or evidence.
- The semantic JSON path emits more than one stdout document or contains ANSI.
- Implementation needs to touch an out-of-scope mutation/apply path.
- A focused verification fails twice after one reasonable correction.
- The Cloud live resource cannot be ownership-checked and safely cleaned up.

## 20. Decisions to revisit while iterating this plan

Recommended defaults are included so implementation is not blocked, but these
are deliberate review points:

1. **Package name**: use `@atlcli/change-set` unless the product vocabulary is
   changed before implementation.
2. **CLI rollout**: keep semantic opt-in via `--format semantic`; do not change
   the default in this spike.
3. **Move policy**: conservative, unique-ID/exact-subtree intra-parent moves
   only.
4. **Cloud fallback**: if versioned ADF is unavailable, use Storage for both
   sides with explicit provenance rather than blocking all Cloud diffs.
5. **Jira depth**: include a pure field/collection/ADF/transition adapter proof,
   but defer bulk-command wiring and execution safety.
6. **Contract stability**: publish as experimental `0.x`; do not freeze
   `atlcli.change-set/1` as a long-term external API until both Confluence and
   Jira real consumers have exercised it.
7. **Metadata scope**: content body only for this spike; labels, restrictions,
   attachments, parent/title, and page properties belong in the next
   Publishing Review plan.
8. **SafeOps boundary**: reserve baseline/plan digest semantics, but require a
   separate plan -> re-read -> review -> canary -> apply -> verify -> compensate
   design before any write consumes this output.

## 21. Maintenance notes and next plan

Reviewers should scrutinize normalization rules more than renderer aesthetics.
Every ignored attribute is a potential hidden change; every fuzzy match is a
potential false move.

After this spike, the next plan should use the proven `ChangeSetV1` for:

- concrete per-issue Jira bulk dry-runs with old -> new values, no-ops,
  inaccessible issues, and stale-baseline detection;
- Confluence Publishing Review across content plus title/parent, labels,
  properties, attachments, restrictions, and links;
- immutable operation plans whose preview and executor share the same digest;
- pre-apply re-read and fail-closed stale-plan rejection;
- canary/apply/verify/compensate workflows and durable receipts.

Those are SafeOps execution features. They are intentionally not claimed by
this read-only semantic diff spike.
