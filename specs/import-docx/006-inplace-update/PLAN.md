# Plan 006: Safely update one previously imported Confluence page in place

Status: **Planned**

Planned at: `18f6f1e`, 2026-07-20

Priority: **P1** · Effort: **XL** · Risk: **HIGH**

Depends on: completed `specs/import-docx-mvp/PLAN.md`

> **Executor instructions:** This is not “overwrite by title”. Preserve page identity/history and block whenever prior AtlCLI ownership, current content, comment anchors, or attachment reconciliation cannot be proven. Record before/after versions and digests, comment/attachment decisions, failure injection, Cloud IDs, and cleanup/restoration in `specs/import-docx/006-inplace-update/EVIDENCE.md`.

---

## 1. Outcome and JTBD

AtlCLI can reimport a changed DOCX into the same single Confluence page created by the MVP while preserving the page ID/URL, version history, labels, restrictions, unrelated attachments, and safely preservable comments. The user sees a semantic diff and every destructive/reanchoring decision before approval. Concurrent or unrecognized target edits block rather than being overwritten.

JTBD: **publish a revised external document to the established wiki URL without manually copying changes or losing the collaboration and governance accumulated on that page**.

Research basis:

- Atlassian's unresolved Cloud request explicitly combines importing into existing pages with heading split and has strong current interest: https://jira.atlassian.com/browse/CONFCLOUD-75154
- A July 2024 user asks to update a Confluence page from a revised Word file; the documented community answer describes the current source/page disconnection: https://community.atlassian.com/forums/Confluence-questions/Update-a-document-in-confluence-with-word-file/qaq-p/2768908
- Data Center's native importer can replace same-title pages while preserving history, demonstrating the workflow demand but not the safety contract: https://confluence.atlassian.com/doc/import-a-word-document-into-confluence-170493136.html
- Users specifically worry about comments when replacing imported content: https://community.atlassian.com/forums/Confluence-questions/Does-Importing-Word-gt-Replace-existing-pages-with-imported/qaq-p/1826288

---

## 2. Scope and staged safety model

In scope for the first release:

- update by explicit page ID only;
- page must carry a valid MVP import provenance/baseline manifest;
- current page body must still match the last imported semantic/body digest, except for explicitly modeled safe target normalization;
- semantic diff preview between old baseline and new planned import;
- optimistic version precondition;
- reconciliation of import-owned assets/comments/properties;
- preservation of labels/restrictions/page ID/history and all non-owned attachments;
- exact failure/partial recovery report;
- Cloud live E2E and DC deterministic contract proof.

Out of scope:

- arbitrary existing pages with no AtlCLI baseline;
- free three-way merge of human-edited Confluence body and revised DOCX;
- update by title, append mode, delete/recreate, or child deletion;
- page-tree update — Plan 009 owns creation only; a later plan must compose tree reconciliation explicitly;
- batch update/synchronization/watchers;
- impersonating/recreating native comments as their original Confluence actors.

---

## 3. Baseline manifest and update plan

Extend the MVP import provenance:

```ts
export interface ImportedPageBaselineV1 {
  schema: "atlcli.docx-page-baseline/1";
  pageId: string;
  deployment: "cloud" | "data-center";
  sourceSha256: string;
  sourceArtifactAttachmentId?: string;
  importPlanDigest: string;
  bodyDigest: string;
  semanticDigest: string;
  importedPageVersion: number;
  assetBindings: Array<{
    sourceAssetId: string;
    attachmentId: string;
    sha256: string;
    remoteFilename: string;
  }>;
  documentCommentBindings: Array<{
    sourceCommentId: string;
    confluenceCommentId: string;
    anchorDigest: string;
  }>;
  provenanceDigest: string;
}

export interface DocxPageUpdatePlanV1 {
  schema: "atlcli.docx-page-update-plan/1";
  targetPageId: string;
  expectedPageVersion: number;
  baselineDigest: string;
  newImportPlanDigest: string;
  bodyDiff: SemanticDiffV1;
  assetActions: UpdateAssetAction[];
  commentActions: UpdateCommentAction[];
  preserved: {
    labels: string[];
    restrictionDigest: string;
    unrelatedAttachmentIds: string[];
    footerCommentIds: string[];
  };
  blockers: ImportIssue[];
  planDigest: string;
}
```

Invariants:

1. Read current page/body/version/properties/comments/attachments/restrictions before planning. Unknown/inaccessible state blocks.
2. Validate baseline/property schema and digest. Never trust an editable visible marker alone for update authority.
3. If current body semantic digest differs from baseline, return `target-diverged`; show a diff but do not mutate. There is no force flag.
4. Build the new content through the unchanged MVP parse/plan/preview path, then derive an update plan. Do not create a second converter.
5. Use optimistic versioning and re-read immediately before the first mutation. A changed version or state invalidates approval.
6. Upload new/changed assets under collision-safe import-owned identities before body update. Never delete or overwrite unrelated attachments.
7. Delete superseded import-owned assets only after new body/comments/baseline readback succeeds; deletion failure leaves an explicit orphan and partial/warning state according to safety policy.
8. Page/footer comments remain. Inline comments require a proven target behavior and exact old-anchor → new-anchor mapping. If a native/user inline comment cannot remain valid without deleting/recreating it, block by default.
9. Imported DOCX comments may be reconciled only through authoritative provenance and authenticated-actor semantics from the MVP; no name matching.
10. Rollback on an existing page means restoring the prior body with a new version plus cleaning newly uploaded import-owned assets/comments. It cannot erase version-history entries and must say so before approval.

Proposed files:

