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
