# @atlcli/web-publish

Mostly isomorphic contracts and pure planning algorithms for publishing
Confluence content as verified static sites.

The default entry point is browser-safe and owns publication projects, refresh
plans, routes, typed links/assets, immutable bundles, experiences, search,
SEO/i18n/media, analytics, edit links, build results, manifests, and issues.
It depends only on `@atlcli/export-blocks`.

Use `@atlcli/web-publish/node` for bounded filesystem helpers. Astro,
Starlight, Pagefind execution, Confluence acquisition/authentication, CLI
orchestration, and deployment belong to separate adapters or hosts.
