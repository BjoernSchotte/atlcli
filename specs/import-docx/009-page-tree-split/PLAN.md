# Plan 009: Split one DOCX into a navigable Confluence page tree

Status: **Implemented (Cloud full form, comment/saved-plan residuals open)** — evidence in specs/import-docx-mvp/EVIDENCE.md

Planned at: `18f6f1e`, 2026-07-20

Priority: **P0** · Effort: **XL** · Risk: **HIGH**

Depends on:

- completed `specs/import-docx-mvp/PLAN.md`;
- completed `specs/import-docx/002-heading-numbering/PLAN.md` heading-title projection;
- completed `specs/import-docx/003-editability-budgets/PLAN.md` editability assessment.

Unblocks: `specs/import-docx/010-batch-import/PLAN.md`

> **Executor instructions:** This plan turns one approved publication into a multi-page transaction. Resolve the complete tree, titles, cross-references, page ownership, comments, assets, and rollback before the first write. Record outline/plan digests, created IDs/parent relationships, link targets, failure injection, Cloud evidence, and cleanup in `specs/import-docx/009-page-tree-split/EVIDENCE.md`.

---

## 1. Outcome and JTBD

A user can split one long DOCX at Word heading levels into a reviewed Confluence parent/child tree. The preview shows the exact future hierarchy, resolved titles, content/asset/comment placement, editability assessment, and link rewrites. Publication creates shells to obtain IDs, finalizes every page deterministically, verifies the whole tree, and rolls back every import-owned page on failure by default.

JTBD: **turn a long handbook/specification into a navigable, editable wiki hierarchy without manually splitting Word files or losing bookmarks and cross-references**.

Research basis:

- The strongest current signal is Atlassian's unresolved Cloud issue for heading split/import into existing pages: 260 votes, 162 watchers, 50 support references as of 2026-07-08: https://jira.atlassian.com/browse/CONFCLOUD-75154
- A February 2026 user describes 100+ pages, forced 30-page chunks, broken hierarchy, and lost cross-references: https://community.atlassian.com/forums/Confluence-questions/Imported-Word-document-becomes-a-single-pag-how-to-split-by/qaq-p/3198194
- Another Cloud suggestion remains active: https://jira.atlassian.com/browse/CONFCLOUD-73722
- Data Center natively shows a Document Outline and creates heading-based hierarchies: https://confluence.atlassian.com/doc/import-a-word-document-into-confluence-170493136.html
- Canary and Aptify advertise heading-based page hierarchies: https://marketplace.atlassian.com/apps/3691041528/word-importer-for-confluence and https://marketplace.atlassian.com/apps/631785764/advanced-word-importer-for-confluence

---

## 2. Scope

In scope:

- split at maximum heading level 1–6;
- stable root page plus child hierarchy and preamble handling;
- numbered-heading titles from Plan 002;
- whole-tree title conflict preflight using MVP `fail|rename`;
- bookmark/`REF`/`PAGEREF` and safe relative link rewriting across created pages;
- deterministic block, note, comment, asset, source-original, and provenance ownership;
- per-page editability metrics from Plan 003;
- multi-page shell/finalize/readback/rollback state machine;
- terminal/HTML/JSON outline and saved-tree plan;
- Cloud live E2E and DC deterministic contract proof.

Out of scope:

- splitting by visual pagination, arbitrary layout, AI, or inferred topic boundaries;
- batch/multiple source documents — Plan 010;
- updating an existing page tree;
- deleting/replacing existing pages or children;
- browser-extension UI;
- arbitrary reparenting after import.

---

## 3. Deterministic split semantics

For `--split-heading N`:

