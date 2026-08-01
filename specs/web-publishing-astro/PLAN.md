# Web publishing V1 — immutable publication bundles and Astro 7.1

- Status: **Planned**
- Planning baseline: `cdf11eb7d1f642528b6d8c995ea90ab75fffd77b`
  (`origin/main`, 2026-07-30)
- First builder: Astro `>=7.1.6 <8`
- Delivery shape: independent, plan-only Draft PR
- Estimated size: **XL**; deliver through the gated task DAG below

## 1. Decision summary

Add web publishing as a third product lifecycle beside document export and
Markdown synchronization, but do not model it as another file format:

| Capability | Authority and lifecycle | Result |
| --- | --- | --- |
| DOCX/PDF export | one export request and one staged artifact | one document |
| Markdown sync | editable local Markdown working tree with pull/push state | bidirectional workspace |
| Web publishing | refreshable page graph, immutable site bundle, build and verification | multi-route static site |

The first implementation uses Astro 7.1 to build a static site from typed data.
Astro supports Markdown, but Markdown is not the interchange format of this
pipeline. A custom Astro content loader reads typed, per-page `ExportBlock[]`
documents and verified assets from the versioned publication bundle. Trusted
Astro and Starlight components render those structures directly, using static
output by default and explicitly allowlisted client islands where interaction
adds value.

The block-to-Astro translation is a standalone product boundary, not an
implementation detail of Starlight. V1 therefore provides a Starlight-free
`@atlcli/export-blocks-astro` package whose semantic Astro components consume
the same consumer-neutral `ExportBlock[]` model as DOCX/PDF. The Starlight
experience composes and styles that package but does not own it. This preserves
an additive path to a future pure `ADF -> ExportBlock[]` adapter and direct
`AdfDocument` convenience component if external Astro-community demand warrants
them; neither is required for V1.

V1 is a world-class publishing experience rather than a bare HTML proof. Its
first supported experience is an atlcli adapter for Astro Starlight, with a
stable theme/experience contract that allows further implementations without
claiming arbitrary Astro-catalog compatibility. V1 also requires
Pagefind-powered client-side search, production navigation/SEO/i18n/media/code
quality, optional privacy-respecting analytics, and an optional
provider-validated Confluence edit link. PWA installation, service workers, and
runtime offline caching are deliberately deferred to a later compatibility-
gated follow-up.

The architecture is:

```text
Confluence Cloud ADF / Data Center Storage
  -> existing per-page decoding and macro resolution
  -> per-page ExportBlock[] graph
  -> mutable, disposable PublishingCache
  -> immutable PublicationBundleV1
  -> PublicationBuilderV1
       -> first implementation: Astro integration + content loader
  -> static site candidate + private StaticPublicationManifestV1
  -> verification
  -> future deployment adapter (not in this V1)
```

Acquisition reads the complete selected page bodies and referenced assets. Raw
ADF or Storage XHTML may exist transiently while a page is decoded, but is not
the build-package contract and is not persisted by default. The durable bundle
contains normalized, per-page `ExportBlock[]`, navigation/link metadata, notes,
and verified content-addressed assets. Consequently:

- a bundle can be rebuilt repeatedly without Confluence access;
- a refresh can reuse unchanged normalized pages and assets;
- a failed refresh cannot corrupt the last good bundle;
- Astro never receives Confluence credentials and never calls Confluence;
- Markdown pull/push and Markdown sync remain unchanged;
- DOCX/PDF composition and job schemas remain unchanged; and
- DOCX import PR #61 is unrelated and is neither a dependency nor part of this
  PR.

`wiki publish` is the product namespace. In V1, “publish” means preparing,
building, and verifying a local publication candidate. It must not claim that a
site was remotely deployed. Remote deployment is a later adapter contract.

## 2. Why Astro does not imply Markdown

Astro supports `.astro` components, typed content collections, custom loaders,
and optional client islands in addition to Markdown. This plan uses a custom
build-time loader:

```text
PublicationPageV1
  -> content-collection entry keyed by immutable source ID
  -> trusted component registry keyed by ExportBlock/macro kind
  -> static HTML/CSS and explicitly selected client islands
```

Source content is data. It must never become `.astro`, MDX, JavaScript, a Vite
module, or a user-controlled component import. Astro's normal text/attribute
escaping remains the default; raw `set:html` is not an input API.

### 2.1 Renderer capability levels

Every component renderer declares one of three levels:

1. `static`: build-time HTML/SVG only; the default and required fallback;
2. `island`: statically rendered markup plus an allowlisted client component
   with frozen, validated bundle data; and
3. `live`: request-time or remote-data rendering, explicitly unsupported in
  this static V1.

This makes structured Confluence content more capable than a Markdown
snapshot. Examples:

- a chart macro can become accessible static SVG/HTML;
- an explicitly enabled chart island can add tooltips, filtering, or zoom while
  using only frozen build data;
- Mermaid can become validated static SVG;
- Jira result macros can become a frozen table/card with refresh provenance;
- unknown macros remain visible placeholders with diagnostics.

An island may receive only schema-validated JSON. It must not receive tenant
URLs, credentials, raw ADF/Storage, arbitrary HTML, component names, or code.
The renderer registry is closed and owned by atlcli/the trusted Astro project.
If JavaScript is disabled, the static fallback must still convey the content.

Live charts, request-time Confluence reads, SSR/on-demand rendering, server
islands, and authenticated runtime APIs require a separate server-publishing
design and deployment threat model.

### 2.2 Standalone Astro render-kit boundary

The V1 component library maps the already normalized publication model rather
than implementing a second Confluence decoder:

```text
Cloud ADF ---------> existing pure/source normalization --+
DC Storage XHTML --> existing pure/source normalization --+--> ExportBlock[]
                                                              -> @atlcli/export-blocks-astro
                                                              -> semantic HTML and opt-in islands
                                                              -> Starlight or another experience
```

`@atlcli/export-blocks-astro` owns exhaustive block/inline dispatch, semantic
Astro components, a trusted override map, resolved-link/asset render context,
minimal accessible baseline styles, public CSS custom properties/data
attributes, and block-local static/island behavior. It does not own page
acquisition, Confluence auth/network access, route discovery, navigation shell,
Starlight, Pagefind, SEO, deployment/service-worker/runtime-cache code,
analytics, or edit links.

The public V1 input is `ExportBlock[]`, which is already the shared normalized
model across Cloud/DC and document consumers. A future community adapter may
accept raw ADF and convert supported nodes/marks/extensions to the same model,
with explicit media/mention/extension resolvers and visible unknown fallbacks.
It must be an additive facade over the same component library, not a parallel
ADF-specific renderer. Direct raw-ADF input and its support matrix are deferred
until there is external demand and a separately evidenced contract.

## 3. Product boundary and user journey

### 3.1 Primary journey

The operator owns an Astro project and one publication configuration. A normal
run is intentionally observable:

```bash
atlcli wiki publish plan --config ./atlcli.publish.json
atlcli wiki publish refresh --config ./atlcli.publish.json
atlcli wiki publish build --config ./atlcli.publish.json
atlcli wiki publish verify --config ./atlcli.publish.json
```

`wiki publish run` may orchestrate the four stages after each individual stage
is stable. It returns a build candidate and verification report, not a remote
deployment receipt.

The configuration selects:

- Confluence profile and page/tree/space scope;
- strict or explicitly partial completeness;
- route, macro, asset, active-content, and island policies;
- publication workspace and retention policy;
- Astro project, base path, URL profile, Starlight/theme options, search,
  SEO/i18n/media/code, analytics, edit link, and build script; and
- local output and private manifest locations.

The build command is executed as an executable plus argument vector with
`shell: false`. The default is the Astro project's declared package script.
atlcli does not expose Astro's experimental programmatic `build()` API as a
public contract.

### 3.2 State model

```text
uninitialized
  -> refresh-planned
  -> refresh-staging
  -> bundle-ready
  -> building
  -> built
  -> verified
```

Cancel, crash, validation failure, or build failure returns to the last valid
state. It never activates a partial bundle or mixed output directory. A future
workflow may add digest-bound approval and deployment states; V1 does not.

### 3.3 Workspace layout

The default workspace is durable and configurable, while run staging is
temporary:

```text
.atlcli/publish/<publication-key>/
  project.json
  routes.json
  cache/
    pages/
    assets/
    manifest.json
  bundles/
    <bundle-digest>/
      publication.json
      pages/<safe-page-key>.json
      assets/<sha256>/<safe-name>
  builds/
    <build-digest>/manifest.json
  staging/<run-id>/
  current.json
```

`cache/` is mutable, derived, and safe to rebuild. A bundle directory is
immutable after validation. `current.json` is updated atomically only after the
new bundle is complete. Staging and final promotion must be on the same
filesystem; cross-filesystem rename must not be called atomic.

The Astro build may use an ephemeral working directory, but it reads an
activated immutable bundle. It never reads a half-written cache. Existing
Astro projects must not have handwritten sources or `public/` files overwritten
in place.

## 4. Goals

1. Publish page, tree, and space scopes as a navigable multi-route static site.
2. Reuse the consumer-neutral, per-page `ExportBlock[]` model without a
   Markdown or raw-HTML intermediate.
3. Preserve Cloud ADF and Data Center Storage acquisition policies.
4. Refresh changed source data and assets without refetching every unchanged
   deterministic page.
5. Produce immutable, self-contained, integrity-checked publication bundles
   that support network-disabled builds.
6. Keep source identity stable while allowing pretty, persisted routes.
7. Resolve internal page links, anchors, assets, navigation, breadcrumbs, and
   removals deterministically.
8. Provide a builder-neutral contract and an Astro 7.1 implementation.
9. Ship Starlight as the first supported publishing experience and prove a
   versioned capability, slot, token, component-override, and accessibility
   contract through which further themes can be added.
10. Ship the exhaustive `ExportBlock[] -> Astro` translation as a standalone,
    Starlight-free, public-0.x component package with a plain-Astro consumer.
11. Ship world-class static client-side search in V1, including keyboard-first
    UI, facets, metadata, multilingual indexing, and nested-base support.
12. Ship production information architecture: responsive tree navigation,
    breadcrumbs, page TOC, previous/next, related pages, label landing pages,
    deep-link actions, and a searchable 404 experience.
13. Ship SEO/discovery output: canonical and alternate-language links,
    sitemap, robots policy, OpenGraph/social metadata, JSON-LD, and optional
    RSS/Atom change feeds.
14. Ship locale-aware routes/UI/search plus responsive images, self-hosted
    fonts, technical code presentation, and explicit performance budgets.
15. Support optional privacy-respecting analytics and an optional trusted
    Confluence edit link without making either a publication prerequisite.
16. Support trusted static renderers and opt-in client islands with frozen data.
17. Fail closed on incomplete acquisition, unsafe active content, route/output
    collisions, XSS, SSRF, path traversal, and secret/private-URL leakage.
18. Verify the final static artifact, including Starlight, search, SEO,
    analytics, and edit-link output, not only serializer inputs.
19. Leave DOCX/PDF export, Markdown sync, and DOCX import behavior unchanged.

## 5. Non-goals

- treating HTML, Markdown, MDX, or a ZIP as a new `ExportFormat`;
- composing a tree through `composeChapters()` before site publication;
- adding `html` to `ExportJobRequestV1` or returning a fake single artifact;
- changing Markdown pull/push or bidirectional sync;
- implementing, modifying, or depending on DOCX import PR #61;
- remote deployment, DNS, CDN, preview environments, invalidation, or rollback;
- Astro SSR, on-demand routes, server islands, live Confluence calls, or a
  runtime secrets service;
- executing source-provided Astro/MDX/JavaScript, arbitrary components, CSS, or
  raw HTML;
- generating a new customer Astro project as the only supported integration;
- promising that arbitrary themes from Astro's catalog satisfy the atlcli
  publishing contract without an explicit adapter and conformance proof;
