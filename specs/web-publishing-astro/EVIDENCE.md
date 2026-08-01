# Web publishing T0 evidence

This record is scoped to the T0 contract and feasibility gate. It does not
claim that the production packages or CLI lifecycle exist yet.

## Repository baseline re-audit

- Re-audited commit: `9c974bd2277f3acc338f4f8fac38e6536b18aae4`
  (`origin/main`, 2026-07-31).
- `packages/confluence/src/export-blocks.ts:765` still defines the shared
  `ExportBlock` discriminated union. It is consumed by DOCX, Typst PDF, browser
  runtime, extension, and export-wiring code through `@atlcli/confluence`.
- `packages/confluence/src/tree-fetch.ts:138` still exposes ordered
  `ExportPageNode` values with per-page blocks, notes, identity, hierarchy,
  position, version, labels, and space metadata.
- `packages/confluence/src/tree-fetch.ts:348` still returns that page/folder
  graph in `FetchExportTreeResult`; raw ADF/Storage bodies do not leave the
  body-fetch jobs.
- `packages/confluence/src/page-body.ts:20-105` still owns the Cloud
  ADF-primary/Data Center Storage-primary source policy and the neutral decoder
  result. Raw bodies are explicitly transient.
- `packages/confluence/src/compose-document.ts:803` still turns the ordered
  graph into one chapterized document. This remains a DOCX/PDF boundary, not a
  publication input.
- `packages/export-wiring/src/jobs/confluence-source-resolver.ts:381-512` still
  fetches the graph once and calls `composeChapters()` only for tree/space
  document export; the page graph therefore remains available before
  composition.
- `packages/export-jobs/src/request.ts:31-133`,
  `packages/export-jobs/src/source.ts:2`, and
  `packages/export-jobs/src/artifact.ts:4-12` remain a deliberately closed
  DOCX/PDF, one-artifact lifecycle. Web publishing must not extend these V1
  unions.
- Current macro/export controls are also closed to document targets:
  `packages/export-macros/src/deps.ts:13`,
  `packages/export-macros/src/types.ts:366`, and
  `packages/confluence/src/export-blocks.ts:1396,1732` use `pdf|word` or
  `docx|pdf`. A future web target is additive and must retain the old truth
  tables.

No audited seam invalidates the plan. T1 should add a public pre-compose graph
contract around the existing traversal rather than create a second walker.

## ExportBlock extraction freeze

T2 will create dependency-free `@atlcli/export-blocks` and move only the model,
schemas, and pure model helpers. It will not move ADF/Storage parsers,
Confluence clients, acquisition policy, Node APIs, or renderers.

The first extraction commit must keep `@atlcli/confluence` compatibility
re-exports, so existing DOCX, PDF, browser, extension, and export-wiring imports
continue to compile unchanged. The new Astro render kit imports the neutral
package directly. Deliberate consumer migrations may follow only after API,
browser-entry, tree-shaking, packed-consumer, and deterministic-artifact gates
prove there is no widened dependency surface.

## Astro 7.1 cohort

The frozen minimum lane is:

| Component | Version / range | T0 result |
| --- | --- | --- |
| Node | `>=22.12.0`; tested `22.18.0` | package engine, network-disabled production builds, and packed-consumer gate |
| Astro | official `7.1.6`; peer `>=7.1.6 <8` | clean install, check, and production builds |
| Starlight | `0.41.5` | production static build and browser proof |
| MDX | `7.0.5` | exact cohort; uses Markdown runtime only as a Starlight dependency, not as publication input |
| Markdown Remark | `7.2.2` | exact Astro 7.1.6 cohort |
| Markdown Satteri | `0.3.5` | exact cohort |
| Internal helpers | `0.10.2` | exact cohort |
| Sitemap | `3.7.3` | nested-base sitemap generated |
| Expressive Code | `0.44.1` | Starlight override rendered with copy action |
| Pagefind / default UI | `1.5.2` | multilingual post-build index and browser search |
| Sharp | `0.34.5` | network-disabled AVIF/WebP/PNG transforms |
| Plausible tracker | `0.4.5` | optional build only; default output contains none |

