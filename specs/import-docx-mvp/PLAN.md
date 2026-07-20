# DOCX import MVP — semantic DOCX to Confluence Cloud/Data Center

Status: **Planned**

Planned at: `63b02ac` (`feat(publishing): packaging readiness & API guards (spec 009) (#50)`), 2026-07-20

Priority: **P1**

Estimated effort: **L / 6–9 implementation weeks plus optional community-operated Data Center validation**

Risk: **HIGH** — untrusted ZIP/XML input, two Confluence body models, multi-step publication, annotations, attachment identity, and a young parser dependency

> **Executor instructions:** Read this plan completely before changing code. Follow the tasks in dependency order and run every named verification gate. A checkbox is evidence of a completed, passing check, not an estimate. Record exact commands, versions, counts, fixture digests, live E2E page titles, and cleanup results in `specs/import-docx-mvp/EVIDENCE.md`. If a STOP condition occurs, stop and update this plan before improvising.

---

## 1. Outcome

AtlCLI shall import a local `.docx` file into a new Confluence page while preserving as much document meaning as the target edition can represent. The first public path is the CLI:

```bash
atlcli wiki import ./handbook.docx \
  --format docx \
  --profile mayflower \
  --space DOCSY \
  --title "Imported handbook" \
  --parent 123456 \
  --comments auto \
  --revisions accept \
  --json
```

The MVP is successful only when all of the following are true:

1. A real DOCX feature-zoo is parsed into a loss-aware, consumer-neutral intermediate model.
2. Confluence Cloud receives an `atlas_doc_format` page body through REST v2 for every feature that has a proven native ADF mapping.
3. Confluence Data Center receives Storage XHTML through the existing REST v1 content API, including context-path handling.
4. Images and other supported binary assets are uploaded as page attachments and referenced by the final page body.
5. Word comments are imported as Cloud inline comments when their anchors can be proven; unsupported or ambiguous annotations follow an explicit, reportable fallback policy.
6. No unsupported DOCX construct disappears silently. Every degradation has a stable issue code, source location, severity, and fallback outcome.
7. The core parser/normalizer/encoders are isomorphic and proven in Bun, Node, and a neutral browser Worker. The Chrome extension itself is explicitly deferred.
8. Interactive CLI use is review-first: it renders a local, target-aware preview from the exact publication plan, exposes every degradation, and requires approval before the first Confluence write. `--confirm` is the explicit direct-import override; it never bypasses safety validation or hard blockers.
9. The same deterministic override file and preview model work in Bun, Node, the CLI HTML preview, and the neutral browser harness, so a later browser UI can edit mappings without inventing another import path.
10. DOCX comment attribution survives the fact that Confluence creates every imported comment as the authenticated AtlCLI actor. The platform actor and original document attribution remain distinct, and the existing DOCX exporter can reconstruct Word authors, anchors, threads, dates, and resolution without treating literal names as Confluence identities.
11. Users may explicitly retain the byte-identical input DOCX as a page attachment. Visible reference is a separate exclusive choice: `none` by default, a link section at the page footer, or a page-level comment linking the attachment. The choice is previewed, digest-bound, read back, and never silently degraded.
12. The built CLI passes an automated live E2E against profile `mayflower`, space `DOCSY`, reads the page back, exports it to DOCX with comments, reimports that DOCX, proves the semantic/comment roundtrip, source-attachment behavior, and removes every created resource in `finally` cleanup.
13. Data Center ships as **implemented · contract-tested · not project-live-certified**: exact REST v1/Storage/auth/context-path/attachment/comment/readback/rollback contracts are automated, while the reusable live harness remains optional for community-operated DC environments and does not block release.

The feature is **create-only** in this MVP. Updating, merging, or replacing an existing page is out of scope because it adds content-diff, comment-reanchoring, attachment-collision, and rollback semantics that deserve a separate plan.

---

## 2. Product and platform decisions

### 2.1 Supported Confluence editions and evidence levels

The supported target matrix for this plan is **Cloud and Data Center**, with deliberately different evidence levels:

| Edition | Product status | Required evidence for release | Runtime behavior |
|---|---|---|---|
| Cloud | implemented, live-certified | local/unit/contract/browser gates plus built-CLI live E2E in `mayflower`/`DOCSY` | enabled for Cloud profiles |
| Data Center | implemented · contract-tested · not project-live-certified | exact local HTTP/Storage/auth/context-path/roundtrip/error/rollback contracts; optional community live E2E | enabled for Data Center profiles with documented evidence level; no forced Cloud fallback |
| Server | unsupported | none | no distinct deployment type or support claim |

`contract-tested` is a support/evidence statement, not a synonym for experimental or unimplemented. Data Center users receive the complete planned Storage/v1 path; AtlCLI simply does not claim that the maintainers ran it against a first-party DC tenant. Documentation, preview/report metadata, release notes, and evidence must say **implemented and contract-tested; live validation not maintained by the project** rather than “certified”, “live-tested”, “experimental”, or “pending implementation”.

The repository’s existing Data Center authentication path is retained and regression-tested. That existing user-contributed behavior is useful compatibility evidence, but it does not by itself prove the new page/import flows; those flows require the deterministic contract suite in Task 13. A self-contained optional live harness lets DC operators contribute sanitized version/build/context-path results later without making credentials or tenant access a project prerequisite.

Repository evidence:

- `README.md:18` advertises Cloud and Data Center.
- `packages/core/src/types.ts:10` defines `DeploymentType = "cloud" | "data-center"`.
- `apps/cli/src/commands/auth.ts:89-96` accepts only those two values and rejects `--deployment server`.
- Some older/current user docs use the phrase “Server/Data Center” for bearer/PAT authentication. That is compatibility wording, not a third typed or certified deployment target.

Confluence Server therefore receives **no separate support promise** in this plan. A legacy Server instance may happen to work through the Data Center/storage path, but that is best-effort compatibility and must not appear as a tested edition in CLI output or documentation. Atlassian ended Server support in 2024; restoring a distinct AtlCLI Server contract would require a separate support decision, version matrix, profiles, and independently operated validation.

### 2.2 Body representation is selected by capability, not by a global converter

| Target | Write API | Body representation | Rationale |
|---|---|---|---|
| Confluence Cloud | REST v2 `/api/v2/pages` | `atlas_doc_format` | Native Cloud editor model; preserves tables, panels, expand nodes, marks, and future inline semantics without an intermediate XHTML conversion. |
| Confluence Data Center | REST v1 `/rest/api/content` | `storage` | DC’s public content API and the existing AtlCLI client are Storage-XHTML based. Context paths must be preserved. |

The import core must never emit “generic Confluence HTML” and hope both platforms interpret it the same way. The Cloud ADF encoder and DC Storage encoder are separate implementations consuming the same neutral import document.

### 2.3 Parser selection

Use an exact, lockfile-pinned version of `@office-open/docx` as the first parser adapter. The research baseline was `0.10.13`, but the executor must confirm the then-current version, commit, license, transitive dependency tree, and package contents before adding it.

Why it leads:

- returns structured document JSON rather than flattening immediately to HTML;
- locally proved exact `commentRangeStart` / `commentRangeEnd` markers and comment bodies;
- locally proved structured insertion and deletion nodes;
- parsed the repository’s real golden DOCX under Bun and Node;
- browser-target build was substantially smaller than the universal OfficeParser bundle and had no required DOM.

Why it is hidden behind an adapter:

- it is a young `0.x` dependency with a small maintainer footprint;
- reply/thread metadata may require reading `commentsExtended.xml` directly;
- browser packaging still needs permanent runtime evidence;
- raw library types must not leak into AtlCLI’s public contract.

Mammoth is not a production dependency for this MVP. It may be used temporarily during the spike as a comparison oracle, but it must not define the IR or target output because its HTML path loses exact comment ranges and tracked-deletion semantics.

### 2.4 No silent loss

Every source construct ends in exactly one outcome:

```text
native       — represented natively in the target format
approximated — represented with an explicit, documented approximation
attached     — preserved as an attachment or image fallback
reported     — omitted from the page but present in the import report
rejected     — the import stops before publishing because safe handling is impossible
```

“Parser ignored it” is never a valid outcome.

### 2.5 Browser extension and Forge are deferred, not forgotten

This MVP does **not** add:

- extension file picker, side-panel UI, progress UI, background/offscreen jobs, permissions, session-auth wiring, or MV3 packaging;
- a Forge manifest, Custom UI, resolver, static-resource bundle, permission scopes, or Marketplace packaging.

It does add permanent portability evidence for the reusable core:

- browser-safe entrypoint;
- no `node:` / `bun:` imports in the browser graph;
- a production Vite build;
- a module Worker parsing a real DOCX and producing IR plus both target representations;
- Node 22/24 and Bun smoke tests.

That evidence is necessary but not sufficient for future Extension or Forge claims. Their CSP, file acquisition, runtime quotas, static assets, permissions, and auth require separate host E2E.

For the deferred browser extension, target identity is not user-selectable. The extension runs beside an active Confluence session and must derive site, base URL/context path, deployment type, space/page context, and available capabilities from the verified host/session adapter. Review displays that target as a locked badge. Missing, unsupported, or contradictory detection blocks import; the UI must not offer a Cloud/Data Center toggle or silently fall back to another encoder. A future Tauri desktop app may add multi-profile target selection/comparison, but that is separate deferred product work.

### 2.6 Preview is a local plan/review boundary

The default preview is a **local semantic Confluence preview**, not an attempted pixel-for-pixel Word renderer and not a temporary remote page. It must answer:

- what page title, destination, body representation, content attachments, optional original-DOCX attachment/reference, document comments, and labels will be created;
- which source features are native, approximated, attached, reported, or rejected for the selected target;
- where every warning occurs in the future wiki page;
- which global or node-specific override produced each decision;
- whether publication is currently allowed, blocked, or allowed only after explicit acceptance of warnings.

The target encoder emits the write body and a target-semantic projection in one operation. The serializable `DocxImportPlanV1`, terminal summary, HTML preview, and publisher all consume that projection. There must be no second “preview converter” whose behavior can drift from the actual import.

Review policy:

| Invocation | Behavior before first Confluence write |
|---|---|
| TTY, neither `--dry-run` nor `--confirm` | Analyze, render preview, ask for approval; default answer is no. |
| `--dry-run` | Analyze and emit preview/report only; never prompt and never write remotely. |
| `--confirm` | Analyze and publish without rendering/prompting unless an output artifact was explicitly requested. Non-blocking warnings are accepted and reported. |
| non-TTY without `--dry-run` or `--confirm` | Fail with a usage error explaining the two explicit modes; never hang waiting for input. |
| any mode with a hard blocker | Stop before publication. Neither `--confirm` nor any override can bypass package safety, invalid OOXML, target payload limits, missing required identity, or an `error` issue. |

Use AtlCLI’s existing `--confirm` vocabulary. Do not add synonymous `--yes`, `--apply`, `--no-preview`, or a general `--force` flag. `--strict` remains orthogonal: it promotes warnings to blockers even when `--confirm` is present.

### 2.7 Portable mapping overrides

Global policy flags cover common decisions, while a versioned `atlcli.docx-import-overrides/1` YAML/JSON document handles reusable style mappings and deterministic node-specific exceptions. Override files contain semantic intents only; they cannot inject raw ADF, Storage XML, HTML, scripts, macros, URLs outside the link policy, or executable content.

Every referenced node uses the stable source-derived ID from `ImportDocument`. Unknown node/style IDs, incompatible actions, duplicate keys, target-inapplicable mappings, and overrides that no longer match the source are validation errors or explicit stale warnings according to the contract in Section 7. A browser shape must be able to export the same schema the CLI reads.

### 2.8 Native Confluence draft preview is optional and deferred

Cloud REST v2 currently exposes draft creation/read/delete semantics, so a later “Preview in Confluence” path may stage the exact ADF/media result remotely. That is not the MVP default: it is already a mutation, needs attachment/comment lifecycle and cleanup proof, and lacks a proven edition-neutral Data Center contract. It must be capability-gated, labeled **remote staged preview**, and covered by its own live E2E before use. Local preview remains the portable baseline.

### 2.9 New external libraries are exact-pinned

Every new direct external production or development dependency introduced by this feature uses an exact manifest version: no `^`, `~`, `latest`, wildcard, Git default branch, or unpinned URL. This includes the DOCX parser and any new ZIP/XML/YAML, schema-validation, sanitization, preview-rendering, browser-harness, or test helper library. Internal AtlCLI packages use the repository’s workspace protocol and are not external pins.

`bun.lock` is committed and `bun install --frozen-lockfile` is a required verification gate. The lockfile pins transitives; do not duplicate the whole transitive graph in package manifests. Use a root override/resolution only for a documented vulnerability or compatibility constraint and record why it is necessary.

Before adding each library, record in `EVIDENCE.md`: exact version, upstream repository/tag or commit, license and transitive-license result, publication provenance/integrity, install scripts/native binaries, unpacked size, browser/runtime surface, vulnerability scan result, and why existing repo/platform code was insufficient. Prefer an owned small renderer/validator over a new dependency when its correctness and security can be tested reasonably.

Dependency upgrades are deliberate maintenance changes: update one logical dependency group, inspect package/lockfile diff, rerun its fixture/security/browser/source-dist-binary gates and live E2E where target behavior can change, then update evidence. Automated dependency PRs must not auto-merge this parser/security-sensitive graph.

### 2.10 Comment actor and document attribution are separate identities

Confluence APIs create a comment as the authenticated platform user; they cannot impersonate the author stored in a DOCX. AtlCLI therefore models two independent facts:

- **actor** — the real Confluence account/user returned by Cloud or Data Center for the remote comment;
- **attribution** — either `native-confluence` or preserved `imported-docx` author/provenance.

An imported DOCX author is a document literal, not a tenant identity. AtlCLI never resolves `"Marcel Hammerschmidt"` to an Atlassian account by display-name matching and never assigns an account ID merely because names coincide. Conversely, a Confluence-native comment without valid import provenance exports with its actual resolved Confluence display name.

Preservation uses layered evidence:

1. a versioned comment content property where the target edition/API proves it;
2. a versioned page-level manifest mapping returned comment IDs to provenance where comment properties are unavailable;
3. an always-present, human-readable first-line fallback marker in the comment body, for example `[DOCX author: Marcel Hammerschmidt] [DOCX created: 2026-01-15T09:30:00Z]`.

The property/manifest is authoritative machine data; the visible marker keeps attribution understandable and recoverable after API/export paths that discard properties. Marker fields have a strict escaped grammar and size limits. Marker-only recovery is labeled `visible-marker` evidence and remains a document attribution, never a verified user identity. The exporter strips a marker from the Word comment body only after the shared parser recognizes it; malformed/lookalike user text remains body text.

Roundtrip provenance includes source document digest, source comment/person/parent IDs, display name, initials, source creation time, resolved state, original range/selected text and occurrence, normalized body digest, and marker version/digest. Email addresses are not copied by default. New Confluence replies without imported provenance use their real Confluence actor; imported replies retain their individual DOCX attribution.

The Confluence→DOCX exporter must write standard OOXML comment author/initial/date/range fields and, where proven, threaded/resolved extension parts. It may add an AtlCLI-owned custom provenance part for higher-fidelity AtlCLI→AtlCLI replay, but standard Word fields and the Confluence-side provenance contract remain the compatibility baseline. An unknown custom part being stripped by Word/LibreOffice must degrade identity kind only, not lose the visible author name or comment body.

### 2.11 Original source retention is explicit and independent from presentation

The input DOCX may be valuable evidence in its own right: contracts, externally supplied specifications, and documents with revisions/comments can require an immutable baseline while the wiki page becomes the editable working representation. AtlCLI therefore offers explicit source retention, but never uploads the original implicitly.

Two independent decisions are modeled:

1. `attachSource: false | true` — whether to upload the byte-identical accepted input DOCX as a page attachment;
2. `sourceReference: "none" | "footer" | "comment"` — whether and where to expose a visible link to that attachment.

Defaults are `attachSource: false` and `sourceReference: "none"`. With `attachSource: true`, `none` means the original is discoverable only through Confluence’s page attachments. `footer` adds a target-native **Original document** link section at the end of the page. `comment` creates a page-level/footer comment, authored by the authenticated Confluence actor, containing a safe link to the attachment. These reference modes are mutually exclusive. A non-`none` reference requires `attachSource: true`; it never implies an upload because uploading the raw source must remain an explicit user choice.

The source attachment is not an `ImportAsset`: it has the distinct role `original-docx`, retains the exact input bytes, and is never treated as embedded page content or overwritten by a later Confluence→DOCX export. Its provenance records original and remote filenames, SHA-256, byte length, media type, returned attachment identity, import-plan digest, and optional generated reference-comment ID. No local absolute path is stored remotely.

If source retention or a selected visible reference cannot be completed, the requested import contract is unfulfilled: fail, roll back the newly created page by default, and never report a successful import without the requested source artifact/reference. Upload/readback must prove byte equality by downloading within configured budgets and comparing SHA-256. The review explicitly warns that the unchanged original can retain comments, tracked changes, metadata, external links, and safe-but-unsupported embedded content; page permissions govern who can download it. Source retention never bypasses macro/package/relationship safety rejection.

A generated `comment` reference has provenance role `source-reference`, not `document-comment`. Its complete thread, including later replies, is excluded from Word-comment export and document-comment counts by authoritative page-manifest/comment-property identity, never by matching its visible text. If that provenance is missing or corrupt, the exporter must not suppress a user comment heuristically; it treats the root/replies according to normal native-comment policy and emits a provenance issue where detectable.

---

## 3. Current repository state and drift check

### 3.1 Relevant existing seams

