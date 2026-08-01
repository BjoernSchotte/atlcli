# @atlcli/web-publish

Mostly isomorphic contracts and pure planning algorithms for publishing
Confluence content as verified static sites.

The default entry point is browser-safe and owns publication projects, refresh
plans, routes, typed links/assets, immutable bundles, experiences, search,
SEO/i18n/media, analytics, edit links, build results, manifests, and issues.
It also exports strict V1 runtime parsers with bounded JSON validation and
closed registries. Pure negotiation helpers bind trusted experience slots,
design tokens, component overrides, Pagefind, renderers, and builder ports
without importing any concrete Astro or theme implementation. It depends only
on `@atlcli/export-blocks`.

`planPublicationRoutesV1()` reconciles the mutable project-owned route
registry. It preserves first-assigned routes across rename/move, accepts only
explicit tombstone evidence, reserves historical and handwritten routes,
applies operator overrides before generated allocations, and rejects exact,
case-folded, or final output-path collisions. Logical routes stay independent
of Astro; `publicationRouteToOutputPathV1()` performs the final directory/file
profile mapping.

`planPublicationReferencesV1()` performs the next, builder-neutral stage. It
derives stable page-local heading/bookmark anchors and resolves typed page and
asset references while they are still logical bundle route/path values. It
rejects unsafe fragments, duplicate anchors, unsafe external URLs, and dangling
page, anchor, or asset references before any builder can emit HTML.

`canonicalPublicationJsonV1()` and the `digestPublication*V1()` helpers use
browser Web Crypto over sorted canonical JSON. They preserve array order,
exclude recognized private/volatile fields and self digests, reject ambiguous
JSON/cycles, and validate bundle-page-route-link-asset integrity before a
bundle identity is calculated.

`planPublicationRefreshV1()` compares two source snapshots without conflating
absence with deletion. It emits separate `exclude`, `out-of-scope`, and
`inaccessible` changes; only a complete traversal carrying explicit
`complete-scan` authority may emit `confirmed-delete`. Content, metadata,
tree-position, asset metadata, and route changes remain independently visible.

Use `@atlcli/web-publish/node` for bounded filesystem helpers and the default
publication-workspace cache store. The cache is digest-keyed, stores only
validated `PublicationPageV1` documents and binary asset values, rejects
symlink/path traversal inputs, and remains derived state rather than source or
bundle authority. `digestPublicationPageCacheKeyV1()` includes the entire
normalized-page dependency identity, not merely the source page version.
Refresh planning records asset-metadata and frozen live-macro dependency changes
as independent changes, so neither can remain stale when a page body is
unchanged.

`materializeNodePublicationBundleV1()` is the Node-only activation seam. It
accepts only a complete, digest-valid `PublicationRefreshPlanV1` and already
normalized pages plus materialized asset bytes. It rechecks page, graph, asset,
and bundle digests in a private `<workspace>/staging/<run-id>/` root, promotes
the resulting content-addressed immutable directory below `bundles/`, and only
then atomically replaces the private `current.json` pointer. A malformed plan,
asset mismatch, cancellation, or symlinked owned directory therefore leaves the
last active bundle unchanged. The caller, not this package, owns acquisition,
macro resolution, MIME/SVG decoding, and retention.
Astro, Starlight, Pagefind execution, Confluence
acquisition/authentication, CLI orchestration, and deployment belong to
separate adapters or hosts.
