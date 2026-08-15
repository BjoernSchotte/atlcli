# Evidence ledger — specs/import-docx-mvp

Scope note: Task 0 runs in the reduced three-gate form defined in
`DRIFT.md` §2. Gate (a) — parser selection — was resolved by analysis in
`DRIFT.md` §1.1 (internal parser on the in-repo hardened archive boundary;
no external parser dependency). Gates (b) and (c) below are live Cloud proof.
Remaining original Task 0 items (TOC macro, comment properties, DC contract
fixtures, title-conflict probing) move to the tasks that first need them.

## 2026-08-15 — Task 0 gates (b) and (c), live Cloud (`mayflower` / DOCSY)

Probe: disposable script (session scratchpad, not committed — no tenant
dumps in the repo per Task 0 rules) driving the public REST API with the
profile's resolved credentials; every created resource deleted in `finally`
with the deletion verified by a follow-up GET.

Environment: Bun 1.3.14, repo worktree at `codex/import-docx-mvp-plan`,
site `mayflowergmbh.atlassian.net`, space DOCSY (id `623935493`).

### Gate (b) — Cloud ADF page create via REST v2 + readback

- `POST /wiki/api/v2/pages` with `body.representation = "atlas_doc_format"`
  and a doc containing `heading`, `paragraph` (with `strong` and `link`
  marks), `bulletList`, `table` (`tableHeader`/`tableCell`): **accepted**,
  page id `1197965313`, `status=current`, `version=1`.
- `GET /wiki/api/v2/pages/{id}?body-format=atlas_doc_format`: readback
  preserved the exact top-level node sequence
  `heading,paragraph,bulletList,table` and the `link` mark. **PASS**

### Gate (c) — Cloud media identity end-to-end

- Shell page `1197899778` created via v2 with an empty ADF doc.
- `POST /wiki/rest/api/content/{id}/child/attachment` (multipart,
  `X-Atlassian-Token: nocheck`) with a PNG: response carries
  `results[0].extensions.fileId = a650f43e-da7e-4f41-954c-7d5e7641da15`
  and `results[0].extensions.collectionName = contentId-1197899778`
  (attachment id `att1197998081`, `mediaType=image/png`).
  → The required `media.attrs.id` is the attachment **`extensions.fileId`**
  (not the `att…` content id), and the collection is the literal
  **`contentId-<pageId>`** value returned by the upload response — both taken
  from authoritative responses, not guessed.
- `PUT /wiki/api/v2/pages/{id}` with `mediaSingle > media
  {type:"file", id:<fileId>, collection:<collectionName>}`: **accepted**
  (version 2).
- ADF readback returned the `media` node with `attrs.id` equal to the
  uploaded `fileId` and the same collection. **PASS**

### Cleanup

- `DELETE /wiki/api/v2/pages/{id}` (trash) + `DELETE …?purge=true` for both
  probe pages; verification `GET` returned **404** for `1197965313` and
  `1197899778`. No probe titles remain in DOCSY.

## 2026-08-15 — Vertical-slice CLI E2E, live Cloud (`mayflower` / DOCSY)

Fixture: deterministic 2,263-byte DOCX generated with the committed
`packages/import-docx/src/test-support.ts` builder (H1, bold + external
hyperlink, H2, nested ordered list, header-row table, one `w:drawing`).

- Preview (source run, no `--confirm`):
  `bun --conditions=development run --cwd apps/cli src/index.ts wiki import
  <fixture> --space DOCSY --profile mayflower`
  → outline `H1/H2`, block counts, issue
  `docx-import/image-not-supported`, ADF digest `sha256:ca3a9fcdd8816c53…`,
  exit without any network write.
- Publish: same command with `--confirm --json`
  → page id `1197899801`, version 1, URL under `/wiki/spaces/DOCSY/…`,
  readback block-sequence verification passed, reported `adfDigest`
  identical to the preview digest
  (`ca3a9fcdd8816c532cc24cb3149dec170ca5d0acad6252eabac071c9cef09d18`).
- Cleanup: `wiki page delete --id 1197899801 --confirm` succeeded; follow-up
  `wiki page get` returned **404**.

## 2026-08-15 — Image support E2E, live Cloud (`mayflower` / DOCSY)

Fixture: 2,528-byte DOCX with an inline DrawingML picture (1×1 PNG,
`wp:extent` 200×100 px, `descr` alt text), external hyperlink, list.

- Preview: image surfaced as `1 image` block plus an attachment plan
  (`image1.png`, image/png, 70 bytes, sha256 `c414cd0e204d…`); digest
  `74bfef36f9038bfc…` computed over the placeholder-form ADF.