| Area | Current state at planned SHA | Consequence |
|---|---|---|
| CLI dispatch | `apps/cli/src/index.ts` delegates `wiki` to `apps/cli/src/commands/wiki.ts`. | Add `wiki import` without growing `page create` into a multi-format command. |
| Page creation | `apps/cli/src/commands/page.ts:270-325` reads Markdown and calls `markdownToStorage`, then `ConfluenceClient.createPage`. | Reuse command conventions (`getFlag`, `fail`, `output`) but create a dedicated import handler/orchestrator. |
| Confluence writes | `packages/confluence/src/client.ts:990-1060` posts/puts only `body.storage` through REST v1. | Introduce a typed body-write contract and Cloud-v2 page methods without breaking existing storage callers or the frozen v1 package surface. |
| Platform model | `packages/core/src/types.ts:10-28` has `cloud | data-center`; URL logic in `confluence-url.ts` preserves DC context paths. | Build a two-target capability matrix. Do not add a Server enum in this spec. |
| Comments | `packages/confluence/src/client.ts:2362-2666` uses Cloud REST v2 footer/inline endpoints for every profile. | Split comment transports by platform before importing Word comments. Existing Cloud behavior must stay green. |
| Comment identity/export | `packages/confluence/src/client.ts:3260-3320` models only one `CommentAuthor`; Cloud parsing currently falls back to `authorId` as `displayName`. `packages/docx/src/export.ts` has no comment input or `comments.xml` writer, and the CLI export path has no `--comments` option. | Add actor-versus-attribution provenance, platform user resolution, OOXML comment writing, and an explicit comment roundtrip path without conflating literal DOCX names with tenant accounts. |
| Export IR | `packages/confluence/src/export-blocks.ts` is isomorphic and consumer-neutral for Confluence→DOCX/PDF export. | Follow its portability and issue-reporting patterns, but do not force richer DOCX-import semantics into `ExportBlock`. |
| Package/API gates | Publishable packages now build `dist`, declarations, conditional `development`/`browser`/`default` exports, API reports/closure classifications, pack checks, and external consumer smokes. Registry publishing is separately prohibited in CI. | Treat `@atlcli/import-docx` as an intentionally classified 0.x package and prove source, packed, file-linked, Node, Bun, and Vite consumption; raw source paths are development-only. |
| DOCX package API | `@atlcli/docx` is at `1.0.0`; its default/browser/node surfaces are frozen and `./internal` remains non-frozen. | Classify comment writer inputs deliberately, update API report/closure evidence, and avoid leaking import or OOXML implementation types through the frozen barrel. |
| Browser gates | `scripts/check-browser-build.ts` builds source entrypoints with the `development` condition and scans for `node:`/`bun:` leaks. | Add the import browser entry and stronger forbidden-runtime scans. |
| Browser E2E | `apps/browser-export-harness` now has a central conformance manifest/registry, generic UI/Playwright loops, output scan, and parity gate. | Register one `docx-import` case in the existing harness; do not create a second Vite app or duplicate its generic runner. |
| CLI packaging proof | `apps/cli/src/commands/export-pdf-build-modes.test.ts` covers source, dist bundle, and compiled binary. | Mirror this pattern with an offline DOCX dry-run smoke. |
| Live E2E convention | `apps/cli/src/commands/export-pdf.e2e.test.ts` is gated by `ATLCLI_E2E=1`; project workflow names `mayflower`/`DOCSY`. | New import E2E owns its pages and must delete them in `finally`, including after failed assertions. |

### 3.2 Mandatory drift check

Before implementation:

```bash
git status --short
git rev-parse HEAD
git log -1 --oneline
rg -n "DeploymentType|createPage\(|updatePage\(|createInlineComment|requestV2|BROWSER_ENTRYPOINTS" \
  packages/core packages/confluence apps/cli scripts
rg -n "wiki import|import-docx|@atlcli/import-docx|@office-open/docx" \
  apps packages specs package.json bun.lock
```

Expected at the planned SHA:

- clean working tree before executor changes;
- `DeploymentType` still has only Cloud/Data Center;
- current `createPage` remains storage/v1-only;
- no existing `wiki import` or `@atlcli/import-docx` implementation;
- Cloud comments still use REST v2 directly;
- no parser dependency already added under another name;
- package/API guards and the centralized browser conformance registry remain present.

STOP and update this plan if another merged change has already introduced an import IR, ADF writer, generic page-body write contract, or edition-specific comment adapter. Reconcile rather than duplicate.

---

## 4. Scope

### 4.1 In scope

- New publish-classified but non-frozen `public-0.x` workspace package `packages/import-docx`, package name `@atlcli/import-docx`; registry publication remains a separate release decision.
- Exact pinned `@office-open/docx` parser adapter behind AtlCLI-owned contracts.
- Safe DOCX/ZIP preflight before any unbounded decompression.
- Isomorphic DOCX bytes→neutral IR parsing and normalization.
- Separate Cloud ADF and Data Center Storage encoders.
- Rich text, headings, lists, tables, links/bookmarks, images, notes, comments, revisions, fields, content controls, text boxes, and safe fallbacks for drawings/equations/charts/embedded objects.
- Typed, allowlisted style-to-semantic/macro mappings.
- Layered DOCX comment provenance in visible body marker plus proven comment/page properties, with platform actor kept separate.
- Optional byte-identical original-DOCX attachment with exclusive `none | footer | comment` visible-reference policy, provenance, download/digest verification, and rollback guarantees.
- A generic page-body write contract and edition capability resolver in `@atlcli/confluence`.
- Transactional create/upload/finalize/comment/readback/rollback orchestration.
- `atlcli wiki import <file>` CLI command with human and stable JSON output.
- Offline unit, fixture, property/invariant, security, packaging, Node/Bun, and neutral browser Worker tests.
- Mandatory live CLI E2E in Cloud `DOCSY`, deterministic Data Center contract/roundtrip suite, and an optional community-operated DC live harness.
- Existing Confluence→DOCX export extended with opt-in `--comments`, standard OOXML comment parts, and import→Confluence→DOCX→reimport comment proof.
- Documentation, troubleshooting, examples, feature matrix, maintenance instructions, and evidence ledger.

### 4.2 Out of scope

- PDF import, OCR, layout detection models, or LLM calls.
- Updating or merging into an existing page.
- Multi-file/batch/folder import.
- Chrome extension, Electron, native desktop, or Forge host implementation.
- Tauri desktop app, multi-profile target chooser, or cross-edition comparison UI.
- Confluence Server certification or a new `server` deployment enum.
- Reconstructing exact Word pagination, columns, margins, headers/footers, floating-object geometry, theme fonts, or print layout in a wiki page.
- Executing VBA, OLE, ActiveX, external templates, remote relationships, or embedded programs.
- Fetching remote images referenced by the DOCX.
- Arbitrary raw ADF, Storage XML, or macro extension payloads supplied by a style-map file.
- Creating arbitrary Marketplace macros whose contracts are tenant/app specific.
- Importing Word permissions, protection, document signatures, mail merge, bibliography databases, or document workflow state.
- Impersonating original DOCX authors as Confluence accounts or resolving document author strings to users by display-name matching. The authenticated user remains the remote actor; original author/date are document attribution and export provenance.

---

## 5. Non-negotiable invariants

1. **Functional core, imperative shell.** Parsing, normalization, mapping, encoding, and comparison are pure byte/data transformations. Filesystem and Confluence calls live in Node/CLI or client adapters.
2. **Bytes at the isomorphic boundary.** Core entrypoints accept `Uint8Array`, never `Buffer`, filesystem paths, browser `File`, or Bun-specific types.
3. **No parser types escape.** `@office-open/docx` values are translated at one adapter boundary. No public type imports that package.
4. **No silent drop.** Every unsupported/approximated node yields an `ImportIssue` with stable code and source provenance.
5. **Deterministic output.** Identical bytes + options + target capabilities produce structurally identical IR/body/report. Run IDs, timestamps, and remote IDs live only in the imperative result envelope.
6. **Target separation.** Cloud ADF and DC Storage are distinct encoders. No `if (cloud)` branches inside dozens of node serializers; dispatch once at the encoder boundary.
7. **No raw passthrough.** Source XML, parser objects, ADF fragments, and Storage XML are never copied through from untrusted input.
8. **Safe before parse.** ZIP budgets, path validation, content-type validation, and XML DTD/entity rejection happen before the selected parser can inflate/process the archive.
9. **Create-only transaction.** A page created by a failed import is rolled back by default. An existing page is never mutated by this MVP.
10. **Readback proof.** Success means the target accepted the body and a semantic readback matches the publication plan; an HTTP 2xx alone is insufficient.
11. **JSON stdout integrity.** With `--json`, stdout contains exactly one JSON document; progress and diagnostics go to stderr.
12. **Strict mode is pre-publication whenever possible.** Known warnings stop before creating a page. Post-publication strict failures trigger rollback.
13. **DC context paths survive.** Never concatenate `/wiki` manually; use existing `buildConfluenceUrl`/client routing.
14. **Browser portability is measured, not inferred.** Browser-target compilation alone is insufficient; the real package runs in a production Worker E2E.
15. **Evidence labels are exact.** Only Cloud may be labeled `live-certified` after its built-CLI E2E. Data Center is labeled `contract-tested` from its mandatory deterministic suite; optional operator evidence may be recorded as `community-live-validated` metadata but does not silently change the project-maintained support label. Both statuses are tracked independently in preview/report/docs.
16. **Preview and publish share one plan.** The preview projection and target body come from the same encoder result and carry the same semantic digest; no UI/CLI renderer remaps the source independently.
17. **Approval is explicit and bounded.** Interactive approval or `--confirm` may accept non-blocking degradation only. Neither can bypass input safety, hard validation, strict-mode, capability, or plan-integrity failures.
18. **Saved plans are replay guards, not payloads.** Applying `--from-plan` regenerates from the original DOCX and revalidates every digest before any network call.
19. **Overrides are portable data.** CLI and future browser shapes consume/export the same versioned semantic schema; raw target fragments and executable content are impossible by type and validation.
20. **Original upload is explicit.** Source retention defaults off; a visible source reference defaults to `none`, requires an explicitly requested source attachment, participates in the plan digest, and cannot silently degrade. The raw original is never inserted into page content, exported as a Word comment, or substituted for a sanitized import representation.

---

## 6. Target architecture and ownership

### 6.1 Flow

```text
path/stdin (CLI only)
       |
       v
Node DocxSource adapter -----> Uint8Array
                                  |
                                  v
                         safe ZIP/OOXML preflight
                                  |
                                  v
                       @office-open/docx adapter
                                  |
                                  v
                 normalize to ImportDocument + issues
                                  |
                    +-------------+-------------+
                    |                           |
                    v                           v
             CloudAdfEncoder              DcStorageEncoder
           body + semantic projection   body + semantic projection
                    |                           |
                    +-------------+-------------+
                                  |
                                  v
                    PreparedImport + DocxImportPlanV1
                                  |
                    +-------------+-------------+
                    |                           |
                    v                           v
      terminal/static HTML preview       approval policy
         + portable overrides       prompt | dry-run | --confirm
                    |                           |
                    +-------------+-------------+
                                  |
                                  v
                  CLI ConfluenceImportPublisher
         create shell -> optionally upload original -> upload assets
         -> finalize body/optional footer reference
         -> optional source-reference comment -> document comments
         -> provenance properties/manifest
         -> semantic readback -> report

roundtrip export:
Confluence comment actor + attribution resolver
         -> ExportCommentThread + page text range mapping
         -> @atlcli/docx OOXML comment writer
         -> comments.xml + relationships/content types
         -> proven thread/resolution/custom provenance parts
```

### 6.2 Workspace dependencies

```text
@atlcli/core       @atlcli/confluence
      ^                    ^
      |                    |
      +---- @atlcli/import-docx
                     ^
                     |
                  @atlcli/cli

apps/browser-export-harness ---> @atlcli/import-docx/browser
          (registered docx-import conformance case)
```

Allowed dependency edges:

- `@atlcli/import-docx -> @atlcli/core` for shared result/error primitives only when browser-safe;
- `@atlcli/import-docx -> @atlcli/confluence` for typed target body/capability contracts, never the concrete Node client;
- `@atlcli/cli -> @atlcli/import-docx`, `@atlcli/confluence`, and CLI-owned file/stdin adapters;
- existing browser conformance harness -> public browser subpath only.

Forbidden edges:

- import package -> `apps/cli`, `apps/extension`, WXT, Chrome, filesystem, process, or live client;
- confluence package -> import package;
- Cloud encoder -> DC encoder or reverse;
- import IR -> `ExportBlock` by type alias;
- browser harness -> CLI adapters, package internals, or any Node-only subpath;
- arbitrary target XML/JSON fragments from style mappings.

### 6.3 Proposed files

```text
packages/import-docx/
  package.json
  tsconfig.json
  tsconfig.build.json
  README.md
  etc/
    import-docx.api.md
    import-docx.closure.md
  src/
    index.ts
    index.browser.ts
    internal.ts
    model.ts
    options.ts
    issues.ts
    report.ts
    import-plan.ts
    overrides.ts
    preview-model.ts
    preview-terminal.ts
    preview-html.ts
    parse.ts
    parser-port.ts
    adapters/office-open.ts
    ooxml/comments-extended.ts
    ooxml/zip-preflight.ts
    ooxml/xml-policy.ts
    normalize/document.ts
    normalize/paragraphs.ts
    normalize/lists.ts
    normalize/tables.ts
    normalize/assets.ts
    normalize/annotations.ts
    normalize/fields.ts
    style-map.ts
    encode/adf.ts
    encode/storage.ts
    encode/plain-text.ts
    encode/semantic-digest.ts
    publication-plan.ts
  tests/
  testdata/
    fixtures/
    expected/
    MANIFEST.json

packages/confluence/src/
  page-body.ts
  capabilities.ts
  import-publisher.ts
  semantic-readback.ts
  comment-provenance.ts
  comment-author-resolver.ts

apps/cli/src/commands/
  import.ts
  import-request.ts
  import-report.ts
  import-preview.ts
  import-plan-file.ts
  import-source.ts                  (CLI-owned file/stdin adapter)
  import-docx-build-modes.test.ts
  import-docx.e2e.test.ts
  export.ts                         (extend existing command with --comments)

packages/docx/src/
  comments.ts
  comment-provenance.ts
  export.ts                         (accept resolved comment threads)

apps/browser-export-harness/src/
  docx-import-case.ts
  docx-import-worker.ts
  conformance-manifest.ts           (add one case)
  conformance-registry.ts           (add one runner)

scripts/
  check-import-dependency-pins.ts
  api-closure.ts                    (add reviewed 0.x decision)
  consumer-smoke*.ts                (extend package/Node/Vite coverage)
```

Internal filenames may change only if ownership and dependency directions remain intact and this plan is updated before implementation.

---

## 7. Normative contracts

The exact exported names below are normative for the MVP. Additive internal types are allowed; weakening discriminated unions or replacing them with `any` is not.

### 7.1 Neutral import document

```ts
export interface ImportDocument {
  schema: "atlcli.import-document/1";
  metadata: {
    title?: string;
    subject?: string;
    creator?: string;
    description?: string;
    language?: string;
    createdAt?: string;
    modifiedAt?: string;
    producer?: string;
  };
  blocks: ImportBlock[];
  assets: ImportAsset[];
  annotations: ImportAnnotation[];
  revisions: ImportRevision[];
  notes: ImportNote[];
  issues: ImportIssue[];
  source: {
    format: "docx";
    sha256: string;
    byteLength: number;
    packageParts: number;
  };
}

export type ImportBlock =
  | { id: string; type: "heading"; level: 1 | 2 | 3 | 4 | 5 | 6; content: ImportInline[]; style?: ImportStyleRef; bookmark?: string }
  | { id: string; type: "paragraph"; content: ImportInline[]; style?: ImportStyleRef; align?: "start" | "center" | "end" | "justify"; spacing?: ImportSpacing }
  | { id: string; type: "blockquote"; content: ImportBlock[]; style?: ImportStyleRef }
  | { id: string; type: "codeBlock"; code: string; language?: string; style?: ImportStyleRef }
  | { id: string; type: "callout"; kind: "info" | "note" | "warning" | "tip" | "success" | "error"; title?: ImportInline[]; content: ImportBlock[] }
  | { id: string; type: "expand"; title: ImportInline[]; content: ImportBlock[] }
  | { id: string; type: "list"; ordered: boolean; start?: number; level: number; items: ImportListItem[]; numberingId?: string }
  | { id: string; type: "table"; rows: ImportTableRow[]; columnWidths?: number[]; caption?: ImportInline[] }
  | { id: string; type: "image"; assetId: string; alt?: string; title?: string; widthPx?: number; heightPx?: number; placement: "inline" | "block"; caption?: ImportInline[] }
  | { id: string; type: "rule" }
  | { id: string; type: "pageBreak" }
  | { id: string; type: "footnotes"; items: ImportNoteItem[] }
  | { id: string; type: "macroIntent"; macro: ImportMacroIntent }
  | { id: string; type: "unsupported"; sourceKind: string; fallbackText?: string };

export type ImportInline =
  | { type: "text"; text: string; marks?: ImportMark[]; style?: ImportStyleRef }
  | { type: "link"; target: ImportLinkTarget; content: ImportInline[] }
  | { type: "lineBreak" }
  | { type: "tab" }
  | { type: "bookmark"; name: string }
  | { type: "noteRef"; noteId: string; noteKind: "footnote" | "endnote" }
  | { type: "change"; revisionId: string; change: "insert" | "delete"; content: ImportInline[] };

export type ImportMark =
  | { type: "strong" }
  | { type: "em" }
  | { type: "underline" }
  | { type: "strike" }
  | { type: "code" }
  | { type: "subsup"; value: "sub" | "sup" }
  | { type: "textColor"; color: `#${string}` }
  | { type: "backgroundColor"; color: `#${string}` };
```

Rules:

- Every block has a stable deterministic ID derived from source part + structural path, not random generation.
- Text is normalized to Unicode NFC, but whitespace, non-breaking spaces, line breaks, and tabs retain semantic intent.
- Unknown source styles remain in `ImportStyleRef` even if no target mapping exists.
- Layout values that the wiki cannot express remain provenance/report data; they are not silently discarded.
- `ImportDocument` is richer than `ExportBlock` by design. Any later unification must prove it preserves annotations, revisions, paragraph styles, list numbering, footnotes, and source provenance.

### 7.2 Assets

```ts
export interface ImportAsset {
  id: string;
  kind: "image" | "embedded-file" | "fallback-preview";
  filename: string;
  mediaType: string;
  bytes: Uint8Array;
  sha256: string;
  sourcePart: string;
  relationshipId?: string;
  widthPx?: number;
  heightPx?: number;
  alt?: string;
}
```

- Filename sanitation is target-independent and deterministic.
- Duplicate source names are resolved with a digest suffix; different bytes never overwrite each other.
- Identical bytes are uploaded once and may be referenced multiple times.
- Unsupported embedded files are not uploaded by default; their existence and metadata are reported.

### 7.2.1 Original source artifact

```ts
export type SourceReferenceMode = "none" | "footer" | "comment";

export type SourceArtifactPlanV1 =
  | {
      attach: false;
      reference: "none";
    }
  | {
      attach: true;
      role: "original-docx";
      reference: SourceReferenceMode;
      originalFilename: string;
      uploadFilename: string;
      mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
      sha256: string;
      byteLength: number;
    };

export interface SourceArtifactProvenanceV1 {
  schema: "atlcli.docx-source-artifact/1";
  role: "original-docx";
  originalFilename: string;
  remoteFilename: string;
  mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  sha256: string;
  byteLength: number;
  attachmentId: string;
  planDigest: string;
  reference: {
    mode: SourceReferenceMode;
    commentId?: string;
  };
}
```

`SourceArtifactPlanV1` is metadata only and is serialized into `DocxImportPlanV1`; its bytes live only in `PreparedImport`. `attach: false` can only pair with `reference: "none"`. `footer` changes the target body/preview/semantic digest. `comment` does not change the body digest, but its exact planned comment intent and reference mode change the plan digest.

The page property key is `atlcli.docx-source-artifact.v1`. Its value is schema/size validated and written only after the returned attachment identity and optional source-reference comment ID are known. The normalized upload result supplies the link target; filenames are escaped/encoded once at the target adapter and never interpolated as raw ADF/Storage/comment markup.

The source attachment uses the accepted input bytes, not a parser reserialization. It is uploaded once, downloaded for bounded SHA-256 verification, and kept separate from deduplicated content assets. A future export may read it as a baseline but must never replace or version it implicitly.

### 7.3 Annotations and revisions

```ts
export interface ImportPoint {
  blockId: string;
  textOffset: number;
}

