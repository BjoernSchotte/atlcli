# Issue 138 — implementation evidence

Verified on 2026-07-30. This file deliberately contains no real tenant URL,
profile credential, project/space key, issue/page identifier, title, excerpt,
or generated private report.

## Outcome

T0–T4 are implemented:

- the portable sidebar accepts one bounded question and a session-only
  Anthropic key;
- `ChatAnthropic` with `claude-sonnet-4-6` is injected into a DeepAgentsJS
  agent;
- `@langchain/quickjs` PTC receives exactly Jira search/detail and Confluence
  search/detail;
- the host owns origin, authentication, JQL/CQL, cursors, entity references,
  budgets, retries, projection, evidence validation, and final Markdown;
- every run gets a fresh dedicated worker, and completion, cancellation, and
  failure terminate it;
- the UI renders the validated report without interpreting model-authored
  Markdown and also supports raw Markdown, copy, download, diagnostics, and
  key removal.

REST is the only production provider in this spike. AGG is a NO-GO until a
frozen operation demonstrates a measurable call-count or field-coverage
advantage. No generic GraphQL capability is shipped.

## Host-specific proof

| Host | Data/model | What it proves |
| --- | --- | --- |
| Packed MV3 Chromium | Synthetic Atlassian and Anthropic responses; real production bundles | Sidebar → background → offscreen → fresh worker, DeepAgentsJS/QuickJS PTC, WASM loading, pagination, details, safe report rendering, session-key reload, cancellation, worker recreation, and cleanup |
| Node live runner | Real user-approved Atlassian profile and Anthropic model; same request, broker, providers, budgets, QuickJS, and agent runtime | Jira and Confluence return scoped read results and readable detail content without any Atlassian write |

The Node runner has an explicit test-only profile-auth switch. The packed
extension leaves that switch disabled and binds reads to the active browser
session and Atlassian origin. A real Node run does not substitute for the
packed-browser lifecycle proof; the two gates cover different host contracts.

## Corrected Confluence finding

The initial live report incorrectly described two Confluence details as
unavailable. Search and detail HTTP reads had succeeded; the local Storage
projection rejected the oversized bodies, and the acquisition code classified
that local error too broadly. The corrected projector emits a bounded,
UTF-8-safe excerpt with `truncated: true`. A repeat live run read both details
and found no explicit Jira reference in the bounded evidence. Negative
content findings that cite truncated detail are now constrained twice: the
agent prompt requires excerpt-scoped wording, and the host appends the same
evidence boundary independently. The host also prefixes the executive summary
with exact Jira/Confluence detail coverage, truncation count, and incomplete
search status whenever the evidence is partial. The initial report is
superseded.

## Scope catalog characterization

Verified on 2026-07-31 with customer-free fixtures and an approved local
authenticated profile. The live harness emitted counts, booleans, and latency
only; it did not emit a tenant URL, profile credential, project/space key,
name, entity ID, provider cursor, or content.

The normalized providers are Jira `GET /rest/api/3/project/search` and
Confluence v2 `GET /wiki/api/v2/spaces`. Atlassian documents that the Jira
endpoint is paginated/searchable and returns only projects for which the caller
has Browse Projects, Administer Projects, or Administer Jira permission:
<https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-projects/>.
The Confluence v2 endpoint is cursor-paginated, sorted by ID ascending, supports
status filtering, and returns only viewable spaces:
<https://developer.atlassian.com/cloud/confluence/rest/v2/api-group-space/>.

Sanitized live observations:

- Jira drained 142 visible projects in 3 pages in 4,284 ms; the repeated first
  page was stable, the exact query returned one verified result in 200 ms, and
  pre-abort stopped before a request.
- Confluence v1 returned one bounded 250-item page in 1,145 ms. It did not
  expose a continuation contract and therefore was not a complete catalog.
- Confluence v2 drained 242 current spaces in 5 pages (1,181 ms) and 66
  archived spaces in 2 pages (576 ms). Both phases completed, the repeated
  first page was stable, exact-key verification succeeded, and pre-abort
  stopped before a request.
- The live space catalog contained 2 duplicate normalized names and advertised
  an active alias for 308 entries. This confirms that names and aliases cannot
  be assumed unique; only an exact unique key/reference or a unique match from
  a complete bounded catalog may auto-resolve.
- The bounded v1 page and complete v2 current catalog overlapped on 194 keys;
  56 appeared only in the v1 page and 48 only in the v2 current set. The
  difference is consistent with v1 truncation and differing status/default
  behavior, so v1 is rejected for normalized discovery.

The optional `space.title` CQL accelerator is a NO-GO. Atlassian's current CQL
field reference documents `space` as a content-search field addressable by
space key and has no `space.title` field:
<https://developer.atlassian.com/cloud/confluence/cql-fields/>. Content search
therefore cannot stand in for a permission-filtered space catalog. Exact links
are verified through a tenant-bound project/space read; foreign, inaccessible,
404, archived-without-opt-in, and trashed candidates remain unselectable.

Fixture coverage proves opaque cursors, bounded pages, deterministic page
ordering, duplicate names and aliases, archived/trashed filtering, exact
normalized names, exact aliases, weak fuzzy ambiguity, current-context versus
explicit-scope precedence, multiple equal-precedence explicit scopes, exact
tenant links, foreign links, cancellation, rate-limit classification, sanitized
errors, and prompt-like catalog metadata treated only as inert data.

