# Deep Chat Performance Ratchet Implementation Plan

> **Executor instructions:** Follow this plan in order. Do not check a parent
> task until its implementation, automated proof, live CLI proof, installed or
> packed MV3 proof, privacy gate, and ratchet decision are complete. After each
> proven parent task, create one conventional commit and push it to the existing
> draft PR so the operator can inspect the progression. Never commit private
> tenant prompts, source identifiers, source content, answers, traces, URLs, or
> generated live artifacts.
>
> **Drift check (run first):**
> `git diff --stat 0184fe0d..HEAD -- packages/research/src packages/research/package.json apps/cli/src apps/extension specs/issue-138-deepagents-research`
>
> If an in-scope runtime seam has changed, re-read the current implementation
> and update this plan's assumptions before editing code. Do not preserve a stale
> line-level implementation merely to satisfy this document.

Status: **In progress; T0, T2, and T5 proven; T1 rejected and reverted**

- **Priority:** P1 performance and cost correction after functional Deep Chat proof
- **Effort:** L, delivered as eight independently proven slices
- **Risk:** MEDIUM; the principal risk is removing useful deliberation while reducing orchestration overhead
- **Depends on:** `specs/issue-138-deepagents-research/CHAT-AGENT-RECOVERY-PLAN.md` through the accepted private Deep proof
- **Category:** performance, architecture, observability, tests
- **Planned at:** commit `0184fe0d`, 2026-08-08

## Contents