1. Always create one root page using the requested import title. Content before the first split heading belongs to the root.
2. Headings with levels `1..N` create page nodes. A page's parent is the nearest preceding split heading with a lower level; otherwise the root.
3. A heading's own visible title is represented by the page title and is not duplicated as the first body heading by default. Its source ID/level/numbering remains in provenance and preview.
4. Headings deeper than `N` remain headings inside the current page.
5. Skipped levels attach to the nearest valid ancestor and emit `page-tree-heading-level-gap`; strict mode may block.
6. Empty heading sections still create a page only when explicitly allowed; default emits `page-tree-empty-section` and keeps the heading in its ancestor body unless the user overrides that node.
7. Footnotes/endnotes belong to the page containing their reference; repeated note references may duplicate a generated note entry with provenance or point to a root notes page only if link/readback proof supports it.
8. A comment fully contained in one page follows normal inline/footer policy. A range crossing page boundaries cannot be represented inline; it becomes a root/page-level imported comment with exact source attribution/range description and `comment-crosses-page-boundary`, or blocks under strict inline mode.
9. The original DOCX attachment, when requested, belongs to the root page. `footer|comment` source reference appears only on the root unless a future explicit option says otherwise.

---

## 4. Page-tree contract

```ts
export interface DocxPageTreePlanV1 {
  schema: "atlcli.docx-page-tree-plan/1";
  sourceDigest: string;
  split: { maxHeadingLevel: 1 | 2 | 3 | 4 | 5 | 6 };
  rootNodeId: string;
  nodes: PageTreeNodePlanV1[];
  links: PageTreeLinkPlanV1[];
  assets: PageTreeAssetBindingV1[];
  comments: PageTreeCommentBindingV1[];
  issues: ImportIssue[];
  capabilitiesDigest: string;
  treeDigest: string;
}

export interface PageTreeNodePlanV1 {
  nodeId: string;
  sourceHeadingId?: string;
  parentNodeId?: string;
  order: number;
  requestedTitle: string;
  titleResolution: ResolvedTitlePlanV1;
  bodyDigest: string;
  semanticDigest: string;
  editability: EditabilityAssessmentV1;
  blockIds: string[];
}

export type PageTreeLinkPlanV1 = {
  sourceNodeId: string;
  sourceLinkId: string;
  targetNodeId: string;
  targetBookmarkId?: string;
  fallback: "none" | "reported-text";
};
```

Invariants:

- Plan nodes use stable source-derived IDs; no remote IDs exist before mutation.
- Resolve every target title as one set against existing target content and intra-tree duplicates. `rename` is deterministic and previewed; collision race after approval rolls back rather than replanning.
- Offline `--dry-run` resolves intra-tree duplicates only and marks target availability unchecked/non-publishable exactly as the MVP. `--dry-run --check-target`, normal interactive review, `--confirm`, and saved-plan replay use the bounded read-only lookup. A replayable tree plan requires checked target titles.
- Build one source-block → page-node map and one bookmark → `{pageNode, anchor}` map. Encoders consume typed page/link intents; they do not parse URLs.
- Assets attach to every page that embeds them unless a proven cross-page media contract is explicitly selected. Deduplicate within a page by digest, never across permission boundaries by assumption.
- Create all page shells in deterministic parent-before-child order to obtain IDs. Rewrite/finalize bodies only after required IDs exist.
- Finalize/read back children and root in deterministic order; rollback deletes returned IDs in reverse child-before-parent order.
- Whole-tree success requires every node, hierarchy edge, required asset/comment/property, and link digest to verify. Partial success is never labeled complete.
- Saved-tree replay rebuilds from source/options/overrides/capabilities/current collision set and compares every digest before mutation.

Proposed files:

```text
packages/import-docx/src/page-tree/model.ts
packages/import-docx/src/page-tree/split.ts
packages/import-docx/src/page-tree/titles.ts
packages/import-docx/src/page-tree/links.ts
packages/import-docx/src/page-tree/assets.ts
packages/import-docx/src/page-tree/comments.ts
packages/import-docx/src/page-tree/preview.ts
packages/confluence/src/page-tree-publisher.ts
packages/confluence/src/semantic-readback.ts
apps/cli/src/commands/import.ts
apps/cli/src/commands/import-report.ts
```

