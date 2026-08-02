---
title: "ExportBlock Astro Render Kit"
description: "Use the standalone theme-neutral Astro renderer for normalized ExportBlock documents"
---

# ExportBlock Astro Render Kit

`@atlcli/export-blocks-astro` is a 0.x, theme-neutral Astro package for
rendering normalized `ExportBlock[]` documents. It is independently packable and
does not depend on Starlight, Confluence, ADF/Storage, authentication, search,
deployment, analytics, or a runtime cache.

## On this page

- [Install and render](#install-and-render)
- [Render context](#render-context)
- [Overrides and styling](#overrides-and-styling)
- [Supported block families](#supported-block-families)
- [Charts](#charts)
- [Security and accessibility](#security-and-accessibility)
- [Boundary](#boundary)

## Install and render

```bash
bun add @atlcli/export-blocks-astro astro
```

```astro
---
import ExportDocument from "@atlcli/export-blocks-astro/components/ExportDocument.astro";
import "@atlcli/export-blocks-astro/styles.css";

const context = {
  base: "/",
  locale: "en",
  direction: "ltr",
  links: new Map(),
  assets: new Map(),
  anchors: new Map(),
};
---

<ExportDocument blocks={page.blocks} context={context} />
```

Production publications should use the validated context from
`@atlcli/web-publish-astro`, not hand-written maps.

## Render context

The context supplies locale/direction, resolved page and asset references,
anchors, and safe presentation metadata. The renderer never fetches a source
page and never turns a page id into a Confluence URL. An unresolved page or
asset reference remains visible text or a bounded placeholder.

## Overrides and styling

Import a component at build time and pass it through `overrides`:

```astro
<ExportDocument
  blocks={page.blocks}
  context={context}
  overrides={{ heading: BrandHeading, callout: BrandCallout }}
/>
```

Theme adapters may override the documented CSS variables and semantic hooks:
`data-atlcli-document`, `data-atlcli-block`, `data-atlcli-caption`,
`data-atlcli-status`, and `data-atlcli-asset-unresolved`. Generated class names
are not a public contract.

## Supported block families

The V1 dispatcher covers headings, paragraphs, inline marks/links, lists and
tasks, quotes, code, rules, tables, media/images, callouts, status, expand and
layout blocks, smart cards, diagrams, charts, anchors, and visible unknown
fallbacks. Macro-specific support depends on the upstream decoder/resolver;
the Astro package does not claim that every Confluence macro is natively
implemented.

## Charts

`ChartBlock.astro` consumes the `type: "chart"` `ExportBlock` and its validated
`atlcli.chart/1` model. It emits accessible static SVG/HTML plus a semantic data
table for all twelve supported shape kinds, including the task-table fallback
for Gantt data. The optional `@tanstack/charts` `0.3.1` island is an additive,
bounded enhancement; it is never required for content, accessibility, or
JavaScript-off output. Chart data is a normalized render model, not raw ADF or
macro parameters.

## Security and accessibility

Text and attributes are escaped. Links use an explicit scheme allowlist; local
assets must be resolved bundle entries; colors and layout values are validated.
Unknown content is visible rather than executable. Every shipped component
must retain semantic headings, labels, keyboard operation, image alternatives,
and the no-JavaScript static fallback.

## Boundary

The package accepts `ExportBlock[]`, not raw ADF or Storage XHTML, and exports no
`AdfDocument`. A future additive `ADF -> ExportBlock[]` adapter may live in a
separate package. It must not introduce a second ADF-specific component tree or
Confluence access into this render kit.

## Related topics

- [Publish with Astro](/publishing/)
- [Experience adapter authoring](/publishing/adapter-authoring/)
- [Renderers and charts](/publishing/renderers/)
- [Confluence chart support](/publishing/charts/)
- [Package consumption](/reference/package-consumption/)
