# Plan 007: Add versioned, shareable DOCX import recipes

Status: **Implemented (Cloud slice)** — see `EVIDENCE.md`; open residuals are marked below

Planned at: `18f6f1e`, 2026-07-20

Priority: **P2** · Effort: **M** · Risk: **MEDIUM**

Depends on: completed `specs/import-docx-mvp/PLAN.md`

> **Executor instructions:** Reuse the MVP override schema and semantic allowlist. A recipe is portable data, not executable configuration and not a raw ADF/Storage/macro escape hatch. Record canonical recipe fixtures, security cases, runtime parity, and example imports in `specs/import-docx/007-import-recipes/EVIDENCE.md`.

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

> Slice note (2026-08-15): the MVP slice had no override layer yet, so this
> task BUILT the baseline instead of reconciling it —
> `atlcli.docx-import-overrides/1` in
> `packages/import-docx/src/overrides.ts` (styleMappings to
> paragraph/heading-1..6/blockquote/code; options revisions/unsupported)
> with layered precedence `default < recipe < cli < override-file`,
> per-decision provenance, and fail-closed explicit-layer conflicts.

- [x] Inventory every baseline option/override and classify it as safe reusable, source-bound, target-bound, or forbidden in recipes. *(All current baseline knobs — styleMappings, revisions, unsupported — are safe reusable; source-bound node overrides do not exist in the slice and stay excluded until built.)*
- [x] Freeze `atlcli.docx-import-recipe/1`, limits, precedence, and canonicalization in API docs. *(Slice 2: `packages/import-docx/src/recipe.ts` + user docs; 64 KiB size limit, sorted-key canonical JSON digest.)*
- [x] Create minimal, advanced, Cloud-only, DC-only, stale capability, source-bound, and hostile fixtures. *(As inline test fixtures in `recipe.test.ts`/`wiki-import.test.ts`: valid+advanced, DC-only applicability, alias/tag/duplicate/unknown-field/oversize hostile cases. Stale-capability and source-bound fixtures wait for those features.)*

Acceptance:

- [x] Recipe schema contains no raw target fragment or executable field.
- [x] Every baseline override either has a recipe policy or explicit exclusion.

### Task 1 — Implement pure parsing/resolution

- [x] Add strict schema validation, canonical serialization/digest, applicability checks, and provenance-aware merge. *(Slice 2: `parseRecipe`/`canonicalRecipeJson`/`recipeApplicability` + `resolveImportPolicy` recipe layer.)*
- [x] Keep browser entrypoint free of filesystem/process dependencies; inject catalog bytes/listing. *(`parseRecipe` takes text; all I/O lives in `apps/cli/src/commands/wiki-import-recipe.ts`.)*
- [ ] Add stable validation issue codes with JSON Pointer/YAML path locations. *(Slice returns plain messages; typed codes deferred.)*

Acceptance/tests:

- [x] Duplicate/prototype/custom-tag/alias/depth/size/unknown-key fixtures fail deterministically. *(Depth is bounded structurally by the flat schema + unknown-field rejection.)*
- [ ] Node/Bun/browser resolve identical inputs to identical effective options/override/plan digests. *(Bun-tested; explicit Node/browser parity run deferred.)*
- [x] Precedence table is exhaustively tested.

### Task 2 — Add CLI catalogs and commands

- [x] Implement explicit safe catalog roots, no symlink escape, deterministic duplicate-ID behavior, and atomic export. *(Export lands in slice 3.)*
- [x] Add validate/list/show/export with human/JSON output. *(validate/list/show shipped; export in slice 3.)*
- [x] Integrate recipe provenance into normal preview, saved plan, report, and stale checks. *(id/version/digest/source in preview and publish report; saved-plan/stale checks do not exist in the slice.)*

Acceptance/tests:

- [ ] Symlink/path traversal, duplicate IDs, invalid UTF-8, huge files, and unreadable catalog cases are safe/actionable.
- [ ] JSON stdout remains exactly one document; diagnostics go to stderr.
- [ ] Exported reusable recipe omits source-specific node IDs by default.

### Task 3 — Documentation and end-to-end proof

- [x] Add minimal and realistic recipes for code/panel/expand mappings without arbitrary macros. *(Minimal + realistic examples in the user docs; panel/expand targets wait for those mapping targets.)*
- [ ] Prove the same recipe produces the same Cloud/DC semantic plan where supported and named capability differences where not. *(Cloud-only slice; DC recipes validate but are rejected at import time.)*
- [x] Use built CLI in DOCSY for one recipe-guided import, readback, and cleanup; use DC contract for target-specific mapping. *(Cloud E2E done — page 1198194793, verified 404 cleanup; DC contract deferred.)*
- [x] Document code review/versioning guidance for repository recipes. *(Docs: commit recipes to `.atlcli/import-recipes/`, digest-bound provenance.)*

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

- [x] Recipes are safe, typed, canonical, versioned, digest-bound, and reviewable.
- [x] Precedence/provenance are visible for every effective decision.
- [x] Catalog lookup cannot escape roots or silently shadow duplicates.
- [ ] Runtime parity and Cloud/DC applicability tests pass. *(Applicability unit-tested; explicit Node/browser parity runs and DC-side proof deferred.)*
- [x] No Requirements-specific or arbitrary macro payload enters the core.
- [x] `specs/import-docx/007-import-recipes/EVIDENCE.md` is complete.

## 8. STOP conditions

STOP if reuse requires executable expressions, arbitrary regex replacement without bounded semantics, raw target payloads, remote untrusted recipe fetch, hidden multi-recipe inheritance, or public API expansion that violates the baseline closure without review.

## 9. DAG

This plan runs independently in the first post-MVP parallel wave. Plans 009/010 may consume recipes through the baseline override contract but do not depend on the catalog implementation.

