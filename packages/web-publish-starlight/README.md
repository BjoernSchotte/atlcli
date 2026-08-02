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

The supported experience includes responsive Starlight navigation, color modes,
breadcrumbs, TOC, previous/next and related-page slots, locale/RTL output,
Pagefind search with facets and keyboard handling, Expressive Code, SEO
metadata, and optional provider-validated Confluence edit actions. Pagefind is
static and built locally; analytics is off by default; PWA/service-worker
output is deferred.

In the CLI lifecycle, read the active bundle and private inventory paths from
`ATLCLI_PUBLICATION_BUNDLE_PATH` and `ATLCLI_PUBLICATION_INVENTORY_PATH` in the
project-owned Astro config. Do not pin a fixture or previous digest directory:
every successful refresh activates a new immutable bundle.

Compatibility is Astro `>=7.1.6 <8` with the tested Starlight release declared
by the package. The consumer project owns its theme and build command. Theme
changes must preserve the neutral `ExportBlock[]` body, semantic hooks,
JavaScript-off rendering, CSP, and accessibility gates. See the
[experience adapter guide](/publishing/adapter-authoring/) for extension
points and the [Starlight publishing guide](/publishing/) for operations.
