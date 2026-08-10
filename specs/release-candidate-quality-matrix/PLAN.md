# Release-candidate quality matrix

> Status: T0-T2 complete; the refreshed private CLI matrix passes all frozen
> local-gold, lifecycle, mode-isolation, and integrity checks across seven
> Quick, Auto, Deep, and separate Deep Research runs. The installed-MV3 subset
> is complete; the explicit operator-review gates remain open. T4 reconciliation has
> a customer-free evidence record, but its monolithic root-suite and final
> revision-bound receipt gates remain open. This slice turns the
> existing Chat gold labels and isolated functional tests into one executable,
> privacy-safe release decision. Private Atlassian questions, sources, answers,
> URLs, and transcripts remain outside Git.

## Goal

Prove that the production ordinary-Chat and Deep Research paths produce useful,
grounded answers across representative retrieval, reasoning, lifecycle, and host
shapes. A green schema or evaluator unit test is not sufficient: release evidence
must include actual production-runtime executions, packed MV3 execution, and
operator-reviewed read-only live runs.

## Non-negotiable gates

- The committed matrix contains 12-20 customer-free, hand-labelled cases.
- Quick, Auto, and Deep receive identical question, scope, corpus, and budgets
  wherever the case is eligible for all three modes.
- Deep Research is evaluated as a separate product mode on research-suitable
  cases; it is never used as an ordinary-Chat fallback.
- Blocking metrics are deterministic: correct source selection, required detail
  reads, citation precision, supported-claim recall, relationship/contradiction
  coverage, gap disclosure, outcome, strategy, false completeness, latency, and
  cost. Model judges remain diagnostic-only.
- Lifecycle proof covers a three-turn conversation with new acquisition,
  durable HITL, steering, stop, stream interruption, and worker recreation.
- Private live receipts contain only opaque case IDs, aggregate numbers, boolean
  review decisions, and generic failure codes. They contain no prompts, content,
  titles, source IDs, URLs, tenant identifiers, or provider transcripts.
- All test execution is sequential or otherwise bounded so the developer
  workstation remains responsive.

## T0 - Freeze the executable matrix contract

- [x] Add a versioned release-candidate matrix manifest and sanitized receipt.
- [x] Require every committed gold case to have an explicit production-runtime,
      packed-MV3, lifecycle, or private-live proof assignment.
- [x] Reject unknown, duplicate, missing, stale, or producer-mismatched proof
      records; later tasks make the approved producers executable.
- [x] Add a root command that returns non-zero when any required gate is missing
      or failed.
- [x] Prove that receipt schemas cannot carry source bodies, prompts, answers,
      URLs, tenant identifiers, credentials, or free-form reviewer text.

Acceptance:

- [x] Contract tests fail independently for missing case coverage, missing
      Quick/Auto/Deep comparison, wrong source, unsupported claim, false
      completeness, missing lifecycle proof, missing MV3 proof, or rejected
      operator review.

Authority correction (2026-08-09):

- [x] Bind every proof to the current Git revision, frozen gold/requirement
      manifest, creation time, and a recomputed canonical fingerprint.
- [x] Bind every result to one opaque `caseId × variant` pair with explicit
      check outcomes; derive and verify proof aggregates from those runs.
- [x] Reject stale, foreign-revision, manifest-mismatched, fingerprint-mismatched,
      duplicate, missing, or non-neutral private proof records.
- [x] Enforce blocking per-run Chat/Research latency and private-live cost
      ceilings, and reject relative receipt paths before filesystem access.

## T1 - Execute the customer-free production-runtime matrix

- [x] Add deterministic bodies and provider behavior for the committed gold
      cases instead of deriving observations directly from gold labels.
- [x] Project actual `runChatAgent` and suitable `runResearchAgent` results,
      events, calls, and timings into the existing evaluation observation.
- [x] Exercise direct anchors, long sections, pagination/query variants,
      Confluence-to-Jira and Jira-to-Confluence links, stale duplicates,
      contradiction, critic repair, no-answer, prompt injection, deadline gaps,
      and a cross-product chain.
- [x] Run the same eligible simple and complex cases through Quick, Auto, and
      Deep with frozen inputs and budgets.
- [x] Run research-suitable cases through the separate Deep Research root.

Acceptance:

- [x] All blocking deterministic quality floors pass from runtime-produced
      observations.
- [x] A deliberately defective runtime answer fails the matrix.

