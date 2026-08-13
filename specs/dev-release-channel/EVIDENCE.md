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
| DR-07 | [`evidence/DR-07-homebrew-dev-lane.json`](evidence/DR-07-homebrew-dev-lane.json) | Tap lane registered and audited; live formula pointer deferred to DR-10 |
| DR-08 | [`evidence/DR-08-docs-evidence-policy.json`](evidence/DR-08-docs-evidence-policy.json) | Runbook, schemas, and privacy policy proven |
| DR-09 | [`evidence/DR-09-shadow-rehearsal.json`](evidence/DR-09-shadow-rehearsal.json) | Full manual shadow release proven with zero publication writes |

## Final live receipts

DR-09 is proven by the mutation-free rehearsal receipt above. DR-10 must add a receipt that
validates against
[`evidence/schemas/live-release-proof.schema.json`](evidence/schemas/live-release-proof.schema.json)
and links one real immutable GitHub dev prerelease plus the exact published
`atlcli-dev` formula commit. DR-10 remains open until downloaded CLI binaries,
the downloaded extension ZIP, stable-latest isolation, macOS/Linux Homebrew
install/test, manual-trigger parity, and schedule activation are all proven.
