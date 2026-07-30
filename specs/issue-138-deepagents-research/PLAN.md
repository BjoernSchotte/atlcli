# Issue 138 — Read-only DeepAgentsJS research report

## Status

Implementation plan for [issue #138](https://github.com/BjoernSchotte/atlcli/issues/138).

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

- Which exact Claude model/version gives the best packed-browser PTC result?
  Select and pin it during T2 from current provider support; do not add a model
  picker to the spike.
- Does a curated AGG Confluence operation materially beat REST? T5 answers this;
  the question is intentionally non-blocking for T0–T4.
- Is interpreted model-generated code acceptable for a future Web Store build?
  This needs a separate policy decision after the technical spike.