An automated advisory temporarily classified `astro@7.1.0` as malicious, but
the source OSV record `MAL-2026-10726` is withdrawn as a false positive and the
remaining GitHub Advisory Database entry is tracked as false-positive issue
[#8871](https://github.com/github/advisory-database/issues/8871). The
isolated dependency tree was paused and inspected: the named dependencies have
legitimate upstreams, no suspicious install hooks were present, and no
exfiltration/persistence primitive was found in the executed entrypoints. T0
still regenerates all final evidence on the current official `7.1.6` patch so
the minimum lane does not freeze a superseded `.0` release.

After all root and workspace dependency trees were moved aside, the frozen-lock
install completed with 445 packages and no peer warnings or lock changes.
The exact overrides follow Astro 7.1.6's own Markdown peer and runtime
dependencies so the minimum lane cannot silently split into two cohorts.
The nested Bun workspace selects the documented `hoisted` linker explicitly:
Astro's generated prerender entry imports Astro-owned runtime dependencies from
the site output, while Bun's isolated workspace linker deliberately does not
make transitive dependencies visible there. Published consumers still declare
only Astro and the render kit; this is a fixture package-manager setting, not a
new public dependency.

The previously considered PWA plugin does not support this Astro lane. PWA,
service workers, installability, and runtime offline caching are therefore a
separate future compatibility spike and are absent from every T0 output.

## Dynamic chart adapter candidate

The separate chart spike originally built Astro `7.1.6`, `@astrojs/react`
`6.0.1`, React `19.1.1`, `@tanstack/charts` `0.0.2`, and
`@tanstack/react-charts` `0.0.2` as a static Astro site. The resulting HTML
contained the full accessible SVG before hydration, and the opt-in React island
hydrated successfully. This historical experiment proves the technical Astro
integration shape, not the version shipped by the render kit.

TanStack Charts' own [repository](https://github.com/TanStack/charts) documents
a framework-neutral grammar, static SVG/SSR, hydration, responsive themes,
interaction, accessibility, and export, which align closely with the frozen
adapter boundary. The same source explicitly labels
[release `0.0.2`](https://github.com/TanStack/charts/releases/tag/v0.0.2)
pre-alpha and not ready for production. The current render kit has since
re-run the compatibility gate against the available `@tanstack/charts`
`0.3.1` package and pins that exact version in both
`packages/export-blocks-astro/package.json` and `bun.lock`. It is used only
behind the closed `tanstack-v0.3` `ChartRendererAdapter` for the bounded,
opt-in bar-chart profile; chart definitions, callbacks, and functions never
enter the publication bundle. The adapter remains replaceable and its
pre-alpha status is an explicit product risk, not a claim of general chart
feature completeness.

## Artifact and browser proofs

The private spike is under `specs/web-publishing-astro/spike/`. Its publication
input is JSON containing typed per-page blocks; it creates no Markdown, MDX,
`.astro`, JavaScript, or component-import source from publication data.

Proven locally on 2026-07-31:

- the complete frozen-lock install and both final production builds pass under
  Node `22.18.0`, within Astro's minimum supported Node 22 lane;
- both the plain and Starlight sites pass `astro check` on official Astro 7.1.6;
- both production builds pass with Node network primitives blocked and Astro
  telemetry explicitly disabled;
- the Starlight output builds at `base: "/docs"` with a custom documented
  content loader, static catch-all routes, a private `build:done` inventory,
  and explicit collision failure for `/publish/reserved`;
- the same structured bundle renders in plain Astro and Starlight;
- a tar-packed plain Astro consumer depends only on Astro and
  `@atlcli/export-blocks-astro`, contains no `src/`, and builds the historical
  all-fields fixture without Starlight, Confluence, auth, Pagefind, loader,
  deployment, service-worker, or runtime-cache dependencies; the fixture covers
  every block family and inline type, public block/inline subpath composition,
  trusted overrides, tokens, print/RTL attributes, visible future-type
  fallbacks, unsafe-link rejection, and account-ID non-disclosure;
- hostile `</script><script>` chart text remains inert;
- the chart has a useful semantic static table with JavaScript disabled and an
  allowlisted progressive island with JavaScript enabled;
- Starlight's paragraph and Expressive Code overrides change presentation while
  the neutral package retains its complete semantic fallbacks;
- Pagefind search works by mouse and `ControlOrMeta+K`, returns the expected
  nested-base URL, exposes language/space/type/label facets, indexes English,
  German, and Arabic independently, and removes deleted pages on a same-output
  rebuild;
- the final Starlight experience has locale-correct real language targets,
  RTL output, derived navigation, breadcrumbs, TOC, previous/next, deterministic
  related pages, label landing pages, and a Starlight 404 whose search dialog
  works;
- canonical, OpenGraph, intentional robots, sitemap, valid existing hreflang,
  and escaped JSON-LD output are generated at the nested base;
- vendored Inter fonts and build-time AVIF/WebP/PNG `srcset` assets are emitted
  without network access and no runtime `/_image` endpoint exists;
- Cloud `edit` and Data Center `webui` provider relations render with truthful
  labels; a relation on an untrusted origin renders no action;
- analytics is `none` by default with no tracker code/configuration in output;
  the optional Plausible build accepts only an allowlisted HTTPS `/api/event`
  endpoint, strips query/fragment/referrer/properties from pageviews, has no
  persistent queue/replay, and leaves all content usable when CSP blocks the
  endpoint; and
- no `manifest.webmanifest`, `sw.js`, or `service-worker.js` is emitted.

The production Pagefind hook now measures the generated index through the same
main-thread runtime used by the search island. The deterministic budget suite
(`packages/web-publish-astro/src/search-budget.test.ts`) covers 3, 24, and 100
pages and gates total index bytes, `pagefind.js` initial JavaScript, seven-query
P95 latency, and post-initialization heap delta. The V1 limits are respectively
1 MiB / 4 MiB / 16 MiB for the three corpus classes, 256 KiB initial JS, 500 ms
P95, and 128 MiB heap delta. The suite also proves that an explicitly stricter
budget fails the build; the normal Astro integration invokes the same gate after
every Pagefind write.

On 2026-08-01 the standard bundle-to-render bridge was added and proved with
the Starlight publication consumer. `createPublicationRenderContextV1` maps
`PublicationPageV1`/`PublicationBundleV1` to the render kit without source
fetches, resolves base-aware page/anchor/attachment links, maps verified
content-addressed assets and download names, and rejects unsafe routes,
asset paths, and external schemes. The consumer build asserts that an
attachment link becomes a local `/docs/assets/...` URL; no Confluence source
URL is synthesized or emitted. Asset IDs are retained in first-use order in
the page contract so this mapping does not persist source URLs in public page
JSON. Focused adapter, renderer, Starlight consumer, typecheck, API-report,
and closure gates pass; packed consumer tests that require the sandbox temp
directory remain separately marked for the escalated CI lane.

The CLI publishing lifecycle now has explicit `plan`, `refresh`, `build`,
`verify`, `run`, `status`, and `prune` routing plus shell completion. `verify`
binds the selected manifest to the active bundle, project/config/lockfile
digests, Astro 7.1.6 and Starlight capability declaration, then invokes
`verifyAstroStaticPublicationOutputV1`. That verifier crawls the private
inventory and public output, rejects extra/missing/symlinked files, checks all
bytes and manifest/search/SEO digests, checks edit-link source partitions,
crawls base-aware internal links and fragments, and rejects active-content URL
sinks, private Confluence/API URLs, bundle-internal references, and disabled
analytics. The Astro builder stages an existing output and inventory sidecar
under explicit temporary sibling names and restores both on build/inventory
failure; the rollback is covered by the builder test. Focused CLI, builder,
command, manifest, and output-verifier tests pass, including explicit public /
partial acknowledgement, field-path validation without private-value echo,
symlink/extra-output rejection, and hostile-content/URL-marker rejection.

The first T11 package-boundary lane is now proven. `bun run check:browser`
passes all 29 isomorphic entrypoints, including `@atlcli/export-blocks` and
the browser-safe `@atlcli/web-publish` core; Astro/Node publishing packages
remain outside that browser graph. The publishable package set passes dist
hygiene, private-workspace dependency, API-report, closure, and `bun pm pack`
checks. The real opt-in consumer suite passes tarball, file-link, Node 22, and
Vite/browser consumers with DOCX/PDF output. The standalone plain-Astro packed
consumer and the full packed Starlight publishing consumer both install from
local tarballs with network disabled and build from `dist` only. Workspace
Astro packages now expose the development condition for in-repo consumers;
pack stripping removes it and restores the manifest byte-for-byte.

The required reusable CI quality workflow now has a blocking `publishing` job
that runs the packed plain-Astro and Starlight consumers, package/pack gates,
and the opt-in Node/Vite consumer smoke. Its result is part of both the
security-attestation dependency and the fail-closed `quality-complete`
aggregator; the workflow policy tests assert that this lane cannot be skipped
while reporting the product gate green.

The packed plain-Astro consumer now asserts that its installed runtime has no
Starlight, Confluence, web-publish, Pagefind, deployment, service-worker,
analytics, or edit-link dependency and builds with all network requests
blocked. The Astro consumer harness also serves both the nested-directory and
nested-portable artifacts through their respective URL rules, then fetches
every inventory output and every same-origin `href`/`src` discovered in the
representative page. The focused consumer run passed 5 tests and 139
expectations.

The complete Starlight visual matrix passed on 2026-08-01 with seven Playwright
tests. It covers desktop/mobile responsive navigation, color modes, forced
colors, reduced motion, print and zoom, RTL plain-Astro keyboard access,
Expressive Code controls, browser performance budgets, the production
Starlight search dialog's mouse opening, result navigation, back/forward, and
keyboard focus/closing path, JavaScript-off static rendering, CSP, blocked
external requests, and privacy markers. The visual fixture server explicitly
allows only `wasm-unsafe-eval` (never broad `unsafe-eval`) because Pagefind's
WASM index requires that narrowly scoped directive. A direct packed-consumer
Pagefind matrix additionally passed query/no-result, excerpt, anchor/sub-result,
label/language facets, English/Arabic partitioning, diacritic normalization,
and worker-disabled main-thread fallback; the deterministic 3/24/100 corpus
budget suite covers the large-result-set gate. The deterministic cold/warm
manifest proof remains in the package consumer and builder tests. Named
negative fixtures are covered by the loader route/path tests, the browser-core
negative import gate, the packed hostile-content consumer, SVG/link security
tests, and the output verifier's digest/private-URL/asset checks.

The same browser run includes a semantic accessibility budget: exactly one
`main`, one level-one heading, and one Pagefind body region; every image has an
`alt` attribute and every button has a browser-recognized accessible name. The
packed Starlight consumer also measures the production output inventory and
asserts the static CSS/JavaScript/search-index budget, required Pagefind
runtime files, and page-count floor. The visual search path records a five
second upper bound for a query after the dialog is open. These gates cover the
shipped fixture's static and browser behavior; they do not claim a universal
performance score for arbitrary customer themes or content sizes.

The analytics/edit-link matrix also passed on 2026-08-01. The runtime test
executes the generated Plausible snippet with hostile query/fragment/path data,
asserts a pathname-only `credentials: omit` request, proves a CSP-blocked
endpoint is non-fatal, and proves DNT suppresses the request. The output
verifier test accepts the enabled marker/CSP/privacy declaration plus a
provider-returned same-origin Confluence edit action, while the existing
Cloud-`editui`/Data-Center-`webui` tests cover present, missing, unsafe-origin,
public-disclosure, and internal-visibility cases. No source ID, tenant URL,
search term, query, fragment, cache, or replay payload is indexed or emitted.

The documentation checkpoint passed on 2026-08-01. It adds the task-focused
`/publishing/` guide, configuration, adapter authoring/migration, search and
ranking, renderer/chart, security/privacy, operations/rollback, and
troubleshooting pages, plus the standalone ExportBlock Astro reference. The
Astro sidebar and package/README boundaries are updated without coupling the
customer runtime to the docs site's theme. `bun run test scripts/docs-links.test.ts`
passed 4 tests, `bun run docs:check` passed with zero diagnostics, and
`bun run docs:build` generated all 87 documentation pages and a local Pagefind
index.

The T10 recovery matrix is now explicit. `builder.test.ts` proves that a
corrupt fresh Astro inventory restores the previous output and private
inventory byte-for-byte, and that a symlinked output target is rejected without
touching its referent. The immutable bundle suite proves retry after an expired
activation lease, stale expected-bundle fencing, corrupt-manifest retention,
cancelled/incomplete candidate rejection, and symlinked project-owned paths;
the builder suite proves build-failure rollback, while the output verifier
suite proves verification-failure rejection. Promotion uses sibling staging
paths for both output and inventory, so the rename boundary stays on the
destination filesystem and an `EXDEV` cross-device move cannot produce a
mixed visible destination.

The unchanged DOCX/PDF/browser source boundary was re-proven with the existing
`@atlcli/confluence` imports: 450 tests across ExportBlock conversion,
composition, source resolution, DOCX browser runtime/serialization, and Typst
PDF serialization pass with two snapshots and 1,381 expectations. T0 changes
no production import, schema, or artifact path.

Starlight emits one known non-fatal warning that its conventional `docs`
collection is empty. The spike intentionally uses a separate structured
`publicationPages` loader and the documented public `StarlightPage` component
instead of pretending publication JSON is Markdown/MDX. T7 must eliminate that
warning through a documented Starlight integration path or an upstream change;
it may not silence it by adding fake Markdown or relying on private content
semantics.

The live local inspection URL for this milestone is
`http://127.0.0.1:4327/docs/publish/`.

## Reproducibility finding

Identical cold/warm Starlight builds produce the same semantic page/search
inventory. Pagefind 1.5.2 can nevertheless change some compressed filter/meta
filenames and bytes, which changes the physical artifact digest. T0 therefore
records both a stable semantic digest and a complete sorted physical inventory.
Production verification must bind the deployed candidate to its actual
artifact digest while reproducibility comparisons use the semantic manifest;
it must not falsely promise bit-identical Pagefind output.

The retained final manifests record:

| Experience | Semantic digest | Physical artifact evidence |
| --- | --- | --- |
| Plain Astro | `30b00fe46bd212f853968726c9732a4e6eafbf0e31f7c8401a809a9a8dace1fd` | 7 pages / 8 files |
| Starlight cold | `599477076cc1a2f043bfb78f5f96331a9f3af20288f0419eeca451a2adc4fc00` | 15 pages / 83 files; artifact `cae8186bfc1e32af28d63e8f8e3a4f5757bee1bb16b76698c9bc6c67d80138cf` |
| Starlight warm | `599477076cc1a2f043bfb78f5f96331a9f3af20288f0419eeca451a2adc4fc00` | 15 pages / 83 files; artifact `2b5e0b44a8273cb9ec9522067afd9907b544e2a79094b6064f79c6d084bd1832` |

## Commands retained as proof recipes

```bash
bun install --frozen-lockfile
bun run test
bun run typecheck
ASTRO_TELEMETRY_DISABLED=1 NODE_OPTIONS=--import=<spike>/scripts/no-network.mjs <node-22>/node <spike>/node_modules/astro/bin/astro.mjs build # run from each site directory
node scripts/packed-consumer.mjs
node scripts/inventory.mjs plain
node scripts/inventory.mjs starlight
```

Runtime tests and provider E2E beyond T0 are still required by T1-T12. This
evidence does not claim live Cloud/DC acquisition or remote deployment.

## T11 production Astro harness

The packed Starlight consumer test now includes a production-shaped fixture
lane. It constructs one Cloud ADF document and one Data Center Storage
fragment, passes both through `adfToBlocks`/`storageToBlocks` and the injected
`defaultRegistry`/`resolveMacroBlocks` web target, and asserts that no raw ADF
or Storage markup reaches the normalized blocks. The fixture covers a heading,
paragraph, Cloud Jira datasource card, TOC, Storage table, and an unknown
Marketplace macro with a visible fallback. The resulting pages are digested,
written into a complete immutable bundle, and consumed through a packed
Astro/Starlight project with Astro `7.1.6`, Pagefind, base-aware routes, and
localized output. The same harness also builds a static TanStack chart and an
opt-in interactive chart island, and proves that a `complete: false` bundle is
rejected before Astro loading. The focused test passed on 2026-08-01 with 27
expectations; the required CI publishing job already runs the containing
`starlight-renderer.test.ts` file.

## T12 live Cloud evidence (2026-08-01)

The required read-only Mayflower Cloud run was exercised against the authorized
Content Drafts tree and kept strictly local. The tree refresh produced a
complete 34-page bundle; the Astro directory build then passed output
verification with 127 owned files, 2,572 internal links, and 515 fragment
anchors. The browser check used the public route
`http://127.0.0.1:4391/docs/publish/content-drafts/` and a content-rich child
route. Starlight navigation, breadcrumbs, related pages, previous/next links,
heading anchors, and the Pagefind modal were inspected; a `Scrum Master` query
returned five results. No source identifiers, titles, bundle files, or assets
are retained in the repository.

The complete DOCSY-space plan also completed at 98 pages, but strict refresh
activation remains blocked by one stale reference to a missing attachment. A
read-only attachment check confirmed that the referenced file is absent; no
remote mutation was attempted. Therefore this evidence claims the authorized
tree build only, not a successful full-space activation.

## T12 local URL proof (2026-08-01, root directory profile)

After the provider run, the activated Content Drafts bundle was rebuilt with
the root-base Astro directory profile and passed the CLI output verifier:
127 owned output files, 2,572 internal links, and 515 fragment anchors. The
local static server is serving that verified output at
`http://127.0.0.1:4391/publish/content-drafts/`.

The in-app browser inspection confirmed the Starlight experience on the
overview and on a content-rich child page: responsive navigation, breadcrumbs,
related pages, previous/next navigation, heading anchors, theme selection, and
the Pagefind search dialog rendered. Searching for `Scrum Master` returned five
results. The browser console had no warning/error entries during the check.

The full `DOCSY` space remains intentionally unactivated for this proof because
strict acquisition rejects the stale missing attachment described above. This
URL is therefore a verified, complete subtree publication, not a claim that
the entire space has been published.

## T12 full DOCSY-space proof (2026-08-01)

The previous subtree-only caveat is superseded by the explicit full-space
acceptance run below. A read-only Cloud plan against the `DOCSY` space found 98
pages and a complete authoritative traversal. Refresh and activation used the
operator-approved `allow-partial` asset policy solely for source-reported asset
acquisition failures: three references were rendered as visible unresolved
fallbacks and recorded as `blocked-asset` warnings. No page was omitted and no
remote Confluence content was changed.

The full bundle was built with Astro `7.1.6` and passed the CLI verifier:

- 98 published page routes;
- 256 owned output files;
- 13,070 checked internal links;
- 905 checked fragment anchors;
- Pagefind search index and SEO discovery artifacts present.

The in-app browser inspected the full-space root at
`http://127.0.0.1:4391/publish/docsync-startseite/`, the nested attachment
page, Starlight navigation/breadcrumbs/related/previous-next links, theme
selection, and the Pagefind dialog. Searching for `Scrum Master` returned the
expected full-space result. The nested attachment page visibly retained the
unavailable media and file references as safe fallbacks rather than emitting a
dangling asset URL.

Two full-space regressions found during this run are now covered by focused
tests: page records below non-page Confluence folder containers are promoted to
explicit publication roots; equal content-addressed assets are copied once;
and stale page-local anchors resolve to the visible unresolved-link fallback.

## T12 output-profile and artifact-boundary proof (2026-08-01)

The same complete DOCSY bundle was also built and verified with the
`portable-file` output profile under the `/docs` base path. The portable build
passed with 256 output files, 13,070 checked internal links, and 905 checked
fragment anchors (`buildDigest`
`e8df14de40c2fd53688575729ccd734f8551f54bf162357cccb74ab061b0c1e8`). The
in-app browser verified the base-aware overview URL
`http://127.0.0.1:4391/docs/publish/docsync-startseite` and the nested route
`http://127.0.0.1:4391/docs/publish/copy-of-attachment-test-page`; headings,
breadcrumbs, related-page links, previous/next navigation, theme controls, and
the Pagefind search entry point rendered correctly.

The final handoff output was then rebuilt with the root `directory` profile and
verified again (`buildDigest`
`a3f4187fbf99f4c8fc2720b219a8afae2120901cf0ee22dbf172f23e33934535`) with the
same 256 files, 13,070 links, and 905 anchors. The final root URL is
`http://127.0.0.1:4391/publish/docsync-startseite/`.

All Astro output, local bundles, inventories, and server state remain under the
untracked `.tmp-web-e2e/` directory (or test temporary directories). Only
source, tests, and this evidence record are eligible for the Draft PR; no
generated Astro output is committed.

## T12 current mayflower re-run (2026-08-01)

The live read-only `mayflower` run was repeated from the current branch against
the `DOCSY` space and completed successfully in the private `.tmp-web-e2e/`
workspace. The traversal remained complete at 98 pages; the explicit partial
asset policy produced three visible `blocked-asset` warnings without dropping
pages. The run built and verified the same 256 output files, 13,070 internal
links, and 905 fragment anchors. The current verified build digest is
`d238e0fdb07abdac0fc3e1dde9330b415c2fb15816553a452d75d820e3c01cb6`, bound to
bundle digest
`356bc0ff9921df83111f41a2e9ed2a9b60db908c808f8d498db7cbd03f36b497`.

The in-app browser then inspected the root URL
`http://127.0.0.1:4391/publish/docsync-startseite/` and the nested attachment
route `http://127.0.0.1:4391/publish/copy-of-attachment-test-page/`. The root
heading, Starlight navigation, theme controls, Pagefind dialog, and a
`Scrum Master` query (one result in this current corpus) rendered correctly;
the nested page rendered its heading, breadcrumbs, related pages, and
previous/next links. No warning or error console entries were observed.

## T11 consumer-smoke portability proof (2026-08-01)

The pinned Bun 1.3.14 consumer lane exposed a current EEXIST spelling emitted
by filesystem-link installs (`EEXIST: File or folder exists: failed to link
package: ... (link)`). The retry classifier now accepts only that exact
version/package/signature family, ignores only Bun's matching install-summary
lines, and still fails closed on mixed or mutated errors. The focused parser
tests pass, and the full consumer smoke suite passes locally with 9 tests and
0 failures, including tarball, filesystem-link retry, Node-LTS, and Vite
consumer exports.

## T2-T10 STOP-condition audit (2026-08-01)

The remaining STOP conditions were audited against the focused contract suites and
the current production-shaped DOCSY run. Route identity/collision/path rules and
page-local macro context are covered by the publication graph, digest, and
web-macro-resolution tests. Asset trust, SVG, external-fetch, cache, and atomic
activation rules are covered by the export-media, web-publish cache, refresh, and
builder suites. The standalone render kit and Starlight adapter prove that source
content cannot select modules, that unsupported content stays visible as a safe
fallback, and that Starlight does not become an acquisition/build authority.
The Astro output verifier and builder reject mixed or unowned output, source-derived
modules, symlink targets, ambient configuration, active content, private URLs, and
unbounded inventories. Analytics/edit-link tests and the final private manifest
prove `analytics: none`, an empty edit-link inclusion set for the DOCSY run, and
digest-bound search/SEO/output inventories. Lifecycle tests cover stale writers,
failed promotion, cleanup ownership, and recovery without glob/title deletion.

The latest local verification commands were:

```text
bun run typecheck                  PASS
bun run build                      PASS
bun run test --max-concurrency=1  6193 passed, 15 skipped, 1 unrelated timing-flake
isolated export-job runtime retry  PASS
```

The one full-suite timing failure was the existing JSONL monitor assertion in
`export-job-runtime.test.ts`; the same test passed in isolation immediately after
the full run. The required PR CI matrix is the final gate: all four Linux Bun
shards, pinned consumer smoke, Astro 7.1.6 on Ubuntu Node 22, latest Astro 7.x on
Ubuntu Node 24, Windows Node 24, typecheck/browser/build, publishing consumers, and
the required aggregator passed in run `30705797902`. Non-required timing telemetry
is intentionally outside that gate.

## T11/T12 final verification and cleanup boundary (2026-08-01)

The minimum fixture pins Astro `7.1.6`; the required CI matrix proves the minimum
Ubuntu Node 22.12 lane, latest supported 7.x on Ubuntu Node 24, and Windows Node 24
path portability. The real read-only Cloud E2E used `mayflower` against `DOCSY` and
the complete 98-page space, with the explicit partial asset policy retaining all
pages and surfacing three visible blocked-asset fallbacks. No Data Center provider
was available for a live run; DC behavior is fixture-proven and the live provider
lane is explicitly `not executed`.

No remote test resource was created. Generated Astro output, bundles, inventories,
and the local static server remain only in the untracked `.tmp-web-e2e/` handoff
directory so the verified URLs remain inspectable. The generated output is not part
of the commit or Draft PR; the separate generated Astro consumer fixture output was
removed after verification. The only repository changes in the final handoff are
source/tests and plan/evidence documentation, with the pre-existing user-owned
`apps/cli/src/index.ts` modification left unstaged.
