---
title: "Web publishing troubleshooting"
description: "Diagnose incomplete refreshes, Astro builds, search, links, and verification failures"
---

# Web publishing troubleshooting

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
- Keep `inventoryPath` outside `dist` and remove only a deliberately stale,
  operator-owned output.
- A failed build should leave the previous output untouched; if it does not,
  stop and preserve the workspace for investigation.

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
  remove it or add a safe renderer, never suppress the verifier.
- **Edit-link origin:** use the provider relation returned by Confluence; do not
  reconstruct an URL from a page id.

## Getting help

Reproduce with `--json`, redact private values, include the operation, stage,
schema versions, and sanitized issue codes, and link to the relevant guide:

- [Publishing guide](./index.md)
- [Operations](./operations.md)
- [Security and privacy](./security.md)
