# Issue #126 implementation evidence

## Proven in this repository

- The generated Unicode coverage table is derived from the exact 12 pinned
  runtime fonts and is reproducible with `bun run fonts:coverage`.
- The resolver, browser compiler, Node adapter, CLI, extension durable bridge,
  and neutral browser harness use the same versioned font-requirement contract.
- Browser, extension, CLI, and Node hosts retain all 12 distributable fonts but
  load only the resolved subset. Missing or hash-mismatched sources fail closed.
- Compiler ownership is serialized across instances because typst.ts font
  access is process-global. Requirement changes, cancellation, retry, reset,
  and cross-instance switching have regression coverage.
- Durable PDF reports carry both the resolved requirement key and the
  registered/loaded font evidence without document text or asset URLs.

## Verification

All commands ran from the repository root on 2026-07-30.

| Gate | Result |
| --- | --- |
| `bun run test` | 5,960 passed, 15 optional skips, 0 failed |
| `bun run typecheck` | Passed |
| `bun run build` | 20 tasks passed |
| `bun run docs:check` | 0 errors, warnings, or hints |
| API report and closure guards | Passed; no reachable-but-unexported gaps |
| Extension output check | Passed; local, CSP-safe runtime |
| Browser harness output check | Passed; local, relative, complete runtime |
| Production Chromium conformance | 1 passed; exact font-network subset ratchet passed |
| Live Confluence PDF E2E | 5 passed, 2 unconfigured fixture skips, 0 failed |

The live E2E used the configured `mayflower` profile and an existing retained
page in `DOCSY`. It created no remote resources. Its temporary local outputs
were removed. The positive path produced a tagged PDF, and the reviewed
DOCX-derived template, not-found, and bad-token paths also passed.

## Remaining acceptance lanes

- The downstream Forge Custom UI adapter in `kiteweave-forge-app` still needs
  to consume the published contract and prove CSP, cancellation, worker
  recreation, and cleanup in that host.
- Approved custom-font intake and license attestation are not connected to a
  host adapter yet. Demand-aware custom asset IDs therefore remain fail-closed.

The Draft PR references issue #126 but does not close it until these external
lanes are complete.
