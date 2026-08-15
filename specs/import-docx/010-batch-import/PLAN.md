# Plan 010: Import DOCX batches and folder trees with checkpoints and resume

Status: **Implemented (Cloud full form: manifest, hierarchy, checkpoint/resume; ZIP/cross-file-links/concurrency residuals open)** — evidence in specs/import-docx-mvp/EVIDENCE.md

Planned at: `18f6f1e`, 2026-07-20

Priority: **P0** · Effort: **XL** · Risk: **HIGH**

Depends on:

- completed `specs/import-docx-mvp/PLAN.md`;
- completed `specs/import-docx/003-editability-budgets/PLAN.md` editability/budget contract;
- completed `specs/import-docx/005-destination-governance/PLAN.md` governance/staging contract;
- completed `specs/import-docx/009-page-tree-split/PLAN.md` file-to-subtree contract.

> **Executor instructions:** A batch is a resumable set of independently auditable document-subtree transactions, not one opaque “import everything” call. Plan all inputs and hierarchy before writes, persist checkpoints atomically without secrets, and verify remote state before skipping work on resume. Record manifests/state digests, per-item IDs/results, failure/retry evidence, Cloud cleanup, and DC contract output in `specs/import-docx/010-batch-import/EVIDENCE.md`.

---

## 1. Outcome and JTBD

AtlCLI imports multiple DOCX files or a directory/ZIP hierarchy into a governed Confluence staging tree. Each file can become one page or a Plan 009 subtree. The user reviews an aggregate plan, follows per-file progress, receives exact success/failure/skipped results, and can safely resume without duplicating verified content.

JTBD: **migrate hundreds or thousands of documents as native Confluence content while preserving hierarchy and links, isolating failures, and continuing after interruption instead of restarting or manually tracking progress**.

Research basis:

- A January 2026 user reports a 500+ DOCX Cloud migration and large manual cleanup: https://community.atlassian.com/forums/Confluence-questions/Confluence-Cloud-Not-Datacenter-Enhanced-flexible-version-of/qaq-p/3176430
- A long-running user request discusses 2,000+ Word files: https://community.atlassian.com/forums/Confluence-questions/Is-there-a-way-to-import-multiple-Word-documents-as-a-bulk/qaq-p/873020
- Native Cloud currently accepts up to 30 files/50 MB and places results under a restricted “Imported pages” container: https://support.atlassian.com/confluence-cloud/docs/import-content-into-confluence-cloud/
- NGPILOT advertises ZIP/folder hierarchy, batch processing, progress, per-file results, and conflict handling: https://marketplace.atlassian.com/apps/977066696/modern-importer-exporter-for-confluence
- Narva advertises folder/bulk import but warns DOCX fidelity varies and embedded images are unsupported: https://marketplace.atlassian.com/apps/1221333/all-in-one-file-importer-for-confluence

Marketplace claims demonstrate workflow expectations, not AtlCLI accuracy evidence.

---

## 2. Scope

In scope:

- explicit file list, directory root, or safe outer ZIP;
- versioned batch manifest with per-source options, target relative hierarchy, labels/governance, and optional split level;
- directory hierarchy preservation and one-file → one page/subtree composition;
- safe relative cross-file DOCX/bookmark links within the manifest;
- aggregate dry-run/HTML preview and resource estimates;
- private staging root by default where Plan 005 proves it;
- bounded parsing/planning concurrency and separately bounded mutation concurrency;
- atomic local checkpoint/state, resume verification, retry failed items only;
- per-document transaction/rollback, aggregate result, and support bundle;
- Cloud DOCSY E2E and DC deterministic contract proof.

Out of scope:

- background daemon, watch folder, scheduled sync, OneDrive/SharePoint/Google Drive;
- `.doc`, PDF, ODT, XLSX, Markdown, or mixed-format batches;
- updating existing pages/batches;
- cross-site/profile migration in one batch;
- atomic rollback of already verified successful documents by default;
- hiding partial success behind exit 0.

---

## 3. Batch manifest and state