- shipping a direct raw-ADF Astro API in V1; a future pure adapter and
  `AdfDocument` facade remain additive community-driven follow-ups;
- promising incremental Astro output builds: only acquisition/normalization is
  incremental in V1;
- requiring a hosted search service, crawler, account, or runtime backend for
  the V1 search baseline;
- automatic publication-permission inference beyond what Confluence APIs can
  prove;
- accepting arbitrary analytics scripts, arbitrary event payloads, cookies,
  fingerprinting, or unredacted search-query telemetry;
- browser/extension/Forge execution of the Node-only Astro build; and
- calling Astro's server deployment integration an atlcli static builder.
- PWA installation, Web App Manifest generation, service workers, runtime
  offline navigation/search caches, update orchestration, and cache cleanup.

## 6. Code-backed baseline

The planning baseline already has most of the source-side semantic model:

- `packages/confluence/src/export-blocks.ts` defines consumer-neutral blocks
  and never passes raw Storage through as output, but its current package
  ownership would make a standalone Astro renderer depend on the broader
  Confluence surface. V1 must extract or otherwise freeze a dependency-free
  `@atlcli/export-blocks` boundary with compatibility re-exports.
- `ExportPageNode` in `packages/confluence/src/tree-fetch.ts` already carries
  page ID, blocks, notes, parent, depth, position, version, labels, and space
  metadata before document composition.
- `packages/confluence/src/page-body.ts` already owns the host-supplied ADF vs.
  Storage source policy.
- `packages/confluence/src/compose-document.ts` intentionally creates one
  chapterized document and rewrites links to in-document anchors. That is the
  DOCX/PDF boundary, not the publication boundary.
- the current Confluence job resolver exposes combined blocks and metadata-only
  pages; tree/space paths call `composeChapters()`. Publishing needs a
  pre-compose page-graph seam, not a second tree walker or body fetch.
- current export controls know only `pdf|word`; macro targets know only
  `docx|pdf`. Web needs an additive, explicit target.
- `htmlToExportBlocks()` converts untrusted `export_view` input into blocks. It
  is not an output renderer.
- existing link, SVG, asset-policy, and sink-side trust routing provide
  security primitives that publishing must reuse rather than bypass.
- `@atlcli/export-jobs` is deliberately a closed DOCX/PDF request union with
  one staged artifact. Its public V1 schemas stay unchanged.
- the repository's own Starlight/Astro docs site is not a customer publication
  template and must not be imported by the new builder.

Before implementation, Task 0 must re-audit these seams against then-current
`main`. If the page graph no longer exists before composition, source-policy
ownership moved, public job schemas changed, or Astro's stable contracts differ
materially, stop and update this plan before runtime edits.

### 6.1 Astro 7.1 compatibility lane

T0 pins and tests the smallest complete supported stack instead of assuming
that an Astro-adjacent package supports Astro 7. The minimum lane is Node
`22.12.0`, Astro `7.1.6`, `@astrojs/markdown-remark` `7.2.2`, Starlight
`0.41.5`, `@astrojs/mdx` `7.0.5`, `@astrojs/markdown-satteri` `0.3.5`,
`@astrojs/internal-helpers` `0.10.2`,
`@astrojs/sitemap` `3.7.3`, `astro-expressive-code` `0.44.1`, Pagefind and
`@pagefind/default-ui` `1.5.2`, Sharp `0.34.5`, and optional
`@plausible-analytics/tracker` `0.4.5`. The default Pagefind UI is tested only
if the shipped UI consumes it; otherwise atlcli owns the accessible UI against
Pagefind's browser API.

The package manifests support this lane: Astro requires Node `>=22.12.0` and
exactly Markdown `7.2.2`; Starlight peers Astro `^7.0.2` and Markdown `^7.2.0`;
MDX `7.0.5` peers Astro `^7` and depends on Markdown `7.2.2`; and Expressive
Code includes Astro `^7`. The minimum lane pins that coherent cohort instead of
letting Starlight's caret silently cross it. Satteri and internal helpers are
resolved through the exact official Astro `7.1.6`/MDX `7.0.5` lock. Pagefind is
an Astro-independent post-build binary/browser runtime; its CLI and default UI
stay on the same release.
Sitemap, Sharp, and the Plausible browser tracker declare no conflicting Astro
peer. T0 must still prove a clean install and real build because compatible
ranges are necessary evidence, not runtime proof. Latest supported Astro 7 and
Node 24 remain a separate forward lane.

The Bun-based monorepo fixture uses Bun's explicit `hoisted` linker. Astro's
generated prerender entry imports Astro-owned runtime dependencies from the
site output, which is intentionally outside a dependency package's private
scope. This fixture setting must not leak into the public package contract or
force consumers to declare Astro's transitive dependencies themselves.

The automated `MAL-2026-10726` classification of Astro `7.1.0` was withdrawn as
a false positive. T0 nevertheless uses the current official `7.1.6` patch as
its minimum rather than freezing a superseded `.0` release. Dependency
provenance and current advisories remain part of the compatibility gate.

No unnamed third-party Starlight theme or plugin receives a V1 compatibility
claim. New integrations enter only through an explicit allowlist plus the same
minimum/latest build and browser conformance matrix.

## 7. Required invariants

### 7.1 Authority and completeness

- Confluence remains source authority; the publication project stores operator
  intent and stable route decisions; cache and bundle are derived snapshots.
- Only a complete authoritative traversal may prove a page was removed.
- `403`, ambiguous `404`, timeout, cancellation, page/asset budget exhaustion,
  or partial traversal is not deletion evidence.
- `deleted`, `excluded`, `out-of-scope`, and `temporarily-inaccessible` are
  separate states in the refresh plan.
- strict completeness is the default. Partial output requires an explicit
  configuration and produces a visible report/banner policy.
- Astro builds only activated bundles whose manifest says `complete: true`,
  unless the explicit partial policy and warning contract are both present.

### 7.2 Compatibility

- Existing page/tree/space DOCX and PDF fixtures, notes, and artifact bytes do
  not change because publishing was added.
- Existing Markdown sync commands and files do not change.
- Existing export requests, snapshots, stores, and public API reports remain
  byte/schema compatible.
- `composeChapters()` remains the single-document path.
- Cloud ADF and DC Storage both converge on the same web-target block contract.

### 7.3 Determinism and integrity

- Bundle digests exclude volatile timestamps, run IDs, absolute paths, and
  credentials.
- Canonical manifest JSON, page files, and asset bytes are digest-verified
  before activation.
- The same bundle plus builder version, project/config/lockfile digest, and URL
  profile produces the same semantic route/file manifest.
- Byte identity is not claimed for Astro output unless measured; DOM, route,
  link, asset, and normalized file digests are the primary proof.
- The bundle validator rejects unknown required schema versions and dangling
  page, link, route, or asset references.

### 7.4 Ownership and cleanup

- Cache writes, bundle creation, and site builds use private staging roots.
- Final bundle and output promotion are atomic or use an explicit
  backup/rollback protocol.
- Cancellation is propagated through discovery, body reads, macro resolution,
  asset fetching, bundle materialization, child build process, and verification.
- Cleanup is idempotent and can remove only paths owned by the exact project and
  recorded manifest.
- Asset garbage collection uses reachability across active and retained
  bundles/builds plus a grace period; filename globs are not authority.

### 7.5 Security and truthful output

- Source data is never executed as code.
- Text and attributes are escaped; unsafe schemes and active markup fail
  closed; unsupported content remains visible as a placeholder/note.
- All remote acquisition goes through explicit protocol/origin/redirect/private
  network, timeout, byte, MIME, pixel, SVG, and aggregate-budget policy.
- Credentials are never forwarded to external origins.
- HTML, SVG, XML, and other active attachments are rejected by default for
  same-origin publication unless a reviewed isolation policy exists.
- Public output contains no auth refs, raw bodies, private attachment URLs,
  private manifests, absolute workspace paths, or diagnostics with source data.
- A privacy/secret/private-URL scan gates every verified build.
- A static chart island is described as interactive frozen data, never as live.
- Build/verify success is not described as remote deployment success.

## 8. Target ownership and dependency graph

### 8.1 Packages

`@atlcli/export-blocks` becomes the public, fully isomorphic semantic model:

- `ExportBlock`, inline, note, link, asset-reference, caption, normalized macro,
  and chart-model types plus their versioned runtime schemas;
- pure exhaustive visitors and validation helpers only;
- no Confluence client, ADF/Storage parser, Astro, Node, auth, or renderer; and
- compatibility re-exports from `@atlcli/confluence` so extraction does not
  break existing DOCX/PDF/browser consumers in the same change.

Task 0 must validate the extraction against the then-current dependency graph.
If a physical package split would destabilize existing consumers, freeze the
same dependency-free public boundary first and migrate imports incrementally;
`@atlcli/export-blocks-astro` must never need the Confluence client surface.

`@atlcli/web-publish` is the public, mostly isomorphic core:

- versioned project, refresh-plan, bundle, page, route, link, asset, renderer,
  experience/theme, search, SEO, analytics, edit-link, build, manifest, report,
  and issue contracts;
- route registry and diff planning;
- canonical digest and bundle validation;
- link/anchor/output-path planning;
- closed renderer descriptors and safe semantic render helpers;
- browser-safe default entry point;
- a Node subpath for bounded filesystem bundle/cache stores.

`@atlcli/export-blocks-astro` is Astro-native, Starlight-free, and public-0.x:

- exhaustive `ExportDocument.astro`/block/inline components over
  `@atlcli/export-blocks` plus a trusted build-selected override registry;
- semantic static HTML, block-local opt-in islands, visible unknown fallbacks,
  resolved link/asset context, and diagnostics propagation;
- minimal accessible baseline styles and versioned CSS custom properties,
  semantic slots, and `data-*` styling hooks;
- named component, document, style, island, schema/type, and test-fixture
  exports suitable for a plain Astro consumer;
- peer dependency `astro >=7.1.6 <8`; and
- no Starlight, Confluence, authentication, acquisition, route/site shell,
  Pagefind, SEO, deployment/service-worker/runtime-cache code, analytics,
  edit-link, Node filesystem, or network code.

`@atlcli/web-publish-astro` is Node-only and public-0.x:

- default Astro integration factory;
- named build-time content loader;
- trusted publication routes, layout/experience ports, asset staging, and
  consumption of `@atlcli/export-blocks-astro`;
- a theme/experience contract and non-shipped plain-Astro conformance
  experience for future implementations;
- a post-build Pagefind indexer plus theme-neutral accessible search components;
- sitemap/SEO/i18n/media/font/code capabilities;
- optional analytics and Confluence edit-link components; and
- Astro config/route/build/search hooks and output manifest production;
- peer dependency `astro >=7.1.6 <8`, Node `>=22.12.0`;
- no embedded second Astro and no private Astro/Vite API contract.

`@atlcli/web-publish-starlight` is the first public-0.x experience adapter:

- the supported Starlight descriptor and compatibility range;
- page shell, sidebar/navigation, breadcrumbs, page TOC, previous/next,
  landing/related/404 views, search/action slots, and theme-mode integration;
- mapping from Starlight tokens and documented component/plugin overrides to
  the stable `@atlcli/export-blocks-astro` token/slot/override contract;
- optional experience-owned placement of analytics and Confluence actions; and
- no duplicate ExportBlock dispatch, ADF/Storage conversion, Confluence client,
  authentication, build execution, output ownership, service-worker, or runtime
  cache authority.

`@atlcli/publish-jobs` is added only if Task 0 proves durable background jobs
are required for V1. It must be a separate request/snapshot/result family and
must not widen export jobs. Otherwise V1 keeps serializable
`PublishRunRequestV1`/reports in `@atlcli/web-publish` and a direct CLI
lifecycle, and durable scheduling becomes a follow-up spec.

Host wiring remains close to authentication and I/O:

- `@atlcli/export-wiring` exposes or is refactored to share the pre-compose
  Confluence graph and trust-routing primitives;
