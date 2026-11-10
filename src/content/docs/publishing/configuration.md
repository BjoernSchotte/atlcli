---
title: "Web publishing configuration"
description: "Configure Confluence scope, routes, Starlight, search, charts, media, privacy, and retention"
---

The operator-owned publication project is a strict, versioned JSON document.
It contains no credentials: authentication stays in the selected atlcli
profile, while private bundle and build paths stay in the local workspace.

## On this page

- [Start from the complete example](#start-from-the-complete-example)
- [Required top-level fields](#required-top-level-fields)
- [Source and completeness](#source-and-completeness)
- [Routes, macros, and assets](#routes-macros-and-assets)
- [Renderers and charts](#renderers-and-charts)
- [Experience, search, and presentation](#experience-search-and-presentation)
- [Analytics and edit links](#analytics-and-edit-links)
- [Builder and Astro handoff](#builder-and-astro-handoff)
- [Retention](#retention)
- [Troubleshooting](#troubleshooting)

## Start from the complete example

[Download the schema-tested Starlight project example](https://atlcli.sh/examples/publish-starlight.json),
save it as `.atlcli/publish.json`, and change at least:

1. `publicationKey`;
2. the page, tree, or space under `source`;
3. `builder.projectDir`, `builder.base`, and the matching Astro configuration;
4. `visibility`, `seo.robots`, analytics, and edit-link policy for the intended
   audience.

Then validate the source and route plan without building:

```bash
atlcli wiki publish plan --project .atlcli/publish.json --profile work
```

The parser rejects unknown fields and does not fill missing configuration
objects. Unless a field is marked optional below, it must be present. Values in
the downloadable file are conservative recommendations, not hidden defaults.

## Required top-level fields

| Field | Type | Required | Default | Purpose and constraints |
| --- | --- | --- | --- | --- |
| `schema` | string literal | yes | none | Must be `atlcli.publication-project/1` |
| `publicationKey` | non-empty string | yes | none | Stable local identity; also names the default workspace |
| `source` | object | yes | none | Exactly one page, tree, or space selector |
| `sourcePolicy` | object | yes | none | Representation, filters, and traversal limits |
| `completeness` | `strict` or `allow-partial` | yes | none | Partial mode additionally requires `--allow-partial` |
| `visibility` | `internal` or `public` | yes | none | Public mode additionally requires `--confirm-public` |
| `routes` | object | yes | none | Stable route allocation and operator overrides |
| `macros` | object | yes | none | Static/frozen-live resolution and data budgets |
| `assets` | object | yes | none | Self-containment, origin policy, and byte/pixel limits |
| `renderers` | object | yes | none | Renderer allowlist, islands, and chart limits |
| `experience` | object | yes | none | Trusted experience, capability, token, and override selection |
| `search` | object | yes | none | Pagefind languages, facets, metadata, ranking, and UI |
| `seo` | object | yes | none | Indexing, canonical, structured-data, social, and feed policy |
| `i18n` | object | yes | none | Locales, route mode, fallbacks, and UI translations |
| `media` | object | yes | none | Images, formats, fonts, zoom, and code presentation |
| `analytics` | tagged object | yes | none | `none` or the closed Plausible profile |
| `editLink` | tagged object | yes | none | `none` or provider-validated Confluence actions |
| `builder` | object | yes | none | Astro project, output profile, base, and literal build argv |
| `retention` | object | yes | none | Retained bundle/build counts and grace period |
| `activeBundleDigest` | non-empty string | no | absent | Optional optimistic state fence; normally managed operationally |

## Source and completeness

Choose exactly one source shape:

```json
{ "kind": "page", "pageId": "12345" }
```

```json
{ "kind": "tree", "rootPageId": "12345" }
```

```json
{ "kind": "space", "spaceKey": "DOCS" }
```

| Field | Type | Required | Constraints |
| --- | --- | --- | --- |
| `sourcePolicy.representation` | enum | yes | `adf-primary` for Cloud; `storage-primary` for Data Center or an explicit rollback path |
| `includeLabels` / `excludeLabels` | string arrays | yes | Empty arrays disable that filter |
| `excludeMode` | enum | yes | `prune-subtree` or `page-only` |
| `maxDepth` | non-negative integer | no | Applies to tree traversal |
| `maxPages` / `maxFolders` | positive integers | yes | Hard traversal bounds, not pagination hints |

Cloud ADF and Data Center Storage both converge on the same `ExportBlock[]`
page contract. `strict` aborts activation on unreadable, ambiguous, changed, or
configured P0 chart content. `allow-partial` never becomes active merely because
it is configured; the operator must also pass `--allow-partial`.

## Routes, macros, and assets

### Routes

`routes.prefix` is the logical publication namespace, for example `/publish`.
V1 requires `generatedStyle: "stable-pretty"`,
`collisions: "stable-source-suffix"`, and `tombstones: "retain"`. Add an
operator route only with a source ID and canonical route:

```json
{
  "customRoutes": [
    { "sourceId": "12345", "route": "/getting-started/" }
  ]
}
```

Renames and moves retain the first assigned route unless an explicit override
changes it. Route and output collisions fail before build.

### Macros

| Field | Type | Required | Default | Constraints |
| --- | --- | --- | --- | --- |
| `mode` | enum | yes | none | `static-only` or `allow-frozen-live` |
| `unknown` | literal | yes | none | Must be `visible-fallback` |
| `liveFreshnessSeconds` | positive integer | no | absent | Required only by policies that permit frozen live data |
| `maxRows`, `maxNodes`, `maxBytes` | positive integers | yes | none | Admission budgets for normalized macro data |
| `chartDiagnostics.p0Codes` | diagnostic-code array | no | built-in P0 list | Non-empty when supplied; controls strict chart completeness |

Dynamic macros are resolved and frozen during refresh. They never fetch
Confluence from the generated site.

### Assets

`selfContained` must be `true` and `activeContent` must be `block`. External
assets are either `same-origin-only` or use an explicit `allowlist` with
`allowedOrigins`. Positive `maxAssetBytes`, `maxTotalBytes`, `maxImagePixels`,
and `maxSvgNodes` values bound materialization before Astro sees an asset.

## Renderers and charts

`allowedRendererIds` is an explicit trusted registry. Include `atlcli.chart`
for Chart macro rendering. `allowIslands: false` produces a completely static
site without losing chart SVGs or data tables.

| Field | Required | Recommended / implicit value | Effective constraint |
| --- | --- | --- | --- |
| `maxIslandBytes` | yes | `65536` | Cannot exceed the 64-KiB chart-island hard cap |
| `maxChartRows` | yes | `80` | Interactive admission; normalization is separately bounded by `macros` |
| `maxChartSeries` | yes | `12` | Interactive admission |
| `maxChartPoints` | no | `min(800, rows × series)` | Cannot exceed the normalized model hard limit |
| `maxChartSvgNodes` | no | `100000` | May lower, but not raise, the static hard limit |
| `maxChartSvgBytes` | no | `2097152` | May lower, but not raise, the static hard limit |
| `maxChartRenderMs` | no | `2000` | Static-render deadline in milliseconds |
| `maxChartIslandMountMs` | no | `250` | Capped at 1000 ms |
| `maxChartAcquisitionMs` | no | `300000` | Source acquisition plus normalization; capped at 15 minutes |
| `maxChartAggregateBytes` | no | `16777216` | Per-refresh chart-model aggregate; capped at 64 MiB |

See the [chart guide](./charts.md) for the twelve-shape matrix, static and
interactive behavior, diagnostics, and accessibility requirements.

## Experience, search, and presentation

The supported first experience has `id: "atlcli.starlight"` and version
`1.0.0`. `requiredCapabilities` is an allowlisted array; build negotiation
fails if the selected experience cannot provide one. `designTokens` contains
only scalar values and `componentOverrides` can name only documented static
override slots. Page content can never select a component or module.

Pagefind is always the V1 search provider and `enabled` must be `true`:

| Search field | Allowed values |
| --- | --- |
| `languages` | `from-pages` or an array of locale strings |
| `filters` | `space`, `label`, `content-type`, `language` |
| `metadata` | `title`, `description`, `breadcrumbs`, `image` |
| `ranking` | non-negative weights for `title`, `headings`, `labels`, `body` |
| `ui` | `modal`, `page`, `both` |
| `shortcut` | `mod+k`, `/`, `none` |

SEO requires `sitemap: true` and `canonical: true`; `robots` is `index` or
`noindex`. Structured data is selected from `WebSite`, `TechArticle`, and
`BreadcrumbList`. Social cards are `metadata-only` or `generated`; feeds are
`disabled`, `rss`, or `atom`.

The `i18n` object declares a default locale, all locales, `prefix-all` or
`hide-default` routes, fallback mappings, and Starlight or explicit UI
translations. Media selects verified originals or bounded Astro derivatives,
original/AVIF/WebP formats, system or vendored-local fonts, optional image
zoom, and the required `expressive-code` code renderer.

## Analytics and edit links

Both are off by default in the example:

```json
{
  "analytics": { "provider": "none" },
  "editLink": { "provider": "none" }
}
```

Plausible requires an HTTPS `/api/event` endpoint, site domain, pathname-only
pageviews, DNT, no search terms, and an allowlisted event set.

### Edit links

`editLink.provider: "confluence"` adds one link back to the Confluence page on
every published page that originates from one. All fields are required unless
noted:

| Field | Type | Default | Constraints |
| --- | --- | --- | --- |
| `provider` | enum | none | `none` or `confluence` |
| `label` | non-empty string | none | Link text, for example `Edit in Confluence` |
| `placement` | enum | none | `page-actions` (above the content) or `page-footer` (below it) |
| `visibility` | enum | none | `all`, or `internal` to emit links only when the project `visibility` is `internal` |
| `fallback` | enum | none | `open-page` links to the page view when Confluence returns no edit URL; `omit` emits no link for that page |
| `publicTenantDisclosureAcknowledged` | literal `true` | optional | Required when project `visibility` is `public` and `editLink.visibility` is `all`; otherwise the project file is rejected when it is loaded |

`refresh` resolves the links and freezes them in the bundle. It uses only the
edit or view URL that Confluence returned for the page, and only when that URL
is `https` on the Confluence site of the profile that ran the refresh. It never
builds a URL from a page ID, title, or page content. A page without a usable
URL is published without a link.

Minimal example, for an internal site:

```json
{
  "visibility": "internal",
  "editLink": {
    "provider": "confluence",
    "label": "Edit in Confluence",
    "placement": "page-actions",
    "visibility": "all",
    "fallback": "omit"
  }
}
```

Realistic example, for a public site that deliberately shows where its source
lives and links to the page view when the reader cannot get an edit URL:

```json
{
  "visibility": "public",
  "editLink": {
    "provider": "confluence",
    "label": "Suggest a change in Confluence",
    "placement": "page-footer",
    "visibility": "all",
    "fallback": "open-page",
    "publicTenantDisclosureAcknowledged": true
  }
}
```

A public site with `"visibility": "internal"` edit links publishes no links and
keeps the Confluence site address out of the output.

The page template renders the link. With the Starlight experience, pass the
frozen link of the page to `StarlightPublicationPage`:

```astro
---
import { publicationEditLinkV1, readPublicationNavigationV1 } from "@atlcli/web-publish-astro";
import StarlightPublicationPage from "@atlcli/web-publish-starlight/components/StarlightPublicationPage.astro";

const loaded = await readPublicationNavigationV1({ bundlePath });
---

<StarlightPublicationPage
  page={page}
  navigation={navigation}
  sidebar={sidebar}
  context={context}
  editLink={publicationEditLinkV1(loaded.bundle, page.sourceId)}
/>
```

A plain Astro template renders the same value itself. Keep the
`data-atlcli-edit-link` marker on the anchor; `verify` uses it to find the link:

```astro
{editLink && (
  <a href={editLink.href} rel="external" data-atlcli-edit-link data-pagefind-ignore>
    {editLink.label}
  </a>
)}
```

`publicationEditLinkV1` returns `undefined` for a page without a link, so the
same template works with edit links on or off. After you change `editLink` or
the project `visibility`, run `refresh` again: `build` rejects a bundle that was
refreshed under a different edit-link policy.

## Builder and Astro handoff

| Field | Type | Required | Constraints |
| --- | --- | --- | --- |
| `builder` | literal | yes | Must be `astro-static` |
| `projectDir` | path string | yes | Operator-owned Astro project containing its own lockfile |
| `integrationOptions.bundlePath` | path string | yes | Direct-build fallback/config identity; never a public URL |
| `integrationOptions.routePrefix` | string | yes | Must agree with the site's publication route. Routes planned with the same `routes.prefix` are not prefixed a second time |
| `integrationOptions.experienceId` | string | yes | Must agree with the trusted experience |
| `trustedLayoutEntrypoint` | path string | no | Static, project-owned layout entrypoint |
| `outputProfile` | enum | yes | `directory` or `portable-file` |
| `base` | non-empty string | yes | Astro deployment base, such as `/docs` |
| `site` | absolute site string | no | Needed for public canonical URL generation |
| `buildCommand` | non-empty string tuple | yes | Literal executable and arguments; no shell parsing |

For the normal CLI lifecycle, `build` supplies the exact active immutable
bundle and private inventory paths only to the child Astro process:

- `ATLCLI_PUBLICATION_BUNDLE_PATH`
- `ATLCLI_PUBLICATION_INVENTORY_PATH`

The Astro config must consume those values. Fail closed when they are absent in
the operator path rather than building stale fixture data:

```js
const bundlePath = process.env.ATLCLI_PUBLICATION_BUNDLE_PATH;
const manifestPath = process.env.ATLCLI_PUBLICATION_INVENTORY_PATH;

if (!bundlePath || !manifestPath) {
  throw new Error("Run this site through `atlcli wiki publish build`.");
}

atlcliPublishingIntegration({
  bundlePath,
  manifestPath,
  routePrefix: "/publish",
  // ...the project-owned expected SEO/i18n/output configuration
});
```

These are local paths, not credentials. The build child receives a bounded
environment and no Atlassian token. Keep the private workspace outside
`projectDir/dist`.

`outputProfile` controls the final static layout:

- `directory`: `/guide/index.html`, for a directory-index host;
- `portable-file`: `/guide.html`, for a simple file host.

`build` records the Astro version installed in `projectDir` and requires it to
be within the tested range (`>=7.1.6 <8`, the packages' peer range). `verify`
rejects a build whose recorded Astro version differs from the one installed
now; rebuild after upgrading Astro.

## Retention

`retention.bundles` and `retention.builds` are positive counts;
`retention.graceSeconds` is a non-negative age fence. Cleanup is never inferred
from titles or globs. Review `status`, then use:

```bash
atlcli wiki publish prune --project .atlcli/publish.json --confirm
```

## Troubleshooting

| Symptom | Likely cause | Action |
| --- | --- | --- |
| `unknown field` | Typo or configuration from a different schema version | Compare with the downloadable example; do not suppress validation |
| Astro reads a fixture/stale bundle | Site config ignores the CLI handoff | Read `ATLCLI_PUBLICATION_BUNDLE_PATH` and rebuild through the CLI |
| Build inventory is missing | Integration writes somewhere other than the CLI-owned private path | Use `ATLCLI_PUBLICATION_INVENTORY_PATH` as `manifestPath` |
| Public acknowledgement error | `visibility` is `public` | Review the scope and pass `--confirm-public` deliberately |
| Partial acknowledgement error | `completeness` is `allow-partial` | Review reported omissions and pass `--allow-partial` deliberately |
| `different edit-link policy` | `editLink` or `visibility` changed after the last `refresh` | Run `refresh` (or `run`), then build |
| Edit links are configured but no page shows one | The template does not pass `editLink`, or Confluence returned no usable URL and `fallback` is `omit` | Pass `publicationEditLinkV1(...)` in the page template; check `editLinks.includedSourceIds` in the build manifest |
| Chart budget diagnostic | Authored data exceeds an admission/render limit | See the [chart guide](./charts.md); prefer reducing source data over raising limits |

## Related topics

- [Publishing guide](./index.md)
- [Confluence chart support](./charts.md)
- [Operations and rollback](./operations.md)
- [Security and privacy](./security.md)
- [Experience adapter authoring](./adapter-authoring.md)
- [CLI command reference](/reference/cli-commands/)
- [General atlcli configuration](/configuration/)