```ts
export interface DocxBatchManifestV1 {
  schema: "atlcli.docx-batch-manifest/1";
  batchId: string;
  destination: {
    spaceKey: string;
    parentId?: string;
    staging: "private" | "none";
    governance: DestinationGovernancePlanV1;
  };
  defaults: {
    splitHeading?: 1 | 2 | 3 | 4 | 5 | 6;
    titleConflict: "fail" | "rename";
    recipe?: string;
  };
  documents: Array<{
    sourcePath: string;
    relativeParentPath?: string;
    title?: string;
    splitHeading?: 1 | 2 | 3 | 4 | 5 | 6;
    labels?: string[];
  }>;
}

export interface DocxBatchStateV1 {
  schema: "atlcli.docx-batch-state/1";
  batchId: string;
  manifestDigest: string;
  capabilitiesDigest: string;
  stagingRootId?: string;
  items: Array<{
    itemId: string;
    sourceSha256: string;
    planDigest: string;
    status: "planned" | "shells-created" | "complete" | "failed" | "rolled-back" | "partial";
    pageIds: string[];
    verifiedSemanticDigests: string[];
    lastErrorCode?: string;
  }>;
  stateDigest: string;
}
```

Invariants:

1. Source paths are relative to an explicit root and canonicalized. Default directory traversal does not follow symlinks. Outer ZIP rejects traversal, duplicate normalized names, links, encryption, overlap, unsupported compression, and size/count/ratio budget violations before extraction.
2. Plan every file/subtree/title/hierarchy/link/budget/governance decision before remote mutation. Aggregate approval digest covers the ordered item plans.
   Offline dry-run may leave target collision/effective-access evidence explicitly unchecked and non-publishable; `--check-target` or a normal approval path resolves it through read-only ports before a replayable batch plan exists.
3. Stable `itemId` derives from manifest-relative path plus source digest, not only filename/title.
4. Persist checkpoint atomically after every returned remote ID/state transition. State contains no credentials, auth headers, source bytes, raw bodies, signed URLs, or absolute paths by default.
5. On resume, re-read and semantically verify every `complete` item's page IDs, ownership properties, hierarchy, and digest. Only then skip it. Missing/diverged state blocks or requires an explicit repair plan; it never duplicates blindly.
6. Default atomicity is per document subtree. A failed item rolls back its owned pages; already verified completed items remain under private staging. Overall status/exit is partial/non-zero until all intended items complete.
7. Default failure scheduling is `stop`: stop starting new items after the first failure, finish/rollback active bounded work, checkpoint, and allow resume. Explicit `continue` may process independent items and still exits non-zero if any fail.
8. Parsing/planning may run concurrently with deterministic result order. Mutation concurrency defaults to 1 and is bounded/rate-limit aware; retries are only for proven idempotent reads/uploads, never blind page creation.
9. Cross-file relative links resolve only among manifest-listed sources and bookmarks. External/unlisted paths are reported or retained as safe literal links; the importer never reads arbitrary neighboring files because a DOCX references them.
10. A private staging root uses Plan 005 and remains restricted after successful import until an explicit later publish/reorganize action. Batch import completion does not silently broaden access.

Proposed files:

```text
packages/import-docx/src/batch/manifest.ts
packages/import-docx/src/batch/discovery.ts
packages/import-docx/src/batch/outer-zip.ts
packages/import-docx/src/batch/plan.ts
packages/import-docx/src/batch/links.ts
packages/import-docx/src/batch/state.ts
packages/import-docx/src/batch/report.ts
packages/confluence/src/batch-publisher.ts
apps/cli/src/commands/import-batch.ts
apps/cli/src/commands/import-batch-state.ts
```

---

## 4. CLI and review UX

Canonical forms:

```text
atlcli wiki import-batch --manifest imports.yaml [options]
atlcli wiki import-batch --directory ./docs --space DOCSY [options]
atlcli wiki import-batch --archive ./docs.zip --space DOCSY [options]

--staging <private|none>      default private
--failure <stop|continue>     default stop
--concurrency <n>             bounded; default 1 for mutations
--state <path>                required for publication; atomic checkpoint
--resume <state-path>         revalidate and continue
--retry-failed                resume failed items only after revalidation
--check-target               allow read-only target checks during --dry-run
```

Before final syntax, inspect the implemented `wiki import` command family and choose one canonical nesting; do not add redundant aliases.

Aggregate preview includes:

- input root/manifest digest and source counts/bytes;
- future page tree grouped by directory/document/subtree;
- resolved titles/conflicts and cross-file links;
- per-item and aggregate editability/resource estimates;
- governance/staging/effective visibility;
- estimated page/attachment/comment/API-operation counts;
- blockers/warnings by file/page/node with filters;
- checkpoint path and per-document atomicity/failure behavior.

