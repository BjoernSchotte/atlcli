# Web publishing V1 threat model

## Security objective

Build a complete static site from untrusted Confluence content without turning
that content into executable source, leaking credentials/private URLs, fetching
untrusted network targets during the Astro build, or overwriting unowned files.

## Trust boundaries

```text
untrusted ADF/Storage/macros/attachments
  -> bounded source decoder and resolver
  -> normalized ExportBlock/page graph
  -> validated immutable publication bundle
  -> trusted Astro loader and closed renderer registry
  -> staged static output + Pagefind
  -> verifier-owned manifest
```

Operator configuration is trusted intent but still schema- and path-validated.
The Astro project and installed experience adapters are trusted code.
Publication strings, macro parameters, URLs, attachment bytes, cached state,
and an existing output directory are untrusted.

## Threats and mandatory controls

| Threat | Controls and verification |
| --- | --- |
| ADF/Storage parser exhaustion | byte/node/depth/text/table budgets; cancellation; strict completeness; raw source transient only |
| Source code injection | source is JSON data only; never emit source-derived `.astro`, MDX, JS, CSS, component names, imports, or build configuration |
| XSS/HTML injection | Astro escaping by default; no raw-string `set:html` renderer API; hostile script-closing fixtures; safe JSON-LD serialization; closed URL schemes |
| Component/plugin selection | only trusted project configuration selects a renderer, island, experience, or plugin; source kinds dispatch through an exhaustive closed registry |
| Macro active content | deny live/HTML/script/iframe/CSS behavior; resolve to bounded static models or visible unknown placeholders; no raw `export_view` output |
| Island abuse | schema-validated frozen JSON, bounded cardinality/size, no callbacks/code/URLs/credentials/raw source; static fallback always present |
| Remote asset SSRF | reuse final-fetch trust routing; validate redirect chain, DNS/private ranges, scheme, MIME/magic bytes, size/pixels/SVG nodes; no credential forwarding |
| SVG/script payload | sanitize/validate before bundle activation; never write unsafe original SVG to public output; rasterize or show fallback under policy |
| Path traversal/symlink escape | canonical safe IDs/names, containment checks after resolution, no source paths, reject symlinks and collisions, same-filesystem staging/promotion |
| Route confusion/open redirect | source-ID registry, normalized locale/base paths, reserved-path inventory, duplicate/case/Unicode collision checks, safe internal link resolver |
| Incomplete deletion | deletion only after complete authoritative traversal; partial refresh cannot create tombstones or remove last-good content |
| Mixed/corrupt bundle | stage, validate, digest, fsync/commit, then atomically switch `current`; immutable bundle directories; failed/cancelled refresh preserves last good |
| Stale macro/dependency data | record dependency identity/version/freshness/provenance; refresh independently; explicit stale/fail/placeholder policy |
| Astro build exfiltration | builder receives no Confluence credentials/raw source; activated bundle only; network-disabled conformance build; telemetry disabled; executable+argv with `shell:false` |
| Ambient project contamination | explicit project root/config/experience; owned generated paths; reject unexplained output; do not copy the repository docs site or overwrite handwritten files |
| Search leakage/injection | Pagefind runs only on final public HTML; exclude diagnostics/actions/private/hidden/partial pages; excerpts remain inert; no hosted backend |
| SEO false links | canonical site/base validation; hreflang only for existing equivalents; sitemap/robots/inventory verification |
| Analytics exfiltration | off by default; closed Plausible adapter; allowlisted HTTPS origin and exact event path; sanitized path only; no query/fragment/referrer/title/source/search/custom fields; no persistence/replay |
| Confluence action phishing/leak | only provider-returned `edit`/`webui`; exact configured provider origin; HTTP(S), no userinfo; truthful label; exclude from search/sitemap/feed/ranking |
| Output takeover/cleanup loss | non-empty/unowned target failure; sibling staging; manifest-bound promotion; retention by reachability/grace only; no glob/title deletion |
| Secret/private URL leakage | redacted diagnostics and manifests; inventory scan; no credentials, raw bodies, tenant-private derived data, analytics payloads, or cache paths in public output |
| Dependency compromise/drift | exact minimum lock, peer/engine bounds, public package/consumer gates, minimum/latest lanes, review updates before widening |

The `MAL-2026-10726` classification of `astro@7.1.0` was withdrawn as a false
positive. The supported minimum is nevertheless the current official Astro
`7.1.6` patch, and dependency provenance is part of the compatibility gate
rather than trusting version strings or one advisory feed alone.

## CSP baseline

The static experience is tested with `default-src 'self'`, no object sources,
no remote scripts/styles/images/fonts, and only the narrow Pagefind WebAssembly
requirement `wasm-unsafe-eval`. Broad `unsafe-eval` is not allowed. Inline
Starlight bootstrapping currently requires `unsafe-inline`; production T8 must
inventory every inline script/style and decide nonce/hash hardening before the
final CSP contract is frozen.

The optional analytics proof deliberately runs with its endpoint blocked by
CSP and confirms content/search/navigation remain usable. Enabling an analytics
origin later is an explicit operator policy, not an implicit build side effect.

## Residual risks and follow-up gates

- Pagefind 1.5.2 is semantically reproducible but not bit-identical for some
  compressed filter/meta artifacts. Verification binds the exact produced
  artifact while cross-build comparison uses the semantic manifest.
- Starlight emits a harmless warning because its built-in Markdown `docs`
  collection is intentionally absent; T4/T7 must ensure the production
  integration does not depend on private Starlight content semantics.
- A dynamic chart library is not frozen by T0. It needs a separate Astro 7.1,
  CSP, accessibility, hostile-input, JS-off, theme, size, and lifecycle spike.
- Live Cloud acquisition is required in T12; Data Center remains fixture-proven
  until a real provider E2E is available and must be labelled accordingly.
- Remote deployment needs its own credentials, origin, rollback, and supply-
  chain threat model and is outside V1.

## STOP conditions

Stop and re-plan if any implementation requires source-derived executable code,
a networked Astro loader/build, a private Astro/Vite API, unbounded output,
credentials in the builder, a static page without a complete accessible
fallback, or cleanup authority derived from a title/glob rather than a verified
manifest.
