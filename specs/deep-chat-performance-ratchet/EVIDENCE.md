# Deep Chat Performance Ratchet Evidence

This file records only customer-free aggregate evidence. Live answers, prompts,
source identities, URLs, traces, and private receipts remain outside Git.

## T0 baseline

The fixed `deep-two-anchor-comparison` scenario uses a synthetic Atlassian
origin, project, space, issue, pages, and relationship. The provider was
`claude-sonnet-4-6`. One warm-up and three measured runs used the same
question, corpus, scope, limits, and fingerprint.

| Metric | Measured values | Median |
| --- | --- | ---: |
| Duration | 111.6s, 122.8s, 147.0s | 122.8s |
| Model calls | 18, 18, 19 | 18 |
| Fresh input tokens | 207,345; 219,512; 222,947 | 219,512 |
| Cache-creation input tokens | 0, 0, 0 | 0 |
| Cache-read input tokens | 0, 0, 0 | 0 |
| Output tokens | 1,796; 2,062; 2,849 | 2,062 |
| Root calls | 7, 7, 7 | 7 |
| Specialist calls | 11, 11, 12 | 11 |
| PTC calls | 12, 14, 14 | 14 |

All three measured receipts reported the expected agentic trajectory, complete
detail-read coverage for admitted evidence, zero wrong-source findings, valid
canonical links, and streamed answers. These are deterministic host metrics,
not an uncalibrated model-judge score. Operator review found the private CLI
comparison useful enough for a baseline but left visible room for better
coverage and comparison structure; no private wording or facts are retained here.

The previously observed approximately 232k conservative input aggregate is now
attributable instead of being treated as invoice-like usage. The new receipts
showed no provider cache creation or cache reads, making child prompt caching a
measurable later target rather than an assumption.

## Proof commands

```bash
bun run test
bun run test packages/research/src/budget.test.ts packages/research/src/model-budget-middleware.test.ts
bun run test packages/research/src/chat-agent/performance-ratchet.test.ts scripts/chat-performance-ratchet.test.ts
bun run test apps/extension/scripts/chat-agent-live.test.ts
bun run typecheck
bun run build
bun run check:browser
bun run check:extension-output
bun run check:research-privacy
bun run --cwd apps/extension test:research-extension-browser:prebuilt
```

The complete repository suite passed 6,986 tests with 15 intentional skips.

Packed MV3 result: 45 passed. It covered direct anchors, Quick/Auto/Deep
strategy boundaries, multi-turn evidence reuse, worker recreation, HITL,
steering, stop, queued input, and remembered BYOK behavior.

The provider-backed synthetic benchmark command wrote body-free receipts to
the external operator artifact root. A separate read-only private CLI Deep
comparison also completed with an isolated external session store. Neither its
input, answer, sources, URLs, trace, nor receipt is committed.

## Ratchet policy

- BEFORE and AFTER receipts must share the exact scenario fingerprint, mode,
  and model ID.
- Any deterministic quality regression rejects the experiment.
- A task-specific minimum reduction must be met; unchanged behavior does not
  count as an optimization.
- Fresh-input and duration regressions beyond the declared tolerance reject the
  experiment.
- Increasing model, token, cost, PTC, HTTP, or time ceilings never counts as an
  improvement.

## Rejected or non-product findings

- The first sandboxed packed-browser launch was rejected as environmental: the
  bundled Chromium could not access its macOS Crashpad state. The identical
  prebuilt suite passed 45/45 outside that sandbox.
- A first private CLI attempt used the already-full default local session
  catalog and stopped before source or model work. The proof was repeated with
  an isolated external store; existing conversations were not deleted.
- T1 expanded provider-native structured output to analytical and critic child
  profiles. Isolated contracts passed, but real provider-backed DeepAgents runs
  failed before synthesis on the nested LangGraph task-result boundary. The
  experiment was fully reverted and has no accepted performance claim.

## T5 child prompt-cache candidate

The Anthropic adapter now explicitly grants a five-minute prompt-cache
capability. Root and child agents share one cache-boundary helper; only stable
system/profile/schema/tool prefixes receive provider cache metadata. Dynamic
questions, conversation state, evidence, scope, steering, identifiers, and
credentials remain ordinary uncached messages. Provider-neutral child bindings
receive no cache middleware.

One warm-up and three measured provider-backed synthetic runs used the same T0
benchmark fingerprint. All quality-floor metrics remained at 100%, wrong-source
and false-completeness counts remained zero, and answer streaming remained present.

