# Plan 005: Add destination governance and private staging contracts

Status: **Planned**

Planned at: `18f6f1e`, 2026-07-20

Priority: **P1** · Effort: **L** · Risk: **HIGH**

Depends on: completed `specs/import-docx-mvp/PLAN.md`

Unblocks: `specs/import-docx/010-batch-import/PLAN.md`

> **Executor instructions:** Confluence access control is security-sensitive and edition-specific. Use stable target identities and proven APIs only. Never infer a Confluence account/group from a DOCX author, display name, email, or Word protection setting. Record sanitized capability probes, effective-access assertions, page IDs, and cleanup in `specs/import-docx/005-destination-governance/EVIDENCE.md`.

---

## 1. Outcome and JTBD

An import plan can describe and preview not only title/space/parent/labels but also the intended visibility, staging state, and validated destination metadata. Publication either proves that governance outcome or fails/rolls back; it never reports success for a page accidentally visible to a broader audience.

JTBD: **place migrated material in the right hierarchy and visibility boundary so a team can review it privately before wider publication, without manually repairing permissions and metadata page by page**.

Research basis:

- Native Cloud multi-import creates child content below a restricted “Imported pages” container for private review: https://support.atlassian.com/confluence-cloud/docs/import-content-into-confluence-cloud/
- A February 2025 user asks to combine Word import with an existing page/template, Page Properties, and labels: https://community.atlassian.com/forums/Confluence-questions/Import-Word-to-an-EXISTING-page-on-Confluence/qaq-p/2932270
- Cloud content restrictions are distinct from space permissions and can only reduce access: https://support.atlassian.com/confluence-cloud/docs/what-are-confluence-cloud-permissions-and-restrictions/
- Page-level permissions require target-specific handling: https://support.atlassian.com/confluence-cloud/docs/manage-permissions-on-the-page-level/

---

## 2. Scope

In scope:

- versioned governance intent in `DocxImportPlanV1`;
- policies `inherit`, `private`, and explicit stable user/group principals;
- optional import-owned staging parent for single-page review, reusable by Plan 010;
- labels plus bounded, allowlisted content-property metadata;
- effective-capability/permission preflight, preview, readback, rollback, and audit report;
- Cloud live E2E and DC deterministic contracts.

Out of scope:

- importing Word permissions/protection/signatures;
- display-name/email matching or impersonation;
- changing space/global permissions;
- arbitrary template execution, raw ADF/Storage wrappers, arbitrary macros, or app-specific Page Properties macros without capability proof;
- publishing/approval workflow engines such as Comala;
- remote draft preview from MVP Section 19.2; staging here is explicit persisted Confluence content.

---

## 3. Contracts and invariants

```ts
export type DestinationRestrictionPolicy =
  | { mode: "inherit" }
  | { mode: "private" }
  | {
      mode: "explicit";
      viewers: DestinationPrincipal[];
      editors: DestinationPrincipal[];
    };

export type DestinationPrincipal =
  | { kind: "cloud-account"; accountId: string }
  | { kind: "cloud-group"; groupId: string }
  | { kind: "dc-user"; userKey: string }
  | { kind: "dc-group"; groupName: string };

export interface DestinationGovernancePlanV1 {
  schema: "atlcli.docx-destination-governance/1";
  restriction: DestinationRestrictionPolicy;
  staging:
    | { mode: "none" }
    | { mode: "private-parent"; requestedTitle: string; resolvedTitle: string };
  labels: string[];
  contentProperties: Array<{
    key: string;
    value: string | number | boolean | null;
  }>;
  capabilitiesDigest: string;
  effectiveAccessSummary: string[];
}
```

Invariants:

1. Destination principal kinds are edition-specific unions. A plan cannot replay Cloud identities against DC or vice versa.
2. `private` resolves to the narrowest proven reviewer set that includes the authenticated importer. If an edition/API cannot prove this safely, it blocks; it does not fall back to inherited visibility.
3. `inherit` means no extra page restriction and must show the effective inherited visibility summary available from the target APIs.
4. Explicit principals are resolved before approval and included by stable identifier in the digest. User-facing names are display-only evidence.
5. An import-owned staging parent has a unique marker/property and is created/restricted/read back before its child page. Any failure rolls back both by returned IDs in reverse order.
6. Content properties are flat, size-bounded, schema-validated, non-secret metadata under an AtlCLI namespace unless a separately proven allowlist exists. They cannot contain raw page bodies/macros/scripts.
7. Labels, restrictions, and properties are required outcomes when selected. Failure is fatal; they are not “nonessential last mutations”.
8. The preview must state that attachment download follows page visibility and that AtlCLI cannot independently prevent downloads from users who can view the page.
9. Plan 010 may reuse this contract for a batch staging root; it must not invent another permissions model.

Proposed files:

```text
packages/confluence/src/restrictions.ts
packages/confluence/src/principals.ts
packages/confluence/src/content-properties.ts
packages/confluence/src/capabilities.ts
packages/confluence/src/import-publisher.ts
packages/import-docx/src/destination-governance.ts
packages/import-docx/src/import-plan.ts
packages/import-docx/src/preview-model.ts
apps/cli/src/commands/import-request.ts
apps/cli/src/commands/import-report.ts
```

