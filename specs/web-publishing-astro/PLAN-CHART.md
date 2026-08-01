# Chart macro parity — a real `ExportBlock` surface for Astro publishing

- Status: **Implementation in progress — the typed surface and all-shapes
  TanStack DOCX/PDF projection are proven; Astro and host proof remain open**
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
      caption?: Caption;
      localId?: string;
      diagnostics?: ChartDiagnosticV1[];
    };
```

The node is produced by the normal Cloud/DC normalization pipeline and is
consumed by every export surface. Astro renders accessible static output for
every supported chart shape and may add a bounded, allowlisted island for
selected shapes. DOCX/PDF render the same deterministic chart model as a safe
SVG visual plus an accessible data table; the table remains the explicit
fallback if a host cannot rasterize/embed the visual.

This is semantic/data parity, not a promise to reproduce Confluence's PNG
renderer pixel-for-pixel. An original chart image may remain a last-resort
fallback with a visible diagnostic, but it is not the parity implementation.

### 1.1 One TanStack rendering source

Do not maintain an atlcli-owned chart geometry engine. Keep `ChartModelV1` in
the dependency-free `@atlcli/export-blocks` package and add a separate
`@atlcli/export-charts-tanstack` adapter package pinned to TanStack Charts
`0.3.1`. The adapter owns the closed mapping from all twelve chart kinds to
TanStack definitions, explicit scales, marks, guides, legends, theme, fixed
export dimensions, deterministic UTC/locale formatters, and stable keys.

TanStack then supplies the shared renderer-neutral `ChartScene`:

1. Astro mounts the same definition through TanStack's SVG DOM host for
   interaction and uses its deterministic server SVG as the no-JavaScript
   representation.
2. DOCX/PDF call TanStack's DOM-free `renderChartSvg(scene, options)` at
   explicit dimensions. PDF embeds that SVG as vector content.
3. DOCX embeds the same SVG and uses the existing bounded SVG rasterizer to
   add the required PNG compatibility rendition. This is a deterministic
   rasterization of the canonical SVG, not a browser screenshot.
4. The browser-only TanStack `renderChartImage` helper is optional for future
   user-facing PNG/JPEG/WebP downloads; it is not required by the document
   export pipeline.

Every target retains the semantic data table. A model that the pinned adapter
cannot represent must produce a visible diagnostic and table fallback; it must
never fall into an independent atlcli geometry implementation. TanStack's SVG
renderer escapes text. Any Astro use of the trusted generated markup must stay
behind this adapter boundary and hostile-label tests; raw provider HTML or
macro parameters never reach an HTML injection seam.

## 1.2 Implementation status

The shared contract, Cloud/DC normalization seams, dedicated macro registry
renderer, Astro chart block, DOCX/PDF SVG-plus-table projections, and the
version-pinned TanStack `ExportBlock` adapter exist in the stacked follow-up
PR. The tenant-free acceptance corpus now visually proves all twelve chart
kinds through the real DOCX and PDF engines. The provider-live path remains a
separate one-XY-bar source proof: its fixture deliberately contains one macro
because a same-page multi-macro experiment triggered provider-side Hibernate
stale-state errors.

An evidence audit on 2026-08-01 reset earlier overclaims. The former
atlcli-owned document geometry renderer has since been removed: DOCX and PDF
now consume the same pinned TanStack scene/SVG adapter as the publishing
surface. The document proof covers signed horizontal stacks, stepped paths,
pie labels, locale-aware time-series labels, and Gantt progress/dependency
edges. Astro still requires the corresponding all-shapes visual, responsive,
interaction, and accessibility proof. The maintained evidence matrix is in
[`CHART-SUPPORT-MATRIX.md`](./CHART-SUPPORT-MATRIX.md).

### Proven milestone evidence (2026-08-01)

- A tenant-free, IO-free proof runs the shared twelve-shape corpus through the
  real document export entry points. DOCX embeds the canonical standalone
  TanStack SVG and a PNG compatibility rendition; PDF keeps the same SVG as
  vector content. Both retain one aligned semantic table per chart.
- Every generated page was rendered and visually inspected: 12/12 DOCX chart
  pages and all 15 PDF pages (cover, contents, twelve charts, end page) pass
  without clipped marks, title/legend collisions, duplicate tables, or broken
  Gantt/pie/step/time-series geometry. Generated proof files stay outside Git;
  `scripts/chart-rendered-proof.ts` makes the proof reproducible.
- The normal mayflower DOCX path completed for the persistent provider fixture;
  the generated document contains the shared `chart.svg`, a PNG compatibility
  rendition, the chart title, marker, table headers, and all four values. A
  LibreOffice render visibly shows the bars and the table.
- The normal mayflower PDF path completed with the shared SVG asset; Typst
  compiled the vector chart visual plus the semantic table, and extracted text
  contains the same marker, title, and values with no provider error text. A
  rasterized page inspection visibly shows the bars and the table. The chart
  visual reserves a title/legend header band and plot-edge padding so neither
  document target clips the last mark or overlays the legend on the title.
- The Astro publication refresh/build/verification completed for one page;
  the verified output inventory covered 35 files and 26 links. The generated
  page contains `data-atlcli-chart-capability="tanstack-v0.3/bar"` and the
  browser hydrated it to `data-atlcli-chart-island="hydrated"` with a
  TanStack runtime chart. Generated output remains outside Git.
- Contract tests dispatch all twelve Cloud ADF and DC Storage spellings and
  retain aligned tables, but are not yet accepted as visual all-shapes proof.
- Browser checks prove the local XY-bar island, static table after hydration,
  390px overflow behavior, CSP-safe bundled output, and JavaScript-off
  fallback for that path. They do not yet prove all twelve shapes.

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

- [x] `pie` — category labels and one value series; section labels/explode
      semantics are typed.
- [x] `bar` — category/value series; vertical and horizontal orientation.
- [x] `line` — category or ordered x values and one or more numeric series.
- [x] `area` — category or ordered x values and one or more numeric series.
- [x] `xyArea` — numeric/date x values with one or more y series.
- [x] `xyBar` — numeric/date x values with one or more y series.
- [x] `xyLine` — numeric/date x values with one or more y series.
- [x] `xyStep` — numeric/date x values with stepped interpolation.
- [x] `xyStepArea` — numeric/date x values with stepped area interpolation.
- [x] `scatter` — numeric/date x values and numeric y values; no invented
      category labels.
- [x] `timeSeries` — normalized timestamp x values, timezone/locale policy,
      and the documented time-period aggregation metadata.
- [x] `gantt` — typed tasks with start, end, optional progress, and dependency
      labels; never coerced into a simple numeric series.

Every kind must have a fixture, normalization test, static Astro rendering
test, accessible fallback test, and DOCX/PDF projection test. If a kind is not
renderable by an interactive library, it still remains statically supported.

### 3.2 Typed presentation/data semantics (P0/P1)

- [ ] Orientation: `vertical`/`horizontal` where meaningful, with equivalent
      Astro and document geometry.
- [ ] `threeD`, `stacked`, `showShapes`, and bounded `opacity`; stacked and
      mixed-sign geometry must be visually proven.
- [x] Width/height with safe bounds and responsive overflow behavior.
- [x] `dataDisplay`: hidden, before, or after the chart.
- [ ] Title, subtitle, x-axis label, y-axis label, and all legend positions.
- [x] Table selection (`tables`) and column selection (`columns`).
- [x] Data orientation: horizontal or vertical.
- [ ] Locale/language/country and date format, with a deterministic fallback.
- [x] Time period: millisecond, second, minute, hour, day, week, month,
      quarter, or year.
- [x] `forgive` behavior as an explicit strict/lenient normalization decision;
      never silently discard malformed rows.
- [x] Background, border, and series colors after palette validation.
- [ ] Axis bounds, tick units, label angles, category label position, and date
      tick position, with finite-value and range validation.
- [ ] Pie section label and section explode values in every static target.
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

- [x] Add a runtime validator and a stable schema version.
- [x] Enforce finite numeric values, canonical dates, unique IDs, aligned
      category series, non-negative dimensions, and valid ranges.
- [x] Bound rows, series, points, tasks, string lengths, palette entries, and
      serialized model bytes. Limits must be configurable only within safe
      maxima and included in diagnostics.
- [x] Keep the existing interactive limits (`800` points / bounded payload) as
      an island policy, not as a reason to reject valid static charts.
- [x] Reject prototype-polluting keys and never deserialize executable values.
- [x] Give each normalized chart a deterministic model digest for caching and
      dependency tracking.

## 5. Source adapters and extraction

### 5.1 Cloud ADF adapter

- [x] Detect the Chart macro extension in the existing ADF macro/extension
      normalization path.
- [x] Decode macro parameters into the closed `ChartModelV1` options above.
- [x] Extract chart data from macro-body tables, including selected
      tables/columns and horizontal/vertical orientations.
- [ ] Resolve referenced attachments through the existing authenticated asset
      acquisition layer, then pass only verified bytes/metadata to the model.
- [ ] Preserve source IDs/versions in non-public provenance without leaking
      account, tenant, or credential material.

### 5.2 Data Center/Server Storage adapter

- [x] Detect the Storage XHTML Chart macro and parse its parameter names and
      macro-body tables without rendering arbitrary XHTML.
- [x] Support the same normalized shape matrix and diagnostics as Cloud; source
      differences belong in the adapter, not in Astro components.
- [ ] Resolve same-page and attachment-backed data through the DC client
      contract, with explicit behavior when a provider does not expose a
      referenced attachment version.
- [x] Add DC fixtures for legacy parameter spellings and malformed/partial
      macros.

### 5.3 Data and locale policy

- [x] Define how empty cells, non-numeric values, duplicate labels, and missing
      dates are handled under strict and lenient modes.
- [ ] Define deterministic decimal, grouping, date, timezone, and locale rules;
      do not depend on the build machine's locale.
- [x] Implement documented `forgive` semantics as diagnostics plus a visible
      partial-data marker when rows are skipped.
- [ ] Include table/attachment dependency digests in the page/bundle manifest so
      a source-data change invalidates the affected page.

## 6. Macro registry and render-model integration

- [x] Add a dedicated Chart macro renderer to `@atlcli/export-macros`; do not
      route charts through the catch-all `export_view` fallback.
- [x] Map Cloud/DC macro names to the same renderer and source adapter.
- [x] Emit one `ExportBlock` chart node in source order, including local ID,
      caption, provenance, diagnostics, and dependency metadata where allowed.
- [x] Remove the spike's page-level `chart` sidecar fixture and replace it with
      a chart entry in `blocks`.
- [x] Ensure unknown chart types remain visible as a typed diagnostic/fallback
      block rather than being silently treated as a paragraph.
- [x] Update the macro capability registry and publishing support matrix so
      “chart” means an implemented source adapter, not merely a declared macro
      kind.

## 7. Astro render-kit and Starlight integration

### 7.1 Static output (required for every kind)

- [x] Add a semantic `ChartBlock.astro` dispatch component to
      `@atlcli/export-blocks-astro`.
- [ ] Render and visually prove accessible SVG/HTML for every chart kind, with title/description,
      keyboard-safe labels, no raw HTML injection, and responsive dimensions.
- [x] Render an accessible data table before/after the visual when configured;
      when visual rendering is intentionally unavailable, render the table as
      the primary representation with an explicit status message.
- [x] Render Gantt tasks with a semantic table/list fallback even if a visual
      timeline is unavailable.
- [x] Add Starlight theme composition without moving chart semantics into
      Starlight-specific components.
- [x] Expose stable CSS custom properties/data attributes for theme adapters;
      do not make the normalized model depend on Starlight tokens.

### 7.2 Interactive output (bounded enhancement)

- [x] Keep static output as the default and JavaScript-off contract.
- [x] Extend the closed interactive adapter registry only for shapes with an
      evidenced renderer contract; the first adapter is the pinned TanStack
      Charts `0.3.1` bounded bar profile for `bar` and `xyBar`.
- [x] Define the explicit `tanstack-v0.3/bar` capability ID and validate the
      model before island hydration, with bounded rows, series, points, and
      payload bytes.
- [x] Fall back to the static visual/table for unsupported kinds, excessive
      data, CSP restrictions, or adapter errors.
- [ ] Complete the interaction matrix for tooltips, legends, resize behavior,
      keyboard access, and reduced motion. The provider-live proof demonstrates
      deterministic hydration and no Confluence data fetch; the static table
      remains present after island hydration.

## 8. DOCX/PDF compatibility

- [x] Add and visually prove all-shapes chart handling in the DOCX export-block renderer: embed the shared
      deterministic SVG visual (with a bounded PNG compatibility rendition)
      and retain an accessible tabular projection alongside it.
- [x] Add and visually prove all-shapes chart handling in the PDF/Typst renderer: embed the shared SVG
      visual and retain the same accessible table fallback, with no unhandled
      `type:"chart"` branch.
- [x] Preserve captions, source order, labels, and data values in both document
      projections.
- [ ] Add regression fixtures proving existing DOCX/PDF exports remain byte- or
      structure-stable for pages without charts.
- [x] Document which visual options are intentionally approximated in DOCX/PDF
      (for example, 3D perspective or interactive hover) while retaining the
      underlying data.

## 9. Diagnostics, security, and operations

- [x] Define stable diagnostic codes for unsupported kind, malformed table,
      missing attachment, locale/date parse, truncation, skipped row, and
      renderer fallback.
- [ ] Make strict mode fail the page/build for configured P0 errors; make
      lenient mode publish a visibly marked partial result and report all
      diagnostics.
- [ ] Enforce resource/time/memory budgets separately for acquisition,
      normalization, static rendering, and islands.
- [x] Sanitize text/attributes and URLs using existing shared gates; never use
      `set:html` for untrusted chart input.
- [x] Ensure chart models and manifests contain no secrets, bearer tokens,
      private tenant URLs, or unreviewed customer identifiers.
- [ ] Make cache invalidation depend on model and source-data digests, not only
      page version.

## 10. Test and proof plan

### 10.1 Contract and unit tests

- [x] Provide one tenant-free, IO-free all-shapes acceptance corpus shared by
      every host proof. It covers multiple series, signed values,
      horizontal/stacked bars, sparse XY data, stepped paths, explicit locale
      metadata, pie labels/explode, and Gantt progress/dependencies.
- [x] Validator tests cover every `ChartKindV1`, every data mode, option bounds,
      malformed rows, duplicate IDs, date parsing, and deterministic digests.
- [x] Cloud ADF fixtures cover all twelve kinds and every P0 parameter family.
- [x] DC Storage fixtures cover all twelve kinds, legacy spellings, same-page
      table data, and malformed/partial input; attachment-backed data remains
      an explicit follow-up.
- [ ] Renderer tests assert source order, semantic labels, data-table values,
      escaping, responsive attributes, and JavaScript-off output.
- [x] DOCX/PDF tests assert no chart block is dropped, the shared SVG visual is
      requested/embedded, and the aligned fallback data table is present.
- [x] Security/property tests cover hostile labels, URLs, CSS colors, huge
      dimensions, NaN/Infinity, prototype keys, and oversized payloads.

### 10.2 Shape-by-shape acceptance matrix

For each row below, the test suite must include source fixture -> normalized
`ExportBlock` -> Astro static output -> accessible fallback -> DOCX/PDF
projection. Interactive output is optional only when an adapter is explicitly
listed in the capability registry.

| Shape | Static | Data table | DOCX/PDF | Interactive policy |
| --- | --- | --- | --- | --- |
| `pie` | [x] | [x] | [x] | [x] static fallback |
| `bar` | [x] | [x] | [x] | [x] TanStack bounded |
| `line` | [x] | [x] | [x] | [x] static fallback |
| `area` | [x] | [x] | [x] | [x] static fallback |
| `xyArea` | [x] | [x] | [x] | [x] static fallback |
| `xyBar` | [x] | [x] | [x] | [x] TanStack bounded |
| `xyLine` | [x] | [x] | [x] | [x] static fallback |
| `xyStep` | [x] | [x] | [x] | [x] static fallback |
| `xyStepArea` | [x] | [x] | [x] | [x] static fallback |
| `scatter` | [x] | [x] | [x] | [x] static fallback |
| `timeSeries` | [x] | [x] | [x] | [x] static fallback |
| `gantt` | [x] | [x] | [x] | [x] table/timeline fallback |

### 10.3 Consumer and live proof

- [x] Build the packed/plain-Astro consumer and the Starlight consumer against
      the published package boundary; no workspace-private import paths.
- [ ] Complete in-app-browser checks for all-shapes desktop/mobile layout,
      accessibility tree,
      keyboard navigation, reduced motion, CSP, and JavaScript disabled; the
      representative interactive XY-bar island is proven in the local build.
- [x] Run the mayflower Cloud profile against the persistent, non-private
      provider fixture page and record the provider-valid XY-bar result without
      committing page content.
- [x] If a DC provider is available, run the same matrix against DC; otherwise
      mark the DC live gate explicitly unexecuted and retain fixture evidence.
- [ ] Verify a refresh with changed table/attachment data invalidates only the
      affected page and produces a new model/bundle digest.

## 11. Implementation tasks

### T0 — Freeze contract and support policy

- [x] Confirm the twelve shape discriminants and the `ChartDataV1` union.
- [x] Confirm P0/P1 parameter families, strict/lenient behavior, bounds, and
      the static-vs-island policy.
- [x] Record open provider differences and the exact Atlassian source links in
      the support matrix.

### T1 — Add the real shared `ExportBlock` type

- [x] Implement `ChartModelV1`, provenance, diagnostics, and `type:"chart"`
      in `packages/export-blocks`.
- [x] Add runtime validation, schema versioning, and public exports.
- [x] Replace page-level chart sidecars in fixtures and contract tests.

### T2 — Cloud ADF source adapter

- [x] Decode the Chart macro extension and all T0-supported parameters.
- [x] Extract tables/columns; attachment-backed data remains an explicit
      follow-up because the provider fixture exposes semantic table data.
- [x] Add Cloud unit and fixture tests for all shapes and failure modes.

### T3 — DC Storage source adapter

- [x] Decode Storage XHTML macros and legacy parameters safely.
- [x] Extract same-page table data and add DC fixtures for all shapes;
      attachment-backed data remains a follow-up.

### T4 — Data, locale, and dependency normalization

- [x] Implement orientation, numeric/date parsing, aggregation metadata,
      `forgive`, and deterministic locale behavior.
- [x] Emit model digests and bounded diagnostics; source-table/attachment
      dependency digests remain a follow-up.

### T5 — Macro registry integration

- [x] Register the dedicated Chart renderer and remove chart reliance on the
      generic fallback.
- [x] Emit source-ordered chart blocks and update capability reporting.

### T6 — Static Astro components

- [x] Add the version-pinned `@atlcli/export-charts-tanstack` package and prove
      that the shared tenant-free all-shapes corpus compiles into non-empty
      TanStack scenes and deterministic, escaped DOM-free SVG output.
- [ ] Implement the separate `@atlcli/export-charts-tanstack` adapter for all
      twelve shapes and visually prove Astro's static/server SVG from the
      shared TanStack scene.
- [ ] Implement and prove data-table/Gantt fallbacks, theme tokens, and a11y behavior.

### T7 — Interactive adapter(s)

- [x] Integrate the closed, version-pinned `tanstack-v0.3/bar` capabilities for
      bounded categorical and XY-bar data, with source-neutral validation.
- [x] Ensure static fallback remains complete for every unsupported case.

### T8 — DOCX/PDF projections

- [x] Replace the temporary atlcli-owned SVG geometry with the shared TanStack
      scene/SVG adapter, then visually prove all shapes in both document
      engines. PDF retains vector SVG; DOCX also retains a bounded PNG
      compatibility rendition.
- [ ] Add no-regression fixtures for existing export surfaces.

### T9 — Hardening and observability

- [x] Add security/property tests, bounded diagnostics, and privacy
      scans.
- [ ] Add independent acquisition/render resource budgets and cache invalidation
      for source-table/attachment changes.

### T10 — End-to-end proof and documentation

- [ ] Run the packed consumers, all-shapes browser checks, Cloud
      DOCX/PDF export, and Cloud Astro publish verification; the broader browser
      matrix and optional DC E2E remain open.
- [x] Publish a support matrix that distinguishes source support, static output,
      interactive enhancement, and document projection.
- [x] Update user-facing docs and keep generated output out of Git.

## 12. Acceptance gates / Definition of Done

The follow-up PR is complete only when all gates are checked:

- [x] `ExportBlock` has a validated, source-neutral `type:"chart"` node; no
      page-level chart sidecar remains.
- [ ] All twelve documented Confluence chart kinds have Cloud/DC fixtures,
      static Astro output, accessible data fallback, and DOCX/PDF projections.
      The DOCX/PDF portion is proven; the Astro visual/a11y gate remains open.
- [ ] P0 parameter families and strict/lenient diagnostics are tested; every
      unsupported option is visible and deterministic.
- [ ] Existing non-chart DOCX/PDF and Astro pages pass regression tests.
- [x] Interactive islands are closed, bounded, version-pinned, optional, and
      never required for content or accessibility.
- [x] Cloud live proof is recorded; DC live proof is recorded or explicitly
      marked unavailable with fixture evidence.
- [x] `bun run typecheck` and the relevant `bun run test` suites pass.
- [x] No credentials, private customer pages, generated Astro output, or
      temporary build artifacts are committed.

## 13. Open decisions

- [x] Expose 3D as a semantic hint and intentionally flatten it in all static
      renderers; the normalizer emits an `invalid-option` approximation
      diagnostic.
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
