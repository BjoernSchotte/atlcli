# `@atlcli/web-publish-astro`

Node-only Astro 7.1 integration and structured-data loader for a complete,
validated atlcli publication bundle. It reads `ExportBlock[]` page documents;
it never acquires Confluence content, credentials, or network data.

Semantic document components are intentionally supplied by
`@atlcli/export-blocks-astro`, not by this integration package.

## Bundle-to-render context

`createPublicationRenderContextV1()` is the standard bridge from one loaded
`PublicationPageV1` plus its immutable `PublicationBundleV1` to the render kit's
`AstroExportBlockRenderContextV1`. It applies the trusted Astro `base` and route
namespace, resolves page links and page-local anchors, maps verified bundle
assets (including original-download metadata), and rejects unsafe routes,
assets, and external schemes. It performs no source fetch and never derives a
Confluence URL. `pages` should contain the loaded page set when cross-page
anchor links are present.

`verifyAstroStaticPublicationOutputV1()` then checks the private build
inventory against the public manifest and output directory: it rejects extra
or missing files, symlinks, digest/byte-length drift, base-escaping internal
links, missing fragments, external resource sinks, active-content URL schemes,
and disabled-analytics markers. The CLI uses this verifier for the `verify`
stage; a successful build is never reported as deployed.

## Static search components

The optional theme-neutral components
`@atlcli/web-publish-astro/components/PagefindSearch.astro` (modal) and
`@atlcli/web-publish-astro/components/PagefindSearchPage.astro` (full page)
consume only the Pagefind files produced by the post-build hook. They accept a
base path, allowlisted facet values, translated visible strings, and either the
default `auto` Pagefind worker runtime or the explicit `main-thread` fallback.
Result titles and excerpts are always inserted as text, never HTML.

```astro
---
import PagefindSearchPage from "@atlcli/web-publish-astro/components/PagefindSearchPage.astro";
---

<PagefindSearchPage
  base="/docs/"
  filters={[{ name: "language", label: "Language", values: ["en", "de"] }]}
  messages={{ queryLabel: "Search", noResults: "No matching pages." }}
/>
```

## Post-build boundary

V1 ends after Astro and Pagefind produce a verified static-publication
manifest. A future augmenter (for example an offline/PWA layer) must consume
that completed manifest, reserve every owned output directory through the
publication route/output registry before writing, and emit a new
digest-bound manifest. It must not mutate an in-progress build or infer
ownership from glob patterns. This package intentionally defines no service
worker, web-app-manifest, Workbox, or other PWA output path.

## Operator lifecycle

The CLI composes this package after a complete immutable bundle exists:

```text
plan -> refresh -> build -> verify
```

`createAstroStaticPublicationBuilderV1()` runs the project-owned Astro build,
creates a private `StaticPublicationManifestV1`, and stages output/inventory
with recoverable sibling paths. `verifyAstroStaticPublicationOutputV1()` checks
the exact output set, byte digests, links, anchors, assets, Pagefind/SEO files,
CSP, analytics declaration, and edit-link origin. A successful build is a
candidate; this package never reports remote deployment.

The CLI exposes the selected content-addressed bundle and private inventory to
that build as `ATLCLI_PUBLICATION_BUNDLE_PATH` and
`ATLCLI_PUBLICATION_INVENTORY_PATH`. A project-owned `astro.config.mjs` should
pass those exact values to `atlcliPublishingIntegration()` and fail closed when
they are absent. They are local non-secret paths; the bounded build environment
does not include Atlassian credentials.

See the [web publishing guide](/publishing/) and the
[ExportBlock Astro reference](/reference/export-blocks-astro/) for the public
configuration and component contract.