- `@atlcli/export-node` supplies Node asset/filesystem/process ports where
  ownership is already appropriate;
- `apps/cli` owns profiles, user confirmation, process signals, command output,
  and the local operator journey.

### 8.2 Allowed dependency direction

```text
@atlcli/export-blocks
  ├──> @atlcli/confluence / @atlcli/export-macros
  ├──> @atlcli/web-publish
  └──> @atlcli/export-blocks-astro ───────────────> Astro peer
             ├──> @atlcli/web-publish-astro ──────> Astro/Node peers
             └──> @atlcli/web-publish-starlight ──> Astro/Starlight peers

web-publish + web-publish-astro + selected experience
  <── export-wiring / export-node ports <── CLI
```

Forbidden edges:

- web-publish core -> Astro, Node built-ins, CLI, Forge, extension, React, Vite;
- export-blocks core -> Confluence, Astro, Starlight, Node, or host code;
- export-blocks-astro -> Starlight, Confluence/auth/network, publication loader,
  routes, Pagefind, deployment/service-worker/runtime-cache code, analytics, or
  edit-link ownership;
- Starlight adapter -> ADF/Storage parsing, duplicate ExportBlock dispatch,
  Confluence auth/network, build execution, or output/cache ownership;
- Confluence content -> generated source/module/component imports;
- Astro loader -> Confluence client/auth or network acquisition;
- Markdown sync -> publication bundle as its new authority;
- DOCX/PDF jobs -> web site builder or deployment semantics; and
- repository docs Astro config/theme -> customer publication output.

## 9. Normative contracts

Names may be adjusted during Task 0, but semantics and schema separation are
required.

### 9.1 Project and request

```ts
interface PublicationProjectV1 {
  schema: "atlcli.publication-project/1";
  publicationKey: string;
  source: PublicationScopeV1; // page | tree | space
  sourcePolicy: PublicationSourcePolicyV1;
  completeness: "strict" | "allow-partial";
  visibility: "internal" | "public";
  routes: PublicationRoutePolicyV1;
  macros: PublicationMacroPolicyV1;
  assets: PublicationAssetPolicyV1;
  renderers: PublicationRendererPolicyV1;
  experience: PublicationExperienceSelectionV1;
  search: PublicationSearchOptionsV1;
  seo: PublicationSeoOptionsV1;
  i18n: PublicationI18nOptionsV1;
  media: PublicationMediaOptionsV1;
  analytics: PublicationAnalyticsOptionsV1;
  editLink: PublicationEditLinkOptionsV1;
  builder: AstroPublicationBuilderOptionsV1;
  retention: PublicationRetentionPolicyV1;
  activeBundleDigest?: string;
}

interface PublishRunRequestV1 {
  schema: "atlcli.publish-run-request/1";
  projectRef: string;
  operation: "plan" | "refresh" | "build" | "verify" | "run";
  expectedActiveBundleDigest?: string;
  dryRun: boolean;
}
```

Credentials and destination authority are opaque host refs, never embedded
tokens. A public-visibility configuration requires an explicit operator choice;
atlcli must not infer that every page visible to the profile is safe to publish.

### 9.2 Refresh plan and cache key

```ts
interface PublicationRefreshPlanV1 {
  schema: "atlcli.publication-refresh-plan/1";
  previousBundleDigest?: string;
  sourceSnapshot: PublicationSourceSnapshotV1;
  changes: readonly PublicationChangeV1[];
  complete: boolean;
  issues: readonly PublicationIssueV1[];
  planDigest: string;
}
```

Changes distinguish `add`, `content-change`, `metadata-change`, `move`,
`route-change`, `asset-change`, `exclude`, `inaccessible`, and
`confirmed-delete`. Any destructive output difference is visible before
activation.

A page cache key includes at least:

```text
pageId + pageVersion + sourceRepresentation + sourcePolicyDigest
+ decoder/model schema versions + macro catalog/web-target versions
+ macro policy/dynamic dependency freshness + asset metadata versions
+ route/link policy digest
```

Page version alone is insufficient: attachment versions and live macro data can
change independently. Until renderers provide dependency fingerprints, pages
with live dependencies are re-resolved on every refresh; deterministic pages
may reuse cached normalized blocks.

Navigation, breadcrumbs, child lists, table-of-contents, sitemap, and link-graph
dependencies are invalidated when their inputs change even if a page body did
not.

### 9.3 Route registry

The mutable project-owned route registry is the authority for stable public
paths:

```ts
interface PublicationRouteRecordV1 {
  sourceId: string;
  route: string;
  state: "active" | "tombstone";
  assignedBy: "generated" | "operator";
  previousRoutes: readonly string[];
}
```

V1 defaults to a stable pretty route assigned on first inclusion. Renames and
moves retain it. Explicit operator route changes are shown in the refresh plan.
Collisions receive a deterministic safe suffix and are never silently
overwritten. Route, case-folded route, and final output-path collisions all fail
before build.

Tombstones retain identity so a removed and later restored page does not steal
another page's route. Static output may report redirect candidates, but cannot
promise HTTP 301/302 behavior without a deployment provider.

### 9.4 Immutable bundle

```ts
interface PublicationBundleV1 {
  schema: "atlcli.publication-bundle/1";
  bundleDigest: string;
  createdBy: { name: "atlcli"; version: string };
  sourceSnapshot: PublicationSourceSnapshotV1;
  sourcePolicyDigest: string;
  complete: boolean;
  rootIds: readonly string[];
  pages: readonly PublicationPageEntryV1[];
  routes: readonly PublicationRouteRecordV1[];
  assets: readonly PublicationAssetEntryV1[];
  issues: readonly PublicationIssueV1[];
}

interface PublicationPageV1 {
  schema: "atlcli.publication-page/1";
  sourceId: string;
  sourceVersion: string;
  title: string;
  parentId?: string;
  position: number;
  depth: number;
  route: string;
  blocks: readonly ExportBlock[];
  notes: readonly ExportNote[];
  labels: readonly string[];
  links: readonly PublicationLinkReferenceV1[];
  assetIds: readonly string[];
  renderDependencies: readonly PublicationDependencyV1[];
  pageDigest: string;
}

interface PublicationAssetEntryV1 {
  assetId: string;
  path: string;
  sha256: string;
  byteLength: number;
  mediaType: string;
  disposition: "inline" | "download" | "blocked-active-content";
  downloadName?: string; // safe logical download filename, independent of path
}
```

The manifest references page files and asset bytes by digest. Public bundle
serialization omits raw ADF/Storage, credentials, request headers, signed URLs,
absolute paths, and sensitive origin details.

Internal page and asset references remain typed bundle references until the
builder applies `base`, URL style, and output mapping. No unresolved internal
reference or private Confluence URL may leak into built HTML.

### 9.5 Renderer registry

```ts
interface PublicationRendererDescriptorV1 {
  id: string;
  version: string;
  handles: readonly PublicationRenderableKindV1[];
  capability: "static" | "island";
  dataSchema: string;
  deterministic: boolean;
  externalRuntimeData: false;
}
```

Renderer selection is allowlist-based and participates in bundle/build
digests. Every island has a static fallback, explicit byte/row/node budgets,
and accessibility tests. Unknown or disabled renderers yield a safe visible
fallback and note.

The first chart renderer accepts only a normalized chart model, not raw macro
parameters. Static SVG/HTML is required. The optional island consumes the same
frozen model; it may add interaction but no network/auth code. Chart capability
must be tested with JavaScript both enabled and disabled.

TanStack Charts is the preferred V1 island adapter because its portable chart
model and expected ecosystem momentum fit this boundary. The product owner
explicitly accepts its current pre-alpha status for the bounded, opt-in
bar-chart island: the package version is pinned, the adapter is replaceable,
and the T6 spike must prove SSR fallback, hydration, keyboard accessibility,
no client error, and an external runtime bundle no larger than 100 KiB. This
exception does not claim a stable TanStack API or permit weakening
accessibility, security, determinism, or bundle budgets.

#### 9.5.1 Astro component-library contract

The default `@atlcli/export-blocks-astro` entry renders a document without a
publication project or Starlight installation:

```astro
---
import ExportDocument from "@atlcli/export-blocks-astro/document";
---

<ExportDocument blocks={blocks} context={renderContext} />
```

Its conceptual props are versioned and contain only resolved, render-safe data:

```ts
interface AstroExportDocumentPropsV1 {
  blocks: readonly ExportBlock[];
  context: AstroExportBlockRenderContextV1;
  overrides?: AstroExportBlockOverridesV1;
}

interface AstroExportBlockRenderContextV1 {
  locale: string;
  direction: "ltr" | "rtl";
  headings: Readonly<Record<string, ResolvedHeadingV1>>;
  links: Readonly<Record<string, ResolvedPublicationLinkV1>>;
  assets: Readonly<Record<string, ResolvedPublicationAssetV1>>;
  notes: "inline" | "collect" | "omit-noncritical";
}
```

The package exports the exhaustive document dispatcher and named semantic
components so a plain Astro project may compose or override individual block
kinds. Overrides are trusted installed modules selected by project/build
configuration; source content can never name a component or module. The base
components must remain complete and accessible without an experience adapter.

The stable styling contract is semantic HTML, declared slots, versioned CSS
custom properties, and documented `data-atlcli-*` hooks. Generated class names,
Starlight DOM/CSS, and full HTML whitespace are not compatibility contracts.
Starlight may map its tokens and replace a block renderer through the trusted
override map, but it must not fork dispatch or change link/asset/security
semantics.

V1 does not export `AdfDocument`. A later `@atlcli/adf-export-blocks` package or
`/adf` facade may add pure ADF normalization and an `AdfDocument` convenience
component over this exact renderer. It must declare node/mark/extension
coverage, accept explicit media/mention/extension resolvers, preserve visible
unknown fallbacks, perform no implicit authenticated fetch, and introduce no
second ADF-specific Astro component tree.

### 9.6 Builder port and Astro options

```ts
interface PublicationBuilderV1 {
  readonly id: string;
  readonly version: string;
  build(request: PublicationBuildRequestV1): Promise<PublicationBuildResultV1>;
}

interface AstroPublicationBuilderOptionsV1 {
  builder: "astro-static";
  projectDir: string;
  integrationOptions: AstroAtlcliIntegrationOptionsV1;
  outputProfile: "directory" | "portable-file";
  base: string;
  site?: string;
  buildCommand: readonly [string, ...string[]];
}
```

For `directory`, Astro uses `output: "static"`, `build.format: "directory"`,
and `trailingSlash: "always"`. For `portable-file`, it uses
`build.format: "file"` and `trailingSlash: "never"`. `base` participates in all
internal URLs and in the build key. Production canonical/sitemap support
requires `site`.

`@atlcli/web-publish-astro` exports:

- default `atlcliPublishingIntegration(options)` for `astro add` compatibility;
- named `atlcliPublicationLoader(options)`;
- builder/integration options and bundle-facing loader types, while referring
  semantic component consumers to `@atlcli/export-blocks-astro`; and
- no programmatic Astro runner in its public API.

The loader uses immutable source ID as collection entry ID and route as data.
It calls Astro's schema-validation path, reconciles deleted store entries, and
records the active bundle revision in loader metadata. It loads structured
blocks, not Markdown. Astro Markdown rendering and `deferRender` therefore are
not part of V1's content contract.

The integration uses only documented hooks:

- `astro:config:done` validates/captures static output, base, site, URL format,
  public/output directories;
- `astro:routes:resolved` proves every publication route is prerendered and
  detects collisions with handwritten routes; and
- `astro:build:done` inventories built pages/assets and writes the private
  manifest outside the public output root.

It may use `astro:config:setup` only for a documented route/virtual-module,
experience, search, or asset plugin. It must not depend on Astro/Vite private
internals.

### 9.7 Experience and search contracts

Publishing experiences/themes are trusted installed code selected by the
operator, never by source content. Astro Starlight is the first concrete V1
implementation; the contract stays neutral enough for later adapters:

