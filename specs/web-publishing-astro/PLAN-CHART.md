# Chart macro parity — a real `ExportBlock` surface for Astro publishing

- Status: **Planned; separate follow-up PR to the Astro publishing plan**
- Parent plan: [`PLAN.md`](./PLAN.md)
- Scope: Confluence Cloud ADF and Data Center/Server Storage Chart macros
- First consumer: `@atlcli/export-blocks-astro` and the Starlight adapter
- Compatibility requirement: DOCX/PDF exporters must not lose or silently drop
  a newly introduced chart block
- Generated Astro output, customer content, tenant identifiers, and credentials
  are never committed

## 1. Outcome

Replace the current page-level chart sidecar and the generic macro fallback with
a source-neutral, typed `ExportBlock` node:

```ts
type ExportBlock =
  | ExistingExportBlock
  | {
      type: "chart";
      chart: ChartModelV1;
      caption?: string;
      localId?: string;
    };
```

The node is produced by the normal Cloud/DC normalization pipeline and is
consumed by every export surface. Astro renders accessible static output for
every supported chart shape and may add a bounded, allowlisted island for
selected shapes. DOCX/PDF render a deterministic static projection and an
accessible data table when a visual chart cannot be represented faithfully.

This is semantic/data parity, not a promise to reproduce Confluence's PNG
renderer pixel-for-pixel. An original chart image may remain a last-resort
fallback with a visible diagnostic, but it is not the parity implementation.

## 2. Why a shared block is required

The current Astro spike stores a chart beside the page's `blocks` array. That
cannot preserve source order, makes links and anchors ambiguous, and bypasses
the common renderer contracts used by document export. A first-class block:

- preserves the exact position of a chart among paragraphs, tables, and macros;
- gives Cloud ADF and DC Storage adapters one target-neutral contract;
- lets Astro, DOCX, and PDF share validation, provenance, and fallback rules;
- makes chart diagnostics and dependency digests part of the page manifest; and
- prevents a macro from disappearing merely because one renderer has no visual
  equivalent.

The chart block must therefore be part of the public `ExportBlock` union in
`packages/export-blocks`, not an Astro-only type and not a page-level sidecar.

## 3. Supported Confluence shape matrix

The matrix is based on Atlassian's current Chart macro documentation for Cloud
and Data Center/Server. The exact source spelling is retained only in adapter
provenance; the normalized `kind` values below are stable API values.

### 3.1 Chart kinds (P0 contract)

- [ ] `pie` — category labels and one value series; section labels/explode
      semantics are typed.
- [ ] `bar` — category/value series; vertical and horizontal orientation.
- [ ] `line` — category or ordered x values and one or more numeric series.
- [ ] `area` — category or ordered x values and one or more numeric series.
- [ ] `xyArea` — numeric/date x values with one or more y series.
- [ ] `xyBar` — numeric/date x values with one or more y series.
- [ ] `xyLine` — numeric/date x values with one or more y series.
- [ ] `xyStep` — numeric/date x values with stepped interpolation.
- [ ] `xyStepArea` — numeric/date x values with stepped area interpolation.
- [ ] `scatter` — numeric/date x values and numeric y values; no invented
      category labels.
- [ ] `timeSeries` — normalized timestamp x values, timezone/locale policy,
      and the documented time-period aggregation metadata.
- [ ] `gantt` — typed tasks with start, end, optional progress, and dependency
      labels; never coerced into a simple numeric series.

Every kind must have a fixture, normalization test, static Astro rendering
test, accessible fallback test, and DOCX/PDF projection test. If a kind is not
renderable by an interactive library, it still remains statically supported.

### 3.2 Typed presentation/data semantics (P0/P1)

- [ ] Orientation: `vertical`/`horizontal` where meaningful.
- [ ] `threeD`, `stacked`, `showShapes`, and bounded `opacity`.
- [ ] Width/height with safe bounds and responsive overflow behavior.
- [ ] `dataDisplay`: hidden, before, or after the chart.
- [ ] Title, subtitle, x-axis label, y-axis label, and legend visibility.
- [ ] Table selection (`tables`) and column selection (`columns`).
- [ ] Data orientation: horizontal or vertical.
- [ ] Locale/language/country and date format, with a deterministic fallback.
- [ ] Time period: millisecond, second, minute, hour, day, week, month,
      quarter, or year.
