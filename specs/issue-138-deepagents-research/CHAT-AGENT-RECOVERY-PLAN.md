# Kiteweave Chat Agent Recovery Plan

Status: **In progress; C0 baseline proven**

## Contents

- [1. Purpose](#1-purpose)
- [2. Corrective diagnosis](#2-corrective-diagnosis)
- [3. Fixed product contract](#3-fixed-product-contract)
- [4. Target architecture](#4-target-architecture)
- [5. Implementation and proof rules](#5-implementation-and-proof-rules)
- [6. Corrective implementation tasks](#6-corrective-implementation-tasks)
- [7. Delivery stages and commit boundaries](#7-delivery-stages-and-commit-boundaries)
- [8. Decisions deliberately deferred to measurement](#8-decisions-deliberately-deferred-to-measurement)
- [9. Definition of success](#9-definition-of-success)

## 1. Purpose

This plan corrects the current implementation direction for ordinary Chat.
The existing runtime exposes `quick`, `auto`, and `deep` quality labels, but the
active Chat path is still a constrained single-agent research-report path.
`deep` currently increases provider reasoning effort without changing the
workflow, retrieval strategy, independent validation, or completion objective.
That is not the product contract we intend to ship.

The corrected product has two separate top-level DeepAgentsJS agents:

- **Kiteweave Chat Agent** for conversational answers in `quick`, `auto`, or
  `deep` quality mode.
- **Kiteweave Research Agent** for explicitly selected, long-running Deep
  Research with an accepted brief, systematic coverage targets, a research
  ledger, and a canonical report artifact.

Both agents use the same DeepAgentsJS harness, host-owned QuickJS/PTC boundary,
read-only Atlassian capabilities, evidence stores, durable control ports, and
presenter-neutral events. They do not share root prompts, completion schemas,
workflow policy, or finalization logic.

This document is the canonical implementation order for repairing ordinary
Chat. It supersedes the **execution order** of Chat work in
`AGENTIC-CHAT-QUALITY-PLAN.md`. It does not invalidate that document's security,
durability, retrieval, evaluation, or Deep Research requirements. Research-only
tasks remain on the Research track.

## 2. Corrective diagnosis

The current Chat path has five structural defects:

1. `deep` changes provider controls but not agent behavior. It does not enable a
   strategy decision, dynamic decomposition, independent critique, repair, or a
   dedicated synthesizer.
2. Chat still uses a research-agent prompt, research draft schema, and research
   report finalizer. A conversational answer is forced into findings,
   relationships, limitations, and report-oriented presentation.
3. Retrieval is a fixed search-rank-detail program. It cannot directly read a
   bound entity, formulate a focused query, inspect a document outline, fetch a
   missing section, diversify a failed query, or perform gap-directed repair.
4. Conversation history exists, but accepted evidence is not yet durable
   cross-turn Chat memory. Every new turn starts another acquisition boundary,
   even when unchanged evidence could be safely reused.
5. Existing proof emphasizes contracts, isolation, budgets, and recovery. Those
   are necessary, but they do not prove that a user receives the right source,
   a useful answer, correct citations, or a coherent follow-up.

The recovery track therefore starts with the smallest visible quality proof:

> Read one explicitly attached Jira issue or Confluence page directly, answer
> the user's actual question as a normal Chat response, cite the canonical
> source, and reuse that evidence correctly in a follow-up turn.

Dynamic subagents are added only after that direct path is correct. More agents
must never amplify weak retrieval or turn a simple question into ceremonial
workflow overhead.

## 3. Fixed product contract

### 3.1 Outer product modes

| Product mode | Root agent | Completion objective | Default output |
| --- | --- | --- | --- |
| Chat | Kiteweave Chat Agent | Sufficiently supported conversational answer | Chat Markdown |
| Deep Research | Kiteweave Research Agent | Coverage against an accepted research brief | Canonical report Markdown |

Deep Research is entered only by explicit user choice. Chat may offer a
continuation or suggest switching to Deep Research, but it may never silently
promote itself.

### 3.2 Chat quality modes

| Chat quality | Root behavior | Delegation | Validation | Completion horizon |
| --- | --- | --- | --- | --- |
| `quick` | Direct bounded answer | Disabled; task bridge is not constructed | Deterministic evidence/citation boundary | Lowest conversational latency |
| `auto` | Supervisor chooses direct or agentic execution | Adaptive | Conditional quality assessment, critic, and repair | Conversational |
| `deep` | Supervisor must make an explicit strategy decision | Dynamically available when useful | Strong quality assessment; agentic paths use an independent critic and synthesizer | Conversational, never the Research ten-minute default |

Provider reasoning controls are optional accelerators behind a provider adapter.
They may not determine workflow availability or completion semantics. A provider
without an effort flag must run the same accepted trajectory.

### 3.3 Root construction invariant

The public factories are:

```ts
createKiteweaveChatAgent({ qualityMode, hostBindings })
createKiteweaveResearchAgent({ hostBindings })
```

The Chat factory owns two audited internal root configurations:

- a direct-only configuration for `quick`, without subagent middleware or a
  QuickJS `task()` bridge;
- an agentic-capable configuration for `auto` and `deep`, with the repository-
  owned `subAgentMiddleware` and durable bridge dispatcher.

Only one configuration is selected for a turn and only one logical root
`createDeepAgent` execution runs for that turn. `auto` and `deep` may finish
directly without dispatching a child. Routing, critique, repair, and synthesis
must not create additional root agents.

Immutable root construction may be cached only after typed per-run binding and
cross-user, thread, scope, cache, abort, and steering isolation are proven. Safe
per-turn construction remains the fallback.

## 4. Target architecture

```mermaid
flowchart TD
    Shape["CLI / Extension / Browser"] --> Router{"Product mode"}
    Router -->|"Chat"| Chat["Kiteweave Chat Agent"]
    Router -->|"Deep Research"| Research["Kiteweave Research Agent"]

    Chat --> Quality{"quick / auto / deep"}
    Quality -->|"quick"| Direct["Direct answer path"]
    Quality -->|"auto or deep"| Strategy["Host-validated strategy decision"]
    Strategy -->|"direct"| Direct
    Strategy -->|"agentic"| Workflow["Dynamic child workflow"]
    Workflow --> Critic["Conditional independent critic / repair"]
    Critic --> Synth["Dedicated Chat synthesizer"]
    Direct --> Answer["ChatAnswerV1 / Markdown"]
    Synth --> Answer

    Research --> Brief["Brief / coverage / research graph"]
    Brief --> Report["ResearchReportV2 / canonical Markdown"]

    Chat --> Core["Shared agentic, retrieval, evidence, durability, and control core"]
    Research --> Core
```

### 4.1 Module boundary

Implement the separation inside the current package first. Do not begin with a
large workspace-package migration.

```text
packages/research/src/
  agentic-workflow-core.ts
  dispatch-adapter.ts
  chat-agent/
    contracts.ts
    runtime.ts
    prompts.ts
    strategy.ts
    retrieval.ts
    profiles.ts
    quality.ts
    answer.ts
    session.ts
  research-agent/
    runtime.ts
```

Move a primitive into a shared directory only when both roots consume the same
contract. Do not create a second capability broker, dispatcher, evidence store,
queue, or checkpointer for Chat.

### 4.2 Chat answer contract

Chat must not use a Research draft or report contract. Introduce a small typed
completion boundary similar to:

```ts
interface ChatAnswerV1 {
  schema: "atlcli.chat-answer/v1";
  messageMarkdown: string;
  citations: ChatCitationV1[];
  evidenceRefs: string[];
  gaps: ChatAnswerGapV1[];
  continuation?: ChatContinuationOfferV1;
}
```

The Markdown is the conversational response. Sources may also be projected as
UI source cards, but source cards never replace canonical inline or adjacent
citations. A Chat answer has no mandatory title, executive summary, findings
section, relationship section, limitation appendix, or report artifact.

## 5. Implementation and proof rules

- Parent task checkboxes are checked only after every implementation, automated
  test, and live acceptance checkbox in that task is complete.
- Complete and push one conventional commit after each proven parent task.
- Run the focused tests, root typecheck, production extension build, output/CSP
  audit, and tracked-tree research privacy scan before each pushed task commit.
- Run the full workspace suite at the Stage A, B, and C exit gates.
- Every runtime task requires a real read-only CLI run and a packed or installed
  MV3 run through the active production caller path.
- Private tenant questions, page/issue content, traces, reports, identifiers, and
  derived fixtures remain outside Git, PR descriptions, comments, and CI logs.
- Synthetic committed fixtures use only neutral test tenants, spaces, projects,
  pages, issues, people, and business content.
- No task may be accepted from mock-only proof when the task changes an active
  runtime path.

## 6. Corrective implementation tasks

### C0 — Freeze the failing baseline and establish quality measurements

Goal: make the current failure observable before replacing the path.

Implementation:

- [x] Define a versioned Chat evaluation observation containing answer outcome,
      selected sources, detail reads, citations, gaps, mode, strategy, model/PTC/
      HTTP calls, tokens, latency, and final Markdown length.
- [x] Add customer-free gold cases for an attached page, attached issue, long
      page, follow-up, Jira reference in a page, multi-source comparison,
      contradiction, no-evidence abstention, and context switch.
- [x] Capture the current direct Chat result as the `legacy-chat` comparison
      variant without freezing its implementation as desired behavior.
- [x] Record provider-effort-only `quick`, `auto`, and `deep` trajectories so the
      recovery work can prove that workflow changes, not only token increases,
      improve quality.

Automated proof:

- [x] Gold labels and metric calculations are deterministic and reject unknown
      source IDs, unsupported citations, or non-normalized requests.
- [x] The comparison harness proves that every variant receives the same scope,
      source corpus, question, and root budget envelope.
- [x] Evaluation artifacts cannot contain credentials, raw private source bodies,
      hidden reasoning, or committed private tenant identifiers.

Live acceptance:

- [x] Run one private read-only CLI baseline and one MV3 baseline through the
      production Chat path; retain artifacts only in the external artifact root.
- [x] Human review records the concrete wrong-source, answer-shape, retrieval,
      citation, completeness, latency, and follow-up defects without committing
      private input or output.

Acceptance criteria:

- [x] We can reproduce and score the current quality failure before changing the
      runtime.
- [x] The baseline distinguishes provider reasoning effort from orchestration and
      retrieval quality.

Proof record (2026-08-05): the focused Chat evaluation suite and workspace
typecheck pass; the production extension builds and passes its output gate; the
packed MV3 Chat E2E passes; private read-only CLI, follow-up, effort-comparison,
and installed-MV3 observations are retained only in the external artifact root.

### C1 — Split the Chat root from the Research root

Goal: stop running ordinary Chat through `runResearchAgent` and Research report
finalization.

Implementation:

- [ ] Add `ChatTurnRequestV1`, `ChatQualityPolicyV1`, `ChatAnswerV1`, citation,
      gap, strategy, continuation, and typed error contracts.
- [ ] Add `createKiteweaveChatAgent` and `runChatAgent` as a separate root runtime.
- [ ] Rename or wrap the existing production entry as
      `createKiteweaveResearchAgent`/`runResearchAgent` without changing Research
      semantics.
- [ ] Give Chat its own system prompt and user-turn prompt. Remove the terms
      research brief, research graph, report outline, research coverage, and
      canonical report from the Chat prompt.
- [ ] Add a Chat finalizer that validates evidence/citations and returns
      `ChatAnswerV1` without invoking Research report schemas or finalizers.
- [ ] Route CLI and extension Chat worker calls to `runChatAgent`; keep Deep
      Research routed to `runResearchAgent`.
- [ ] Version persisted Chat state so an old Research-shaped Chat checkpoint
      cannot be resumed under the new contract as though it were compatible.

Automated proof:

- [ ] Import-boundary test proves the Chat runtime does not import
      `ResearchBriefV1`, Research graph composition, Research draft schemas, or
      Research report finalization.
- [ ] Root-spy tests prove one Chat `createDeepAgent` root per turn and a separate
      Research root factory.
- [ ] Chat structured-output repair returns only `ChatAnswerV1`; it cannot fall
      back to findings/relationships/limitations arrays.
- [ ] Existing Deep Research graph, report, resume, and privacy tests remain green.

Live acceptance:

- [ ] CLI and MV3 answer a simple synthetic question as natural Chat Markdown.
- [ ] The response contains no research-report heading or empty report sections.
- [ ] Explicit Deep Research still produces its canonical report artifact.

Acceptance criteria:

- [ ] Chat and Research have separate roots, prompts, completion objectives, and
      finalizers while sharing the same secure host infrastructure.

### C2 — Prove exact-context direct reading

Goal: make the most common current-page/current-issue question correct before
adding agentic complexity.

Implementation:

- [ ] Add a host-issued exact-anchor reference for the bound Confluence page or
      Jira issue. The model may use the opaque reference but may not substitute an
      arbitrary page ID, issue key, URL, tenant, or scope.
- [ ] Add a direct bound-entity read capability that validates tenant, binding,
      entity kind, authorization, byte budget, timeout, and cancellation before
      HTTP.
- [ ] Remove search and candidate ranking from the exact-anchor path.
- [ ] Treat the containing project/space only as validation authority; do not
      search it unless the question or an explicit added context requests a
      broader scope.
- [ ] Trigger Jira acquisition from a Confluence-only turn only when the question
      requires Jira or the retrieved page exposes a Jira key, structured Jira
      macro, or Jira link that is material to the answer.
- [ ] Preserve the canonical URL and exact source identity from the host response;
      never let the model construct them.

Automated proof:

- [ ] Attached-page test performs one matching detail read and zero search HTTP
      calls.
- [ ] Attached-issue test performs one matching detail read and zero search HTTP
      calls.
- [ ] A hostile or stale presenter-supplied anchor cannot widen or replace the
      host binding.
- [ ] A mismatched detail response fails closed and cannot fall back to another
      search result.
- [ ] Confluence-only input produces zero Jira calls unless an admitted Jira
      signal is observed and relevant.
- [ ] Canonical URL tests cover personal-space keys, renamed titles, encoded
      paths, and issue keys without trusting model-authored URLs.

Live acceptance:

- [ ] In CLI and MV3, summarize one exact attached page correctly with its
      canonical citation and no unrelated source.
- [ ] In CLI and MV3, answer one exact issue question correctly with no unrelated
      page or project search.
- [ ] The user-visible activity says the named attached entity is being read; it
      does not claim that the containing space/project is being searched.

Acceptance criteria:

- [ ] Exact-context wrong-source rate is zero in the committed gold set.
- [ ] Exact-context retrieval performs no unnecessary search operation.

### C3 — Add navigable long-document reading

Goal: prevent long or structurally complex Confluence pages from collapsing into
an unhelpful truncated excerpt.

Implementation:

- [ ] Add a bounded document-outline projection containing canonical section
      identities, headings, ordering, content byte estimates, and structured
      macro/link metadata without full bodies.
- [ ] Add an authorized section/chunk read capability using only host-issued
      section references.
- [ ] Let the direct Chat root choose relevant sections from the outline and fetch
      additional sections until the question is supported or the Chat budget
      enters finalization reserve.
- [ ] Preserve exact visible support spans and section identity for citations.
- [ ] Distinguish source truncation, projection truncation, unread sections, and
      genuinely empty content. Do not turn any of them into a claim that content
      is absent from the complete page.
- [ ] Bound section count, characters, bytes, nodes, depth, calls, concurrency,
      and cumulative retained evidence.

Automated proof:

- [ ] The relevant evidence exists only in a late section and is still found.
- [ ] A large irrelevant section is not loaded when the outline identifies a
      narrower relevant section.
- [ ] Section references cannot be forged, replayed across tenants, or used after
      their turn/scope revision is obsolete.
- [ ] Truncation tests distinguish a supported positive excerpt from an
      unsupported whole-document negative claim.
- [ ] Near-limit and overflow cases fail with a supported partial answer or typed
      gap, never silent clipping or an invented completion claim.

Live acceptance:

- [ ] CLI and MV3 correctly answer a question whose support is beyond the first
      projection of a long read-only page.
- [ ] The answer cites the correct page and states only material residual coverage
      gaps in user language.

Acceptance criteria:

- [ ] A long attached page can produce a useful supported answer without treating
      the whole page as unusable solely because one projection was truncated.

### C4 — Implement real `quick`, `auto`, and `deep` Chat strategies

Goal: make quality modes change host-validated workflow behavior rather than only
provider reasoning controls.

Implementation:

- [ ] Keep `quick` on the direct-only Chat root. Do not construct subagent
      middleware, a task registry, or QuickJS task bridge.
- [ ] Add `ChatStrategyDecisionV1` and a host-validated strategy-decision PTC for
      the agentic-capable root.
- [ ] Include direct-versus-agentic execution, closed reason codes, ambiguity
      disposition, required capability classes, expected complexity, and quality
      risks in the strategy contract.
- [ ] In `auto`, permit either direct or agentic execution based on the question,
      anchors, source count, comparison/relationship intent, contradiction risk,
      and unresolved ambiguity.
- [ ] In `deep`, require an explicit strategy decision. Permit a direct strategy
      for a genuinely simple exact-context question, but require additional
      quality work when material complexity or evidence risk is present.
- [ ] Map provider-neutral `fast`, `balanced`, and `thorough` preferences only
      after the host accepts the workflow policy.
- [ ] Add a capability-free provider adapter that ignores reasoning preference
      without changing the accepted trajectory.

Automated proof:

- [ ] Quick never exposes or dispatches `task()`.
- [ ] Auto selects direct execution for simple exact-context gold cases.
- [ ] Auto selects agentic execution for multi-source comparison, relationship,
      and contradiction gold cases.
- [ ] Deep always records one accepted strategy decision and does not imply that
      subagents are mandatory for a trivial case.
- [ ] Identical host trajectories result with a provider that has no reasoning-
      effort feature.
- [ ] Provider controls cannot enable delegation or alter authorization, scope,
      budgets, completion objective, or finalization.

Live acceptance:

- [ ] Run the same simple and complex private read-only questions in Quick, Auto,
      and Deep through CLI and MV3.
- [ ] Inspect body-free trajectories and confirm that mode-specific workflow
      behavior, not only token usage, differs as designed.

Acceptance criteria:

- [ ] Auto is cheaper/faster on simple cases than an unnecessary agentic run.
- [ ] Deep improves complex-question quality over Quick without regressing exact-
      context correctness.

### C5 — Add dynamic Chat subagent composition

Goal: let one central Chat supervisor dynamically isolate complex work while
keeping simple answers direct.

Implementation:

- [ ] Register narrow host-owned profiles for exact-context reading, Confluence
      search, Jira search, relationship tracing, comparison analysis,
      contradiction checking, answer critique, and Chat synthesis.
- [ ] Give each profile the minimum PTC capabilities, response schema, prompt,
      context projection, model preference, budget slice, and duration required
      by its role.
- [ ] Add a host-validated Chat workflow proposal using the generalized
      `AgenticWorkflowV1` core and `conversation-answer` objective.
- [ ] Let QuickJS compose dynamically sized parallel frontiers and dependency-
      driven continuation from only the host-returned admitted tasks.
- [ ] Route bridged `task()` calls through the shared durable dispatcher with
      authorization, HITL, deterministic task/attempt IDs, reserve-before-call
      budgets, cancellation, and journal writes.
- [ ] Keep child depth at one. A child cannot delegate, access sibling context,
      inspect the full supervisor history, or receive another child's trajectory.
- [ ] Keep source bodies in the evidence workspace; guest code and child packets
      carry bounded references, metadata, support spans, claims, and gaps.
- [ ] Dispatch exactly one dedicated Chat synthesizer for every agentic Chat path.

Automated proof:

- [ ] Deterministic composition tests cover direct, two-sibling parallel, multi-
      wave dependency, optional critic, repair, and synthesis topologies.
- [ ] Sibling timing proves real concurrency under the host concurrency ceiling.
- [ ] Context-isolation tests prove no sibling/full-supervisor/source-body leak.
- [ ] Unknown profile, forged task, duplicate dispatch, dependency violation,
      nested delegation, raw network, GraphQL, filesystem, Chrome API, credential,
      and mutation attempts fail before provider execution.
- [ ] Packet item/character/byte/depth limits have explicit near-limit and
      overflow rejection tests.
- [ ] Exactly one root and one agentic-path synthesizer execute per turn.

Live acceptance:

- [ ] A real read-only complex CLI question produces a dynamically composed
      workflow whose child tasks materially match the question.
- [ ] The equivalent MV3 run uses the same accepted topology and capability
      closure.
- [ ] A simple exact-page Deep turn may remain direct and dispatch no ceremonial
      children.

Acceptance criteria:

- [ ] Dynamic composition reduces supervisor context and improves the complex
      answer without changing scope or exposing extra capabilities.

### C6 — Implement Chat retrieval planning and candidate accountability

Goal: replace fixed search-rank-detail behavior with question-directed retrieval
that stops at sufficient evidence rather than pretending a fixed cap is complete.

Implementation:

- [ ] Add `ChatRetrievalPlanV1` with anchors, resolved entities, admitted searches,
      relationship traversals, unresolved terms, completion signals, and budget
      reservations.
- [ ] Enforce the retrieval order: bound anchors; explicit URL/ID/key; approved
      natural-language resolver; focused scoped search; query variants;
      relationship traversal; controlled related-scope proposal; completion
      assessment.
- [ ] Add a durable candidate ledger containing discovery provenance, query
      variant, rank, canonical identity, version, authority, deduplication,
      admission, detail-read state, exclusion reason, and deferred state.
- [ ] Add bounded query reformulation and saturation detection for alternate
      titles, synonyms, terminology, and time windows.
- [ ] Traverse Confluence-to-Jira text keys, structured Jira macros, and links,
      plus Jira-to-Confluence remote links, without implicitly granting broader
      whole-project or whole-space access.
- [ ] Resolve natural-language project/space names through approved catalog tools;
      pause through HITL when a material ambiguity remains.
- [ ] Reserve separate root capacity for direct reads, discovery/pagination,
      traversal, repair, critique, and synthesis. Rank further work by expected
      information gain rather than a fixed candidate count.
- [ ] Add a host-owned sufficient-evidence assessment for Chat that remains
      distinct from Research corpus completeness.

Automated proof:

- [ ] Relevant later-page candidate, alternate title, synonym, explicit link,
      search-index miss, Jira text key, Jira macro, Jira remote link, stale/new
      duplicate, and ambiguous resolver scenarios all have individual tests.
- [ ] Every admitted candidate ends in detail-read, excluded-with-reason, or
      deferred-with-disclosed-reason state.
- [ ] Few search results, index exhaustion, or a read cap cannot alone set
      sufficient evidence to true.
- [ ] Invalid CQL/JQL, cursor, tenant, scope, traversal, or budget proposals fail
      before HTTP.
- [ ] CLI and MV3 consume the same retrieval plan and candidate trace.

Live acceptance:

- [ ] A private read-only case demonstrates a relevant source found only by a
      later page or bounded query variant.
- [ ] The resulting answer and diagnostics account for every admitted candidate
      without exposing private source bodies in committed output.

Acceptance criteria:

- [ ] Retrieval recall, wrong-source rate, detail-read coverage, canonical URL
      correctness, Atlassian calls, and latency are measurable per turn.

### C7 — Add sufficient-evidence assessment, critic, repair, and synthesis

Goal: prevent a single model from acquiring, judging, and publishing its own
unsupported interpretation without an independent quality boundary.

Implementation:

- [ ] Define a versioned groundedness rubric for question coverage, claim support,
      citation correctness, source authority/freshness, contradiction handling,
      wrong-source risk, uncovered candidates, and false completeness.
- [ ] Run deterministic host checks before any model critic: known source IDs,
      canonical URLs, admitted details, scope, evidence version, and citation
      references.
- [ ] Schedule an independent critic conditionally for Auto and for every
      materially complex agentic Deep path. Skip it only when an accepted direct
      single-source assessment proves low risk.
- [ ] Return typed defects such as unsupported claim, wrong source, missing
      context, incomplete retrieval, unresolved contradiction, or question not
      answered.
- [ ] Convert material defects into one bounded targeted repair wave; do not repeat
      generic discovery or allow unbounded self-critique loops.
- [ ] Reserve time and model budget for final synthesis before admitting repair.
- [ ] Give the final Chat synthesizer only the user objective, accepted evidence/
      claim references, supported spans, dispositions, explicit gaps, and answer
      style contract.
- [ ] At deadline, publish supported partial findings plus explicit material gaps
      and an optional continuation; never fabricate completeness.

Automated proof:

- [ ] Gold cases cover unsupported claim, wrong source, missing detail,
      truncation, contradiction, stale/duplicate sources, irrelevant candidates,
      prompt injection, repair success, and repair-budget exhaustion.
- [ ] The critic catches an intentionally wrong citation and the repair improves
      the final scored answer.
- [ ] Maximum critic/repair iterations and synthesis reserve are host-enforced,
      not prompt-only.
- [ ] Retrieved content cannot alter tools, scope, models, workflow, HITL, secrets,
      mutation policy, or rubric decisions.
- [ ] A synthesizer cannot cite rejected evidence or omit a blocking unresolved
      gap without deterministic rejection.

Live acceptance:

- [ ] One private complex run shows a real critic defect, targeted repair, and
      improved final answer through both CLI and MV3 production paths.
- [ ] Human review confirms the final answer addresses the question rather than
      merely enumerating limitations.

Acceptance criteria:

- [ ] Agentic Chat has an independent quality loop and a single coherent final
      author without becoming a fixed always-on pipeline.

### C8 — Add durable multi-turn Chat and evidence memory

Goal: preserve conversational continuity without treating summaries or stale tool
transcripts as factual authority.

Implementation:

- [ ] Add `ChatSessionV1` and `ChatTurnV1` with versioned objective, quality mode,
      accepted strategy/workflow, controls, final answer, and compact activity
      references.
- [ ] Keep conversation memory, operational summaries, and evidence memory as
      separate state classes with explicit resume ownership.
- [ ] Persist accepted evidence by tenant, scope/capability provenance, canonical
      identity, version/last-modified, capture time, content hash, and supporting
      claim references.
- [ ] Reuse unchanged evidence only inside the accepted freshness window and
      authorized scope; revalidate or re-read changed, stale, or newly material
      evidence.
- [ ] Build each new supervisor context from the current user turn, compact
      conversation summary, recent messages, accepted evidence/claim references,
      unresolved gaps, and controls. Do not replay raw historic tool transcripts
      by default.
- [ ] Keep DeepAgentsJS conversation summarization as non-authoritative operational
      context and preserve provider prompt-cache privacy boundaries.
- [ ] Fence user, thread, tenant, scope, provider-cache identity, revision, abort,
      and steering state across root reuse or worker recreation.

Automated proof:

- [ ] A fresh follow-up reuses accepted evidence with zero unnecessary HTTP reads.
- [ ] A changed or stale source is revalidated and dependent claims are refreshed
      or invalidated.
- [ ] A context switch cannot retain obsolete evidence as answer authority.
- [ ] A 1,000-turn synthetic conversation remains bounded and semantically stable
      across native compaction.
- [ ] Cross-user/thread/tenant isolation and hostile stale-client resume tests fail
      closed.

Live acceptance:

- [ ] Run at least three connected read-only turns in CLI and MV3: initial answer,
      evidence-based follow-up, then a materially different follow-up requiring
      new acquisition.
- [ ] Reload/restart between turns and verify that the correct conversation and
      evidence state resume without repeating settled calls.

Acceptance criteria:

- [ ] Conversation continuity and factual evidence reuse are both durable, but
      neither can overwrite the other's authority boundary.

### C9 — Add shared HITL, steering, stop, queue, and streaming

Goal: make Chat interactive and inspectable across shapes without leaking debug
state or hidden reasoning.

Implementation:

- [ ] Add the shared durable `askUserQuestion` tool for multiple-choice, free-text,
      constrained mixed answers, and declared-assumption continuation.
- [ ] Add one host-neutral FIFO queue with edit/delete-before-admission and a
      separate immediate steering command applied at a durable checkpoint.
- [ ] Propagate stop through root, children, broker, pagination, catalog,
      interpreter bridge, and provider calls; quarantine obsolete late results.
- [ ] Project semantic events for strategy, direct read, search, selected sources,
      child work, critique, repair, synthesis, gap, HITL, steering, stop,
      continuation, and completion.
- [ ] Stream final Chat Markdown incrementally. Do not stream hidden reasoning,
      raw child output, credentials, raw source bodies, provider payloads, or
      budget/debug counters to the normal user view.
- [ ] Persist replayable activity and the completed final answer atomically. Treat
      exact mid-provider token replay as later hardening unless evidence justifies
      its cost.
- [ ] Provide complete German/English presentation copy and deterministic fallback
      for every event and error state.

Automated proof:

- [ ] HITL pause/reload/answer/resume works with every supported question shape.
- [ ] Queue messages remain FIFO and separately editable/deletable; immediate
      steering does not become an ordinary queued follow-up.
- [ ] Steering revises only eligible remaining work and re-runs scope/HITL checks.
- [ ] Stop acknowledgement meets an evidence-backed bound and no cancelled result
      can enter synthesis.
- [ ] Event snapshots contain no raw private/debug/reasoning fields and cover both
      locales.
- [ ] Streaming interruption resumes from the last durable workflow checkpoint or
      reports a typed resumable interruption without pretending token replay.

Live acceptance:

- [ ] Demonstrate queue, edit, delete, steering, stop, HITL, and resume in CLI and
      packed/installed MV3 against read-only operations.
- [ ] Confirm that the visible activity explains useful work in user language and
      expandable details remain concise and privacy-safe.

Acceptance criteria:

- [ ] All interaction controls use the same core contract in every host shape.

### C10 — Complete CLI, extension, and ordinary-browser parity

Goal: expose one Chat product with identical semantics rather than separate host-
specific agents.

Implementation:

- [ ] Define one `ChatAgentPortV1` for start, stream, answer-HITL, queue, edit,
      delete, steer, stop, resume, history, and artifact/source access.
- [ ] Keep `--thinking quick|auto|deep` in CLI and expose only user-meaningful
      deadline overrides, not workflow internals.
- [ ] Make Chat with `auto` the clear extension default; keep Deep Research as a
      separate explicit selector.
- [ ] Route the extension Chat worker to the Chat root and Research worker/resume
      paths to the Research root.
- [ ] Render conversation history, context chips, strategy/activity, sources,
      queue, steering, stop, HITL, and streamed Markdown through the same event and
      control contracts.
- [ ] Implement the ordinary-browser adapter against the same ports; do not create
      a browser-only agent or capability policy.
- [ ] Keep BYOK/provider configuration outside the composer and independent from
      Chat quality mode.

Automated proof:

- [ ] Contract tests run the same deterministic Quick, Auto-direct, Auto-agentic,
      Deep-direct, Deep-agentic, HITL, follow-up, steering, and stop scenarios
      through every adapter.
- [ ] CLI owns the fast complete workflow/recovery matrix; packed MV3 owns worker
      recreation, IndexedDB, active browser session, streaming, and representative
      control recovery; ordinary browser owns port/presenter parity plus targeted
      E2E.
- [ ] Presenter input cannot alter scope, durable state, strategy, evidence,
      budgets, or completion authority.

Live acceptance:

- [ ] The same read-only question and context produce equivalent source choice,
      strategy, supported claims, citations, and gaps in CLI and MV3.
- [ ] Switching to Deep Research visibly changes product mode and creates a report;
      changing Chat quality never does so.

Acceptance criteria:

- [ ] Chat semantics, controls, and evidence boundaries are shape-neutral.

### C11 — Establish release-blocking Chat quality gates and remove the legacy path

Goal: ship only after ordinary Chat is materially better than the legacy path and
the mode promises are empirically true.

Implementation:

- [ ] Expand the committed synthetic gold set to roughly twenty hand-labelled
      scenarios spanning routing, exact context, long documents, discovery,
      relationships, contradiction, clarification, repair, multi-turn reuse,
      steering, deadline, and injection.
- [ ] Score answer correctness, supported-claim recall, citation precision,
      wrong-source rate, source/candidate recall, detail coverage, relationship
      recall, contradiction handling, false completeness, latency, tokens, cost,
      model/PTC/HTTP calls, and peak supervisor context.
- [ ] Compare `legacy-chat`, Quick, Auto, Deep, and explicit Deep Research on the
      same eligible questions and budget disclosures.
- [ ] Calibrate any model judge against hand-labelled anchors and keep it
      diagnostic until human agreement/error thresholds are reviewed and
      accepted.
- [ ] Add privacy-safe optional answer feedback without committing tenant-derived
      text.
- [ ] Remove the old Chat branch from `runResearchAgent`, its legacy research
      prompt, compatibility-only UI routing, and obsolete tests only after all
      migration and release gates pass.
- [ ] Update user, architecture, provider, security, troubleshooting, and
      operations documentation in the same delivery commit.

Automated proof:

- [ ] Exact-context gold cases have zero wrong sources and canonical citations.
- [ ] Auto chooses the cheaper direct path for simple cases and an agentic path
      for complex cases at the accepted routing threshold.
- [ ] Deep materially improves the accepted complex-question quality score over
      Quick without regressing simple exact-context correctness.
- [ ] No Chat mode inherits the Deep Research brief, report finalizer, systematic
      coverage contract, or ten-minute default.
- [ ] Restart, steering, HITL, evidence reuse, and prompt-injection gates pass in
      the release-blocking suite.
- [ ] Full tests, typecheck, production builds, API/closure reports, output/CSP
      audit, and tracked-tree privacy scan pass after legacy deletion.

Live acceptance:

- [ ] Operator-reviewed private CLI and MV3 evaluation compares all modes on
      realistic read-only questions; all artifacts remain outside Git.
- [ ] The review explicitly accepts answer usefulness, citations, source choice,
      follow-up coherence, visible activity, latency, and cost trade-offs.
- [ ] A user can complete a multi-turn Chat session without seeing Research
      terminology or receiving a report-shaped answer unless Deep Research was
      explicitly selected.

Acceptance criteria:

- [ ] The legacy Chat-through-Research path is deleted, not retained as a hidden
      fallback.
- [ ] Quick, Auto, Deep, and Deep Research have empirically distinct and truthful
      behavior.

## 7. Delivery stages and commit boundaries

### Stage A — Correct direct Chat

Tasks: C0-C3.

Exit gate:

- [ ] Exact page and exact issue answers are correct, natural, canonically cited,
      and use no unnecessary search.
- [ ] Long-page questions can fetch relevant sections instead of failing solely
      on one truncated projection.
- [ ] CLI and MV3 production paths pass the same direct-answer acceptance.

Commit boundaries:

1. `test(chat): establish legacy quality baseline`
2. `refactor(chat): separate chat and research roots`
3. `feat(chat): read exact context directly`
4. `feat(chat): navigate long confluence content`

### Stage B — Real agentic Chat quality

Tasks: C4-C7.

Exit gate:

- [ ] Quick, Auto, and Deep execute different host-validated policies.
- [ ] Complex Auto/Deep questions use dynamic context-isolated children when
      useful, plus bounded independent quality validation.
- [ ] Retrieval accounts for candidates and repairs material evidence gaps.
- [ ] Deep improves complex-answer quality without degrading simple answers.

Commit boundaries:

5. `feat(chat): implement provider-neutral chat strategies`
6. `feat(chat): compose dynamic specialist workflows`
7. `feat(chat): add accountable retrieval planning`
8. `feat(chat): validate and repair chat answers`

### Stage C — Durable multi-turn product parity

Tasks: C8-C11.

Exit gate:

- [ ] Evidence-aware follow-ups, HITL, queue, steering, stop, streaming, restart,
      and conversation history work through shared ports.
- [ ] CLI, MV3, and ordinary browser preserve the same product semantics.
- [ ] Release-blocking quality and privacy gates pass and the legacy path is gone.

Commit boundaries:

9. `feat(chat): persist conversation and evidence memory`
10. `feat(chat): add durable interactive controls and streaming`
11. `feat(chat): align cli and browser chat shapes`
12. `feat(chat): enforce quality gates and remove legacy routing`

## 8. Decisions deliberately deferred to measurement

The following are not permission to leave behavior ambiguous. They require a
documented experiment before their production defaults are frozen:

- Auto and Deep soft/hard conversational deadlines.
- Mandatory synthesis reserve derived from observed synthesis P95 plus margin.
- Provider/model routing by role versus one-model fallback.
- Prompt-cache TTL and measured benefit.
- Maximum dynamic concurrency within host/device limits.
- Whether exact token-chunk replay after MV3 interruption is worth production
  complexity beyond durable checkpoint continuation.
- Whether a cheap pre-supervisor Auto classifier materially reduces latency
  without harming routing or scope quality.

Until measurement is accepted, correctness uses safe explicit limits, one-model
fallback, per-turn root construction, and honest resumable interruption.

## 9. Definition of success

This recovery is complete only when all of the following are true:

- [ ] Ordinary Chat never runs through the Research brief/report pipeline.
- [ ] One attached entity is read directly and cannot be replaced by a ranked
      unrelated candidate.
- [ ] Chat Markdown answers the actual question before presenting material gaps.
- [ ] Quick, Auto, and Deep change workflow semantics independently of provider
      reasoning controls.
- [ ] Auto and Deep use one central Chat supervisor and dynamically selected
      depth-one specialists only when they improve the task.
- [ ] Retrieval is question-directed, candidate-accountable, and capable of
      targeted repair.
- [ ] Agentic paths have an independent quality boundary and one coherent final
      synthesizer.
- [ ] Multi-turn Chat preserves conversation state and safely reusable evidence
      without replaying all historic source bodies.
- [ ] HITL, queue, steering, stop, streaming, and restart use shared shape-neutral
      contracts.
- [ ] CLI, extension, and ordinary browser pass the accepted quality and control
      gates.
- [ ] Deep Research remains a separate explicit agent and product mode.
- [ ] Private live data and artifacts never enter Git or public collaboration
      surfaces.

Implementation begins with C0 and proceeds in order. No later infrastructure
task may be used to declare Chat quality complete before the Stage A direct-answer
proof is accepted.
