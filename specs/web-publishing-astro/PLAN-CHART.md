# Chart macro parity — a real `ExportBlock` surface for Astro publishing

- Status: **Implemented and proven — the typed surface, all-shapes TanStack
  Astro/DOCX/PDF projection, bounded interaction, and CLI/browser/MV3 host
  paths pass the acceptance gates below**
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
kinds through Astro 7.1.6 and the real DOCX/PDF engines. The provider-live path
remains a separate one-XY-bar source proof: its fixture deliberately contains
one macro because a same-page multi-macro experiment triggered provider-side
Hibernate stale-state errors.

An evidence audit on 2026-08-01 reset earlier overclaims. The former
atlcli-owned document geometry renderer has since been removed: DOCX and PDF
now consume the same pinned TanStack scene/SVG adapter as the publishing
surface. The document proof covers signed horizontal stacks, stepped paths,
pie labels, locale-aware time-series labels, and Gantt progress/dependency
edges. The production Astro proof covers the corresponding all-shapes visual,
responsive and accessibility baseline, JavaScript-off behavior, and the
complete bounded `bar`/`xyBar` interaction matrix. The maintained evidence
matrix is in [`CHART-SUPPORT-MATRIX.md`](./CHART-SUPPORT-MATRIX.md).

### Proven milestone evidence (2026-08-02)

- A tenant-free, IO-free proof runs the shared twelve-shape corpus through the
  real document export entry points. DOCX embeds the canonical standalone
  TanStack SVG and a PNG compatibility rendition; PDF keeps the same SVG as
  vector content. Both retain one aligned semantic table per chart.
- Every generated page was rendered and visually inspected: 12/12 DOCX chart
  pages and all 15 PDF pages (cover, contents, twelve charts, end page) pass
  without clipped marks, title/legend collisions, duplicate tables, or broken
  Gantt/pie/step/time-series geometry. Generated proof files stay outside Git;
  `scripts/chart-rendered-proof.ts` makes the proof reproducible.
- The shared TanStack scene now places `top`, `right`, `bottom`, and `left`
  legends outside the plot with reserved margins, maps the documented category
  rotations and date-period tick positions, offsets named pie sections and
  their labels, and caps Gantt date ticks so adjacent labels remain readable.
  Unit tests inspect scene coordinates rather than merely searching SVG text.
- The refreshed tenant-free proof was rendered through the real document
  engines after those changes. Original-resolution inspection confirms the
  right-legend exploded pie, signed horizontal stack with bottom legend,
  top/left/right legends, rotated category/date labels, sparse and stepped XY
  shapes, and the dependency-linked Gantt all fit their pages in both DOCX and
  PDF. The proof artifacts and rendered page images remain outside Git.
- A second complete document proof after source-semantic and subtitle changes
  rendered 12/12 DOCX pages and all 15 PDF pages at original resolution. It
  confirms visible subtitles, scene background/border styling, separated
  title/legend bands, unclipped plots, aligned data tables, and stable page
  breaks for every chart kind. No asset or image was skipped.
- Cloud and DC normalization now apply deterministic locale-aware numeric and
  UTC date parsing, documented default values, table/column selection by
  number or authored identity, all data orientations, strict `forgive=false`
  rejection, and selected-table dependency digests. Publication pages convert
  those into ID-free `macro-data` render dependencies; tests prove that an
  unselected-table change is cache-stable while a selected-table change is
  not.
- Publication projects may configure the chart diagnostic codes treated as
  P0. The default policy treats incomplete data, parse failures, truncation,
  unsupported shapes, and renderer fallback as P0: strict refreshes become
  incomplete and strict builds reject an affected active bundle. Explicit
  `allow-partial` projects retain the chart, report every diagnostic, and keep
  the detailed warning visibly attached to Astro, DOCX, and PDF output. A
  deliberate skipped-row proof compiled through the real document engines;
  original-resolution inspection confirms the DOCX warning line and PDF
  warning callout fit above the unchanged TanStack visual/table without
  clipping or collisions.
