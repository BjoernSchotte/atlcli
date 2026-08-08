# Plan 004: Import DOCX bytes from an existing Confluence attachment

Status: **Planned**

Planned at: `18f6f1e`, 2026-07-20

Priority: **P1** · Effort: **M** · Risk: **MEDIUM**

Depends on: completed `specs/import-docx-mvp/PLAN.md`

> **Executor instructions:** Keep the core byte-oriented and host-neutral. This plan adds an imperative source adapter; it must not teach the parser about URLs, credentials, REST clients, or browser sessions. Record Cloud seed/source/destination IDs, digests, transport fixtures, and cleanup in `specs/004-import-docx/EVIDENCE.md`.

---

## 1. Outcome and JTBD

The CLI can use a DOCX already attached to an accessible Confluence page as its source, download it with the selected Cloud/DC profile, run the exact MVP safety/preflight pipeline, and import it into a new page. The reviewed source identity and downloaded digest are immutable through publication.

JTBD: **convert a document that is already governed/stored in Confluence without downloading it manually, while retaining the same security, preview, fidelity, and provenance guarantees as a local file**.

Research basis:

- Aptify advertises local upload or an existing Confluence attachment as source, including a path for documents over 20 MB: https://marketplace.atlassian.com/apps/631785764/advanced-word-importer-for-confluence
- Cloud documents importing local DOCX and OneDrive sources, which confirms source acquisition is a distinct workflow concern: https://support.atlassian.com/confluence-cloud/docs/import-content-into-confluence-cloud/
- Confluence attachment permissions and page association matter independently from page creation: https://support.atlassian.com/confluence-cloud/docs/upload-and-manage-files/

Vendor size claims are not treated as AtlCLI/API limits. AtlCLI applies its own proven download/package/target budgets.

---

## 2. Scope

In scope:

- attachment source by stable page/content ID plus attachment ID, with filename selector as a guarded convenience;
- Cloud and Data Center authenticated download adapters;
- exact attachment version selection (`latest` default or explicit version where API-supported);
- bounded download, redirects/origin policy, digest, media type/name checks, and DOCX preflight;
- saved-plan/replay integrity and source provenance;
- optional `--attach-source` copying the bytes to the destination page as a distinct retained original;
- Cloud DOCSY live E2E and DC contract suite.

Out of scope:

- OneDrive/SharePoint/Google Drive OAuth;
- browser-extension session transport;
- remote arbitrary URLs;
- scheduled synchronization/watchers;
- importing an attachment by display-name search across a whole site;
- trusting the source attachment because it is already in Confluence.

---

## 3. Architecture

Keep the MVP boundary:

```text
ConfluenceAttachmentSource (CLI imperative adapter)
  -> edition-aware attachment metadata lookup
  -> bounded authenticated byte download
  -> AcquiredDocxSource { bytes: Uint8Array, descriptor, sha256 }
  -> unchanged safe ZIP/OOXML preflight and import core
```

```ts
export type DocxSourceDescriptor =
  | { kind: "local-file"; basename: string }
  | { kind: "stdin"; suppliedFilename?: string }
  | {
      kind: "confluence-attachment";
      deployment: "cloud" | "data-center";
      siteFingerprint: string;
      pageId: string;
      attachmentId: string;
      attachmentVersion?: number;
      filename: string;
      mediaType?: string;
    };

export interface AcquiredDocxSource {
  descriptor: DocxSourceDescriptor;
  bytes: Uint8Array;
  sha256: string;
  byteLength: number;
}
```

Rules:

1. Only the CLI/Confluence adapter sees auth/profile/network. `@atlcli/import-docx` still accepts `Uint8Array` plus inert source metadata.
2. Attachment ID is canonical. A filename selector must resolve to exactly one visible attachment/version on the specified page or block with candidate IDs; never pick the first result.
3. Download redirects must stay within the normalized selected Confluence origin and allowed attachment path unless the official Cloud download contract proves a signed Atlassian host. Record the final origin contract; never forward auth headers to an untrusted host.
4. Apply compressed/uncompressed/relationship/XML budgets after download exactly as for local files. Already-hosted content is untrusted input.
5. `DocxImportPlanV1.source` stores the inert descriptor, exact attachment version/ID, byte length, and digest, never auth headers, token, raw URL, or tenant response.
6. Saved-plan replay refetches metadata/bytes and fails stale if version, bytes, ID, or target capability/destination digest changed.
7. `--attach-source` remains independent. When selected, the downloaded bytes are uploaded byte-identically to the new destination page and verified; a source attachment on another page is not treated as destination retention.
8. Reading and writing may use different profiles only in a future cross-site plan. This plan requires one selected profile/site and blocks cross-origin source descriptors.

Proposed files:

```text
apps/cli/src/commands/import-source.ts
apps/cli/src/commands/import-request.ts
packages/confluence/src/attachments.ts
packages/confluence/src/client.ts
packages/confluence/src/capabilities.ts
packages/import-docx/src/import-plan.ts
packages/import-docx/src/report.ts
```

---

## 4. CLI contract

Add one mutually exclusive source form:

