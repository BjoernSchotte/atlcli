# Evidence — plan 007 import recipes (Cloud slice, 2026-08-15)

Delivered in three pushed slices on `codex/import-docx-mvp-plan`:

## Slice 1 — baseline override contract (`atlcli.docx-import-overrides/1`)

- `packages/import-docx/src/overrides.ts`: styleMappings
  (styleId/display name, case-insensitive) →
  paragraph|heading-1..6|blockquote|code; options
  revisions accept|reject, unsupported report|fail.
- Precedence `default < recipe < cli < override-file` with per-decision
  provenance; explicit-layer conflicts fail closed (unit-tested,
  `overrides.test.ts`, 4 tests; parser policy tests 3).
- Parser: mapping suppression of heuristics, unmatched-mapping info
  issue, revisions=reject drops insertions/keeps deletions with issues.
- CLI flags `--map-style/--revisions/--unsupported/--overrides` in
  single and batch paths; `unsupported=fail` blocks confirmed publishes
  (and marks batch items failed) while previews still render.

## Slice 2 — recipe schema, hardened parsing, catalogs

- `packages/import-docx/src/recipe.ts`: `parseRecipe` over injected
  text; rejects duplicate keys, YAML anchors/aliases, custom tags,
  prototype keys, >64 KiB inputs, unknown fields, bad ids/targets
  (6 tests). Sorted-key canonical JSON digest is byte-stable across key
  order. `recipeApplicability` blocks wrong-edition recipes.
- Catalogs (`apps/cli/src/commands/wiki-import-recipe.ts`):
  `.atlcli/import-recipes/` (repo) shadows `~/.atlcli/import-recipes/`
  (user); duplicate ids inside a root error; symlinks may not escape a
  root. Subcommands `recipe validate|list|show`.
- Recipe id/version/digest/source in preview and publish report.

## Slice 3 — export + live Cloud E2E

- `recipe export --id … [--output …] <policy flags>` distills the
  resolved policy into a recipe (non-default options + all mappings,
  `targets: [cloud]`), re-parses its own output as a self-test, and
  writes atomically (tmp + rename). Round-trip export→import is
  unit-tested with matching digests.
- Live DOCSY E2E: exported recipe `docsy-e2e@1.0`
  (sha256 `dbc82f6a22e3e4ee…`) mapped custom styles "Hinweis"→blockquote
  and "Listing"→code; preview showed recipe digest + per-style recipe
  provenance; `--confirm` published page `1198194793` with the mapped
  block sequence readback-verified and the recipe recorded in the JSON
  report. Page deleted; follow-up GET returned **404**.

## Honest deviations from the plan

- Recipe `options` carry only the slice's real knobs
  (revisions/unsupported); comments/pageBreaks arrive with those
  features.
- No source-bound node overrides exist yet, so export has nothing
  document-specific to omit (`--include-node-overrides` reserved).
- Typed issue codes with YAML paths, explicit Node/browser parity runs,
  and DC applicability E2E are deferred; DC recipes validate but are
  rejected at import time by the Cloud-only gate.