- [ ] `forgive` behavior as an explicit strict/lenient normalization decision;
      never silently discard malformed rows.
- [ ] Background, border, and series colors after palette validation.
- [ ] Axis bounds, tick units, label angles, category label position, and date
      tick position, with finite-value and range validation.
- [ ] Pie section label and section explode values.
- [ ] Attachment source, attachment version/comment, and thumbnail intent as
      provenance/fallback metadata; attachment bytes are resolved through the
      existing asset pipeline and are never fetched by an Astro island.

Unsupported or ambiguous parameters must produce a structured diagnostic and a
deterministic fallback, not an arbitrary `Record<string, unknown>` escape hatch.

## 4. Normalized model contract

### 4.1 Discriminated model

Introduce dependency-free types in `packages/export-blocks` (names may be
refined during T0, but the discriminants are normative):

```ts
export type ChartKindV1 =
  | "pie" | "bar" | "line" | "area"
  | "xyArea" | "xyBar" | "xyLine" | "xyStep" | "xyStepArea"
  | "scatter" | "timeSeries" | "gantt";

export type ChartPointV1 = {
  x: number | string; // ISO-8601 for dates; finite number otherwise
  y: number;
  label?: string;
};

export type ChartSeriesV1 = {
  id: string;
  label: string;
  values?: readonly number[];       // category charts, aligned to labels
  points?: readonly ChartPointV1[]; // XY/time-series charts
};

export type GanttTaskV1 = {
  id: string;
  label: string;
  start: string; // canonical ISO-8601 timestamp/date
  end: string;
  progress?: number;
  dependencies?: readonly string[];
};

export type ChartDataV1 =
  | { mode: "categories"; labels: readonly string[]; series: readonly ChartSeriesV1[] }
  | { mode: "points"; series: readonly ChartSeriesV1[] }
  | { mode: "gantt"; tasks: readonly GanttTaskV1[] };

export interface ChartModelV1 {
  schema: "atlcli.chart/1";
  kind: ChartKindV1;
  title?: string;
  subtitle?: string;
  xLabel?: string;
  yLabel?: string;
  legend?: "none" | "top" | "right" | "bottom" | "left";
  orientation?: "vertical" | "horizontal";
  stacked?: boolean;
  threeD?: boolean;
  showShapes?: boolean;
  opacity?: number;
  display?: { width?: number; height?: number; data?: "hidden" | "before" | "after" };
  palette?: readonly string[];
  axes?: ChartAxesV1;
  pie?: { sectionLabel?: "name" | "value" | "percent" | "name-value"; explode?: readonly number[] };
  locale?: { language?: string; country?: string; dateFormat?: string; timePeriod?: string };
  data: ChartDataV1;
  source: ChartSourceProvenanceV1;
}
```

`ChartAxesV1` and `ChartSourceProvenanceV1` are also closed, dependency-free
types. The former contains only finite bounds, tick units, label angles, and
documented position enums. The latter contains a source kind (`cloud-adf` or
`dc-storage`), a provider-local macro identity, and safe dependency/model
digests; it must not contain a clickable tenant URL or authentication data.
Colors are represented by a validated `style`/palette type (including
background and border colors), not by unchecked CSS strings. These details are
part of T0/T1's schema review and must be exported with the chart model.

The final type must use closed unions for axes, display, pie, and locale
options. It must not expose raw ADF/Storage XML, arbitrary macro parameters,
tenant URLs, attachment URLs, or credentials. Provenance is diagnostic metadata
only and must be safe to include in a public site manifest.

### 4.2 Validation and limits

- [ ] Add a runtime validator and a stable schema version.
- [ ] Enforce finite numeric values, canonical dates, unique IDs, aligned
      category series, non-negative dimensions, and valid ranges.
- [ ] Bound rows, series, points, tasks, string lengths, palette entries, and
      serialized model bytes. Limits must be configurable only within safe
      maxima and included in diagnostics.
- [ ] Keep the existing interactive limits (`800` points / bounded payload) as
      an island policy, not as a reason to reject valid static charts.
- [ ] Reject prototype-polluting keys and never deserialize executable values.
- [ ] Give each normalized chart a deterministic model digest for caching and
      dependency tracking.

## 5. Source adapters and extraction

### 5.1 Cloud ADF adapter