Default dry-run is fully offline and cannot write a replayable batch plan. Checked dry-run may read capabilities, titles, principals, and existing ownership markers but its typed port exposes no mutations. Resume always performs required read-only remote verification before any new write.

---

## 5. Execution model

```text
discover/validate all inputs
 -> acquire/hash/preflight all DOCX files
 -> plan each file/subtree (bounded parallel, stable order)
 -> resolve global hierarchy/titles/cross-file links/budgets
 -> render aggregate preview
 -> approve exact batch digest
 -> create/restrict staging root?
 -> for each item in deterministic schedule:
      create subtree shells -> checkpoint IDs
      finalize assets/bodies/links/comments/provenance
      readback verify -> checkpoint complete
      on failure: rollback item -> checkpoint failed/rolled-back
 -> aggregate verification/report
```

Cross-file link publication may require shells for multiple items before finalization. If so, retain per-item ownership/state and do not mark an item complete until all inbound/outbound links read back. A failure in a referenced item yields an explicit unresolved dependency and blocks completion of dependents; it does not silently leave a broken link.

---

## 6. Tasks

### Task 0 — Corpus, limits, and recovery model

- [ ] Build directory/ZIP fixtures with nested folders, duplicate names, Unicode/case variants, symlinks, cross-file links/bookmarks, mixed split modes, empty docs, unsafe DOCX, outer ZIP attacks, large batches, and injected failures.
- [ ] Set safe default file/page/byte/depth/concurrency/checkpoint limits independently from native Cloud's 30-file UI limit.
- [ ] Document rate-limit/retry/idempotency and staging restriction contracts.

Acceptance:

- [ ] Every fixture has expected discovery/order/hierarchy/link/outcome.
- [ ] No limit is copied from native UI without API/benchmark evidence.

### Task 1 — Safe discovery and manifest validation

- [x] Implement strict schema/canonicalization, relative-root resolution, no-follow symlink policy, deterministic ordering, and safe outer ZIP inspection/extraction. *(Manifest schema hardened + canonical digest; sourcePath traversal rejected; ZIP source still open.)*
- [x] Reject duplicate normalized paths/item IDs/title-map conflicts before parsing/publication.
- [x] Acquire/hash/preflight every DOCX through the baseline safety pipeline.

Acceptance/tests:

- [ ] Traversal, symlink escape, duplicate Unicode-normalized names, encrypted/overlap/bomb ZIP, huge counts/depth, and non-DOCX entries fail predictably.
- [ ] Directory and equivalent ZIP produce the same canonical discovery digest.

### Task 2 — Compose global batch plan

- [x] Invoke the Plan 009 file-to-subtree planner for each item; `splitHeading` absent uses its one-page/root contract.
- [x] Apply Plan 003 budgets and Plan 005 governance without copying their logic. *(Editability in preview; staging root via the plan-005 restriction path; defaults.recipe resolves through the plan-007 policy chain incl. comment mode.)*
- [x] Resolve directory parent nodes, whole-batch titles, and relative cross-file links. *(Folder pages + per-item title policy; cross-FILE links still open — cross-page links within one document ship via plan 009.)*
- [ ] Produce aggregate preview/report/plan digest with file→page→node/asset issue locations.

Acceptance/tests:

- [ ] Bounded concurrency does not change order/digests.
- [ ] Every input block/page/link has exactly one outcome/owner.
- [ ] Any source/options/recipe/capability/destination/collision/governance change stales saved approval.
- [ ] Offline versus checked dry-run follows the MVP contract; unchecked target/governance state cannot be approved, checkpointed as publishable, or replayed directly.

### Task 3 — Atomic checkpoint and resume engine

- [x] Implement safe atomic state writes, schema/digest validation, permissions, symlink defense, and transition rules. *(tmp+rename after every item; schema/batchId/manifest-digest validation on load.)*
- [x] Checkpoint immediately after every remote ID and verification result. *(Staging root, each folder page, and each item checkpoint separately.)*
- [x] On resume, validate manifest/capability/source and read back remote ownership/semantics before skipping/retrying. *(Manifest digest + source sha + remote status/current + body-digest readback; live-proven incl. the trashed-page case.)*