- Publish (`--confirm --json`): shell page `1198129153` created (v1),
  attachment uploaded, `listPageAttachmentMedia` resolved the media
  `fileId`, final ADF with `mediaSingle/media` landed as version 2,
  readback block-sequence verification (incl. `mediaSingle`) passed,
  zero issues.
- Cleanup: page deleted; follow-up GET returned **404**.

## 2026-08-15 — Attachment-source import E2E, live Cloud (plan 004 slice)

- Seed: page `1197801482` created in DOCSY with `source.docx`
  (`att1198194689`) attached — a DOCX containing H1, paragraph, and an
  embedded PNG.
- `wiki import --from-page 1197801482 --attachment source.docx --confirm
  --json` downloaded the attachment with the profile, ran the standard
  pipeline, and published page `1198194695` (version 2, image attached,
  zero issues). The report records the source identity
  (`kind: attachment`, pageId, attachmentId, version 1).
- Cleanup: both pages deleted; follow-up GETs returned **404**.

## 2026-08-15 — Page-tree split E2E, live Cloud (plan 009 slice) + §2.12 title preflight

- Fixture: preamble, H1 "Intro" (with H2 "Background" carrying an embedded
  PNG), H1 "Usage".
- Preview with `--split 2` rendered the exact 4-page tree (root + 2 children
  + 1 grandchild) with per-page block/attachment counts.
- `--confirm` published the tree depth-first: root `1198227457`, children
  `1197998087` (Intro) and `1198227478` (Usage), grandchild `1198161935`
  (Background, version 2 with the image attached to THAT page). Every page
  readback-verified; report shows the nested structure, `pagesCreated: 4`,
  zero issues.
- Title preflight: all 4 planned titles checked against DOCSY via the direct
  content endpoint before the first write.
- Split-time duplicate titles and `--split` values outside 1|2 fail closed
  (unit-tested); tree-wide rollback deletes children before parents.
- Cleanup: all 4 pages deleted; root and grandchild GETs returned **404**.

## 2026-08-15 — Editability assessment (plan 003 slice) + batch import E2E (plan 010 slice)

- Editability: `assessEditability` metrics (ADF bytes, node count, table
  cells, images) with soft caution/risk budgets and a --split
  recommendation; unit-tested against the budget boundaries; surfaced in
  single, tree, and batch previews. Warn-only by design — the thresholds
  are community-calibrated, not proven API limits.
- Batch live E2E: directory with alpha/beta/gamma fixtures →
  `wiki import <dir> --confirm` created 3 pages (`1198030866`,
  `1197998116`, `1197801502`), summary `created: 3`.
- Resume: identical re-run with `--skip-existing` reported
  `skipped: 3, created: 0` — no duplicate content.
- In-batch duplicate titles and unparsable files fail closed/degrade
  gracefully (unit-tested with a broken fixture in the directory).
- Cleanup: all 3 pages deleted; spot-check GET returned **404**.

## 2026-08-15 — Fidelity slice E2E: blockquotes, code blocks, footnotes

- Parser: Quote/Intense Quote/Zitat styles group into blockquote blocks;
  Code/Source Code/HTML Preformatted styles merge into code blocks;
  footnote references become inline [n] markers (numbered in reference
  order) with the footnote bodies appended as a trailing section (own
  rels scope, separator pseudo-footnotes skipped). Missing footnote
  definitions and endnotes report explicit issues. 7 new unit tests.
- Live Cloud proof: page `1197899830` published with blockquote,
  codeBlock, and footnote paragraphs — ADF accepted, readback
  block-sequence verification passed (info issue
  `docx-import/footnotes-appended` as designed).
- Cleanup: page deleted; follow-up GET returned **404**.

## 2026-08-15 — In-place update E2E, live Cloud (plan 006 slice)

- Seed: page `1198030895` created from a v1 fixture (H1 + 1 paragraph).
- Preview `--update-page 1198030895`: showed title, version 1 → 2, and
  current (1 heading, 1 paragraph) vs. new (1 heading, 2 paragraph)
  block summaries plus the inline-comment anchor warning.
- Guards proven live: `--confirm` without `--expect-version` fails with
  the current version in the message; `--expect-version 7` against
  version 1 fails as a concurrent-edit conflict. Nothing was written in
  either case.
- `--confirm --expect-version 1`: body replaced via v2 PUT as version 2,
  same page id/URL, readback block-sequence verification passed. On a
  failed verification the previous body is restored as a new version
  (code path exercised by the rollback design; page never left
  unverified).
