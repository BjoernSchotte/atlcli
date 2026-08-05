# Confluence REST/AGG Adapter A/B Plan

Status: **Deferred experiment; REST remains the only accepted production
provider until every GO gate passes**

## Contents

- [1. Decision to make](#1-decision-to-make)
- [2. Recommended implementation window](#2-recommended-implementation-window)
- [3. Fixed safety and product contract](#3-fixed-safety-and-product-contract)
- [4. Experiment architecture](#4-experiment-architecture)
- [5. Candidate slices](#5-candidate-slices)
- [6. Metrics and GO/NO-GO rule](#6-metrics-and-gono-go-rule)
- [7. Implementation tasks](#7-implementation-tasks)
- [8. Delivery and rollback](#8-delivery-and-rollback)
- [9. Definition of done](#9-definition-of-done)

## 1. Decision to make

Kiteweave already has a bounded REST provider for read-only Confluence
retrieval. Atlassian's GraphQL Gateway (AGG) may expose a richer structured page
projection or reduce the number of calls needed for page and space resolution.
Neither possibility is assumed.

This experiment answers two narrow questions:

1. Does one curated `page-by-id` AGG operation provide materially better
   structured evidence, fewer calls, or lower latency than the REST baseline?
2. Do curated space-list/space-key operations improve natural-language space
   resolution without weakening pagination, authorization, or error handling?

AGG is accepted only behind the existing neutral host capabilities. It is not a
new model tool, a generic GraphQL client, or a replacement for the long-document
outline/section model. A `NO-GO` is a successful experiment outcome and leaves
the REST path unchanged.

## 2. Recommended implementation window

Implement this experiment **after Chat Recovery C3A and C6 are proven, and
before C7 quality calibration or C10 host-parity hardening**.

Rationale:

- C3A first freezes the normalized document, structure, version, and coverage
  contracts that both providers must satisfy.
- C6 first freezes retrieval planning, space resolution, candidate accounting,
  and the metrics needed for a fair comparison.
- Running the experiment before C3A/C6 would let AGG-specific response shapes
  distort the product contract and make the comparison unmeasurable.
- Running it after C7/C10 would repeat quality calibration and host E2Es if AGG
  is accepted.
- C4 and C5 do not depend on AGG and must not be delayed by this experiment.

The recommended sequence is therefore:

```text
C3A -> C4 -> C5 -> C6 -> REST/AGG A/B -> C7 -> C8 ... C11
```

## 3. Fixed safety and product contract

The following rules are invariant regardless of the experiment result:

- [ ] REST is the control provider and remains the fallback for every admitted
      capability.
- [ ] QuickJS and every model see the same neutral read-only capabilities and
      normalized outputs for REST and AGG.
- [ ] QuickJS receives neither `fetch`, raw GraphQL, query text, provider URLs,
      cookies, authorization headers, tenant origins, cursors, nor schema access.
- [ ] The host binds tenant, session/authentication, operation, variables,
      authorization, scope, pagination, cost, depth, bytes, calls, timeout,
      cancellation, and retry policy.
- [ ] AGG mutations, subscriptions, introspection, arbitrary operation names,
      arbitrary fields, fragments, directives, aliases, and caller-supplied query
      text are rejected before network I/O.
- [ ] Each admitted AGG operation is frozen in a host-owned manifest with a
      versioned operation ID, exact query hash, typed variable decoder, result
      decoder, cost ceiling, maximum depth, and normalized-output mapper.
- [ ] Partial GraphQL data is never silently treated as complete. Every error and
      missing field is classified into the same typed coverage/error boundary
      used by REST.
- [ ] Page identity, version, space identity, representation, canonical URL, and
      capture time are verified by the host and cannot be authored by the model.
- [ ] No Confluence or Jira write operation is introduced.
- [ ] Committed tests and plans contain only synthetic neutral tenants and
      content. Private live inputs, payloads, reports, and traces remain outside
      Git and public collaboration surfaces.

## 4. Experiment architecture

```text
Chat or Research supervisor
          |
          | neutral capability and opaque refs
          v
Host capability broker
          |
          | ConfluenceReadPortV1
          v
Provider experiment boundary
       /                 \
REST control          AGG candidate
       \                 /
        normalized source, document,
        pagination, coverage, and errors
                    |
                    v
        evidence and candidate ledgers
```

### 4.1 Neutral provider boundary

The experiment must introduce or reuse one internal provider port whose outputs
contain no REST- or GraphQL-specific envelope:

```ts
interface ConfluenceReadPortV1 {
  getPageById(input: VerifiedPageReadInputV1): Promise<NormalizedPageV1>;
  listSpaces(input: VerifiedSpacePageInputV1): Promise<NormalizedSpacePageV1>;
  validateSpaceKey(input: VerifiedSpaceKeyInputV1): Promise<NormalizedSpaceV1 | null>;
}
```

The broker remains responsible for opaque refs, source admission, evidence
retention, candidate state, budgets, and canonical capability outputs. Provider
selection is a host configuration or experiment assignment, never a model
argument.

### 4.2 Frozen AGG operation registry

Each operation manifest records at least:

- stable internal `operationId` and schema version;
- exact GraphQL document and SHA-256 hash;
- allowed variable names, scalar/list types, lengths, and value constraints;
- maximum depth, aliases, requested fields, and expected cost;
- normalized success decoder and partial-error decoder;
- cursor extraction and loop detection;
- per-operation call, byte, timeout, and retry ceilings;
- expected authentication transport for CLI, packed MV3, and ordinary browser;
- test vectors proving unknown variables and response shapes fail closed.

The model-facing tool calls an existing high-level capability such as bound page
read or space resolution. It never selects an AGG operation ID.

### 4.3 Browser authentication boundary

The packed MV3 candidate uses the authenticated tenant endpoint
`https://<site>.atlassian.net/gateway/api/graphql` through the extension's
existing host permission and browser session. The experiment must prove this
behavior; successful REST authentication is not evidence that AGG works.

CLI support is accepted only if its configured authentication mechanism can use
the operation through a documented and testable contract. If AGG remains
browser-session-only, provider parity fails and REST remains the shared default.

## 5. Candidate slices

### 5.1 Candidate A — bound page by ID

Compare the existing REST page read with one frozen AGG page operation. Normalize
and compare:

- content ID, title, space ID/key, status, version number, and modification time;
- canonical link inputs;
- Storage and/or ADF body availability and exact representation identity;
- headings, tables, Expand macros, Jira macros, Smart Links, Include/Excerpt
  structures, ancestors, and other fields required by C3A;
- response bytes, HTTP calls, latency, partial fields, and coverage state.

Ancestors, labels, properties, comments, likes, permissions, and operations are
not automatically admitted. A field is useful only if a committed gold case or
measured retrieval need consumes it.

### 5.2 Candidate B — space resolution

Compare REST catalog behavior with frozen AGG space listing and key validation:

- exact key validation;
- paginated listing without hidden result caps;
- display-name and alias resolution performed by the host over normalized rows;
- archived/inaccessible/personal/global space distinctions;
- duplicate names and durable HITL ambiguity;
- cursor termination, saturation, and loop detection.

Search-by-name must not be claimed if the admitted AGG operation only lists
spaces. The host resolver owns matching and ambiguity policy.

### 5.3 Explicitly deferred content

Whiteboards, databases, folders, embeds, tasks, comments, attachments, labels,
properties, likes, classifications, templates, site settings, admin utilities,
and long-task operations require separate product questions and capability
slices. Their existence in an API catalog is not sufficient reason to expose or
retrieve them.

## 6. Metrics and GO/NO-GO rule

Every A/B case uses the same tenant authorization, source identity, question,
normalized limits, capture window, expected output, and evaluation rubric.

Record at least:

- normalized field and structure completeness;
- source/version/canonical-URL correctness;
- detail-read and candidate coverage;
- false-empty, false-negative, wrong-source, and unsupported-claim rates;
- HTTP and provider call count;
- request/response and retained-evidence bytes;
- p50/p95 time to normalized evidence and final answer;
- retries, 401/403, 404, 429/`Retry-After`, timeout, abort, cursor-loop, partial
  error, malformed-response, and worker-restart outcomes;
- model/PTC calls and tokens, which should remain equivalent because the neutral
  model capability contract does not change.

### GO rule

AGG may be accepted for one specific capability only if all safety, semantic,
privacy, error, cancellation, and host-parity gates pass and it demonstrates at
least one predeclared material advantage:

- at least one fewer HTTP round trip on the exercised common path; or
- at least 20% lower measured p50 evidence latency with no p95 regression above
  10%; or
- a required structured field or representation that materially improves a
  committed gold-case answer and cannot be obtained from the REST baseline at a
  comparable cost.

The benefit must survive repeated CLI/MV3 measurements where that host supports
the provider. Cosmetic field richness, a larger response, or one warm-cache run
is not an advantage.

### NO-GO rule

Keep REST when no material advantage is proven, any required host cannot use the
authentication contract, normalized semantics diverge, partial errors are
ambiguous, or operational/security cost outweighs the measured benefit. Record
the measurements and remove the dormant production branch rather than shipping
an unselected second provider indefinitely.

## 7. Implementation tasks

### A0 — Freeze the REST control

- [ ] Record the exact REST endpoints, fields, body representation, page/space
      normalization, pagination, retries, and limits used by the active broker.
- [ ] Add neutral gold fixtures for page identity, long structured content,
      personal/archived/ambiguous spaces, later pagination, and error classes.
- [ ] Capture body-free REST observations for calls, bytes, latency, coverage,
      and normalized output.
- [ ] Prove Chat C2, C3, C3A, and C6 behavior remains green before AGG code is
      linked into a production bundle.

Acceptance: the control is reproducible and the A/B cannot change its corpus,
scope, limits, or evaluator.

### A1 — Freeze the neutral Confluence provider port

- [ ] Extract provider-specific envelopes behind `ConfluenceReadPortV1` without
      changing broker capability schemas or Chat/Research prompts.
- [ ] Define normalized page, space, cursor, structure, version, coverage, and
      error contracts with strict decoders.
- [ ] Run the same contract suite against the REST adapter and a deterministic
      candidate adapter.
- [ ] Add import-boundary tests proving models, QuickJS, presenters, and shared
      agent roots cannot import REST or AGG clients.

Acceptance: replacing the adapter cannot alter authorization, scope, tool names,
evidence identity, or user-visible semantics.

### A2 — Add the frozen AGG transport and operation registry

- [ ] Add a host-only AGG transport for the tenant gateway endpoint with session,
      timeout, abort, byte, redirect, content-type, and retry enforcement.
- [ ] Register only the reviewed page operation and space operations with pinned
      hashes and strict variable/result decoders.
- [ ] Reject mutation/subscription/introspection documents, unknown operations,
      variables, fields, cursors, tenants, and content types before or at the
      narrowest possible trust boundary.
- [ ] Keep query documents, raw errors, cookies, authorization, and tenant URLs
      out of model messages, QuickJS results, durable activity, and UI events.

Acceptance: the candidate can execute only the frozen read operations and leak
neither transport nor authentication details.

### A3 — Prove page-read semantic parity

- [ ] Map the frozen AGG page result into the same normalized page and C3A
      document snapshot as REST.
- [ ] Compare identity, version, representation, canonical URL inputs, body,
      structures, support spans, and typed gaps on every gold fixture.
- [ ] Prove an AGG section read still uses the retained snapshot and performs no
      second search or page-detail call.
- [ ] Prove stale version, partial body, missing space, foreign tenant, malformed
      macro, oversized body, and unknown response shapes fail closed.

Acceptance: AGG never changes which page was read or overstates document
coverage; any additional field has a demonstrated consumer.

### A4 — Prove space-resolution semantic parity

- [ ] Map space listing and exact-key validation into the same scope-catalog and
      resolver contracts as REST.
- [ ] Prove complete pagination, duplicate display names, aliases, personal and
      archived spaces, inaccessible rows, foreign tenants, and cursor loops.
- [ ] Prove exact keys resolve without model search and ambiguous natural names
      produce the same durable HITL checkpoint in every provider.
- [ ] Confirm no provider can widen the accepted scope or bypass catalog policy.

Acceptance: the same user input yields the same accepted scope or the same typed
clarification across REST and AGG.

### A5 — Prove failure, cancellation, and lifecycle behavior

- [ ] Classify GraphQL top-level errors, partial data plus errors, HTTP errors,
      malformed JSON, schema drift, empty data, and truncated responses.
- [ ] Prove 401/403, 404, 429/`Retry-After`, timeout, abort, redirect, cursor-loop,
      packed-MV3 worker restart, and stop propagation.
- [ ] Prove an uncertain post-call outcome is not blindly retried and cannot
      publish incomplete evidence as complete.
- [ ] Prove body-free durable events and diagnostics are provider-neutral.

Acceptance: AGG failure semantics are at least as explicit and recoverable as
the REST control.

### A6 — Run synthetic and live A/B measurements

- [ ] Run deterministic contract/evaluation cases repeatedly with cold and warm
      caches and record normalized measurements.
- [ ] Run packed MV3 page and space cases through the production bundle and
      authenticated browser session.
- [ ] Run CLI cases only if a documented supported authentication route exists;
      otherwise record the parity failure rather than emulating browser cookies.
- [ ] Run approved private read-only page and space cases, retaining payloads,
      answers, and traces only in the external artifact root.
- [ ] Have a human review answer usefulness, structure preservation, source
      correctness, gaps, latency, and failure messaging without publishing
      private inputs or outputs.

Acceptance: the comparison report contains enough evidence to apply the frozen
GO/NO-GO rule without relying on anecdotal impressions.

### A7 — Decide and integrate or remove

- [ ] Publish a privacy-safe decision record with per-capability GO/NO-GO,
      measurements, limitations, and the exact accepted operation versions.
- [ ] For GO, add provider selection outside QuickJS, REST fallback policy,
      telemetry, upgrade/schema-drift gate, CLI/MV3/ordinary-browser contracts,
      and operator documentation.
- [ ] For NO-GO, remove candidate production wiring and dependencies while
      retaining only the decision record and deterministic experiment fixtures.
- [ ] Re-run Chat and Deep Research regression, privacy, typecheck, production
      build, CSP/output, packed MV3, cancellation, and host-parity gates.

Acceptance: production contains either one proven narrowly selected AGG adapter
or no AGG runtime path; it never contains an unmeasured generic GraphQL escape.

## 8. Delivery and rollback

Use one commit and Draft-PR push after each proven task:

1. `test(confluence): freeze rest provider baseline`
2. `refactor(confluence): add neutral read provider port`
3. `feat(confluence): add curated agg read transport`
4. `test(confluence): compare agg page semantics`
5. `test(confluence): compare agg space resolution`
6. `test(confluence): prove agg lifecycle failures`
7. `test(confluence): measure rest and agg providers`
8. `docs(confluence): record agg adapter decision`

REST remains the rollback path for an accepted capability. Rollback must not
change capability schemas, evidence IDs, persisted Chat state, or user-facing
scope semantics.

## 9. Definition of done

- [ ] The A/B uses frozen operations and identical normalized contracts, corpus,
      scope, limits, and evaluators.
- [ ] No model, QuickJS sandbox, presenter, or persisted event can access raw
      GraphQL, authentication, tenant URLs, or provider cursors.
- [ ] Page and space identity, structured content, pagination, partial errors,
      cancellation, retries, and MV3 lifecycle are directly proven.
- [ ] CLI, MV3, and ordinary-browser support or explicit unsupported-host status
      are truthful and documented.
- [ ] Private live material remains outside Git and public collaboration.
- [ ] The frozen GO/NO-GO rule is applied per capability.
- [ ] REST remains intact unless a narrowly curated AGG operation proves a
      measurable advantage without a quality, security, or lifecycle regression.
