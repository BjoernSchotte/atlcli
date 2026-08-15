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
| [`evidence/DR-10-scheduled-live-release-proof.json`](evidence/DR-10-scheduled-live-release-proof.json) | Real `schedule` event, immutable ten-asset prerelease [`dev-20260814.34.1-e439c62f`](https://github.com/BjoernSchotte/atlcli/releases/tag/dev-20260814.34.1-e439c62f), exact downloaded-byte verification, five native CLI consumers, full packed-Chromium matrix and four native Homebrew consumers at tap commit [`b94a1934`](https://github.com/BjoernSchotte/homebrew-tap/commit/b94a1934bee2e02a3e6cfc017eac0ffd8b10871b) | Scheduled live proven |
| [`evidence/DR-10-operations-proof.json`](evidence/DR-10-operations-proof.json) | Manual default-source No-op, forced rebuild, forward rollback plus recovery, retention dry run, operator configuration, pinned-font cache hit and later scheduled immutable No-op | Live proven |

The selected final scheduled release binds source SHA
`e439c62f318bee363045ef8beab62800704213f0` to canonical main CI run
[`31755459683`](https://github.com/BjoernSchotte/atlcli/actions/runs/31755459683),
scheduled dev-release run
[`31764529357`](https://github.com/BjoernSchotte/atlcli/actions/runs/31764529357)
and Homebrew tap run
[`31764886975`](https://github.com/BjoernSchotte/homebrew-tap/actions/runs/31764886975).
The later scheduled run
[`31769502152`](https://github.com/BjoernSchotte/atlcli/actions/runs/31769502152)
selected the same immutable tag and completed through the explicit No-op path
without a new release or formula commit.
GitHub stable latest remains [`v0.17.2`](https://github.com/BjoernSchotte/atlcli/releases/tag/v0.17.2).

The nightly variable is enabled and the deployed cron is `17 2 * * *`. The
temporary acceptance retry cron was removed after the real scheduled build and
scheduled No-op were captured. DR-10 is complete; the manual run was not used
as a substitute for the time-bound schedule proof.