| Metric | T0 median | T5 measured values | T5 median | Change |
| --- | ---: | --- | ---: | ---: |
| Duration | 122.8s | 140.9s, 117.4s, 130.0s | 130.0s | +5.8% |
| Worst duration | 147.0s | 140.9s | 140.9s | -4.2% |
| Model calls | 18 | 18, 17, 18 | 18 | 0% |
| Fresh input tokens | 219,512 | 49,894; 46,201; 37,203 | 46,201 | -79.0% |
| Cache-creation input tokens | 0 | 0; 26,614; 0 | 0 | n/a |
| Cache-read input tokens | 0 | 171,857; 145,243; 171,857 | 171,857 | observed |
| Output tokens | 2,062 | 2,105; 1,934; 2,008 | 2,008 | -2.6% |
| Billed-equivalent input | 219,512 | 67,080; 93,993; 54,389 | 67,080 | -69.4% |

`Billed-equivalent input` uses the provider cache multipliers captured for this
experiment: fresh input + 1.25 x five-minute cache writes + 0.1 x cache reads.
It is a comparison metric, not an invoice. The median latency increase remains
inside the plan's 10% per-slice tolerance, while the worst run improved. The
five-minute TTL is retained because it produces large repeated-input savings
without extending the privacy lifetime or model-call topology.

The private integration gate used two operator-approved, single-anchor CLI runs
and one installed production-MV3 run. Every run resolved the bound context
directly without broad Jira or Confluence discovery. The CLI runs completed in
77.0s and 64.6s with three model calls each. Their safe usage aggregates were:

| CLI run | Fresh input | Cache creation | Cache read | Output |
| --- | ---: | ---: | ---: | ---: |
| cold single-anchor | 2,249 | 3,936 | 3,936 | 234 |
| warm single-anchor | 2,237 | 0 | 7,872 | 231 |

The installed MV3 Deep run completed in 87.7s. It visibly streamed the read,
analysis, and answer phases, exposed a working stop control while active, and
produced an evidence-backed answer from the bound page only. The CLI and MV3
receipts therefore prove the same direct-context capability across both hosts;
the provider cache telemetry remains sourced from the body-free CLI receipt.

Focused cache, adapter, and workflow tests, type checking, the production
extension build, browser/output/CSP checks, packed MV3 tests, and the research
privacy scan remained green. No private prompt, source, answer, URL, trace,
identifier, or receipt is recorded here.

## T2 direct exact-evidence extraction

The host now reads every admitted exact anchor once, retains the resulting
evidence in the existing broker ledger, and uses one tool-free, provider-neutral
structured extraction call when the combined projection is small and complete.
The routine 30-second sacrificial exact-reader run and its second recovery call
have been removed. Navigable truncated or oversized projections retain the
guarded child path, but consume the already-read host projection rather than
replaying the Atlassian request.

One provider-backed customer-free two-anchor measurement produced:

| Metric | T0 observation | T2 measurement | Change |
| --- | ---: | ---: | ---: |
| Exact-evidence acquisition window | approximately 116s | 8.3s | approximately -93% |
| Total duration | 122.8s T0 median | 88.4s | -28.0% |
| Total model calls | 18 T0 median | 12 | -6 calls |
| Fresh input tokens | 219,512 T0 median | 28,594 | -87.0% |
| Cache-read input tokens | 0 | 143,622 | observed separately |
| Output tokens | 2,062 T0 median | 1,646 | -20.2% |
| Exact-reader recovery | routine fallback in the old path | 0 | removed |

The measurement reported the expected agentic trajectory, 100% exact-anchor
and detail-read coverage, 100% canonical citation precision, zero wrong-source
or false-completeness findings, and streamed output. It performed the two
synthetic detail reads without search; the in-memory provider correctly reports
zero external HTTP attempts while the broker and retrieval ledger record both
detail operations.

Two separately scoped, operator-approved private CLI page runs completed in
77.0s and 64.6s. Each performed one direct exact read, no Jira or Confluence
search, no recovery, and produced one useful evidence-backed answer with one
canonical source. Only those aggregate observations are retained here.

The focused 88-test workflow/retrieval/dispatch/harness suite, typecheck,
production build, browser/output/CSP/privacy gates, and all 45 packed MV3 tests
passed. The packed suite covers exact-page and exact-issue reads without search,
Quick/Auto/Deep strategy separation, long-page section reads, worker recovery,
HITL, steering, stop, queue, durable key rehydration, and the new direct
extraction response contract. A sandboxed Chromium startup failure and one
disposable-worker harness race were repeated outside the sandbox; the final
full packed run passed 45/45. The full workspace lane completed 6,795 tests
with 15 intentional skips; 50 local-server cases were denied ephemeral ports
by the filesystem/network sandbox. All 27 affected test files were then rerun
outside that sandbox and passed 332/332, including the one CLI timeout seen
under the earlier accidental parallel load. No private input or artifact entered Git.