```ts
interface PublicationExperienceDescriptorV1 {
  schema: "atlcli.publication-experience/1";
  id: string;
  version: string;
  engine: "astro";
  capabilities: readonly PublicationExperienceCapabilityV1[];
  slots: readonly PublicationExperienceSlotV1[];
  designTokensSchema: string;
  components: PublicationExperienceComponentsV1;
}

type PublicationExperienceCapabilityV1 =
  | "responsive-navigation"
  | "light-dark-system"
  | "search-modal"
  | "search-page"
  | "faceted-search"
  | "table-of-contents"
  | "breadcrumbs"
  | "previous-next"
  | "chart-islands"
  | "i18n"
  | "print-styles"
  | "seo"
  | "analytics-slot"
  | "edit-link";
```

V1 ships one supported atlcli Starlight experience. Starlight is an Astro
documentation integration rather than a generic swappable skin, so the adapter
owns the translation between publication contracts and Starlight's navigation,
page shell, overrides, Pagefind, i18n, SEO, Expressive Code, and theme modes. It
consumes the complete `@atlcli/export-blocks-astro` render kit and may provide
trusted presentation overrides, but owns neither ExportBlock dispatch nor the
base semantic components.
One deliberately small non-shipped test experience implements the same
descriptor to prove that the contract is not Starlight-private. Adding a second
production theme is a later adapter, not a V1 shipping requirement.

An experience owns presentation but may not change source, route, search,
security, completeness, analytics, edit-link, deployment, service-worker, or
runtime-cache ownership semantics.

The stable customization surface is semantic slots, design tokens, and closed
component overrides, not selectors into generated DOM. Required slots cover
document head, header, primary navigation, left navigation, breadcrumbs,
search trigger/modal, main content, page TOC, previous/next, footer, and
renderer/island styling. Starlight must provide responsive behavior,
keyboard/focus states, reduced-motion behavior, usable print styles, and
light/dark/system color modes. Future experiences must declare and satisfy the
same capabilities they expose.

V1 search is static and local-first, with Pagefind as the pinned first provider:

```ts
interface PublicationSearchOptionsV1 {
  provider: "pagefind";
  enabled: true;
  languages: "from-pages" | readonly string[];
  filters: readonly ("space" | "label" | "content-type" | "language")[];
  metadata: readonly ("title" | "description" | "breadcrumbs" | "image")[];
  ranking: PublicationSearchRankingV1;
  ui: "modal" | "page" | "both";
  shortcut: "mod+k" | "/" | "none";
}
```

Pagefind runs after the complete Astro static build and writes a fully static
index into the owned output tree. It has no server component. Generated pages
mark only canonical content with `data-pagefind-body`; navigation, duplicate
chrome, hidden diagnostics, and private metadata are excluded. Labels, space,
content type, and language are allowlisted facets. Title, description,
breadcrumbs, and optional safe image references are explicit result metadata.

The search UI is lazy-loaded, base-aware, themeable through the search slots,
usable with keyboard and screen readers, and multilingual. Search is fully
static and requires no hosted search backend; no runtime-offline guarantee is
claimed. It uses Pagefind's worker path when available with a tested main-thread
fallback. Result URLs must use the same route/output profile as the site.
Search excerpts are treated as untrusted presentation data:
themes either use plain excerpts and their own escaped highlighting or a narrow
reviewed `<mark>` sanitizer; arbitrary excerpt HTML never reaches `set:html`.

The indexer version/config, indexed page set, filters, language partitions,
index file hashes, total compressed/uncompressed bytes, and search manifest
digest participate in build verification. V1 rebuilds the complete search index
after each site build and makes no incremental-index claim. Deleted, excluded,
partial, private, redirect-only, and non-canonical pages must not remain
searchable.

The provider contract may allow later Algolia/Typesense adapters, but V1 does
not require a hosted provider, account, network crawler, or runtime secret.

### 9.8 Information architecture, SEO, i18n, media, and code

The Starlight experience implements the complete V1 information architecture
from the page graph rather than rediscovering it from rendered HTML:

- responsive hierarchical sidebar with active/expanded state;
- breadcrumbs, page-local heading TOC, and stable deep-link/copy-link actions;
- deterministic previous/next within configured navigation order;
- deterministic related pages derived from explicit links, shared labels, and
  hierarchy, with explainable ranking and no network/AI dependency;
- label/topic landing pages and space/root landing pages; and
- a useful 404 page with Pagefind search and top-level navigation.

```ts
interface PublicationSeoOptionsV1 {
  sitemap: true;
  robots: "index" | "noindex";
  canonical: true;
  structuredData: readonly ("WebSite" | "TechArticle" | "BreadcrumbList")[];
  socialCards: "metadata-only" | "generated";
  feed: "disabled" | "rss" | "atom";
}

interface PublicationI18nOptionsV1 {
  defaultLocale: string;
  locales: readonly string[];
  routeMode: "prefix-all" | "hide-default";
  fallback: Readonly<Record<string, string>>;
  uiTranslations: "starlight" | Readonly<Record<string, string>>;
}

interface PublicationMediaOptionsV1 {
  images: "verified-original" | "astro-responsive";
  formats: readonly ("original" | "avif" | "webp")[];
  fonts: "system" | "vendored-local";
  imageZoom: boolean;
  code: "expressive-code";
}
```

Production `site` is required when canonical URLs, sitemap, feeds, or generated
social cards are enabled. Public/indexable builds emit canonical URLs,
alternate-language links, sitemap, intentional robots policy, OpenGraph/social
metadata, and allowlisted JSON-LD. Internal or explicit `noindex` builds do not
accidentally advertise tenant-derived routes. Feed entries use only canonical
public metadata and sanitized summaries; publication timestamps and source
revision timestamps remain distinct.

Locale is explicit page/config metadata, never guessed from arbitrary text.
Astro i18n route helpers and Pagefind language partitions consume the same
locale map. Each page emits correct `lang` and `dir`; locale fallback and
untranslated-page behavior are visible and tested. Route, `base`, format,
canonical, alternate, sitemap, feed, and search URLs share one URL planner.

The responsive image mode uses Astro's stable image pipeline only for verified
safe image inputs and preserves a direct original/download path. Dimensions,
alt text, lazy/eager policy, formats, variants, and transformation budgets are
manifested. Fonts are system fonts or vendored local bytes; a network-disabled
build must not contact a font provider. Theme font/image choices participate in
the build digest and performance budgets.

Expressive Code is the V1 code presentation for the Starlight experience:
copy, wrap, language label, optional filename/caption, line highlighting, and
theme-aware output are supported from a normalized code model. Source content
cannot inject Expressive Code configuration, plugins, CSS, or executable HTML.

### 9.9 Deferred installable PWA/offline runtime

V1 ends at a verified `Astro -> Pagefind -> StaticPublicationManifestV1`
artifact. It ships no Web App Manifest, service worker,
`@vite-pwa/astro`/Workbox dependency, install/update/cache policy, or runtime
offline-navigation/search guarantee. In particular, the V1 project schema,
experience capability set, and static manifest contain no provisional PWA
contract.

A separate follow-up may consume the immutable verified V1 manifest through a
versioned post-build augmentation boundary, reserve collision-safe owned paths
through the existing route/output registry, and emit a new digest-bound
superset manifest. That follow-up must independently select an Astro-compatible
toolchain and prove final-Pagefind ordering, scope/base behavior, bounded
precaching, update/rollback, quota and multi-tab behavior, privacy exclusions,
and unregister/cleanup. The current `@vite-pwa/astro` `1.2.0` peer range ends at
Astro 5, which is direct evidence not to freeze it into the Astro 7 V1 lane.

### 9.10 Analytics and Confluence edit-link contracts

Analytics is optional and disabled by default:

```ts
type PublicationAnalyticsOptionsV1 =
  | { provider: "none" }
  | {
      provider: "plausible";
      endpoint: string;
      siteDomain: string;
      pageviews: true;
      events: readonly ("outbound-link" | "download" | "search-open")[];
      respectDoNotTrack: true;
      searchTerms: false;
    };
```

Plausible is the first optional provider because it supports cookie-free client
analytics and self-hosted/custom endpoints. Enabled builds bundle the exact
`@plausible-analytics/tracker` implementation rather than synthesizing a remote
script tag; only the validated event endpoint needs a CSP `connect-src`
allowance. “Privacy-respecting” is a bounded technical configuration, not a
legal-compliance claim: the operator remains responsible for deployment
jurisdiction, notices, server logs, and local law.

The adapter accepts only a closed event allowlist and data schema. It strips
query/fragment values, source IDs, Confluence URLs, page titles, user/account
data, and arbitrary event properties. Search terms are never collected in V1;
analytics events are never queued for persistent storage or later replay. The
site remains fully functional when the endpoint is blocked. External origins
participate in CSP/privacy reports and must be explicitly allowlisted.

The edit link is also optional and disabled by default, especially for public
sites:

```ts
type PublicationEditLinkOptionsV1 =
  | { provider: "none" }
  | {
      provider: "confluence";
      label: string;
      placement: "page-footer" | "page-actions";
      visibility: "internal" | "all";
      fallback: "open-page" | "omit";
    };
```

Cloud uses the provider-returned `_links.editui`; Data Center uses its returned
edit relation. The source adapter resolves the link against the trusted
tenant/base URL, rejects cross-origin/unsafe targets, and records only the
operator-approved action link. It must not synthesize undocumented editor URLs.
If the edit relation is absent or unsafe, policy either falls back to the
validated page `webui` link with truthful “Open in Confluence” copy or omits the
action and reports a note.

The Starlight adapter threads the validated per-page URL through the documented
route-data `editUrl` field and, when custom placement/copy is required, a
documented `EditLink` component override. Starlight's repository-oriented
`editLink.baseUrl` concatenation is not used because a Confluence relation is
provider-returned per-page authority, not a content-file path.

Edit links are excluded from Pagefind, related-page ranking, sitemap/feed/JSON-
LD, deployment/runtime-cache metadata, and analytics payloads. The UI must
distinguish leaving the published site, and public enablement requires an
explicit tenant-disclosure acknowledgement.

### 9.11 Static publication manifest

```ts
interface StaticPublicationManifestV1 {
  schema: "atlcli.static-publication-manifest/1";
  bundleDigest: string;
  builder: { id: "astro-static"; version: string; astroVersion: string };
  projectDigest: string;
  configDigest: string;
  lockfileDigest: string;
  base: string;
  outputProfile: "directory" | "portable-file";
  pages: readonly BuiltPageV1[];
  assets: readonly BuiltAssetV1[];
  experience: { id: string; version: string; digest: string };
  search: BuiltSearchIndexV1;
  seo: BuiltSeoArtifactsV1;
  analytics: BuiltAnalyticsDeclarationV1;
  editLinks: BuiltEditLinkSummaryV1;
  removedOwnedPaths: readonly string[];
  verification: PublicationVerificationSummaryV1;
  buildDigest: string;
}
```

This is a private sidecar and future deployment input, not a file copied into
the public web root. Only paths recorded as owned by a preceding manifest may
later be deleted remotely.

## 10. Acquisition, links, macros, and assets

### 10.1 Pre-compose page graph

Extract `resolveConfluencePageGraphV1()` before `composeChapters()`. Existing
DOCX/PDF resolution becomes a compatibility wrapper over the same graph.
Publishing consumes page/folder order, parent/depth, individual blocks/notes,
completeness, and source summary from one discovery/body-fetch pass.

Do not introduce a second crawler. Checkpoint/body-spool concepts may inform
cache implementation, but the current export spool is job recovery rather than
a cross-build publication cache and is not reused as hidden authority.

### 10.2 Page and anchor links

Extract the current page-ID/title/space link truth table from document
composition into a shared pure resolver. Publishing resolves `contentId`
first, then safe unambiguous fallbacks. It builds the complete route and anchor
maps before rendering any page.