- [ ] Detect the Chart macro extension in the existing ADF macro/extension
      normalization path.
- [ ] Decode macro parameters into the closed `ChartModelV1` options above.
- [ ] Extract chart data from macro-body tables, including multiple tables,
      selected tables/columns, and horizontal/vertical orientations.
- [ ] Resolve referenced attachments through the existing authenticated asset
      acquisition layer, then pass only verified bytes/metadata to the model.
- [ ] Preserve source IDs/versions in non-public provenance without leaking
      account, tenant, or credential material.

### 5.2 Data Center/Server Storage adapter

- [ ] Detect the Storage XHTML Chart macro and parse its parameter names and
      macro-body tables without rendering arbitrary XHTML.
- [ ] Support the same normalized shape matrix and diagnostics as Cloud; source
      differences belong in the adapter, not in Astro components.
- [ ] Resolve same-page and attachment-backed data through the DC client
      contract, with explicit behavior when a provider does not expose a
      referenced attachment version.
- [ ] Add DC fixtures for legacy parameter spellings and malformed/partial
      macros.

### 5.3 Data and locale policy

- [ ] Define how empty cells, non-numeric values, duplicate labels, and missing
      dates are handled under strict and lenient modes.
- [ ] Define deterministic decimal, grouping, date, timezone, and locale rules;
      do not depend on the build machine's locale.
- [ ] Implement documented `forgive` semantics as diagnostics plus a visible
      partial-data marker when rows are skipped.
- [ ] Include table/attachment dependency digests in the page/bundle manifest so
      a source-data change invalidates the affected page.

## 6. Macro registry and render-model integration

- [ ] Add a dedicated Chart macro renderer to `@atlcli/export-macros`; do not
      route charts through the catch-all `export_view` fallback.
- [ ] Map Cloud/DC macro names to the same renderer and source adapter.
- [ ] Emit one `ExportBlock` chart node in source order, including local ID,
      caption, provenance, diagnostics, and dependency metadata where allowed.
- [ ] Remove the spike's page-level `chart` sidecar fixture and replace it with
      a chart entry in `blocks`.
- [ ] Ensure unknown chart types remain visible as a typed diagnostic/fallback
      block rather than being silently treated as a paragraph.
- [ ] Update the macro capability registry and publishing support matrix so
      “chart” means an implemented source adapter, not merely a declared macro
      kind.

## 7. Astro render-kit and Starlight integration

### 7.1 Static output (required for every kind)

- [ ] Add a semantic `ChartBlock.astro` dispatch component to
      `@atlcli/export-blocks-astro`.
- [ ] Render accessible SVG/HTML for every chart kind, with title/description,
      keyboard-safe labels, no raw HTML injection, and responsive dimensions.
- [ ] Render an accessible data table before/after the visual when configured;
      when visual rendering is intentionally unavailable, render the table as
      the primary representation with an explicit status message.
- [ ] Render Gantt tasks with a semantic table/list fallback even if a visual
      timeline is unavailable.
- [ ] Add Starlight theme composition without moving chart semantics into
      Starlight-specific components.
- [ ] Expose stable CSS custom properties/data attributes for theme adapters;
      do not make the normalized model depend on Starlight tokens.

### 7.2 Interactive output (bounded enhancement)

- [ ] Keep static output as the default and JavaScript-off contract.
- [ ] Extend the closed interactive adapter registry only for shapes with an
      evidenced renderer contract; first candidate is the existing TanStack
      Charts `0.3.1` bar adapter.
- [ ] Define explicit capability IDs for each interactive shape (for example,
      `tanstack-v0.3/bar`) and validate the model before island hydration.
- [ ] Fall back to the static visual/table for unsupported kinds, excessive
      data, CSP restrictions, or adapter errors.
- [ ] Test tooltips, legends, resize behavior, keyboard access, reduced motion,
      and deterministic hydration. An island must never fetch Confluence data.

## 8. DOCX/PDF compatibility

- [ ] Add chart handling to the DOCX export-block renderer: deterministic
      static image/SVG projection where supported and an accessible tabular
      projection otherwise.
- [ ] Add chart handling to the PDF/Typst renderer with the same fallback and
      no unhandled `type:"chart"` branch.
- [ ] Preserve captions, source order, labels, and data values in both document
      projections.
- [ ] Add regression fixtures proving existing DOCX/PDF exports remain byte- or
      structure-stable for pages without charts.
