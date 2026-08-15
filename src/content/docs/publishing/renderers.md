---
title: "Renderers, macros, and charts"
description: "Understand ExportBlock rendering, macro fallbacks, and TanStack Charts"
---

The renderer pipeline is intentionally layered:

```text
Confluence ADF / Storage
  -> source decoder and macro resolver
  -> ExportBlock[] + closed render models
  -> theme-neutral Astro render kit
  -> Starlight or another experience
```

Astro components do not parse raw ADF, Storage XHTML, or arbitrary macro HTML.

## Macro behavior

The current registry has explicit renderers for TOC, Jira/Jira Issues,
Confluence lists, children, include/excerpt families, Multiexcerpt Include,
page-properties reports, Scroll table layout, Draw.io/Gliffy previews, and
Whiteboard embeds. These renderers return normal blocks or a closed web render
model.

Unknown or unsupported macros remain visible as a labelled fallback with a
diagnostic. This is safer than silently dropping content and gives a future
renderer a stable extension point.

Chart macros now have a real source-neutral `ExportBlock` representation. The
Cloud ADF and Data Center Storage decoders normalize the supported Chart macro
data into the validated `atlcli.chart/1` model, preserving source order and
diagnostics. Astro renders static semantic output for all twelve documented
shape kinds. DOCX embeds the shared SVG with a PNG compatibility fallback; PDF
embeds the same vector SVG. Both document formats retain the exact-value table
below the visual. Attachment bytes still come through the normal asset
pipeline; an unavailable generated-chart attachment does not make an Astro
component fetch Confluence at runtime. Mermaid remains a separate renderer
capability and should not be inferred from Chart macro support.

## Block overrides

Use a statically imported override component for theme-specific presentation:

```astro
<ExportDocument
  blocks={page.blocks}
  context={context}
  overrides={{ heading: BrandHeading }}
/>
```

Page data cannot choose a component, module, or callback. Overrides must retain
the semantic `data-atlcli-*` hooks and safe fallback behavior.

## Charts

`ChartBlock.astro` emits an accessible SVG/table fallback for every normalized
chart kind. JavaScript failure or disablement leaves the static chart usable.
The optional `@tanstack/charts` `0.3.1` island remains a bounded enhancement
behind an explicit capability registry; shapes outside the Bar/XY Bar island
profile and data beyond island budgets use the complete static representation.

The complete shape/output matrix, project limits, strict diagnostic policy,
and troubleshooting steps are in the dedicated [chart guide](./charts.md).

## Related topics

- [Experience adapter authoring](./adapter-authoring.md)
- [Confluence charts across Astro, DOCX, and PDF](./charts.md)
- [Security and privacy](./security.md)
- [Confluence macro compatibility](/confluence/macro-compatibility/)
- [ExportBlock Astro package reference](/reference/export-blocks-astro/)