## T3 durable host auto-advance

The root supervisor now owns strategy and dynamic graph composition only. Once
the graph is admitted, one durable host control call executes ready specialist
waves, strategy and quality reviews, an optional bounded repair, and terminal
synthesis. Deterministic transitions no longer recall the root model. The final
answer remains owned by exactly one synthesizer, and all specialist dependencies
remain host-hydrated and body-free at the root boundary.

Three provider-backed runs used the unchanged customer-free two-anchor benchmark
and passed every deterministic quality floor:

| Run | Duration | Model calls | Fresh input | Cache read | Output | Repair |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| 1 | 76.8s | 7 | 2,512 | 23,618 | 962 | yes |
| 2 | 67.3s | 7 | 2,538 | 23,618 | 865 | yes |
| 3 | 64.5s | 6 | 2,516 | 23,618 | 893 | no |

The 67.3-second median is 23.9% faster than the accepted T2 measurement of
88.4 seconds and remains well below the 180-second ceiling. The no-repair path
uses six calls and the repair path seven, both below the ratchet limits of ten
and eleven. Exact/detail coverage, canonical citation precision, supported
assertions, contradiction handling, relationship handling, material-gap
disclosure, and streaming all remained at 100%; wrong-source and false-
completeness counts remained zero.

The focused workflow suite passed 92/92, followed by type checking, the full
production build, browser-isomorphism, extension output/CSP, and research privacy
gates. The packed production-MV3 suite passed 45/45 with one worker. It proves
exact reads without search, three connected Chat turns across worker recreation,
HITL, interrupted-stream recovery, steering, cooperative stop, queued-follow-up
editing, durable key rehydration, and safe Markdown rendering. No private prompt,
source, answer, URL, identifier, trace, or receipt is recorded here.

## T4 host-owned graph dominance and anchor packing

The central supervisor still selects a dynamic graph from the host catalog, but
the host now normalizes that proposal before admission. It binds exact anchors,
packs compatible exact readers, rewires phase dependencies, removes dominated
relationship or contradiction work, and rejects duplicate, disconnected, or
unchanged-information-gain tasks. The admitted graph retains exactly one
drafter, critic, and synthesizer; repair remains a conditional host decision.

Three provider-backed, customer-free Deep runs exercised distinct topologies:

| Trajectory | Duration | Model calls | Fresh input | Cache read | Output | Admitted specialist |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| comparison only | 35.1s | 6 | 2,563 | 23,673 | 845 | comparison analyst |
| explicit contradiction | 57.4s | 7 | 2,606 | 0 | 936 | contradiction checker |
| cross-product relationship | 84.3s | 10 | 2,396 | 26,451 | 1,173 | relationship tracer |

The comparison answer covered both detailed sources and described their
differences without a redundant contradiction or relationship task. The
explicit-risk run retained an independent contradiction check. The relationship
run followed the bounded cross-product evidence in both directions, used the
canonical source title, and did not infer a macro or link subtype that the
evidence did not establish. The broader relationship trajectory consumed more
work than the fixed comparison because it required two product-specific readers
and a dedicated relation analysis; the accepted quality gain stayed below the
absolute 180-second ceiling. The fixed comparison used the same six-call
no-repair topology as T3 and improved latency by 47.7% from the 67.3-second T3
median.

Gold tests cover minimal comparison, contradiction, relationship, and combined
risk graphs; exact-reader packing; dependency rewiring; dominated-specialist
removal; duplicate rejection; and host quality repair for missing source-specific
comparison coverage. Regression tests also prove that a Jira key explicitly
supported by a detail-read Confluence source is preserved while unsupported Jira
claims remain blocked. The packed production-MV3 suite passed 45/45 and exercised
the same strategy, graph admission, exact-read, streaming, recovery, stop,
steering, and safe-rendering contracts in the built extension. The three
provider-backed CLI trajectories and packed-host contract proofs exposed only the
specialists admitted for their requested capability.

Focused tests, type checking, the production build, browser/output/CSP checks,
and the research privacy scan remained green. The full repository gate then
passed 7,003 tests with 15 intentional skips and zero failures using a
resource-capped two-test concurrency outside the local-port sandbox. No private
question, source, answer, URL, identifier, trace, or receipt is recorded here.

## T6 explicit provider-neutral model routing

Chat model selection is now an explicit host-owned role contract for root
planning, extraction, analysis, drafting, critique, repair, and synthesis. A
provider adapter returns the effective model ID, requested and effective
preference, thinking mode, and finalization corridor together with the selected
LangChain model. A capability-free adapter remains a first-class one-model
fallback. The route cannot grant scope, tools, workflow admission, or evidence
authority.

