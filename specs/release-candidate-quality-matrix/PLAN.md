# Release-candidate quality matrix

> Status: implementation in progress. This slice turns the existing Chat gold
> labels and isolated functional tests into one executable, privacy-safe release
> decision. Private Atlassian questions, sources, answers, URLs, and transcripts
> remain outside Git.

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

- [ ] Add deterministic bodies and provider behavior for the committed gold
      cases instead of deriving observations directly from gold labels.
- [ ] Project actual `runChatAgent` and suitable `runResearchAgent` results,
      events, calls, and timings into the existing evaluation observation.
- [ ] Exercise direct anchors, long sections, pagination/query variants,
      Confluence-to-Jira and Jira-to-Confluence links, stale duplicates,
      contradiction, critic repair, no-answer, prompt injection, deadline gaps,
      and a cross-product chain.
- [ ] Run the same eligible simple and complex cases through Quick, Auto, and
      Deep with frozen inputs and budgets.
- [ ] Run research-suitable cases through the separate Deep Research root.

Acceptance:

- [ ] All blocking deterministic quality floors pass from runtime-produced
      observations.
- [ ] A deliberately defective runtime answer fails the matrix.

## T2 - Prove packed MV3 and lifecycle parity

- [ ] Build the production extension and execute the packed MV3 suite with one
      worker.
- [ ] Feed packed exact-anchor, mode-selection, three-turn, HITL, steering,
      stop, stream-recovery, worker-recreation, redaction, and safe-Markdown
      results into the release receipt.
- [ ] Compare the source/outcome/strategy projections for the selected CLI and
      packed MV3 cases.

Acceptance:

- [ ] The production bundle passes the same structural and quality floors as
      the Node host for the selected cases.
- [ ] Worker recreation does not duplicate committed retrieval or publish a
      stale answer.

## T3 - Run the private read-only operator matrix

- [ ] Add a private-suite runner that executes opaque external cases through
      Quick, Auto, Deep, and optional Deep Research variants.
- [ ] Keep the suite definition, local gold labels, Markdown, JSON, logs, and
      provider traces under the operator-owned external artifact root.
- [ ] Score local expected source choice, required facts, forbidden claims,
      abstention, citation validity, follow-up coherence, latency, and cost.
- [ ] Require explicit operator acceptance of usefulness, source choice,
      citations, activity, follow-up coherence, latency, and cost trade-offs.
- [ ] Run at least two approved real Confluence pages individually and one
      connected follow-up; include both a simple and a materially analytical
      question.
- [ ] Run a small installed-extension subset after rebuilding/reloading it.

Acceptance:

- [ ] Every private case passes its frozen local gold and operator review.
- [ ] The committed receipt exposes only non-identifying aggregate evidence.

## T4 - Close the ratchet and reconcile plans

- [ ] Run focused tests, full tests, typecheck, production build, browser/output
      gates, public API/closure gates, and `check:research-privacy`.
- [ ] Add an evidence record containing only customer-free methodology,
      aggregate measurements, commands, and commit references.
- [ ] Mark superseded status in the older Chat quality plans without pretending
      that contract-only checks were runtime evidence.
- [ ] Confirm AGG, local models, web search, TUI, and export extensions remain
      separate follow-up slices rather than release-matrix dependencies.

Acceptance:

- [ ] One command produces a passing release-candidate receipt from the required
      synthetic, packed, lifecycle, and private proof inputs.
- [ ] A staged-diff privacy scan passes immediately before commit and push.

## Unresolved questions

None. The private suite format deliberately keeps case-specific gold and human
review outside the repository while the committed matrix owns the release rules.
