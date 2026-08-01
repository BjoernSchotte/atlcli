# `@atlcli/export-charts-tanstack`

Closed adapter from the renderer-neutral `ChartModelV1` contract to the pinned
TanStack Charts runtime. It is the only chart-geometry implementation used by
Astro, DOCX, and PDF.

- `createTanStackChartDefinitionV1` maps every supported chart kind to TanStack
  marks, scales, guides, color, and theme.
- `createTanStackChartSceneV1` compiles the definition at explicit dimensions.
- `renderTanStackChartSvgV1` returns deterministic, DOM-free accessible SVG.

Provider HTML, callbacks, URLs, and executable configuration never cross this
package boundary. Document targets retain their semantic data tables; DOCX may
derive a PNG compatibility rendition from the returned SVG.
