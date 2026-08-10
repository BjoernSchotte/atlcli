# Confluence-to-public-site market and JTBD research

**As of:** 2026-08-01
**Scope:** Publishing a Confluence page tree or space as an external public
HTML/static documentation or knowledge site. This is product research, not a
claim that every referenced vendor capability is implemented by atlcli.

## Executive conclusion

The user job is not merely *"export Confluence as HTML"*. It is to turn a
private, collaborative Confluence authoring area into a trustworthy public
documentation product, without duplicating content, exposing the authoring
space, or accepting Confluence's reader experience as the public experience.

The planned architecture is strategically well aligned with that job:

```text
Private Confluence source
  -> explicit, auditable acquisition and immutable bundle
  -> macro/asset normalization and completeness gate
  -> theme-neutral ExportBlock Astro components
  -> customer-owned static output, CDN, domain, and deployment
```

Its architectural differentiation is reproducibility, customer-controlled
hosting and a privacy-preserving build boundary. This is a differentiation
claim about this architecture, **not** a claim that hosted Marketplace products
cannot offer similar outcomes. To compete as a publishing experience, V1 must
also close table-stakes gaps: deliberate scope/release control, polished
navigation and search, SEO, macro fidelity with fail-closed behaviour, and
branding/deployment seams.

## Evidence classifications

- **User evidence** is a concrete user question, report, or stated problem.
- **Vendor evidence** is a current Marketplace listing or vendor material. It
  proves the vendor's stated offering, not independent customer demand.
- **Product inference** is our conclusion from the evidence and is explicitly
  labelled as such.

## The jobs users are hiring a publisher to do

