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

## Trusted component overrides

An Astro project may statically import a component and pass it through the
`overrides` prop. This is a build-time integration surface, not source data:

```astro
---
import ExportDocument from "@atlcli/export-blocks-astro/components/ExportDocument.astro";
import BrandHeading from "./BrandHeading.astro";
---

<ExportDocument blocks={blocks} context={context} overrides={{ heading: BrandHeading }} />
```

Every named slot in `ASTRO_EXPORT_BLOCK_OVERRIDE_SLOTS_V1` receives its source
block and render context. The project must resolve and validate its selected
override descriptors before rendering; page data cannot name a slot, module,
or component.

## Charts

`StaticChart.astro` always produces an accessible SVG and data-table fallback.
A trusted Astro project can opt into `InteractiveChart.astro`; for a real
`ExportBlock` it selects the closed `tanstack-v0.3/bar` adapter and reconstructs
bounded, validated rows from the semantic table at runtime. The first proven
profile covers categorical `bar` and provider-valid `xyBar` blocks. The legacy
standalone chart-model API remains available for compatibility and reads its
validated SVG data. No chart definition, callback, URL, credential, or raw
macro parameter is serialized to the page. JavaScript failure or disablement
leaves the static representation visible.

TanStack Charts `0.3.1` is an explicit, pinned pre-alpha dependency. The
adapter is replaceable behind `ChartRendererAdapterV1`; its production use is
limited to the tested bounded bar-chart profile until a later compatibility
review promotes or replaces it.

## Security boundary

Components escape content by default and never accept raw HTML. Links have a
renderer-side scheme allowlist, assets must be local bundle paths, and
user-derived CSS is restricted to canonical colors and numeric layout shares.
The project that builds pages validates original SVG bytes and all asset
provenance before this package receives a render context.

Page and attachment links are looked up through the context's stable semantic
keys (`astroExportLinkKeyV1`). Page/attachment targets without a trusted
resolved entry render as non-clickable text; they never fall back to a source
or Confluence URL. Standalone consumers may still use safe external and
page-local anchor targets directly.

The included Astro consumer proves a CSP with external scripts and styles,
`connect-src 'none'`, and no inline module scripts. It permits inline styles
only for the component's validated numeric layout and color attributes; an
experience that needs a stricter `style-src` can extract these bounded values
into its build-owned stylesheet.

## Deferred ADF facade

This package intentionally accepts `ExportBlock[]`, not raw ADF or Data Center
Storage XHTML, and it does not export `AdfDocument`. A future additive adapter
may normalize raw ADF into this same model with explicit media, mention, and
extension resolvers plus visible unknown fallbacks. It must not create a second
ADF-specific component tree or add implicit Confluence access here.