export interface ImportRange {
  start: ImportPoint;
  end: ImportPoint;
  exactText: string;
}

export interface DocumentCommentAuthor {
  displayName: string;
  initials?: string;
  sourcePersonId?: string;
}

export interface ImportAnnotation {
  id: string;
  kind: "comment";
  sourceAuthor?: DocumentCommentAuthor;
  createdAt?: string;
  resolved?: boolean;
  parentId?: string;
  range?: ImportRange;
  body: ImportBlock[];
}

export interface ImportRevision {
  id: string;
  change: "insert" | "delete" | "move-from" | "move-to" | "property-change";
  author?: string;
  createdAt?: string;
  range?: ImportRange;
}

export interface DocxCommentProvenanceV1 {
  schema: "atlcli.docx-comment-provenance/1";
  source: {
    documentSha256: string;
    commentId: string;
    parentCommentId?: string;
  };
  sourceAuthor: DocumentCommentAuthor;
  sourceCreatedAt?: string;
  sourceResolved?: boolean;
  sourceRange?: {
    exactText: string;
    occurrence?: number;
    startBlockId?: string;
    endBlockId?: string;
  };
  sourceBodySha256: string;
  marker: { version: 1; digest: string };
}

export interface ConfluenceCommentActor {
  kind: "confluence-user";
  displayName: string;
  accountId?: string;
  userKey?: string;
  username?: string;
}

export type CommentAttribution =
  | { kind: "native-confluence" }
  | {
      kind: "imported-docx";
      evidence: "comment-property" | "page-manifest" | "visible-marker";
      provenance: DocxCommentProvenanceV1;
    };

export interface ResolvedConfluenceComment {
  id: string;
  role: "document-comment" | "source-reference";
  actor: ConfluenceCommentActor;
  attribution: CommentAttribution;
  bodyWithoutAttributionMarker: string;
  bodyModifiedAfterImport: boolean;
  createdAt: string;
  resolved: boolean;
  parentId?: string;
  currentRange?: { exactText: string; matchCount?: number; matchIndex?: number };
  replies: ResolvedConfluenceComment[];
}
```

Comment ranges must be reconstructed from start/end markers, not guessed from the comment reference position. Reply and resolved metadata must be supplemented from OOXML extension parts when the primary parser omits it.

Property keys are fixed as `atlcli.docx-comment-provenance.v1` for per-comment data and `atlcli.docx-import-comments.v1` for the page fallback manifest. Values are size-bounded JSON conforming exactly to the schema above; unknown fields/versions are ignored with an issue, never trusted through casting.

The `source-reference` role comes only from valid `atlcli.docx-source-artifact/1` provenance referencing the returned comment ID. It has normal `native-confluence` actor attribution but is filtered before document-comment export/counting. Visible text such as “Original document” is never sufficient evidence for this role.

The visible marker serializer/parser is shared by Cloud, Data Center, export, and tests. It emits one leading attribution paragraph with escaped author and optional ISO timestamp. It normalizes control characters and length but the property retains the exact normalized source display name. A recognized marker is removed from `bodyWithoutAttributionMarker`; malformed marker-like text is retained.

If standard OOXML omits/empties the author, normalize it to the explicit document literal `Unknown DOCX author` and emit `comment-author-missing`; never substitute the authenticated Confluence actor or document creator.

Export author resolution is deterministic:

1. valid `imported-docx` attribution → standard Word author/initial/date come from provenance;
2. otherwise → Word author comes from the resolved Confluence actor display name, with initials derived deterministically only when absent;
3. never infer/import a Confluence account from a document display name;
4. if current comment body no longer matches `sourceBodySha256`, export the current body with preserved source attribution and emit `imported-comment-body-modified`; do not guess an editor identity.

### 7.4 Issues and provenance

```ts
export interface ImportIssue {
  severity: "info" | "warning" | "error";
  code: string;
  message: string;
  outcome: "native" | "approximated" | "attached" | "reported" | "rejected";
  source?: {
    part?: string;
    blockId?: string;
    path?: string;
    styleId?: string;
    relationshipId?: string;
  };
  target?: "cloud-adf" | "data-center-storage";
}
```

Stable initial issue codes include:

```text
unsupported-node
unsupported-field
external-relationship-blocked
embedded-object-skipped
image-format-unsupported
image-preview-used
floating-layout-flattened
textbox-order-approximated
page-break-approximated
header-footer-omitted
comment-anchor-ambiguous
comment-anchor-cross-block
inline-comment-demoted
comment-thread-flattened
comment-author-preserved-as-provenance
comment-author-missing
comment-provenance-property-unavailable
comment-provenance-manifest-fallback
comment-provenance-marker-only
comment-provenance-invalid
comment-actor-unresolved
imported-comment-body-modified
comment-range-reanchored
comment-range-export-fallback
source-attachment-upload-failed
source-attachment-readback-mismatch
source-reference-create-failed
source-reference-provenance-invalid
revision-accepted
revision-rejected
revision-markup-approximated
macro-intent-deferred
style-unmapped
font-substitution
limit-exceeded
invalid-ooxml
unsafe-package
target-readback-mismatch
rollback-failed
override-schema-invalid
override-node-unmatched
override-action-inapplicable
preview-plan-mismatch
saved-plan-stale
approval-required
```

### 7.5 Target capability contract

```ts
export interface ConfluenceImportCapabilities {
  deployment: "cloud" | "data-center";
  supportEvidence: "live-certified" | "contract-tested";
  pageApi: "cloud-v2" | "content-v1";
  bodyRepresentation: "atlas_doc_format" | "storage";
  attachments: "cloud-file-id" | "storage-filename";
  inlineComments: "cloud-v2" | "unsupported";
  footerComments: "cloud-v2" | "content-v1";
  commentReplies: "cloud-v2" | "content-v1" | "unsupported";
  commentProperties: "cloud-v2" | "content-v1" | "unsupported";
  pageProperties: "cloud-v2" | "content-v1";
  commentActorResolution: "cloud-account-id" | "data-center-user";
  macros: Readonly<Record<ImportMacroKind, "native" | "extension" | "storage-macro" | "unsupported">>;
}
```

Capability selection is deterministic from the profile’s `DeploymentType`. Cloud releases set `live-certified` only after Task 12 evidence; Data Center sets `contract-tested` after Task 13 and never upgrades itself based on an arbitrary successful user request. HTTP 404 probing must not silently switch Cloud to DC or vice versa. A narrowly documented capability probe may refine a version-dependent DC feature, but the resulting decision and server version, when observable, must appear in the report.

### 7.6 Target-semantic preview projection

The encoder result must include a semantic projection of the **target result after documented approximations**. Terminal/HTML previews render this projection; they do not independently reinterpret raw `ImportDocument` and do not parse the emitted ADF/Storage back into another ad-hoc model.

```ts
export type ImportOutcome = "native" | "approximated" | "attached" | "reported" | "rejected";

export interface ImportPreviewNode {
  id: string;
  sourceBlockId?: string;
  kind:
    | "heading" | "paragraph" | "blockquote" | "codeBlock" | "callout" | "expand"
    | "list" | "listItem" | "table" | "tableRow" | "tableCell" | "image"
    | "rule" | "footnotes" | "macro" | "attachment" | "commentAnchor" | "unsupported";
  outcome: ImportOutcome;
  text?: string;
  targetKind?: string;
  issueCodes: string[];
  overrideId?: string;
  children?: ImportPreviewNode[];
}

export interface ImportPreviewDocument {
  schema: "atlcli.docx-import-preview/1";
  target: "cloud-adf" | "data-center-storage";
  nodes: ImportPreviewNode[];
  semanticDigest: string;
}
```

Requirements:

- Every visible target block and attachment placeholder maps back to a stable source block/asset ID when one exists.
- Every issue that affects visible output is attached to at least one preview node; document-level issues are shown in a separate summary.
- Comment preview shows document attribution (author/date/range/fallback) separately from “remote actor: authenticated profile/session”; dry-run never fabricates or fetches a display name merely for preview.
- The preview semantic digest equals the expected pre-publication readback digest after remote asset IDs are normalized to source asset IDs.
- HTML rendering is deterministic, self-contained, offline, and display-only. It escapes source strings, uses no remote resources, performs no network requests, executes no DOCX content, and carries a restrictive CSP. Interactive filtering/highlighting may use only AtlCLI-owned static code.
- The terminal preview is a compact summary plus ordered issues, not a lossy replacement for `--json` or the HTML artifact.

### 7.7 Portable override contract

```ts
export interface DocxImportOverridesV1 {
  schema: "atlcli.docx-import-overrides/1";
  defaults?: {
    comments?: "auto" | "inline" | "footer" | "append" | "skip";
    revisions?: "accept" | "reject" | "markup";
    pageBreaks?: "omit" | "rule";
    unsupported?: "report" | "attach" | "fail";
  };
  styles?: Record<string, ImportStyleOverride>;
  nodes?: Record<string, ImportNodeOverride>;
}

export type ImportStyleOverride =
  | { mapTo: "paragraph" | "blockquote" | "expand" }
  | { mapTo: "codeBlock"; language?: string }
  | { mapTo: "heading"; level: 1 | 2 | 3 | 4 | 5 | 6 }
  | { mapTo: "callout"; kind: "info" | "note" | "warning" | "tip" | "success" | "error" }
  | { mapTo: "macroIntent"; macro: "toc" };

export type ImportNodeOverride =
  | { action: "use-default" }
  | { action: "map"; intent: ImportStyleOverride }
  | { action: "flatten" }
  | { action: "attach" }
  | { action: "report" }
  | { action: "reject" };
```

Rules:

- Style IDs and node IDs are source identifiers, never translated display labels alone.
- Precedence is node override → style override → explicit CLI global policy → override defaults → built-in defaults. Two values at the same precedence are an error.
- `--style-map` is an ergonomic shorthand for a style-only `atlcli.docx-import-overrides/1` file. It cannot be combined with `--overrides`; there is one internal validator and merge engine.
- `use-default` intentionally suppresses a broader style override for that node and remains visible in provenance.
- `attach` is valid only when a safe, finite attachment/fallback asset exists. It cannot turn VBA/OLE/executable content into an upload.
- Unknown or duplicate keys, impossible actions, schema-version mismatch, and target-inapplicable native mappings fail validation before publication.
- Unmatched node IDs are stale-plan warnings by default and errors under `--strict`; matched override IDs appear on preview nodes and in the report.
- YAML is parsed with duplicate-key rejection and schema validation. Anchors/aliases, custom tags, executable types, and merge keys are rejected unless separately security-reviewed.

### 7.8 Page body, serializable import plan, and prepared publication

```ts
export type ConfluencePageBodyWrite =
  | { representation: "atlas_doc_format"; value: string }
  | { representation: "storage"; value: string };

export interface DocxImportPlanV1 {
  schema: "atlcli.docx-import-plan/1";
  source: { sha256: string; byteLength: number; basename?: string };
  inputs: {
    optionsDigest: string;
    overridesDigest?: string;
    capabilitiesDigest: string;
  };
  target: ConfluenceImportCapabilities;
  destination: { title: string; spaceKey: string; parentId?: string; labels: string[] };
  publication: {
    representation: "atlas_doc_format" | "storage";
    bodyDigest: string;
    sourceArtifact: SourceArtifactPlanV1;
    assets: Array<{ id: string; filename: string; mediaType: string; sha256: string; byteLength: number }>;
    comments: Array<{ id: string; mode: "inline" | "footer" | "append" | "skip"; sourceBlockId?: string }>;
  };
  preview: ImportPreviewDocument;
  issues: ImportIssue[];
  review: {
    publishable: boolean;
    warningCount: number;
    blockingIssueCodes: string[];
    appliedOverrideIds: string[];
    unmatchedOverrideIds: string[];
  };
  planDigest: string;
}

export interface PreparedImport {
  plan: DocxImportPlanV1;
  shellBody: ConfluencePageBodyWrite;
  sourceArtifact?: {
    plan: Extract<SourceArtifactPlanV1, { attach: true }>;
    bytes: Uint8Array;
  };
  assets: ImportAsset[];
  finalize: (uploaded: readonly UploadedAsset[], source?: UploadedSourceArtifact) => ConfluencePageBodyWrite;
  sourceReferenceComment?: PlannedSourceReferenceComment;
  comments: PlannedComment[];
}

export interface ImportApproval {
  mode: "interactive" | "confirmed" | "saved-plan";
  planDigest: string;
  acceptedWarningCodes: string[];
}
```

`DocxImportPlanV1` contains no asset bytes, function values, credentials, auth headers, absolute paths by default, remote IDs, timestamps, or tenant response bodies. `PreparedImport` is process-local and never written as JSON.

`--plan-out` atomically writes the serializable plan. `--from-plan <file>` always requires the original DOCX path, rebuilds `PreparedImport` from current bytes/options/overrides/capabilities, and compares source, input, body, semantic, and plan digests before approval. It never trusts serialized ADF/Storage or uploads from the plan file. Stale/mismatched plans fail before any network mutation; there is no override for this TOCTOU gate.

The publisher requires both `PreparedImport` and `ImportApproval`; it rejects a missing approval, digest mismatch, unlisted warning, or non-publishable plan before invoking the Confluence port. `--dry-run` never creates an `ImportApproval`.

### 7.9 Report schema

```ts
export interface DocxImportReportV1 {
  schema: "atlcli.docx-import-report/1";
  status: "previewed" | "dry-run" | "created" | "failed" | "rolled-back" | "partial";
  source: { path?: string; sha256: string; byteLength: number };
  target: {
    deployment: "cloud" | "data-center";
    supportEvidence: "live-certified" | "contract-tested";
    representation: "atlas_doc_format" | "storage";
    profile?: string;
    spaceKey: string;
    pageId?: string;
    pageUrl?: string;
  };
  coverage: Record<string, { source: number; native: number; approximated: number; omitted: number }>;
  assets: { planned: number; uploaded: number; deduplicated: number; failed: number };
  sourceArtifact: {
    requested: boolean;
    reference: SourceReferenceMode;
    status: "not-requested" | "planned" | "uploaded" | "verified" | "failed";
    originalFilename?: string;
    remoteFilename?: string;
    attachmentId?: string;
    sha256?: string;
    commentId?: string;
  };
  comments: {
    source: number;
    inline: number;
    footer: number;
    appended: number;
    skipped: number;
    attribution: {
      commentProperty: number;
      pageManifest: number;
      visibleMarker: number;
      bodyModifiedAfterImport: number;
    };
  };
  revisions: { source: number; policy: "accept" | "reject" | "markup" };
  review: {
    mode: "interactive" | "dry-run" | "confirmed" | "saved-plan";
    planDigest: string;
    previewFormat?: "terminal" | "html" | "json";
    acceptedWarnings: number;
    appliedOverrideIds: string[];
    unmatchedOverrideIds: string[];
  };
  issues: ImportIssue[];
  timings: {
    readMs: number;
    preflightMs: number;
    parseMs: number;
    normalizeMs: number;
    encodeMs: number;
    publishMs?: number;
    readbackMs?: number;
    totalMs: number;
  };
  cleanup?: { attempted: boolean; pageDeleted: boolean; error?: string };
}
```

No absolute source path is emitted unless explicitly requested in JSON; default output uses the basename to avoid leaking local filesystem structure into CI logs.

`comments.*` counts only document comments. The generated source-reference comment is represented solely under `sourceArtifact.commentId`/reference mode so UX, telemetry, and DOCX export cannot conflate it with imported or native discussion. Dry-run uses `sourceArtifact.status: "planned"` when requested and never fabricates attachment/comment IDs.

---

## 8. Feature coverage contract

Legend: **N** native, **A** approximation, **R** report/omit, **G** gated by proof, **D** deferred.

| DOCX feature | Neutral IR | Cloud ADF | DC Storage | MVP policy and required evidence |
|---|---:|---:|---:|---|
| Unicode text, whitespace, NBSP | N | N | N | Exact text digest fixture incl. emoji, RTL samples, combining characters. |
| Bold, italic, underline, strike | N | N | N | Mark-level golden tests and live readback. |
| Subscript/superscript | N | N | N | ADF `subsup`; Storage `<sub>/<sup>`. |
| Text/background color | N | N | N/A | Validate colors; unsupported theme colors resolved to explicit RGB or warned. |
| Paragraph alignment | N | N/A | N | ADF alignment only where accepted; otherwise approximation issue. |
| Headings 1–6 | N | N | N | Preserve levels; page title is not synthesized from/removes an H1. |
| Custom paragraph/character styles | N | via map | via map | Preserve style ID/name; allowlisted style map; unmapped styles are not errors. |
| External hyperlinks | N | N | N | Reject unsafe schemes; preserve titles/text. |
| Internal bookmarks/anchors | N | G | N | Cloud anchor behavior requires live proof; never emit dead links silently. |
| Bullet lists | N | N | N | Nested 1–9 levels fixture. |
| Ordered lists, starts/restarts | N | N/A | N | Preserve numbering semantics; ADF limitations explicitly reported. |
| Mixed/nested list types | N | N | N | Semantic digest verifies hierarchy, not rendered whitespace. |
| Checkbox/content-control tasks | N/A | G | N/A | Map only proven checkbox controls to task items; otherwise literal glyph + issue. |
| Tables | N | N | N | Header cells, nested blocks, empty cells. |
| `rowspan` / `colspan` | N | N | N | Structural assertions and live readback. |
| Column widths | N | N/A | N/A | Normalize to target constraints; report clamping. |
| Cell shading/alignment | N | N/A | N | Golden target tests. |
| Nested tables | N | G/A | N | Cloud acceptance gate; flatten only with explicit warning if rejected. |
| Inline PNG/JPEG/GIF/WebP | N | G | N | Two-phase upload/reference live proof. Animated GIF remains attachment; no transcoding. |
| SVG | N | G | N | Upload/reference if target accepts; otherwise safe raster fallback only through injected renderer. |
| EMF/WMF | N metadata | A/R | A/R | Prefer package preview; no native decoder in MVP. |
| Floating images/wrap/position | N provenance | A | A | Preserve content order + dimensions; emit `floating-layout-flattened`. |
| Image crop/rotation | N provenance | G/A | G/A | Apply only if deterministic local transform exists; otherwise preserve original and warn. |
| Alt text/title/captions | N | N/A | N/A | Keep alt; captions become adjacent semantic paragraph when no native caption. |
| Footnotes/endnotes | N | A | A | Append generated “Notes” section with backlinks; no silent inline flattening. |
| Comments with exact range | N | G/N | A | Cloud inline when anchor proof passes; DC footer/append fallback. |
| Comment replies/resolved state | G/N | G/N | G/A | Supplement extension XML; preserve thread/resolution in property/manifest/custom part or named fallback. |
| DOCX author/initials/date | N | A | A | Remote actor stays authenticated user; document attribution uses property → page manifest → visible marker. |
| Confluence→DOCX comment export | `ExportCommentThread` | N | N/A | Imported author uses source attribution; native comment uses resolved platform actor; standard OOXML fields are baseline. |
| Comment import→export→reimport | N digest | G | G/A | Cloud DOCSY live proof mandatory; DC capability/fallback independently contract-proven. |
| Tracked insert/delete | N | policy | policy | `accept` default; `reject` and `markup` tested. Metadata remains in report. |
| Move/property revisions | N/R | A/R | A/R | Preserve/report; no false native claim. |
| `HYPERLINK`, `REF`, `PAGEREF` fields | N | N/A | N/A | Prefer semantic target when resolvable; otherwise visible field result + issue. |
| Word TOC field | `macroIntent` | G | N | Drop generated TOC entries and create target TOC only after macro proof. |
| PAGE/NUMPAGES fields | N metadata | R | R | Wiki has no stable pages; omit generated value with issue. |
| DATE/TIME/doc properties fields | N | A | A | Preserve displayed result, do not evaluate dynamic Word fields. |
| Code-styled paragraphs | N | N | N | Built-in/style-map mapping to ADF code block / DC code macro. |
| Info/note/warning/tip styles | N | N panel | N macro | Style-map driven only; no visual guess based solely on color. |
| Expand style | N | N | N macro | Allowlisted style-map entry. |
| Text boxes/shapes with text | N/A | A | A | Extract text in deterministic document order; report geometry loss. |
| Equations (OMML) | N/R | A/R | A/R | Use safe preview image when present; otherwise readable fallback/issue. |
| Charts/SmartArt | N metadata | A/R | A/R | Prefer embedded preview; attach source workbook only with explicit future option. |
| Headers/footers | N metadata | R | R | Not page body by default; counts and representative text in report. |
| Section/page breaks | N | A/R | A/R | Page break may become rule only with `--page-breaks rule`; default report/omit. |
| OLE/embedded files | N metadata | R | R | Never execute/upload by default. |
| VBA/macros (`.docm`) | reject | reject | reject | Input format rejected; no macro-enabled documents in MVP. |
| External relationships/templates | report | R | R | Never fetched. Hyperlinks preserved only for safe schemes. |

No row may be changed from G/A/R to N without a fixture, target-specific unit assertion, and live target readback evidence.

---

## 9. Semantic mapping rules

### 9.1 Title resolution

Title precedence:

1. explicit `--title`;
2. non-empty DOCX core property `dc:title`;
3. sanitized filename stem.

A `Title`-styled paragraph or first H1 remains in the body. Automatic removal is surprising and prohibited in the MVP. Report the selected source as `titleSource`.

### 9.2 Style and node overrides

Support the versioned YAML/JSON contract from Section 7.7. A style-only file may use the ergonomic `--style-map` flag; full global/style/node policy uses `--overrides`:

```yaml
schema: atlcli.docx-import-overrides/1
defaults:
  comments: auto
  revisions: accept
