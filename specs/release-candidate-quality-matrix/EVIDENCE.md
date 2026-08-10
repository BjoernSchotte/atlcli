# Release-candidate verification evidence

This record contains only customer-free commands, aggregate outcomes, and
non-identifying operational observations. Private questions, source material,
URLs, tenant identifiers, answers, and provider transcripts remain outside Git.

## Verification on 2026-08-10

Baseline source revision before this verification slice: `21c357511ce9`.

| Gate | Command or method | Outcome |
| --- | --- | --- |
| Runtime quality and endurance | `bun run test --max-concurrency 1 packages/research/src/chat-agent/testing/runtime-runner.test.ts packages/research/src/langgraph-checkpointer.test.ts` | 75 passed, 0 failed in 215.33 s. This includes 60 complete customer-free Chat runtime observations and 1,000 native DeepAgents checkpoint transitions across fresh hosts. |
| Production packed MV3 | `bun run --cwd apps/extension test:research-extension-browser:prebuilt` | 45 passed, 0 failed in 47.5 s with one Playwright worker. The final lifecycle case recorded 10 bounded PTC calls and 10 HTTP calls. |
| Production build | `bun run build` | 21 build tasks passed. |
| Browser boundary | `bun run check:browser` | All 29 browser entry points passed the isomorphism gate. |
| Packed output | `bun run --cwd apps/extension check:output` | CSP-safe, complete extension output passed. |
| Type safety | `bun run typecheck` | Root, extension, PDF-compiler-browser, and browser-export-harness checks passed. |
| Privacy | `bun run check:research-privacy` | Tracked-tree research privacy gate passed. |
| Patch hygiene | `git diff --check` | Passed before staging. |

The installed extension was also exercised interactively with genuine read-only
usage during the development cycle. On 2026-08-10 the product owner explicitly
accepted the resulting Chat behavior, presentation, source handling, and
multi-turn experience and declared the candidate release-ready. Private inputs
and outputs remain outside Git. This operator decision does not fabricate a
revision-bound aggregate receipt; that automation remains follow-up hardening.

The final merge integration additionally passed 52 focused settings, host,
release-contract, and portability tests; root typecheck; all 27 build tasks; the
31-entrypoint browser boundary; packed output and privacy checks; API report and
closure regeneration; and all 45 packed MV3 research/Chat lifecycle tests with
one Playwright worker.

## Full-suite limitation

A serial root-suite attempt completed 6,990 tests with 15 skips. Two measured
test-only timeout thresholds were corrected and now pass in isolation. The
remaining failures were local-server fixtures unable to allocate an ephemeral
port after the long run (`Bun.serve({ port: 0 })` returned `EADDRINUSE`). A fresh
small server-test batch reproduced the same environment-level allocation failure
before executing its first network assertion. Therefore this record does not
claim a passing monolithic root suite. The focused Chat/runtime proofs, build,
browser, packed-output, packed-MV3, typecheck, and privacy gates above are green.

## Still-open release evidence

- A single revision-bound receipt assembled from customer-free, packed,
  lifecycle, and explicitly accepted private proof inputs.
- A root-suite run in an environment where ephemeral local ports remain
  available for the complete test duration.