Acceptance/tests:

- [ ] Kill/interrupt simulation after every transition resumes without duplicate pages.
- [x] Tampered/truncated/stale/wrong-site state blocks before mutation. *(Schema/batch/manifest-digest mismatches block; unit-tested.)*
- [x] Missing/diverged remote page is never silently recreated over an unrelated title. *(Re-import runs the normal title preflight; live: deleted item recreated cleanly, others untouched.)*

### Task 4 — Batch publisher, failure scheduling, and cross-file links

- [x] Create/restrict/read back staging root.
- [ ] Execute item subtrees with bounded mutation concurrency and deterministic events.
- [ ] Coordinate shell ID maps for cross-file links and completion dependencies.
- [x] Roll back failed item resources only; retain verified items under staging and report partial state.
- [ ] Implement `stop|continue` and retry only proven operations/items.

Acceptance/tests:

- [ ] Failure injection covers staging, every item state, link dependency, rate limit, interruption, cleanup, and checkpoint write failure.
- [ ] `stop` starts no new item after failure; `continue` never masks aggregate non-zero status.
- [ ] Resume/retry changes only failed/incomplete items after verification.

### Task 5 — CLI progress, reports, support bundle, docs

- [ ] Emit stable structured progress to stderr and exactly one aggregate JSON document to stdout.
- [ ] Report per-item status/page IDs/URLs/issues/timings and aggregate counts; redact absolute paths unless explicitly requested.
- [ ] Produce an optional redacted support bundle containing manifest/state schemas, digests, issue codes, capabilities, and timings but no document bytes/bodies/secrets.
- [ ] Add help, minimal/realistic manifests, recovery/troubleshooting, staging/publishing guidance.

### Task 6 — Cloud DOCSY E2E and DC contract proof

- [ ] Built CLI imports at least five documents with nested directories, one page subtree, cross-file link, duplicate title rename, images/comments, and private staging into DOCSY.
- [ ] Inject one item failure, prove checkpoint/partial state, fix/resume, verify no duplicates and all links, then delete every created resource in `finally`.
- [ ] Repeat all transport/state/failure semantics against DC contract server with root/context path variants.
- [ ] Keep DC label `implemented · contract-tested · not project-live-certified`.

---

## 7. E2E proof matrix

- [ ] directory and outer ZIP equivalent import plans;
- [ ] manifest override and per-document split;
- [ ] private staging/effective restriction readback;
- [ ] 1:1 file page plus file subtree composition;
- [ ] cross-file bookmark/link success and failed dependency;
- [ ] title conflicts across target, directory siblings, and split nodes;
- [ ] interruption after each checkpoint transition and safe resume;
- [ ] `stop`, `continue`, `retry-failed`, state tamper, remote divergence;
- [ ] final aggregate readback and complete cleanup.

---

## 8. Verification gates

```bash
bun install --frozen-lockfile
bun test packages/import-docx packages/confluence apps/cli
bun run typecheck
bun run build
bun run check:browser
bun run docs:check
bun run docs:build
git diff --check
```

Large-corpus benchmarks run with explicit fixture/threshold commands recorded in evidence; they must not target production tenant content.

---

## 9. Definition of Done

- [ ] Directory/ZIP/manifest inputs produce deterministic safe batch plans.
- [ ] File/directory/page hierarchy and cross-file links are preserved or explicitly blocked/reported.
- [ ] Private staging and destination governance are proven before final bodies.
- [ ] Checkpoint/resume never skips unverified state or duplicates content.
- [ ] Per-document rollback and aggregate partial status are exact.
- [ ] Cloud failure/resume E2E cleans every resource; DC full contract suite passes.
- [ ] `specs/import-docx/010-batch-import/EVIDENCE.md` is complete.

## 10. STOP conditions

STOP if safe discovery requires following symlinks, cross-file links require reading outside the manifest, resume cannot prove remote ownership/state, checkpoints would contain secrets/source bodies, rate-limit behavior makes creation retry unsafe, private staging cannot be applied before content, or implementation expands into continuous sync/update.

## 11. DAG

This is the convergence plan. It starts only after Plans 003, 005, and 009. Plans 004, 006, 007, and 008 remain optional orthogonal capabilities and must not become hidden prerequisites. The MVP remains the baseline for all types, safety, preview, approval, target encoders, and evidence labels.
