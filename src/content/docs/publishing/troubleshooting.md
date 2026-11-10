---
title: "Web publishing troubleshooting"
description: "Diagnose incomplete refreshes, Astro builds, search, links, and verification failures"
---

Start with the JSON output from the failing stage and the private workspace
manifest. Do not inspect or paste raw page bodies, tenant URLs, or credentials
into an issue.

## Refresh failures

| Symptom | Likely cause | Action |
| --- | --- | --- |
| `page-unreadable` or `subtree-unreadable` | profile lacks view permission | fix access, rerun `plan`, or explicitly use partial policy |
| `page-version-changed` | page changed during discovery | rerun `refresh`; the version fence is working |
| `page-ambiguous-404` | provider cannot distinguish deletion from restricted access | restore access or investigate before allowing deletion |
| asset blocked/missing | unsafe scheme, invalid bytes, or missing attachment | inspect the structured asset issue; never allow an unverified URL |

## Astro build failures

- Check that the project uses Astro `7.1.6` or a supported 7.x release.
- Ensure the project lockfile and build command are present.
- Ensure `astro.config.mjs` reads `ATLCLI_PUBLICATION_BUNDLE_PATH` and
  `ATLCLI_PUBLICATION_INVENTORY_PATH`; a fixed fixture/digest path becomes stale
  after the next successful refresh.
- Keep `inventoryPath` outside `dist` and remove only a deliberately stale,
  operator-owned output.
- A failed build should leave the previous output untouched; if it does not,
  stop and preserve the workspace for investigation.
- **`publication bundle does not match its digest`** (or `publication page
  '<id>' does not match its digest`): a file under the active bundle directory
  was edited after `refresh`. The build recomputes every page and bundle
  digest before Astro reads them. Run `refresh` again; never edit a bundle.

## Search failures

- Confirm `pagefind/pagefind.js`, `pagefind-worker.js`, and index shards are in
  the private inventory and public output.
- Keep `wasm-unsafe-eval` in the CSP; do not replace it with broad
  `unsafe-eval`.
- If a page still appears after deletion, rebuild the same output and inspect
  the semantic search manifest for stale source ids.

## Verification failures

- **Unowned output:** a theme plugin emitted a file outside the declared
  project/generated paths.
- **Digest mismatch:** output was edited after build or the wrong build digest
  was selected.
- **Private URL/active content:** content or a plugin emitted a forbidden sink;
  remove it or add a safe renderer, never suppress the verifier. The verifier
  inspects markup only: elements, attribute names and values, link and resource
  targets, and inline scripts. Page text or inline code that mentions
  `onclick=`, `javascript:`, or a Confluence REST path is content and passes,
  and so does a page whose route is `/cache/`, `/bundles/`, or `/staging/`.
- **Edit link outside the trusted Confluence origin:** a template rendered an
  `data-atlcli-edit-link` element that is not an `<a>` to the Confluence site
  the bundle was refreshed from. Render the value of
  `publicationEditLinkV1(bundle, page.sourceId)` unchanged; do not build a URL
  from a page ID.
- **Edit-link marker missing / in a page without a declared edit link:** the
  template renders the link on the wrong pages. Render it exactly when
  `publicationEditLinkV1` returns a value.
- **Edit-link marker in disabled build:** the template hard-codes a link while
  `editLink.provider` is `none`.
- **Different edit-link policy:** `editLink` or `visibility` changed after the
  last `refresh`. Refresh, then build again.
- **Edit links are enabled but a page has none:** Confluence returned no usable
  URL for it. With `fallback: "omit"` a page without an edit URL gets no link;
  `open-page` falls back to the page view URL. The build manifest lists the
  pages under `editLinks.includedSourceIds` and `omittedSourceIds`.

## Chart failures

- **Only a data table is visible:** inspect `renderer-fallback` and
  `image-embed-failed` diagnostics. The table is the deliberate accessible
  fallback, not proof that the chart visual succeeded.
- **A chart is static in Astro:** V1 hydrates only the proven Bar and XY Bar
  profiles within their row/series/point/byte budgets. Other shapes remain
  first-class server-rendered SVG.
- **Strict refresh rejects a chart:** fix the named malformed/locale/skipped-row
  source diagnostic or deliberately choose partial publishing; do not remove
  the diagnostic from the bundle.

See the [complete chart troubleshooting matrix](./charts.md#troubleshooting).

## Getting help

Reproduce with `--json`, redact private values, include the operation, stage,
schema versions, and sanitized issue codes, and link to the relevant guide:

- [Publishing guide](./index.md)
- [Operations](./operations.md)
- [Security and privacy](./security.md)
- [Confluence chart support](./charts.md)