The current provider remains a one-model configuration. Root planning,
extraction, analysis, and critique use their requested standard corridor;
drafting, repair, and synthesis retain the already proven bounded
`finalize-only` corridor. An initial experiment that moved drafting and repair
to a reasoning-enabled balanced route took 136.2 seconds without an accepted
quality gain and was rejected. No alternative model route was adopted.

The final provider-backed synthetic matrix produced:

| Trajectory | Duration | Model calls | Fresh input | Cache read | Output | Quality floor |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| two-source comparison with repair | 86.5s | 7 | 2,527 | 23,674 | 857 | pass |
| explicit contradiction with repair | 75.9s | 7 | 2,544 | 23,674 | 883 | pass |
| cross-product relationship | 123.0s | 12 | 7,463 | 3,836 | 3,021 | pass |

Every run reported one effective model ID. The comparison and contradiction
each reported three balanced standard calls and four fast calls, including
three explicit finalize-only calls. The broader relationship path used four
acquisition calls, two relationship-analysis calls, two critic calls, and the
same bounded finalization corridor. All three retained complete exact/detail
coverage, canonical citation precision, supported assertions, relationship and
contradiction recall, zero wrong sources, zero false completeness, and streamed
answers. All stayed below the 180-second absolute ceiling; provider latency
variance did not justify a new model route.

The built production-MV3 strategy E2E reports the same effective model,
requested/effective preference split, thinking modes, standard corridor, and
finalize-only corridor as the CLI receipt. Tests also prove that changing a
route cannot change compiled tool grants or accepted graph semantics, and that
a deliberately lower-quality finalizer cannot bypass critic, repair, or final
host validation. No private tenant input or artifact was used for these T6
measurements.

The T6 release gates passed after the routing surface was frozen: 68 focused
Chat tests, 11 public API/export guard tests, typecheck, the production build,
all browser-isomorphism checks, the extension output/CSP gate, and the research
privacy scan. The complete packed production-MV3 suite passed 45/45 with one
worker. The resource-capped full workspace run passed 7,006 tests across 530
files with 15 intentional skips and zero failures.

## T7 final cross-shape ratchet

The final evaluator freezes independent ceilings for model calls, fresh and
cache-weighted input, output, median and worst-case latency, source correctness,
false completeness, and the hand-labelled quality floor. Separate negative
fixtures prove that each dimension fails independently instead of being hidden
inside one aggregate score.

One warm-up and three measured provider-backed runs used the unchanged neutral
two-anchor comparison corpus. The accepted measured set produced:

| Metric | Final result | Release ceiling | Change from T0 median |
| --- | ---: | ---: | ---: |
| Duration, median | 73.331s | 120s | -40.3% |
| Duration, worst | 73.633s | 180s | -49.9% from T0 worst |
| Model calls, maximum | 7 | 10 normally / 11 with repair | -61.1% |
| Fresh input, maximum | 2,535 | 109,756 | -98.8% |
| Cache-weighted input, maximum | 4,902 | 120,000 | n/a at T0 |
| Output, maximum | 860 | 15,000 | -58.3% |

All three runs retained full admitted detail coverage, canonical source
correctness, zero wrong sources, zero false completeness, supported central
claims, streamed output, the central supervisor, dynamic specialist admission,
the independent critic, conditional repair, and one final synthesizer.

Two operator-approved private exact-context pages were exercised separately in
isolated external CLI stores. They completed in 59.3s and 63.8s with one direct
read each, full detail coverage, one accepted canonical source, and no unrelated
product access. A retained follow-up completed in 45.0s with zero new HTTP
calls and reused the accepted evidence. Initial operator review rejected noisy
duplicate whole-page citations and an unbalanced German quote. The final answer
projection now collapses repeated whole-page links only for a complete
single-page direct answer, balances the quote, and leaves multi-source,
section-level, and incomplete-retrieval citations untouched. A post-fix private
follow-up and deterministic regression tests accepted the corrected Markdown.
No private wording, identity, URL, source, answer, trace, or receipt is retained
in Git.

The freshly built production MV3 suite passed 45/45 with one worker. It covers
exact page and issue anchors without search, Quick/Auto/Deep strategy isolation,
three connected turns across worker recreation, evidence reuse, HITL, interrupted
stream recovery, steering, cooperative stop, queued-message editing, remembered
BYOK recovery, privacy redaction, bounded PTC, and safe Markdown rendering.
Explicit Deep Research continues through its separate durable Research root and
was not routed through ordinary Chat.

The final focused quality suite passed 126 tests before the repository-wide
gate. Typecheck, production build, browser isomorphism, extension output/CSP,
public API/closure, and tracked-tree privacy checks passed. All private artifacts
remain only under the external timestamped operator artifact root.
