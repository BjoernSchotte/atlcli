# @atlcli/export-macros

The macro-renderer registry for the export engines: an async resolver pass
that turns Confluence macro blocks (TOC, Jira, children, include/excerpt,
multiexcerpt, page-properties-report, embedded Whiteboard links, export_view
fallback, diagrams, …)
into renderable `ExportBlock` content. Zero runtime imports from other
`@atlcli/*` packages — hosts inject the walker, converters, and
`JiraClient`/`ConfluenceClient` ports at construction time.

- **Entry points:** `.` — `defaultRegistry`, `resolveMacroBlocks`,
  `MacroRendererRegistry` types, and the concrete renderers.
- **Runtime:** Node ≥ 20, Bun, and browsers (isomorphic; gated by the repo's
  browser-build check).
- **Install:** filesystem link or packed tarball — no registry publish today.
  See the [package consumption guide](https://atlcli.sh/reference/package-consumption/).

```ts
import { defaultRegistry, resolveMacroBlocks } from "@atlcli/export-macros";

const registry = defaultRegistry({ storageToBlocks, htmlToExportBlocks, parsePageProperties });
const resolved = await resolveMacroBlocks(blocks, { registry, ports });
```

Versioning: lockstep `@atlcli/*` train, pre-1.0 rules — see
[package versioning](https://atlcli.sh/reference/versioning/).

Embedded `native-embed:whiteboard` ADF nodes are handled offline. The registry
accepts only a validated same-site
`/wiki/spaces/{spaceKey}/whiteboard/{id}` destination and emits one neutral
`Atlassian Whiteboard` Smart Card. It does not fetch Whiteboard content or
metadata; invalid targets remain visible as a non-clickable degraded fallback.