## Production response-schema feasibility

The T0 fixtures freeze the intended child-to-supervisor bodies without
exporting premature graph/task domain contracts. Every applicable role was
admitted through the pinned QuickJS native `task({ responseSchema })` path in
both Bun and the packed MV3 worker.

| Schema | Serialized bytes | Properties | Depth | Admitted roles |
| --- | ---: | ---: | ---: | --- |
| `ResearchPacketBodyV1` | 2,140 | 23 | 4 | focused researcher, document distiller, contradiction verifier, coverage moderator |
| `ResearchPacketBodyV2` | 2,806 | 31 | 4 | outline planner |
| `ReconciliationBodyV1` | 1,638 | 16 | 5 | reconciler |

All stay within the pinned runtime limits of 4,096 serialized bytes, 32
properties, and depth 5. V2 has one property of headroom and reconciliation
has no depth headroom. T3 must reproduce these serialized fixtures byte-for-byte
before replacing them with authoritative typed contracts; adding nested fields
requires an explicit schema redesign and repeat of both host gates.

## Deterministic cross-host model output and evaluation

The fake supervisor emits one versioned, customer-free 779-byte QuickJS
program. It launches the admitted Jira and Confluence research nodes in one
parallel `Promise.all` wave using the dynamic response schema. The Bun test and
packed MV3 worker import the same fixture module and execute it through the
same central `createDeepAgent` and native declarative `task()` path; there is
no browser-only surrogate workflow.

The host-neutral evaluation scorer freezes the following metrics and formulas:

- relevant-source retrieval recall and detailed-source coverage;
- citation precision against claim-specific support sets, unsupported-claim
  count, supported-claim recall, and verified-relationship precision;
- abstention correctness, explicit completeness-criterion coverage, branch
  coverage, duplicate task fingerprints, and prompt-injection success;
- scope-resolution precision/recall, false auto-resolution count, bounded
  catalog completeness, and unnecessary scope-expansion proposals;
- model/PTC/HTTP calls, model/provider bytes, model tokens, median latency,
  median model cost, and peak active supervisor context.

An empty gold denominator scores as one, avoiding false failures for tasks with
no expected relationships or abstentions. A claim is supported only when it is
present in the gold set and has at least one citation to a source registered for
that exact claim; citing an unrelated but otherwise valid source does not pass.

The T3 S2/S3 decision is executable rather than prose-only. A candidate must
keep citation and verified-relationship precision and abstention correctness
at one; unsupported claims, successful prompt injection, and false automatic
scope resolution at zero; and every other deterministic coverage/scope gate at
least at S1. Duplicate work and unnecessary expansion may not increase. Median
model cost is capped at 2.0 times S1, and at least one of these gains is
required: source coverage or supported-claim recall by 10 percentage points,
peak supervisor context by 25%, or median latency by 20%.

## Packed metrics

Single synthetic acceptance run:

- report: complete, 8 PTC calls / 8 HTTP calls, 2 Jira items /
  2 Confluence items, 40 input tokens / 20 output tokens;
- report duration: 53 ms in the captured deterministic run;
- packed browser test: 1 passed in 2.0 s, including reload and cancellation;
- extension output: 55,196 KiB on disk;
- research worker JavaScript: 1,959,111 bytes;
- selected QuickJS asyncify WASM: 1,075,905 bytes, SHA-256 pinned by the
  artifact gate;
- QuickJS linear-memory limit: 64,000,000 bytes;
- side-panel V8 heap proxy while the agent worker was held after PTC:
  10,343,664 bytes used, 13,664,256 bytes total, 3,627,243 bytes backing
  storage.

Chromium exposes the active MV3 dedicated-worker target with no URL and did not
provide a stable direct worker-heap session in this harness. The side-panel
number is therefore explicitly a host proxy, not a claim about the worker or
QuickJS WASM heap.

## Gates

```text
bun run test <15 focused research/boundary files>
  98 passed, 0 failed

bun run test apps/extension/tests/output-scan.test.ts
  52 passed, 0 failed

bun run test
  5,994 passed, 15 skipped, 0 failed across 423 files

bun run --cwd apps/extension test:research-extension-browser:prebuilt
  1 passed

bun run --cwd apps/extension check:output
  passed

bun run typecheck
  passed
```

The Confluence research subpath is intentionally limited to eight public
type/runtime symbols; its generated API and closure reports are current. The
packed browser harness selects the extension's `background.js` service worker
explicitly, so unrelated Chromium service workers cannot be mistaken for the
extension host.

The output scan still rejects executable Node/Bun globals, remote scripts,
dynamic code, fake Buffer globals, and missing/unpinned runtime assets. Its
only new classification is that exact quoted SDK labels such as
`process.env['ANTHROPIC_LOG']` are inert diagnostic text; an executable
`process.env` read remains a failing fixture.

## Markdown and later export

The validated structured report remains the evidence-bearing source of truth.
Its deterministic Markdown projection is a practical, portable interchange
artifact and can later feed a DOCX/PDF adapter. Keeping that adapter separate
avoids coupling model output directly to either existing export engine and
preserves the current sanitization and evidence checks.

## Remaining product decision

Technical execution in a packed MV3 extension is proven. Chrome Web Store
policy treatment of interpreted model-generated QuickJS code remains a
separate release decision; this spike does not claim publication readiness.
