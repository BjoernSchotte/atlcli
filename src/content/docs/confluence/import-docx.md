---
title: "DOCX Import"
description: "Import a Word document as a native Confluence page — review first, publish explicitly"
---

# DOCX Import

Import a Word (`.docx`) document as a **native, editable Confluence Cloud
page** — real headings, lists, tables, links, and images, not an embedded
file. `wiki import` is review-first: it always shows you exactly what will be
published before anything touches Confluence, and it only publishes with an
explicit `--confirm`.

> **Scope.** DOCX import is under active development
> (`specs/import-docx-mvp`). Current coverage: single pages, page-tree
> splitting, batch imports with resume, importing from Confluence
> attachments, and in-place updates of existing pages — Cloud only.
> Data Center support is a planned follow-up.

## On this page

- [Prerequisites](#prerequisites)
- [Quick start](#quick-start)
- [How the preview works](#how-the-preview-works)
- [What gets imported](#what-gets-imported)
- [Images and attachments](#images-and-attachments)
- [Importing from a Confluence attachment](#importing-from-a-confluence-attachment)
- [Editability check](#editability-check)
- [Splitting into a page tree](#splitting-into-a-page-tree)
- [Import policy: style mappings and options](#import-policy-style-mappings-and-options)
- [Visibility, staging, and metadata](#visibility-staging-and-metadata)
- [Updating an existing page](#updating-an-existing-page)
- [Batch import](#batch-import)
- [Options](#options)
- [Advanced example](#advanced-example)
- [No silent loss: import issues](#no-silent-loss-import-issues)
- [Publication safety](#publication-safety)
- [Troubleshooting](#troubleshooting)
- [Related topics](#related-topics)

## Prerequisites

- A configured **Confluence Cloud** profile (`atlcli auth login`); Data
  Center profiles are rejected with a clear error for now
- Permission to create pages (and attachments, for documents with images) in
  the target space
- A `.docx` file — the binary `.doc` format is not supported

## Quick start

Preview first — this is completely local, nothing is sent anywhere:

```bash
atlcli wiki import handbook.docx --space TEAM
```

```text
Import preview
  Title:  Employee Handbook
  Space:  TEAM
  Digest: sha256:74bfef36f9038bfc…

Content: 3 headings, 1 image, 2 lists, 14 paragraphs, 1 table

Outline:
  H1 Employee Handbook
    H2 Getting started
    H2 Working hours

Attachments (1):
  image1.png (image/png, 34812 bytes, sha256:c414cd0e204d…)

Dry preview only — nothing was published. Re-run with --confirm to create the page.
```

Then publish the exact plan you just reviewed:

```bash
atlcli wiki import handbook.docx --space TEAM --confirm
```

## How the preview works

The preview is a pure local projection of the parsed document: block counts,
the heading outline, the attachment plan, every issue, and a **content
digest**. The digest is computed over the canonical page payload (with
attachment references in a deterministic placeholder form), and the same
digest is reported again after publishing — so you can verify that what
landed is what you reviewed. Per-attachment SHA-256 digests bind the image
bytes the same way.

The page title resolves in this order: `--title` flag → first Heading 1 in
the document → the file name.

## What gets imported

| Word construct | Confluence result |
|---|---|
| Heading styles (built-in and localized, e.g. „Überschrift 2“) | Native headings H1–H6 (via outline level, name fallback) |
| Bold, italic, code-styled runs | `strong`, `em`, `code` marks |
| External hyperlinks (`http`, `https`, `mailto`) | Native links |
| Bullet and numbered lists, including nesting | Native bullet/ordered lists (format from `numbering.xml`) |
| Tables with marked header rows | Native tables with header cells |
| Embedded images (PNG, JPEG, GIF, WebP, SVG) | Page attachments rendered as native media |
| Quote / Intense Quote / Zitat paragraphs | Native blockquotes (consecutive paragraphs grouped) |
| Code-styled paragraphs (Code, Source Code, HTML Preformatted) | Native code blocks (consecutive lines merged) |
| Footnotes | Inline `[n]` markers plus an appended footnote section (numbered in reference order) |
| Tracked insertions | Accepted into the content (with an info issue) |
| Content controls (SDT) | Unwrapped to their plain content |
| Word fields | Flattened to their cached display text |

## Images and attachments

Embedded pictures are extracted from the document, uploaded as page
attachments, and rendered as native media blocks — with alt text and display
size carried over from Word. Identical images referenced multiple times are
uploaded once.

Not imported (each produces an explicit issue): EMF/WMF vector formats,
legacy VML pictures, embedded OLE objects, charts/shapes without a bitmap,
and images linked from external URLs.

## Importing from a Confluence attachment

A DOCX that already lives as an attachment on a Confluence page can be
imported directly — no manual download:

```bash
atlcli wiki import --from-page 123456 --attachment handbook.docx --space TEAM
```

The attachment is downloaded with the active profile, then runs through the
exact same preview/confirm pipeline as a local file. The publish report
records the source page, attachment id, and attachment version for
provenance.

## Editability check

Very large single pages can be created successfully and still freeze the
Confluence editor. The preview estimates that risk from the encoded payload
(bytes, node count, table cells) and flags it:

```text
Editability: RISK — 3184 KiB payload, 24802 nodes, 11040 table cells
  This page is likely to freeze or time out in the Confluence editor. Split it into a page tree (--split 1 or --split 2) before publishing.
```

With `--split`, every planned page is assessed individually and flagged in
the tree preview. The thresholds are calibrated soft budgets, not hard API
limits — the check warns and recommends, it never blocks a publish on its
own.

## Splitting into a page tree

A long document can become a navigable page hierarchy instead of one huge
page — split at Word heading levels with `--split`:

```bash
atlcli wiki import handbook.docx --space TEAM --split 2
```

```text
Page tree (--split 2, 4 pages):
• Employee Handbook (1 blocks)
  └ 1 Getting started (3 blocks, 1 attachment(s))
    └ 1.1 First week (2 blocks)
  └ 2 Working hours (2 blocks)
```

- `--split 1`: every Heading 1 becomes a child page of the root
- `--split 2`: Heading 1 → children, Heading 2 → grandchildren
- The splitting heading becomes the page **title** (numbering label
  included) and is removed from the page body; content before the first
  splitting heading stays on the root page
- Images travel with the section that references them
- Duplicate resulting titles are rejected **before** the preview — rename
  the headings or import without `--split`
- Before publishing, every planned title is checked against the target
  space; existing pages with the same title block the run
- Publication is transactional: if any page of the tree fails, **all**
  pages created by the run are rolled back

## Import policy: style mappings and options

The built-in style heuristics (Quote → blockquote, Code → code block, …)
can be steered per organization with a typed policy — no code, no regex:

```bash
# Map custom Word styles (by styleId or display name, case-insensitive)
atlcli wiki import spec.docx --space TEAM \
  --map-style "Hinweis=blockquote" --map-style "Listing=code" \
  --revisions reject --unsupported fail

# Or keep the policy in a reviewable file
atlcli wiki import spec.docx --space TEAM --overrides import-policy.yaml
```

```yaml
# import-policy.yaml
schema: atlcli.docx-import-overrides/1
options:
  revisions: accept      # accept|reject tracked changes
  unsupported: report    # report|fail on lossy constructs
styleMappings:
  Hinweis: blockquote
  Listing: code
  Untertitel: heading-2
  Kleingedrucktes: paragraph   # suppress a heuristic classification
```

Rules:

- Mapping targets: `paragraph`, `heading-1`…`heading-6`, `blockquote`,
  `code`. Mappings that match no style in the document produce an info
  issue instead of silently doing nothing.
- Precedence is layered and **visible**: built-in defaults < recipe <
  CLI flags < override file. The preview's `Policy:` section shows every
  non-default decision with the layer that set it.
- A direct conflict between CLI flags and the override file fails closed —
  nothing silently wins.
- `--revisions reject` mirrors Word's "reject all changes": tracked
  insertions are dropped, tracked deletions are kept (each reported).
- `--unsupported fail` blocks a confirmed publish while any construct
  would be lost (reported warnings); previews still work.

## Visibility, staging, and metadata

Where imported content lands and **who can see it** is part of the reviewed
plan, not an afterthought:

```bash
# Private review copy: only you can view/edit until you lift the restriction
atlcli wiki import draft.docx --space TEAM --restriction private --confirm

# Explicit audience by stable ids (never display names or emails)
atlcli wiki import spec.docx --space TEAM \
  --restriction explicit \
  --viewer account:557058:aaaa-bbbb --viewer group-id:9c2d… \
  --editor account:557058:aaaa-bbbb --confirm

# Private staging parent + labels + audit metadata
atlcli wiki import handbook.docx --space TEAM \
  --staging-parent "Imported drafts" \
  --label imported --content-property atlcli.import.batch=wave-1 --confirm
```

How it behaves:

- **Restriction-first:** with `private`/`explicit`, the page is created as an
  empty shell, the restriction is applied **and read back** first, and only
  then does any imported content or attachment land. A failed or rejected
  restriction (e.g. an unknown account id) rolls the empty shell back —
  sensitive content is never visible in an unrestricted state.
- `private` restricts view+edit to the importing user. `explicit` takes
  stable principals (`account:<accountId>`, `group-id:<groupId>`); the
  importing user is always included so the transaction cannot lock itself
  out. Data-Center-style principals (`user-key:`, `group:`) are rejected.
- With `--split`, the restriction is applied to the root; Confluence Cloud
  cascades view restrictions to child pages.
- `--staging-parent <title>` creates a private, import-owned parent
  (marker property `atlcli.import.staging`) and places the imported
  page/tree below it — review privately, then move or unrestrict.
- Labels and `atlcli.*`-namespaced content properties are **required
  outcomes**: they are applied and read back, and a failure rolls back the
  entire import.
- Attachment downloads follow page visibility; anyone who can view the page
  can download its attachments. The preview repeats this caveat whenever a
  restriction is selected.

## Updating an existing page

Reimport a revised DOCX **into the page it originally created** — the page
id, URL, version history, labels, and unrelated attachments are preserved
(the body is replaced as a new version, never delete-and-recreate):

```bash
# 1. Preview: shows current vs. new content and the current version
atlcli wiki import spec-v2.docx --update-page 123456

# 2. Confirm with the version you just reviewed
atlcli wiki import spec-v2.docx --update-page 123456 --confirm --expect-version 7
```

`--expect-version` is mandatory on a confirmed update: if the page changed
since your preview (someone edited it concurrently), the run fails instead
of overwriting their work. Same-name attachments are updated in place; if
the post-update verification fails, the previous content is automatically
**restored as a new version**.

Word of caution: inline comments anchored to text that changed may lose
their anchors — the preview says so explicitly. `--update-page` cannot be
combined with `--split` or `--parent`.

## Batch import

Import a whole directory (all `.docx` directly inside, sorted) or several
files at once — each file becomes its own page (or page tree with
`--split`) under the same parent:

```bash
atlcli wiki import ./exports --space TEAM --parent 123456
atlcli wiki import a.docx b.docx c.docx --space TEAM --confirm
```

The batch preview lists every file with its resolved title, page count,
attachments, issues, and editability rating; files that fail to parse are
reported without stopping the preview. Titles are taken from each document
(`--title` is rejected in batch mode), and duplicate titles across the
batch fail closed before anything is published.

Each file publishes as its **own transaction**: a failure rolls back only
that file's pages, is recorded in the result list, and the batch continues.
The final report shows exact `created` / `skipped` / `failed` results and
the command exits non-zero if anything failed.

**Resuming:** re-run the same command with `--skip-existing` — files whose
titles already exist in the space are skipped instead of failing, so an
interrupted batch continues without duplicating verified content.

## Options

| Option | Type | Default | Description |
|---|---|---|---|
| `--from-page <id>` | string | — | Import the source DOCX from this page's attachments (instead of a local file) |
| `--attachment <name>` | string | — | Exact attachment file name on `--from-page` |
| `--space <KEY>` | string | profile space | Target space key |
| `--title <title>` | string | first H1, else file name | Page title |
| `--parent <id>` | string | space root | Parent page id |
| `--split <1\|2>` | number | off | Split into a page tree at heading levels 1 (or 1+2) |
| `--skip-existing` | flag | off | Batch: skip files whose titles already exist (resume an interrupted batch) |
| `--update-page <id>` | string | — | Reimport into this existing page (keeps id/URL/history) |
| `--expect-version <n>` | number | — | Required with `--update-page --confirm`; must match the page's current version |
| `--restriction <mode>` | string | `inherit` | `inherit` \| `private` \| `explicit` page visibility |
| `--viewer <principal>` | string, repeatable | — | Explicit mode: `account:<id>` or `group-id:<id>` |
| `--editor <principal>` | string, repeatable | — | Explicit mode: `account:<id>` or `group-id:<id>` |
| `--staging-parent <title>` | string | — | Create a private import-owned parent and import below it |
| `--label <name>` | string, repeatable | — | Labels applied and verified on the root page |
| `--content-property <k=v>` | string, repeatable | — | `atlcli.*` namespaced page metadata (max 20, value ≤ 2048 chars) |
| `--map-style <s>=<t>` | string, repeatable | — | Map a Word style to `paragraph`/`heading-1..6`/`blockquote`/`code` |
| `--revisions <mode>` | string | `accept` | `accept` or `reject` tracked changes |
| `--unsupported <mode>` | string | `report` | `fail` blocks confirmed publishes on lossy constructs |
| `--overrides <file>` | string | — | Policy file (`atlcli.docx-import-overrides/1`, YAML or JSON) |
| `--confirm` | flag | off | Actually create the page; without it the command only previews |
| `--profile <name>` | string | active profile | Auth profile |
| `--json` | flag | off | Machine-readable output (preview or publish report) |

## Advanced example

Import below a parent page, with an explicit title, and capture the publish
report as JSON:

```bash
atlcli wiki import spec-v2.docx \
  --space DOCS \
  --parent 123456 \
  --title "Product Spec v2" \
  --confirm --json
```

The JSON report contains the page id/URL/version, the content digest, the
attachment list with SHA-256 digests, and all import issues — suitable for
audit trails or scripted pipelines.

## No silent loss: import issues

Every Word construct ends in exactly one outcome: imported natively,
approximated (e.g. a nested table flattened to paragraphs), or **reported**
as an issue. "The importer ignored it" is never a valid outcome. Issues are
deduplicated with an occurrence count and shown in the preview, for example:

```text
Issues (2):
  [warning] docx-import/comment-dropped: Word comments are not imported by this slice.
  [warning] docx-import/image-format-not-supported: Embedded images of type .emf (e.g. EMF/WMF) are not imported. (×3)
```

Warnings never block the import — they tell you what to check after
publishing.

## Publication safety

- Rejected before parsing: files that are not valid DOCX packages, oversized
  archives, zip bombs, packages with macros/active content, and XML with
  DOCTYPE declarations
- Hyperlinks with unsafe schemes (e.g. `javascript:`) are kept as plain text
  with a warning
- After publishing, the page is read back and verified against the reviewed
  plan; if verification fails, the page is **deleted again (rollback)** and
  the command exits non-zero
- Documents with images publish in one transaction: page shell → attachment
  uploads → final content; any failure rolls the whole page back

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `Rejected DOCX package: …` | File is `.doc`, corrupted, or contains active content | Re-save as `.docx` in Word; remove macros |
| `Space XYZ not found or not accessible` | Wrong key or missing permission | Check `--space`; verify the profile can see the space |
| `wiki import currently supports Confluence Cloud profiles only` | Data Center profile | Use a Cloud profile; DC support is a planned follow-up |
| Headings imported as plain paragraphs | Text styled manually (big/bold) instead of Word heading styles | Apply real heading styles in Word and re-import |
| List numbers restart or nest oddly | Document uses manual numbering, not Word list formatting | Reformat with Word's list styles |
| `Publication could not be verified; the page was rolled back` | Confluence normalized the content unexpectedly | Re-run with `--json`, file the reported sequences as a bug |

## Related topics

- [DOCX and PDF Export](/confluence/export/) — the reverse direction
- [Pages](/confluence/pages/) — create/update pages from Markdown
- [Attachments](/confluence/attachments/) — manage page attachments
- [Authentication](/authentication/) — set up the Cloud profile