---

## 5. CLI and review UX

```text
--split-heading <1..6>      create root + pages through this heading level
--empty-sections <mode>     keep|page|fail (default keep)
```

Preview includes:

- collapsible page tree with source heading/number, requested/resolved title, conflict outcome, block/asset/comment counts, and editability classification;
- cross-page link map and unresolved links;
- root-only original attachment/reference;
- exact number of pages/attachments/comments/API mutations;
- rollback scope and warning that `--keep-failed-page` may leave a partial tree with all IDs reported.

Direct `--confirm` skips detailed rendering only; it still constructs and validates the whole tree. The prompt becomes `Import this 14-page tree? [y/N]`.

Default `--dry-run` remains fetch-free. `--check-target` retains the MVP meaning: bounded read-only capability/title checks, zero mutation, and a checked plan eligible for `--plan-out`.

---

## 6. Publication state machine

```text
planned
 -> approved
 -> root-shell-created
 -> descendant-shells-created (parent before child)
 -> root-source-artifact-uploaded?
 -> per-page-assets-uploaded
 -> per-page-bodies-finalized (IDs rewritten)
 -> per-page-comments/provenance/labels-created
 -> tree-readback-verified
 -> complete

failure after first shell
 -> reverse-order cleanup of comments/assets/pages owned by run
 -> rolled-back | partial
```

No page is mutated through existing-page update APIs. A shell contains only an import marker until its intended parent relation and any required governance have been established.

---

## 7. Tasks

### Task 0 — Corpus and contract decisions

- [x] Create documents with preamble, H1–H6, skipped/repeated/empty headings, numbered headings, duplicate titles, bookmarks/REF/PAGEREF/hyperlinks, notes, shared images, comments within/across boundaries, revisions, and source attachment. *(As unit/E2E fixtures; comment-across-boundary waits for comment import.)*
- [ ] Document Cloud/DC anchor/page-link/title/hierarchy readback behavior and exact error cases.
- [ ] Add adversarial fixtures for huge/deep trees and collision races.

Acceptance:

- [ ] Every source block/asset/comment/bookmark has an expected owner/outcome.
- [ ] Maximum nodes/depth/title/link budgets are explicit before implementation.

### Task 1 — Pure split and ownership planner

- [x] Implement split semantics and stable node IDs in a single deterministic document-order traversal.
- [x] Consume Plan 002 heading-title projection and Plan 003 assessment; do not duplicate either algorithm.
- [x] Build block/note/comment/asset ownership maps and issue codes. *(Blocks/assets/bookmarks/comments — anchored comments land on the page owning their range-start block, unanchored on the root; live-proven.)*

Acceptance/tests:

- [x] Golden/property tests prove no block is lost/duplicated, page order/parents are stable, empty/gap policies work, and budgets prevent pathological trees. *(Unit tests for split/gap/empty/rename/bookmarks; explicit tree budgets still open.)*
- [ ] Node/Bun/browser tree digests match.

### Task 2 — Titles and cross-page links

- [x] Resolve whole-tree title conflicts, including intra-tree duplicates, before approval.
- [x] Map bookmarks and fields to page/anchor intents and rewrite only after remote IDs exist. *(Hyperlink anchors + fldSimple REF/PAGEREF; two-phase shells-then-finalize.)*
- [x] Preserve external/safe links and report unresolved/ambiguous targets. *(Unresolved anchors render as plain text.)*

Acceptance/tests:

- [x] Duplicate title fixtures prove deterministic `fail|rename` and no title-based deletion.
- [x] Every cross-page link readback points to the expected page ID/anchor; unresolved links never silently point to the root. *(Live: both refs on Alpha read back pointing at the Gamma page URL.)*
- [ ] Post-approval conflict race causes rollback and fresh-review instruction.

