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

An “Edit in Confluence” action is optional. It accepts only a provider-returned
Cloud `editui` or Data Center edit/web relation on the trusted tenant origin.
Missing or unsafe relations omit the action. Public/all visibility requires an
explicit tenant-disclosure acknowledgement. Edit URLs are excluded from
Pagefind, SEO, feeds, analytics, and unrelated public metadata.

## CSP and no-JS behavior

The static page remains readable without JavaScript. The browser fixtures use a
self-contained CSP with only the narrowly scoped `wasm-unsafe-eval` allowance
needed by Pagefind's WASM runtime; broad `unsafe-eval` is not permitted.

## Related topics

- [Publishing guide](./index.md)
- [Search and indexing](./search.md)
- [Operations](./operations.md)
- [Threat model and stop rules](./index.md#boundaries)
