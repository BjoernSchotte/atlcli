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

Use `@atlcli/web-publish/node` for bounded filesystem helpers. Astro,
Starlight, Pagefind execution, Confluence acquisition/authentication, CLI
orchestration, and deployment belong to separate adapters or hosts.
