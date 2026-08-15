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
> (`specs/import-docx-mvp`). Cloud (live-certified): single pages,
> page-tree splitting, batch imports with resume, importing from
> Confluence attachments, in-place updates, comments, recipes,
> governance. Data Center (contract-tested, not live-certified):
> single-page imports with images and labels over REST v1 Storage.

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
- [Recipes: shared, versioned import conventions](#recipes-shared-versioned-import-conventions)
- [Word comments](#word-comments)
- [Visibility, staging, and metadata](#visibility-staging-and-metadata)
- [Updating an existing page](#updating-an-existing-page)
- [Batch import](#batch-import)
- [Options](#options)
- [Advanced example](#advanced-example)
- [No silent loss: import issues](#no-silent-loss-import-issues)
- [Data Center](#data-center)
- [Publication safety](#publication-safety)
- [Troubleshooting](#troubleshooting)
- [Related topics](#related-topics)

## Prerequisites

- A configured Confluence profile (`atlcli auth login`) — Cloud for the
  full feature set, or Data Center for single-page imports (see below)
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
| Word comments (incl. replies and resolved state) | Native Confluence comments — inline on the exact commented text where the anchor resolves, footer otherwise |
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

- `--split <1..6>`: headings up to that level open pages — level 1 makes
  H1 sections children of the root, level 2 adds H2 grandchildren, and so
  on down to H6
- The splitting heading becomes the page **title** (numbering label
  included) and is removed from the page body; content before the first
  splitting heading stays on the root page
- **Cross-references become real links:** Word bookmarks, hyperlink
  anchors, and `REF`/`PAGEREF` fields whose target lands on another page
  are rewritten to links to that page. The tree publishes in two phases —
  all page shells first (so every target URL exists), then the content
- Level jumps (H1 → H3) attach to the nearest open ancestor; empty
  sections stay as headings in their ancestor's body instead of becoming
  empty pages (each reported as an info issue)
- Images travel with the section that references them
- Title conflicts: in-tree duplicates and existing space titles fail by
  default; `--title-conflict rename` deduplicates with " (2)", " (3)" …
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

## Recipes: shared, versioned import conventions

A recipe wraps an import policy in a **named, versioned, digest-bound file**
your team can commit and review — apply the same Word-to-wiki conventions
across every import without repeating flags:

```yaml
# .atlcli/import-recipes/company-handbook.yaml
schema: atlcli.docx-import-recipe/1
id: company-handbook
version: "2.1"
title: Firmenhandbuch-Konventionen
targets: [cloud]
options:
  revisions: accept
  unsupported: fail
overrides:
  styleMappings:
    Hinweis: blockquote
    Listing: code
metadata:
  owners: [docs-team]
```

```bash
atlcli wiki import handbook.docx --space TEAM --recipe-id company-handbook
atlcli wiki import handbook.docx --space TEAM --recipe ./my-recipe.yaml

atlcli wiki import recipe validate my-recipe.yaml
atlcli wiki import recipe list
atlcli wiki import recipe show company-handbook

# Distill your current flags into a committable recipe
atlcli wiki import recipe export --id company-handbook \
  --title "Firmenhandbuch-Konventionen" \
  --map-style "Hinweis=blockquote" --map-style "Listing=code" \
  --unsupported fail
```

- **Catalogs are explicit:** `--recipe <file>` reads a file;
  `--recipe-id <id>` searches `.atlcli/import-recipes/` in the working
  directory, then `~/.atlcli/import-recipes/`. The repository catalog
  shadows the user catalog; duplicate ids inside one catalog are an error;
  symlinks may not escape a catalog root.
- **Recipes are data, not code:** no scripts, regex, template engines, raw
  ADF/HTML, YAML anchors/aliases, or custom tags — the hardened parser
  rejects them, along with duplicate keys and unknown fields.
- The recipe sits at the lowest explicit precedence layer: CLI flags and an
  `--overrides` file still win, with provenance shown in the preview.
- Preview and publish report carry the recipe id, version, and content
  digest, so a page can be traced back to the exact convention set that
  produced it.
- A recipe declaring `targets: [data-center]` is rejected before any
  preview — it cannot silently run against the wrong edition.

## Word comments

Word comments import as **native Confluence comments** (single-page imports
and in-place updates):

- The Confluence comment **actor is always you** (the authenticated
  importer); the original Word author and date appear as a visible
  attribution line at the top of each comment — no impersonation, no
  name-to-account guessing.
- A comment anchored to a text range becomes an **inline comment on the
  exact same text**; if the anchor cannot be matched, it falls back to a
  footer comment (with an info issue). Replies thread under their parent;
  resolved Word threads arrive resolved.
- `--comments auto|inline|footer|skip` controls the shape (default `auto`;
  also available in recipes and override files as `options.comments`).
- On `--update-page`, comments are **reconciled by source identity** from
  the import baseline: existing threads keep their Confluence ids, new
  Word comments (and new replies to existing threads) are added, and
  imported comments whose Word source disappeared are deleted after
  verification. Comments other people added on the page are never touched.
- Commenting is not editing: inline-comment annotations are normalized out
  of the update divergence check, so a colleague commenting on the page
  does not block your next update.
- With `--split`, each comment lands on the **page that owns its anchored
  text** (unanchored comments go to the root page); batch imports (plain
  and manifest) publish comments the same way, and a manifest's
  `defaults.recipe` policy (including `options.comments`) now applies to
  every document in the batch.

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

Updates are guarded by an **import baseline** the importer seals on every
single-page import (page property `atlcli.import.baseline`, digest-signed):

- Only pages **created by `wiki import`** can be updated — a page without a
  valid baseline is rejected.
- If anyone edited the page since the import, the update fails with
  `target-diverged` and shows the diff. There is deliberately **no force
  flag** — reconcile manually or import as a new page.
- The preview shows a semantic block diff (added/changed/removed/unchanged)
  between the current page and the new plan; re-uploaded attachment
  identities never count as changes.
- Attachments are reconciled by content digest: unchanged images are not
  re-uploaded, changed ones are updated in place, and images no longer in
  the document are deleted **after** the new body verifies (a failed
  deletion becomes an explicit orphan warning, never a rollback).
- Pages carrying inline comments are blocked by default (anchors to changed
  text cannot be proven to survive); pass `--accept-anchor-loss` to proceed.
- If post-update verification fails, the previous content is automatically
  **restored as a new version**, and the baseline is resealed after every
  successful update.
- `--expect-version <n>` remains available as an additional guard.
  `--update-page` cannot be combined with `--split` or `--parent`.

## Batch import

Import a whole directory (all `.docx` directly inside, sorted) or several
files at once — each file becomes its own page (or page tree with
`--split`) under the same parent:

```bash
atlcli wiki import ./exports --space TEAM --parent 123456
atlcli wiki import a.docx b.docx c.docx --space TEAM --confirm
atlcli wiki import export-bundle.zip --space TEAM --confirm   # outer ZIP
```

A `.zip` batch source is inspected against the same hardened archive
budgets as DOCX packages (entry-name safety, zip-bomb limits) before
anything is inflated; all `.docx` members import in sorted order.

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

### Manifest batches with checkpoint/resume

For larger migrations, describe the whole batch in a versioned manifest —
per-document titles, split levels, labels, and a **folder hierarchy** that
becomes a page hierarchy:

```yaml
# batch.yaml
schema: atlcli.docx-batch-manifest/1
batchId: wave-1
destination:
  spaceKey: TEAM
  staging: private        # everything lands under a private batch root
defaults:
  titleConflict: rename
documents:
  - sourcePath: docs/intro.docx
  - sourcePath: docs/guides/admin.docx
    relativeParentPath: Guides     # folder page, created on demand
    labels: [imported]
  - sourcePath: docs/guides/handbook.docx
    relativeParentPath: Guides
    splitHeading: 1                # this one becomes a page tree
```

```bash
atlcli wiki import --manifest batch.yaml --confirm          # first run
atlcli wiki import --manifest batch.yaml --confirm --resume # continue later
```

- Every document is its own transaction; a failure rolls back only that
  document's pages and the batch continues to an exact
  complete/skipped/failed report.
- A checkpoint state file (`batch.yaml.state.json`, written atomically
  after every item) records page ids and content digests.
- `--resume` **verifies the remote state** before skipping anything: an
  item only skips when its recorded root page still exists (not trashed)
  and its body digest matches — a page someone deleted is re-imported,
  everything else is left alone. A changed manifest invalidates the state
  file instead of being silently reinterpreted.
- **Cross-file links:** a Word hyperlink pointing at a sibling DOCX
  (`guides/admin.docx` or `admin.docx#section`) becomes a link to that
  document's imported page. Links are patched in after every root page
  exists; unresolved targets stay plain text and are listed in the
  report. Planning runs with bounded concurrency (4 workers); target
  mutations stay strictly sequential.

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
| `--comments <mode>` | string | `auto` | `auto`/`inline`/`footer`/`skip` Word-comment handling |
| `--overrides <file>` | string | — | Policy file (`atlcli.docx-import-overrides/1`, YAML or JSON) |
| `--recipe <file>` | string | — | Apply a recipe file (`atlcli.docx-import-recipe/1`) |
| `--recipe-id <id>` | string | — | Apply a catalog recipe by id |
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

## Data Center

Data Center profiles publish through the documented REST v1 contracts:
the page body is Storage XHTML, images reference their attachment **by
filename** (`<ac:image><ri:attachment ri:filename="…"/></ac:image>`), and
context paths (e.g. `https://confluence.example.com/confluence`) are
honored on every call. The transaction mirrors the Cloud shape: empty
shell → attachment uploads → full body as version 2 → structural readback
verification → labels with readback; any failure rolls the page back.

Supported on DC: single-page imports (local file or `--from-page`),
images, labels, title preflight with `--title-conflict rename`, policies
and recipes. Cloud-only (rejected with a clear error): `--split`,
`--update-page`, `--restriction`/`--staging-parent`,
`--content-property`, and comment import.

This path is **contract-tested against the documented v1 REST contracts**
(a deterministic local suite covering auth, context path, multipart CSRF
header, storage bodies, readback, and rollback) — it is not certified
against a specific live Data Center installation.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `Rejected DOCX package: …` | File is `.doc`, corrupted, or contains active content | Re-save as `.docx` in Word; remove macros |
| `Space XYZ not found or not accessible` | Wrong key or missing permission | Check `--space`; verify the profile can see the space |
| `Data Center import supports single pages only; unsupported here: …` | A Cloud-only flag on a DC profile | Drop the listed flags, or use a Cloud profile |
| Headings imported as plain paragraphs | Text styled manually (big/bold) instead of Word heading styles | Apply real heading styles in Word and re-import |
| List numbers restart or nest oddly | Document uses manual numbering, not Word list formatting | Reformat with Word's list styles |
| `Publication could not be verified; the page was rolled back` | Confluence normalized the content unexpectedly | Re-run with `--json`, file the reported sequences as a bug |

## Related topics

- [DOCX and PDF Export](/confluence/export/) — the reverse direction
- [Pages](/confluence/pages/) — create/update pages from Markdown
- [Attachments](/confluence/attachments/) — manage page attachments
- [Authentication](/authentication/) — set up the Cloud profile