- [1. Outcome](#1-outcome)
- [2. Measured baseline and diagnosis](#2-measured-baseline-and-diagnosis)
- [3. Non-negotiable architecture and quality invariants](#3-non-negotiable-architecture-and-quality-invariants)
- [4. Ratchet contract](#4-ratchet-contract)
- [5. Commands and proof environments](#5-commands-and-proof-environments)
- [6. Scope](#6-scope)
- [7. Prioritized implementation tasks](#7-prioritized-implementation-tasks)
- [8. Delivery order and commit boundaries](#8-delivery-order-and-commit-boundaries)
- [9. Final acceptance](#9-final-acceptance)
- [10. STOP conditions](#10-stop-conditions)
- [11. Deferred work](#11-deferred-work)

## 1. Outcome

Reduce the latency, token use, and cost of ordinary **Deep Chat** without
turning it into Quick Chat, weakening evidence coverage, removing its central
supervisor, or collapsing it into Deep Research.

The target architecture keeps:

- one central `createDeepAgent` Chat supervisor per turn;
- dynamic, host-validated specialist composition;
- bounded read-only Jira and Confluence capabilities;
- direct reads for explicitly bound pages and issues;
- context-isolated depth-one specialists;
- an independent critic and one final synthesizer on agentic Deep paths;
- targeted repair only when a material defect is admitted;
- durable HITL, steering, stop, restart, queue, and conversation state;
- the same core contracts for CLI, MV3 extension, and ordinary browser shapes.

It removes avoidable model work:

- model calls used only to move between deterministic host states;
- two-call structured-output loops for tool-free specialists;
- sacrificial exact-reader agent loops before a one-shot recovery extractor;
- unnecessary one-reader-per-small-anchor decomposition;
- redundant specialist profiles that add no independent quality signal;
- uncached stable child system/schema prefixes;
- unmeasured provider usage hidden inside one aggregate token counter.

Deep Chat remains conversational. It must not inherit the systematic coverage
horizon, ten-minute default, brief, graph approval, or report artifact contract
of Deep Research.

## 2. Measured baseline and diagnosis

The accepted private read-only Deep comparison proved the path functional but
expensive:

| Metric | Current observation |
| --- | ---: |
| End-to-end duration | approximately 5 minutes 19 seconds |
| Model calls in the matching persisted topology | 18 |
| Aggregated model input tokens | approximately 231k-232k |
| Model output tokens | approximately 26.5k |
| Completed specialist tasks | 7 |
| Durable LangGraph checkpoint operations | 91 |
| Direct Atlassian detail reads | 2 |
| Detail-read coverage | 100% |
| Acquisition-window latency in the persisted run | approximately 116 seconds |

The seven-task topology was:

```text
two exact-context readers in parallel
  -> comparison analyst
  -> provisional answer drafter
  -> independent answer critic
  -> targeted answer repairer
  -> final synthesizer
```

The 231k-232k token figure is a safety-budget aggregate, not an invoice-grade
cost metric. `ResearchModelRunBudget` currently adds normal input,
`cache_creation_input_tokens`, and `cache_read_input_tokens` into one value.
Task T0 must split those dimensions before cost claims become release gates.

### Current code seams

- `packages/research/src/chat-agent/runtime.ts`
  - constructs the single Chat root;
  - installs prompt caching only on the root;
  - gives agentic Chat a default ceiling of 28 model calls;
  - drives the accepted workflow through the supervisor.
- `packages/research/src/chat-agent/prompts.ts`
  - requires the root to acknowledge strategy, propose a graph, advance it,
    perform strategy review, advance again, perform quality review, advance
    again, and close.
- `packages/research/src/chat-agent/workflow.ts`
  - defines the specialist catalog and strict phases;
  - defaults toward parallel exact readers and requires one drafter, critic,
    and synthesizer.
- `packages/research/src/chat-agent/workflow-runtime.ts`
  - compiles and dispatches children;
  - applies native structured output only to drafter, repairer, and synthesizer;
  - starts an exact-reader DeepAgent and falls back to a second structured model
    pass after the bounded primary deadline;
  - serializes the acquisition, analysis, reconciliation, drafting, critique,
    repair, and synthesis phases.
- `packages/research/src/chat-agent/prompt-cache.ts`
  - implements the privacy-safe stable-system-prefix cache boundary used by the root.
- `packages/research/src/chat-agent/providers/anthropic.ts`
  - maps `fast`, `balanced`, and `thorough` to the same model ID with different
    thinking, effort, and output limits;
  - exposes a separate no-thinking finalization binding.
- `packages/research/src/budget.ts` and
  `packages/research/src/model-budget-middleware.ts`
  - reserve and settle the shared model budget but do not preserve per-call,
    per-role, or cache-category usage.

## 3. Non-negotiable architecture and quality invariants

Every task in this plan must preserve all of the following:

1. **One Chat root:** exactly one logical `createDeepAgent` Chat supervisor runs
   per turn. Optimizations must not create additional root agents.
2. **Dynamic composition:** the supervisor still chooses a bounded graph from
   host-admitted profiles. A fixed hard-coded comparison graph is not an
   acceptable shortcut.
3. **Supervisor authority:** the supervisor owns strategy and composition and
   can be re-entered for HITL, steering, changed scope, unexpected task failure,
   or a genuinely new planning decision.
4. **Host authority:** scope, capabilities, budgets, task schemas, dependency
   hydration, quality admission, and final evidence validation remain host-owned.
5. **Independent quality:** an agentic Deep path keeps one independent critic
   and one final synthesizer. Repair remains conditional and defect-directed.
6. **Evidence floor:** direct anchors are read in detail, every factual answer
   block names accepted evidence, wrong-source rate stays zero, and incomplete
   coverage remains an explicit typed gap.
7. **No scope widening:** performance work cannot add searches, broader spaces,
   projects, products, or network access.
8. **Provider neutrality:** native Anthropic features are optional adapter
   accelerators. Providers without native structured output, prompt caching,
   adaptive thinking, or multiple model tiers must retain a correct portable path.
9. **Shape neutrality:** CLI, MV3, and browser use the same strategy, workflow,
   evidence, queue, steering, stop, HITL, and answer contracts.
10. **Privacy:** committed tests and evidence are synthetic. Private live runs
    stay in the operator's external artifact root and never enter Git, PR text,
    CI logs, snapshots, fixtures, or comments.
11. **Deep Research isolation:** no task changes the Research root or reuses its
    report-oriented completion semantics.
12. **No budget masking:** increasing deadlines, model-call limits, total-token
    limits, or monetary ceilings does not count as an optimization.

## 4. Ratchet contract

### 4.1 Fixed benchmark matrix

Create and freeze these customer-free scenarios. Every scenario must use the
same question, bound scope, source corpus, limits, provider/model configuration,
and expected quality labels before and after a change.

| ID | Scenario | Required trajectory |
| --- | --- | --- |
| `deep-single-anchor` | one exact page or issue, simple question | direct; no delegation or search |
| `deep-two-anchor-comparison` | two small exact sources, comparison | agentic; bounded comparison, critic, synth |
| `deep-explicit-contradiction` | two exact sources with a material conflict | agentic; independent contradiction handling |
| `deep-cross-product-relationship` | one Jira and one Confluence anchor with explicit relation | agentic; relationship specialist only when needed |
| `deep-quality-repair` | supported draft with one seeded citation or coverage defect | one critic-directed repair, then synth |
| `deep-follow-up-reuse` | second turn over unchanged accepted evidence | reuse valid evidence without unrelated acquisition |
| `auto-simple-control` | simple exact-context control | direct and no slower than the accepted Auto baseline |
| `research-isolation-control` | explicit Deep Research control | unchanged Research root and report behavior |

The synthetic corpus must contain only neutral tenant, project, space, page,
issue, people, and business names. Private tenant inputs are supplied only by
an ignored external configuration at live-run time.

### 4.2 Quality floor

An optimization is rejected if any fixed case regresses on:

- expected direct versus agentic trajectory;
- exact-anchor source coverage or detail-read coverage;
- citation precision, canonical identity, or supported-assertion score;
- wrong-source rate;
- contradiction, relationship, or material-gap recall;
- false-completeness detection;
- final answer usefulness in operator review;
- follow-up coherence and evidence reuse;
- stop, steering, HITL, restart, or durability semantics;
- absence of Research terminology/report shape in Chat.

Release-blocking quality remains deterministic and hand-labelled. Model judges
may be recorded only as non-blocking diagnostics until separately calibrated.

### 4.3 Performance dimensions

Record for every provider call:

- call ID, root/child role, profile, phase, wave, attempt, and recovery reason;
- provider and model ID plus provider-neutral preference;
- normal input tokens, cache-creation input tokens, cache-read input tokens,
  output tokens, and separately calculated cost when the adapter knows pricing;
- request bytes split into stable system prefix, dynamic system suffix, message
  history, tool schemas, response schema, dependency packets, and evidence data;
- start time, time to first token, streaming duration, and total duration;
- retry, timeout, cancellation, schema repair, exact-reader recovery, and cache hit;
- model calls, PTC calls, HTTP calls, source count, detail-read coverage, and
  final Markdown bytes for the whole run;
- critical-path duration per workflow phase and maximum parallelism observed.

Telemetry must contain no prompts, answers, source bodies, URLs, queries,
identifiers, credentials, hidden reasoning, or tenant names.

### 4.4 Acceptance rule for each slice

For the fixed synthetic lane, compare identical BEFORE and AFTER runs. Use one
warm-up and three measured live-model runs when cost permits; record median and
worst-of-three. A single private operator run confirms real integration but is
not used to claim a percentile.

Each slice is accepted only when:

- all quality-floor checks pass;
- no benchmark case becomes more than 10% slower or consumes more than 10%
  additional fresh input/output tokens without an explicitly accepted quality gain;
- the targeted metric improves by at least 20% latency or 25% calls/fresh input,
  unless the task's exact acceptance criterion is stricter;
- the new best accepted ceiling replaces the previous ceiling in the ratchet;
- a no-improvement or high-variance result is recorded honestly and the change
  is reverted or kept diagnostic-only rather than declared successful.

### 4.5 Final target for the two-anchor Deep Chat case

| Metric | Baseline | Required final ceiling |
| --- | ---: | ---: |
| Model calls without repair | up to 18 observed with repair | <= 10 |
| Model calls with one admitted repair | 18 observed | <= 11 |
| Aggregated model input | ~231k-232k | <= 120k |
| Fresh non-cache input | establish in T0 | at least 50% below T0 baseline |
| Model output | ~26.5k | <= 15k |
| Median live-model latency | ~5:19 private observation | <= 120 seconds |
| Worst of three fixed synthetic runs | establish in T0 | <= 180 seconds |
| Direct Atlassian reads | 2 | no increase |
| Detail-read coverage | 100% | 100% |
| Wrong-source rate | 0 | 0 |

The absolute ceilings are not permission to sacrifice quality. If a ceiling
cannot be met without a quality regression, stop and report the measured
trade-off instead of weakening the quality floor.

## 5. Commands and proof environments

### 5.1 Repository verification

| Purpose | Command | Expected result |
| --- | --- | --- |
| Focused Chat tests | `bun run test packages/research/src/chat-agent/workflow-runtime.test.ts packages/research/src/chat-agent/prompt-cache.test.ts packages/research/src/chat-agent/evaluation.test.ts packages/research/src/chat-agent/contracts.test.ts packages/research/src/budget.test.ts packages/research/src/model-budget-middleware.test.ts` | exit 0; all selected tests pass |
| Full tests | `bun run test` | exit 0; no unexpected skips or failures |
| Typecheck | `bun run typecheck` | exit 0; no TypeScript errors |
| Production build | `bun run build` | exit 0; all Turbo tasks pass |
| Browser entrypoints | `bun run check:browser` | exit 0 |
| MV3 output/CSP | `bun run check:extension-output` | exit 0 |
| Privacy | `bun run check:research-privacy` | exit 0; no private markers or secrets |
| Git scope | `git status --short` and `git diff --check` | only task-scoped files; no whitespace errors |

Always invoke tests through `bun run test`, never bare `bun test`, so workspace
packages resolve their live source under the `development` condition.

### 5.2 Live proof lanes to create in T0

T0 must add one runner with stable commands similar to:

```bash
# Synthetic corpus plus real provider, safe for repeatable measurement.
bun --env-file=.env --conditions=development \
  scripts/chat-performance-ratchet.ts \
  --lane synthetic --case deep-two-anchor-comparison --repeat 3 \
  --output-root /absolute/external/artifact/root

# Read-only private integration. Configuration and artifacts are outside Git.
ATLCLI_CHAT_RATCHET_PRIVATE_CONFIG=/absolute/outside-git/private-live.json \
  bun --env-file=.env --conditions=development \
  scripts/chat-performance-ratchet.ts \
  --lane private --case deep-two-anchor-comparison --repeat 1 \
  --output-root /absolute/external/artifact/root

# Packed production MV3 regression matrix.
bun run --cwd apps/extension test:research-extension-browser
```

The exact final runner flags may differ if an existing benchmark harness offers
a cleaner typed contract. The commands must nevertheless freeze inputs, emit a
versioned privacy-safe measurement JSON, retain full private artifacts only
outside Git, and return non-zero when a ratchet or quality gate fails.

For an installed extension acceptance, rebuild the production extension,
reload it, restore the remembered provider key through the existing Settings
flow, run the same operator-approved read-only question, and compare its safe
aggregate receipt with the CLI receipt. Never automate or perform Jira or
Confluence writes.

## 6. Scope

### In scope

- `packages/research/src/budget.ts`
- `packages/research/src/model-budget-middleware.ts`
- `packages/research/src/chat-agent/runtime.ts`
- `packages/research/src/chat-agent/prompts.ts`
- `packages/research/src/chat-agent/workflow.ts`
- `packages/research/src/chat-agent/workflow-runtime.ts`
- `packages/research/src/chat-agent/prompt-cache.ts`
- `packages/research/src/chat-agent/model.ts`
- `packages/research/src/chat-agent/providers/anthropic.ts`
- `packages/research/src/chat-agent/evaluation.ts`
- directly corresponding `*.test.ts` files
- the smallest necessary CLI and extension adapters for safe performance receipts
- a dedicated benchmark/ratchet runner under `scripts/`
- packed MV3 Chat tests and task-specific documentation
- `specs/deep-chat-performance-ratchet/EVIDENCE.md`, created during execution

### Out of scope

- changing the Deep Research root, graph, brief, report, or ten-minute contract;
- implementing AGG, web search, local Gemma, another provider, or a provider gateway;
- adding Jira or Confluence write capabilities;
- redesigning the Chat UI, activity feed, conversation history, or source cards;
- removing durability, HITL, steering, stop, queue, restart, or prompt-injection defenses;
- persisting hidden reasoning or private model text;
- committing private live fixtures, prompts, source identifiers, reports, URLs,
  traces, queries, tenant names, or derived business facts;
- solving performance by increasing model/token/cost/time ceilings.

## 7. Prioritized implementation tasks

### T0 - Establish per-call observability and freeze the ratchet baseline

Goal: attribute every token and millisecond before changing execution topology.

Implementation:

- [x] Define a versioned `ResearchModelCallObservationV1` shared by Chat and
      Deep Research and containing only the safe
      dimensions from section 4.3.
- [x] Extend model-budget settlement to retain normal input, cache creation,
      cache read, output, and unresolved pessimistic reservations separately.
- [x] Preserve the existing conservative total for hard budget enforcement;
      do not weaken fail-closed reservations or restart semantics.
- [x] Attribute calls to root/profile/phase/wave/attempt without storing task
      objectives or source identifiers.
- [x] Measure phase critical-path time and exact-reader primary/recovery time.
- [x] Add the fixed benchmark matrix and a deterministic comparison/ratchet evaluator.
- [x] Add `scripts/chat-performance-ratchet.ts` or an equivalent typed runner.
- [x] Create `EVIDENCE.md` containing only customer-free measurements, commands,
      accepted ceilings, rejected experiments, and redacted private aggregate receipts.

Automated proof:

- [x] Budget unit tests prove category arithmetic, reservations, settlement,
      retry accounting, cancellation, restore, and old-checkpoint compatibility.
- [x] Observation schemas reject prompts, messages, URLs, source IDs, query text,
      credentials, reasoning, arbitrary metadata, and unknown fields.
- [x] The benchmark runner rejects changed corpus/scope/question/model/limits when
      comparing BEFORE and AFTER receipts.
- [x] A failing quality metric or performance ceiling returns non-zero.
- [x] Existing full tests, typecheck, build, browser, output/CSP, and privacy gates pass.

Live proof:

- [x] Run the fixed synthetic Deep comparison three times with the real model
      and retain one warm-up plus three measured receipts externally.
- [x] Run one operator-approved private CLI comparison and one installed or
      packed MV3 comparison read-only; retain all private material externally.
- [x] Confirm receipts contain model roles and metrics but no tenant-derived data.
- [x] Record the accepted T0 baseline and variance before changing behavior.

Ratchet acceptance:

- [x] The 18-call/~232k aggregate can be attributed by role, phase, attempt,
      cache category, and duration.
- [x] Budget enforcement is unchanged and invoice-like cost is no longer inferred
      from the conservative aggregate.

Commit: `perf(chat): establish deep chat performance ratchet`

### T1 - Use one provider call for every tool-free structured specialist

Goal: remove portable ToolStrategy closure calls where no tool or side effect can be replayed.

Status: rejected and fully reverted. Provider-native output passed isolated
contract tests but failed real DeepAgents/LangGraph child execution before
synthesis. No T1 checkbox or performance claim is accepted; later slices must
reduce topology without relying on this unsafe shortcut.

Implementation:

- [ ] Classify profiles by actual tool/eval/side-effect capability in a typed,
      host-owned predicate; do not use a name-only allowlist hidden in middleware.
- [ ] Route relationship, comparison, contradiction, critic, drafter, repairer,
      and synthesizer through native structured output when the provider binding supports it.
- [ ] Keep exact/search acquisition readers on the portable tool-bearing path.
- [ ] Keep the ToolStrategy fallback for providers without native structured output.
- [ ] Preserve one bounded schema-repair retry only for side-effect-free children.
- [ ] Reconcile profile comments and finalization routing so declared preference
      and effective model are observable and not contradictory.

Automated proof:

- [ ] Each tool-free profile completes from one provider response under a native binding.
- [ ] Tool-bearing profiles still use the safe portable path and never replay an Atlassian read.
- [ ] A provider-neutral injected model still completes every profile through ToolStrategy.
- [ ] Invalid native schema output performs at most one safe retry and cannot dispatch tools.
- [ ] Quality-floor and full repository gates pass.

Live proof:

- [ ] Synthetic Deep comparison and contradiction runs show the expected
      specialist topology with at least two fewer model calls than T0.
- [ ] One private CLI Deep comparison and one packed/installed MV3 Deep comparison
      finish with unchanged sources, coverage, citations, and answer usefulness.
- [ ] No private receipt or answer is committed.

Ratchet acceptance:

- [ ] Tool-free specialists have a one-call normal path.
- [ ] The fixed comparison improves call count by at least 2 with no quality regression.
- [ ] Fresh input/output and latency do not regress beyond the section 4.4 tolerance.

Commit: `perf(chat): use native output for tool-free specialists`

### T2 - Replace sacrificial exact-reader loops with a direct extraction fast path

Goal: make already-bound pages and issues cheap, deterministic acquisition inputs.

Implementation:

- [x] Let the host read admitted exact anchors before constructing the extraction request.
- [x] Build one bounded, provider-neutral structured extraction call over the
      successfully read detail evidence; it may not search, delegate, call eval,
      or replay an Atlassian request.
- [x] Preserve optional smallest-section reads for a question-critical truncated
      Confluence projection, with the existing one-section guard and typed gaps.
- [x] Turn the current direct recovery extractor into the normal fast path or
      share one implementation with it; do not maintain two divergent extractors.
- [x] Retain a fallback child path only for a proven case the direct extractor
      cannot represent, documented by a failing characterization test.
- [x] Bin-pack small exact anchors deterministically by projected bytes and the
      existing maximum-anchor ceiling. Split large anchors or independent slow
      reads; do not blindly create one reader per anchor.
- [x] Preserve source/version identity, canonical refs, coverage limits, and
      prompt-injection isolation in the packet.

Automated proof:

- [x] Two small exact anchors require two HTTP detail reads and one extraction
      call, with no primary deadline or recovery call.
- [x] Large/truncated anchors split or section-read within byte, call, and time limits.
- [x] Cancellation before/after a read preserves `outcome_unknown` and never
      blindly repeats a potentially completed provider call.
- [x] No search is performed for an exact anchor.
- [x] Existing exact-reader recovery, long-page, section-link, evidence, and
      wrong-source regressions remain green or are deliberately superseded by
      stronger tests of the new single implementation.

Live proof:

- [x] Run two operator-approved exact-page CLI answers and the packed production
      MV3 exact-context/strategy lanes; verify direct read,
      canonical citation, useful answer, and no search.
- [x] Run the fixed customer-free two-anchor comparison with the live provider
      and the packed production MV3 contract; verify two
      direct reads, one bounded extraction task, 100% coverage, and no recovery.
- [x] Confirm the acquisition window is at least 40% faster than T0 or stop and diagnose.

Ratchet acceptance:

- [x] Exact acquisition has no routine 30-second sacrificial agent attempt.
- [x] The two-anchor case reaches no more than 12 total model calls at this stage.
- [x] Quality remains at or above T0/T1 and Atlassian call count does not increase.

Commit: `perf(chat): extract bound evidence in one pass`

### T3 - Auto-advance deterministic workflow transitions without recalling the supervisor

Goal: keep the supervisor for decisions while removing model calls that merely select the only legal next state.

Implementation:

- [x] Separate **supervisor decisions** from **host state transitions** in the
      agentic workflow protocol.
- [x] Keep strategy and dynamic graph composition in the root supervisor.
- [x] After workflow admission, let the durable host state machine execute ready
      waves, mandatory deterministic strategy adequacy checks, quality admission,
      optional repair, and synthesis without requiring a new root model call for
      every `advance -> review -> advance` transition.
- [x] Re-enter the supervisor only for HITL, steering, changed scope, unexpected
      failure, no executable frontier, or a quality outcome that offers more
      than one materially different planning action.
- [x] Persist every transition before the next external call and preserve late-result quarantine.
- [x] Keep the final answer owned by the synthesizer, not rewritten by the supervisor.
- [x] Simplify the root prompt and QuickJS control surface to the new protocol;
      remove obsolete ceremonial instructions and tools only after callers migrate.

Automated proof:

- [x] A normal accepted graph completes with no root model recall between its
      deterministic waves and final synthesis.
- [x] Steering, HITL, stop, restart, worker loss, outcome-unknown, task failure,
      and quality-required repair re-enter at the correct durable checkpoint.
- [x] The supervisor still composes different valid graphs for the fixed comparison,
      contradiction, relationship, and repair scenarios.
- [x] One root `createDeepAgent` execution and one final synthesizer remain invariant.
- [x] No child can bypass dependencies, quality review, scope, or evidence validation.

Live proof:

- [x] CLI and packed/installed MV3 Deep comparisons show the same specialist
      graph and answer quality with fewer root calls.
- [x] During one live run, queue a follow-up, steer at a safe checkpoint, and
      stop a separate run; all controls remain responsive and durable.
- [x] Recreate the MV3 worker during a bounded synthetic run and verify safe continuation.

Ratchet acceptance:

- [x] Normal fixed comparison uses no more than 10 model calls without repair
      and no more than 11 with one repair.
- [x] Median latency improves at least 20% from T2 and stays below 180 seconds.
- [x] No quality or durability gate regresses.

Commit: `perf(chat): auto-advance accepted workflows`

### T4 - Add host-owned graph dominance and anchor packing rules

Goal: prevent dynamic composition from creating specialists whose output is dominated by another admitted task.

Implementation:

- [ ] Add typed proposal normalization/admission rules, not prompt-only advice.
- [ ] Let a comparison analyst report evidence-backed differences and conflicts;
      require a separate contradiction checker only for explicit contradiction
      intent, version conflict, or host-detected unresolved conflict risk.
- [ ] Admit a relationship tracer only for explicit/cross-product relationship work.
- [ ] Use deterministic byte-aware exact-anchor packing from T2.
- [ ] Reject ceremonial, duplicate, phase-equivalent, disconnected, or no-op tasks.
- [ ] Keep exactly one drafter, one critic, and one synthesizer for agentic Deep.
- [ ] Keep repair host-only and conditional on material admitted defects.
- [ ] Project the normalized graph and rejection reason into safe diagnostics.

Automated proof:

- [ ] Comparison, contradiction, relationship, and combined-risk gold cases
      produce distinct minimal valid graphs.
- [ ] The host rejects duplicated analysts/readers, unnecessary relationship or
      contradiction tasks, and graphs with unchanged expected information gain.
- [ ] The critic still detects seeded contradiction and citation defects when a
      separate contradiction specialist is correctly omitted.
- [ ] Dynamic composition remains model-selected within the host catalog; tests
      reject a fixed graph disguised as optimization.

Live proof:

- [ ] Run at least three operator-approved read-only questions that require
      comparison-only, explicit contradiction, and cross-product relationship
      trajectories in CLI and packed/installed MV3.
- [ ] Confirm the displayed activity names only specialists actually needed.
- [ ] Human review accepts answer quality and topology choice for all three.

Ratchet acceptance:

- [ ] Comparison-only runs contain no redundant contradiction/relationship task.
- [ ] Explicit-risk runs still contain the required independent specialist.
- [ ] No fixed case exceeds T3 calls, tokens, or latency by more than 10% without
      an accepted quality gain.

Commit: `perf(chat): minimize dynamic specialist graphs`

### T5 - Extend privacy-safe prompt caching to child agents

Goal: reduce billed repeated input without caching private or turn-specific content.

Implementation:

- [x] Reuse one shared cache-boundary helper for root and children.
- [x] Cache only stable provider-compatible system/profile/schema/tool prefixes.
- [x] Keep user questions, conversation summaries, evidence bodies, dependency
      packets, steering, credentials, scope, identifiers, and private metadata
      outside cached segments.
- [x] Use provider cache controls only when the binding explicitly supports them.
- [x] Preserve the provider-neutral no-cache path byte-for-byte semantically.
- [x] Expose cache creation/read token categories through T0 telemetry.
- [x] Evaluate the existing five-minute TTL with repeated fixed runs; change it
      only when measurements justify the privacy and cost trade-off.

Automated proof:

- [x] Child cache tests prove stable-prefix hits and dynamic/private suffix exclusion.
- [x] Two different users, tenants, conversations, scopes, and steering revisions
      cannot share private cache identity or cached dynamic content.
- [x] Provider-neutral bindings receive no provider-specific cache metadata.
- [x] Cached and uncached execution produce identical accepted structured packets.

Live proof:

- [x] Run the same synthetic comparison twice within the TTL and demonstrate
      cache-read tokens on the second run without changed answer/evidence metrics.
- [x] Run one private CLI and one installed MV3 comparison and inspect only the
      safe aggregate receipt; no prompt or source text may appear.

Ratchet acceptance:

- [x] Cache-read and cache-creation tokens are separately visible.
- [x] Repeated billed-equivalent input cost improves by at least 25% or the cache
      change remains diagnostic and is not claimed as successful.
- [x] Aggregate safety-budget accounting and privacy tests remain fail-closed.

Commit: `perf(chat): cache stable child prompts`

### T6 - Make role-based model routing explicit and provider-neutral

Goal: permit genuinely faster acquisition/finalization models without making Anthropic-specific features part of Chat semantics.

Implementation:

- [ ] Replace ambiguous preference comments with a typed role-to-capability
      routing contract covering extraction, analysis, critique, repair,
      synthesis, and root planning.
- [ ] Keep one-model fallback as a first-class supported configuration.
- [ ] Let provider adapters map a preference to the same model, another model,
      reasoning controls, or no special control.
- [ ] Record effective model ID, preference, thinking mode, and finalization
      corridor in T0 telemetry.
- [ ] Do not automatically move critic or synthesis to a cheaper model. Require
      the fixed quality matrix to prove each routing change separately.
- [ ] Keep provider/model selection out of workflow and capability authorization.

Automated proof:

- [ ] The same accepted trajectory runs with a capability-free one-model provider.
- [ ] Routing changes model selection but cannot change scope, graph admission,
      tools, evidence validation, or completion shape.
- [ ] Tests expose and resolve the current declared-`thorough` versus effective
      finalization-model ambiguity.
- [ ] A lower-quality injected finalizer fails quality gates and cannot be adopted.

Live proof:

- [ ] Re-run the full synthetic matrix using the current Anthropic one-model
      adapter and confirm no behavioral regression.
- [ ] If a second production-grade model route is configured, evaluate it as a
      separate candidate; do not make it default without operator acceptance.
- [ ] CLI and installed MV3 report the same effective routing for the same configuration.

Ratchet acceptance:

- [ ] Provider neutrality and one-model fallback remain proven.
- [ ] Any adopted role route improves its targeted latency/cost by at least 20%
      with no quality-floor regression.
- [ ] If no alternative route passes, retain the current model and mark the
      experiment rejected rather than blocking T7.

Commit: `refactor(chat): make model routing measurable`

### T7 - Close the final cross-shape quality/performance ratchet

Goal: prove the optimized path as a user-facing Deep Chat implementation, not merely a faster unit-test topology.

Implementation:

- [ ] Consolidate accepted synthetic measurements and redacted private aggregate
      receipts in `EVIDENCE.md`.
- [ ] Remove superseded experimental flags, duplicate fast/recovery code, stale
      prompt instructions, and diagnostic-only fields that were not adopted.
- [ ] Freeze final ratchet ceilings in the deterministic evaluator.
- [ ] Document Deep Chat latency/cost expectations and the difference from Deep Research.
- [ ] Update package/CLI/extension docs for any changed diagnostics or provider routing.

Automated proof:

- [ ] The full fixed matrix passes all quality and final performance ceilings.
- [ ] Full workspace tests, typecheck, production build, browser checks,
      extension CSP/output gate, public API/closure gates, and privacy scan pass.
- [ ] Quick and Auto simple controls do not regress.
- [ ] Explicit Deep Research remains behaviorally and structurally unchanged.
- [ ] A negative ratchet fixture proves calls, fresh tokens, latency, wrong
      sources, false completeness, and lost quality each fail independently.

Live proof:

- [ ] Run one warm-up and three measured synthetic Deep comparison runs.
- [ ] Run the operator-approved private CLI matrix for simple exact context,
      two-source comparison, explicit contradiction or relationship, repair,
      follow-up reuse, HITL, steering, and stop.
- [ ] Run the matching installed production MV3 matrix, including worker recreation.
- [ ] Human review accepts answer usefulness, source choice, citations, visible
      progress, responsiveness, follow-up coherence, latency, and cost trade-off.
- [ ] Copy every private artifact only to the external timestamped artifact root;
      run privacy and staged-diff scans before commit and push.

Ratchet acceptance:

- [ ] Two-anchor Deep Chat meets every final ceiling in section 4.5.
- [ ] No fixed quality case regresses from T0.
- [ ] The supervisor remains central and composition remains dynamic.
- [ ] CLI and MV3 share the same core trajectory and differ only in presentation/host adapters.
- [ ] The user never waits on Deep Research semantics when ordinary Deep Chat was selected.

Commit: `perf(chat): enforce deep chat performance ceilings`

## 8. Delivery order and commit boundaries

Execute strictly in this order:

1. T0 telemetry and baseline
2. T1 native structured output
3. T2 direct exact extraction and anchor packing
4. T3 deterministic host auto-advance
5. T4 graph dominance rules
6. T5 child prompt caching
7. T6 explicit provider-neutral model routing
8. T7 final cross-shape ratchet

After each parent task:

1. run its focused tests and live proofs;
2. run typecheck, privacy, production extension build, and output/CSP gates;
3. update only customer-free/redacted `EVIDENCE.md` measurements;
4. check the parent task only when every child checkbox is proven;
5. create the listed conventional commit;
6. push the branch to the existing draft PR;
7. update the draft PR description only with public-safe architecture and
   aggregate proof; never mention private tenant inputs or artifacts.

Do not combine unproven tasks in one commit. A task that fails its ratchet is
recorded as rejected or blocked and must not be checked merely because its code exists.

## 9. Final acceptance

This plan is complete only when all are true:

- [ ] Every parent task T0-T7 and every automated/live acceptance checkbox is checked.
- [ ] Deep Chat comparison uses at most 10 model calls normally and 11 with one repair.
- [ ] Aggregated input is at most 120k and fresh input is at least 50% below T0.
- [ ] Model output is at most 15k for the fixed comparison.
- [ ] Median fixed live-model latency is at most 120 seconds and worst-of-three at most 180 seconds.
- [ ] Detail-read coverage is 100%, wrong-source rate is zero, and central claims remain supported.
- [ ] Critic, conditional repair, and final synthesizer remain effective quality boundaries.
- [ ] The central supervisor and dynamic graph composition remain observable and tested.
- [ ] Quick, Auto, Deep, and explicit Deep Research retain distinct truthful semantics.
- [ ] CLI, MV3, and browser core contracts remain shape-neutral.
- [ ] Steering, stop, queue, HITL, restart, and follow-up evidence reuse remain proven.
- [ ] No private tenant data or generated live artifact exists in Git, the PR, CI, or public collaboration surfaces.
- [ ] Full repository verification and the production extension build pass.

## 10. STOP conditions

Stop and report instead of improvising when:

- the drift check shows that the current runtime no longer matches the diagnosed seams;
- T0 cannot attribute provider calls without persisting private content;
- an optimization requires removing the independent critic or final synthesizer;
- host auto-advance would make steering, HITL, cancellation, or restart non-durable;
- a direct extraction path cannot preserve exact source/version identity or section coverage;
- a provider-specific feature would become necessary for correctness rather than optional acceleration;
- a ratchet can be met only by raising limits, hiding tokens, reducing evidence,
  skipping material defects, or changing the frozen benchmark input;
- the same blocking proof fails twice after a scoped correction;
- implementation requires Jira/Confluence writes or private committed fixtures;
- any private identifier, source content, answer, URL, query, or artifact appears
  in a staged diff, PR text, CI output, or committed evidence file.

## 11. Deferred work

The following may be considered after T7 but must not expand this implementation:

- local Gemma or another in-browser/local model;
- a multi-provider gateway or enterprise secret broker;
- the separately planned Confluence REST/AGG A/B slice;
- web search as a shape-neutral capability;
- Deep Research performance work;
- exact token-chunk replay after MV3 worker loss;
- broad checkpoint/state compaction unless profiling proves it material after
  model-call reduction;
- UI redesign beyond exposing already-defined safe aggregate diagnostics.

The first optimization target is model topology, not Atlassian REST, QuickJS,
durability, or the evidence ledger. Those components were not the dominant cost
in the measured two-source Deep Chat run.