- Cleanup: page deleted; follow-up GET returned **404**.

## 2026-08-15 — Plan 005 Task 0: Cloud governance contracts, live (`mayflower` / DOCSY)

Probe page `1198194732` (shell, no sensitive body), deleted+purged with
verified 404. Contracts derived from authoritative responses:

- **Restrictions:** `PUT /rest/api/content/{id}/restriction` with
  `[{operation:"read"|"update", restrictions:{user:[{type:"known",
  accountId}]}}]` REPLACES the restriction set (2 results). Readback via
  `GET …/restriction/byOperation?expand=read.restrictions.user,…`
  returned exactly the applied accountIds for both operations.
  `DELETE …/restriction` restores inherited visibility (readback: 0
  users). An unknown accountId fails the PUT with HTTP 400
  ("valid": false) — invalid principals fail closed BEFORE any
  restriction state changes, which makes the preflight contract
  (invariant 2/4) implementable without probing mutations.
- **Labels:** `POST /rest/api/content/{id}/label` with
  `[{prefix:"global", name}]` applied and echoed the label.
- **Page properties (v2):** `POST /api/v2/pages/{id}/properties` with
  `{key:"atlcli.import.probe", value:{…}}` created version 1; readback
  by key returned the exact JSON value.
- Current-user identity for the `private` policy comes from
  `GET /rest/api/user/current` (`accountId`, `type=known`).

## 2026-08-15 — Destination governance E2E, live Cloud (plan 005 slice)

Proof matrix (plan §6), all pages deleted afterwards with a verified 404:

- **private:** `--restriction private --label atlcli-import
  --content-property atlcli.import.source=gov-e2e` published page
  `1197899851` restriction-first (empty shell → restrict → readback →
  body+image → labels/properties with readback). Independent
  verification: read AND update restricted to exactly the importer's
  accountId, label and property present.
- **invalid principal:** `--restriction explicit --viewer
  account:000000:…` — the restriction PUT failed with HTTP 400
  ("not a valid existing user") while the page was still an empty
  shell; the shell was rolled back and a title search returned 0
  results. No sensitive content was ever visible.
- **staging parent:** `--staging-parent "atlcli gov e2e staging area"
  --restriction private` created parent `1198129207` (restricted to the
  importer, marker property `atlcli.import.staging` read back) BEFORE
  child `1198096423` was created below it (`parentId` verified);
  `pagesCreated: 2`, rollback tracks both ids in reverse order.
- **inherit:** covered by every earlier E2E (no restriction mutation).
- **explicit with a foreign principal:** not live-provable with a
  single-account test tenant; the mechanism (PUT + readback per
  principal, importer always included) is identical to the proven
  private path, and unknown principals fail closed per above.
- Fix found by this E2E: an empty page plan (staging parent) skips the
  body update and block-sequence verify — Cloud normalizes an empty doc
  to one empty paragraph, which the verifier would misread as drift.

## 2026-08-15 — Plan 006 full form, live Cloud (baseline, divergence, reconciliation)

- Import of a v1 fixture (text + image) sealed baseline
  `atlcli.docx-page-baseline/1` as page property with readback proof
  (page `1197965352`, imported v2).
- Update preview showed the validated baseline and a semantic LCS diff
  (2 added, 2 removed incl. the mediaSingle, 1 unchanged).
- `--confirm` updated to v3: unchanged-digest assets skipped, the
  superseded image attachment deleted AFTER verification (independent
  check: attachments list empty), baseline resealed at v3 with empty
  bindings.
- Tamper test: a manual body edit outside the pipeline (v4) made the
  next confirmed update fail with `target-diverged` including the
  current-vs-plan diff; the page version stayed 4 — zero mutation, no
  force flag exists.
- Inline-comment gate: pages with inline comments block confirmed
  updates unless --accept-anchor-loss is passed (implemented; page had
  none in this run).
- Cleanup: page deleted; follow-up GET returned **404**.

## 2026-08-15 — Plan 009 full form, live Cloud (cross-page links, levels, rename)

- Fixture: preamble, H1 Alpha (hyperlink anchor AND `fldSimple REF` both
  targeting bookmark `sec_gamma`), H2 Beta (image), H3 Gamma (bookmark
  owner), empty H1 section.
- `--split 3` preview: correct 4-page tree (root→Alpha→Beta→Gamma), the
  empty section stayed as a heading with `page-tree-empty-section`.