### Task 3 — Multi-page planning/preview/saved plan

- [ ] Add `DocxPageTreePlanV1`, canonical serialization, digest, report, terminal/HTML outline, and saved-plan replay.
- [ ] Compute per-page target body/projection/editability metrics from one source plan.
- [ ] Keep all bytes/functions/credentials/remote IDs out of serialized plans.

Acceptance/tests:

- [ ] Preview node/body/link counts exactly match publisher input.
- [ ] Source/options/heading numbering/threshold/capability/collision changes stale the plan.
- [ ] Offline dry-run is non-publishable and fetch-free; checked dry-run exposes no mutation methods and resolves the full target collision set.

### Task 4 — Page-tree publisher and recovery

- [x] Add typed page-tree port; create shells parent-before-child and track IDs immediately.
- [ ] Upload root source artifact and page-owned content assets.
- [x] Finalize bodies with page-ID link map; create comments/provenance/labels; verify full hierarchy/semantics. *(Bodies + links + per-page verify + per-page comment placement.)*
- [x] Roll back reverse-order by owned IDs with failure injection at every transition. *(Reverse-order rollback shipped since the slice; formal per-transition injection suite still open.)*

Acceptance/tests:

- [x] No final body is written until all IDs required by its links exist.
- [ ] Failure/interrupt/race tests leave zero resources by default or exact partial IDs with `--keep-failed-page`/cleanup failure.
- [ ] Readback detects missing child, wrong parent, broken link, missing asset/comment, and core semantic mismatch.

### Task 5 — CLI, Cloud DOCSY E2E, DC contracts, docs

- [ ] Add flags/help/examples and feature matrix.
- [ ] Built CLI dry-run/save/replay/imports a feature tree into DOCSY, verifies all nodes/links/assets/comments/source attachment, exports/reimports representative pages, and cleans all resources.
- [ ] Add injected-failure live cases bounded to safe fixture size.
- [ ] Run full DC contract suite with context paths and exact evidence label.

---

## 8. E2E proof matrix

- [ ] H1/H2/H3 tree with numbered titles and preamble root.
- [ ] Duplicate headings plus existing target conflict under `fail` and `rename`.
- [ ] Cross-page bookmark/REF, external link, and unresolved target.
- [ ] Shared/unique images and root source attachment `none|footer|comment`.
- [ ] Inline, page-level, reply, and cross-boundary comment outcomes.
- [ ] One node exceeding editability budget blocks/recommends revised split before writes.
- [ ] Failure at shell/asset/finalize/comment/readback cleans whole tree.

---

## 9. Verification gates

```bash
bun install --frozen-lockfile
bun test packages/import-docx packages/confluence packages/docx apps/cli
bun run typecheck
bun run build
bun run check:browser
bun run test:browser-export-harness
bun run docs:check
bun run docs:build
git diff --check
```

---

## 10. Definition of Done

- [ ] Whole page tree is deterministic, previewed, digest-bound, and create-only.
- [ ] No source block/asset/comment/link disappears or attaches to the wrong page silently.
- [ ] Numbered titles and editability assessments come from Plans 002/003.
- [ ] Multi-page transaction/readback/rollback pass failure injection.
- [ ] Cloud live E2E cleans every resource; DC is contract-tested, not live-certified.
- [ ] Plan 010 can compose one file into one subtree through a stable public/internal contract.
- [ ] `specs/import-docx/009-page-tree-split/EVIDENCE.md` is complete.

## 11. STOP conditions

STOP if complete ownership cannot be determined before writes, Cloud/DC links require guessed URLs, comments/assets cannot be assigned safely, title availability cannot be proven, rollback could delete existing content, or implementation expands into existing-tree update/batch before this slice is proven.

## 12. DAG

Plans 002 and 003 must complete first. Plans 004–008 may still run in parallel and are not blockers. Plan 010 starts after this plan plus 003 and 005.
