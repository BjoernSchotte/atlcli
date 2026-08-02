# Web publishing V1 decision freeze

These decisions close T0. Changes require an explicit plan update and a new
compatibility/security proof.

## Lifecycle and job model

V1 ends at a locally verified `StaticPublicationManifestV1`:

```text
plan -> refresh -> immutable bundle -> Astro build -> Pagefind -> verify
```

Remote deployment is not part of V1. Publish runs are direct serializable
orchestrations with durable immutable bundles, build manifests, and atomic
state transitions. No separate `@atlcli/publish-jobs` package is justified in
V1: there is no evidenced scheduling, multi-worker leasing, or remote recovery
requirement that would outweigh a second job lifecycle. The decision can be
reopened if a real automation host requires resumable cross-process execution.

`@atlcli/export-jobs` remains DOCX/PDF-only and unchanged.

## Policy ownership

| Policy | V1 owner and frozen rule |
| --- | --- |
| Route | project registry owns stable source-ID routes, aliases, tombstones, locale prefix, reserved paths, and collision failure |
| Completeness | strict by default; partial requires explicit configuration and visible diagnostics/noindex policy |
| Active attachments | deny by default; only closed validated static conversions may enter a bundle |
| Macro freshness | freeze dependency provenance and refresh live dependencies independently; stale/failed policy is explicit per renderer |
| Islands | opt-in closed registry; schema-validated frozen JSON only; complete static fallback required |
| Render kit | `ExportBlock[]` plus bounded context; closed overrides selected by trusted build configuration, never source data |
| Styling | semantic data attributes, versioned CSS variables, minimal accessible defaults; project/theme chrome remains outside the render kit |
| Experience | explicit descriptor/capability negotiation; Starlight is first supported adapter, not proof of arbitrary theme compatibility |
| Search | Pagefind 1.5.2 post-build; no hosted backend; private/hidden/action chrome excluded; multilingual facets required |
| SEO | canonical/site/base required for public output; alternates only for routes that exist; sitemap/robots/OG/JSON-LD verified |
| i18n | locale is page data; persisted locale routes and direction; fallback language navigation points to an existing locale landing |
| Media | verified originals or bounded build transforms; vendored fonts; no runtime image service |
| Code | normalized language token, inert source, static escaped fallback; Starlight may use the pinned Expressive Code override |
| Analytics | `none` by default; optional closed Plausible adapter; endpoint origin/path allowlist; sanitized path only; no search terms, referrer, source IDs, custom properties, queue, or replay |
| Confluence action | off unless a provider-returned `edit`/`webui` relation matches the configured provider origin; truthful edit/open label; excluded from search/SEO/ranking |
| Output | owned sibling staging, complete inventory, collision/unexplained-path failure, atomic promotion on one filesystem |
| Workspace | durable cache/bundles/build manifests; ephemeral per-run staging; raw ADF/Storage is not durable by default |
| Retention | manifest reachability plus grace period; no title-, glob-, or mtime-only deletion authority |

## Component boundary

`@atlcli/export-blocks-astro` is Starlight-free. It owns exhaustive semantic
block/inline rendering, static/island dispatch, bounded render context, trusted
override slots, baseline accessibility/styles, and inert unknown fallbacks.

Experiences own route chrome, navigation, breadcrumbs, TOC, previous/next,
related/landing/404 pages, Pagefind, SEO, locale UI, theme tokens, analytics,
provider actions, and deployment-independent build configuration. A Starlight
override may enhance code or paragraphs, but removing it must reveal a complete
neutral fallback rather than remove content.

Charts use a library-neutral normalized chart model. The semantic table and
accessible summary are authoritative; the client island is progressive
enhancement. No third-party chart options/functions enter `ExportBlock[]` or a
publication bundle. `TanStack/charts` is the preferred adapter candidate because
its framework-neutral core, static SVG, SSR/hydration, accessibility, themes,
interaction, and export model fit this boundary. Its current `0.0.2` release is
explicitly pre-alpha, so it is not a frozen production dependency. T6 must
re-run the Astro lane and maturity gate; if the selected release is still not
production-ready, another adapter may be chosen without changing the bundle or
render-model contracts.

## Future raw ADF seam

The V1 public renderer input remains `ExportBlock[]`. A later community package
may add:

```text
ADF -> pure ADF adapter -> ExportBlock[] -> existing Astro render kit
```

That adapter must publish a node/mark/extension support matrix, bounded parser
budgets, explicit media/mention/link/extension resolvers, visible unknown
fallbacks, safe URL rules, and Cloud/DC-independent tests. It is an additive
facade, not an ADF-specific parallel renderer. V1 exports no `AdfDocument`
component and makes no raw-ADF support claim.

## Deferred follow-ups

- installable PWA, service worker, runtime offline navigation/search, update
  orchestration, and cache cleanup;
- remote deployment/CDN/DNS/preview/rollback adapters;
- Astro SSR, server islands, live runtime Confluence access, or runtime secrets;
- direct raw-ADF rendering; and
- incremental Astro output generation (acquisition/normalization only is
  incremental in V1).