- Publish: two-phase (all shells parent-before-child, then finalize with
  the bookmark→URL map). Independent readback of Alpha
  (`1197932600`): BOTH cross-references are real links pointing at the
  Gamma page URL (`…/pages/1198096454`) — hyperlink anchor and REF field
  alike.
- Rename mode: identical re-import with `--title-conflict rename`
  created the full tree as "… (2)" variants (root, Alpha, Beta, Gamma),
  4 pages, no conflict failure.
- Level-gap and empty-section policies unit-tested (H1→H3 attach to
  nearest ancestor with `page-tree-heading-level-gap`).
- Cleanup: all 8 pages of both trees deleted; title search returned 0.

## 2026-08-15 — Plan 010 full form, live Cloud (manifest, hierarchy, checkpoint/resume)

- Manifest `e2e-wave-1`: 3 documents, one with `relativeParentPath:
  Guides` + labels, one with `splitHeading: 1`, destination staging
  private, titleConflict rename.
- Run 1: private staging root `1198096487` (restriction-first, proven),
  folder page "Guides" `1198096523` under it, all 3 items complete
  (handbook as a 3-page tree). Hierarchy verified: Admin Guide
  parentId=Guides, Guides parentId=staging root.
- Resume run: all 3 skipped via REMOTE verification (page current +
  canonicalized body digest matches the checkpoint).
- Deletion test: after remotely deleting the admin root page, resume
  re-imported ONLY that item (new id `1197998201`) and skipped the rest.
  This E2E exposed and fixed a real bug: v2 getPageAdf still serves
  TRASHED pages, so existence checks now go through v1 (status=current
  404s for trash).
- All-skip runs now normalize and persist the state (skipped →
  complete), fixing a second found-by-E2E bug where `continue` bypassed
  the per-item checkpoint.
- State file is atomic (tmp+rename); manifest-digest drift blocks
  --resume (unit-tested).
- Cleanup: all batch pages incl. staging root and folder page deleted;
  staging-root title search returned 0.

## 2026-08-15 — Word-comment import + plan 006 comment reconciliation, live Cloud

- Parser: word/comments.xml + commentsExtended.xml (replies via
  w14:paraId → w15:paraIdParent, resolved via w15:done), comment range
  anchors collected as exact text between commentRangeStart/End. Policy
  option comments=auto|inline|footer|skip in CLI, recipes, overrides.
- Import (page `1198194823`): anchored comment → INLINE comment on
  exactly "42 million euros" with visible attribution "original author:
  Alice Autor, 2026-02-01", threaded reply (Bob), resolved footer
  comment (Carol). All three bindings sealed into the baseline.
- Reconciliation update (v2 DOCX: Carol removed, Erin new, Dave = new
  reply on Alice's thread): Alice's thread KEPT the same Confluence id,
  Dave attached as reply 2 to the existing inline thread, Carol's
  imported comment was deleted post-verify, Erin created as footer;
  bindings updated to sources 1,2,4,5. Foreign comments untouched by
  construction (only baseline-bound ids are candidates).
- Two real findings fixed by this E2E: (1) creating an inline comment
  REWRITES the page body (annotation marks + text-node splits) — the
  divergence digest and semantic diff now strip annotations and re-merge
  adjacent equal-marked text nodes ("commenting is not editing",
  invariant-3 safe normalization, regression-tested); (2) the
  inline-comment anchor-loss gate now exempts import-owned (baseline-
  bound) comments and gates only foreign ones.
- Client fix: inlineCommentProperties are only sent on top-level inline
  comments (replies inherit the parent anchor).
- Cleanup: page deleted; follow-up GET returned **404**.

## 2026-08-15 — Comments in split trees and batches, live Cloud (closing the open points)

- Parser records the owning top-level block of every anchored comment
  range (unit-tested by identity).
- Split placement (plan 009 rule 8): 3-page tree — the anchored comment
  published as an INLINE comment on page Beta (owner of its range-start
  block: {root:0/1 footer, alpha:0/0, beta:1 inline/0}); the unanchored
  comment landed as a footer comment on the root. Pages `1198162016`
  (root), `1197801584` (Alpha), `1197965451` (Beta).
- Batch: a plain directory batch published the comment fixture with
  1 inline + 1 footer comment on its page (`1197965486`) through the
  same per-page pipeline; the manifest batch now also APPLIES
  `defaults.recipe` (previously parsed but unused — found while wiring
  comments) through the plan-007 policy chain, including
  `options.comments`, style mappings, and revisions.
- All four E2E pages deleted; follow-up GET returned **404**.
