# Web publishing MVP — immutable publication bundles and Astro 7.1

- Status: **Planned**
- Planning baseline: `cdf11eb7d1f642528b6d8c995ea90ab75fffd77b`
  (`origin/main`, 2026-07-30)
- First builder: Astro `>=7.1.0 <8`
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
Astro can consume Markdown, but this pipeline deliberately does not. It loads
per-page `ExportBlock[]` documents and assets from a versioned publication
bundle and maps blocks and macros to trusted Astro components.

V1 is a world-class publishing experience rather than a bare HTML proof. It
ships a stable multi-theme contract, at least two first-party themes, a
project-owned theme adapter, and required Pagefind-powered client-side search
with accessible keyboard UI, facets, metadata, multilingual indexes, and
offline static operation.

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
  -> future deployment adapter (not in this MVP)
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
   this static MVP.

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
- Astro project, base path, URL profile, theme/tokens, search, and build script;
  and
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
5. Produce immutable, offline, integrity-checked publication bundles.
6. Keep source identity stable while allowing pretty, persisted routes.
7. Resolve internal page links, anchors, assets, navigation, breadcrumbs, and
   removals deterministically.
8. Provide a builder-neutral contract and an Astro 7.1 implementation.
9. Support multiple versioned themes with a stable capability, slot, token,
   component-override, and accessibility contract.
10. Ship world-class static client-side search in V1, including keyboard-first
    UI, facets, metadata, multilingual indexing, and nested-base support.
11. Support trusted static renderers and opt-in client islands with frozen data.
12. Fail closed on incomplete acquisition, unsafe active content, route/output
    collisions, XSS, SSRF, path traversal, and secret/private-URL leakage.
13. Verify the final static artifact, including theme and search output, not
    only serializer inputs.
14. Leave DOCX/PDF export, Markdown sync, and DOCX import behavior unchanged.

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
- promising incremental Astro output builds: only acquisition/normalization is
  incremental in V1;
- requiring a hosted search service, crawler, account, or runtime backend for
  the V1 search baseline;
- automatic publication-permission inference beyond what Confluence APIs can
  prove;
- browser/extension/Forge execution of the Node-only Astro build; and
- calling Astro's server deployment integration an atlcli static builder.

## 6. Code-backed baseline

The planning baseline already has most of the source-side semantic model:

- `packages/confluence/src/export-blocks.ts` defines consumer-neutral blocks
  and never passes raw Storage through as output.
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

`@atlcli/web-publish` is the public, mostly isomorphic core:

- versioned project, refresh-plan, bundle, page, route, link, asset, renderer,
  theme, search, build, manifest, report, and issue contracts;
- route registry and diff planning;
- canonical digest and bundle validation;
- link/anchor/output-path planning;
- closed renderer descriptors and safe semantic render helpers;
- browser-safe default entry point;
- a Node subpath for bounded filesystem bundle/cache stores.

`@atlcli/web-publish-astro` is Node-only and public-0.x:

- default Astro integration factory;
- named build-time content loader;
- trusted default route, layouts, block components, styles, themes, and islands;
- a theme-package contract with at least two first-party reference themes and a
  validated project-owned theme adapter;
- a post-build Pagefind indexer plus theme-neutral accessible search components;
- Astro config/route/build/search hooks and output manifest production;
- peer dependency `astro >=7.1.0 <8`, Node `>=22.12.0`;
- no embedded second Astro and no private Astro/Vite API contract.

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
@atlcli/confluence -----------+
@atlcli/export-macros -------+----> @atlcli/web-publish
@atlcli/core ----------------+
                                      ^
                                      |
                           @atlcli/web-publish-astro ---> Astro peer
                                      ^
                                      |
export-wiring / export-node ports ---> CLI
```

Forbidden edges:

- web-publish core -> Astro, Node built-ins, CLI, Forge, extension, React, Vite;
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
  theme: PublicationThemeSelectionV1;
  search: PublicationSearchOptionsV1;
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

The Astro package exports:

- default `atlcliPublishingIntegration(options)` for `astro add` compatibility;
- named `atlcliPublicationLoader(options)`;
- bundle schemas/types and trusted default components; and
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
theme, search, or asset plugin. It must not depend on Astro/Vite private
internals.

### 9.7 Theme and search contracts

Themes are trusted installed code selected by the operator, never by source
content:

```ts
interface PublicationThemeDescriptorV1 {
  schema: "atlcli.publication-theme/1";
  id: string;
  version: string;
  engine: "astro";
  capabilities: readonly PublicationThemeCapabilityV1[];
  slots: readonly PublicationThemeSlotV1[];
  designTokensSchema: string;
  components: PublicationThemeComponentsV1;
}

