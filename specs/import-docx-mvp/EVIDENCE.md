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
