# `@atlcli/research`

Shared, read-only Atlassian research runtime for CLI and browser hosts.

Use the package through one of five explicit surfaces:

- `@atlcli/research` contains versioned contracts, validation, budgets,
  capability brokering, query compilation, evidence validation, and canonical
  Markdown rendering. It imports no Node, Bun, DOM, or extension APIs.
- `@atlcli/research/browser` adds the browser-safe REST providers while keeping
  model dependencies out of the import graph.
- `@atlcli/research/browser/agent` constructs DeepAgentsJS through
  `deepagents/browser` with an in-memory `StateBackend` and exposes the
  LangChain/QuickJS tool adapters.
- `@atlcli/research/node` adds the filesystem workspace, the same REST
  provider, and constructs DeepAgentsJS through `deepagents/node`. It remains
  consumable by ordinary Node processes, including the packed-browser E2E.
- `@atlcli/research/bun` adds Bun-only host storage, currently
  `SqliteResearchSessionStoreV1`, on top of the Node runtime. The CLI selects
  this surface explicitly; browser and Node consumers never load `bun:sqlite`.

The package exposes two explicit agent runtimes. `runChatAgent` owns ordinary
multi-turn Chat with Quick/Auto/Deep strategies, durable conversation memory,
HITL, steering, and stop. `runResearchAgent` owns only an approved Research
graph and a cited report; it rejects `mode: "chat"` before constructing a
DeepAgent. The frozen legacy evaluator remains only as a comparison fixture and
is not a production route.

Both runtimes use the same read capabilities, host-owned scope and evidence
contracts, bounded QuickJS execution, and body-free presentation events. Each
host injects a virtual workspace. Capability events contain only safe metadata
such as status, item count, termination, and duration; raw tool results,
prompts, provider errors, and hidden chain-of-thought never enter the stream.
Scope seeds preserve their ordered source (`cli_flag`, `ui_added`,
`current_context`, or default) and authority without allowing lower-precedence
context to replace locked scope. Hosts retain ownership of credentials,
lifecycle, cancellation, and artifact presentation. The extension defaults to
session-only provider credentials and offers an explicit device-persistence
opt-in restricted to trusted extension contexts; the CLI reads its key from the
process environment and never persists it.

### Chat depth, routing, and performance diagnostics

Chat depth changes the bounded Chat strategy, not the product mode. **Quick**
stays direct, **Auto** chooses direct or agentic work from the question and
bound context, and **Deep** may compose focused reader, analysis, critic,
repair, and synthesis roles. Deep Research remains a separate report runtime
with its own approval and long-running completion contract.

Model routing is provider-neutral and host-owned. Every root and specialist
role declares a preference; a provider adapter may use one model for every
role, select another model, or apply provider controls. The current Anthropic
adapter keeps one model ID and uses an explicit bounded finalization corridor
for drafting, repair, and synthesis. Routing never grants scope, tools, graph
admission, or evidence authority.

`ChatRunSummaryV1.modelRouting` exposes only aggregate counts by effective model,
role route, preference, thinking mode, and finalization corridor. It contains no
prompts, answers, source bodies, URLs, queries, identifiers, credentials, or
hidden reasoning. The fixed two-anchor Deep Chat release gate allows at most ten
model calls without repair or eleven with one repair, 120 seconds median and
180 seconds worst-of-three on the synthetic provider lane. Real provider and
Atlassian latency can vary; those ceilings do not weaken the evidence floor or
turn ordinary Chat into the ten-minute Deep Research workflow.

The pinned QuickJS and Anthropic packages still expose optional Node-only
branches. Browser bundlers therefore need the optional-dependency aliases used
by `apps/extension/wxt.config.ts`; the packed MV3 build and E2E are the
authoritative browser integration proof. The plain `/browser` surface requires
none of those aliases.
