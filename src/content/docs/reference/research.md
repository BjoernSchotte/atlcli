---
title: "Jira and Confluence Research"
description: "Run bounded, read-only research across Jira and Confluence from the CLI or browser extension."
---

# Jira and Confluence Research

`atlcli chat` answers ordinary scoped questions without a research graph.
`atlcli research` produces one cited Markdown report from read-only Jira and
Confluence evidence. The CLI and browser extension use the same request,
scope-provenance, progress-event, workspace, structured-report, and Markdown
contracts.

## On this page

- [Prerequisites](#prerequisites)
- [Use ordinary chat from the CLI](#use-ordinary-chat-from-the-cli)
- [Run from the CLI](#run-from-the-cli)
- [Run from the browser extension](#run-from-the-browser-extension)
- [Options](#options)
- [Output and session workspace](#output-and-session-workspace)
- [Shared workflow core](#shared-workflow-core)
- [Security boundaries](#security-boundaries)
- [Troubleshooting](#troubleshooting)
- [Related topics](#related-topics)

## Prerequisites

- Configure an Atlassian Cloud profile with access to the selected Jira
  projects and Confluence spaces.
- Set `ANTHROPIC_API_KEY` in the CLI process environment. Do not put it on the
  command line.
- For the extension, open an Atlassian Cloud page and enter the key in the
  global settings screen. The extension stores it only in browser session
  storage.

## Use ordinary chat from the CLI

Use `chat` for a direct answer that does not need planning, dynamic subagents,
reconciliation, or a deep-research report:

```bash
ANTHROPIC_API_KEY=... atlcli chat \
  "Summarize the most important changes in DOCS." \
  --profile work \
  --space DOCS \
  --thinking auto \
  --language en \
  --json
```

The JSON result contains the retained conversation ID. Continue it without
repeating the scope:

```bash
ANTHROPIC_API_KEY=... atlcli chat \
  --profile work \
  --session research-session:... \
  "Which change has the largest operational impact?"
```

Ordinary chat never imports Jira or Confluence defaults from the selected
profile. It uses only explicit `--project`/`--space` values or an exact,
unambiguous project, space, issue, page, or URL named in the question. This
prevents a Confluence-only question from silently creating Jira work. Use
`research` when the task needs broader discovery or a planned multi-source
investigation.

Chat thinking is independent from Deep Research. `--thinking auto` enables
adaptive thinking and lets the model decide how much reasoning the current
turn needs. Use `--thinking quick` for the lowest-latency chat path or
`--thinking deep` for a more thorough direct answer. All three remain ordinary
chat: they create no research graph, subagents, plan review, or reconciliation.
The extension exposes the same **Automatic**, **Quick**, and **Think deeper**
choices inside **Chat**; **Deep Research** remains a separate top-level mode.

## Run from the CLI

Minimal example using project and space defaults from the selected profile:

```bash
ANTHROPIC_API_KEY=... atlcli research \
  "Which Jira work is explicitly linked to our Confluence documentation?"
```

Realistic bounded example:

```bash
ANTHROPIC_API_KEY=... atlcli research \
  "Which work completed this week is documented, and which relationships are only inferred?" \
  --profile work \
  --project PLATFORM --project DELIVERY \
  --space ENGINEERING,DOCS \
  --from 2026-07-24 \
  --to 2026-07-31 \
  --as-of 2026-07-31T12:00:00+02:00 \
  --timezone Europe/Berlin \
  --max-run-minutes 10 \
  --output /absolute/path/report.md
```

Repeated and comma-separated project/space keys preserve input order and enter
the shared request as locked scope seeds. If a product key is omitted, the CLI
uses that product's configured profile default as an approved seed.

## Run from the browser extension

1. Open a Jira or Confluence page and select **Research** in the side panel.
2. Enter the Anthropic key and the research question.
3. Add explicit Jira project and Confluence space keys when needed.
4. Keep or clear **Use detected current context**. Manual keys remain locked
   and are never replaced by the detected context.
5. Confirm the disclosure and select **Run research**.
6. Follow **Live activity** for current phases, subagents, read-only tool calls,
   bounded result counts, stop reasons, durations, and validation decisions.
7. Review the formatted report or raw Markdown, then copy or download it.

## Options

Both commands accept `--profile`, `--project`, `--space`, `--language`,
`--max-run-minutes`, `--max-cost-usd`, `--output`, and `--json`. `chat` also
accepts `--session` for a follow-up turn. Research-only planning, time-window,
scope-expansion, and reconciliation flags are rejected by `chat`.

| Option | Type | Default | Constraints |
|---|---|---|---|
| `--profile` | string | active profile | Existing atlcli profile |
| `--project` | string, repeatable | profile project | Jira keys; comma-separated values accepted |
| `--space` | string, repeatable | profile space | Confluence keys; comma-separated values accepted |
| `--from`, `--to` | date | none | `YYYY-MM-DD`; start must not follow end |
| `--as-of` | date or timestamp | none | Valid date or ISO 8601 timestamp with timezone |
| `--timezone` | string | none | Valid IANA timezone, such as `Europe/Berlin` |
| `--max-run-minutes` | integer | `10` | From 1 through 10 |
| `--output` | path | none | Atomically written Markdown |
| `--json` | boolean | `false` | Structured report on stdout; progress remains on stderr |
| `--keep-session` | boolean | `false` | Retains the temporary CLI workspace |

Durable-session and planning flags are deliberately rejected until their
session-control phases are available.

## Output and session workspace

Normal stdout contains only the canonical Markdown. With `--output`, the file
contains exactly the same bytes. The CLI also copies successful reports into a
timestamped `~/Documents/atlcli/artefacts/` directory.

Detailed activity streams immediately to CLI stderr and the browser's bounded
**Live activity** list. It includes stable task/call IDs, subagent roles,
read-only capability names, start/completion/failure state, item counts,
pagination termination, durations, and host validation decisions. It does not
buffer diagnostics until the report is complete.

Each run writes its host-owned state through a virtual workspace. Retained CLI
research sessions and ordinary chat conversations use the private SQLite-backed
session store under `~/.atlcli/research-sessions/`. A chat follow-up restores
the same DeepAgentsJS checkpointer and approved scope. Browser chat uses the
equivalent IndexedDB-backed workspace so a fresh extension worker can restore
the conversation.

### Shared workflow core

Chat and Deep Research use one host-neutral agentic workflow contract, but
they have different completion objectives. Ordinary Chat completes a
conversation answer. Deep Research completes a cited research report. A
validated graph is compiled into immutable depth-one profiles for acquisition,
analysis, reconciliation, and synthesis; mutable tenant, thread, scope,
provider-cache, steering, cancellation, and credential state remains bound to
the individual run.

Every delegated task passes the same host-owned admission bridge before a
provider call. The bridge validates the registered subagent type and response
schema, then applies authorization, any required human approval, budget
reservation, cancellation, and the durable journal transition. QuickJS may
compose admitted tasks, but it cannot create a role, widen scope, skip a gate,
or act as the durable scheduler. Quick Chat constructs neither delegated
subagent middleware nor this task bridge.

Compiled-root reuse is disabled by default. A host may enable it only after
fresh-versus-reused trajectory tests prove cross-user, thread, scope, cache,
steering, and cancellation isolation and measurements show a material latency
benefit.

## Security boundaries

- Atlassian and Anthropic credentials never enter QuickJS.
- QuickJS has no `fetch`, shell, Node, Chrome, raw JQL/CQL/GraphQL, or write
  capability.
- Explicit scope is host-bound. Lower-precedence context cannot replace a
  manually locked project or space.
- Activity events contain no prompts, source bodies, cursors, credentials, raw
  model responses, provider errors, or hidden chain-of-thought. Structured
  reason codes expose reviewable decisions without persisting private internal
  reasoning.
- Reports cite only fully retrieved, non-empty, non-truncated detail evidence.

## Troubleshooting

### `ANTHROPIC_API_KEY is missing`

Set the variable in the process environment that launches `atlcli`. A CLI flag
for the key is intentionally unsupported.

### `Select at least one Jira project` or Confluence space

Pass the missing key explicitly or configure it as a default on the selected
profile.

### The report says the search is incomplete

The provider or configured item/detail/call budget ended before exhaustive
coverage. Treat negative conclusions as bounded to the retrieved evidence and
refine the question or scope.

### A temporary workspace remains

This is expected with `--keep-session`. The command prints the retained path to
stderr; remove it when it is no longer needed.

## Related topics

- [CLI Commands](cli-commands.md)
- [Authentication](../authentication.md)
- [Configuration](../configuration.md)
- [Environment Variables](environment.md)
- [Troubleshooting](troubleshooting.md)
