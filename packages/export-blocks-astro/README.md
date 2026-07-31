# `@atlcli/export-blocks-astro`

Theme-neutral Astro render kit for normalized `ExportBlock[]` documents.

It is intentionally separate from Confluence acquisition, ADF/Storage
decoding, Starlight, routing, search, and deployment. Its only runtime input
will be normalized blocks plus pre-resolved link, asset, anchor, locale, and
direction context. The package is experimental (`0.x`) while the exhaustive
component registry and packed plain-Astro consumer are completed.

## Styling contract

Import `@atlcli/export-blocks-astro/styles.css` for the accessible baseline.
Theme adapters may override the versioned custom properties
`--atlcli-content-foreground`, `--atlcli-content-muted`,
`--atlcli-content-border`, `--atlcli-content-surface`, and
`--atlcli-content-code-background`.

Stable integration hooks are semantic HTML plus `data-atlcli-document`,
`data-atlcli-block`, `data-atlcli-caption`, `data-atlcli-status`, and
`data-atlcli-asset-unresolved`. Generated class names and whitespace are not
public compatibility contracts.

## Charts

`StaticChart.astro` always produces an accessible SVG fallback. A trusted
Astro project can opt into `InteractiveChart.astro`; it selects the closed
`tanstack-v0.3` adapter and reconstructs bounded, validated chart rows from
that SVG at runtime. No chart definition, callback, URL, credential, or raw
macro parameter is serialized to the page. JavaScript failure or disablement
leaves the SVG visible.

TanStack Charts `0.3.1` is an explicit, pinned pre-alpha dependency. The
adapter is replaceable behind `ChartRendererAdapterV1`; its production use is
limited to the tested bounded bar-chart profile until a later compatibility
review promotes or replaces it.