- in-scope links become typed page+fragment references;
- out-of-scope links become a policy-approved canonical Confluence URL or a
  visible unresolved link/note;
- unsafe/ambiguous links fail closed;
- headings receive stable, deduplicated page-local anchors;
- builder-specific base and `.html`/directory URL mapping happens last.

### 10.3 Web macro target

Add `web` additively to export-control and macro target contracts. Existing
`word|pdf` and `docx|pdf` truth tables remain unchanged. Web-specific controls
match `web`; Word/PDF-only values are mismatches unless Task 0 proves and tests
official aliases.

Resolve macros per page with correct page identity and page-local TOC scope.
Pure macros remain cacheable. Live macros are refreshed according to explicit
freshness policy and record frozen provenance. `export_view` remains an
untrusted input conversion path; its raw HTML is never emitted.

### 10.4 Assets

Default output is self-contained. Acquisition resolves attachment/external
references through current trust routing, validates content, and writes
content-addressed bytes. Duplicate bytes are stored once even when filenames
differ; each logical asset retains its own safe `downloadName` for generated
download links.

The Astro integration emits or stages assets without mutating the user's
handwritten `public/` tree. Arbitrary downloads preserve bytes. V1 defaults to
copying verified originals and also supports an explicit bounded
`astro-responsive` mode; neither mode may require runtime `/_image` URLs.

Missing or blocked assets produce a deterministic placeholder and issue.
Whether that blocks a strict publication depends on issue severity and policy;
it is never silently omitted.

## 11. Astro integration behavior

The existing Astro project remains owner of installed theme packages, approved
design-token values, project chrome, and handwritten routes. The atlcli
packages contribute distinct layers:

- `@atlcli/export-blocks-astro` contributes the closed semantic content
  registry, exhaustive components, baseline styles, and block-local islands;
- `@atlcli/web-publish-astro` contributes the configurable route prefix,
  `getStaticPaths()` route, bundle-backed collection entries, asset/output
  integration, Pagefind post-build stage, and private manifest; and
- `@atlcli/web-publish-starlight` contributes the supported page experience,
  generated information architecture, Starlight token/override mapping,
  SEO/i18n/media/code presentation, search/actions placement, and optional
  analytics/edit-link slots.

Experience selection is project configuration. Confluence pages and macro data
cannot choose packages, component imports, arbitrary CSS, or scripts. Replacing
the Starlight adapter with a future conforming experience must not change
canonical routes, page identity, indexed content, link targets, completeness,
or asset trust. Experience ID/version/config and generated CSS/JS participate
in the build digest.

The Pagefind baseline is required in the Starlight V1 experience. A future
experience must implement the declared search trigger/modal/page slots or fail
capability validation before build; silently losing search is not allowed.

The integration rejects rather than silently rewrites incompatible
configuration: server output, non-prerendered publication routes, base/profile
contradictions, handwritten route collisions, or overlapping owned asset
paths.

The first real build matrix is:

| Case | `base` | format | required result |
| --- | --- | --- | --- |
| normal static host | `/` | directory/always | `/guide/index.html` |
| nested static host | `/docs` | directory/always | base-aware links/assets |
| portable file host | `/docs` | file/never | `/guide.html` and matching links |

Every case is built with the Starlight experience and search enabled. A small
non-shipped conformance experience proves that route, content, search,
security, and manifest contracts are not Starlight-private. The matrix also
covers multilingual pages, label/space facets, keyboard navigation, deep-link
result URLs, deleted-page removal, optional analytics/edit-link modes, blocked
external-network requests, and JavaScript-disabled graceful degradation to
normal site navigation.

Before the Starlight matrix, a packed plain-Astro consumer imports only
`@atlcli/export-blocks-astro`, renders the all-fields fixture, applies one
trusted component override and custom-token set, and proves that no Starlight,
Confluence, publication builder, auth, network, Pagefind, deployment,
service-worker, or runtime-cache dependency is required for semantic block
rendering.

Astro's static redirect output cannot promise HTTP redirect status codes.
Redirect candidates stay in the private manifest for a future deployment
provider.

## 12. Capability and evidence matrix

| Capability | V1 target | Required evidence |
| --- | --- | --- |
| Cloud page/tree/space | supported | fixtures + live Cloud E2E |
| DC page/tree/space | supported contract | Storage fixtures + live DC E2E before claim |
| per-page blocks/navigation | supported | graph and artifact proof |
| Markdown intermediate | unsupported by design | absence/dependency proof |
| attachments/images | self-contained default | bytes/digest/artifact crawl |
| internal links/anchors | supported | collision/link crawler matrix |
| web export controls | supported | target truth-table regression |
| pure macros | supported | per-page fixture matrix |
| live macros | frozen at refresh | live/no-live and freshness proof |
| unknown macros | visible fallback | artifact and diagnostics proof |
| static chart | supported | SVG/HTML visual/a11y proof |
| interactive chart island | opt-in V1 target | JS-on/off, CSP, payload proof |
| live/request-time chart | deferred | explicitly unsupported |
| standalone ExportBlock Astro render kit | required V1 package | packed plain-Astro consumer + dependency/fixture proof |
| direct raw-ADF Astro input | additive future adapter | deferred; no V1 `AdfDocument` claim |
| Starlight experience | required V1 baseline | packed artifact/a11y/visual proof |
| future experience adapters | supported contract | non-shipped capability/slot/negative conformance fixture |
| light/dark/system + responsive | V1 experience requirement | keyboard/mobile/contrast proof |
| Pagefind client search | required V1 baseline | production index + browser E2E |
| search facets/metadata | label/space/type/language | result/facet correctness proof |
| multilingual search | supported | language-partition/stemming/UI proof |
| navigation/TOC/related/404 | required V1 baseline | route graph + browser/a11y proof |
| SEO/sitemap/social/structured data | required for public builds | artifact-schema/link proof |
| i18n/locale routing | supported V1 baseline | locale/RTL/hreflang/search proof |
| responsive images/local fonts | supported and remote-runtime-free | transform/inventory/network proof |
| Expressive Code | required Starlight code renderer | hostile-input/a11y/visual proof |
| PWA/installable offline runtime | deferred follow-up | no V1 capability or artifact claim |
| privacy-respecting analytics | optional, off by default | allowlist/redaction/blocked-network proof |
| Confluence edit link | optional, off by default | Cloud/DC relation/origin/exclusion proof |
| hosted search provider | optional future adapter | deferred, not required |
| local static build | supported | packed Astro production build |
| remote deployment | deferred | no shipped claim |
| browser core | supported | browser package gate |
| Astro build in browser/Forge/MV3 | unsupported | negative dependency proof |

Evidence labels are kept precise: `code-backed baseline`, `planned contract`,
`fixture-proven`, `real Astro artifact-proven`, `live Cloud-proven`, `live
DC-proven`, `unsupported`, and `deferred`. A network-disabled Astro build does
not prove Cloud/DC acquisition or deployment.

## 13. Implementation DAG

```text
T0 Contract/security/Astro spike
├── T1 Pre-compose page graph
├── T2 Core publication contracts, routes and cache
├── T3 Web target and per-page macros
└── T4 Astro 7.1 loader/integration spike
T1 + T2 + T3 ──> T5 Refresh, assets and immutable bundle
T2 + T3 + T4 ──> T6 Standalone ExportBlock Astro render kit
T2 + T4 + T6 ──> T7 Starlight experience adapter
T2 + T4 + T5 + T6 + T7 ──> T8 Static output, discovery and web quality
T8 ──> T9 Analytics and Confluence edit link
T5 + T8 + T9 ──> T10 CLI lifecycle and verification
T10 ──> T11 Package/API/consumer/CI gates
T11 ──> T12 Docs and real provider proof
```

## 14. Checkable implementation tasks

### T0 — Freeze contracts, threat model, and feasibility gates

- [x] Re-audit all code-backed seams in section 6 against current `main` and
      record exact SHA/file references in `EVIDENCE.md`.
- [x] Pin the minimum test lane to official Astro `7.1.6`, public peer range to
      `>=7.1.6 <8`, pin Node to Astro's supported minimum, and use the coherent
      section 6.1 dependency cohort; prove a frozen-lock clean install with no
      peer warnings.
- [x] Prove a network-disabled production Astro build from structured typed
      data at `base: "/docs"`; no Markdown, Confluence request, or generated
      code.
- [x] Prove a custom build-time content loader, static catch-all route,
      handwritten-route collision detection, and private `build:done` manifest
      using only documented Astro APIs.
- [x] Prove that source strings such as `</script><script>` remain inert and
      that source data cannot select/import a component.
- [x] Spike a trusted static chart and an opt-in island over one frozen,
      schema-validated model; verify useful JS-disabled fallback.
- [x] Prove a packed plain Astro project can consume only
      `@atlcli/export-blocks-astro`, render the all-fields ExportBlock fixture,
      apply trusted overrides/tokens, and build without Starlight, Confluence,
      auth, network, publication loader, Pagefind, deployment, service-worker,
      or runtime-cache dependencies.
- [x] Freeze the dependency-free `@atlcli/export-blocks` extraction and
      compatibility-re-export strategy; prove DOCX/PDF/browser consumers retain
      their existing imports, schemas, artifacts, and tree-shaking boundary.
- [x] Build the same bundle with the supported Starlight experience and one
      deliberately small non-shipped conformance experience; freeze semantic
      slots, tokens, capability negotiation, and override rules without
      promising arbitrary Astro-theme compatibility.
- [x] Run a pinned Pagefind proof after the nested-base Astro build; prove
      keyboard search, facets, multilingual partitioning, route correctness,
      deleted-page removal, no hosted search backend, and deterministic index
      inventory.
- [x] Freeze V1 completion at
      `Astro -> Pagefind -> verified StaticPublicationManifestV1`; record
      installable PWA/offline delivery as a separate post-build follow-up with
      no V1 schema, capability, path, or dependency claim.
- [x] Prove Starlight navigation, breadcrumbs, TOC, previous/next, label/root
      landing pages, related pages, 404 search, SEO artifacts, locale/RTL,
      responsive images, vendored fonts, and Expressive Code on representative
      content before treating them as committed V1 capabilities.
- [x] Prove optional analytics with its endpoint blocked and with hostile URL
      data, plus Cloud/DC provider-returned edit relations and unsafe-origin
      rejection; freeze the no-search-term/no-persistent-queue/replay rules.
- [x] Decide whether durable publish jobs are required in V1. Default to direct
      serializable runs; create `@atlcli/publish-jobs` only with an evidenced
      recovery/scheduling requirement.
- [x] Freeze route, active-attachment, strict/partial, macro freshness, island,
      render-kit props/overrides/styling, experience, search,
      SEO/i18n/media/code, analytics, edit-link, output, workspace, and retention
      policies.
- [x] Record the additive future `ADF -> ExportBlock[] -> Astro` seam and the
      minimum resolver/support-matrix requirements without implementing or
      claiming a V1 raw-ADF API.
- [x] Record a threat model for ADF/Storage/macro input, remote assets, bundle
      paths, Astro build, islands, output directory, and future deployment.
- [x] STOP and re-plan if Astro needs source-derived code, a networked loader,
      private APIs, unbounded output, or cannot render a complete accessible
      static fallback.

Acceptance: the spike first proves the standalone render kit in plain Astro,
then produces a bounded, searchable Starlight static directory and private
manifest, with nested-base links, facets, keyboard-accessible fully static
search, SEO/i18n/media/code output, optional analytics/edit-link modes, and
hostile content remaining inert. The non-shipped experience fixture proves
adapter neutrality. No production package contract is frozen until this gate
passes.

### T1 — Expose the Confluence page graph before document composition

- [x] Add `ResolvedConfluencePageGraphV1` and
      `resolveConfluencePageGraphV1()` in export wiring.
- [x] Preserve ordered page/folder nodes, parent/depth/position, per-page
      blocks/notes, source version/metadata, completeness, and summary.
- [x] Make current `resolveConfluenceSourceV1()` a compatibility wrapper that
      still composes tree/space documents exactly as before.
