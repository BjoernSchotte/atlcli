Welcome to the **atlcli Handbook** — how the team builds, ships and runs atlcli.

:::info
New here? Start with [Getting started](#), then read the **Release process** before your first on-call week.
:::

## What lives here

| Section | What you find | Owner |
|---|---|---|
| Getting started | Install, first profile, first sync | Developer Experience |
| Architecture | Packages, data flow, export engine | Core team |
| Release process | Monthly CalVer releases, checklists | Release captain |
| Runbooks | Token rotation, incident response | On-call |

## Principles

- **Markdown in, Confluence out** — every page round-trips without losing content.
- **Ask before every write** — the CLI, the TUI and the extension show what changes first.
- **No silent loss** — anything we cannot render is reported, never dropped.
