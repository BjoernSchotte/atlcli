# T0 Astro render-kit spike

This private package exists only to prove the standalone package boundary before
the public `@atlcli/export-blocks` and `@atlcli/export-blocks-astro` contracts
are frozen in T2/T6. It deliberately has no Starlight, Confluence, acquisition,
Pagefind, analytics, deployment, service-worker, or runtime-cache dependency.

The public implementation must replace the temporary structural types in this
spike with the dependency-free `@atlcli/export-blocks` model.

The spike exports the exhaustive document dispatcher at `/document`, the
semantic block and inline components at `/block` and `/inline`, the static and
island chart surfaces, and opt-in baseline styles. Trusted overrides compose
these public semantic components instead of copying dispatch or flattening rich
content.
