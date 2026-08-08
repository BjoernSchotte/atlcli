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
