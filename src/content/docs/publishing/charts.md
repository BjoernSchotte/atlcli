---
title: "Confluence charts across Astro, DOCX, and PDF"
description: "Supported Chart macro shapes, static and interactive rendering, accessibility, limits, and diagnostics"
---

atlcli normalizes the Confluence Chart macro once and renders the same validated
chart model in Astro, Word, and PDF. The authored table remains the data source;
the optional generated-image attachment is never treated as authoritative.

## On this page

- [Supported chart shapes](#supported-chart-shapes)
- [Source compatibility](#source-compatibility)
- [Output behavior](#output-behavior)
- [Configure chart rendering](#configure-chart-rendering)
- [Accessibility and no-JavaScript behavior](#accessibility-and-no-javascript-behavior)
- [Diagnostics and strict publishing](#diagnostics-and-strict-publishing)
- [Examples](#examples)
- [Troubleshooting](#troubleshooting)
- [Current boundaries](#current-boundaries)

## Supported chart shapes

The `atlcli.chart/1` model supports all twelve normalized Confluence Chart
macro shapes:

| Confluence type | Normalized kind | Static Astro | Interactive Astro | DOCX | PDF |
| --- | --- | --- | --- | --- | --- |
| Pie | `pie` | SVG + table | Static in V1 | SVG + PNG fallback + table | SVG + table |
| Bar | `bar` | SVG + table | TanStack island | SVG + PNG fallback + table | SVG + table |
| Line | `line` | SVG + table | Static in V1 | SVG + PNG fallback + table | SVG + table |
| Area | `area` | SVG + table | Static in V1 | SVG + PNG fallback + table | SVG + table |
| XY Area | `xyArea` | SVG + table | Static in V1 | SVG + PNG fallback + table | SVG + table |
| XY Bar | `xyBar` | SVG + table | TanStack island | SVG + PNG fallback + table | SVG + table |
| XY Line | `xyLine` | SVG + table | Static in V1 | SVG + PNG fallback + table | SVG + table |
| XY Step | `xyStep` | SVG + table | Static in V1 | SVG + PNG fallback + table | SVG + table |
| XY Step Area | `xyStepArea` | SVG + table | Static in V1 | SVG + PNG fallback + table | SVG + table |
| Scatter | `scatter` | SVG + table | Static in V1 | SVG + PNG fallback + table | SVG + table |
| Time Series | `timeSeries` | SVG + table | Static in V1 | SVG + PNG fallback + table | SVG + table |
| Gantt | `gantt` | SVG + task table | Static in V1 | SVG + PNG fallback + task table | SVG + task table |

“Static in V1” is complete chart support, not a placeholder. Every shape uses
the shared `@atlcli/export-charts-tanstack` scene and server-SVG renderer. The
client island is an additive interaction layer currently enabled only for the
proven categorical Bar and provider-valid XY Bar profiles.

## Source compatibility

Confluence Cloud ADF and Data Center Storage XHTML both normalize into the same
source-neutral chart block. The normalizer supports:

- category, numeric XY, date/time, and Gantt task tables;
- table and column selection, horizontal or vertical data orientation;
- titles, subtitles, axis labels and bounds, legends, stacking, shapes,
  opacity, palettes, backgrounds, borders, and data-label display;
- locale-aware numbers and dates, time periods, Gantt progress, and declared
  dependency labels;
- deterministic diagnostics for malformed or approximated options.

The `3D` option is retained as provenance but intentionally flattened. Static
documents and sites do not invent perspective geometry. A visible
`invalid-option` diagnostic records that approximation.

## Output behavior

### Astro and Starlight

`ChartBlock.astro` renders a labelled, accessible SVG followed by the exact
semantic data table. Wide visuals scroll inside their own focusable region on
narrow screens; the page itself must remain overflow-free.

When chart islands are allowed, Bar and XY Bar add responsive resizing,
pointer and keyboard focus, exact-value tooltips, pin/dismiss controls, and
reduced-motion-aware transitions. A failed or timed-out island is destroyed
and the complete static SVG and table remain visible.

### DOCX

Word receives the same deterministic SVG plus a high-resolution PNG
compatibility fallback for Word/LibreOffice implementations that do not display
SVG. The exact-value table follows the visual and remains editable.

### PDF

The Typst pipeline embeds the same SVG as a vector image and follows it with a
tagged semantic table. Chart titles, subtitles, diagnostics, and captions stay
outside the drawing so they do not overlap its legend or plotting area.

## Configure chart rendering

Chart limits live in the publication project file. Start with the bounded
profile below and adjust only when the source corpus requires it:

```json
{
  "macros": {
    "mode": "allow-frozen-live",
    "unknown": "visible-fallback",
    "maxRows": 2000,
    "maxNodes": 20000,
    "maxBytes": 524288,
    "chartDiagnostics": {
      "p0Codes": [
        "unsupported-kind",
        "malformed-data",
        "locale-parse",
        "skipped-row",
        "truncated",
        "renderer-fallback"
      ]
    }
  },
  "renderers": {
    "allowedRendererIds": ["atlcli.chart"],
    "allowIslands": true,
    "maxIslandBytes": 65536,
    "maxChartRows": 80,
    "maxChartSeries": 12,
    "maxChartPoints": 800,
    "maxChartSvgNodes": 100000,
    "maxChartSvgBytes": 2097152,
    "maxChartRenderMs": 2000,
    "maxChartIslandMountMs": 250,
    "maxChartAcquisitionMs": 300000,
    "maxChartAggregateBytes": 16777216
  }
}
```

The schema requires `maxChartRows`, `maxChartSeries`, and `maxIslandBytes`.
The remaining chart-specific renderer fields are optional and use the values
shown above when omitted. Configured values cannot raise the engine's hard
limits; lower values are useful for a deliberately smaller publication budget.

Set `allowIslands` to `false` for a fully static site. This changes only the
interactive enhancement: every chart still renders as SVG plus its data table.

## Accessibility and no-JavaScript behavior

- The SVG has an accessible title and can receive focus when horizontal
  scrolling or chart interaction needs it.
- The complete data table is always present in HTML and in document output.
- Color is not the sole carrier of series identity; legends and exact values
  remain available.
- Interactive Bar and XY Bar charts support keyboard focus, tooltip movement,
  Enter/Space pinning, Escape dismissal, and reduced motion.
- Disabling JavaScript leaves all twelve shapes readable and does not trigger a
  network request.

## Diagnostics and strict publishing

By default, these diagnostics are P0 for a `strict` publication:
`unsupported-kind`, `malformed-data`, `locale-parse`, `skipped-row`,
`truncated`, and `renderer-fallback`. `plan` reports the affected source page
and chart block path without copying source values into the public bundle.

A strict refresh does not activate a candidate containing a configured P0
chart diagnostic. An `allow-partial` project can retain the chart's exact-value
table and visible diagnostic, but requires the separate `--allow-partial`
operator acknowledgement.

## Examples

### Verify a static-only publication

Set `renderers.allowIslands` to `false`, then run:

```bash
atlcli wiki publish plan --project .atlcli/publish.json --profile work
atlcli wiki publish run --project .atlcli/publish.json --profile work
atlcli wiki publish verify --project .atlcli/publish.json
```

Inspect at least one chart with JavaScript disabled. The SVG and data table
must still be present.

### Keep interaction bounded

For a public site with small authored charts, keep the default 80-row,
12-series, 800-point, 64-KiB island profile. A larger chart remains fully
static instead of hydrating an oversized client payload.

## Troubleshooting

| Symptom | Likely cause | Action |
| --- | --- | --- |
| Only a table appears | Visual preparation failed or no image/SVG seam was available | Inspect the export report for `renderer-fallback` or `image-embed-failed`; do not remove the table fallback |
| Chart is static in Astro | Shape is outside the Bar/XY Bar island profile or exceeds an island budget | This is expected V1 behavior; verify the SVG and table, or reduce the authored data size |
| Strict refresh is incomplete | A configured P0 normalization/render diagnostic was emitted | Fix the source table/locale/options, or deliberately choose partial publishing |
| Dates or numbers are skipped | Macro locale/date settings do not match the table values | Set the Chart macro language, country, or date format consistently and refresh |
| Gantt has no visual | Task/start/end columns were not recognized | Use explicit task, start, and end headers with parseable dates |
| Labels or legend collide | Stale pre-chart renderer output or unsupported custom styling | Rebuild with the current adapter and inspect theme overrides before changing chart data |

## Current boundaries

- TanStack Charts `0.3.1` is pinned and pre-alpha. It is replaceable behind the
  closed adapter; source data never receives callbacks or executable options.
- Only Bar and XY Bar hydrate in V1. The remaining shapes are first-class static
  charts with the same SVG geometry used by document export.
- Chart rendering does not fetch Confluence at browser runtime.
- The Confluence Chart macro is distinct from fenced Mermaid diagrams. Mermaid
  has its own supported diagram-type matrix and fallback behavior.

## Related topics

- [Publish with Astro](./index.md)
- [Web publishing configuration](./configuration.md)
- [Renderers and macro fallbacks](./renderers.md)
- [Web publishing security](./security.md)
- [DOCX and PDF export](/confluence/export/)
- [Macro compatibility](/confluence/macro-compatibility/)
- [ExportBlock Astro Render Kit](/reference/export-blocks-astro/)