type PublicationThemeCapabilityV1 =
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
  | "print-styles";
```

V1 ships at least two visually and structurally distinct first-party reference
themes: a feature-complete documentation/knowledge-base theme and a minimal
content theme. It also supports a validated project-owned theme package through
the same descriptor. A theme owns presentation but may not change source,
route, search, security, or completeness semantics.

The stable customization surface is semantic slots, design tokens, and closed
component overrides, not selectors into generated DOM. Required slots cover
document head, header, primary navigation, left navigation, breadcrumbs,
search trigger/modal, main content, page TOC, previous/next, footer, and
renderer/island styling. Every theme must provide responsive behavior,
keyboard/focus states, reduced-motion behavior, usable print styles, and a
light/dark/system color mode or explicitly declare a single accessible mode.

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
usable with keyboard and screen readers, and multilingual. Search works offline
after the index is loaded and uses Pagefind's worker path when available with a
tested main-thread fallback. Result URLs must use the same route/output profile
as the site. Search excerpts are treated as untrusted presentation data:
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

### 9.8 Static publication manifest

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
  theme: { id: string; version: string; digest: string };
  search: BuiltSearchIndexV1;
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
differ.

The Astro integration emits or stages assets without mutating the user's
handwritten `public/` tree. Arbitrary downloads preserve bytes. Supported image
optimization may be a later explicit mode; the V1 default copies verified
bytes and never requires runtime `/_image` URLs.

Missing or blocked assets produce a deterministic placeholder and issue.
Whether that blocks a strict publication depends on issue severity and policy;
it is never silently omitted.

## 11. Astro integration behavior

The existing Astro project remains owner of installed theme packages, approved
design-token values, project chrome, and handwritten routes. The atlcli
integration contributes:

- a configurable publication route prefix;
- a trusted default catch-all route enumerated by `getStaticPaths()`;
- a closed component registry and at least two first-party accessible themes;
- a validated project-owned theme adapter with capability negotiation;
- bundle-backed content collection entries; and
- post-build Pagefind indexing, theme-owned accessible search UI slots, and
  private build-manifest production.

Theme selection is project configuration. Confluence pages and macro data
cannot choose packages, component imports, arbitrary CSS, or scripts. Switching
themes must not change canonical routes, page identity, indexed content, link
targets, completeness, or asset trust. Theme ID/version/config and generated
CSS/JS participate in the build digest.

The Pagefind baseline is required in every first-party V1 theme. A custom theme
must either implement the standard search trigger/modal/page slots or fail
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

Every case is built with both first-party themes and search enabled. The matrix
also covers a project-owned theme adapter, multilingual pages, label/space
facets, keyboard navigation, deep-link result URLs, deleted-page removal, and
JavaScript-disabled graceful degradation to normal site navigation.

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
| first-party themes | at least docs + minimal | two-theme artifact/a11y/visual proof |
| project-owned theme | supported contract | capability/slot/negative fixture proof |
| light/dark/system + responsive | V1 theme requirement | keyboard/mobile/contrast proof |
| Pagefind client search | required V1 baseline | production index + browser E2E |
| search facets/metadata | label/space/type/language | result/facet correctness proof |
| multilingual search | supported | language-partition/stemming/UI proof |
| hosted search provider | optional future adapter | deferred, not required |
| local static build | supported | packed Astro production build |
| remote deployment | deferred | no shipped claim |
| browser core | supported | browser package gate |
| Astro build in browser/Forge/MV3 | unsupported | negative dependency proof |

Evidence labels are kept precise: `code-backed baseline`, `planned contract`,
`fixture-proven`, `real Astro artifact-proven`, `live Cloud-proven`, `live
DC-proven`, `unsupported`, and `deferred`. An offline Astro build does not prove
Cloud/DC acquisition or deployment.

## 13. Implementation DAG

```text
T0 Contract/security/Astro spike
├── T1 Pre-compose page graph
├── T2 Core publication contracts, routes and cache
├── T3 Web target and per-page macros
└── T4 Astro 7.1 loader/integration spike
T1 + T2 + T3 ──> T5 Refresh, assets and immutable bundle
T2 + T3 + T4 ──> T6 Trusted renderers, themes and charts
T2 + T4 + T5 + T6 ──> T7 Astro builder, Pagefind and output manifest
T5 + T7 ──> T8 CLI lifecycle and verification
T8 ──> T9 Package/API/consumer/CI gates
T9 ──> T10 Docs and real provider proof
```

## 14. Checkable implementation tasks

### T0 — Freeze contracts, threat model, and feasibility gates

- [ ] Re-audit all code-backed seams in section 6 against current `main` and
      record exact SHA/file references in `EVIDENCE.md`.
- [ ] Pin the minimum test lane to Astro `7.1.0`, public peer range to
      `>=7.1.0 <8`, and Node engine to Astro's supported minimum.
- [ ] Prove an offline production Astro build from structured typed data at
      `base: "/docs"`; no Markdown, Confluence request, or generated code.
- [ ] Prove a custom build-time content loader, static catch-all route,
      handwritten-route collision detection, and private `build:done` manifest
      using only documented Astro APIs.
- [ ] Prove that source strings such as `</script><script>` remain inert and
      that source data cannot select/import a component.
- [ ] Spike a trusted static chart and an opt-in island over one frozen,
      schema-validated model; verify useful JS-disabled fallback.
- [ ] Build the same bundle with two structurally distinct theme fixtures and
      freeze semantic slots, tokens, capability negotiation, and override rules.
- [ ] Run a pinned Pagefind proof after the nested-base Astro build; prove
      keyboard search, facets, multilingual partitioning, route correctness,
      deleted-page removal, offline behavior, and deterministic index inventory.
- [ ] Decide whether durable publish jobs are required in V1. Default to direct
      serializable runs; create `@atlcli/publish-jobs` only with an evidenced
      recovery/scheduling requirement.
- [ ] Freeze route, active-attachment, strict/partial, macro freshness, island,
      theme, search, output, workspace, and retention policies.
- [ ] Record a threat model for ADF/Storage/macro input, remote assets, bundle
      paths, Astro build, islands, output directory, and future deployment.
- [ ] STOP and re-plan if Astro needs source-derived code, a networked loader,
      private APIs, unbounded output, or cannot render a complete accessible
      static fallback.

Acceptance: the spike produces a bounded, searchable static directory and
private manifest offline, with two themes, nested-base links, facets, keyboard
search, and hostile content remaining inert. No production package contract is
frozen until this gate passes.

### T1 — Expose the Confluence page graph before document composition

- [ ] Add `ResolvedConfluencePageGraphV1` and
      `resolveConfluencePageGraphV1()` in export wiring.
- [ ] Preserve ordered page/folder nodes, parent/depth/position, per-page
      blocks/notes, source version/metadata, completeness, and summary.
- [ ] Make current `resolveConfluenceSourceV1()` a compatibility wrapper that
      still composes tree/space documents exactly as before.
- [ ] Prove one discovery/body-fetch pass, cancellation, checkpoint/version,
      partial-result, and placeholder behavior.
- [ ] Generate/update public API reports deliberately.
- [ ] Keep all DOCX/PDF resolver fixtures and deterministic artifacts unchanged.
- [ ] STOP if implementation duplicates traversal/fetch, persists raw source,
      changes existing resolver output, or changes document bytes/notes.

Acceptance: publishing can consume the exact pre-compose page graph while all
existing export behavior remains regression-green.

### T2 — Implement core project, diff, route, link, and bundle contracts

- [ ] Add `@atlcli/web-publish` with public-0.x classification, strict ESM,
      browser-safe default entry point, Node filesystem subpath, README, API
      report, and closure report.
- [ ] Implement and validate the versioned contracts from section 9.
- [ ] Implement theme descriptor/selection, capability negotiation, semantic
      slot, design-token, component-override, and search-provider contracts.
- [ ] Extract shared page-link resolution from `compose-document.ts`; keep its
      existing truth table unchanged.
- [ ] Implement stable route registry, custom routes, tombstones, safe slugs,
      deterministic collisions, and case/output-path collision rejection.
- [ ] Implement stable page-local anchors and builder-neutral typed page/asset
      references.
- [ ] Implement canonical JSON/digest functions that exclude volatile/private
      data and reject cycles/dangling references.
- [ ] Implement refresh diff semantics that distinguish delete, exclude,
      out-of-scope, and inaccessible.
- [ ] Unit-test duplicate titles/IDs, rename/move, non-ASCII, long names,
      reserved names, separators, `..`, backslashes, case folding, base paths,
      and ambiguous/out-of-scope links.
- [ ] STOP on title-only identity, duplicated link truth tables, path escape,
      or silent collision/overwrite.

Acceptance: an identical graph/policy yields an identical plan and bundle
digest; route identity survives rename/move; every internal reference resolves.

### T3 — Add explicit web targeting and per-page macro resolution

- [ ] Add `web` additively to Confluence export-control, macro target, source
      resolver, and macro option contracts.
- [ ] Freeze existing DOCX/PDF/Word target truth tables and API output.
- [ ] Resolve macros independently per page with correct page identity and
      page-local TOC/document context.
- [ ] Define closed macro-to-render-model mappings, starting with TOC, Jira
      data, diagram/Mermaid, chart, status, Smart Card, and unknown fallback.
- [ ] Prefer validated SVG/static models for web diagrams/charts.
- [ ] Implement `live`, `no-live`, freshness, dependency, and frozen-provenance
      policies without leaking source data.
- [ ] Prove raw `export_view` HTML never reaches bundle/output.
- [ ] Add Cloud ADF and DC Storage fixture parity for web target behavior.
- [ ] STOP if one page can read another page's local context, existing target
      behavior changes, or raw/source-provided HTML is emitted.

Acceptance: web macro output is per-page, typed, deterministic under frozen
inputs, and does not alter existing export targets.

### T4 — Establish the Astro 7.1 integration/loader contract

- [ ] Add the Node-only `@atlcli/web-publish-astro` package with Astro peer
      dependency and no bundled Astro/private Vite internals.
- [ ] Export the default integration factory and named structured-data loader.
- [ ] Implement loader entry IDs from immutable source IDs, schema validation,
      page digests, metadata revision, and deletion reconciliation.
- [ ] Validate `output: "static"`, URL profile, `base`, `site`, `outDir`, and
      `publicDir` without silently rewriting owner configuration.
- [ ] Inject/enumerate publication routes with `getStaticPaths()` and prove
      prerendering/collision behavior in documented integration hooks.
- [ ] Define an optional trusted user layout entrypoint and ensure content
      cannot influence module resolution.
- [ ] Load only installed operator-selected theme descriptors; validate required
      capabilities/slots and include theme/version/config in the build key.
- [ ] Reserve collision-safe owned paths for Pagefind output and expose the
      standard theme search slots without coupling the loader to one theme.
- [ ] Write the private output manifest outside the public output root.
- [ ] Keep programmatic Astro APIs and experimental collection storage out of
      public contracts.
- [ ] STOP on private Astro/Vite dependency, non-static route, ambient docs-site
      config, or Confluence/network access in the loader.

Acceptance: a packed integration installed into a clean Astro 7.1 project can
load a bundle and build all routes offline.

### T5 — Implement refresh, cache, assets, and atomic bundle activation

- [ ] Implement bounded mutable page/asset cache ports and the default Node
      filesystem store under the project workspace.
- [ ] Compute page reuse from the full cache key, not page version alone.
- [ ] Refresh live dependencies and attachment metadata independently of page
      body versions.
- [ ] Build a complete `PublicationRefreshPlanV1` before mutating active state;
      surface all destructive and partial changes.
- [ ] Reuse existing asset trust routing and SVG validation at the final fetch
      and materialization seam.
- [ ] Validate MIME/magic bytes, size/pixel/node budgets, redirects/private
      networks, digest, safe filenames, root containment, and symlinks.
- [ ] Deduplicate content-addressed assets and preserve safe download names.
- [ ] Stage, validate, digest, and atomically activate immutable bundles.
- [ ] Ensure failed/cancelled refresh preserves the last active bundle.
- [ ] Implement retention/GC by manifest reachability and grace period only.
- [ ] Test concurrent refresh/fencing, crash points, stale writer, abort, corrupt
      cache recovery, failed asset, confirmed deletion, and ambiguous absence.
- [ ] STOP on credentialed external fetch, unsafe original SVG write, glob-based
      delete, cache-as-authority, or mixed/partial activation.

Acceptance: unchanged deterministic pages/assets are reused; changed and live
dependencies refresh; removed content is acted on only with authoritative proof;
the active bundle is always complete and digest-valid.

### T6 — Build exhaustive trusted renderers, themes, and chart capabilities

- [ ] Implement trusted Astro components for every `ExportBlock` and inline
      discriminator with compile-time exhaustiveness.
- [ ] Cover headings/anchors, paragraphs/marks, lists/tasks, tables/spans,
      callouts, code, figures/captions, layouts, expand/details, status, links,
      assets, Smart Cards, and visible unknown fallbacks.
- [ ] Use Astro escaping by default; expose no caller/raw-string `set:html` API.
- [ ] Implement a closed renderer registry with versioned descriptors and
      schema-validated payloads.
- [ ] Implement the versioned theme runtime and semantic slots without exposing
      generated-DOM selectors as a compatibility contract.
- [ ] Ship feature-complete documentation/knowledge-base and minimal-content
      reference themes with responsive navigation, breadcrumbs, page TOC,
      previous/next, search slots, dark/light/system modes, print styles, and
      accessible design-token defaults.
- [ ] Implement and validate a project-owned theme adapter; source content may
      never select or parameterize component/module imports.
- [ ] Implement accessible static chart SVG/HTML from normalized chart data.
- [ ] Implement the optional chart island with frozen data, explicit opt-in,
      byte/row/node limits, no network/auth access, and static fallback.
- [ ] Prove CSP, no event-handler/script/CSS injection, unsafe URL rejection,
      SVG safety, and no opaque datasource/provenance serialization.
- [ ] Prove keyboard/screen-reader semantics and meaningful JS-disabled output.
- [ ] Prove both themes at mobile/desktop widths, high zoom, forced colors,
      reduced motion, light/dark/system modes, print, long titles, deep trees,
      RTL-safe layout, and custom tokens.
- [ ] Add deterministic semantic goldens and browser DOM/a11y tests rather than
      brittle full Astro HTML/CSS whitespace snapshots.
- [ ] STOP if source content can become executable code, disabled JS loses the
      represented information, or unsupported blocks disappear silently.

Acceptance: the all-fields fixture renders safely and accessibly in both
first-party themes and one custom-theme fixture; chart output works statically
and the optional island adds only bounded client interaction.

### T7 — Build static output, Pagefind search, and a private manifest

- [ ] Implement a builder adapter over immutable bundle + trusted Astro project;
      do not expose Astro's experimental programmatic API publicly.
- [ ] Invoke the project-owned build executable/argv with `shell: false`, bounded
      environment, abort/timeout handling, and no inherited secrets by default.
- [ ] Materialize generated assets/routes without overwriting handwritten
      project sources or `public/` files.
- [ ] Build the three URL/base profiles from section 11.
- [ ] Pin Pagefind, annotate canonical content/facets/metadata in trusted
      components, and run the full static indexer after each Astro build.
- [ ] Provide theme-neutral accessible modal and full-page search components
      with keyboard shortcut, worker/main-thread fallback, translated UI,
      filters, result excerpts, and nested-base URL handling.
- [ ] Exclude navigation chrome, private diagnostics, partial/hidden pages,
      redirects, and deleted pages; never index raw bundle/source data.
- [ ] Treat result excerpts safely and prove that indexed hostile text cannot
      become executable markup in either theme.
- [ ] Enforce measured search-index, initial-JS, query-latency, and memory
      budgets on small, representative, and large deterministic corpora.
- [ ] Inventory every generated page/asset/output path and reject unexplained or
      escaping output.
- [ ] Produce `StaticPublicationManifestV1` with bundle, builder, Astro,
      project/config/lockfile, theme, route/asset, Pagefind index, and normalized
      output digests.
- [ ] Prove a build with network disabled and no runtime `/_image` or private
      Confluence dependencies.
- [ ] Prove cold/warm builds of one bundle yield equivalent semantic manifests.
- [ ] STOP on mixed old/new output, source-derived build modules, ambient repo
      docs config, unexpected executable JS, or an unbounded output inventory.

Acceptance: a verified, themed, searchable local static candidate and private
exact manifest are produced from the bundle without any Confluence access or
hosted search service.

### T8 — Add CLI lifecycle, reports, and artifact verification

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
- [ ] Fail on non-empty/unowned output targets; use sibling staging plus
      recoverable promotion for replacement.
- [ ] Report `bundle-ready`, `built`, and `verified`; never `deployed`.
- [ ] Test retry/recovery, stale expected digest, corrupt manifest, symlink
      target, cross-device destination, build failure, and verification failure.
- [ ] STOP if cleanup/delete authority comes from a title/glob or failure leaves
      a mixed visible destination.

Acceptance: the four-stage journey is independently repeatable and `run`
orchestrates it without hiding the plan, bundle, build, or verification digest.

### T9 — Prove packages, consumers, hosts, and required CI

- [ ] Add API/closure reports and deliberate public-0.x classifications.
- [ ] Add browser-build entry only for genuinely isomorphic web-publish core;
      add a negative gate that Astro/Node code cannot enter it.
- [ ] Extend pack checks, publishable-dependency checks, Node consumer smoke,
      Vite/browser consumer smoke, and add a real packed Astro consumer build.
- [ ] Pin Astro `7.1.0` in the minimum fixture and test latest supported 7.x
      separately.
- [ ] Test Ubuntu Node 22.12/Astro 7.1.0, Ubuntu Node 24/latest 7.x, and Windows
      Node 24/Astro 7.1.0 path portability.
- [ ] Add a production Astro publishing harness with Cloud ADF and DC Storage
      synthetic fixtures, assets, links, macros, both first-party themes,
      custom-theme adapter, Pagefind search/facets, chart static/island, and
      strict/partial failures.
- [ ] Serve directory output with a directory-index server and portable-file
      output with a simple file server; crawl every route/link/asset.
- [ ] Run Playwright with JS on/off, CSP, accessibility, offline/no-network,
      privacy, and deterministic-manifest gates.
- [ ] Exercise search by mouse and keyboard in every theme/profile: query,
      empty/no-result, excerpts, anchors, facets, language, Unicode/diacritics,
      large result sets, back/forward, deleted pages, and worker fallback.
- [ ] Measure theme CSS/JS, island JS, search bootstrap/index shards, LCP/CLS,
      search interaction latency, and accessibility budgets; gate regressions.
- [ ] Seed negative fixtures for route collision, path traversal, Node import in
      browser core, XSS, unsafe SVG, private URL, digest mismatch, and missing
      asset; prove each named gate fails.
- [ ] Wire all publishing checks into the required CI aggregator so path routing
      cannot report green after skipping them.

Acceptance: packed real consumers, not source-only tests, prove both the
browser-safe core and Node-only Astro boundary.

### T10 — Documentation, real E2E, and delivery gates

- [ ] Add a task-focused Web Publishing guide, configuration reference,
      theme authoring/migration guide, search/index/ranking guide,
      renderer/chart guide, security/privacy guide, operations/refresh/rollback
      guide, troubleshooting, examples, and related-topic links.
- [ ] Document both first-party themes, the project-owned theme contract,
      tokens/slots/capabilities, Pagefind facets/metadata/languages, search
      accessibility, index budgets, and hosted-provider extension boundary.
- [ ] Document static vs. island vs. live capability and state clearly that
      deployment is deferred.
- [ ] Document `.gitignore`, cache/bundle/build retention, reproducibility,
      visibility/partial warnings, and safe cleanup.
- [ ] Update CLI/package READMEs and docs-site navigation without reusing the
      docs site's Astro theme as customer runtime.
- [ ] Run focused tests, full `bun run test`, `bun run typecheck`, build,
      API/closure, browser, pack/consumer, docs, Astro production harness,
      theme/search performance, link/a11y/security/privacy, and Windows path
      gates.
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
bun run test packages/web-publish
bun run test packages/web-publish-astro
bun run test packages/confluence packages/export-macros packages/export-wiring
bun run test:publish-themes
bun run test:publish-search
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
2. package tests prove graph/macro/assets/Astro integration seams;
3. packed consumers prove published tarballs and dependency boundaries;
4. real Astro production artifacts prove routes, links, assets, CSP/a11y;
5. live Cloud/DC E2E proves provider acquisition only; and
6. remote deployment remains unproven and unclaimed.

## 16. Delivery sequence and commit boundaries

Recommended implementation PR stack/commit boundaries:

1. `refactor(confluence): expose pre-compose page graph`
2. `feat(publish): add publication contracts and route planning`
3. `feat(macros): add web publication target`
4. `feat(publish): add cache and immutable bundle materialization`
5. `feat(publish-astro): add Astro 7.1 loader and integration`
6. `feat(publish-astro): add trusted renderers and theme contract`
7. `feat(publish-astro): add Pagefind search and chart island`
8. `feat(cli): add local web publishing lifecycle`
9. `test(publish): add packed Astro and browser conformance gates`
10. `docs(publish): document static web publishing`

Each boundary must keep existing DOCX/PDF and Markdown behavior green. Draft
PRs stay Draft until their own acceptance gates pass; no automatic release.

## 17. Definition of done

- [ ] T0–T10 are complete with no unresolved STOP condition.
- [ ] Page/tree/space Cloud acquisition and local Astro static output are
      fixture-, packed-artifact-, browser-, and live-E2E proven.
- [ ] DC Storage behavior is fixture-proven and either live-proven or labelled
      honestly as not executed.
- [ ] Immutable bundles build offline and failed refresh/build never replaces
      the last valid state.
- [ ] Route, deletion, asset, dynamic-dependency, and output ownership semantics
      are deterministic and tested.
- [ ] Every block has safe static output; the optional chart island works with
      bounded frozen data and degrades usefully without JavaScript.
- [ ] At least two first-party themes and one project-owned theme fixture pass
      the same semantic, responsive, mode, print, accessibility, and search
      contract without changing routes or indexed content.
- [ ] Pagefind client search is production-built, offline, keyboard-accessible,
      multilingual, faceted, base-aware, privacy-safe, budgeted, and free of
      deleted/excluded/private content.
- [ ] Strict completeness, XSS, SSRF, path, active-content, secret/private URL,
      CSP, accessibility, and privacy gates pass.
- [ ] Existing export and Markdown sync schemas/fixtures/artifacts are unchanged.
- [ ] `wiki publish` reports local bundle/build/verification truthfully and does
      not claim remote deployment.
- [ ] Public APIs, pack/consumer/browser/CI gates and user docs are complete.
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
9. **Theme and search fragmentation:** V1 deliberately includes multiple themes
   and Pagefind, but a theme cannot silently replace route/search/security
   semantics. Hosted search providers, arbitrary catalog-theme compatibility,
   deployment, live runtime, and user code/MDX still require explicit adapters
   or follow-up specs.

## 19. Decisions to confirm before T1

The plan recommends defaults so implementation can begin, but these product
choices should be confirmed at the T0 gate:

1. Is the opt-in interactive chart island part of the first release, or should
   V1 ship static charts only while retaining the renderer capability contract?
2. Which two first-party theme directions should V1 ship? Recommendation:
   feature-complete documentation/knowledge-base plus minimal editorial
   content, both implementing the same slots/capabilities/search contract.
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

## 20. Primary references

- [Astro 7.1 release](https://github.com/withastro/astro/releases/tag/astro%407.1.0)
- [Astro configuration reference](https://docs.astro.build/en/reference/configuration-reference/)
- [Astro content loader reference](https://docs.astro.build/en/reference/content-loader-reference/)
- [Astro integration API](https://docs.astro.build/en/reference/integrations-reference/)
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
- [Starlight plugin ecosystem](https://starlight.astro.build/resources/plugins/)
- [Astro programmatic API](https://docs.astro.build/en/reference/programmatic-reference/)
- [Astro template directives and `set:html`](https://docs.astro.build/en/reference/directives-reference/#sethtml)