styles:
  CodeBlock:
    mapTo: codeBlock
    language: typescript
  InfoBox:
    mapTo: callout
    kind: info
  Collapsible:
    mapTo: expand
nodes:
  "docx:word/document.xml#/body/tbl[7]":
    action: flatten
```

Rules:

- User style keys match exact source style IDs. Preview/report show both ID and display name so users can author mappings without relying on localized/non-unique names.
- Built-ins may recognize Word semantic/outline metadata and known built-in style IDs; explicit node/style overrides take precedence according to Section 7.7.
- Mapping actions are the typed discriminated allowlist (`heading`, `paragraph`, `blockquote`, `codeBlock`, `callout`, `expand`, `macroIntent: toc`, `flatten`, `attach`, `report`, `reject`, `use-default`).
- Raw ADF nodes, raw Storage XML, arbitrary macro keys, JavaScript expressions, remote URLs, and template execution are forbidden.
- Validation errors include YAML/JSON path, source style/node context, expected values, and a minimal example.
- `--strict` treats unknown mapping actions and unmapped explicitly required styles as pre-publication failures.
- The canonicalized override document and applied/unmatched IDs contribute to `overridesDigest` and `planDigest`; any change invalidates a saved review plan.

### 9.3 Macro intents

The MVP may produce only these semantic intents:

| Intent | Cloud | Data Center |
|---|---|---|
| `toc` | Proven Confluence ADF extension payload only; otherwise reported/deferred | `<ac:structured-macro ac:name="toc"/>` |
| `info/note/warning/tip` | Native ADF `panel` | Corresponding structured macro |
| `expand` | Native ADF `expand` | `expand` structured macro |
| `code` | Native ADF `codeBlock` | `code` structured macro with CDATA-safe body |
| task list | Proven ADF task nodes | `<ac:task-list>` |

The export-side `@atlcli/export-macros` registry is not inverted or reused. It resolves Confluence macros to export blocks and has different trust/IO semantics.

### 9.4 Comments

Default `--comments auto`:

- Cloud: create an inline comment only when the exact selected text and its occurrence index can be deterministically located in the finalized target body. Create replies after the parent. Preserve original author/date through the Section 2.10 provenance stack because the API comment actor is the authenticated AtlCLI user.
- Data Center: use a footer comment with a quoted selection, block path, original author/date, and reply indentation. Do not call undocumented inline-comment creation payloads.
- Missing/collapsed/ambiguous/cross-block anchor: demote according to platform, emit a warning, and include the original range text.

Modes:

```text
--comments auto     platform-safe default
--comments inline   require every comment to be inline; fail before write if unsupported/ambiguous
--comments footer   create page/footer comments with provenance
--comments append   append an “Imported comments” section to the page
--comments skip     omit from target but include full counts/issues in report
```

Anchor algorithm:

1. Carry exact source start/end positions through normalization.
2. After final target encoding, build the same normalized visible-text projection used by the semantic readback inspector.
3. Locate all occurrences of `exactText`; map the source block/range to the corresponding target occurrence.
4. Send `textSelection`, `textSelectionMatchCount`, and zero-based `textSelectionMatchIndex` only if the mapping is unique and stable.
5. Read back the comment and assert selection/index. Otherwise roll back or demote according to mode before declaring success.

Attribution persistence algorithm:

1. Normalize source author/initials/date/person ID and comment body; compute source body and visible-marker digests.
2. Prefix the remote comment body with the fixed escaped human marker from Section 2.10. The marker is part of remote UX but not part of the logical Word comment body.
3. Create the remote comment and retain its returned ID plus actual platform actor separately.
4. Write `atlcli.docx-comment-provenance.v1` to the comment when the proven target capability allows it. Otherwise add the entry to `atlcli.docx-import-comments.v1` on the page. If both mechanisms are supported, the comment property is primary and the page manifest is a recovery index.
5. Read back body, actor, property/manifest, selection, replies, and resolution. A property/manifest conflict is `comment-provenance-invalid` and fails under strict mode; it never silently chooses a different author.
6. Property failure does not erase the remote comment. Record the exact fallback evidence; default mode may complete with marker/page-manifest degradation, while strict mode rolls back.

#### 9.4.1 Confluence→DOCX comment roundtrip

`atlcli wiki export <page> --format docx --comments --output <file.docx>` becomes the explicit opt-in exporter path. It must:

1. fetch inline/footer comments, replies, resolution, properties/page manifest, and actual platform actors;
2. resolve each `ResolvedConfluenceComment` using the evidence order in Section 7.3;
3. for `imported-docx`, use the preserved document author/initials/date; for `native-confluence`, use the resolved platform display name and never an account ID as visible Word author;
4. strip exactly one recognized attribution marker from the exported comment body and retain malformed/lookalike text;
5. map a current inline selection first, otherwise safely reanchor the preserved source text/occurrence against the exported semantic document;
6. emit `word/comments.xml`, required relationships/content types, range start/end/reference markup, and schema-valid unique numeric IDs;
7. emit proven threaded/resolved OOXML extension parts when available. Otherwise flatten replies in a documented order with author labels, retain full structure in the AtlCLI custom provenance part, and emit `comment-thread-flattened`;
8. place native footer or otherwise unanchorable comments in a generated final “Unanchored comments” section with explicit `comment-range-export-fallback`, rather than silently dropping them or attaching them to unrelated text;
9. optionally write `customXml/atlcli-comment-provenance.xml` plus the required relationship/content type, mapping Word comment IDs to attribution kind, Confluence actor reference, source IDs, thread, resolution, and digests. This part is inert data, contains no tokens/email by default, and is never required for standard Word readability;
10. on reimport, prefer a valid AtlCLI custom part to recover identity kind/thread metadata, then verify it against standard comment fields/body/ranges. If absent/stripped/invalid, standard Word author/body/range remain authoritative document literals and an issue records the fidelity loss.

Roundtrip equality is semantic, not remote-ID equality. Compare ordered thread topology, logical body without the marker, effective Word author/initials/date, resolution, selected text/occurrence or named fallback, and attribution kind where the custom part survives. Confluence IDs, Word numeric IDs, run IDs, and API timestamps are normalized away.

### 9.5 Revisions

```text
--revisions accept  include insertions, exclude deletions (default)
--revisions reject  exclude insertions, include deletions
--revisions markup  include both; insertion/deletion use explicit target marks and a legend
```

`markup` is an approximation, not native Word change tracking. Original author/date/change kind stay in `ImportDocument.revisions` and the report. A source document with changes always produces at least one informational issue so users know which policy was applied.

### 9.6 Images and attachment identity

Publication is two-phase because assets need a page container:

1. Create an import shell page.
2. Upload deduplicated assets in deterministic source order.
3. Resolve Cloud attachment `fileId`/ADF media identity or DC filename references.
4. Encode and update the final body.

The Cloud `fileId` and required media collection mapping must be proved in Task 0 against DOCSY. Do not assume the v1 attachment content ID equals the ADF media services ID. If the official/readback contract cannot be made deterministic, Cloud image support remains gated and the executor stops for a plan decision instead of silently switching the whole Cloud page to Storage.

### 9.7 Footnotes, fields, text boxes, drawings

- Footnotes/endnotes become a deterministic final section with stable anchors/backlinks where the target supports them.
- Word-generated TOC paragraphs are not imported as stale duplicate text when a target TOC intent is emitted.
- Dynamic page-number fields are omitted with an issue; their cached values are not meaningful in Confluence.
- Textbox text is inserted at its drawing anchor in document order. Geometry, overlap, and wrapping are reported.
- Equations/charts/SmartArt prefer a package-provided preview image. If no safe preview exists, emit readable alt/fallback text and an issue.
- Header/footer content is counted and summarized in the report, not merged into the wiki body by default.

---

## 10. CLI UX and DX contract

### 10.1 Command shape

```text
atlcli wiki import <source.docx|-> [options]

Required/resolved target:
  --space <key>              Target space; falls back to profile/config default

Identity and placement:
  --title <title>            Explicit page title
  --parent <page-id>         Optional parent
  --label <name>             Repeatable label applied after successful body finalize

Import behavior:
  --format docx              Optional when extension identifies .docx; required for stdin
  --overrides <file>         Versioned global/style/node override document
  --style-map <file>         Shorthand for a style-only override document
  --comments <mode>          auto|inline|footer|append|skip (default auto)
  --revisions <mode>         accept|reject|markup (default accept)
  --page-breaks <mode>       omit|rule (default omit)
  --unsupported <mode>       report|attach|fail (default report)
  --attach-source            Upload the byte-identical input DOCX as a page attachment
  --source-reference <mode>  none|footer|comment (default none; footer/comment require --attach-source)
  --source-filename <name>   Required source-attachment filename for stdin
  --strict                   Fail on warnings before publication when possible

Review/approval:
  --dry-run                  Parse, normalize, encode, validate; zero Confluence writes
  --confirm                  Direct import without interactive review/prompt
  --preview <format>         auto|terminal|html (default auto)
  --preview-output <path>    Required for html preview; written atomically
  --open-preview             Open the explicit HTML preview path; requires TTY
  --plan-out <path>          Atomically save atlcli.docx-import-plan/1 JSON
  --from-plan <path>         Rebuild and digest-check a previously reviewed plan

Safety/transaction:
  --keep-failed-page         Do not roll back a newly created shell/partial page

Output/auth:
  --profile <name>
  --json
  --report <path>            Also write report JSON atomically
  --debug
```

Do not expose dozens of ZIP-budget flags in the first public help. Safe defaults live in `ImportLimits`; advanced overrides may use environment/config only after security review and must appear in the report.

Flag rules:

- `--dry-run` and `--confirm` are mutually exclusive.
- stdin (`-`) is non-replayable and consumes the confirmation input; it therefore requires `--dry-run` or `--confirm` and cannot be combined with `--plan-out`/`--from-plan`.
- `--style-map` and `--overrides` are mutually exclusive and feed the same validator.
- `--source-reference footer|comment` requires `--attach-source`; it never implies upload. `none` is the default and produces no page-body block or comment.
- `--attach-source` with a local file preserves its basename as `originalFilename` and derives a target-safe `uploadFilename`. With stdin it requires `--source-filename <name.docx>`; the flag is otherwise invalid. The supplied name is untrusted metadata and follows the same sanitation, length, Unicode, and collision rules.
- `--preview html` requires `--preview-output`; `--open-preview` requires both, a TTY, and explicit user invocation. AtlCLI never opens a browser merely because the command ran interactively.
- `--from-plan` requires the original DOCX path and is incompatible with flags that change title, destination, mapping, comments, revisions, page breaks, unsupported policy, source attachment/reference/filename, labels, or strictness. Auth/profile selection may differ only if the resolved capability/destination digests remain identical.
- `--confirm` may be combined with `--plan-out`, `--report`, or an explicitly requested preview artifact for auditability; it skips only the prompt.
- Do not add synonyms such as `--yes`, `--apply`, `--no-preview`, or `--force`.

### 10.2 Review-mode state machine

```text
analyzed -> planned -> preview-rendered -> approval-requested -> approved -> prepared
                    |                       |
                    |                       +-> declined -> previewed (no writes)
                    +-> dry-run -> dry-run (no writes)

analyzed -> planned -> confirmed -> prepared              (--confirm)
analyzed -> regenerated-and-digest-matched -> approved    (--from-plan)
```

Behavior:

- TTY with neither explicit mode: render terminal preview by default, then ask exactly `Import this page? [y/N]`. Only an affirmative answer publishes. A normal “no” returns a `previewed` report and exit 0; EOF or interrupt follows existing cancellation/interrupt exit behavior and never writes.
- Non-TTY with neither `--dry-run` nor `--confirm`: fail with `approval-required` and an actionable usage message before any Confluence request. Never wait on stdin.
- `--confirm`: do all preflight/planning work, accept and report non-blocking warnings, then publish without preview/prompt unless a preview artifact was explicitly requested.
- `--strict`: any warning blocks before approval in every mode, including `--confirm` and `--from-plan`.
- A hard error, stale saved plan, preview/plan digest mismatch, or unsafe input blocks before approval and has no bypass.

The approved object is the exact `PreparedImport` created before preview. Do not parse or encode again between an in-process interactive preview and publication. If the source file metadata or bytes change before the first write, recompute its digest and stop as `saved-plan-stale`.

### 10.3 Dry-run and saved-plan behavior

`--dry-run` must:

- perform full byte preflight, parse, normalization, target encoding, style-map validation, and report generation;
- select Cloud/DC behavior from the local profile without any HTTP request;
- leave asset IDs as explicit plan placeholders;
- optionally write a developer artifact directory only when `--report` or a future explicit debug flag requests it;
- never create a page, attachment, comment, label, temp file outside a scoped OS temp directory, or cache entry.

A test installs a fetch function that throws on any call and proves dry-run still succeeds.

`--plan-out` writes the canonical JSON serialization of Section 7.8 plus `planDigest`; formatting/key order is deterministic. `--from-plan` parses the file as untrusted input, rejects unknown schema versions/duplicate JSON keys where the parser can detect them, rebuilds the plan from current source and options, and compares every integrity field before prompting or honoring `--confirm`. Saved plans are review evidence, not a cache of trusted target payloads.

### 10.4 Terminal and HTML preview

Terminal output shows destination, target edition/body model/evidence level, feature counts, outcome percentages, content-attachment/comment/revision decisions, original-source retention/reference, ordered warnings/errors, and the plan digest. Issue rows include stable code plus source block/style/node context when available. Data Center displays `contract-tested · not project-live-certified` without turning every run into an interactive warning or requiring an override.

Example before approval:

```text
DOCX import preview — no remote changes

Source       handbook.docx
Destination  DOCSY / Engineering
Target       Confluence Cloud / ADF · live-certified
Title        Engineering Handbook
Plan         7b91…e14c

Content      42 paragraphs · 8 headings · 5 tables · 12 images
Coverage     91% native · 6% approximated · 3% reported
Comments     6 inline · 1 footer fallback
Revisions    3 accepted
Original     handbook.docx → attachment + page comment · 842 KB · SHA-256 4c8e…91af

Warnings
  comment-anchor-ambiguous  Comment 7 → footer fallback  [paragraph-42]
  floating-layout-flattened Image 4 → inline image       [drawing-4]

Import this page? [y/N]
```

The static HTML preview uses `ImportPreviewDocument`, visually marks outcomes, provides issue-to-node anchors, displays macro/attachment placeholders, and identifies itself as **Confluence semantic preview**, not Word fidelity. Original-source retention is a separate summary row showing filename, size, digest, and `none | footer | comment`; `none` reference must not fabricate a visible page node. It embeds no source DOCX bytes and no source asset bytes unless they are explicitly safe image previews within configured output budgets; use sanitized object URLs or data only during generation and never preserve active SVG/script content. Tests load the final file with network disabled and require zero requests, console errors, or executable source content.

### 10.5 Publish progress and final human output

Progress goes to stderr:

```text
Reading handbook.docx
Checking package safety
Parsing document
Mapping 187 blocks, 4 assets, 6 comments
Creating Cloud page in DOCSY
Uploading original document
Uploading assets 1/4
Finalizing ADF body
Creating source-reference comment
Creating comments 1/6
Verifying readback
Created “Imported handbook” — https://…
4 warnings; run with --json or --report for details
```

No spinner is used when stderr is not a TTY. Progress events are structured internally and tested independently from rendering.

### 10.6 Exit behavior

Use existing AtlCLI `fail()`/`ERROR_CODES` conventions and existing numeric exit mapping. Required classifications:

- usage/style-map error;
- auth/profile error;
- unsafe/invalid input validation error;
- local IO error;
- target API/capability error;
- strict/degradation failure;
- approval-required/non-TTY mode error;
- override validation or stale saved-plan error;
- canceled/declined interactive review without remote mutation;
- partial/rollback-failed error with page ID/URL in both human and JSON output.

Never print raw XML, binary content, tokens, auth headers, or entire API bodies in normal errors.

---

## 11. Publication transaction and recovery

### 11.1 State machine

```text
prepared
  -> shell-created
  -> source-artifact-uploaded?       (--attach-source)
  -> assets-uploaded
  -> body-finalized
  -> source-reference-comment-created? (--source-reference comment)
  -> comments-created
  -> provenance-written
  -> labels-applied
  -> readback-verified
  -> complete

any failure after shell-created
  -> rollback-attempted
     -> rolled-back
     -> partial (rollback failed or --keep-failed-page)