| Job to be done | Evidence | Implication for atlcli |
| --- | --- | --- |
| Publish existing internal product documentation for customers, partners, prospects, search engines, and AI assistants without moving it to another CMS. | A user asks to extend Confluence documentation to partners/customers; the accepted response recommends a standalone public site. [Community](https://community.atlassian.com/t5/Confluence-questions/My-product-documentation-is-on-Confluence-I-want-to-extend-it-to/qaq-p/2908656) | Make Confluence the authoring source, not the public runtime. Keep the acquired bundle repeatable and independently deployable. |
| Keep the authoring space private while releasing only reviewed content. | A user explicitly calls anonymous access a “big no-no” and prefers private source to separate public target when final. [Community](https://community.atlassian.com/forums/Confluence-questions/Is-there-a-way-to-have-a-page-tree-for-public-pages/qaq-p/2885667) | Scope allowlists, immutable complete bundles, dry-run/diff, preview/promote/rollback, and no runtime Confluence access are core. |
| Give readers a real documentation site rather than a stripped or branded Confluence UI. | A user cannot remove Cloud logo/global navigation/Create/byline/sign-in and uses Viewport for a custom-domain docs site. [Community](https://community.atlassian.com/forums/Confluence-questions/customizing-look-and-feel-of-confluence-cloud/qaq-p/1528546) | First-class Starlight experience, theme-neutral body renderer, semantic component slots, custom-domain/base support, and future theme adapters matter. |
| Preserve the page-tree mental model and make a large documentation set discoverable. | Public links work in isolation but lose page-tree content; users ask for a public tree rather than manual reconstruction. [Community](https://community.atlassian.com/forums/Confluence-questions/The-page-tree-cannot-be-viewed-in-public-links-anymore/qaq-p/2766497) | Stable routes, hierarchy, breadcrumbs, page TOC, previous/next, related pages, root/label landings, accessible search, and a searchable 404 are baseline rather than polish. |
| Be found and look credible on an owned domain. | Users ask about custom domains and professional presentation. [Community](https://community.atlassian.com/forums/Confluence-questions/Can-i-add-a-own-Domain-to-a-space-or-whole-Conluence-cloud/qaq-p/1610556) | Build at arbitrary base/domain, preserve stable slugs and redirects, and generate sitemap/canonical/robots/OG/schema rather than relying on Confluence discovery. |
| Preserve meaningful content such as included pages, diagrams, charts, and attachments safely. | Public links can show an authorization notice for an included public page; Community discussion describes missing page tree/breadcrumbs and macro limitations. [Include-page evidence](https://community.atlassian.com/forums/Confluence-questions/Public-Confluence-pages-with-page-inclusions/qaq-p/2551575), [public-link limits](https://community.atlassian.com/forums/Confluence-questions/Difference-between-public-link-and-anonymous-access/qaq-p/2338738) | Maintain a published macro support matrix, map supported macros to trusted components, snapshot dynamic inputs, provide safe static fallbacks/original downloads, and fail closed with actionable diagnostics. |
| Publish correct static deep links, media and cross-page links. | A static HTML export user reports mixed relative and fully-qualified internal links that break the published documentation. [Community](https://community.atlassian.com/forums/Confluence-questions/Export-pages-space-to-HTML-inter-page-links-are-created-in-two/qaq-p/1284173) | Route/link/anchor rewriting, base-profile testing, asset materialization, output-link verification, and redirect checks are acceptance gates. |
| Control cost when only a small function maintains docs but Confluence has many seats. | A user with 200 Confluence employees says a $350/month app cost does not make sense for a small documentation function. [Community](https://community.atlassian.com/forums/Confluence-questions/Is-there-a-way-to-have-a-page-tree-for-public-pages/qaq-p/2885667) | Customer-owned static hosting and a non-seat-shaped local build model are a promising positioning seam. Do **not** claim universal price superiority without current tier-by-tier validation. |

## Marketplace landscape

| Product | Current, verified positioning | What it establishes for the category | Caveat |
| --- | --- | --- | --- |
| [Refined for Confluence Cloud](https://marketplace.atlassian.com/apps/1221322/refined-for-confluence-cloud?tab=overview) | Marketplace listing reports 2,556 installs and advertises public/private branded sites, audience-aware navigation/content, templates, AI search, analytics, audit logs, IP allowlisting, JSM and supported macro rendering. Standard/Advanced editions distinguish published-site/domain limits. | Enterprise benchmark for branded multi-audience Confluence publishing and governance. | Vendor listing; exact current price was not reliably available in this research and is deliberately not inferred. |
| [Scroll Viewport / Scroll Sites](https://www.youtube.com/watch?v=qm-Pgku0DIg) | K15t describes themed sites, custom domains, public/restricted sites, analytics/article-feedback/incident integrations, translations, versions and variants. A Community answer describes CNAME/CloudFront and SSO use without anonymous spaces. [Community](https://community.atlassian.com/forums/Confluence-questions/Looking-for-Alternatives-to-Share-Confluence-Content-as-a/qaq-p/3136926) | Documentation-specialist benchmark for versioning, localization, variants and restricted-reader delivery. | Vendor material and Community answer; not proof of a purely static/export architecture. |
| [Capable Sites for Confluence](https://marketplace.atlassian.com/apps/528130293/capable-sites-for-confluence-website-intranet) | A closely aligned, recently launched app: vendor materials state static HTML, scoped publishing, staging/promote workflow, themes with search/sidebar/TOC, custom branding/domain, SEO controls, ZIP export and macro support. [Launch explanation](https://www.gocapable.com/blog/introducing-capable-sites-for-confluence) | Closest feature benchmark: fidelity, governed scope/release, branded static site, SEO and deployment ergonomics must be visible in the product story. | Vendor claims only; do not claim parity without feature-by-feature proof. |
| [Instant Websites for Confluence](https://marketplace.atlassian.com/apps/1214121/instant-websites-for-confluence) | Marketplace listing reports static public sites on a company domain, AWS hosting, automatic update publication, and exclusion of private pages/comments. | Focused baseline for “publish a space as a website.” | Hosted vendor model; no conclusion about its implementation details. |
| [Public Pages for Confluence](https://marketplace.atlassian.com/apps/356517983/public-pages-for-confluence) | Marketplace listing advertises selected pages, clean URLs, title/meta, robots, sitemap, Search Console verification, GA4, branding/custom domain and light/dark mode. | SEO and basic reader experience are expected even for a narrower selected-page publisher. | Vendor listing. |

## Detailed competitive capability matrix

This is the decision table for assessing **each researched product**. Every
competitor statement below is vendor evidence unless explicitly labelled
otherwise. `P0` means necessary before atlcli makes a credible public-site
claim; `P1` is a strong next differentiator; `P2` is adapter/hosting-dependent
or should wait for a separately evidenced workflow. “Atlcli status” describes
the plan/current implementation direction, not a release claim.

| Capability | Refined Sites | Scroll Sites / Viewport | Capable Sites | Public Pages | Instant Websites | Atlcli status and implication | Classification / priority |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **Scope and multiple targets** | Curates Confluence content, external links and Refined pages into audience-specific sites; multiple sites are an Advanced-edition capability. [Product](https://www.refined.com/products/sites-for-confluence) | A site accepts multiple Confluence spaces or Scroll Documents sources. [Docs](https://help.k15t.com/scroll-viewport/add-and-remove-content-sources) | Selected one or more spaces, reorderable, with portal/home-space options. [Docs](https://help.gocapable.com/sites/choose-scope.html) | Selected individual pages; multi-space portal was not documented. [Product](https://typeswitch.net/public-pages-for-confluence/) | Per-space site model. [Marketplace](https://marketplace.atlassian.com/apps/1214121/instant-websites-for-confluence) | Page/tree/space scopes and immutable page graph exist in the plan. Add multiple roots/spaces, explicit ordering, external nav entries and per-target configuration. | **Parity required P0**; multi-space portal **P1**. |
| **Preview, promotion and rollback** | Markets live builder preview. [Documentation-sites page](https://www.refined.com/solutions/documentation-sites) | Explicit preview generation, then atomic live publish; changes regenerate source pages. [Docs](https://help.k15t.com/scroll-viewport/publish-and-update-a-site) | Staging/preview then production promotion. [Overview](https://help.gocapable.com/sites/index.html) | Preview, publish, sync and unpublish controls. [Product](https://typeswitch.net/public-pages-for-confluence/) | Automatic update once enabled; drafts/restricted pages excluded. [Usage](https://docs.glintech.com/instant-websites-for-confluence/using-instant-websites) | Immutable bundle, diff and output manifest are the superior foundation. Finish explicit CLI preview/promote/rollback and changed-page report; never present a build as deployed without a deploy adapter. | **Parity required P0**; inspectable digests/rollback are an **Atlcli differentiator W1**. |
| **Static delivery, hosting and portability** | Hosted rendered pages in Refined Cloud. [Marketplace](https://marketplace.atlassian.com/apps/1221322/refined-for-confluence-cloud?tab=overview) | Static HTML preview/live site on vendor-operated hosting. [Publish docs](https://help.k15t.com/scroll-viewport/publish-and-update-a-site) | States static HTML plus ZIP export. [Marketplace](https://marketplace.atlassian.com/apps/528130293/capable-sites-for-confluence-website-intranet) | Public web-page delivery; portable artifact was not documented. | Static mobile-responsive site, AWS-hosted Cloud offering; historical Server edition offered filesystem/Git/AWS paths. [Vendor](https://www.glintech.com/services/atlassian-marketplace/instant-websites-for-confluence/) | Build output is intentionally host-neutral. Add deploy adapters only at the outer boundary (for example object storage/CDN/Git hosting), with output ownership and no permanent atlcli content mirror. | **Atlcli differentiator W1**, but usable static artifact is **P0**. |
| **Theme, branding and composition** | Theme editor, logo, colors, imagery, icons, fonts, templates and drag/drop landing modules. [Marketplace](https://marketplace.atlassian.com/apps/1221322/refined-for-confluence-cloud?tab=overview) | Responsive help-center theme; configurable header/footer/favicon/article/portal/search, plus CSS/JS injection. [Theme docs](https://help.k15t.com/scroll-viewport/the-help-center-theme) | Theme framework with colors, fonts, layout, logo, favicon, cover image and footer/header links. [Marketplace](https://marketplace.atlassian.com/apps/528130293/capable-sites-for-confluence-website-intranet) | Logo/site name/branding; light/dark presentation. [Product](https://typeswitch.net/public-pages-for-confluence/) | CSS styling and custom JS are advertised. [Vendor](https://www.glintech.com/services/atlassian-marketplace/instant-websites-for-confluence/) | Starlight is the supported first theme; ExportBlock body stays presentation-neutral. Finish typed tokens, logo/favicon/header/footer configuration and trusted Astro theme adapter contract. Do not introduce source-controlled arbitrary JS. | **Parity required P0** for theme/brand; page-builder parity is **P1 architecture**, not a V1 visual-builder project. |
| **Documentation navigation and landing pages** | Hierarchical/global navigation, folders, menus and external links. [Product](https://www.refined.com/products/sites-for-confluence) | Portal/content-source overview, page tree and article navigation; pinned/news/CTA conventions. [Theme](https://help.k15t.com/scroll-viewport/the-help-center-theme), [featured pages](https://help.k15t.com/scroll-viewport/define-pinned-news-and-call-to-action-pages) | Responsive tree, active expansion, sidebar, ToC and optional space tabs/dropdown. [Layout](https://help.gocapable.com/sites/site-layout.html) | Clean page presentation; complete hierarchy details not documented. | Slimmed-down Confluence site; detailed navigation contract not documented. | Graph planner already provides tree, breadcrumbs, TOC, previous/next, related and labels. The bundle-driven Starlight consumer now proves label + 404 output; complete root/space landings, external menu entries and searchable 404 remain. | **Parity required P0**. |
| **Search and relevance** | Enhanced search; promoted results and Advanced AI search/summaries. [Marketplace](https://marketplace.atlassian.com/apps/1221322/refined-for-confluence-cloud?tab=overview) | OpenSearch full text with title weighting, fuzzy matching and exclusions; optional AI layer. [Search docs](https://help.k15t.com/scroll-viewport/how-does-search-on-viewport-sites-work) | Prebuilt fuzzy full-text index over titles/content/assigned spaces. [Layout](https://help.gocapable.com/sites/site-layout.html) | Public-site search was not documented in inspected sources. | Search, labels and later label-result/filter improvements documented. [Usage](https://docs.glintech.com/instant-websites-for-confluence/using-instant-websites), [releases](https://docs.glintech.com/instant-websites-for-confluence/instant-websites-for-confluence-release-notes) | Pagefind local search is correct baseline. Complete filters, title boosting/exclusions, keyboard/mouse/a11y proof and small/medium/large corpus latency/size/memory budgets before considering AI. | **Parity required P0**; privacy-preserving quality evidence is **W1**. |
| **AI answers and summaries** | RAG-style suggested questions, answers and summaries are advertised in Advanced; vendor documentation describes stored content with opt-in. [Docs](https://refined.atlassian.net/wiki/spaces/CLOUDDOCS/pages/6239059975) | Optional BYO OpenAI-key answer summaries in search. [Docs](https://help.k15t.com/scroll-viewport/ai-search-integration) | Marketplace advertises AI/MCP without inspected implementation detail. [Marketplace](https://marketplace.atlassian.com/apps/528130293/capable-sites-for-confluence-website-intranet) | Not documented. | Not documented. | Do not make this a V1 requirement. A future provider-neutral, opt-in adapter needs source citations, explicit content transfer, customer/BYO key or hosted endpoint, budgets and no secret in static output. | **Parity later P2**; provenance-first answer UX could be **W1**. |
| **SEO, metadata and discovery** | Branded public sites/custom URLs are core; detailed artifact set not fully verified. | Per-page metadata, SEO-friendly URL construction, `sitemap.xml` and `robots.txt`. [Indexing](https://help.k15t.com/scroll-viewport/how-is-my-site-indexed-and-ranked-by-search-engine), [URLs](https://help.k15t.com/scroll-viewport/how-does-scroll-viewport-construct-urls) | Title, description, custom paths and cover images. [Overview](https://help.gocapable.com/sites/index.html) | Slug, SEO title/description, robots, sitemap and Search Console verification. [Marketplace](https://marketplace.atlassian.com/apps/356517983/public-pages-for-confluence) | Sitemap, `robots.txt` and redirects. [Releases](https://docs.glintech.com/instant-websites-for-confluence/instant-websites-for-confluence-release-notes) | Canonical, robots, sitemap, OG/social, allowlisted JSON-LD, feed policy, stable routes and verification-token configuration are planned T8 work and must share one URL planner. | **Parity required P0**. |
| **Redirects and durable links** | Custom URL/domain; redirect controls not independently verified. | Literal/fallback redirects plus durable context-key links. [Redirects](https://help.k15t.com/scroll-viewport/manage-redirects), [context keys](https://help.k15t.com/scroll-viewport/generate-stable-links-context-keys) | Managed redirects. [Overview](https://help.gocapable.com/sites/index.html) | Slug/unpublish flow; redirect behaviour not documented. | Redirect function advertised. [Releases](https://docs.glintech.com/instant-websites-for-confluence/instant-websites-for-confluence-release-notes) | Existing identity-first route history is the base. Finish generated redirect output, verify it, record it in the manifest, and later evaluate permanent aliases without copying a proprietary context-key model. | **Parity required P0**; permanent aliases **P1**. |
| **Locales, versions and variants** | Partial browser/profile UI translation; content translation is manual. [FAQ](https://www.refined.com/faq) | Locales, `lang`, localized chrome, switcher; versions/variants via Scroll Documents. [Languages](https://help.k15t.com/scroll-viewport/set-site-language-s), [sources](https://help.k15t.com/scroll-viewport/add-and-remove-content-sources) | No comparable detailed locale/version contract verified. | No comparable detailed locale/version contract verified. | No comparable detailed locale/version contract verified. | Explicit locale metadata, localized UI/routes/search, fallback, `hreflang`, RTL and canonical consistency are required. Model future `edition/version/audience` as source-agnostic dimensions; do not pretend Confluence alone supplies authoritative version semantics. | **Parity required P0** i18n; versions/variants **P1 architecture**. |
| **Access control and privacy boundary** | Public/private/JSM access; group/audience controls and Confluence permission awareness. [FAQ](https://www.refined.com/faq) | Public static output or token/SAML access behind custom domain. [Authenticated access](https://help.k15t.com/scroll-viewport/set-up-authenticated-access) | Public, password and Atlassian-login modes; exact SSO protocol needs validation. [Overview](https://help.gocapable.com/sites/index.html) | Public page publishing in inspected sources. | Public output; source permissions determine what is emitted. [Usage](https://docs.glintech.com/instant-websites-for-confluence/using-instant-websites) | Strict scope/completeness preflight and no source leakage are V1. Authentication/SSO belongs to a deployment adapter: static files must never falsely claim Confluence permission enforcement. | Safe public boundary **P0**; managed auth **P2 adapter-only**. |
| **Macro and rich-content fidelity** | Supported-macro rendering; unsupported content can be embedded as native Confluence page. [Marketplace](https://marketplace.atlassian.com/apps/1221322/refined-for-confluence-cloud?tab=overview) | Published supported-macro surface/known limitations. [Docs](https://help.k15t.com/scroll-viewport) | Native content plus Capable, Excalidraw, Draw.io, PlantUML, Mosaic, Aura and Refined macros; limitations are documented. [Marketplace](https://marketplace.atlassian.com/apps/528130293/capable-sites-for-confluence-website-intranet), [limitations](https://help.gocapable.com/publishing/known-limitations.html) | Text, images, tables and page layout asserted preserved. [Product](https://typeswitch.net/public-pages-for-confluence/) | draw.io, expand, live search and code appear in the documented/release surface. [Releases](https://docs.glintech.com/instant-websites-for-confluence/instant-websites-for-confluence-release-notes) | ExportBlock-to-Astro components must have a public support/fallback/unsupported matrix. Per-build coverage/freshness report and fail-closed diagnostics are stronger than a generic “macro compatible” claim. | **Parity required P0**; verifiable coverage report is **W1**. |
| **Trusted dynamic components** | Dynamic modules are product-specific; broad chart support not verified. | Widgets/custom theme JS; chart surface not verified. | Rich formatting advertises tabs, cards, HTML, LaTex and code; broad chart claim not verified. [Formatting](https://help.gocapable.com/sites/capable-formatting.html) | Not documented. | Custom JS can alter behaviour. | TanStack Charts and future diagrams/islands are useful only from typed frozen data with an accessible static fallback, CSP-safe hydration and a closed adapter registry. Never execute Confluence-originated JavaScript. | **P1 world-class opportunity**, not parity theatre. |
| **Analytics, feedback and support integrations** | Built-in/deep analytics, GA, feedback module, JSM requests/tracker. [Product](https://www.refined.com/products/sites-for-confluence), [FAQ](https://www.refined.com/faq) | GA4/GTM/Search Console/Cloudflare analytics; comments/ratings/reactions; JSM/Zendesk/Freshdesk/Intercom integrations. [Analytics](https://help.k15t.com/scroll-viewport/analytics-integrations), [feedback](https://help.k15t.com/scroll-viewport/article-feedback-integration) | Custom-code injection for analytics/chat/widgets. [Overview](https://help.gocapable.com/sites/index.html) | GA4 and Search Console. [Marketplace](https://marketplace.atlassian.com/apps/356517983/public-pages-for-confluence) | GA and custom JS. [Vendor](https://www.glintech.com/services/atlassian-marketplace/instant-websites-for-confluence/) | Planned off-by-default, privacy-respecting analytics + Confluence edit link are appropriate V1. Add feedback/contact-support slots as trusted external adapters; arbitrary script injection is not a default capability. | Analytics/edit link **P1**; feedback **P1**; hosted comments/help desk **P2 adapter-only**. |
| **Governance and operations** | Delegated admins, audit logs and IP allowlisting in Advanced. [Marketplace](https://marketplace.atlassian.com/apps/1221322/refined-for-confluence-cloud?tab=overview) | Dedicated site-admin group manages content/theme/publish. [Docs](https://help.k15t.com/scroll-viewport/permission-to-use-the-app) | Site scope/stage/promotion plus tiered sites. [Purchasing](https://help.gocapable.com/sites/purchasing-options.html) | Publish/sync/unpublish dashboard. | Space configuration/automatic sync. | CLI needs explicit publisher authority, plan/dry-run confirmation, manifest verification, retention/prune rules and audit-friendly reports. Hosting RBAC/IP controls are adapter/host concerns. | **P0** lifecycle safety; attestations/audit quality **W1**. |
| **Custom domain and DNS** | Advanced includes custom domain. [Pricing](https://www.refined.com/advanced-edition/refined-sites-pricing) | CNAME/CloudFront managed-domain process. [Docs](https://help.k15t.com/scroll-viewport/connect-a-custom-domain) | DNS validation/certificate/CloudFront CNAME. [Docs](https://help.gocapable.com/sites/custom-domains.html) | Guided domain verification. [Product](https://typeswitch.net/public-pages-for-confluence/) | Customer domain/CNAME to AWS hosting. [Usage](https://docs.glintech.com/instant-websites-for-confluence/using-instant-websites) | `site`/base configuration and static hosting hand-off are core. DNS validation/cert issuance must be a host-provider adapter responsibility, not an accidental atlcli hosted service promise. | Artifact/site config **P0**; DNS/certificate automation **P1 adapter**. |
| **Operational limits and pricing model** | Standard is limited to one published/public site; Advanced adds multiple sites/custom domains and is user-tier priced. [Pricing](https://www.refined.com/advanced-edition/refined-sites-pricing) | Commercial tier/pricing not established in this pass. | Standard/Advanced separate site/auth options; packaging needs reconfirmation before commercial comparison. [Purchasing](https://help.gocapable.com/sites/purchasing-options.html) | Paid Marketplace app; exact tier limits not observed. | Trial/site limits vary by edition. [Usage](https://docs.glintech.com/instant-websites-for-confluence/using-instant-websites) | Do not make “cheaper” claims. The defensible distinction is a non-seat-shaped local artifact layer; customers still pay their chosen hosting/provider costs. | Positioning constraint, not a feature. |

### Derived prioritised capability backlog

| Rank | Capability package | Why it matters | Atlcli decision boundary |
| --- | --- | --- | --- |
| P0.1 | Release safety and output ownership | Preview/promote, scope gates, manifest/diff, redirect-safe route history and a recoverable verified output are shared category expectations. | Core CLI and builder; never delegated implicitly to an Astro theme or hosting provider. |
| P0.2 | Docs-grade reader experience | Responsive navigation, search, accessible color modes, 404 recovery, design tokens, reliable base URLs and rich content determine whether it is a site rather than a file export. | First-class Starlight experience plus theme-neutral body components; plain Astro remains conformance-only. |
| P0.3 | Discovery and locale correctness | Sitemap/canonical/robots/social/schema, redirects, i18n/RTL and stable routes are required for public documentation credibility. | One shared route/locale planner used by Astro, Pagefind, SEO and deployment verification. |
| P0.4 | Honest fidelity and media | Competitors market macro support; silent loss is unacceptable. | Closed macro registry, static fallback/originals and a per-build support/freshness report. |
| P1.1 | Customer-owned deployment adapters | Custom domain and promotion are buyer-visible, but DNS/SSL/auth are hosting functions. | Provider adapters consume verified manifests; core remains portable and local-first. |
| P1.2 | Privacy-respecting analytics, edit and feedback loop | Analytics, author feedback and support links are common, but arbitrary injected scripts are not a safe default. | Closed opt-in analytics/event contract; authorized edit/feedback/support slots. |
| P1.3 | Rich trusted islands | Chart/diagram/tabs/expand behaviour can distinguish a modern docs experience. | Typed normalized inputs, static accessible fallback, CSP budgets and no source-controlled executable code. |
| P2 | AI answers, managed SSO/comments/JSM, visual page builder | Valuable adjacent products, but rely on external accounts, hosting, moderation, access enforcement or a separate UX thesis. | Adapter-only or later standalone initiative; no implicit V1 claim. |

### Where atlcli can be genuinely superior

1. A reproducible, content-addressed acquisition/build package with explicit
   scope, macro-freshness and output verification — rather than an opaque
   hosted rendering state.
2. Hosting and data-residency freedom: deploy a verified static artifact to a
   customer-selected domain/CDN/store with no mandatory third-party content
   copy.
3. Native Astro extensibility: a public ExportBlock-first component/render
   model and trusted theme adapters, rather than a proprietary template DSL or
   unrestricted injected scripts.
4. A visible fidelity contract: every macro/rendered feature is supported,
   statically degraded, or release-blocked with evidence.
5. A privacy-first optional dynamic layer: local Pagefind by default,
   explicit analytics/AI/network declarations, and no runtime secrets.

## Pain points that should shape V1

### 1. Public access is not an adequate release workflow

Users want authors to collaborate privately, then intentionally publish a
reviewed subset. Native anonymous/public-link approaches either broaden access
or make pages isolated. A public site should therefore be a **derived release
artifact**, not a live anonymous view of a space.

Required capability direction:

- explicit roots/page allowlists and visible inclusion/exclusion report;
- full/partial acquisition semantics and a hard public-release confirmation;
- immutable build package, deterministic manifest, preview, promote and
  rollback path;
- no public comments, page history, tenant URLs, credentials or raw source in
  the output;
- freshness/unsupported-macro/completeness status that can block a release.

### 2. Information architecture and search are the product

The direct Community evidence on missing trees and macro limitations means a
page-by-page export is not sufficient. The output must act like a docs portal:

- responsive hierarchy, breadcrumbs, local TOC and previous/next;
- predictable routes, redirects and deep-link-safe anchors;
- label/section/root/space landing pages and deterministic related content;
- high-quality keyboard-accessible client-side search with facets, safe
  snippets and explicit quality/performance budgets;
- useful 404/search recovery, not merely a missing file response.

This validates the current shared page-graph/navigation planner and Pagefind
work as category-critical rather than optional enhancement.

### 3. Fidelity must be trustworthy, never misleading

The product must not quietly drop an important chart, include, Jira item or
diagram. The appropriate promise is a bounded supported surface:

- support a transparent set of ExportBlock/macro renderers;
- emit accessible static chart/diagram output where possible, with original
  downloads and a clearly labelled fallback where appropriate;
- opt-in islands only from frozen, typed normalized data;
- closed failure behaviour and a pre-publication report for unsupported or
  stale dynamic content;
- never move raw ADF, Storage or `export_view` HTML into public runtime code.

Vendor evidence from Capable Sites specifically treats rich-macro fidelity as
its headline problem; this reinforces, but does not independently prove, the
priority of the existing closed renderer architecture.

### 4. SEO and ownership are buyer-visible outcomes

A public Confluence space can be indexable, but users still ask whether it is
SEO-safe and how custom domains/redirects work. [SEO question](https://community.atlassian.com/t5/Confluence-questions/Confluence-Public-cloud-works-with-Google-SEO/qaq-p/1742054), [migration/domain question](https://community.atlassian.com/forums/Confluence-questions/Custom-Domains-and-SEO/qaq-p/2370123).

V1 should produce and verify canonical URLs, intentional robots policy,
sitemap, OpenGraph/social metadata, allowlisted JSON-LD, title/description,
redirect mapping and search-engine-verification passthrough. Hosting/deploy
adapters should use customer-controlled domain/CDN/storage credentials, never
turn the local build into an unannounced hosted content mirror.

## Capability priorities

### Must be demonstrably present before a public-static V1 claim

1. Safe scope and release: complete bundle, diff, preview, explicit publish,
   immutable output manifest, verification, rollback-compatible ownership.
2. Documentation-grade reader experience: Starlight, navigation, search,
   responsive/accessibility proof, selectable theme contract and custom domain
   / nested base support.
3. Reader trust: macro support matrix, hard failure/warning policy, media
   originals, link/anchor verifier, no confidential Confluence residue.
4. Discovery: canonical/robots/sitemap/OG/JSON-LD, clean routes/redirects and
   privacy-respecting optional analytics.
5. Practical operating model: `plan`, `refresh`, `build`, `verify`, `run`,
   `status`, `prune`; actionable permissions/configuration diagnostics;
   customer-owned deploy hand-off.

### Deliberate next extensions, not hidden V1 promises

- multi-space documentation centres with namespaces and cross-space links;
- audience/conditional-content variants, product versions and locales;
- access-controlled deployment/SSO integration (not cosmetic client-side
  gating);
- feedback, JSM/issue loop and content-freshness/broken-link reporting;
- a hosted deployment adapter, only if its privacy, retention and pricing
  model is separately designed;
- installable PWA/offline runtime — explicitly deferred in the current plan.

## Positioning recommendation

The most credible concise position is:

> **Turn reviewed Confluence knowledge into a verifiable, branded, fast static
> documentation site — built from an immutable release bundle and deployable
> to infrastructure you control.**

Avoid an early “cheaper Refined/Scroll replacement” claim. The evidence proves
paid competitor categories and one user’s price objection, but not a stable
like-for-like price comparison. Lead with release safety, renderer fidelity,
portable output and docs-quality UX; validate pricing and deployment demand
with design partners before committing to a commercial packaging claim.

## Research limitations

- Marketplace availability, install counts, editions and pricing can change;
  links record the observed current listing, and vendor claims remain vendor
  claims.
- Community and Reddit posts are qualitative signals, not market sizing.
- Some high-value capabilities (versions, variants, SSO, feedback) are
  competitor/vendor statements or strategic inferences. They remain backlog
  candidates until atlcli requirements and proof are defined.
- This report does not make any claim that atlcli currently supports all
  competitor features; the authoritative implementation scope remains
  [PLAN.md](./PLAN.md).
