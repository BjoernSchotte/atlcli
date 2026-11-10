---
title: "Web publishing security and privacy"
description: "Security boundaries for source data, assets, URLs, analytics, and static output"
---

Static publishing is a trust boundary. The acquisition side handles Atlassian
authentication; the public output must not inherit credentials, private source
URLs, raw HTML, or runtime access to Confluence.

## Source and bundle boundary

- ADF/Storage is validated and normalized before Astro sees it.
- Bundles and build inventories are private, digest-bound, and schema-validated.
- The public output contains rendered content and verified asset bytes, not raw
  source bodies or credentials.
- Strict completeness prevents an apparently complete site from hiding an
  unreadable page.

## URL and content rules

The render kit escapes text, rejects unsafe schemes and path traversal, and
resolves page/asset links through trusted semantic keys. Active content such as
iframes, scripts from content, credentialed URLs, and unsafe SVG is rejected or
degraded to a visible safe fallback. The verifier crawls every owned output,
link, fragment, image, and resource sink.

## Analytics

Analytics is disabled by default. The optional Plausible adapter sends only a
pathname-only pageview to an allowlisted HTTPS `/api/event` endpoint with
`credentials: omit`. It strips query strings, fragments, titles, source ids,
Confluence URLs, search terms, and arbitrary properties; it has no queue,
replay, or content cache and respects Do Not Track. Blocking the endpoint must
not affect page rendering or search.

Operators remain responsible for lawful configuration, consent, retention, and
their analytics provider's terms.

## Edit links

An “Edit in Confluence” link is optional and off by default. See
[edit-link configuration](./configuration.md#edit-links) for the fields.

- **Source of the URL:** `refresh` takes the edit URL (Cloud `editui`, Data
  Center `edit`) or, with `fallback: "open-page"`, the page view URL (`webui`)
  that Confluence returned for the page. It never builds a URL from a page ID,
  title, or page content.
- **Trusted origin:** a URL is kept only when it is `https`, on the Confluence
  site of the profile that ran the refresh, and free of credentials, fragments,
  secret-bearing query parameters, and REST API paths. Anything else is
  dropped and the page is published without a link. A profile whose site is
  not `https` cannot enable edit links.
- **Scope:** only pages in the bundle get a link. Excluded, out-of-scope, and
  unreadable pages, label landings, and the 404 page get none.
- **Tenant disclosure:** an edit link reveals the address of your Confluence
  site. A project with `visibility: "public"` and edit-link visibility `all`
  must set `publicTenantDisclosureAcknowledged: true`; otherwise the project
  file is rejected. With edit-link visibility `internal`, a public site
  publishes no links and no site address.
- **Frozen policy:** the links and the policy they were resolved under are part
  of the digest-bound bundle. `build` rejects a bundle refreshed under a
  different edit-link policy.
- **Verification:** `verify` requires the link on exactly the pages the bundle
  holds one for, as an `<a data-atlcli-edit-link>` whose target is the frozen
  URL on the trusted origin. A link on any other page, to another origin, or in
  a build with edit links off fails verification. Confluence REST and
  `api.atlassian.com` URLs in markup stay forbidden everywhere.

The link carries `data-pagefind-ignore`, so its label is not indexed. Edit URLs
are not written to SEO metadata, feeds, the sitemap, or analytics events.

## CSP and no-JS behavior

The static page remains readable without JavaScript. The browser fixtures use a
self-contained CSP with only the narrowly scoped `wasm-unsafe-eval` allowance
needed by Pagefind's WASM runtime; broad `unsafe-eval` is not permitted.

## Related topics

- [Publishing guide](./index.md)
- [Search and indexing](./search.md)
- [Operations](./operations.md)
- [Threat model and stop rules](./index.md#boundaries)
