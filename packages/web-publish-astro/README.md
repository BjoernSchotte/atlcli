# `@atlcli/web-publish-astro`

Node-only Astro 7.1 integration and structured-data loader for a complete,
validated atlcli publication bundle. It reads `ExportBlock[]` page documents;
it never acquires Confluence content, credentials, or network data.

Semantic document components are intentionally supplied by
`@atlcli/export-blocks-astro`, not by this integration package.

## Post-build boundary

V1 ends after Astro and Pagefind produce a verified static-publication
manifest. A future augmenter (for example an offline/PWA layer) must consume
that completed manifest, reserve every owned output directory through the
publication route/output registry before writing, and emit a new
digest-bound manifest. It must not mutate an in-progress build or infer
ownership from glob patterns. This package intentionally defines no service
worker, web-app-manifest, Workbox, or other PWA output path.