Proof record (2026-08-09): the customer-free runner executes all twenty frozen
Chat cases through the production `runChatAgent` root in Quick, Auto, and Deep,
for sixty body-free runtime observations. Three separate controls execute the
production `runResearchAgent` root with single-worker, parallel-worker, and
reconciliation topologies. The accepted proof contains only case IDs, checks,
aggregate measurements, failure codes, and canonical fingerprints; it contains
no question, answer, source body, URL, tenant identity, or model transcript. An
independently malformed production answer fails with `unsupported-claim`. The
focused runtime, retrieval, workflow, release-contract, CLI-verifier, and
generated API/closure suites pass 187 tests. Root typecheck, the tracked-tree
research privacy gate, and `git diff --check` pass on the same worktree state.

## T2 - Prove packed MV3 and lifecycle parity

- [x] Build the production extension and execute the packed MV3 suite with one
      worker.
- [x] Feed packed exact-anchor, mode-selection, three-turn, HITL, steering,
      stop, stream-recovery, worker-recreation, redaction, and safe-Markdown
      results into the release receipt.
- [x] Compare the source/outcome/strategy projections for the selected CLI and
      packed MV3 cases.

Acceptance:

- [x] The production bundle passes the same structural and quality floors as
      the Node host for the selected cases.
- [x] Worker recreation does not duplicate committed retrieval or publish a
      stale answer.

Proof record (2026-08-09): production commit `bbf18cac` passes all 45 packed
MV3 tests sequentially in 18.4 seconds. The revision-bound quality proof covers
six cases and ten explicit runs across Quick, Auto, Deep, and the separate Deep
Research path; it records 5.568 aggregate seconds, 30 PTC calls, 19 HTTP calls,
360 synthetic input tokens, and 180 synthetic output tokens. The lifecycle
proof covers six cases and six explicit runs across Quick, Auto, and Deep in
2.245 aggregate seconds: three connected turns with new acquisition, durable
HITL, steering, cooperative stop, interrupted-stream recovery, and fresh-worker
continuation. The Node/packed host-parity case compares byte-identical source
and result artifacts plus semantically equivalent progress. Both proof files are
mode `0600`, contain only opaque case IDs, checks, aggregate measurements, and
fingerprints, and remain outside Git.

## T3 - Run the private read-only operator matrix

Proof update (2026-08-10): the revision-bound full private CLI matrix passed all
nine applicable source-selection, citation-support, required-fact,
claim-support, outcome, mode-isolation, lifecycle, follow-up, and
answer-integrity checks across two cases and seven runs. The neutral proof and
all private inputs and outputs remain outside Git. This closes frozen local
gold only; it does not close installed-extension or operator-review gates.

- [x] Add a private-suite runner that executes opaque external cases through
      Quick, Auto, Deep, and optional Deep Research variants.
- [x] Keep the suite definition, local gold labels, Markdown, JSON, logs, and
      provider traces under the operator-owned external artifact root.
- [x] Score local expected source choice, required facts, forbidden claims,
      abstention, citation validity, follow-up coherence, latency, and cost.
- [ ] Require explicit operator acceptance of usefulness, source choice,
      citations, activity, follow-up coherence, latency, and cost trade-offs.
- [x] Run at least two approved real Confluence pages individually and one
      connected follow-up; include both a simple and a materially analytical
      question.
- [x] Run a small installed-extension subset after rebuilding/reloading it.

Acceptance:

- [x] Every private case and variant passes its frozen local gold.
- [ ] Every private case passes explicit operator review.
- [ ] The committed receipt exposes only non-identifying aggregate evidence.

## T4 - Close the ratchet and reconcile plans

- [ ] Run focused tests, full tests, typecheck, production build, browser/output
      gates, public API/closure gates, and `check:research-privacy`.
- [x] Add an evidence record containing only customer-free methodology,
      aggregate measurements, commands, and commit references.
- [x] Mark superseded status in the older Chat quality plans without pretending
      that contract-only checks were runtime evidence.
- [x] Confirm AGG, local models, web search, TUI, and export extensions remain
      separate follow-up slices rather than release-matrix dependencies.

Acceptance:

- [ ] One command produces a passing release-candidate receipt from the required
      synthetic, packed, lifecycle, and private proof inputs.
- [x] A staged-diff privacy scan passes immediately before commit and push.

## Unresolved questions

None. The private suite format deliberately keeps case-specific gold and human
review outside the repository while the committed matrix owns the release rules.