- [ ] Document which visual options are intentionally approximated in DOCX/PDF
      (for example, 3D perspective or interactive hover) while retaining the
      underlying data.

## 9. Diagnostics, security, and operations

- [ ] Define stable diagnostic codes for unsupported kind, malformed table,
      missing attachment, locale/date parse, truncation, skipped row, and
      renderer fallback.
- [ ] Make strict mode fail the page/build for configured P0 errors; make
      lenient mode publish a visibly marked partial result and report all
      diagnostics.
- [ ] Enforce resource/time/memory budgets separately for acquisition,
      normalization, static rendering, and islands.
- [ ] Sanitize text/attributes and URLs using existing shared gates; never use
      `set:html` for untrusted chart input.
- [ ] Ensure chart models and manifests contain no secrets, bearer tokens,
      private tenant URLs, or unreviewed customer identifiers.
- [ ] Make cache invalidation depend on model and source-data digests, not only
      page version.

## 10. Test and proof plan

### 10.1 Contract and unit tests

- [ ] Validator tests cover every `ChartKindV1`, every data mode, option bounds,
      malformed rows, duplicate IDs, date parsing, and deterministic digests.
- [ ] Cloud ADF fixtures cover all twelve kinds and every P0 parameter family.
- [ ] DC Storage fixtures cover all twelve kinds, legacy spellings, attachment
      data, and malformed/partial input.
- [ ] Renderer tests assert source order, semantic labels, data-table values,
      escaping, responsive attributes, and JavaScript-off output.
- [ ] DOCX/PDF tests assert no chart block is dropped and that fallback data is
      present.
- [ ] Security/property tests cover hostile labels, URLs, CSS colors, huge
      dimensions, NaN/Infinity, prototype keys, and oversized payloads.

### 10.2 Shape-by-shape acceptance matrix

For each row below, the test suite must include source fixture -> normalized
`ExportBlock` -> Astro static output -> accessible fallback -> DOCX/PDF
projection. Interactive output is optional only when an adapter is explicitly
listed in the capability registry.

| Shape | Static | Data table | DOCX/PDF | Interactive policy |
| --- | --- | --- | --- | --- |
| `pie` | [ ] | [ ] | [ ] | [ ] fallback unless adapter exists |
| `bar` | [ ] | [ ] | [ ] | [ ] TanStack bounded candidate |
| `line` | [ ] | [ ] | [ ] | [ ] static first |
| `area` | [ ] | [ ] | [ ] | [ ] static first |
| `xyArea` | [ ] | [ ] | [ ] | [ ] static first |
| `xyBar` | [ ] | [ ] | [ ] | [ ] static first |
| `xyLine` | [ ] | [ ] | [ ] | [ ] static first |
| `xyStep` | [ ] | [ ] | [ ] | [ ] static first |
| `xyStepArea` | [ ] | [ ] | [ ] | [ ] static first |
| `scatter` | [ ] | [ ] | [ ] | [ ] static first |
| `timeSeries` | [ ] | [ ] | [ ] | [ ] static first |
| `gantt` | [ ] | [ ] | [ ] | [ ] table/timeline fallback |

### 10.3 Consumer and live proof

- [ ] Build a packed/plain-Astro consumer and the Starlight consumer against
      the published package boundary; no workspace-private import paths.
- [ ] Run browser checks for desktop/mobile layout, accessibility tree,
      keyboard navigation, reduced motion, CSP, JavaScript disabled, and a
      representative interactive bar island.
- [ ] Run the mayflower Cloud profile against a non-private, non-committed page
      tree fixture and record the per-shape result without committing content.
- [ ] If a DC provider is available, run the same matrix against DC; otherwise
      mark the DC live gate explicitly unexecuted and retain fixture evidence.
- [ ] Verify a refresh with changed table/attachment data invalidates only the
      affected page and produces a new model/bundle digest.

## 11. Implementation tasks

### T0 — Freeze contract and support policy

- [ ] Confirm the twelve shape discriminants and the `ChartDataV1` union.
- [ ] Confirm P0/P1 parameter families, strict/lenient behavior, bounds, and
      the static-vs-island policy.
- [ ] Record open provider differences and the exact Atlassian source links in
      the support matrix.

### T1 — Add the real shared `ExportBlock` type

