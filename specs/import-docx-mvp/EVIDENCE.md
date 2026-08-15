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
