# Issue 102 — Configurable Shiki code themes

Status: **Plan**, 2026-07-25.

Issue: [#102 — feat(export): make the Shiki code theme configurable](https://github.com/BjoernSchotte/atlcli/issues/102)

Planned at: `9034895` (`docs: showcase world-class document fidelity`, `origin/main`).

## Table of contents

1. [Outcome](#1-outcome)
2. [Verified baseline](#2-verified-baseline)
3. [Scope and non-goals](#3-scope-and-non-goals)
4. [Target architecture](#4-target-architecture)
5. [Contracts and migration](#5-contracts-and-migration)
6. [Implementation sequence](#6-implementation-sequence)
7. [Test and validation plan](#7-test-and-validation-plan)
8. [Documentation](#8-documentation)
9. [Definition of Done](#9-definition-of-done)
10. [Risks](#10-risks)
11. [Unresolved questions](#11-unresolved-questions)

---

## 1. Outcome

Every DOCX and PDF export surface accepts one stable `codeTheme` identifier.
Omitting it resolves to `github-light` and preserves the current DOCX token
colors. The resolved identifier and its code-block foreground/background
contract are shared by both engines, persisted before background work starts,
included in deterministic inputs, and reported with the result.

The first release ships a deliberately small static registry:

- `github-light` — backward-compatible default;
- one additional theme selected during implementation after its Shiki colors
  and explicit code-block background pass the PDF/DOCX readability goldens.

No caller may provide a module path, a free-form Shiki theme object, or a URL.
No renderer fetches theme data at runtime.

## 2. Verified baseline

### 2.1 Highlighting is not shared today

- `packages/docx/src/highlight.ts` owns a private curated language registry,
  statically imports `shiki/themes/github-light.mjs`, and memoizes one
  process-wide `HighlighterCore`.
- `packages/docx/src/serialize.ts` calls `highlightCode(code, language)` while
  serializing each code block and emits the returned colors as OOXML runs.
- `packages/pdf/src/serialize.ts` emits Typst `raw(..., lang: ...)`; Typst, not
  Shiki, chooses PDF token colors. There is therefore no existing shared
  highlighted-token model whose theme can simply be switched.
- The existing DOCX token result contains line/token foreground colors but no
  resolved theme id or code-block background.

Consequently, threading a setting to the two existing renderers would not meet
the issue's cross-format color-equivalence criterion. PDF must consume the same
prepared Shiki token projection as DOCX.

### 2.2 Engine and report contracts

- DOCX input/report/prepared state live in `packages/docx/src/export.ts`:
  `ExportInput`, `ExportReport`, and `PreparedDocxExportV1`.
- PDF input/report/prepared state live in `packages/pdf/src/types.ts` and
  `packages/pdf/src/run-export.ts`: `RunPdfExportInput`,
  `PdfTemplateSettings`, `PdfExportReport`, and `PreparedPdfExportV1`.
- Neither prepared checkpoint records an effective code theme today.
- PDF settings are resolved centrally by `packages/pdf/src/settings.ts`; DOCX
  has no general template-settings object and receives render options directly
  on `ExportInput`.

### 2.3 Durable jobs and host surfaces

- `packages/export-jobs/src/request.ts` defines the closed
  `DocxExportJobRequestV1` and `PdfExportJobRequestV1` shapes.
- `packages/export-jobs/src/validation.ts` rejects unknown keys and validates
  requests before execution. Neither request variant currently carries a code
  theme.
- CLI requests are built in
  `apps/cli/src/commands/export-job-request.ts`; the command/help wiring is in
  `apps/cli/src/commands/export.ts`.
- Extension requests are built in
  `apps/extension/utils/export-jobs/docx-request.ts` and
  `apps/extension/utils/export-jobs/pdf-request.ts`.
- Retry and Run again clone the durable request. Therefore the effective theme
  must be normalized into that request before submission, not re-read from
  current UI preferences during execution.
- PDF template preferences use the schema/form/persistence flow in
  `apps/extension/components/export/settings-schema.ts` and
  `TemplateLibraryPort.readSettings/writeSettings`. The setting can be
  persisted per space through that existing template-preference boundary.
- The report shapes are engine-specific; the CLI additionally projects them
  through `apps/cli/src/commands/export-report.ts`.

### 2.4 Mandatory drift check

Before implementation, re-run:

```bash
rg -n "github-light|highlightCode|raw\\(|PreparedDocxExportV1|PreparedPdfExportV1|ExportJobRequestV1|toPdfSettings" packages apps
bun run test packages/docx/src/highlight.test.ts packages/export-jobs/src/validation.test.ts
```

Stop and update this plan if a shared code-token package or a newer durable
request schema has landed, or if PDF no longer delegates code highlighting to
Typst.

## 3. Scope and non-goals

### 3.1 In scope

- A browser-safe shared code-highlighting module with:
  - a closed `CodeThemeId` union;
  - `DEFAULT_CODE_THEME`;
  - registry metadata including foreground and background;
  - runtime validation/defaulting;
  - lazy static imports of bundled Shiki themes and grammars;
  - theme-keyed highlighter/language-load memoization;
  - a serializable highlighted line/token result.
- One normalized `codeTheme` value in both engine inputs, prepared checkpoints,
  durable requests, reports, CLI JSON output, extension forms, and persisted
  per-space preferences.
- PDF rendering of the shared highlighted tokens rather than independent Typst
  syntax colors.
- Explicit code-block background and fallback foreground in PDF and DOCX.
- Tests for defaults, validation, concurrency isolation, fallback behavior,
  prepared/resumed jobs, and cross-engine rendered colors.
- Supported-theme documentation and CLI examples.

### 3.2 Non-goals

- Arbitrary Shiki themes, user-authored JSON themes, module paths, CDN loading,
  or network discovery.
- Shipping Shiki's full theme or language catalogue.
- Making the document body itself dark.
- Changing Mermaid/diagram themes automatically. `diagramTheme` remains a
  separate contract.
- Replacing the export-job lifecycle or merging PDF and DOCX engine reports.
- Changing source-language detection or expanding the curated language list.

### 3.3 Invariants

1. An omitted theme resolves to `github-light` at the first authoritative
   boundary and never depends on a later ambient default.
2. Unknown identifiers fail with a typed, actionable configuration error before
   source discovery or rendering.
3. Durable requests and prepared checkpoints contain the resolved identifier.
4. Retry and Run again reuse the parent request's resolved theme.
5. Concurrent exports using different themes never mutate shared theme state.
6. Both engines receive the same token text, token colors, background, and
   fallback foreground from the shared adapter.
7. Unknown languages and tokenizer failures keep the complete source text and
   use the selected theme's fallback foreground/background.
8. Adding a theme requires an explicit registry entry, static import, metadata,
   tests, and documentation.

## 4. Target architecture

### 4.1 Ownership

Create a small browser-safe workspace package, tentatively
`packages/code-highlight` (`@atlcli/code-highlight`). Keeping the adapter in
`@atlcli/docx` would make PDF depend on the DOCX engine; duplicating it in PDF
would recreate the state-leak and parity problem.

Public contract:

```ts
export const CODE_THEME_IDS = ["github-light", "<second-theme>"] as const;
export type CodeThemeId = (typeof CODE_THEME_IDS)[number];
export const DEFAULT_CODE_THEME: CodeThemeId = "github-light";

export interface ResolvedCodeTheme {
  id: CodeThemeId;
  foreground: `#${string}`;
  background: `#${string}`;
}

export interface HighlightedCode {
  theme: ResolvedCodeTheme;
  lines: Array<Array<{ text: string; color?: `#${string}` }>>;
  skipped: "unknown-language" | "highlight-failed" | null;
}

export function resolveCodeTheme(value?: unknown): ResolvedCodeTheme;
export function highlightCode(
  code: string,
  language?: string,
  theme?: CodeThemeId,
): Promise<HighlightedCode>;
export function warmHighlight(
  languages: readonly string[],
  theme?: CodeThemeId,
): void;
```

`resolveCodeTheme` is the one authority used by job validation, CLI flag
parsing, extension form validation, and engines. If dependency direction makes
calling it from `@atlcli/export-jobs` undesirable, export a zero-dependency
registry/validation subpath and keep Shiki loading behind the main subpath.

### 4.2 Registry and memoization

The registry maps each id to:

- one static dynamic import such as
  `() => import("shiki/themes/github-light.mjs")`;
- normalized fallback foreground and background;
- optional human-readable label for host UIs.

Do not generate an unconstrained dynamic import from user input.

Replace the single `highlighterPromise` with a map keyed by `CodeThemeId`.
Language load/warm promises must also include the theme/highlighter identity,
for example `Map<CodeThemeId, Map<CanonicalLanguage, Promise<void>>>`.
A failed initialization or language load removes only its own key so a later
attempt can retry without poisoning other themes.

Use the theme id passed to `codeToTokens`; never retain a mutable “current
theme”. A concurrency test must interleave first loads and tokenization for both
themes and compare each result with its isolated baseline.

### 4.3 Shared prepared-token projection

Move code highlighting into the engines' prepare phase. Define a serializable
prepared code-block shape containing:

- the original code/language and existing caption/options;
- highlighted lines;
- `themeId`, foreground, and background;
- the existing skip reason.

DOCX consumes this shape when producing `w:r` runs. PDF serializes the same
lines into Typst spans with explicit colors and an explicit containing block
fill. Typst `raw(..., lang: ...)` must no longer be the authoritative colored
path. Preserve whitespace, trailing empty lines, wrapping, line numbers,
captions, and source-map mapping.

If keeping the raw source alongside tokens is needed for accessibility,
copy/paste, or source maps, it remains data; it must not trigger a second,
renderer-specific syntax-color decision.

### 4.4 Background contract

The registry's background is part of the theme contract, not inferred in each
renderer.

- DOCX: extend the code-block OOXML wrapper in `packages/docx/src/ooxml.ts` /
  `packages/docx/src/serialize.ts` to apply the selected fill and fallback ink.
  Emit per-paragraph shading so the selected theme overrides an existing
  template-provided `AtlcliCode` style without mutating that global style.
- PDF: extend the code-block Typst template/serializer in
  `packages/pdf/src/serialize.ts` to apply the same fill and token colors.
- Normalize Shiki alpha colors through the existing DOCX color normalization;
  define the equivalent PDF normalization once and test the same canonical
  six-digit RGB values.
- Token-less and degraded lines use the theme fallback foreground.

## 5. Contracts and migration

### 5.1 Engine inputs and reports

Add `codeTheme?: CodeThemeId` to `ExportInput`, `RunPdfExportInput`, and the PDF
settings surface used by hosts. Resolve it immediately in
`prepareDocxExport`/`preparePdfExport`.

Add required `codeTheme: CodeThemeId` to new prepared checkpoint versions and
reports:

- `PreparedDocxExportV2`;
- `PreparedPdfExportV2`;
- `ExportReport.codeTheme`;
- `PdfExportReport.codeTheme`.

Prefer explicit V2 checkpoint discriminants over silently changing persisted V1
semantics. Readers may migrate a V1 checkpoint to V2 by assigning
`github-light`; writers emit only V2 after the change. If current host stores
prove that ready-to-render checkpoints are deliberately disposable across
versions, fail old checkpoints with a stable “re-prepare required” code instead
of guessing.

### 5.2 Durable requests

Add required `codeTheme: CodeThemeId` to both `DocxExportJobRequestV1.options`
and `PdfExportJobRequestV1.options` (or introduce request V2 if released
external consumers cannot accept an additive required field).

Submission builders always write the resolved default. Parsers may accept an
older stored V1 object with the field omitted only through an explicit migration
that materializes `github-light`; newly constructed in-memory requests without
the field fail validation. Update:

- `packages/export-jobs/src/request.ts`;
- `packages/export-jobs/src/validation.ts`;
- request clone/retry tests and type tests;
- CLI and extension request builders;
- DOCX/PDF job resolvers and executors.

Because the complete normalized request participates in idempotency/provenance,
confirm the current request digest sites and add a regression proving two
otherwise-identical requests with different themes have different hashes/cache
keys. PDF preview's `settingsHash` must include the effective theme.

### 5.3 CLI

Add `--code-theme <id>` to `atlcli wiki export` for both formats.

- Parse and validate it before profile/network/template work.
- Default to `github-light`.
- Include the supported ids in the error and help output.
- Pass the normalized id through both job-request builders.
- Include `codeTheme` in machine-readable reports without removing or renaming
  existing fields.
- Document minimal default and non-default DOCX/PDF examples.

Do not make the flag PDF-only or require users to encode this cross-engine
setting inside a DOCX file.

### 5.4 Extension and per-space persistence

Expose a choice control backed by the shared registry ids. Store it with the
existing template preference values so the current space override continues to
win over global preferences.

The host projection must:

1. merge defaults and persisted values;
2. validate the choice against the shared registry;
3. put the resolved id on both `DocxExportRequest` and `PdfExportRequest`;
4. persist it in both durable job-request variants before source discovery;
5. include it in PDF preview cache settings hashes;
6. display the effective theme in DOCX/PDF result details.

Do not rely only on the PDF manifest schema: DOCX currently has no engine
settings projection. Add a shared export-setting control/projection or an
explicit DOCX mapping rather than leaving DOCX preferences informational.

### 5.5 Template/schema boundary

Treat `codeTheme` as a product-owned export setting with a closed registry.
Template manifests may declare the standard choice for presentation, but cannot
extend its allowed values. Machine-readable schemas expose:

- field name and `CodeThemeId` enum;
- default `github-light`;
- supported identifiers;
- the fact that foreground/background are resolved metadata, not user input.

This avoids confusing Level-B manifest custom settings with an engine contract
that must be identical across formats.

## 6. Implementation sequence

### Phase 1 — Shared registry and compatibility lock

1. Extract the language registry, canonicalization, regex-engine selection,
   token types, and Shiki adapter from `packages/docx/src/highlight.ts` into
   `@atlcli/code-highlight`.
2. Add the closed theme registry and default resolver.
3. Add per-theme highlighter/language memoization with failure eviction.
4. Port existing DOCX highlight tests unchanged first; capture the current
   `github-light` token grid as the compatibility fixture.
5. Add second-theme, invalid-theme, concurrency, unknown-language, trailing
   empty-line, and failed-load retry tests.

Exit gate: default calls return the same text/token colors as the pre-change
DOCX adapter, and the browser build contains only the curated theme/language
chunks.

### Phase 2 — Prepared engine state and render parity

1. Resolve and highlight code blocks during DOCX and PDF preparation.
2. Version prepared checkpoints and persist theme metadata plus tokens.
3. Change DOCX serialization to consume prepared tokens and selected
   background.
4. Change PDF serialization from Typst-selected syntax colors to explicit
   shared token spans/background.
5. Add effective theme to both engine reports.
6. Retain existing fallback notes and add no warning merely because the default
   was omitted.

Exit gate: one fixture produces the same canonical token RGB sequence and
background in PDF source and DOCX OOXML for both themes.

### Phase 3 — Durable job contracts and executors

1. Extend/version request contracts and validators.
2. Normalize defaults in CLI/extension builders before enqueue.
3. Thread the field through source resolution, executors, checkpoint stores,
   retries, Run again, summaries, and report projections.
4. Include it in request/provenance hashes and PDF preview cache keys.
5. Add migration behavior for pre-theme stored requests/checkpoints.

Exit gate: resume, retry, and Run again still use the submitted theme after the
host preference changes.

### Phase 4 — CLI, extension UI, schemas, and docs

1. Add CLI flag parsing/help/examples and JSON report field.
2. Add the shared extension choice control, localized labels/errors, and
   per-space persistence.
3. Update machine-readable settings/report schemas and public package exports.
4. Update user documentation and the supported-theme registry table.

Exit gate: both hosts reject unknown ids before rendering and can produce both
formats with both supported themes.

### Phase 5 — Proof and release preparation

1. Run focused unit/integration tests, typecheck, build, and browser harness.
2. Generate four real artifacts: PDF/DOCX × default/non-default theme.
3. Inspect DOCX in Word and LibreOffice and PDF in a real viewer/browser.
4. Verify readable backgrounds, token parity, wrapping, line numbers,
   copy/paste, and unchanged default output.
5. Measure browser chunk deltas and record them in the implementation PR.

Do not release automatically. Follow the repository dry-run release workflow
only when a later request explicitly asks for a release.

## 7. Test and validation plan

### 7.1 Unit tests

- `packages/code-highlight`: registry defaulting, exact allowed ids, static
  loaders, alias canonicalization, token compatibility, isolation under
  concurrent themes, failure eviction, unknown languages, tokenizer fallback,
  and trailing empty lines.
- `packages/export-jobs`: closed-shape validation, missing/legacy migration,
  unknown id error path and actionable message, clone/retry preservation, and
  theme-sensitive request hashes.
- `packages/docx`: prepared-state migration, report field, foreground/fill OOXML
  colors, degraded fallback, and unchanged default tokens.
- `packages/pdf`: prepared-state migration, report field, explicit Typst token
  colors/fill, no independent syntax-theme authority, and degraded fallback.
- CLI/extension builders: explicit/default theme on both request variants.
- Extension settings: global/space precedence, stale/unknown stored value
  handling, choice rendering, save/reset, and preview cache invalidation.

### 7.2 Integration and golden tests

- Default DOCX bytes remain equal where timestamps and other deterministic
  inputs are pinned. If the necessary explicit background changes historical
  bytes, split the acceptance proof into unchanged token RGB/text semantics and
  a reviewed one-time golden update; do not claim byte compatibility falsely.
- PDF and DOCX goldens for both themes assert equivalent ordered token RGB
  sequences and the same background RGB.
- A mixed concurrent test prepares two exports with different themes and
  verifies neither result contains colors unique to the other.
- Durable-job tests change the stored preference after submission, then cover
  resume, automatic retry, manual Retry, and Run again.
- Browser build tests assert CSP-safe execution, no runtime theme fetch, and no
  uncurated Shiki theme chunks.

### 7.3 Commands

```bash
bun run test packages/code-highlight
bun run test packages/docx packages/pdf packages/export-jobs packages/export-wiring
bun run test apps/cli/src/commands/export-request.test.ts apps/cli/src/commands/export-job-request.test.ts
bun run test apps/extension/tests/settings-form.test.tsx apps/extension/tests/jobs
bun run typecheck
bun run build
git diff --check
```

Run tests through `bun run test`, never bare `bun test`.

### 7.4 E2E

Before committing implementation, use profile `mayflower`, space `DOCSY`, and
the repository's real export/browser harness. Clean up any pages or other remote
fixtures created for the proof. Planning-only commits require no remote product
mutation; `git diff --check` is the proportionate local gate for this document.

## 8. Documentation

Update the export feature guide and CLI reference under `src/content/docs/` in
the same implementation PR, including
`src/content/docs/reference/docx-engine.md` and the corresponding PDF/export-job
reference pages:

- supported id/default table;
- minimal omitted/default example;
- realistic light/non-default examples for both formats;
- per-space extension selection steps;
- JSON/report field;
- unknown-theme symptom, cause, and fix;
- warning that dark themes use their own code-block background but do not make
  the document body dark;
- related links to PDF/DOCX templates and durable export jobs.

Do not create a parallel root `docs/` hierarchy; `src/content/docs/` is the
currently published documentation source.

## 9. Definition of Done

- Omitted input resolves to `github-light` across every CLI/browser PDF/DOCX
  path.
- At least one additional statically bundled theme is selectable.
- Both engines consume the same prepared Shiki tokens and background.
- Unknown ids fail before source discovery/rendering with supported ids named.
- Durable requests, checkpoints, hashes, reports, retries, and Run again retain
  the effective theme.
- Concurrent themes are isolated.
- Default compatibility and cross-format color parity have automated proofs.
- Real DOCX/PDF artifacts pass the requested application/browser inspection.
- Public types, schemas, help, examples, and troubleshooting are updated.
- Typecheck, build, focused tests, browser harness, and `git diff --check` pass.

## 10. Risks

1. **PDF semantic drift.** Replacing Typst `raw` highlighting can affect
   whitespace, line wrapping, line numbers, copy/paste, or source maps.
   Mitigation: preserve raw text alongside tokens and lock each behavior with
   focused serializer/golden tests.
2. **False byte-compatibility claim.** Adding an explicit background may alter
   default DOCX bytes even when colors are visually equivalent. Mitigation:
   measure before promising byte equality and distinguish byte parity from
   token-color parity in the proof.
3. **Bundle growth.** A full Shiki theme import pattern can emit the catalogue.
   Mitigation: static curated imports and bundle-content assertions.
4. **Dark-theme readability.** Token colors without a fill are unusable.
   Mitigation: registry-owned foreground/background and real-app artifact
   inspection.
5. **Stale durable data.** Changing a V1 shape in place can make recovery
   nondeterministic. Mitigation: explicit request/checkpoint migration or V2
   discriminants with a tested compatibility policy.
6. **Split settings ownership.** PDF manifest settings currently have a UI
   projection while DOCX does not. Mitigation: product-owned shared setting,
   not a PDF-only manifest custom value.
7. **Memoization races.** A shared mutable highlighter can leak loaded/current
   theme state. Mitigation: theme-keyed immutable selection and deliberately
   interleaved concurrency tests.

## 11. Unresolved questions

1. Which second curated theme should ship? Recommendation: choose one dark theme
   to force the background contract to be proven now; confirm its redistribution
   metadata and real Word/PDF contrast before freezing the id.
2. Are `atlcli.export-job-request/1` and the prepared V1 checkpoints already
   treated as externally stable persisted contracts? If yes, introduce V2. If
   no, document and test the one-time default migration rather than changing
   them silently.
3. Does “byte compatible” in Issue #102 require the complete historical DOCX
   archive to remain byte-identical, or specifically the highlighted token
   output? The implementation must measure both; an explicit default background
   may require a reviewed golden change even though token colors remain exact.
4. Should compact durable `ExportReportSummaryV1` also carry `codeTheme`, or is
   the full persisted engine/CLI report sufficient? Recommendation: keep the
   compact Activity summary unchanged unless the UI will display/filter by
   theme.