- [x] Prove one discovery/body-fetch pass, cancellation, checkpoint/version,
      partial-result, and placeholder behavior.
- [x] Generate/update public API reports deliberately.
- [x] Keep all DOCX/PDF resolver fixtures and deterministic artifacts unchanged.
- [x] STOP if implementation duplicates traversal/fetch, persists raw source,
      changes existing resolver output, or changes document bytes/notes.

Acceptance: publishing can consume the exact pre-compose page graph while all
existing export behavior remains regression-green.

### T2 — Implement core project, diff, route, link, and bundle contracts

- [x] Extract the dependency-free `@atlcli/export-blocks` model/schema/helpers
      package or the Task-0-approved equivalent boundary; retain deliberate
      compatibility re-exports from `@atlcli/confluence`.
- [x] Move no ADF/Storage parser, Confluence client, host, Node, or renderer code
      into the model package; update consumers incrementally with API/closure and
      deterministic DOCX/PDF/browser regression proof.
- [x] Add `@atlcli/web-publish` with public-0.x classification, strict ESM,
      browser-safe default entry point, Node filesystem subpath, README, API
      report, and closure report.
- [x] Implement and validate the versioned contracts from section 9.
- [x] Implement experience descriptor/selection, capability negotiation,
      semantic slot, design-token, component-override, search-provider,
      SEO/i18n/media/code, analytics, and edit-link contracts.
- [x] Extract shared page-link resolution from `compose-document.ts`; keep its
      existing truth table unchanged.
- [x] Implement stable route registry, custom routes, tombstones, safe slugs,
      deterministic collisions, and case/output-path collision rejection.
- [x] Implement stable page-local anchors and builder-neutral typed page/asset
      references.
- [x] Implement canonical JSON/digest functions that exclude volatile/private
      data and reject cycles/dangling references.
- [x] Implement refresh diff semantics that distinguish delete, exclude,
      out-of-scope, and inaccessible.
- [x] Unit-test duplicate titles/IDs, rename/move, non-ASCII, long names,
      reserved names, separators, `..`, backslashes, case folding, base paths,
      and ambiguous/out-of-scope links.
- [ ] STOP on title-only identity, duplicated link truth tables, path escape,
      or silent collision/overwrite.

Acceptance: an identical graph/policy yields an identical plan and bundle
digest; route identity survives rename/move; every internal reference resolves.

### T3 — Add explicit web targeting and per-page macro resolution

- [x] Add `web` additively to Confluence export-control, macro target, source
      resolver, and macro option contracts.
- [x] Freeze existing DOCX/PDF/Word target truth tables and API output.
- [x] Resolve macros independently per page with correct page identity and
      page-local TOC/document context.
- [x] Define closed macro-to-render-model mappings, starting with TOC, Jira
      data, diagram/Mermaid, chart, status, Smart Card, and unknown fallback.
- [x] Prefer validated SVG/static models for web diagrams/charts.
- [x] Implement `live`, `no-live`, freshness, dependency, and frozen-provenance
      policies without leaking source data.
- [x] Prove raw `export_view` HTML never reaches bundle/output.
- [x] Add Cloud ADF and DC Storage fixture parity for web target behavior.
- [ ] STOP if one page can read another page's local context, existing target
      behavior changes, or raw/source-provided HTML is emitted.

Acceptance: web macro output is per-page, typed, deterministic under frozen
inputs, and does not alter existing export targets.

### T4 — Establish the Astro 7.1 integration/loader contract

- [x] Add the Node-only `@atlcli/web-publish-astro` package with Astro peer
      dependency and no bundled Astro/private Vite internals.
- [x] Export the default integration factory and named structured-data loader.
- [x] Implement loader entry IDs from immutable source IDs, schema validation,
      page digests, metadata revision, and deletion reconciliation.
- [x] Validate `output: "static"`, URL profile, `base`, `site`, `outDir`, and
      `publicDir` without silently rewriting owner configuration.
- [x] Inject/enumerate publication routes with `getStaticPaths()` and prove
      prerendering/collision behavior in documented integration hooks.
- [x] Define an optional trusted user layout entrypoint and ensure content
      cannot influence module resolution.
- [x] Load only installed operator-selected experience descriptors; validate
      required capabilities/slots and include experience/version/config in the
      build key.
- [x] Reserve collision-safe owned paths for Pagefind output and expose the
      standard experience search slots without coupling the loader to
      Starlight-private DOM.
- [x] Document that a future post-build augmenter must consume the completed
      verified manifest and reserve owned paths through the route/output
      registry; add no V1 service-worker paths or PWA schema.
- [x] Write the private output manifest outside the public output root.
- [x] Keep programmatic Astro APIs and experimental collection storage out of
      public contracts.
- [x] STOP on private Astro/Vite dependency, non-static route, ambient docs-site
      config, or Confluence/network access in the loader.

Acceptance: a packed integration installed into a clean Astro 7.1 project can
load a bundle and build all routes with build-time network access disabled.

### T5 — Implement refresh, cache, assets, and atomic bundle activation

- [x] Implement bounded mutable page/asset cache ports and the default Node
      filesystem store under the project workspace.
- [x] Compute page reuse from the full cache key, not page version alone.
- [x] Refresh live dependencies and attachment metadata independently of page
      body versions.
- [x] Build a complete `PublicationRefreshPlanV1` before mutating active state;
      surface all destructive and partial changes.
- [x] Reuse existing asset trust routing and SVG validation at the final fetch
      and materialization seam.
- [x] Validate MIME/magic bytes, size/pixel/node budgets, redirects/private
      networks, digest, safe filenames, root containment, and symlinks.
- [x] Deduplicate content-addressed assets and preserve safe download names.
- [x] Stage, validate, digest, and atomically activate immutable bundles.
- [x] Ensure failed/cancelled refresh preserves the last active bundle.
- [x] Implement retention/GC by manifest reachability and grace period only.
- [x] Test concurrent refresh/fencing, crash points, stale writer, abort, corrupt
      cache recovery, failed asset, confirmed deletion, and ambiguous absence.
- [ ] STOP on credentialed external fetch, unsafe original SVG write, glob-based
      delete, cache-as-authority, or mixed/partial activation.

Acceptance: unchanged deterministic pages/assets are reused; changed and live
dependencies refresh; removed content is acted on only with authoritative proof;
the active bundle is always complete and digest-valid.

### T6 — Build the standalone ExportBlock Astro render kit

- [x] Add Astro-native, Starlight-free `@atlcli/export-blocks-astro` as a
      public-0.x package with Astro peer range, README, API report, closure
      report, named exports, fixture exports, and no Node-only default entry.
- [x] Implement `ExportDocument.astro` plus trusted components for every
      `ExportBlock` and inline discriminator with compile-time exhaustiveness.
- [x] Cover headings/anchors, paragraphs/marks, lists/tasks, tables/spans,
      callouts, code, figures/captions, layouts, expand/details, status, links,
      assets, Smart Cards, and visible unknown fallbacks.
- [x] Accept only `ExportBlock[]` plus the versioned locale/heading/link/asset/
      note render context; perform no acquisition, auth, or implicit network I/O.
- [x] Use Astro escaping by default; expose no caller/raw-string `set:html` API.
- [x] Implement a closed, build-selected override registry with versioned
      descriptors and schema-validated payloads; source content can never select
      or parameterize a component/module import.
- [x] Export minimal accessible baseline styles, semantic slots, versioned CSS
      custom properties, and documented `data-atlcli-*` hooks without treating
      generated classes/full DOM snapshots as public compatibility.
- [x] Implement accessible static chart SVG/HTML from normalized chart data.
- [x] Implement the optional block-local chart island with frozen data, explicit
      opt-in, byte/row/node limits, no network/auth access, and static fallback.
- [x] Keep chart rendering behind a vendor-neutral `ChartRendererAdapter`; use
      TanStack Charts `0.3.1` as the pinned, product-owner-approved pre-alpha
      adapter only for the bounded opt-in bar-chart profile. Prove Astro SSR
      fallback, hydration, keyboard accessibility, no client error, and a
      <=100 KiB external runtime bundle; never serialize TanStack definitions,
      callbacks, or functions into the bundle.
- [x] Prove CSP, no event-handler/script/CSS injection, unsafe URL rejection,
      SVG safety, and no opaque datasource/provenance serialization.
- [x] Build a packed plain-Astro consumer with the all-fields fixture, one
      trusted component override, custom tokens, JS on/off, accessibility, RTL,
      print, hostile data, and deterministic semantic goldens.
- [x] Add negative dependency gates for Starlight, Confluence client/auth,
      publication loader/routes, Node filesystem, Pagefind, deployment,
      service-worker/runtime-cache, analytics, and edit-link code.
- [x] Document the deferred additive ADF-adapter seam but export no V1
      `AdfDocument` or raw-ADF capability claim.
- [x] STOP if the base renderer requires Starlight/project chrome, source data
      can become executable code, disabled JS loses represented information, or
      unsupported blocks disappear silently.

Acceptance: a packed plain Astro project independently renders the all-fields
ExportBlock fixture safely and accessibly with the documented override/styling
contract. The package contains no Starlight, Confluence, site-build, auth,
network, search, deployment, service-worker, or runtime-cache dependency; chart
interaction remains bounded and has a complete static fallback.

### T7 — Build the Starlight experience adapter

- [x] Add `@atlcli/web-publish-starlight` as the first public-0.x experience
      package with pinned compatible Starlight/Astro peers and no duplicated
      ExportBlock dispatcher or build runner.
- [x] Implement the versioned experience descriptor/runtime and semantic slots
      without exposing Starlight-generated DOM selectors as compatibility.
- [x] Consume `@atlcli/export-blocks-astro` for all document bodies and map
      Starlight tokens to its public custom-property/slot contract.
- [x] Implement supported Starlight configuration, plugins, component
      overrides, and Expressive Code integration without forking Starlight.
- [x] Ship responsive hierarchical navigation, breadcrumbs, page TOC,
      previous/next, search slots, related pages, landing pages, deep-link
      actions, useful 404, dark/light/system modes, print styles, and accessible
      token defaults.
- [x] Implement a deliberately small non-shipped plain-Astro experience fixture
      over the same contracts; it must not reimplement ExportBlock dispatch.
- [ ] Prove Starlight plus the experience fixture at mobile/desktop widths, high
      zoom, forced colors, reduced motion, light/dark/system modes, print, long
      titles, deep trees, RTL-safe layout, and custom tokens.
- [ ] Prove a Starlight renderer override changes presentation without changing
      normalized content, resolved links/assets, routes, indexed text, or
      security diagnostics.
- [ ] STOP on Starlight-private content semantics, duplicate render trees,
      source-selected imports, undocumented override hooks, or an experience
      becoming the authority for acquisition/build/cache/security.

Acceptance: Starlight is a feature-complete first consumer of the standalone
render kit, not its owner. The non-shipped experience fixture proves that page
and presentation contracts are not Starlight-private.

### T8 — Build static output, discovery, and production web quality

- [x] Implement a builder adapter over immutable bundle + trusted Astro project;
      do not expose Astro's experimental programmatic API publicly.
- [x] Invoke the project-owned build executable/argv with `shell: false`, bounded
      environment, abort/timeout handling, and no inherited secrets by default.
- [x] Materialize generated assets/routes without overwriting handwritten
      project sources or `public/` files.
- [x] Build the three URL/base profiles from section 11.
- [x] Pin Pagefind, annotate canonical content/facets/metadata in trusted
      components, and run the full static indexer after each Astro build.
- [x] Provide theme-neutral accessible modal and full-page search components
      with keyboard shortcut, worker/main-thread fallback, translated UI,
      filters, result excerpts, and nested-base URL handling.
- [x] Exclude navigation chrome, private diagnostics, partial/hidden pages,
      redirects, and deleted pages; never index raw bundle/source data.
