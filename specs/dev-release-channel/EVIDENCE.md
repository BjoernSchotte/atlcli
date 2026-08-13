# Dev release channel evidence

This index binds implementation and live receipts to the dev-release plan.
Task checkboxes are closed only from committed evidence. Local implementation
proof is not a substitute for a published consumer proof.

## Receipt policy

Every receipt is revision-bound and records the exact command or workflow
identity and result. Final live evidence additionally records source SHA,
canonical main-push eligibility, workflow run/attempt/event, immutable tag and
release URL, toolchain and lockfile identity, every asset size and SHA-256, the
packaged-extension consumer result, and the Homebrew formula commit, digest,
native test matrix, and installed `release-info` identity.

Receipts may contain public URLs, opaque workflow IDs, hashes, product/tool
versions, and generic error codes. They must not contain credentials,
authorization values, tenant/customer data, private identifiers, raw provider
logs, source bodies, or absolute home-directory paths. The repository policy
test validates schemas and scans receipts before publication.

## Implementation receipts

| Task | Receipt | Status |
|------|---------|--------|
| DR-00 | [`evidence/DR-00-baseline.json`](evidence/DR-00-baseline.json) | Baseline frozen |
| DR-01 | [`evidence/DR-01-release-contract.json`](evidence/DR-01-release-contract.json) | Contract implementation proven |
| DR-02 | [`evidence/DR-02-artifact-build.json`](evidence/DR-02-artifact-build.json) | Local artifact build proven |
| DR-03 | [`evidence/DR-03-consumer-verification.json`](evidence/DR-03-consumer-verification.json) | Archive consumers proven locally |
| DR-04 | [`evidence/DR-04-reusable-artifact-workflow.json`](evidence/DR-04-reusable-artifact-workflow.json) | Shared workflow policy proven |
| DR-05 | [`evidence/DR-05-source-eligibility.json`](evidence/DR-05-source-eligibility.json) | Green-main eligibility contract proven |
| DR-06 | [`evidence/DR-06-github-publish-transaction.json`](evidence/DR-06-github-publish-transaction.json) | Immutable GitHub prerelease and downloaded-byte consumers proven live |
| DR-07 | [`evidence/DR-07-homebrew-dev-lane.json`](evidence/DR-07-homebrew-dev-lane.json) | App-dispatched formula publication and four native Homebrew consumers proven live |
| DR-08 | [`evidence/DR-08-docs-evidence-policy.json`](evidence/DR-08-docs-evidence-policy.json) | Runbook, schemas, and privacy policy proven |
| DR-09 | [`evidence/DR-09-shadow-rehearsal.json`](evidence/DR-09-shadow-rehearsal.json) | Full manual shadow release proven with zero publication writes |

## Final live receipts

| Receipt | Bound result | Status |
|---------|--------------|--------|
| [`evidence/DR-10-live-release-proof.json`](evidence/DR-10-live-release-proof.json) | Immutable ten-asset prerelease [`dev-20260813.32.1-18184731`](https://github.com/BjoernSchotte/atlcli/releases/tag/dev-20260813.32.1-18184731), exact downloaded-byte verification, five native CLI consumers, full packed-Chromium matrix and four native Homebrew consumers at tap commit [`050ac914`](https://github.com/BjoernSchotte/homebrew-tap/commit/050ac914d6db5d0e4fb0f3b448bc2199bfe57bc7) | Live proven |
| [`evidence/DR-10-operations-proof.json`](evidence/DR-10-operations-proof.json) | Manual default-source No-op, forced rebuild, forward rollback plus recovery, retention dry run, operator configuration and pinned-font cache hit | Live proven except scheduled-event gate |

The selected final release binds source SHA
`18184731cf128bf06ccc8a3c287a6b026f41b658` to canonical main CI run
[`31700826175`](https://github.com/BjoernSchotte/atlcli/actions/runs/31700826175),
dev-release run [`31701377742`](https://github.com/BjoernSchotte/atlcli/actions/runs/31701377742)
and Homebrew tap run
[`31701894788`](https://github.com/BjoernSchotte/homebrew-tap/actions/runs/31701894788).
GitHub stable latest remains [`v0.17.2`](https://github.com/BjoernSchotte/atlcli/releases/tag/v0.17.2).

The nightly variable is enabled and the deployed cron is `17 2 * * *`. DR-10
remains open only until one real `schedule` event has traversed the same graph
and produced the expected immutable No-op receipt. A manually dispatched run is
not substituted for that time-bound proof.