---

## 4. CLI/manifest UX

```text
--restriction <mode>        inherit|private|explicit (default inherit)
--viewer <principal>        repeatable; explicit mode only
--editor <principal>        repeatable; explicit mode only
--staging-parent <title>    create a private import-owned parent
--content-property <k=v>    repeatable, allowlisted/size-bounded
```

Principal syntax must encode kind explicitly, for example `account:<id>`, `group-id:<id>`, `user-key:<key>`, or `group:<name>`. The CLI must reject a kind invalid for the selected edition before network mutation.

Plan 010 may additionally load these fields per document from a versioned batch manifest. No YAML merge keys, executable tags, or prototype-bearing deep merge.

Offline dry-run validates only syntax and edition-shaped principal kinds; it marks identity/effective-access/capability evidence unchecked and non-publishable. `--dry-run --check-target`, normal interactive review, and `--confirm` resolve/read effective governance through a typed read-only port before approval. A replayable plan requires that checked snapshot.

---

## 5. Tasks

### Task 0 — Prove Cloud/DC restriction and identity contracts

- [ ] Document create/read/update/delete restrictions and stable principal identifiers for Cloud.
- [ ] Build exact DC REST/Storage restriction fixtures, version floors, context paths, permission failures, and inherited behavior from authoritative contracts.
- [ ] Determine whether restrictions can be applied atomically at creation; if not, design the shell so it contains no sensitive imported content until restriction readback succeeds.
- [ ] Prove bounded content-property and label contracts.

Acceptance:

- [ ] No sensitive final body is ever published before required private/explicit restrictions are verified.
- [ ] Unsupported identity/restriction capability is a preflight blocker.

### Task 1 — Add pure governance validation and preview

- [ ] Implement the schema, canonicalization, edition validation, duplicate/conflict rules, size limits, and capability digest.
- [ ] Resolve principal display summaries through target adapters without persisting emails/tokens.
- [ ] Render effective visibility, staging hierarchy, labels, properties, and blockers in terminal/HTML/JSON.

Acceptance/tests:

- [ ] Pure tests cover empty/duplicate/mixed-edition principals, unknown identities, group/user collisions, private importer inclusion, property limits, hostile keys/values, and deterministic order.
- [ ] Saved plans stale on principal/capability/effective-policy drift.
- [ ] Offline dry-run performs no fetch and cannot be approved; checked dry-run exposes no mutation methods and resolves the exact governance snapshot.

### Task 2 — Extend the publication transaction

- [ ] For required restrictions, create a minimal marker shell, immediately restrict/read back it, then upload/finalize content.
- [ ] For staging parent, create/restrict/read back parent before creating child; track both IDs immediately.
- [ ] Apply/read back required labels/properties and incorporate them into semantic/audit evidence.
- [ ] Roll back only import-owned returned IDs in reverse order; never search/delete by title.

Acceptance/tests:

- [ ] Failure injection covers every parent/child/restriction/property/label/body step.
- [ ] A target race/version conflict cannot broaden visibility.
- [ ] Rollback failure reports every surviving ID/URL prominently.

### Task 3 — CLI, documentation, and evidence

- [ ] Add flags/help/completion and a reusable versioned destination manifest fragment.
- [ ] Add Cloud DOCSY E2E for inherit, private, explicit allowed principal, invalid principal, staging cleanup, source attachment visibility, and readback.
- [ ] Add full DC contract scenarios without claiming project live certification.
- [ ] Document access-model caveats, attachments, administrator capabilities, and safe examples using synthetic IDs.

---

## 6. E2E proof matrix

- [ ] `inherit`: preview summarizes inherited access; no restriction mutation.
- [ ] `private`: no final body/attachment is visible before restriction proof.
- [ ] `explicit`: exact stable principals read back; wrong-edition kind blocks.
- [ ] staging parent: parent and child hierarchy/restrictions verified and cleaned.
- [ ] property/label failure: rollback rather than success.
- [ ] attachment retained under restricted page: link/readback succeeds for actor and remains governed by page access.

---

## 7. Verification gates

```bash
bun install --frozen-lockfile
bun test packages/confluence packages/import-docx apps/cli
bun run typecheck
bun run build
bun run docs:check
bun run docs:build
git diff --check
```

---

## 8. Definition of Done

- [ ] Governance intent is typed, edition-aware, digest-bound, previewed, and read back.
- [ ] Required restricted pages never expose final imported content during setup.
- [ ] No Word identity/permission is mapped to a Confluence principal.
- [ ] Batch plan 010 can reuse the staging/governance contract unchanged.
- [ ] Cloud live proof and DC contract proof use exact evidence labels.
- [ ] `specs/import-docx/005-destination-governance/EVIDENCE.md` is complete.

## 9. STOP conditions

STOP if restrictions cannot be applied before sensitive content, stable principal identities are unavailable, the implementation would need email/display-name matching, rollback could delete non-import-owned content, or a template/macro request cannot be expressed as a typed allowlisted intent.

## 10. DAG

This plan runs in parallel with Plans 002–004 and 006–008 after MVP. Plan 010 depends on it. Plan 009 does not.