- [x] Treat result excerpts safely and prove that indexed hostile text cannot
      become executable markup in Starlight or the conformance experience.
- [ ] Enforce measured search-index, initial-JS, query-latency, and memory
      budgets on small, representative, and large deterministic corpora.
- [ ] Generate the complete navigation model, deterministic related-page
      ranking, root/space/label landing pages, breadcrumbs, page TOC,
      previous/next, deep-link actions, and searchable 404 from the page graph.
- [ ] Generate canonical and alternate-language links, intentional robots
      policy, sitemap, OpenGraph/social metadata, allowlisted JSON-LD, and
      optional RSS/Atom from the shared route/locale planner.
- [ ] Implement explicit locale metadata, localized routes/UI/search, language
      fallback, correct `lang`/`dir`, RTL, and canonical/hreflang consistency.
- [ ] Implement verified-original and bounded Astro-responsive image modes,
      original download links, local/system fonts, and no remote font runtime.
- [ ] Implement the normalized Expressive Code surface with copy, wrap,
      language label, filename/caption, highlights, and hostile-input proof.
- [ ] Enable base-aware prefetch only for verified same-origin routes; allow
      native cross-document view transitions as progressive enhancement but do
      not make Starlight's client router or SPA state a correctness dependency.
- [ ] Set and gate budgets for critical CSS, initial JS, fonts, transformed
      images, LCP, CLS, navigation, and search interaction.
- [x] Inventory every generated page/asset/output path and reject unexplained or
      escaping output.
- [ ] Produce the final V1 static-publication manifest inventory with bundle,
      builder, Astro,
      project/config/lockfile, experience, route/asset, Pagefind, SEO/i18n/media,
      and normalized output digests.
- [ ] Prove a build with network disabled and no runtime `/_image` or private
      Confluence dependencies.
- [ ] Prove cold/warm builds of one bundle yield equivalent semantic manifests.
- [ ] STOP on mixed old/new output, source-derived build modules, ambient repo
      docs config, unexpected executable JS, or an unbounded output inventory.

Acceptance: a Starlight candidate with complete information architecture,
search, SEO/discovery, i18n, media, code, and performance proof is produced
from the bundle without Confluence access or a hosted search service; its exact
manifest is ready for local promotion or a future deployment/post-build
adapter.

### T9 — Add optional analytics and Confluence edit links

- [ ] Implement analytics as `none` by default and a closed optional Plausible
      adapter with a bundled pinned tracker, explicit endpoint/origin,
      pageviews, and allowlisted events.
- [ ] Strip query/fragment, title, source ID, Confluence URL, account data, and
      arbitrary properties; never collect search terms or persist/replay events
      later; respect Do Not Track as configured.
- [ ] Prove blocking the analytics endpoint cannot affect content,
      navigation, search, accessibility, or verification; emit an exact CSP and
      privacy declaration for enabled external origins.
- [ ] Implement the optional Confluence action from provider-returned Cloud
      `_links.editui` and Data Center edit relations; resolve only against the
      trusted tenant/base origin and never synthesize editor URLs.
- [ ] Implement validated `webui` fallback with truthful “Open in Confluence”
      copy or omission, internal/all visibility, placement, and explicit public
      tenant-disclosure acknowledgement.
- [ ] Exclude edit URLs/actions from Pagefind, related ranking, sitemap, feeds,
      JSON-LD, deployment/runtime-cache metadata, and analytics payloads.
- [ ] Finalize `StaticPublicationManifestV1` with analytics declaration,
      edit-link summary, and exact final output digests.
- [ ] STOP on persistent analytics queue/replay, source-controlled event data,
      synthesized/cross-origin edit URL, or any private/provider URL leaking to
      unrelated public artifacts.

Acceptance: analytics and Confluence edit links remain optional/off-by-default,
narrowly configured, privacy-bounded, and unable to weaken content, search,
artifact integrity, or origin security.

### T10 — Add CLI lifecycle, reports, and artifact verification

- [ ] Add `wiki publish plan|refresh|build|verify|run|status|prune` command
      routing, help, JSON output, and shell completion.
- [ ] Validate configuration with actionable field-level errors and redact all
      profile/auth/private values.
- [ ] Require explicit public visibility and partial-output choices.
- [ ] Make plan/diff visible before confirmed deletions or route changes become
      active; non-interactive CI requires explicit flags/config authority.
- [ ] Propagate Ctrl-C/abort through every port and child process.
- [ ] Verify manifest ownership, expected route/file set, internal links,
      anchors, images/downloads, base mapping, hashes, CSP/active content,
      secret/private URLs, and absence of bundle-internal references.
- [ ] Verify Starlight capability declarations, Pagefind/SEO/i18n/media output,
      analytics declarations, and edit-link origins/exclusions.
- [ ] Fail on non-empty/unowned output targets; use sibling staging plus
      recoverable promotion for replacement.
- [ ] Report `bundle-ready`, `built`, and `verified`; never `deployed`.
- [ ] Test retry/recovery, stale expected digest, corrupt manifest, symlink
      target, cross-device destination, build failure, and verification failure.
- [ ] STOP if cleanup/delete authority comes from a title/glob or failure leaves
      a mixed visible destination.

Acceptance: the four-stage journey is independently repeatable and `run`
orchestrates it without hiding the plan, bundle, build, or verification digest.

### T11 — Prove packages, consumers, hosts, and required CI

- [ ] Add API/closure reports and deliberate public-0.x classifications.
- [ ] Add browser-build entries only for genuinely isomorphic export-block and
      web-publish cores; add negative gates that Astro/Node code cannot enter
      them.
- [ ] Extend pack checks, publishable-dependency checks, Node consumer smoke,
      Vite/browser consumer smoke, and add separate packed plain-Astro render-kit
      and full Starlight publishing consumers.
- [ ] Pin official Astro `7.1.6` in the minimum fixture and test latest
      supported 7.x
      separately.
- [ ] Test Ubuntu Node 22.12/Astro 7.1.6, Ubuntu Node 24/latest 7.x, and Windows
      Node 24/Astro 7.1.6 path portability.
- [ ] Add a production Astro publishing harness with Cloud ADF and DC Storage
      synthetic fixtures, assets, links, macros, Starlight, the non-shipped
      experience conformance fixture, Pagefind search/facets, chart
      static/island, and strict/partial failures.
- [ ] Assert the packed plain-Astro render-kit consumer has no Starlight,
      Confluence client/auth, web-publish builder, Pagefind, deployment,
      service-worker/runtime-cache, analytics, or edit-link transitive/runtime
      dependency and performs no network request.
- [ ] Serve directory output with a directory-index server and portable-file
      output with a simple file server; crawl every route/link/asset.
- [ ] Run Playwright with JS on/off, CSP, accessibility, blocked external
      network, privacy, and deterministic-manifest gates.
- [ ] Exercise search by mouse and keyboard in every output/experience fixture:
      query,
      empty/no-result, excerpts, anchors, facets, language, Unicode/diacritics,
      large result sets, back/forward, deleted pages, and worker fallback.
- [ ] Exercise Cloud/DC edit relation present/missing/unsafe cases and analytics
      disabled/enabled/blocked/redacted cases; assert no indexing/caching/event
      leakage.
- [ ] Measure experience CSS/JS, island JS, search bootstrap/index shards,
      responsive images/fonts, LCP/CLS, navigation and search latency, and
      accessibility budgets; gate regressions.
- [ ] Seed negative fixtures for route collision, path traversal, Node import in
      browser core, XSS, unsafe SVG, private URL, digest mismatch, and missing
      asset; prove each named gate fails.
- [ ] Wire all publishing checks into the required CI aggregator so path routing
      cannot report green after skipping them.

Acceptance: packed real consumers, not source-only tests, prove the
browser-safe cores, standalone Astro render kit, Starlight experience, and
Node-only publishing boundary independently.

### T12 — Documentation, real E2E, and delivery gates

- [ ] Add a task-focused Web Publishing guide, configuration reference,
      experience-adapter authoring/migration guide, search/index/ranking guide,
      renderer/chart guide, security/privacy guide, operations/refresh/rollback
      guide, troubleshooting, examples, and related-topic links.
- [ ] Add a standalone `@atlcli/export-blocks-astro` guide/API reference with a
      plain Astro minimal example, advanced override/token example, complete
      block support matrix, baseline-style contract, accessibility/security
      rules, and package-boundary explanation.
- [ ] Document `ExportBlock[]` as the V1 public renderer input and the deferred
      additive `ADF -> ExportBlock[]`/`AdfDocument` seam without implying direct
      raw-ADF support has shipped.
- [ ] Document the supported Starlight experience and neutral adapter contract,
      tokens/slots/capabilities, Pagefind facets/metadata/languages, search
      accessibility, index budgets, and future-experience boundary without
      claiming arbitrary Astro-theme compatibility.
- [ ] Document navigation/related-page rules, SEO/sitemap/social/feed controls,
      i18n/RTL, responsive media/fonts, Expressive Code, prefetch/progressive
      transitions, and performance budgets.
- [ ] Document explicitly that installable PWA/offline runtime is deferred and
      describe only the versioned post-build augmentation seam for its future
      independent PR.
- [ ] Document analytics as optional/off-by-default with its exact collected
      fields, DNT/CSP/endpoint configuration and operator legal responsibility;
      document edit-link visibility, fallback, origin validation, and public
      tenant disclosure.
- [ ] Document static vs. island vs. live capability and state clearly that
      deployment is deferred.
- [ ] Document `.gitignore`, cache/bundle/build retention, reproducibility,
      visibility/partial warnings, and safe cleanup.
- [ ] Update CLI/package READMEs and docs-site navigation without reusing the
      docs site's Astro theme as customer runtime.
- [ ] Run focused tests, full `bun run test`, `bun run typecheck`, build,
      API/closure, browser, pack/consumer, docs, Astro production harness,
      Starlight/search performance, SEO/i18n/media, link/a11y/security/privacy,
      analytics/edit-link, and Windows path gates.
- [ ] Run required real read-only Cloud E2E with profile `mayflower`, space
      `DOCSY`, on representative page/tree/space content; build/inspect both URL
      profiles and abort/retry; keep private identifiers/artifacts out of Git.
- [ ] Run a real DC E2E before making the DC-supported claim; if no provider is
      available, label it `not executed`, not proven.
- [ ] Remove only created local outputs and any deliberately created remote test
      resources in `finally`; record proof without tenant/customer data.
- [ ] Deliver implementation through logical conventional commits and Draft
      PR checkpoints; do not release automatically.

Acceptance: every shipped claim maps to fixture, packed artifact, browser, and
where applicable real provider evidence; all resources are cleaned up.

## 15. Verification commands and proof matrix

Implementation PRs must use repository wrappers and add named scripts as
needed. At minimum:

```bash
bun run test packages/export-blocks
bun run test packages/export-blocks-astro
bun run test packages/web-publish
bun run test packages/web-publish-astro
bun run test packages/web-publish-starlight
bun run test packages/confluence packages/export-macros packages/export-wiring
bun run test:publish-render-kit
bun run test:publish-experiences
bun run test:publish-search
bun run test:publish-seo
bun run test:publish-analytics-edit
bun run typecheck
bun run build
bun run check:browser
bun run check:api
bun run test:pack
bun run test:consumer
bun run docs:build
```

The final plan-only PR itself runs only documentation checks appropriate to its
scope (`git diff --check`); it introduces no runtime behavior.

Proof remains layered:

1. pure unit/property tests prove contracts, routes, digests, diff, escaping;
2. package tests prove graph/macro/assets, render-kit, experience, and Astro
   integration seams;
3. packed plain-Astro and Starlight consumers prove published tarballs and
   dependency boundaries;
4. real Astro production artifacts prove routes, links, assets, CSP/a11y;
5. live Cloud/DC E2E proves provider acquisition only; and
6. remote deployment remains unproven and unclaimed.

## 16. Delivery sequence and commit boundaries

Recommended implementation PR stack/commit boundaries:

