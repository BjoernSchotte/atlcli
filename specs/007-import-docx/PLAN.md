# Plan 007: Add versioned, shareable DOCX import recipes

Status: **Planned**

Planned at: `18f6f1e`, 2026-07-20

Priority: **P2** · Effort: **M** · Risk: **MEDIUM**

Depends on: completed `specs/import-docx-mvp/PLAN.md`

> **Executor instructions:** Reuse the MVP override schema and semantic allowlist. A recipe is portable data, not executable configuration and not a raw ADF/Storage/macro escape hatch. Record canonical recipe fixtures, security cases, runtime parity, and example imports in `specs/007-import-docx/EVIDENCE.md`.

---

## 1. Outcome and JTBD

Teams can commit, review, validate, discover, and reuse named import recipes that encode approved style/node/global mapping policy. CLI and later browser shapes resolve the same recipe to the same override/options digest and preview. Recipes can be exported from a reviewed plan without leaking document-specific node overrides unless explicitly requested.

JTBD: **apply the same organization-specific Word-to-wiki conventions across many imports without repeating manual decisions or relying on one operator's local knowledge**.

Research basis:

- Requirement Yogi's Transformation Wizard advertises preview, reusable/shared rules, bulk page transformations, table normalization, and reverse transformation: https://docs.requirementyogi.com/cloud/page-transformations
- Marketplace positioning emphasizes bulk Word-related transformation into typed requirements/properties: https://marketplace.atlassian.com/apps/1212523/requirement-yogi-requirements-management-for-confluence

The domain-specific Requirements/RTM model is not copied. The reusable mechanism — versioned, previewable transformation policy — is the relevant signal.

---

## 2. Scope

In scope:

- `atlcli.docx-import-recipe/1` schema wrapping baseline semantic override/options;
- explicit local file and repository catalog lookup;
- canonical ID/version/digest, metadata, target applicability, and compatibility range;
- deterministic precedence and plan provenance;
- validate/list/show/export CLI workflows;
- browser-safe pure resolution and Node/Bun/browser parity;
- optional CQL/app-specific transformations remain typed plugin intents only if capability-proven.

Out of scope:

- downloading recipes from arbitrary URLs/registries;
- JavaScript, regex replacement code, template engines, shell commands, YAML custom tags, raw ADF/Storage/HTML/XML;
- organization-wide server hosting/signing marketplace;
- automatically editing already-imported pages;
- Requirement Yogi macros/RTM semantics in the generic core.

---

## 3. Recipe contract

```ts
export interface DocxImportRecipeV1 {
  schema: "atlcli.docx-import-recipe/1";
  id: string;
  version: string;
  title: string;
  description?: string;
  targets: Array<"cloud" | "data-center">;
  requiresCapabilities?: string[];
  options: {
    comments?: "auto" | "inline" | "footer" | "append" | "skip";
    revisions?: "accept" | "reject" | "markup";
    pageBreaks?: "omit" | "rule";
    unsupported?: "report" | "attach" | "fail";
  };
  overrides: DocxImportOverridesV1;
  metadata?: {
    owners?: string[];
    documentationUrl?: string;
    tags?: string[];
  };
}
```

Rules:

1. Exact supported schema only. Recipe `version` is opaque validated metadata; recipe bytes plus canonical content produce `recipeDigest`.
2. Search order is explicit: `--recipe <path>` is a file; `--recipe-id <id>` searches the repository catalog then configured user catalog. No current-directory magic outside documented roots.
3. Initial release has no inheritance/`extends`; composition causes hidden precedence and cycles. One recipe plus one optional document-specific override is enough.
4. Precedence: built-in defaults < recipe < explicit CLI global flags < explicit document override. Every effective decision records provenance. Conflicting explicit sources fail rather than silently win where semantics would surprise.
5. Node-specific IDs are omitted when exporting a reusable recipe by default. `--include-node-overrides` is explicit and warns that the recipe is source-digest-bound.
6. Recipe metadata cannot influence target payload except through typed options/overrides.
7. Capability mismatch blocks before approval or yields a named optional mapping fallback already defined by the baseline; recipe cannot force unsupported native output.
8. Canonical parser rejects duplicate keys, anchors/aliases, merge keys, custom tags, prototype keys, excessive depth/keys/bytes, and unknown fields.

Suggested catalog:

