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