```

Rules:

- The publisher has no API that accepts raw DOCX/IR/body alone. Its mutation entrypoint requires a matching `PreparedImport` + `ImportApproval` and checks `planDigest`, publishable state, strict policy, and accepted warning set before `shell-created`.
- Interactive preview keeps one immutable `PreparedImport` in memory. Saved-plan replay regenerates it from the original source and revalidates all digests; neither flow trusts a separately rendered preview artifact.
- All parse/normalize/known strict failures happen before `shell-created`.
- The shell contains a short import-in-progress message and a machine-readable import marker owned by AtlCLI, but no secrets or local absolute path.
- Requested source-artifact upload happens before content assets. The uploader sends the accepted original bytes unchanged, records returned identity immediately, downloads within configured limits, and requires the downloaded SHA-256 to equal the plan. A size/capability failure discovered before `shell-created` blocks early; any upload/reference/readback failure after it triggers normal rollback.
- Asset uploads are sequential or bounded with deterministic result ordering; API mutation order is stable.
- Final body update uses the latest shell version and cannot overwrite another actor’s update. A version conflict stops and leaves/rolls back according to safety policy; it never retries with an unexamined version. `sourceReference: "footer"` is finalized here from a typed attachment-link intent; `none` adds no source block.
- Comments are created only after body readback succeeds enough to compute anchors.
- A requested `sourceReference: "comment"` is created first as a page-level/footer comment from a typed safe-link intent. It is tracked separately from document comments, contains no DOCX-author marker, and failure is fatal. Document comments then follow their normal parent/reply ordering.
- Each comment is tracked immediately by returned ID. Comment and source-artifact provenance properties/page manifests are written after all required IDs exist and read back before completion; visible DOCX-author marker fallback is present only in document-comment create bodies from the start.
- Labels are last nonessential mutations; their failure is reported and follows strict/non-strict policy.
- Default rollback deletes only the page ID created in this run. It never searches/deletes by title.
- If rollback fails, report status is `partial`, exit is non-zero, and page ID/URL are prominent.

### 11.2 Semantic readback

Readback inspector produces a target-neutral digest over:

- ordered visible text;
- heading levels;
- list hierarchy and order/start values where expressible;
- table row/cell/span structure;
- link destinations;
- image/attachment references and alt text;
- original-source attachment role, filename, byte digest, and selected visible-reference mode; generated URLs/IDs are normalized;
- native callout/expand/code/TOC intents;
- comment selection and hierarchy where supported.

The expected digest comes from the publication plan after target-specific documented approximations, not directly from raw DOCX. IDs, timestamps, generated macro IDs, versions, and attachment URLs are excluded.

A mismatch is never downgraded to a warning for core text/table/list loss. It triggers rollback. Cosmetic target normalization may be allowlisted only with a named regression fixture.

---

## 12. Security and resource budgets

DOCX input is untrusted. The following checks run before the parser adapter:

### 12.1 Package validation

- Extension and content sniff must both identify a ZIP-based DOCX; `.docm` is rejected.
- Locate EOCD/ZIP64 records safely and validate central-directory offsets before reading entries.
- Reject absolute paths, drive paths, NUL bytes, `..` traversal, duplicate normalized part names, overlapping ranges, encrypted entries, unsupported compression, and invalid size metadata.
- Require `[Content_Types].xml`, `_rels/.rels`, and a valid officeDocument relationship to a Word main document part.
- Reject DTD/ENTITY declarations and external XML entity resolution.
- Never follow `TargetMode="External"` relationships except to preserve safe `http`/`https`/`mailto` hyperlinks as link data.
- Never execute or load VBA, OLE, ActiveX, embedded packages, external templates, or remote images.

### 12.2 Default budgets

Initial defaults, adjustable only through the typed internal policy after tests:

| Budget | Default | Outcome |
|---|---:|---|
| Input bytes | 50 MiB | reject before parse |
| ZIP entries | 10,000 | reject |
| Total declared uncompressed bytes | 250 MiB | reject |
| Per-entry uncompressed bytes | 64 MiB | reject |
| Compression ratio | 100:1 per entry and aggregate | reject |
| XML parts | 5,000 | reject |
| XML nesting | 128 | reject |
| Normalized blocks | 250,000 | reject |
| Text characters | 20 million | reject |
| Assets | 1,000 | reject |
| Per asset | 25 MiB | report/reject according to strict policy; never partially buffer beyond limit |
| Total upload assets | 100 MiB | reject before shell creation |
| Original source attachment | same accepted input-byte limit plus target attachment limit | reject before shell creation when locally knowable; otherwise upload failure rolls back |
| Comments/revisions | 50,000 each | reject |

The executor may tune numbers after benchmark evidence, but every change requires a fixture/test and documentation. Do not offer `--no-limits`.

### 12.3 Output safety

- Escape all Storage text/attributes and split `]]>` safely in CDATA macro bodies.
- Construct ADF objects with typed builders; serialize once. Never interpolate JSON strings.
- Allow link schemes `https`, `http`, `mailto`, and target-relative Confluence anchors only. Other schemes become plain text + issue.
- Sanitize attachment filenames for both Cloud/DC while preserving extensions and uniqueness.
- Upload an explicitly retained original only after the entire input passes package/security validation. Preserve its bytes exactly, but disclose in preview/docs that this also preserves document metadata, comments, revisions, hyperlinks, and safe-but-unsupported embedded content. Never reinterpret source retention as permission to upload a rejected `.docm`, unsafe relationship/package, or executable payload.
- Build `footer` and `comment` source references from a typed returned-attachment identity. Escape/encode the filename and URL through the target adapter; never accept raw reference markup or URL from the DOCX/override file.
- Strip path components and control characters from titles, filenames, report paths, and provenance strings.
- Use exclusive temp creation and atomic report writes; refuse symlink targets following existing sink patterns.
- Parse override and saved-plan files as untrusted input with byte/depth/key-count limits, duplicate-key rejection where supported, exact schema versions, and no prototype-bearing object merge. Never spread parsed objects into defaults.
- Escape every preview string/attribute/embedded JSON boundary, sanitize or rasterize active SVG, disallow remote fonts/scripts/styles/images, and ship a restrictive CSP. A DOCX hyperlink is displayed as text/metadata only; preview generation never follows it.
- `--open-preview` opens only the exact regular file atomically written by this run after rechecking its identity; it never opens a path sourced from the DOCX.

---

## 13. Fixture and proof strategy

### 13.1 Fixture corpus

`packages/import-docx/testdata/MANIFEST.json` records for every binary fixture:

- filename and SHA-256;
- producer/version (Word, LibreOffice, Google Docs export, synthetic OOXML builder);
- license/provenance and whether redistribution is permitted;
- feature tags;
- expected issue codes;
- whether it is safe/malformed/adversarial;
- expected block/asset/comment/revision counts.

Required fixtures:

```text
minimal.docx
rich-text-and-styles.docx
lists-numbering-restarts.docx
tables-spans-nested.docx
images-inline-floating.docx
comments-ranges-replies-resolved.docx
comments-duplicate-selection.docx
preview-hostile-content.docx
override-targets.docx
source-retention.docx
tracked-changes.docx
fields-toc-bookmarks.docx
content-controls-textboxes.docx
equations-charts-smartart.docx
headers-footers-sections.docx
feature-zoo.docx
libreoffice-feature-zoo.docx
google-docs-export.docx
malformed-relationships.docx
unsafe-paths.docx
zip-bomb-metadata.docx
doctype-entity.docx
```

Synthetic malformed fixtures are generated deterministically by a small test builder and need not commit huge inflated payloads. Real-world binaries must not contain customer data.

### 13.2 Test layers

| Layer | What it proves | What it does not prove |
|---|---|---|
| Pure unit | normalizers, mappings, escaping, issue policy | real OOXML package parsing |
| Fixture integration | parser adapter + real DOCX bytes → stable IR | target acceptance/rendering |
| Encoder golden/invariant | valid deterministic ADF/Storage semantics | live Confluence normalization |
| Plan/override/preview contract | stable IDs/digests, precedence, stale detection, issue anchoring, safe offline HTML | live Confluence rendering |
| Security/adversarial | budgets/rejection before parse/write | every possible malicious ZIP |
| CLI PTY/non-TTY | default-no prompt behavior, approval gate, decline/direct/dry-run modes, stdout/stderr integrity | live target mutation |
| Source/dist/binary smoke | release packaging reads and dry-runs a real DOCX | live auth/API |
| Node/Bun/browser Worker | isomorphic runtime behavior | Extension/Forge host certification |
| Local HTTP transport/roundtrip contract | exact Cloud/DC paths, auth headers, payloads, context paths, documented response variants, failure/rollback, Storage semantic readback | live tenant/editor behavior |
| Live Cloud DOCSY E2E | actual CLI, Cloud v2 ADF, attachments, comments, readback, cleanup | Data Center |
| Optional community DC E2E | operator-owned actual Storage/client/context path/readback/cleanup evidence | project-maintained certification or a release gate |
| User-assisted visual review | target editor/page rendering and UX | automation/regression coverage |

### 13.3 Evidence ledger

Create `specs/import-docx-mvp/EVIDENCE.md` during implementation with:

- git SHA and exact direct dependency versions, upstream tags/commits, integrity/provenance, install-script/native-binary review, sizes, vulnerability result, and direct/transitive licenses;
- manifest/lockfile exact-pin check output and rationale for every newly introduced library;
- fixture manifest digest;
- exact commands and pass/fail counts;
- Node/Bun/Chromium versions;
- browser artifact sizes and forbidden-token scan;
- Cloud live platform-probe results; DC contract-matrix results and any optional sanitized community run;
- E2E generated page titles and deletion confirmation, but no credentials/tokens;
- semantic coverage table generated from the E2E report;
- known supported/approximated/deferred features;
- screenshots only for the one-time visual review, sanitized of private tenant content.

---

## 14. Implementation tasks

The tasks are ordered dependency gates. A downstream task may not mark acceptance complete while a prerequisite is unresolved.

### Task 0 — Prove external contracts before committing the architecture

**Files:**

- `specs/import-docx-mvp/EVIDENCE.md` (create)
- `packages/import-docx/testdata/` spike fixtures (only redistributable artifacts)
- optional disposable scripts under `/tmp`; do not commit tenant-specific dumps

**Implementation/research:**

- [ ] Confirm selected `@office-open/docx` exact package version, repository commit/tag, MIT license, maintainer/release status, transitive licenses, unpacked size, browser exports, and absence of install scripts/native binaries.
- [ ] Inventory every other proposed new direct dependency for ZIP/XML/YAML/schema/sanitization/preview/browser/test work. Prefer existing platform/repo code when safe; for each accepted library record the complete Section 2.9 evidence before it enters a manifest.
- [ ] Re-run Node 22, Node 24, Bun, and browser-target bundle smoke on `packages/export/tests/fixtures/golden-export.docx` plus the new comments/revisions fixtures.
- [ ] Prove comment start/end ranges, reply parent IDs, and resolved state. If the parser omits thread data, document exact required parts (`commentsExtended.xml` and relationships) and a minimal supplemental parser contract.
- [ ] In `mayflower`/`DOCSY`, prove Cloud ADF page creation via REST v2 and read back `atlas_doc_format`.
- [ ] Prove Cloud image identity end-to-end: create shell, upload a known image, fetch attachment `fileId`, finalize an ADF `mediaSingle/media`, read back, and verify rendered/export view. Determine the required collection value from authoritative response/readback, not guesswork.
- [ ] Prove byte-identical DOCX attachment upload/download live on Cloud. For Data Center, derive returned attachment/content identity, context-path-safe download/reference construction, filename normalization, size/error handling, and body/comment links from documented REST v1 contracts and lock them into deterministic local HTTP fixtures; do not invent URL shapes or require a maintainer-owned tenant.
- [ ] Prove one TOC macro path: create a known TOC through Storage or UI, fetch its ADF, sanitize instance IDs, create a second ADF page from the derived typed intent, and read it back. If this is not reproducible through public APIs, mark Cloud TOC intent deferred.
- [ ] Verify Cloud inline comment creation on a unique and duplicate text selection, including match count/index and a reply.
- [ ] Prove Cloud `/api/v2/comments/{comment-id}/properties` create/read/update/delete for inline and footer comments, including returned value/version semantics and scopes. Prove the page-property recovery manifest separately.
- [ ] Prove the fixed visible attribution paragraph live through Cloud comment create/read/render and structurally through the DC Storage/comment transport plus parser/readback fixtures. An optional community DC run may strengthen this evidence but is not a release prerequisite.
- [ ] Research supported Data Center comment-content-property endpoints/version floors from authoritative documentation and response contracts. If the intended DC range lacks one explicit portable contract, set `commentProperties: "unsupported"` and use the documented page-manifest + visible-marker fallback; do not depend on tenant probing or invent an endpoint.
- [ ] Create a minimal standard OOXML comment/reply/resolved fixture plus `customXml/atlcli-comment-provenance.xml`; prove Word/LibreOffice-produced variants parse, the current exporter package can preserve/add required parts, and custom-part removal still leaves author/body/range readable.
- [ ] Delete every Cloud probe page/attachment/comment in `finally` and record cleanup. Optional community DC probes use the same ownership/cleanup contract.

**Acceptance:**

- [ ] Parser recommendation remains `@office-open/docx`; otherwise stop and revise Sections 2/6/7 before implementation.
- [ ] Cloud ADF text/table page creation and readback pass.
- [ ] Cloud media mapping is either proven with exact fields or explicitly blocks image support/implementation pending a decision.
- [ ] Original-DOCX upload/download and `footer`/`comment` links have live Cloud proof and exact DC contract fixtures; otherwise gate only the unsupported edition/capability rather than silently omitting the requested artifact/reference.
- [ ] TOC macro is labeled proven or deferred; no invented ADF extension payload.
- [ ] Comment thread/range gaps have a precise supplemental OOXML solution or a documented MVP degradation.
- [ ] Cloud comment-property and page-manifest contracts are live-proven; Data Center provenance uses an authoritative documented/version-gated contract or the explicit page-manifest + visible-marker fallback, backed by transport/readback tests.
- [ ] Standard Word comment parts are the roundtrip baseline; any custom provenance part is inert/optional and its loss has a tested degradation.
- [ ] The visible attribution marker round-trips live through Cloud and structurally through the complete DC Storage transport/readback contract; optional community evidence is recorded separately.
- [ ] `EVIDENCE.md` contains commands, exact dependency evidence, versions, outcomes, and cleanup confirmation.

**Proof command examples:**

```bash
bun run --cwd apps/cli src/index.ts wiki page get --id <probe-id> --profile mayflower --json
bun run --cwd apps/cli src/index.ts wiki page delete --id <probe-id> --profile mayflower --confirm --json
```

Expected: probe assertions exit 0; cleanup GET returns not found; no probe title remains in DOCSY search.

### Task 1 — Establish package, distribution, and typed-contract boundaries

**Depends on:** Task 0 parser and Cloud media decisions.

**Files:** `packages/import-docx/package.json`, `tsconfig.json`, `tsconfig.build.json`, `README.md`, `etc/*.md`, `src/model.ts`, `options.ts`, `issues.ts`, `report.ts`, `import-plan.ts`, `overrides.ts`, `preview-model.ts`, `parser-port.ts`, `index.ts`, `index.browser.ts`, `internal.ts`, root `package.json`, `bun.lock`, `scripts/check-browser-build.ts`, `scripts/check-import-dependency-pins.ts`, `scripts/api-closure.ts`, API/pack/consumer-smoke scripts and tests, boundary tests.

- [ ] Add `@atlcli/import-docx` at `0.1.0` with `atlcli.publish: public-0.x`, no `private: true`, and exact external dependency versions. This classification makes packaging/API drift fail closed; it does **not** authorize or automate registry publication. No caret, tilde, tag, wildcard, branch, or unpinned URL is allowed for any newly introduced production/dev dependency; workspace protocol references are allowed.
- [ ] Implement contracts from Section 7 without parser-specific types.
- [ ] Implement deterministic canonical JSON/digest helpers, override validation/precedence, plan integrity, and preview-model issue anchoring contracts before adding UI/CLI rendering.
- [ ] Follow the current distribution contract: build `dist/*.js` plus declarations from `tsconfig.build.json`; expose conditional `development` source and built `browser`/`default` entrypoints; add `./browser` and a deliberately non-frozen `./internal`; set `sideEffects: false`; restrict `files` to `dist` and `README.md`; and strip the development condition for packed/file-linked production consumption.
- [ ] Keep default and browser entrypoints pure and byte-oriented. Do **not** add a package `./node` subpath in the MVP: local file/stdin acquisition belongs to `apps/cli/src/commands/import-source.ts`, while Node, Bun, Workers, and future hosts all call the same `Uint8Array` package contract. A future convenience host-adapter package needs its own consumer evidence and API decision.
- [ ] Add `@atlcli/import-docx` to the reviewed API-freeze decision map as non-frozen 0.x. Generate and review API report plus closure classification; require zero reachable-but-unexported gaps for the browser/default contract even though it is experimental.
- [ ] Add import entrypoint to browser build gate and scan bundled output for `node:`, `bun:`, bare `Buffer`, `process`, `eval`, `new Function`, and remote executable imports. Document narrowly justified false positives; do not blanket-ignore strings.
- [ ] Add dependency-boundary tests forbidding imports from apps, extension/WXT/Chrome, Node modules in browser modules, and export-engine internals.
- [ ] Add a scoped manifest check that rejects non-exact external specs in the new import/harness packages and maintains an explicit feature-owned allowlist for any dependency newly added to existing `packages/confluence`, `packages/docx`, or CLI manifests. Verify `bun.lock` contains resolved versions/integrities and permit only documented workspace protocol edges. Do not rewrite unrelated pre-existing dependency ranges as part of this feature.
- [ ] Extend pack, file-link, Node-LTS, and Vite consumer smokes so they install the actual package artifact/closure, import only declared exports, typecheck with `skipLibCheck: false`, and parse a minimal real DOCX. The smoke must not succeed by resolving workspace source accidentally.

**Acceptance/tests:**

- [ ] `bun test packages/import-docx scripts/check-browser-build.test.ts` passes.
- [ ] `bun run check:browser` reports the new entrypoint clean.
- [ ] `bun run typecheck` exits 0.
- [ ] `bun run check:import-dependency-pins` exits 0 and a regression fixture proves `^`, `~`, `latest`, wildcard, Git branch, and unpinned URL specs fail.
- [ ] `bun install --frozen-lockfile` exits 0 without changing `bun.lock` or package manifests.
- [ ] Publish-classification, API-report, API-closure, pack-check, development-condition, and install-matrix tests pass; committed generated reports match built declarations.
- [ ] Tarball and file-linked production manifests contain no `development` condition or source target; default/browser imports resolve from `dist`, while repository development still resolves source explicitly.
- [ ] Node floor/current and vanilla Vite consumers parse the same fixture to the same semantic digest from packed artifacts with `skipLibCheck: false`.
- [ ] A test proves parser adapter objects cannot satisfy/export the public IR without explicit translation.
- [ ] Package tarball/file list contains no fixtures with private data and no unexpected binaries/install scripts.

### Task 2 — Reject unsafe packages before parsing

**Depends on:** Task 1.

**Files:** `ooxml/zip-preflight.ts`, `ooxml/xml-policy.ts`, `security.test.ts`, adversarial fixture builder.

- [ ] Implement central-directory/ZIP64 metadata inspection with `DataView`; do not inflate entries during preflight.
- [ ] Enforce Section 12 budgets and canonical part-name validation.
- [ ] Validate required OOXML parts/relationships/content types and reject macro-enabled/VBA content.
- [ ] Reject DTD/entities and external executable/template/image relationships; preserve safe hyperlinks as data only.
- [ ] Return typed validation errors and issues without echoing binary/XML contents.

**Acceptance/tests:**

- [ ] Valid Word/LibreOffice/Google fixtures pass preflight.
- [ ] Traversal, duplicate normalized names, invalid offsets, encrypted entries, unsafe compression ratio, inflated budgets, DTD/entity, `.docm`, external template, and malformed relationship fixtures fail before the parser adapter spy is called.
- [ ] No adversarial test allocates the declared expanded payload.
- [ ] Fuzz/property tests over truncated/random central-directory bytes never crash/hang; they return a typed rejection within the test timeout.
- [ ] `bun test packages/import-docx/tests/security.test.ts` exits 0.

### Task 3 — Parse and normalize rich text, styles, links, bookmarks, and revisions

**Depends on:** Tasks 1–2.

**Files:** parser adapter, `parse.ts`, paragraph/field/annotation normalizers, style map, fixtures/expected JSON.

- [ ] Translate paragraphs/runs/marks/styles/metadata to deterministic IR.
- [ ] Normalize Unicode/whitespace while preserving NBSP, tabs, hard/soft breaks.
- [ ] Map headings by outline/style metadata, not English display name alone.
- [ ] Preserve external links, internal bookmarks, note references, fields, content controls, and source provenance.
- [ ] Preserve insert/delete/move/property revisions in IR and apply the selected rendering policy only after parse.
- [ ] Implement supplemental comment extension parsing proven in Task 0.
- [ ] Parse and validate optional `customXml/atlcli-comment-provenance.xml` through a narrowly owned schema; reconcile it with standard comment author/body/range/thread fields and degrade safely when missing, stripped, stale, or contradictory.
- [ ] Validate built-in/user style maps, macro intents, and `atlcli.docx-import-overrides/1`; apply the exact precedence from Section 7.7 and preserve every applied/unmatched override ID.

**Acceptance/tests:**

- [ ] Rich-text/style fixture produces exact structural assertions and a reviewed semantic JSON golden.
- [ ] Heading detection works across localized/custom style names when outline level/style ID is present.
- [ ] Safe/unsafe link scheme tests pass.
- [ ] Comments retain exact range text and deterministic start/end block offsets.
- [ ] Standard-only, valid custom-provenance, stripped-custom-part, stale-digest, conflicting-author, duplicate-ID, and malformed-custom-XML comment fixtures have named assertions; invalid custom data never overrides standard comment content silently.
- [ ] Insertions and deletions remain separately observable before policy application.
- [ ] Global/style/node override precedence, `use-default`, unknown IDs, duplicate YAML keys, stale node IDs, and target-inapplicable actions have named tests.
- [ ] `parseDocx(bytes, opts)` is byte-for-byte/structurally deterministic over 100 repeated runs excluding timings.

### Task 4 — Preserve list and table semantics

**Depends on:** Task 3.

**Files:** list/table normalizers, fixtures, expected IR.

- [ ] Resolve numbering definitions, abstract numbering, levels, overrides, starts, restarts, mixed ordered/bullet nesting, and paragraphs continuing a list item.
- [ ] Build rectangular table semantics with `gridSpan`, vertical merge, header rows, nested blocks/tables, widths, shading, alignment, captions, and empty-cell placeholders.
- [ ] Detect malformed spans/merges and approximate with explicit issues rather than emitting invalid target trees.

**Acceptance/tests:**

- [ ] List hierarchy fixture proves 1–9 levels, restarts, start values, mixed types, and intervening paragraphs.
- [ ] Table fixture proves row/col spans, repeated header, nested table, multiple paragraphs/list in a cell, empty cells, and widths.
- [ ] Table invariants verify every row resolves to a consistent logical grid after spans.
- [ ] No cell text is duplicated or lost in malformed-merge fallback.
- [ ] Focused tests exit 0 and semantic goldens are reviewed for structure, not just snapshot-updated.

### Task 5 — Extract assets and advanced Word fallbacks

**Depends on:** Tasks 2–4.

**Files:** asset normalizer, image metadata helpers, drawing/field/textbox logic, fixtures.

- [ ] Extract inline/floating image relationships, bytes, media types, dimensions, alt/title, crop/rotation metadata, and deterministic placement.
- [ ] Deduplicate by SHA-256 using isomorphic Web Crypto or an injected browser-safe digest port.
- [ ] Sanitize/collision-resolve filenames deterministically.
- [ ] Use packaged preview images for EMF/WMF/equations/charts/SmartArt when safe and present.
- [ ] Extract textbox text in anchor order; preserve unsupported layout provenance.
- [ ] Build footnote/endnote section and backlinks.
- [ ] Record headers/footers/sections/embedded objects without merging or executing them.

**Acceptance/tests:**

- [ ] PNG/JPEG/GIF/WebP/SVG fixtures extract correct digests/types/dimensions/alt text.
- [ ] Same bytes under two relationships upload once; same filename/different bytes gets deterministic unique names.
- [ ] Unsupported vector/drawing paths use preview or issue, never an empty block.
- [ ] Remote image relationship produces no network request and an issue.
- [ ] Embedded executable/VBA/OLE content is never returned as an uploadable asset by default.
- [ ] Browser, Node, and Bun compute identical asset IDs/digests.

### Task 6 — Implement independent Cloud ADF and DC Storage encoders

**Depends on:** Tasks 0, 3–5.

**Files:** `encode/adf.ts`, `encode/storage.ts`, `preview-model.ts`, `preview-terminal.ts`, `preview-html.ts`, typed builders/validators, semantic digest/inspectors, encoder/preview tests.

- [ ] Encode every supported IR node separately for Cloud ADF and DC Storage.
- [ ] Validate ADF root/version/node/mark/content constraints before publication. Pin a test schema only after license/redistribution review; otherwise use owned narrow validators plus live readback.
- [ ] Escape Storage XML/attributes/CDATA and preserve namespaces/macros.
- [ ] Implement allowlisted macro-intent registry per capability matrix.
- [ ] Resolve asset placeholders only from `UploadedAsset` results.
- [ ] Produce target-aware issues for every approximation.
- [ ] Emit `ImportPreviewDocument` and visible-text/semantic-digest projection from the same target encoding result for both targets.
- [ ] Encode `sourceReference: "footer"` from one typed attachment-link intent in Cloud ADF/DC Storage and emit no body block for `none|comment`; the finalized target link is derived only from verified upload identity.
- [ ] Implement compact terminal and self-contained offline HTML preview renderers. HTML nodes expose source IDs/outcomes/issue anchors without embedding executable source content or remote dependencies.

**Acceptance/tests:**

- [ ] Every Feature Coverage row marked N/G/A has a named encoder test for both targets.
- [ ] ADF output parses as JSON and passes the owned/schema validator.
- [ ] Storage output is well-formed under the repository’s XML tokenizer and contains no unescaped input.
- [ ] Table span, lists, links, panels/expand/code, notes, images, and revision policies have structural assertions.
- [ ] Re-encoding the same IR is deterministic.
- [ ] Cross-target semantic digests match for the shared-native subset; documented target differences have named allowlist entries.
- [ ] Preview semantic digest equals the target body’s expected readback digest; mutation testing a mapping on only one side fails `preview-plan-mismatch`.
- [ ] Source-reference encoder goldens prove none/comment add zero body nodes, footer adds exactly one final target-native link section, hostile filenames cannot inject ADF/Storage, and normalized remote IDs/URLs do not destabilize semantic digests.
- [ ] `preview-hostile-content.docx` cannot inject markup/script/style, activate SVG, navigate, or cause a network request in the HTML preview browser test.

### Task 7 — Add edition-aware page, attachment, comment, and readback ports

**Depends on:** Task 6.

**Files:** `packages/confluence/src/page-body.ts`, `capabilities.ts`, `import-publisher.ts`, `semantic-readback.ts`, `client.ts`, exports, client/transport tests.

- [ ] Add typed page-body methods without breaking existing `createPage({ storage })`/`updatePage({ storage })` callers. Prefer additive overload/wrapper migration, then move callers deliberately.
- [ ] Add Cloud v2 page create/get/update by space ID and `atlas_doc_format` body.
- [ ] Reuse current v1 Storage create/update/upload for DC and preserve context paths.
- [ ] Return Cloud attachment `fileId` and other proven identity fields through a normalized upload result.
- [ ] Add normalized source-artifact upload/download verification and typed body/comment attachment-link builders for Cloud/DC. The core supplies intent plus returned attachment identity; target adapters alone own exact URLs/markup.
- [ ] Split Cloud-v2 comment behavior from DC content-v1 footer comments. Mark DC inline unsupported unless Task 0/13 produces an official, versioned contract.
- [ ] Add typed comment/page provenance-property read/write/delete ports according to Task 0 capabilities; property values are schema-validated and size-bounded before use.
- [ ] Resolve Cloud `authorId` to an actual display name/account reference through the supported user API/cache and parse Data Center user identity fields without treating IDs as names. Permission-limited resolution yields explicit `comment-actor-unresolved`, never a fabricated DOCX author.
- [ ] Implement capability selection and readback methods.
- [ ] Implement bounded retries only for established transient/idempotent reads/uploads. Never blindly retry page creation.

**Acceptance/tests:**

- [ ] Local HTTP transport tests assert exact Cloud v2 path/payload (`spaceId`, representation, JSON-string ADF) and DC v1 path/payload (`space.key`, ancestors, storage).
- [ ] DC root and arbitrary context path tests remain green.
- [ ] Existing page/comments/client tests remain green.
- [ ] Cloud methods are never selected for DC profile and vice versa.
- [ ] A simulated 409 version conflict does not retry/overwrite.
- [ ] Attachment upload result preserves fileId/filename/content ID without conflation.
- [ ] Source-artifact transport tests prove exact input bytes are uploaded, bounded download bytes hash identically, filenames/links are escaped once, and Cloud/DC path/context handling cannot cross-select.
- [ ] Cloud comment property and page manifest transport tests assert exact endpoints/scopes/payload/version behavior; Data Center tests assert proven content-property path or explicit unsupported capability.
- [ ] Actor tests distinguish Cloud account ID, resolved Cloud display name, Data Center display name/user key, imported document attribution, and same-display-name/different-identity cases.

### Task 8 — Implement transactional publisher and comment/revision policies

**Depends on:** Tasks 6–7.

**Files:** publication plan, import plan/override/approval contracts, publisher, annotation mapping, rollback and plan-integrity tests.

- [ ] Implement the state machine in Section 11 with an injected `ConfluenceImportPort`.
- [ ] Keep parse/encode separate from network execution and expose canonical `DocxImportPlanV1` plus process-local `PreparedImport`.
- [ ] Require a matching `ImportApproval` at the only publisher mutation entrypoint; reject missing approval, plan-digest mismatch, unaccepted warnings, strict warnings, and non-publishable plans before the first port call.
- [ ] Implement atomic plan serialization and safe `--from-plan` regeneration/comparison. Saved target bodies/asset metadata are evidence only and are never trusted as upload/write input.
- [ ] Upload assets deterministically and finalize the body with remote identities.
- [ ] When requested, upload and SHA-256-verify the original DOCX before content assets; keep `original-docx` separate from `ImportAsset`, and finalize `footer` only from the verified returned attachment identity.
- [ ] Compute Cloud comment occurrence mapping from finalized/readback visible text.
- [ ] Create parents before replies; serialize the fixed visible marker, persist per-comment property/page-manifest provenance, and retain returned platform actor separately from source attribution.
- [ ] For `sourceReference: "comment"`, create one page-level comment before document comments, link the verified source attachment, record role/comment ID in source-artifact provenance, and never apply a DOCX-author marker. `none` creates neither a body node nor a comment.
- [ ] Implement DC footer/append demotion and strict inline failure.
- [ ] Read back body/comments/attachments and compare semantic digest.
- [ ] Treat every explicitly selected source upload/reference failure or digest mismatch as fatal and roll back by default; never downgrade to a successful import without the requested original/reference.
- [ ] Roll back only the created page on every post-create failure by default.

**Acceptance/tests:**

- [ ] Failure injection at every state transition proves expected rollback and report status.
- [ ] `--keep-failed-page` suppresses rollback but returns non-zero/partial with page ID.
- [ ] Rollback failure is prominent and never reported as success.
- [ ] Duplicate selected text maps to correct match index; cross-block/changed text demotes/fails per mode.
- [ ] Comment reply order and provenance are stable.
- [ ] `none`, `footer`, and `comment` are mutually exclusive and deterministic: default/no flags create no source attachment/reference; attach+none uploads only; footer creates exactly one final body reference and no source comment; comment creates exactly one role-tagged page comment and no body reference.
- [ ] Changing attach/reference/source filename invalidates approval/saved-plan before network; source attachment bytes are the exact approved input bytes.
- [ ] Same display name for a DOCX author and Confluence user remains two distinct typed identities; no name-based account lookup occurs.
- [ ] Property success, property unsupported, property write failure, page-manifest fallback, marker-only recovery, invalid/conflicting metadata, modified body, and new native Confluence reply all produce the specified attribution/evidence/report outcome.
- [ ] Core text/table/list readback mismatch triggers rollback.
- [ ] No network method is called during dry-run.
- [ ] Publisher type/runtime tests prove there is no raw body/IR mutation path that bypasses approval.
- [ ] Source byte change, option/override/capability/destination change, edited plan JSON, body digest change, and semantic digest change each fail as stale before any network method.
- [ ] Interactive in-process approval publishes the exact `PreparedImport` instance/digest that produced the preview; it does not parse or encode twice.

### Task 9 — Preserve comment identity and implement DOCX comment roundtrip export

**Depends on:** Tasks 0, 3, 7–8.

**Files:** `packages/confluence/src/comment-provenance.ts`, `comment-author-resolver.ts`, `comments.ts`, `client.ts`, exports/tests; `packages/docx/src/comments.ts`, `comment-provenance.ts`, `export.ts`, `index.browser.ts`, fixtures/tests; `apps/cli/src/commands/export.ts` and export tests/help; import publisher tests.

- [ ] Implement the Section 7.3 actor/attribution/provenance types, fixed marker serializer/parser, exact property/page-manifest schemas, evidence precedence, conflict handling, and body-modified detection in a browser-safe pure module.
- [ ] Extend comment API parsing additively so existing `PageComments` consumers remain compatible while export/import paths can request resolved actor + attribution records. Do not store `authorId` as a display name.
- [ ] Add bounded/cached platform actor resolution for Cloud/DC and preserve stable account/user references separately from display names.
- [ ] Extend `@atlcli/docx` with an `ExportCommentThread` input and an OOXML writer for comments content type, document relationship, `comments.xml`, range markers/references, unique IDs, author/initial/date, and the Task 0-proven thread/resolution parts.
- [ ] Treat that `@atlcli/docx` change as an additive change to an existing frozen 1.0 surface: expose only the smallest host-facing comment input needed by `ExportInput`, keep OOXML/provenance writer details behind `./internal`, regenerate API report/closure, and run the full packed/file-linked/Node/Vite consumer matrix. If the required public change is breaking, STOP and version the contract instead of silently weakening the freeze.
- [ ] Build one visible-text index over the resolved `ExportBlock[]` using serializer traversal order. Convert selection + occurrence into leaf inline offsets, pass an immutable `ExportCommentAnchorPlan` into `serializeBlocks`, and split runs there to emit `commentRangeStart`/`commentRangeEnd`/`commentReference`. Never regex-rewrite rendered `document.xml` text to guess ranges.
- [ ] Reanchor preserved imported ranges only on an exact stable match. Insert native footer/unanchorable comments as typed blocks in the explicit final section **before** indexing/serialization, then anchor their Word comments to those generated entries.
- [ ] Write/read the optional inert `customXml/atlcli-comment-provenance.xml` manifest with exact schema, relationship, digests, and size limits. Standard comment parts remain usable when it is removed.
- [ ] Wire `atlcli wiki export <page> --format docx --comments --output <file.docx>`; reject `--comments` for other formats until their own contract exists. Fetch comments/properties/actors before final DOCX rendering and include attribution issues in the existing export report/notes path.
- [ ] Ensure imported DOCX comments export with `sourceAuthor`; Confluence-native comments/replies export with actual actor display name. Equal display strings do not collapse identity kinds.
- [ ] Filter a valid `source-reference` root and its complete reply thread before building `ExportCommentThread`; never export/count them as Word comments and never use visible-text matching to identify them. Missing/invalid provenance follows normal native-comment export plus an issue where detectable rather than risking suppression of user content.

**Acceptance/tests:**

- [ ] Pure tests cover marker escaping/lookalikes/malformed forms, property → page manifest → marker evidence order, conflicts, unknown schemas, same-name/different-kind identities, body modification, missing actor permission, and no email leakage.
- [ ] OOXML structural tests validate content types, relationships, comment IDs/ranges/references, standard author/initial/date, replies/resolved state or named fallback, and optional custom part using real ZIP/XML inspection rather than string presence alone.
- [ ] Removing the custom part from an exported fixture preserves author/body/range on reimport and yields only the documented identity-kind fidelity issue.
- [ ] `DOCX fixture → ImportDocument → simulated Confluence actor+provenance → DOCX export → ImportDocument` preserves the semantic comment equality contract from Section 9.4.1 for multiple authors, same-name actor/source, duplicate text ranges, replies, resolution, non-ASCII/escaped names, modified body, and unanchored footer fallback.
- [ ] A native Confluence comment plus native reply exports actual resolved Confluence names; an imported parent plus native reply exports source author for the parent and platform actor for the reply.
- [ ] A valid source-reference comment and replies are absent from OOXML comments and document-comment counts; edited visible text remains excluded while its authoritative provenance is valid, and a lookalike user comment/thread is retained.
- [ ] Existing DOCX golden/export tests and existing `.comments.json`/page comment consumers stay green.
- [ ] `bun test packages/confluence/src/comments.test.ts packages/confluence/src/comment-provenance.test.ts packages/docx/src/comments.test.ts apps/cli/src/commands/export*.test.ts` exits 0.

### Task 10 — Add review-first `wiki import` CLI, portable overrides, reports, progress, and help

**Depends on:** Tasks 8–9.

**Files:** CLI import handler/request/report/preview/plan-file, wiki dispatch/help, PTY/non-TTY tests, preview HTML browser tests, root/build inputs.

- [ ] Parse command/flags exactly as Section 10 and reject ambiguous/missing values.
- [ ] Implement `--attach-source`, exclusive `--source-reference none|footer|comment`, and stdin-only `--source-filename`; defaults produce no source upload or visible reference. Include all resolved values in options/plan digest and report.
- [ ] Read a file or stdin through the CLI-owned `import-source.ts` adapter; convert immediately to `Uint8Array` and require `--format docx` for stdin.
- [ ] Resolve profile/default space/title/parent without duplicating auth logic.
- [ ] Implement TTY review-first flow with terminal preview and default-no prompt; keep one immutable `PreparedImport` through approval/publish.
- [ ] Implement non-TTY approval guard, `--confirm` direct path, explicit `--dry-run`, HTML artifact/open behavior, `--plan-out`, and safe `--from-plan` replay.
- [ ] Load `--overrides`/`--style-map` through the shared schema validator; never merge parsed objects with prototype-sensitive spread/deep-merge helpers.
- [ ] Use `assertCliAuthSupported`, `fail`, `output`, and stable JSON conventions.
- [ ] Emit progress only to stderr and one report to stdout under `--json`.
- [ ] Atomically write `--report`; do not follow symlinks/overwrite directories.
- [ ] Add help, completion entries, minimal/advanced examples, and exit behavior.

**Acceptance/tests:**

- [ ] CLI parser table covers every flag, repeated label, valueless flags, stdin, wrong extension, incompatible modes, strict mode, target, preview, confirm, override, and saved-plan combinations.
- [ ] Source-retention parser tests cover default-off, attach+none, attach+footer, attach+comment, reference-without-attach rejection, local-file/source-filename rejection, stdin missing/valid filename, hostile filenames, and saved-plan mismatch.
- [ ] `--dry-run --json` snapshot matches `atlcli.docx-import-report/1` and performs no fetch.
- [ ] Pseudo-TTY tests prove default preview → exact prompt → default no/no write; yes publishes; EOF/interrupt does not write; `--confirm` never prompts; non-TTY without an explicit mode fails without hanging or fetching.
- [ ] `--strict --confirm` blocks on a known warning, while non-strict `--confirm` publishes and records accepted warnings. Neither mode bypasses an error issue.
- [ ] Human preview contains title/destination/target/plan digest/coverage/comments/revisions/ordered warnings; no raw JSON dump unless requested.
- [ ] Human/HTML/JSON preview distinguishes content assets, original source attachment, visible source-reference mode, and document comments; it warns that retained original bytes preserve metadata/comments/revisions and never renders a footer/comment preview for `none`.
- [ ] HTML preview is atomically written, requires an explicit path, opens only on explicit TTY request, and passes offline CSP/injection/no-request browser tests.
- [ ] Plan JSON is canonical and contains no asset bytes, function, credential, absolute path by default, remote ID, timestamp, or raw target response. Valid replay passes; every stale/tampered dimension fails before fetch.
- [ ] CLI- and browser-generated override fixtures are byte-equivalent after canonicalization and produce the same plan/semantic digest.
- [ ] Invalid/unsafe input exits with validation classification and creates no page.
- [ ] Report write race/symlink/Unicode path tests follow existing sink hardening.
- [ ] Root `--help`, `wiki --help`, and `wiki import --help` expose the command.

### Task 11 — Prove isomorphic runtime and shipped CLI packaging

**Depends on:** Tasks 3–6 and 9–10.

**Files:** existing browser conformance manifest/registry plus `docx-import-case.ts`/Worker, browser scan/parity scripts/tests, CLI build-mode smoke, pack/consumer smoke, CI workflow.

- [ ] Register exactly one `docx-import` entry in the existing `apps/browser-export-harness` conformance manifest, expected-ID guard, and registry, with its own `docx-import-case.ts` and module Worker. Extend the engine discriminant/protocol only as required. Do not create a second Vite app or edit generic app/Playwright loops for case-specific behavior.
- [ ] The import case imports only `@atlcli/import-docx/browser` for engine behavior; fixtures and generic harness protocol remain explicit test-only inputs. It never reaches a CLI adapter or `./internal` entrypoint.
- [ ] Parse `feature-zoo.docx` inside a module Worker with no `Buffer`, `process`, DOMParser, filesystem, network, extension API, or remote asset.
- [ ] Set `emitsDigests: true`; extend the existing parity runner/protocol with an offline Node/Bun import oracle that produces IR summary, `DocxImportPlanV1`, target preview projection, Cloud ADF, and DC Storage semantic digests from the same fixture/options. Compare canonical results without tenant or wall-clock data.
- [ ] Run browser/Node/Bun parity for source retention off, attach+none, attach+footer, and attach+comment using placeholder upload identities; choices and plan digests match, footer alone changes the body projection, and no host uploads during conformance planning.
- [ ] Render the shared static HTML preview in production Chromium, exercise issue-to-node highlighting/filtering, and export a canonical override file using browser APIs only. Reimport that override in Node/Bun and prove identical plan digest.
- [ ] Serve production output below a nested non-root path and scan artifacts for forbidden runtimes/eval/remote code.
- [ ] Add source, `bun build --target bun`, and `bun build --compile` dry-run smoke using the same real fixture from a foreign CWD.
- [ ] Extend current pack/file-link/plain-Node/Vite smokes with the import package and add Node 22 and Node 24 ESM import cases in CI; Bun remains the CLI runtime proof.

**Acceptance commands:**

```bash
bun run typecheck
bun run check:browser
bun run build:browser-export-harness
bun run check:browser-export-harness
bun run assert:conformance-cases
bun run check:parity
bun run test:browser-export-harness
bun test apps/cli/src/commands/import-docx-build-modes.test.ts
```

Expected: all exit 0; Chromium has no console/page/request errors; no foreign request; Worker plan/semantic digests and canonical overrides equal Node/Bun; source/dist/binary print the same `DOCX_IMPORT_OK <digest>` marker.

This certifies the package in a neutral browser Worker only. It does not close the deferred Extension/Forge work.

### Task 12 — Prove Cloud behavior with the built CLI in DOCSY

**Depends on:** Tasks 0–11.

**Files:** `apps/cli/src/commands/import-docx.e2e.test.ts`, fixture/report inspectors, `EVIDENCE.md`.

Harness contract:

```text
ATLCLI_E2E=1
ATLCLI_E2E_PROFILE=mayflower       (default)
ATLCLI_E2E_SPACE=DOCSY             (hard requirement)
ATLCLI_E2E_PARENT_ID=<optional dedicated parent>
```

- [ ] Build first; E2E invokes `bun ./dist/index.js`, not source command.
- [ ] Generate a unique title such as `ATLCLI E2E DOCX <run-id>` and track created page ID immediately.
- [ ] Run `--dry-run --plan-out <scoped-temp-path> --preview html --preview-output <scoped-temp-path>` first; validate the plan/HTML and prove no matching page/attachment exists.
- [ ] Import the exact reviewed plan through the built CLI with source path + `--from-plan ... --confirm`; prove source/plan/semantic digests match the dry-run evidence.
- [ ] Separately run built-CLI direct `--confirm` on the Cloud feature-zoo with ADF, images, tables/spans, nested lists, panel/expand/code, TOC if Task 0 proved it, footnotes, comments/replies, and revisions.
- [ ] Parse JSON report; validate schema, target representation, counts, issue policy, and page URL.
- [ ] Fetch page back as ADF and view/export representation; compare semantic digest.
- [ ] Fetch attachments and verify filename/fileId/digest/count and displayed image references.
- [ ] Prove the source-retention matrix through the built CLI: default import creates no original attachment/reference; `--attach-source` creates one `original-docx` attachment with no body/comment reference; `--attach-source --source-reference footer` adds exactly one final page link; `--attach-source --source-reference comment` adds exactly one role-tagged page comment and no footer block.
- [ ] Download every retained original through the normalized Cloud attachment URL and compare exact byte length/SHA-256 to the input. Validate the source-artifact page property, plan digest, remote filename, reference mode/comment ID, and permission-safe page association.
- [ ] Fetch inline/footer comments and verify unique/duplicate selection occurrence, parent/reply, provenance, and counts.
- [ ] Resolve the authenticated Confluence actor; import at least two DOCX authors plus one source author whose display string equals that actor. Assert remote actor remains the real account while all three source attributions remain document identities with exact names/initials/dates.
- [ ] Create an additional native Confluence comment/reply with no import provenance, then run the **built CLI** DOCX exporter with `--comments`. Inspect the ZIP structurally: imported comments use source authors, native comments use resolved platform display names, marker text is absent from logical Word bodies, ranges/thread/resolution/custom provenance match the contract.
- [ ] In the `comment` source-reference case, prove built CLI export excludes the generated source-reference comment from OOXML/comments counts while retaining a same-text native user comment; corrupt provenance in a controlled case must not heuristically suppress that user-visible comment.
- [ ] Reimport that exported DOCX into a second uniquely titled DOCSY page with `--confirm`; fetch its comments/provenance and compare the normalized comment roundtrip digest. Assert imported parent/native reply identity kinds remain distinct.
- [ ] Run a strict fixture with a known unsupported feature; assert failure before page creation.
- [ ] Modify a copy of the source, override file, destination option, and saved plan in four cases; each replay must fail stale before page creation.
- [ ] Inject a post-shell failure; assert rollback and absence from search.
- [ ] In `finally`, delete created page(s) by ID, then poll/read until not found. Search unique run prefix to prove no orphan remains.

**Mandatory command:**

```bash
bun run build
ATLCLI_E2E=1 \
ATLCLI_E2E_PROFILE=mayflower \
ATLCLI_E2E_SPACE=DOCSY \
bun test apps/cli/src/commands/import-docx.e2e.test.ts
```

Expected: exit 0; all live cases pass; cleanup assertions pass. If auth/network is unavailable, record environment limitation but do not check the task or claim Cloud completion.

### Task 13 — Prove Data Center contracts and provide optional community validation

**Depends on:** Tasks 0–11. Task 12 Cloud live certification is independent and may run in parallel.

**Files:** `packages/confluence/src/import-dc-contract.test.ts`, CLI DC contract/build-mode tests, shared optional live E2E path, sanitized community-evidence schema/inspector, docs, `EVIDENCE.md`.

Mandatory project-owned contract suite:

- [ ] Build a deterministic local HTTP test server from the Task 0 documented DC REST v1/Storage contract. It records method/path/query/headers/body and returns realistic success, pagination, version-conflict, auth/permission, not-found, size-limit, malformed-response, and server-error variants without tenant credentials.
- [ ] Run source, built-dist, and compiled-CLI cases against root base URLs and at least two non-root context paths. Assert the existing Data Center auth/profile selection emits the expected auth/TLS request shape without logging secrets and that no Cloud v2 route is called.
- [ ] Exercise the full create-only transaction: dry-run/save/replay, page shell, Storage finalize, labels, content attachments, footer comments/replies, page-property provenance fallback, semantic readback, version conflict, every injected post-shell failure, and rollback.
- [ ] Parse generated Storage/readback fixtures structurally and prove headings, tables/spans, nested lists, links, notes, macros, comment fallback/provenance, and issue policy; do not accept request snapshots alone as roundtrip evidence.
- [ ] Prove DC default-off, attach+none, attach+footer, and attach+comment source retention against the contract server. Re-download/hash exact source bytes, verify context-path-safe links and source-reference role, and prove DOCX export excludes only the provenance-tagged generated thread.
- [ ] Prove the conservative comment capability selected in Task 0: supported documented comment property or page-manifest + visible-marker fallback. Compare normalized two-author import→simulated-DC→DOCX-export→reimport semantics for body/author/thread/range fallback.
- [ ] Assert `--comments inline` fails before page creation; `auto` demotes and reports. Unknown/unsupported DC response shapes fail explicitly and never switch to Cloud or silently omit requested behavior.
- [ ] Record the exact documented API assumptions and fixture variants in `EVIDENCE.md`; do not list a DC version as live-verified merely because its public contract informed a fixture.

Optional community live harness (shipped, not a release gate):

```text
ATLCLI_E2E=1
ATLCLI_E2E_DC_PROFILE=<configured DC profile>
ATLCLI_E2E_DC_SPACE=<dedicated test space>
ATLCLI_E2E_DC_PARENT_ID=<optional>
```

- [ ] Reuse the built-CLI create/readback/export/reimport/source-retention cases rather than maintaining a divergent community script. Every created ID is tracked immediately and removed in `finally`; unique-prefix search proves no orphan remains.
- [ ] Emit optional `atlcli.dc-community-evidence/1` containing AtlCLI commit/version, DC version/build when returned, root-versus-context-path classification, feature/result codes, semantic digests, and cleanup status. Redact base URL, space/page titles, user identity, credentials, raw responses, and document content.
- [ ] With no DC environment variables, the community test skips with an explicit message and exit 0; default CI and release readiness do not require secrets or a DC tenant. A submitted failure becomes a compatibility bug/evidence update, not an automatic Cloud fallback.

**Acceptance:**

- [ ] Mandatory DC contract, Storage structural roundtrip, auth/context-path, source-artifact, comment-provenance, error, and rollback tests all exit 0 across source/dist/compiled CLI where applicable.
- [ ] No `/wiki` segment is injected unless it is literally part of the configured context path; hostile/encoded paths cannot escape the configured base.
- [ ] Preview/report/docs identify DC as `implemented · contract-tested · not project-live-certified`; they do not call it experimental, pending implementation, certified, or live-tested.
- [ ] The optional community harness is documented and cleanup-safe but its absence does not block DC implementation status or release.

### Task 14 — Performance, documentation, operational readiness, and final evidence

**Depends on:** Tasks 1–13 as applicable.

**Files:** docs under `src/content/docs/confluence/`, reference/help pages, troubleshooting, fixture manifest, evidence, CI.

- [ ] Add `src/content/docs/confluence/import-docx.md` using repo docs template: intro, prerequisites, minimal steps, advanced/config path, options, examples, troubleshooting, related topics, feedback/edit link.
- [ ] Update Confluence index, CLI reference, authentication/platform wording, comments page, and relevant troubleshooting.
- [ ] Publish feature/edition matrix with native/approximated/deferred outcomes, exact comment/revision behavior, and separate evidence badges: Cloud `live-certified`; DC `implemented · contract-tested · not project-live-certified`; Server unsupported.
- [ ] Document comment actor versus document attribution, visible marker/property/page-manifest evidence order, privacy limits, modified-body behavior, `wiki export --format docx --comments`, unanchored/thread fallbacks, and the no-name-to-account-resolution rule.
- [ ] Document original-source retention and threat/privacy implications, `--attach-source`, stdin filename handling, `--source-reference none|footer|comment`, default-off/default-none behavior, exact-byte/readback guarantee, rollback semantics, page permissions, exporter exclusion, and browser-extension control mapping.
- [ ] Document review-first TTY behavior, non-TTY contract, `--confirm`, `--dry-run`, terminal/HTML preview, `--plan-out`/`--from-plan`, and why `--confirm` cannot bypass blockers.
- [ ] Document the unified override/style-map schema with precedence, deterministic node IDs, minimal/global/style/node examples, browser portability, stale-plan behavior, and forbidden raw target payloads.
- [ ] Document security budgets, no remote fetch/execution, preview HTML safety, exact dependency pins/upgrades, rollback, strict mode, and original comment-author limitation.
- [ ] Add a large synthetic fixture benchmark and record parse/normalize/encode p50/p95 and peak RSS where measurable. Performance numbers are evidence, not brittle unit thresholds; only broad regression budgets fail CI.
- [ ] Run full verification matrix and record results in `EVIDENCE.md`.
- [ ] Perform one user-assisted visual review in Confluence Cloud: headings/lists/tables/images/panels/code/comments/macros. Record screenshots/checklist; automated readback remains the authoritative regression gate. Accept sanitized optional DC community review evidence, but do not block release on its absence.

**Acceptance:**

- [ ] Docs check/build pass.
- [ ] All current and new tests/typecheck/build/browser gates pass.
- [ ] Cloud DOCSY live E2E passes and cleans up.
- [ ] DC support label is exactly `implemented · contract-tested · not project-live-certified`, backed by Task 13; optional community evidence is additive and separately dated.
- [ ] Feature matrix and report issue codes agree.
- [ ] Cloud comment import→export→reimport live digest passes; DC contract-server import→export→reimport digest and fallback match Task 13 evidence.
- [ ] No private fixture/customer content, absolute paths, credentials, or tenant response dumps are committed.

---

## 15. Verification matrix

Run focused gates during tasks, then this full matrix before each commit permitted by the repository workflow:

```bash
bun install --frozen-lockfile
bun run check:import-dependency-pins
bun test packages/import-docx
bun test packages/confluence/src/client.test.ts packages/confluence/src/comments.test.ts packages/confluence/src/comment-provenance.test.ts
bun test packages/confluence/src/import-dc-contract.test.ts apps/cli/src/commands/import-docx.dc-contract.test.ts
bun test packages/docx/src/comments.test.ts packages/docx/src/export.test.ts
bun test apps/cli/src/commands/export*.test.ts
bun test apps/cli/src/commands/import-docx-build-modes.test.ts
bun test scripts/publish-classification.test.ts scripts/api-report.test.ts scripts/pack-check.test.ts scripts/dev-resolution.test.ts scripts/strip-dev-condition.test.ts
bun run typecheck
bun run check:browser
bun run build
bun run check:extension-output
bun run build:browser-export-harness
bun run check:browser-export-harness
bun run assert:conformance-cases
bun run check:parity
bun run test:browser-export-harness
ATLCLI_CONSUMER_SMOKE=1 bun --conditions=development test scripts/consumer-smoke.test.ts scripts/install-matrix.test.ts
bun run docs:check
bun run docs:build
```

Live Cloud gate:

```bash
ATLCLI_E2E=1 ATLCLI_E2E_PROFILE=mayflower ATLCLI_E2E_SPACE=DOCSY \
  bun test apps/cli/src/commands/import-docx.e2e.test.ts
```

Optional community DC validation (never a project release gate):

```bash
ATLCLI_E2E=1 \
ATLCLI_E2E_DC_PROFILE=<profile> \
ATLCLI_E2E_DC_SPACE=<space> \
  bun test apps/cli/src/commands/import-docx.e2e.test.ts
```

Expected for every mandatory gate and every invoked optional community run: exit 0, zero failed tests, no orphan E2E resources. Exact passing counts and runtime versions go into `EVIDENCE.md`; do not copy planned counts into evidence. Absence of DC credentials is an explicit skip, not a missing mandatory result.

### CI additions

- Default Linux job: frozen install, exact import-dependency pin check, import package/unit/security/fixture/plan/override/preview tests, Confluence provenance + DOCX comment roundtrip tests, mandatory DC HTTP/Storage/auth/context-path/rollback contracts, browser build scan, full build.
- Existing browser-conformance job: production Vite build, manifest/registry drift assertion, output scan, semantic parity, and pinned Playwright Chromium E2E including `docx-import`.
- Consumer-smoke job: real pack/file-link installs, `skipLibCheck: false`, and import semantic digest through Bun, plain Node, and vanilla Vite without workspace-source resolution.
- Node matrix: Node 22 and 24 ESM parser/encoder smoke from built/packed exports.
- macOS import packaging smoke mirroring release platform coverage.
- Windows compiled-binary dry-run smoke if the release continues to ship Windows binaries.
- Live Cloud tests remain credential-gated and are not run on untrusted PRs; Cloud `live-certified` requires recent recorded evidence. Optional community DC runs are manual/credential-gated and never required for release; DC `contract-tested` requires the mandatory project-owned suite, while `live-certified` is never claimed by default.

---

## 16. Git and delivery workflow

- Suggested branch: `codex/import-docx-mvp`.
- Conventional commits, for example:
  - `feat(import-docx): add safe semantic parser core`
  - `feat(confluence): add edition-aware page body publisher`
  - `feat(cli): import docx pages`
  - `test(import-docx): prove Cloud live and DC contract readback`
  - `docs: document DOCX import`
- Never push or release unless explicitly instructed.
- Never release automatically; any eventual release follows the repository dry-run release workflow.
- Repository policy requires E2E before committing. Until Task 12 exists, keep implementation checkpoints uncommitted or in a disposable executor worktree. Once the harness exists, run the built-CLI DOCSY E2E and cleanup before every logical commit. Do not substitute mocked/transport tests.
- Stage only named in-scope files. Preserve unrelated dirty worktree changes.
- Documentation ships in the same implementation PR.

---

## 17. Definition of Done

All boxes must be backed by evidence:

- [ ] `@atlcli/import-docx` accepts `Uint8Array` and emits deterministic `ImportDocument` without Node/Bun/DOM dependencies.
- [ ] Every newly introduced external production/dev dependency is exact-pinned; frozen install and scoped manifest/lockfile gate pass; each dependency has license/provenance/security/runtime/size evidence and an explicit rationale.
- [ ] Unsafe ZIP/OOXML inputs are rejected before parser decompression or any Confluence write.
- [ ] Feature corpus covers Word, LibreOffice, Google Docs, comments, revisions, tables, assets, fields, advanced drawings, and adversarial inputs.
- [ ] No unsupported feature is silently lost; issue coverage invariant passes.
- [ ] Cloud encoder emits validated ADF; DC encoder emits valid Storage XHTML.
- [ ] Cloud media and macro intents are only marked native when Task 0/live E2E proves them.
- [ ] Cloud comments preserve exact selection/index/replies where possible and transparently demote otherwise.
- [ ] DC inline comments are not falsely claimed; documented fallback works.
- [ ] Original comment author/initials/date/range/thread/resolution and revision metadata remain observable even though Confluence authorship cannot be impersonated.
- [ ] Confluence comment `actor` and document `attribution` are independently typed/read back; display-name equality never merges them and no document name is resolved to an account.
- [ ] Built CLI DOCX export with `--comments` writes standard Word comment fields from source attribution for imported comments and platform display name for native comments; custom provenance loss has the tested standard-field fallback.
- [ ] Cloud DOCSY import→DOCX export→reimport preserves the normalized comment digest and cleans both pages/resources; the DC contract server proves the corresponding Storage/fallback digest and failure semantics without a live-certification claim.
- [ ] Publisher rollback/readback/version-conflict tests pass at every transition.
- [ ] Original-source retention defaults off; attach+none, attach+footer, and attach+comment are plan-digest-bound, Cloud-live-proven, DC-contract-proven, and roll back rather than silently degrading. The original remains a distinct immutable source artifact and is never overwritten by export.
- [ ] A provenance-tagged source-reference comment is excluded from document-comment counts/DOCX export, while lookalike or provenance-lost user comments are never suppressed heuristically.
- [ ] Preview body/projection, plan JSON, terminal summary, static HTML, and publisher share one semantic digest and issue/override provenance; no second mapping path exists.
- [ ] `wiki import` help, review-first TTY flow, `--confirm`, dry-run, strict, HTML preview, plan-out/replay, overrides, JSON/report, progress, stdin, title/space/parent, comments, revisions, source attachment/reference, and labels behave as specified.
- [ ] Non-TTY cannot hang or mutate without `--confirm`; strict/hard safety/plan-integrity blockers cannot be overridden.
- [ ] Saved-plan replay rejects changed source/options/overrides/capabilities/destination/plan before any network call.
- [ ] Source, dist, and compiled binary dry-run the same real fixture with the same digest.
- [ ] Node 22, Node 24, Bun, and neutral browser Worker produce matching semantic digests.
- [ ] `bun run typecheck`, full `bun test`, browser checks, build, harness E2E, docs check/build all pass.
- [ ] Built CLI live Cloud E2E passes against `mayflower`/`DOCSY`, proves semantic readback, and deletes every resource.
- [ ] Data Center’s full import path passes Task 13 and is labeled `implemented · contract-tested · not project-live-certified`; optional community live evidence is additive, sanitized, dated, and never required for release.
- [ ] Browser extension, native remote draft preview, Tauri desktop app, Forge, PDF import, existing-page update, batch import, and Server certification remain explicitly deferred.
- [ ] `specs/import-docx-mvp/EVIDENCE.md` contains actual, current evidence rather than planned assertions.

---

## 18. STOP conditions

Stop and revise the plan if:

- the selected parser cannot retain exact comment range markers or insert/delete revisions on the checked fixtures;
- supplemental reply/resolution parsing would require copying an entire generic OOXML stack into AtlCLI;
- the parser’s license/transitive licenses, install scripts, vulnerability profile, or maintenance status are unacceptable;
- a required new dependency cannot be exact-pinned to an auditable published artifact, requires an unpinned branch/URL, has unacceptable provenance/license/install behavior, or cannot pass the frozen-lockfile/browser gate;
- Cloud attachment upload cannot yield a stable, public-API-backed ADF media reference;
- original-DOCX upload/download cannot prove byte identity or target-safe body/comment attachment links for a claimed edition;
- Cloud macro ADF requires undocumented tenant-specific payloads;
- Cloud REST v2 rejects otherwise valid ADF structures that the planned validator considers native;
- Data Center target behavior requires undocumented APIs or version-specific payloads with no capability gate;
- correct implementation requires raw XML/ADF passthrough, remote resource fetching, VBA/OLE execution, or disabling security budgets;
- a browser Worker requires `eval`/`new Function`, DOM globals, Node polyfills, or remote executable code;
- preview generation requires a separate semantic mapping path, active/remote content, or cannot prove the same digest/issue decisions as publication;
- `--from-plan` cannot reliably detect changed source, overrides, target capabilities, destination, or serialized plan before network mutation;
- no human-readable attribution marker shape survives Cloud live create/read/view or the complete DC Storage transport/readback contract closely enough for deterministic recognition;
- the exporter cannot inject schema-valid standard Word comments/ranges without losing or reordering existing document content, or comment roundtrip would depend on the optional custom part;
- existing page mutation becomes necessary for the MVP;
- semantic readback cannot distinguish loss of core text/list/table content;
- mandatory Cloud E2E or an invoked optional community DC run cannot reliably delete only resources created by its run;
- implementation needs to add a third `server` deployment type. That is a separate product/support decision.

Do not paper over a STOP condition with a warning code.

---

## 19. Deferred follow-ups

### 19.1 Browser extension

The intended browser-extension shape is session-adjacent, not profile-driven. It runs beside an active Confluence tab/session. A future spec must require the host adapter to verify and lock:

- site/base URL and Data Center context path;
- Cloud versus Data Center deployment;
- authenticated session/transport availability;
- current space/page context and permitted destination choices;
- capability digest used by `DocxImportPlanV1`.

The review header displays this as a read-only target badge including `live-certified` (Cloud) or `contract-tested · not project-live-certified` (DC). There is **no Cloud/DC toggle** and no arbitrary profile picker in the extension. Missing, unsupported, cross-tab-conflicting, or changed host detection blocks planning/publication and invalidates an open preview before mutation.

The intended UI flow is:

```text
select/drop DOCX -> Worker analysis -> target-locked review -> import progress -> verified result
                                      |
                                      +-> export atlcli.docx-import-overrides/1
                                      +-> cancel with zero remote writes
```

Review layout should contain:

- verified destination/title/target context at the top;
- semantic future-wiki preview in the main pane, clearly labeled as Confluence preview rather than Word fidelity;
- issue/decision inspector with outcome filters and click-to-highlight source/preview nodes;
- global, style, and node override controls that rerun the pure plan and update its digest live;
- an unchecked **Retain original DOCX as page attachment** checkbox; when selected, a subordinate exclusive choice **No visible reference** (default), **Link at page end**, or **Page comment with link**. Changing either control regenerates the plan/digest; reference choices never imply an upload;
- fixed summary/CTA with page, attachment, comment, warning, and blocker counts;
- primary review/import flow plus a secondary **Import directly** action. Direct import skips rendering the detailed review but still runs preflight/planning, blocks on hard errors, and requires a compact warning acceptance when degradations exist.

The browser UI imports/exports exactly `atlcli.docx-import-overrides/1`; it does not invent browser-only mapping state. It consumes `ImportPreviewDocument` from the MVP core and cannot directly emit ADF/Storage.

Separate future spec must additionally decide and prove:

- file picker/drag-drop and maximum browser file size;
- MV3 side-panel vs service-worker/offscreen ownership;
- parser/preview bundle splitting and startup latency;
- durable jobs, cancellation, progress, navigation/restart recovery;
- session-auth publisher, permissions, CSP, memory quotas, attachment upload;
- exact source-attachment upload/download verification, raw-original metadata/privacy disclosure, target-safe footer/comment links, generated-comment provenance, and exporter exclusion;
- active-tab/site changes while review is open;
- extension-specific E2E in production MV3 output;
- rollback/result UX and accessibility/keyboard/screen-reader behavior.

The neutral `docx-import` case in the existing browser conformance harness is an input to that work, not its acceptance proof.

### 19.2 Native Confluence staged preview

A later optional action may create a remote Cloud draft, upload assets, and open Confluence’s own renderer/editor for higher-fidelity macro/media review. Requirements before implementation:

- name it **Preview in Confluence** or **remote staged preview**, never local/dry-run preview;
- capability-gate it; do not infer Data Center parity from Cloud draft behavior;
- show that remote state will be created and require explicit consent;
- use a unique import marker and track every created draft/attachment by returned ID;
- prove publish/discard, cancellation, timeout, navigation, attachment/comment lifecycle, and `finally` cleanup with live E2E;
- never make this remote path necessary for the portable CLI/browser preview or for `--dry-run`.

### 19.3 Tauri desktop app

The planned desktop shape may later offer profile selection, Cloud/DC comparison, multi-site destinations, filesystem integration, and richer plan management. None of those choices belong to the session-adjacent extension or this MVP. A Tauri spec must reuse the same core contracts but separately prove credential storage, updater/security model, filesystem permissions, native dialog behavior, browser/webview bundle compatibility, and per-profile capability freshness.

### 19.4 Forge

Separate future spec must test Node runtime versus Custom UI, static resource/WASM packaging if relevant, function time/memory limits, upload sizes, scopes, app-access rules, CSP, and Marketplace eligibility. The core remains host-neutral so both shapes can reuse it.

### 19.5 Existing-page update/merge

Requires a three-way semantic merge, version conflict UI, attachment reconciliation, comment reanchoring, rollback without deleting existing pages, and explicit overwrite confirmation.

### 19.6 PDF import

Requires a separate extraction/layout/OCR strategy and confidence-driven UX. It must not reuse DOCX assumptions merely because both end at the same target IR.

### 19.7 Confluence Server

No distinct target in this plan. If product policy later restores Server certification, add an explicit deployment/support matrix and live fixtures rather than assuming the DC path certifies an end-of-support Server release.

### 19.8 Advanced fidelity

- native equation mapping;
- deterministic EMF/WMF rendering;
- chart data extraction to Confluence charts/tables;
- SmartArt relationship reconstruction;
- crop/rotation/vector transforms;
- arbitrary app macro mappings behind installed-app capability discovery;
- batch import and directory hierarchy;
- a visual diff service for long-lived regression baselines.

---

## 20. Risks and mitigations

| Risk | Failure signal | Mitigation / gate |
|---|---|---|
| Young parser changes shape | upgrade breaks goldens/types | exact pin, adapter boundary, fixture corpus, upgrade bot/manual gate |
| New dependency drifts or is replaced upstream | lockfile/manifest pulls unreviewed code | exact direct pins, frozen lockfile, provenance/integrity evidence, no auto-merge |
| ZIP bomb or malformed OOXML | memory/CPU spike before validation | central-directory preflight before parser, hard budgets, adversarial tests |
| Cloud ADF accepted but normalized destructively | readback digest differs | live readback is required; core mismatch rolls back |
| Attachment ID confused with media file ID | broken image after 2xx | Task 0 media probe and v2 attachment readback |
| Original silently omitted or changed | legal/reference baseline is missing or unverifiable | explicit opt-in + digest-bound policy, exact-byte upload/download proof, fatal failure and rollback |
| Raw original exposes hidden metadata/revisions | users upload more information than the wiki rendering shows | default off, prominent review disclosure, page-permission guidance, no unsafe-package bypass |
| Source-reference comment becomes a Word comment or hides user content | polluted roundtrip or data loss | authoritative `source-reference` role/property, filter before export, never identify/suppress by visible text |
| Word comment selects repeated text | wrong highlight | exact range→target occurrence algorithm and duplicate-selection E2E |
| Original authors appear falsified | comments authored by token user | provenance prefix/report; docs state limitation |
| DOCX author name is mistaken for tenant user | false identity/account association | separate actor/attribution types; never resolve literal names; same-name collision tests |
| User text mimics or edits attribution marker | wrong author/body on export | property/manifest evidence precedence, strict marker grammar, evidence label, malformed text retained, conflict issue |
| Comment property/custom OOXML part is unavailable or stripped | identity kind/thread metadata degrades | page manifest + visible marker + standard Word fields; removal/reimport regression fixture |
| Imported comment body changes in Confluence | source author appears to own later edits | retain actor separately, body digest mismatch issue, never infer editor identity |
| DC gets Cloud v2 call | 404/405 under on-prem | capability dispatch once, exact root/context-path transport suite, optional community validation |
| Storage/ADF encoders drift | one edition loses feature | shared corpus + cross-target semantic digest + separate goldens |
| New import/comment API bypasses current package guarantees | source works but packed/consumer builds drift or frozen DOCX surface breaks | 0.x classification for import core, smallest additive DOCX seam, reviewed API report/closure, pack/file-link/Node/Vite gates |
| Style heuristics surprise users | colored paragraph becomes macro | semantic/style-ID mapping only; explicit versioned style map |
| Preview differs from publication | user approves a different result | one target encoding result, shared semantic projection/digest, mutation regression test |
| Saved plan or source changes after review | unreviewed content is imported | rebuild from original DOCX and compare source/options/override/capability/body/plan digests before network |
| Override file injects target/active content | XSS or arbitrary macro/XML/ADF | semantic union only, hostile parser fixtures, duplicate-key/prototype defenses, no raw fragments |
| Preview HTML executes DOCX content | local script/network/data leak | escaping, CSP, no remote assets, active SVG handling, headless no-request proof |
| Extension target changes mid-review | Cloud/DC/site mismatch | locked verified host identity, capability digest, invalidate plan on tab/session change; no toggle |
| Partial page remains after failure | import shell/orphan attachments | state machine, default rollback, prominent partial report, cleanup tests |
| Browser compile passes but runtime fails | worker crashes/global missing | production Chromium Worker E2E with no DOM/Buffer/process/network |
| Huge fixture suite slows CI | developers skip tests | tag fast/full corpus; security/core fixtures remain mandatory; record budgets |
| Server wording creates false promise | docs/users infer certification | Cloud/DC names in new docs; Server only deferred compatibility note |

---

## 21. Authoritative references

- AtlCLI current body/client seams: `packages/confluence/src/client.ts`, `apps/cli/src/commands/page.ts`.
- AtlCLI isomorphic model pattern: `packages/confluence/src/export-blocks.ts`, `packages/docx/src/index.browser.ts`, `scripts/check-browser-build.ts`.
- AtlCLI proof pattern: `apps/cli/src/commands/export-pdf-build-modes.test.ts`, `apps/cli/src/commands/export-pdf.e2e.test.ts`, `apps/browser-export-harness/tests/exports.e2e.ts`.
- AtlCLI package/API proof: `scripts/api-report.ts`, `scripts/api-closure.ts`, `scripts/pack-check.test.ts`, `scripts/consumer-smoke.test.ts`, `.github/workflows/consumer-smoke.yml`.
- Cloud page REST v2: <https://developer.atlassian.com/cloud/confluence/rest/v2/api-group-page/>
- Cloud comments REST v2: <https://developer.atlassian.com/cloud/confluence/rest/v2/api-group-comment/>
- Cloud comment/page content properties REST v2: <https://developer.atlassian.com/cloud/confluence/rest/v2/api-group-content-properties/>
- Cloud attachments REST v2: <https://developer.atlassian.com/cloud/confluence/rest/v2/api-group-attachment/>
- Atlassian Document Format structure/schema: <https://developer.atlassian.com/cloud/jira/platform/apis/document/structure/>
- ADF table/cell/media/panel nodes: <https://developer.atlassian.com/cloud/jira/platform/apis/document/nodes/table/>, <https://developer.atlassian.com/cloud/jira/platform/apis/document/nodes/table_cell/>, <https://developer.atlassian.com/cloud/jira/platform/apis/document/nodes/media/>, <https://developer.atlassian.com/cloud/jira/platform/apis/document/nodes/panel/>
- Data Center REST overview/examples: <https://developer.atlassian.com/server/confluence/confluence-server-rest-api/>, <https://developer.atlassian.com/server/confluence/confluence-rest-api-examples/>
- Data Center content properties: <https://developer.atlassian.com/server/confluence/content-properties-in-the-rest-api/>
- Microsoft Open XML comment insertion/range/reference contract: <https://learn.microsoft.com/en-us/office/open-xml/word/how-to-insert-a-comment-into-a-word-processing-document>
- Microsoft Office 2013 threaded/resolved `commentEx` contract: <https://learn.microsoft.com/en-us/previous-versions/office/jj622926(v=office.15)>
- `@office-open/docx`: <https://github.com/DemoMacro/office-open>
- Mammoth comparison baseline: <https://github.com/mwilliamson/mammoth.js>
- Atlassian Server end-of-support context: <https://www.atlassian.com/licensing/server-end-of-support>

---

## 22. Unresolved questions

There are no product choices required before starting Task 0. The remaining uncertainties are intentionally evidence gates, not decisions to guess:

1. Exact public Cloud ADF media identity/collection after attachment upload.
2. Reproducible Cloud TOC macro ADF payload through public APIs.
3. Completeness of comment reply/resolved metadata from the selected parser plus OOXML extension parts.
4. Exact Cloud comment-property value/version behavior and Data Center comment-content-property support/version floor; page manifest + marker remains the defined fallback.
5. Preservation behavior of the optional AtlCLI custom comment-provenance part after Word and LibreOffice save; standard Word comment fields remain the fallback contract.
6. Whether Cloud accepts nested tables/task nodes produced by the chosen ADF subset without destructive normalization.

Maintainer access to a live Data Center tenant is explicitly **not** an unresolved prerequisite. Any later community-operated live result is optional additive evidence under Task 13.

If a gate fails, stop at the owning task and update this plan with the observed contract and revised scope.
