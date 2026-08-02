---
title: "Renderers, macros, and charts"
description: "Understand ExportBlock rendering, macro fallbacks, and TanStack Charts"
---

# Renderers, macros, and charts

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

Chart and Mermaid names are recognized as requested semantic categories, but a
source adapter is still required before a Confluence chart/Mermaid macro is
fully supported end to end. Do not claim macro parity from the generic fallback.

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

`StaticChart.astro` emits an accessible SVG/table fallback. An opt-in
`InteractiveChart.astro` island uses the pinned `@tanstack/charts` `0.3.1`
adapter with bounded, frozen data. JavaScript failure or disablement leaves the
static chart usable. The adapter is replaceable behind the chart renderer
contract and is currently limited to the tested bar-chart profile.

## Related topics

- [Experience adapter authoring](./adapter-authoring.md)
- [Security and privacy](./security.md)
- [Confluence macro compatibility](/confluence/macro-compatibility/)
- [ExportBlock Astro package reference](/reference/export-blocks-astro/)
