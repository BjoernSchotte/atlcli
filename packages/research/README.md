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

Both runtime entries use the same request/report schemas, read capabilities,
dynamic subagent composition, QuickJS limits, report finalizer, and Markdown
bytes. Each host injects a virtual workspace; the runtime persists the
normalized one-shot request and `/artifacts/report.md` before returning. CLI
and browser hosts also consume the same body-free phase, progress, capability,
subagent, decision, and artifact event shape. Capability events contain only
safe metadata such as status, item count, termination, and duration; raw tool
results, prompts, provider errors, and hidden chain-of-thought never enter the
stream. Scope seeds preserve their ordered source (`cli_flag`, `ui_added`,
`current_context`, or default) and authority without allowing lower-precedence
context to replace locked scope. Hosts retain ownership of credentials,
lifecycle, cancellation, and artifact presentation. The extension keeps
Anthropic keys in session storage; the CLI reads its key from the process
environment and never persists it.

The pinned QuickJS and Anthropic packages still expose optional Node-only
branches. Browser bundlers therefore need the optional-dependency aliases used
by `apps/extension/wxt.config.ts`; the packed MV3 build and E2E are the
authoritative browser integration proof. The plain `/browser` surface requires
none of those aliases.
