# `@atlcli/web-publish-starlight`

The first supported publishing experience for an Astro project using Starlight.
It composes `@atlcli/export-blocks-astro`; it does not decode ADF/Storage,
acquire Confluence data, own routes or caches, execute builds, or dispatch
`ExportBlock` content itself.

The consumer Astro project owns its installed Starlight version, theme, and
build command. This package declares the supported compatibility range and a
versioned experience descriptor only; later modules add configuration and
components through documented Starlight extension points.

`StarlightDocumentBody.astro` is the document-body bridge for a project-owned
`<StarlightPage>` route. It accepts normalized `ExportBlock[]` plus the
render-kit context and delegates to `@atlcli/export-blocks-astro`; the project
adds this package's stylesheet to Starlight's documented `customCss` option.
The route data and page source remain Astro/ExportBlock based—MDX is not an
interchange format or a required content layer.