1. `refactor(export): extract consumer-neutral ExportBlock package`
2. `refactor(confluence): expose pre-compose page graph`
3. `feat(publish): add publication contracts and route planning`
4. `feat(macros): add web publication target`
5. `feat(publish): add cache and immutable bundle materialization`
6. `feat(export-blocks-astro): add standalone semantic render kit`
7. `feat(publish-astro): add Astro 7.1 loader and integration`
8. `feat(publish-starlight): add first publishing experience`
9. `feat(publish-astro): add Pagefind, navigation, SEO and web quality`
10. `feat(publish-astro): add analytics and Confluence edit links`
11. `feat(cli): add local web publishing lifecycle`
12. `test(publish): add packed Astro and browser conformance gates`
13. `docs(publish): document static web publishing`

Each boundary must keep existing DOCX/PDF and Markdown behavior green. Draft
PRs stay Draft until their own acceptance gates pass; no automatic release.

## 17. Definition of done

- [ ] T0–T12 are complete with no unresolved STOP condition.
- [ ] Page/tree/space Cloud acquisition and local Astro static output are
      fixture-, packed-artifact-, browser-, and live-E2E proven.
- [ ] DC Storage behavior is fixture-proven and either live-proven or labelled
      honestly as not executed.
- [ ] Immutable bundles build with network access disabled and failed
      refresh/build never replaces the last valid state.
- [ ] Route, deletion, asset, dynamic-dependency, and output ownership semantics
      are deterministic and tested.
- [ ] Every block has safe static output; the optional chart island works with
      bounded frozen data and degrades usefully without JavaScript.
- [ ] `@atlcli/export-blocks-astro` is independently packable and renders the
      all-fields fixture in plain Astro with no Starlight, Confluence, auth,
      network, builder, search, deployment, service-worker, or runtime-cache
      dependency.
- [ ] The ExportBlock model has a dependency-free public boundary with
      compatibility re-exports and unchanged DOCX/PDF/browser behavior.
- [ ] The supported Starlight experience passes the semantic, responsive, mode,
      print, accessibility, and search contract; a non-shipped experience
      fixture proves the adapter contract without a second production theme.
- [ ] Pagefind client search is production-built, fully static with no hosted
      backend, keyboard-accessible, multilingual, faceted, base-aware,
      privacy-safe, budgeted, and free of deleted/excluded/private content.
- [ ] Navigation, breadcrumbs, TOC, previous/next, related/landing/404 pages,
      canonical/hreflang/sitemap/robots/social/JSON-LD/feed output, localized
      routes, responsive images, local fonts, Expressive Code, prefetch, and
      performance budgets are artifact- and browser-proven.
- [ ] V1 makes no installable-PWA or runtime-offline claim and emits no Web App
      Manifest, service worker, cache policy, or provisional PWA schema; the
      post-build augmentation seam is documented for a separate PR.
- [ ] Analytics is off by default and the optional Plausible configuration is
      redacted, allowlisted, DNT-aware, non-persistent/non-replayed, and harmless
      when blocked.
- [ ] The optional Confluence edit action uses validated provider-returned
      Cloud/DC relations, never synthesized URLs, and is excluded from search,
      discovery/deployment/runtime-cache metadata, and analytics.
- [ ] Strict completeness, XSS, SSRF, path, active-content, secret/private URL,
      CSP, accessibility, and privacy gates pass.
- [ ] Existing export and Markdown sync schemas/fixtures/artifacts are unchanged.
- [ ] `wiki publish` reports local bundle/build/verification truthfully and does
      not claim remote deployment.
- [ ] Public APIs, pack/consumer/browser/CI gates and user docs are complete.
- [ ] No direct raw-ADF Astro API is claimed in V1; the future adapter can be
      added without changing the render-kit or Starlight contracts.
- [ ] No customer/tenant data, raw source, credentials, or private artifacts are
      committed.

## 18. Risks and STOP/re-plan rules

1. **Live-data expectation:** an interactive island is not live data. If the
   product needs request-time freshness, stop and design a server/deployment
   capability with auth, caching, tenancy, and operations separately.
2. **Deletion ambiguity:** never translate incomplete discovery into output
   deletion. If provider semantics cannot prove removal, retain the last page
   and report inaccessible/stale.
3. **Macro freshness:** page versions do not cover Jira/chart/external data.
   Re-resolve live dependencies until stable fingerprints exist.
4. **Active attachments:** static same-origin hosts often cannot force safe
   download headers. Reject HTML/SVG/XML-like downloads unless validated or
   isolated by a later provider contract.
5. **Astro API drift:** only stable documented 7.1 APIs are public. Re-plan for
   Astro 8; do not silently widen the peer range.
6. **Route ownership:** handwritten/project routes win only if configured;
   collisions fail. Never overwrite project content.
7. **False portability:** `base` and URL profile are build inputs. Moving the
   directory to another base without rebuilding is unsupported.
8. **Host claims:** browser-safe core proof does not certify Astro in MV3,
   ordinary browser, or Forge.
9. **Starlight coupling:** Starlight is the first supported experience, not the
   core content contract. The non-shipped conformance fixture must prove that
   route/search/security semantics do not depend on Starlight-private DOM.
   Arbitrary catalog-theme compatibility requires an explicit future adapter.
10. **Render-kit leakage:** putting Starlight, Confluence resolution, routes, or
    build concerns into block components would destroy their standalone value.
    Gate package closure and prove a packed plain-Astro consumer before the
    Starlight experience is accepted.
11. **Premature ADF API:** a direct ADF component appears simple but media,
    mentions, extensions, versions, and unknown-node behavior require an honest
    support/resolver contract. Keep it additive and deferred; never implement a
    second component tree or advertise raw-ADF support from internal fixtures.
12. **Deferred PWA boundary:** a later PWA augmenter must start from the final
    verified Astro/Pagefind manifest and independently prove ordering, ownership,
    update, quota, privacy, and cleanup. Do not leak provisional cache semantics
    into V1 contracts.
13. **Analytics privacy drift:** “Privacy-respecting” is a narrow technical
    configuration, not a legal conclusion. Keep analytics optional/off, accept
    only the closed provider/events, emit disclosure/CSP evidence, and never add
    query/search/source/user data or persistent queue/replay without re-planning.
14. **Edit-link disclosure:** a Confluence action may reveal a tenant hostname
    or route on a public site. Keep it off by default, require explicit public
    acknowledgement, validate provider-returned same-origin relations, and omit
    rather than synthesize an editor URL.

## 19. Decisions to confirm before T1

The plan recommends defaults so implementation can begin, but these product
choices should be confirmed at the T0 gate:

1. Is the opt-in interactive chart island part of the first release, or should
   V1 ship static charts only while retaining the renderer capability contract?
2. Which Starlight customization surface should V1 expose initially?
   Recommendation: documented Starlight configuration plus atlcli semantic
   tokens, slots, and closed component overrides; do not promise arbitrary CSS
   selectors or compatibility with unadapted Astro themes.
3. Is local directory output the only V1 destination? Recommendation: yes;
   remote deployment is a separate provider/PR.
4. Is the stable first-assigned pretty route policy acceptable for rename/move?
   Recommendation: yes, with explicit custom route changes and private redirect
   candidates.
5. Does V1 require durable background/recovery jobs? Recommendation: no; keep a
   direct serializable lifecycle and design durable publish jobs only when a
   scheduler/remote deployer requires them.
6. Which chart macro/data shapes are the first supported normalized chart
   model? Freeze the smallest provider-backed set in T0 rather than accepting
   arbitrary chart configuration.
7. Which Pagefind facets and ranking defaults should be visible initially?
   Recommendation: space, label, content type, and language; boost title and
   headings, then validate relevance on representative English/German corpora.
8. Should RSS/Atom be enabled automatically for public builds? Recommendation:
   no; keep feeds off by default because publication/revision semantics and
   intended audience must be selected explicitly.
9. Should the Confluence action ever default to public visibility?
    Recommendation: no; default to off/internal and require an explicit
    disclosure acknowledgement for `visibility: "all"`.
10. Should `@atlcli/export-blocks-astro` be published to npm with the first
    publishing release? Recommendation: make it independently packable,
    documented, and public-0.x in V1, but make the external npm/community
    publication a deliberate post-conformance release decision.
11. Should the standalone baseline stylesheet load automatically?
    Recommendation: no hidden global CSS; export a documented stylesheet that
    plain-Astro consumers opt into and that the Starlight adapter maps/imports
    explicitly.

## 20. Primary references

- [Official Astro 7.1.6 release](https://github.com/withastro/astro/releases/tag/astro%407.1.6)
- [Withdrawn `astro@7.1.0` false-positive record](https://osv.dev/vulnerability/MAL-2026-10726)
- [GitHub Advisory Database false-positive report](https://github.com/github/advisory-database/issues/8871)
- [Astro configuration reference](https://docs.astro.build/en/reference/configuration-reference/)
- [Astro content loader reference](https://docs.astro.build/en/reference/content-loader-reference/)
- [Astro integration API](https://docs.astro.build/en/reference/integrations-reference/)
- [Astro components](https://docs.astro.build/en/basics/astro-components/)
- [Astro integration/component npm publishing](https://docs.astro.build/en/guides/integrations/#publishing-your-integration-to-npm)
- [TanStack Charts repository and pre-alpha status](https://github.com/TanStack/charts)
- [TanStack Charts `0.3.1` release](https://github.com/TanStack/charts/releases/tag/v0.3.1)
- [TanStack portable chart spec](https://github.com/TanStack/charts/blob/main/PORTABLE-CHART-SPEC.md)
- [Astro routing](https://docs.astro.build/en/guides/routing/)
- [Astro images](https://docs.astro.build/en/guides/images/)
- [Astro themes catalog](https://astro.build/themes/)
- [Astro integrations catalog](https://astro.build/integrations/)
- [Astro fonts](https://docs.astro.build/en/guides/fonts/)
- [Astro internationalization](https://docs.astro.build/en/guides/internationalization/)
- [Astro prefetch](https://docs.astro.build/en/guides/prefetch/)
- [Astro view transitions](https://docs.astro.build/en/guides/view-transitions/)
- [Pagefind static search](https://pagefind.app/docs/)
- [Pagefind Component UI](https://pagefind.app/docs/search-ui/)
- [Pagefind indexing](https://pagefind.app/docs/indexing/)
- [Pagefind filters](https://pagefind.app/docs/filtering/)
- [Pagefind multilingual search](https://pagefind.app/docs/multilingual/)
- [Starlight capabilities](https://starlight.astro.build/)
- [Starlight configuration](https://starlight.astro.build/reference/configuration/)
- [Starlight component overrides](https://starlight.astro.build/guides/overriding-components/)
- [Starlight plugin ecosystem](https://starlight.astro.build/resources/plugins/)
- [Astro sitemap integration](https://docs.astro.build/en/guides/integrations-guide/sitemap/)
- [Astro RSS](https://docs.astro.build/en/recipes/rss/)
- [Expressive Code](https://expressive-code.com/)
- [Starlight package manifest](https://raw.githubusercontent.com/withastro/starlight/main/packages/starlight/package.json)
- [Deferred PWA compatibility evidence: current `@vite-pwa/astro` package manifest](https://raw.githubusercontent.com/vite-pwa/astro/main/package.json)
- [Plausible analytics documentation](https://plausible.io/docs)
- [Plausible script extensions and custom endpoints](https://plausible.io/docs/script-extensions)
- [Official Plausible tracker package](https://www.npmjs.com/package/@plausible-analytics/tracker)
- [Confluence Cloud page API](https://developer.atlassian.com/cloud/confluence/rest/v2/api-group-page/)
- [Confluence Data Center REST examples](https://developer.atlassian.com/server/confluence/confluence-rest-api-examples/)
- [Astro programmatic API](https://docs.astro.build/en/reference/programmatic-reference/)
- [Astro template directives and `set:html`](https://docs.astro.build/en/reference/directives-reference/#sethtml)