```text
atlcli wiki import --from-attachment <page-id>:<attachment-id> [options]

Optional guarded selector:
  --attachment-name <filename>   requires --source-page <page-id>;
                                 exact unique match only
  --attachment-version <number>  requires attachment source
```

The executor may choose either the compact ID form or the separate `--source-page/--source-attachment` pair after checking existing CLI parsing conventions, but must expose one canonical form, not both aliases. Local positional file/stdin and remote attachment source are mutually exclusive.

Because attachment acquisition itself is a Confluence read, `--from-attachment --dry-run` requires the baseline `--check-target` flag. It enables only the typed metadata/download/capability/title read port and remains zero-mutation. Offline dry-run rejects remote attachment input with an actionable message rather than pretending to analyze unavailable bytes.

Preview displays site/deployment, source page ID, attachment ID/version, filename, byte size, and digest. It does not print signed URLs or profile secrets.

---

## 5. Tasks

### Task 0 — Prove download contracts

- [ ] Document exact Cloud and DC attachment metadata/download endpoints, pagination, context path, redirect behavior, IDs, versions, content length, media type, and permission/not-found responses.
- [ ] Probe Cloud in `mayflower`/`DOCSY` with a disposable seed page/attachment and delete it in `finally`.
- [ ] Encode DC behavior into the deterministic local HTTP server; optional community live evidence remains additive.
- [ ] Establish safe maximum bytes/time/redirect count and signed-host rules.

Acceptance:

- [ ] No raw guessed URL shape remains in core/CLI.
- [ ] Cross-origin redirect and auth-header forwarding tests fail safely.

### Task 1 — Add normalized attachment read port

- [ ] Add metadata lookup and bounded streaming download to `@atlcli/confluence`.
- [ ] Normalize errors without including response bodies/tokens.
- [ ] Resolve filename only when exactly one allowed attachment/version matches.
- [ ] Abort on declared or streamed size overflow.

Acceptance/tests:

- [ ] Cloud/DC transport tests cover success, context path, pagination, ambiguity, permissions, not found, stale version, missing/incorrect length, interrupted stream, over-budget, malicious redirect, and malformed metadata.
- [ ] Returned bytes/digest are exact and never converted through text/base64 unnecessarily.

### Task 2 — Integrate source acquisition and plan integrity

- [ ] Extend source union, report schema, canonical plan serialization, and preview.
- [ ] Feed downloaded `Uint8Array` into the unchanged MVP preflight/parser.
- [ ] Refetch/revalidate on saved-plan replay and immediately before first mutation according to the baseline TOCTOU contract.
- [ ] Preserve downloaded bytes in the same immutable `PreparedImport` used for approval/publication.

Acceptance/tests:

- [ ] Local, stdin, and attachment sources produce identical semantic digests for identical bytes.
- [ ] Attachment version/byte change makes the plan stale before destination mutation.
- [ ] Unsafe DOCX bytes are rejected before parser invocation even when hosted in Confluence.

### Task 3 — CLI UX and source-retention interactions

- [ ] Add flags/help/completion/minimal and advanced examples.
- [ ] Reject multiple/no source forms and attachment-only flags on local input.
- [ ] Require `--check-target` for attachment-source dry-run; type/runtime tests prove that its read-only port cannot create/update/upload/comment/label/property/delete.
- [ ] Implement attach-source off/on behavior with distinct source and destination attachment identities.
- [ ] Keep JSON stdout and redacted diagnostics stable.

Acceptance/tests:

- [ ] Parser table covers every source/flag combination.
- [ ] Source attachment without `--attach-source` creates no copy on the destination.
- [ ] With `--attach-source`, destination download verification matches the acquired source SHA-256.

### Task 4 — E2E and docs

- [ ] Built CLI creates a DOCSY seed page, uploads a known DOCX, imports it by attachment ID, verifies body/comments/assets/report, and cleans source/destination resources in `finally`.
- [ ] Repeat with retained-original none/footer/comment modes where applicable.
- [ ] Run full DC contract transaction with context-path and error injection.
- [ ] Document permissions, privacy, sizes, stale versions, and troubleshooting.

---

## 6. Verification gates

```bash
bun install --frozen-lockfile
bun test packages/confluence packages/import-docx apps/cli
bun run typecheck
bun run build
bun run check:browser
bun run docs:check
bun run docs:build
git diff --check
```

---

## 7. Definition of Done

- [ ] Existing attachment bytes use the exact MVP safety and semantic pipeline.
- [ ] Cloud/DC download contracts are normalized, bounded, and tested.
- [ ] Preview/reports are useful without exposing URLs or secrets.
- [ ] Replay and pre-write checks detect source drift.
- [ ] Retained-original behavior is explicit and byte-proven.
- [ ] Cloud live E2E cleans every source/destination resource; DC is contract-tested only.
- [ ] `specs/004-import-docx/EVIDENCE.md` is complete.

## 8. STOP conditions

STOP if download requires forwarding credentials to an unproven origin, attachment IDs/versions cannot be made stable, filename selection is ambiguous, the API cannot enforce configured byte budgets, or implementation pressure moves network/auth logic into the isomorphic import package.

## 9. DAG

This plan starts in parallel with Plans 002, 003, and 005–008 after MVP. No later plan requires it; Plan 010 may add attachment manifests only through a separate explicit extension.
