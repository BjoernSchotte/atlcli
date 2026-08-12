# AP-09 quality-gate evidence

**Status:** COMPLETE

**Date:** 2026-08-12

**Source commit:** `028790b7d5e9c18cfbe431f9b24d0e25d80fc35e`

## Environment

- macOS `26.4` (`25E246`), arm64;
- Google Chrome `151.0.7922.137`;
- Bun `1.3.14`;
- Node.js `v22.18.0`;
- WXT `0.20.27`;
- Playwright `1.55.0`.

The commands below ran from a clean `codex/action-palette-mvp-plan` worktree.
The full root test temporarily regenerated one tracked publish inventory and one
ignored-style consumer output directory. Both were identified by comparison
with the clean pre-test state and removed/restored after the run; no generated
consumer output is part of this evidence commit.

## Required gate log

| Command | Result |
| --- | --- |
| `bun run test` | **7,978 pass, 16 explicit skip, 0 fail**, 6 snapshots and 40,217 assertions across 640 files in 412.61 seconds |
| `bun run typecheck` | Passed on the recorded source commit |
| `bun run build` | Passed; all 30 Turbo tasks completed |
| `bun run check:browser` | Passed; all 34 browser entrypoints remained free of reachable Node/Bun built-ins |
| `bun run --cwd apps/extension build` | Passed; WXT produced the Chrome MV3 production directory, 61.71 MB including the existing export runtimes |
| `bun run check:extension-output` | Passed; output reported CSP-safe and a complete export runtime |
| `bun run --cwd apps/extension test:palette-extension-browser:prebuilt` | **7 pass, 0 fail** in 21.3 seconds against a copied production build loaded unpacked into Chromium |

The 16 root-suite skips are intentional opt-in consumer, veraPDF, scale, and
live-tenant lanes. The AP-09 tenant acceptance is tracked separately and is not
claimed by this offline quality gate.

The first full-root invocation inside the restricted sandbox could not open
local `Bun.serve` listeners, even on port `0`; the identical suite passed in the
approved unsandboxed local-server lane. Likewise, the sandboxed packed-browser
invocation could not start Chromium because macOS denied Crashpad access. The
final source commit above was then rebuilt and tested in the approved browser
lane. These environment failures are not counted as product-test results.

## Packed MV3 result

The production-output suite proved:

- Atlassian-only mounting and Confluence, Jira, and generic-site context;
- SPA survival, adversarial host CSS, zoom, and 50 open/close cycles;
- real current-page PDF durable submission and the DOCX Publishing handoff;
- contenteditable selection/focus restoration and accessible nested states;
- bounded loading and transport-error states;
- a visible, explained, inert action when a required capability is absent;
- no search-time request and no palette long task.

The final post-fix performance sample reported cold-open p95 `74.013 ms`,
warm-open p95 `12.323 ms`, maximum long task `0 ms`, search requests `0`, eager
palette gzip `6,834 bytes`, and lazy palette gzip `81,850 bytes`. These all
remain inside the approved AP-05 budgets. The lifecycle ratchet also proves
that close awaits disposal of the old frame transport and prewarms a fresh,
hidden transport before acknowledging the next warm open.

## Production-output identity

The final WXT build used for the output scan and packed-browser test has these
SHA-256 identities:

| File | SHA-256 |
| --- | --- |
| `apps/extension/.output/chrome-mv3/manifest.json` | `9ad7e7092ee258002b733d8f4e47061d5adbf29d84087ad228184f791721af25` |
| `apps/extension/.output/chrome-mv3/background.js` | `d5dca5faabb259ea6420e8f4bc4d18a53ca65c59425f8b9c9294b94fbb54128e` |
| `apps/extension/.output/chrome-mv3/content-scripts/atlassian-action-palette.js` | `00944a2f6a349dcab559c847a2c484b206c5c793816e5f404cc645741bd59548` |
| `apps/extension/.output/chrome-mv3/content-scripts/atlassian-action-palette.css` | `83162aa7fb37704c479f9ced535fb55783d78d7bd3c255368f46f581e2c96867` |

This is a production WXT build directory loaded through Chrome's unpacked
extension mechanism; it is not represented as a signed or packed CRX.