```text
packages/import-docx/src/update/baseline.ts
packages/import-docx/src/update/diff.ts
packages/import-docx/src/update/plan.ts
packages/import-docx/src/update/reconcile-assets.ts
packages/import-docx/src/update/reconcile-comments.ts
packages/confluence/src/import-update-publisher.ts
packages/confluence/src/semantic-readback.ts
apps/cli/src/commands/import.ts
apps/cli/src/commands/import-update.ts
apps/cli/src/commands/import-report.ts
```

---

## 4. CLI/preview contract

```text
atlcli wiki import revised.docx --update-page <page-id> [normal import options]
```

- Mutually exclusive with `--parent`, create-only `--title-conflict`, and any future page-tree/batch mode.
- `--title` may propose a page rename only if separately selected and previewed; default preserves current title.
- Interactive default displays old/new source digest, page version, semantic additions/removals/changes, asset actions, comment actions/blockers, preserved metadata, and rollback limitations.
- Non-TTY still requires `--confirm` or a digest-matched saved update plan.
- No `--force`, `--append`, `--overwrite`, or title-based discovery alias.
- Update planning necessarily reads the existing page. `--update-page --dry-run` therefore requires `--check-target`; the injected port exposes only page/property/comment/attachment/restriction/version reads. Offline dry-run rejects update mode, and checked dry-run remains zero-mutation.

---

## 5. Tasks

### Task 0 — Prove target update/comment/attachment contracts

- [ ] Probe Cloud page version/update/readback, property versioning, attachment version/delete, inline/footer comment persistence, and restriction/label preservation in DOCSY.
- [ ] Encode DC REST v1/Storage equivalents and context-path behavior in the deterministic contract server.
- [ ] Determine exact failure order and which operations are reversible; document unavoidable history/orphan effects.

Acceptance:

- [ ] If native inline comments cannot be safely preserved/reanchored through public APIs, the default blocker is documented and tested.
- [ ] No capability is inferred from UI behavior alone.

### Task 1 — Strengthen baseline provenance

- [ ] Write/read/validate `ImportedPageBaselineV1` during normal MVP creation without changing create semantics.
- [ ] Include exact imported asset/comment bindings and target version.
- [ ] Add recovery from bounded page manifest only where authoritative property support is unavailable; visible marker alone is insufficient.

Acceptance/tests:

- [ ] Missing, malformed, stale, conflicting, copied-to-another-page, and body-diverged baselines block update.
- [ ] Baseline never stores credentials, source bytes, emails, or raw tenant responses.

### Task 2 — Implement semantic diff and reconciliation planning

- [ ] Diff target-neutral projections with stable node/source IDs where available and deterministic fallback matching.
- [ ] Plan reuse/upload/retire actions by digest and ownership.
- [ ] Plan comment preserve/reanchor/recreate/block outcomes with exact reason codes.
- [ ] Bind current version/state/baseline/new plan/diff/actions into approval digest.

Acceptance/tests:

- [ ] Golden diffs cover text, heading, list, table, link, image, comment, source attachment, and metadata changes.
- [ ] Reordering/duplicate text does not cause non-deterministic matching.
- [ ] Human edits and unknown attachments/comments are never classified as import-owned.

### Task 3 — Implement existing-page transaction

- [ ] Re-read version/state before mutation.
- [ ] Upload new assets, update body with version precondition, reconcile imported comments/provenance, verify semantics/metadata, then retire old import-owned resources.
- [ ] On failure, restore prior body through a new version and clean only resources created by this run.
- [ ] Report `updated`, `restored`, or `partial`; never `rolled-back` as if history were erased.

Acceptance/tests:

- [ ] Failure injection at every step proves exact surviving state/IDs.
- [ ] Concurrent edit yields zero overwrite.
- [ ] Unknown attachment/comment/label/restriction survives.
- [ ] Cleanup never selects by title/filename alone.

### Task 4 — CLI, Cloud E2E, DC contracts, docs

- [ ] Add flags/help/saved-update-plan schema and JSON report.
- [ ] Require `--check-target` for update dry-run and prove the read-only port has no mutation methods/paths.
- [ ] DOCSY E2E: create through MVP, update with changed DOCX, assert same page ID/new version/history, preserved labels/restrictions/footer comment, exact assets/provenance, and cleanup.
- [ ] Add divergence, concurrent edit, inline-comment blocker/preserve, asset failure, restore, and partial scenarios.
- [ ] Run corresponding DC contract suite and document no maintainer live certification.

---

## 6. Verification gates

```bash
bun install --frozen-lockfile
bun test packages/import-docx packages/confluence packages/docx apps/cli
bun run typecheck
bun run build
bun run docs:check
bun run docs:build
git diff --check
```

---

## 7. Definition of Done

- [ ] Only a valid, unchanged, previously imported single page can be updated.
- [ ] Page ID/URL, version history, labels, restrictions, unrelated attachments, and safely preservable comments survive.
- [ ] Diff/actions/rollback limitations are previewed and digest-bound.
- [ ] Concurrency/divergence never causes overwrite.
- [ ] Failure recovery is exact about history and partial state.
- [ ] Cloud live E2E and DC contract evidence pass.
- [ ] `specs/import-docx/006-inplace-update/EVIDENCE.md` is complete.

## 8. STOP conditions

STOP if reliable baseline ownership cannot be established, update requires name-based discovery, public APIs cannot preserve required metadata/comments, rollback would overwrite a concurrent actor, or implementation expands into arbitrary three-way merge/page-tree synchronization.

## 9. DAG

This single-page update plan runs in parallel with Plans 002–005 and 007–008 after MVP. It intentionally does not block or depend on Plans 009/010. Page-tree/batch updates require a future composition plan.