```text
.atlcli/import-recipes/
  <recipe-id>.yaml
docs/examples/import-recipes/
```

Do not create a new workspace package unless baseline API-closure evidence shows the pure resolver cannot remain in `@atlcli/import-docx`.

---

## 4. CLI/DX

```text
atlcli wiki import handbook.docx --recipe .atlcli/import-recipes/handbook.yaml
atlcli wiki import handbook.docx --recipe-id company-handbook
atlcli wiki import recipe validate <file>
atlcli wiki import recipe show <file|id> --resolved --profile <name>
atlcli wiki import recipe list
atlcli wiki import recipe export --from-plan <plan.json> --output <file>
```

Before locking syntax, inspect existing command nesting conventions and choose one canonical discoverable form. Do not add aliases for every spelling.

Preview/report list recipe ID/version/digest, source path category (repo/user/explicit, not absolute path by default), capability decisions, and per-node/style provenance.

---

## 5. Tasks

### Task 0 — Reconcile the baseline override contract

- [ ] Inventory every baseline option/override and classify it as safe reusable, source-bound, target-bound, or forbidden in recipes.
- [ ] Freeze `atlcli.docx-import-recipe/1`, limits, precedence, and canonicalization in API docs.
- [ ] Create minimal, advanced, Cloud-only, DC-only, stale capability, source-bound, and hostile fixtures.

Acceptance:

- [ ] Recipe schema contains no raw target fragment or executable field.
- [ ] Every baseline override either has a recipe policy or explicit exclusion.

### Task 1 — Implement pure parsing/resolution

- [ ] Add strict schema validation, canonical serialization/digest, applicability checks, and provenance-aware merge.
- [ ] Keep browser entrypoint free of filesystem/process dependencies; inject catalog bytes/listing.
- [ ] Add stable validation issue codes with JSON Pointer/YAML path locations.

Acceptance/tests:

- [ ] Duplicate/prototype/custom-tag/alias/depth/size/unknown-key fixtures fail deterministically.
- [ ] Node/Bun/browser resolve identical inputs to identical effective options/override/plan digests.
- [ ] Precedence table is exhaustively tested.

### Task 2 — Add CLI catalogs and commands

- [ ] Implement explicit safe catalog roots, no symlink escape, deterministic duplicate-ID behavior, and atomic export.
- [ ] Add validate/list/show/export with human/JSON output.
- [ ] Integrate recipe provenance into normal preview, saved plan, report, and stale checks.

Acceptance/tests:

- [ ] Symlink/path traversal, duplicate IDs, invalid UTF-8, huge files, and unreadable catalog cases are safe/actionable.
- [ ] JSON stdout remains exactly one document; diagnostics go to stderr.
- [ ] Exported reusable recipe omits source-specific node IDs by default.

### Task 3 — Documentation and end-to-end proof

- [ ] Add minimal and realistic recipes for code/panel/expand mappings without arbitrary macros.
- [ ] Prove the same recipe produces the same Cloud/DC semantic plan where supported and named capability differences where not.
- [ ] Use built CLI in DOCSY for one recipe-guided import, readback, and cleanup; use DC contract for target-specific mapping.
- [ ] Document code review/versioning guidance for repository recipes.

---

## 6. Verification gates

```bash
bun install --frozen-lockfile
bun test packages/import-docx apps/cli
bun run typecheck
bun run build
bun run check:browser
bun run docs:check
bun run docs:build
git diff --check
```

---

## 7. Definition of Done

- [ ] Recipes are safe, typed, canonical, versioned, digest-bound, and reviewable.
- [ ] Precedence/provenance are visible for every effective decision.
- [ ] Catalog lookup cannot escape roots or silently shadow duplicates.
- [ ] Runtime parity and Cloud/DC applicability tests pass.
- [ ] No Requirements-specific or arbitrary macro payload enters the core.
- [ ] `specs/007-import-docx/EVIDENCE.md` is complete.

## 8. STOP conditions

STOP if reuse requires executable expressions, arbitrary regex replacement without bounded semantics, raw target payloads, remote untrusted recipe fetch, hidden multi-recipe inheritance, or public API expansion that violates the baseline closure without review.

## 9. DAG

This plan runs independently in the first post-MVP parallel wave. Plans 009/010 may consume recipes through the baseline override contract but do not depend on the catalog implementation.