- The production Astro 7.1.6 consumer renders the same twelve models through
  the shared TanStack server-SVG adapter. The clean Starlight gallery combines
  those twelve static models with two explicit bounded interaction examples.
  Desktop and 390px browser inspection confirms all twelve shapes, fourteen
  aligned semantic tables, UTF-8 labels, strict CSP, focusable contained mobile
  visuals, no document overflow, and no production browser warnings/errors.
  A fresh JavaScript-off run retains all fourteen static SVGs and tables with
  zero hydrated islands; the JavaScript-on reduced-motion run hydrates only the
  two allowlisted islands and retains visible keyboard focus. Hostile-label
  inertness remains separately proven by the synthetic security fixture, which
  is deliberately absent from the clean gallery.
- The production ordinary-browser conformance bundle runs the same twelve
  models through both public browser document entry points. Its DOCX artifact
  contains 12 standalone TanStack SVG parts plus 12 PNG compatibility parts;
  its captured Typst bundle contains 12 accessible TanStack SVG vector assets,
  and both artifacts retain all 12 chart titles. This proof also caught and
  fixed the missing-asset-fetcher case: generated DOCX charts now require only
  the rasterizer, not an unrelated page-attachment fetcher.
- The packed Chrome MV3 offscreen job pipeline consumes one synthetic Storage
  page containing all twelve Chart macro spellings. Its retained DOCX artifact
  has 12 TanStack SVG parts, 12 PNG compatibility parts, and all 12 titles; its
  retained PDF is complete and has at least twelve chart pages. This executes
  the productive queued resolvers, IndexedDB spools, canvas rasterizer, Typst
  worker, retained artifact stores, and report stores rather than a test-only
  renderer.
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
  retain aligned tables; the shared tenant-free corpus supplies the separate
  visual all-shapes proof.
- Browser checks prove all twelve static shapes plus the bounded categorical-
  and XY-bar islands, static tables after hydration, pointer and keyboard
  tooltips, pin/Escape, resize behavior, reduced motion, 390px containment, and
  CSP-safe bundled output. The clean Starlight gallery explicitly proves the
  complete all-shapes matrix with JavaScript disabled and no external requests.

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

- [x] Orientation: `vertical`/`horizontal` where meaningful, with equivalent
      Astro and document geometry.
- [x] `threeD`, `stacked`, `showShapes`, and bounded percentage `opacity`;
      stacked and mixed-sign geometry is visually proven. `threeD` remains an
      explicit flattened semantic hint because TanStack has no 3D geometry.
- [x] Width/height with safe bounds and responsive overflow behavior.
- [x] `dataDisplay`: hidden, before, or after the chart.
- [x] Title, subtitle, x-axis label, y-axis label, and all legend positions.
- [x] Table selection (`tables`) and column selection (`columns`).
- [x] Data orientation: horizontal or vertical.
- [x] Locale/language/country and date format, with a deterministic fallback.
- [x] Time period: millisecond, second, minute, hour, day, week, month,
      quarter, or year.
- [x] `forgive` behavior as an explicit strict/lenient normalization decision;
      never silently discard malformed rows.
- [x] Background, border, and series colors after palette validation.
- [x] Axis bounds, tick units, label angles, documented category-label rotation
      (`up45`/`up90`/`down45`/`down90`), and date-period tick placement
      (`start`/`middle`/`end`), with finite-value and range validation.
