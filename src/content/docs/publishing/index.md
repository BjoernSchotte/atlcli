---
title: "Publish Confluence as a static Astro site"
description: "Build a verified, searchable Astro or Starlight site from Confluence page trees"
---

Web publishing creates a versioned build package from Confluence, renders its
normalized `ExportBlock[]` documents through an Astro experience, and stops at
a locally verified static output. Deployment is deliberately a separate
operator or hosting concern.

## On this page

- [When to use web publishing](#when-to-use-web-publishing)
- [Prerequisites](#prerequisites)
- [Quick start](#quick-start)
- [The four-stage lifecycle](#the-four-stage-lifecycle)
- [Choose an experience](#choose-an-experience)
- [Chart rendering](#chart-rendering)
- [Examples](#examples)
- [Boundaries](#boundaries)
- [Troubleshooting](#troubleshooting)

## When to use web publishing

Use this path when a page tree, personal page subtree, or space should become a
public or internal documentation site. The source is acquired once into an
immutable private bundle; repeated builds can reuse that bundle without
re-reading Confluence. A refresh creates a new candidate and activates it only
when completeness and digest checks pass.

This is separate from Markdown sync. Markdown remains the bidirectional editing
surface for `wiki docs pull`, `push`, and `sync`; it is not an intermediate
format in the Astro pipeline.

## Prerequisites

- an authenticated profile with read access to the selected Confluence scope;
- Node `22.12.0` or newer and Bun for the repository scripts;
- an Astro project using Astro `7.1.6` through the supported 7.x range;
- a project file (normally `.atlcli/publish.json`) and a private workspace;
- an explicit acknowledgement when publishing is public or intentionally
  partial.

The first supported experience is Starlight. A plain Astro render-kit consumer
is also supported for projects that own their own page shell.

## Quick start

Create or copy an operator-owned project file, then run the lifecycle from the
repository root:

```bash
atlcli wiki publish plan --project .atlcli/publish.json --profile mayflower
atlcli wiki publish refresh --project .atlcli/publish.json --profile mayflower
atlcli wiki publish build --project .atlcli/publish.json
atlcli wiki publish verify --project .atlcli/publish.json
```

For a deliberate public publication, add `--confirm-public`. For a deliberately
partial result, add `--allow-partial`; a partial bundle is never silently
treated as complete.

The commands write only operator-selected local workspace paths. The `verify`
stage reports `verified`, not `deployed`.

## The four-stage lifecycle

| Stage | What it does | Durable evidence |
| --- | --- | --- |
| `plan` | discovers the graph, computes route changes, and reports issues | `last-plan.json` |
| `refresh` | fetches ADF or Storage, resolves macros/assets, and activates a complete bundle | immutable bundle digest |
| `build` | runs the project-owned Astro build and creates a private inventory | `StaticPublicationManifestV1` |
| `verify` | checks ownership, bytes, links, anchors, CSP, search, SEO, and privacy | build digest and verification summary |

`run` performs the same stages in sequence but does not hide their reports.
`status` shows local stage state and `prune --confirm` removes only verified,
unreachable retained state.

## Choose an experience

### Starlight

`@atlcli/web-publish-starlight` supplies the first supported documentation
experience: responsive navigation, color modes, breadcrumbs, TOC,
previous/next links, related pages, 404 handling, Pagefind search, locale and
RTL support, Expressive Code, SEO metadata, and the publication edit-link slot.
Starlight owns the page chrome; atlcli supplies the document body and graph
data through documented extension points.

The navigation planner owns breadcrumbs, related-page ranking, label landings,
previous/next order, and page-local TOC anchors. The SEO layer owns canonical,
Open Graph, robots, sitemap, hreflang, JSON-LD, and feed controls. Prefetch and
progressive transitions remain experience-owned enhancements and must preserve
the same static route and JavaScript-off behavior.

### Plain Astro

`@atlcli/export-blocks-astro` is the theme-neutral render kit. It accepts only
normalized `ExportBlock[]` plus a trusted render context. It has no Confluence
client, ADF parser, router, search service, or deployment dependency.

See [adapter authoring](./adapter-authoring.md) before adding another experience.

## Chart rendering

Confluence Chart macros are normalized into a source-neutral chart block and
rendered through one shared TanStack scene/SVG adapter. Astro, DOCX, and PDF
therefore use the same geometry rather than maintaining three chart engines.
All twelve supported shapes have static SVG and exact-value table output; the
proven Bar and XY Bar profiles can additionally hydrate an interactive Astro
island without making JavaScript necessary for content or accessibility.

See [Confluence charts across Astro, DOCX, and PDF](./charts.md) for the shape
matrix, configuration, diagnostics, accessibility contract, and current island
boundary.

## Examples

### Publish a page tree internally

```bash
atlcli wiki publish plan --project .atlcli/publish.json --profile mayflower
atlcli wiki publish run --project .atlcli/publish.json --profile mayflower
```

Keep `visibility: "internal"`, use strict completeness, and serve the verified
output behind the organisation's own access control.

### Preview a public candidate without activation

```bash
atlcli wiki publish refresh --project .atlcli/publish.json \
  --profile mayflower --confirm-public --dry-run
```

The plan is printed and persisted, but no candidate is activated.

### Build again from the active package

```bash
atlcli wiki publish build --project .atlcli/publish.json
atlcli wiki publish verify --project .atlcli/publish.json --build <build-digest>
```

No Confluence request is needed for this build/verify pair.

## Boundaries

- V1 consumes `ExportBlock[]`; raw ADF input is a future additive adapter, not
  a shipped Astro API.
- Dynamic macros are resolved and frozen during refresh. There is no request-
  time Confluence access in the static output.
- PWA/service-worker/offline output is deferred to a separate post-build
  augmentation; V1 emits no web-app manifest or service worker.
- Analytics is off by default. Optional Plausible pageviews are pathname-only,
  DNT-aware, non-persistent, and endpoint allowlisted.
- An “Edit in Confluence” action uses only provider-returned, validated
  relations; atlcli never synthesizes an editor URL from an ID or title.

## Troubleshooting

- **Refresh says incomplete:** inspect `last-plan.json`; resolve access/version
  issues or explicitly choose the partial policy.
- **Build says no active bundle:** run `refresh` successfully first.
- **Verify reports an extra file:** remove the unowned output or add it through
  the project-owned, versioned experience contract; do not broaden a glob.
- **Search works without a worker but not with one:** check the narrow
  `wasm-unsafe-eval` CSP directive and that the Pagefind files are present.
- **A macro is visible as unsupported:** see the [renderer and chart guide](./renderers.md);
  visible fallback is intentional and prevents silent content loss.

## Related topics

- [Configuration](./configuration.md)
- [Experience adapter authoring](./adapter-authoring.md)
- [Search and indexing](./search.md)
- [Renderers and charts](./renderers.md)
- [Confluence charts across Astro, DOCX, and PDF](./charts.md)
- [Security and privacy](./security.md)
- [Operations, refresh, and rollback](./operations.md)
- [Troubleshooting](./troubleshooting.md)
- [Confluence DOCX/PDF export](/confluence/export/)
- [Markdown sync](/confluence/sync/)
