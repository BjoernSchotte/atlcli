# `@atlcli/web-publish-starlight`

The first supported publishing experience for an Astro project using Starlight.
It composes `@atlcli/export-blocks-astro`; it does not decode ADF/Storage,
acquire Confluence data, own routes or caches, execute builds, or dispatch
`ExportBlock` content itself.

The consumer Astro project owns its installed Starlight version, theme, and
build command. This package declares the supported compatibility range and a
versioned experience descriptor only; later modules add configuration and
components through documented Starlight extension points.