- [x] Pie section label and section explode values in every static target.
- [x] Preserve generated-chart attachment name, `new`/`replace`/`keep`
      versioning, comment, thumbnail intent, and requested PNG/JPG format as
      provenance only. These Chart macro parameters control Confluence's
      optional cached output image; they are not an input-data source and must
      never trigger an attachment fetch in an Astro island or document export.

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
  style?: { backgroundColor?: string; borderColor?: string; colors?: readonly string[] };
  axes?: ChartAxesV1;
  pie?: { sectionLabelFormat?: string; explode?: readonly string[] };
  locale?: { language?: string; country?: string; dateFormat?: string; timePeriod?: ChartTimePeriodV1 };
  data: ChartDataV1;
  source: ChartSourceProvenanceV1;
}
```

`ChartAxesV1` and `ChartSourceProvenanceV1` are also closed, dependency-free
types. The former contains only finite numeric/date bounds, tick units and
periods, numeric/date value kinds, label angles, documented category-label
rotations, and documented date-period positions.
The latter contains a source kind (`cloud-adf` or `dc-storage`), the normalized
generated-attachment policy, a provider-local macro identity, and safe
dependency/model digests; it must not contain a clickable tenant URL or
authentication data.
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
- [x] Treat the Chart macro's `attachment` options as generated-output cache
      policy rather than an external data reference; preserve their safe typed
      metadata without fetching bytes.
- [x] Preserve source IDs/versions in non-public provenance without leaking
      account, tenant, or credential material.

### 5.2 Data Center/Server Storage adapter

- [x] Detect the Storage XHTML Chart macro and parse its parameter names and
      macro-body tables without rendering arbitrary XHTML.
- [x] Support the same normalized shape matrix and diagnostics as Cloud; source
      differences belong in the adapter, not in Astro components.
- [x] Resolve same-page body tables without treating the generated-chart
      `attachment` setting as input data. The same typed provenance policy is
      shared with Cloud.
- [x] Add DC fixtures for legacy parameter spellings and malformed/partial
      macros.

### 5.3 Data and locale policy

- [x] Define how empty cells, non-numeric values, duplicate labels, and missing
      dates are handled under strict and lenient modes.
- [x] Define deterministic decimal, grouping, date, timezone, and locale rules;
      do not depend on the build machine's locale.
- [x] Implement documented `forgive` semantics as diagnostics plus a visible
      partial-data marker when rows are skipped.
- [x] Include selected source-table dependency digests in the page/bundle
      manifest so a source-data change invalidates the affected page. Generated
      chart-attachment policy remains part of the model digest, not an acquired
      asset dependency.

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
- [x] Render and visually prove accessible SVG/HTML for every chart kind, with title/description,
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
- [x] Complete the interaction matrix for tooltips, legends, resize behavior,
      keyboard access, and reduced motion. The production Astro 7.1.6 matrix
      proves TanStack grouped pointer/keyboard tooltips, pin/Escape behavior,
      responsive legends, native `ResizeObserver` plus window-resize fallback,
      reduced-motion animation policy, 390px containment, retained exact-value
      tables, and complete JavaScript-off static SVG output for both promoted
      `bar` and `xyBar` capabilities.

## 8. DOCX/PDF compatibility

- [x] Add and visually prove all-shapes chart handling in the DOCX export-block renderer: embed the shared
      deterministic SVG visual (with a bounded PNG compatibility rendition)
      and retain an accessible tabular projection alongside it.
- [x] Add and visually prove all-shapes chart handling in the PDF/Typst renderer: embed the shared SVG
      visual and retain the same accessible table fallback, with no unhandled
      `type:"chart"` branch.
- [x] Preserve captions, source order, labels, and data values in both document
      projections.
- [x] Add regression fixtures proving existing DOCX/PDF exports remain byte- or
      structure-stable for pages without charts. DOCX pins the serialized OOXML
      digest and proves the generated-SVG seam is never called; PDF pins the
      generated Typst-source digest and proves no `assets/chart-*` entry exists.
      The older full DOCX golden captured before chart support also remains
      part-for-part identical.
- [x] Document which visual options are intentionally approximated in DOCX/PDF
      (for example, 3D perspective or interactive hover) while retaining the
      underlying data.

## 9. Diagnostics, security, and operations

- [x] Define stable diagnostic codes for unsupported kind, malformed table,
      locale/date parse, truncation, skipped row, invalid generated-attachment
      policy, and renderer fallback.
- [x] Make strict mode fail the page/build for configured P0 errors; make
      lenient mode publish a visibly marked partial result and report all
      diagnostics.
- [x] Enforce resource/time/memory budgets separately for acquisition,
      normalization, static rendering, and islands.
  - [x] Thread a frozen, project-derived chart policy through the immutable
        publication bundle. Enforce normalization row/point/byte admission,
        TanStack scene-node/SVG-byte/render-time limits, and stricter island
        row/series/point/payload limits. Strict mode rejects admission/render
        overruns; explicit partial mode renders a visible warning and complete
        data table instead of an unbounded visual.
  - [x] Enforce a project-bounded island mount deadline. A mount overrun or
        adapter failure destroys the TanStack host, restores the complete
        static SVG, exposes a visible status, and retains the exact-value table;
        the real browser matrix proves the teardown path with a bounded
        66-row/12-series chart.
  - [x] Add acquisition deadlines and aggregate memory accounting. The frozen
        project policy now bounds source acquisition plus normalization with
        `maxChartAcquisitionMs` and independently caps the aggregate encoded
        chart-model payload with `maxChartAggregateBytes`. A raced deadline
        rejects even a non-cooperative adapter while aborting cooperative work;
        the real CLI/provider path proves a 1ms deadline exits with
        `chart-acquisition-timeout` before writing or activating a candidate.
        Strict aggregate overruns make refresh incomplete; explicit partial
        mode retains diagnostics without silently dropping data.
- [x] Sanitize text/attributes and URLs using existing shared gates. The only
      chart `set:html` seam accepts validated, escaped output from the pinned
      TanStack adapter; raw provider HTML and macro parameters cannot reach it.
- [x] Ensure chart models and manifests contain no secrets, bearer tokens,
      private tenant URLs, or unreviewed customer identifiers.
- [x] Make cache invalidation depend on model and source-data digests, not only
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
      table data, malformed/partial input, and generated-attachment provenance.
- [x] Renderer tests assert source order, semantic labels, data-table values,
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
- [x] Complete in-app-browser checks for the all-shapes static matrix on
      desktop/mobile, accessibility tree, keyboard focus, reduced motion, CSP,
      and JavaScript disabled. The production Astro 7.1.6 build proves all
      twelve static shapes, responsive desktop/390px containment, fourteen
      aligned semantic tables, strict CSP, UTF-8 labels, visible focus, no
      document overflow, and zero browser errors. With JavaScript disabled all
      fourteen SVG/table pairs remain; with JavaScript enabled exactly the two
      allowlisted islands hydrate. The separate synthetic fixture proves
      hostile-label inertness without exposing test payloads in the clean
      review surface.
- [x] Run the mayflower Cloud profile against the persistent, non-private
      provider fixture page and record the provider-valid XY-bar result without
      committing page content.
- [x] If a DC provider is available, run the same matrix against DC; otherwise
      mark the DC live gate explicitly unexecuted and retain fixture evidence.
- [x] Verify a refresh with changed selected-table data invalidates only the
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
- [x] Extract tables/columns and retain the generated-chart attachment policy
      without misclassifying it as an input-data dependency.
- [x] Add Cloud unit and fixture tests for all shapes and failure modes.

### T3 — DC Storage source adapter

- [x] Decode Storage XHTML macros and legacy parameters safely.
- [x] Extract same-page table data, add DC fixtures for all shapes, and retain
      the generated-chart attachment policy without fetching it as data.

### T4 — Data, locale, and dependency normalization

- [x] Implement orientation, numeric/date parsing, aggregation metadata,
      `forgive`, and deterministic locale behavior.
- [x] Emit model digests, selected source-table dependency digests, and bounded
      diagnostics. Publication pages retain an ID-free `macro-data` dependency
      keyed by chart source order; changing an unselected table leaves it
      stable while changing a selected table changes it.

### T5 — Macro registry integration

- [x] Register the dedicated Chart renderer and remove chart reliance on the
      generic fallback.
- [x] Emit source-ordered chart blocks and update capability reporting.

### T6 — Static Astro components

- [x] Add the version-pinned `@atlcli/export-charts-tanstack` package and prove
      that the shared tenant-free all-shapes corpus compiles into non-empty
      TanStack scenes and deterministic, escaped DOM-free SVG output.
- [x] Implement the separate `@atlcli/export-charts-tanstack` adapter for all
      twelve shapes and visually prove Astro's static/server SVG from the
      shared TanStack scene.
- [x] Implement and prove data-table/Gantt fallbacks, theme tokens, and a11y behavior.

### T7 — Interactive adapter(s)

- [x] Integrate the closed, version-pinned `tanstack-v0.3/bar` capabilities for
      bounded categorical and XY-bar data, with source-neutral validation.
- [x] Ensure static fallback remains complete for every unsupported case.
- [x] Prove grouped pointer/keyboard tooltips, pin/Escape, legends, responsive
      resize with and without `ResizeObserver`, reduced motion, and JavaScript-
      off output in the production Astro 7.1.6 browser matrix.

### T8 — DOCX/PDF projections

- [x] Replace the temporary atlcli-owned SVG geometry with the shared TanStack
      scene/SVG adapter, then visually prove all shapes in both document
      engines. PDF retains vector SVG; DOCX also retains a bounded PNG
      compatibility rendition.
- [x] Add chart-free no-regression fixtures for DOCX, PDF, and plain Astro.
      Their OOXML, Typst-source, and rendered-main digests are pinned; the
      normal Astro build and in-app-browser DOM check prove no chart markup,
      runtime, alert, or horizontal overflow appears.

### T9 — Hardening and observability

- [x] Add security/property tests, bounded diagnostics, and privacy
      scans.
- [x] Add independent acquisition/render resource budgets and cache invalidation
      for selected source-table changes.
  - [x] Selected source-table content digests invalidate the cache, and the
        immutable bundle now carries independent normalization, static-render,
        and island structural limits plus the static render deadline.
  - [x] Complete acquisition deadline/aggregate-memory containment and exercise
        its cancellation path through the normal `wiki publish plan` command
        against the mayflower provider profile. The timed-out run leaves no
        plan, bundle, or active pointer in its isolated workspace.
  - [x] Complete island runtime containment and exercise its teardown/static-
        fallback path end to end. Together with the acquisition proof above,
        every resource phase now has a structural and runtime gate.

### T10 — End-to-end proof and documentation

- [x] Run the packed consumers, all-shapes ordinary-browser and packed-MV3
      document checks, Cloud DOCX/PDF export, and Cloud Astro publish
      verification. DC live E2E remains explicitly unavailable and is covered
      by the source/contract fixtures; the bounded client-interaction and
      JavaScript-off all-shapes matrices are proven above.
- [x] Publish a support matrix that distinguishes source support, static output,
      interactive enhancement, and document projection.
- [x] Update user-facing docs and keep generated output out of Git.

## 12. Acceptance gates / Definition of Done

The follow-up PR is complete only when all gates are checked:

- [x] `ExportBlock` has a validated, source-neutral `type:"chart"` node; no
      page-level chart sidecar remains.
- [x] All twelve documented Confluence chart kinds have Cloud/DC fixtures,
      static Astro output, accessible data fallback, and DOCX/PDF projections.
- [x] P0 parameter families and strict/lenient diagnostics are tested; every
      unsupported option is visible and deterministic.
- [x] Existing non-chart DOCX/PDF and Astro pages pass regression tests. This
      includes the pre-refactor full DOCX golden, the PDF multi-page engine
      golden, and the dedicated chart-free cross-surface digest fixtures.
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
- [x] Do not promote another XY/time-series interactive capability in V1.
      The measured, version-pinned client contract remains deliberately limited
      to categorical `bar` and provider-valid `xyBar`; every other shape keeps
      its complete TanStack static SVG and exact-value table. Future adapters
      require a separate capability ID and the same a11y/bundle/runtime gates.
- [x] A missing generated-chart attachment never fails a build: it is an output
      cache hint, not the source data. Missing/invalid body-table data follows
      the normal strict/lenient chart diagnostic policy.
- [x] Preserve declared Gantt dependency labels/edges without recalculating or
      inventing scheduling behavior.

## 14. References

- [Atlassian Confluence Cloud — Insert the Chart macro](https://support.atlassian.com/confluence-cloud/docs/insert-the-chart-macro/)
- [Atlassian Confluence Data Center/Server — Chart macro](https://confluence.atlassian.com/conf717/chart-macro-1115675780.html)
- [Astro — Content collections and custom loaders](https://docs.astro.build/en/guides/content-collections/)
- [TanStack Charts](https://tanstack.com/charts/latest)