- [ ] Implement `ChartModelV1`, provenance, diagnostics, and `type:"chart"`
      in `packages/export-blocks`.
- [ ] Add runtime validation, schema versioning, and public exports.
- [ ] Replace page-level chart sidecars in fixtures and contract tests.

### T2 — Cloud ADF source adapter

- [ ] Decode the Chart macro extension and all T0-supported parameters.
- [ ] Extract tables/columns and resolve attachment-backed data.
- [ ] Add Cloud unit and fixture tests for all shapes and failure modes.

### T3 — DC Storage source adapter

- [ ] Decode Storage XHTML macros and legacy parameters safely.
- [ ] Extract same-page/attachment data and add DC fixtures for all shapes.

### T4 — Data, locale, and dependency normalization

- [ ] Implement orientation, numeric/date parsing, aggregation metadata,
      `forgive`, and deterministic locale behavior.
- [ ] Emit dependency/model digests and bounded diagnostics.

### T5 — Macro registry integration

- [ ] Register the dedicated Chart renderer and remove chart reliance on the
      generic fallback.
- [ ] Emit source-ordered chart blocks and update capability reporting.

### T6 — Static Astro components

- [ ] Implement dispatch and static renderers for all twelve kinds.
- [ ] Implement data-table/Gantt fallbacks, theme tokens, and a11y behavior.

### T7 — Interactive adapter(s)

- [ ] Integrate only the closed, version-pinned adapter capabilities that pass
      the bounded-data, CSP, a11y, and hydration tests.
- [ ] Ensure static fallback remains complete for every unsupported case.

### T8 — DOCX/PDF projections

- [ ] Implement chart rendering/table fallback in both document engines.
- [ ] Add no-regression fixtures for existing export surfaces.

### T9 — Hardening and observability

- [ ] Add security/property tests, resource budgets, diagnostics, and privacy
      scans.
- [ ] Add cache invalidation and partial-publication verification.

### T10 — End-to-end proof and documentation

- [ ] Run packed consumers, browser/a11y checks, Cloud E2E, and optional DC E2E.
- [ ] Publish a support matrix that distinguishes source support, static output,
      interactive enhancement, and document projection.
- [ ] Update user-facing docs and keep generated output out of Git.

## 12. Acceptance gates / Definition of Done

The follow-up PR is complete only when all gates are checked:

- [ ] `ExportBlock` has a validated, source-neutral `type:"chart"` node; no
      page-level chart sidecar remains.
- [ ] All twelve documented Confluence chart kinds have Cloud/DC fixtures,
      static Astro output, accessible data fallback, and DOCX/PDF projections.
- [ ] P0 parameter families and strict/lenient diagnostics are tested; every
      unsupported option is visible and deterministic.
- [ ] Existing non-chart DOCX/PDF and Astro pages pass regression tests.
- [ ] Interactive islands are closed, bounded, version-pinned, optional, and
      never required for content or accessibility.
- [ ] Cloud live proof is recorded; DC live proof is recorded or explicitly
      marked unavailable with fixture evidence.
- [ ] `bun run typecheck` and the relevant `bun run test` suites pass.
- [ ] No credentials, private customer pages, generated Astro output, or
      temporary build artifacts are committed.

## 13. Open decisions

- [ ] Do we expose 3D as a semantic hint only, or intentionally flatten it in
      all static renderers? (Recommendation: flatten with a diagnostic.)
- [ ] Which XY/time-series renderer, if any, is promoted to an interactive
      adapter after the bounded TanStack bar proof? (Recommendation: do not
      expand until a11y and bundle budgets are measured.)
- [ ] Should a missing attachment fail strict builds by default, or only when
      the chart has no table data? (Recommendation: fail only when no usable
      semantic data remains.)
- [ ] Which Gantt dependency semantics can be represented without inventing
      scheduling behavior? (Recommendation: preserve labels/edges and avoid
      recalculation.)

## 14. References

- [Atlassian Confluence Cloud — Insert the Chart macro](https://support.atlassian.com/confluence-cloud/docs/insert-the-chart-macro/)
- [Atlassian Confluence Data Center/Server — Chart macro](https://confluence.atlassian.com/conf717/chart-macro-1115675780.html)
- [Astro — Content collections and custom loaders](https://docs.astro.build/en/guides/content-collections/)
- [TanStack Charts](https://tanstack.com/charts/latest)
