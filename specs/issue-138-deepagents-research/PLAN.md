# Issue 138 — Read-only DeepAgentsJS research report

## Status

T0–T4 implemented on 2026-07-30 for
[issue #138](https://github.com/BjoernSchotte/atlcli/issues/138). T5 is a
documented NO-GO for this spike because no curated AGG operation with a measured
advantage over REST was identified. See [EVIDENCE.md](./EVIDENCE.md).

The spike proves one bounded workflow in the packed MV3 extension:

1. accept a session-only Anthropic key;
2. accept one research question containing explicitly labelled Jira project
   and Confluence space keys;
3. let DeepAgentsJS use `@langchain/quickjs` PTC to paginate four read-only
   capabilities;
4. join exact Jira/Confluence references;
5. return a validated structured report and deterministic Markdown projection.

REST is the required baseline. AGG is an optional A/B provider behind the same
wiki capabilities and cannot block the core result.

## Architecture

```text
Portable Research screen
        |
        | ResearchPort
        v
Chrome host / offscreen document
        |
        +-- session-only Anthropic credential
        +-- ChatAnthropic -> DeepAgentsJS
        +-- dedicated QuickJS worker
                         |
                         | exact PTC allowlist
                         v
                  Capability broker
                    |            |
                  Jira REST    Wiki provider
                               REST | AGG
```

The key and Atlassian session never enter QuickJS. The guest receives no raw
HTTP, JQL, CQL, GraphQL, Chrome, filesystem, shell, or write capability.

## Proof sequence

### T0 — contracts and deterministic fixtures

- Version request, scope, limits, capability results, report, diagnostics, and
  error shapes.
- Issue run-bound opaque cursors without exposing provider URLs/tokens.
- Render Markdown only from the validated report.
- Cover exact joins, hypotheses, unsafe links, prompt-injection text,
  pagination, truncation, and scope escapes with deterministic fixtures.

### T1 — bounded REST capabilities

- Bind every call to the active approved Atlassian origin.
- Compose escaped, scope-clamped JQL/CQL from high-level search text.
- Project only fields required by the report.
- Prove pagination, abort, retry classification, session expiry, and byte/item
  limits independently of the agent.

### T2 — DeepAgentsJS and QuickJS PTC

- Pin `deepagents`, `@langchain/quickjs`, `@langchain/anthropic`, and the model.
- Inject a configured `ChatAnthropic` into `createDeepAgent`.
- Enable exactly `jira.issue.search`, `jira.issue.get`, `wiki.search`, and
  `wiki.page.get`.
- Run in a dedicated worker owned by the offscreen document.
- Prove tool loops, bounded parallel calls, cancellation, clean recreation, and
  structured report output with fake and live model ports.

### T3 — portable Labs/Research UI

- Add the capability-gated screen through the registry.
- Store the masked key in memory or `chrome.storage.session`, never app settings
  or durable stores.
- Provide one question field that parses labelled Jira project and Confluence
  space keys, confirms the resulting scope before the run, and rejects missing
  or ambiguous keys.
- Provide disclosure, progress, cancel, safe formatted Markdown, raw Markdown,
  copy, download, diagnostics, and forget-key.
- Keep all host/runtime imports behind `ResearchPort`.

### T4 — packed MV3 and live gates

- Production build and output scan.
- Packed Playwright run with fake model/Atlassian ports and no secret.
- Real session read E2E with the user's key, no Atlassian writes, and sanitized
  evidence.
- Record bundle, worker, memory, calls, latency, token usage, and completeness.

### T5 — optional AGG A/B

- Admit one frozen query operation only after naming its REST-call or field
  advantage.
- Keep provider selection outside QuickJS.
- Compare normalized coverage, calls, bytes, latency, pagination, partial
  errors, 429/Retry-After, session expiry, and abort.
- Record GO/NO-GO. A NO-GO leaves the REST path intact.

## Commit and push boundaries

Each green task above is a logical commit. After its focused tests and relevant
repository gates pass, push it to the Draft PR before starting the next task.

## Non-goals

- Atlassian writes, attachments, comments, user search, or unrestricted query
  languages;
- chat history, long-term memory, subagents, skills, filesystem tools, or
  `quickjs-wasi` snapshots;
- DOCX/PDF wiring;
- Forge execution;
- persistent secret management;
- Chrome Web Store publication;
- a generic GraphQL capability.

## Unresolved questions

- Resolved: the spike pins `claude-sonnet-4-6`; there is no model picker.
- Resolved for the spike: AGG remains out because there is no named,
  measured REST-call or field advantage. Revisit only with a frozen operation
  and the T5 A/B gates.
- Is interpreted model-generated code acceptable for a future Web Store build?
  This needs a separate policy decision after the technical spike.

## Accepted Agentic Chat follow-on invariants

The reviewed follow-on implementation is defined in
[`AGENTIC-CHAT-QUALITY-PLAN.md`](./AGENTIC-CHAT-QUALITY-PLAN.md). This section
records its accepted boundaries without duplicating its task list:

- Quick Chat is direct; Auto Chat may select a direct or agentic path; Deep Chat
  makes an explicit strategy decision and may use dynamic subagents when they
  improve quality. Deep Research remains a separate coverage-oriented report
  mode.
- One logical root owns each turn. One repository-owned middleware with the
  exact pinned merge key `subAgentMiddleware` owns dynamic child dispatch.
- QuickJS `task()` authorization, journaling, budget, HITL, cancellation, and
  result bounds live in the host dispatcher because the bridge bypasses normal
  ToolNode wrappers.
- Graph construction remains per-turn until immutable compiled-root reuse proves
  cross-run isolation and a material measured latency benefit.
- Checkpoint/journal state is authoritative on resume. Client state may provide
  validated per-turn context but cannot overwrite durable authorization or
  workflow state.
- Auto/Deep Chat deadlines are intentionally unresolved. T8 measures phase-level
  warm/cold latency and selects defaults plus `mustSynthesizeAt`; 120/180 seconds
  remain hypotheses rather than current product defaults.
