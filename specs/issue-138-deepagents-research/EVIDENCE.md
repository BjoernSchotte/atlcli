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
evidence boundary independently. The initial report is superseded.

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
