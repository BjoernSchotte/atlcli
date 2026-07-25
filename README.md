# atlcli

**Bring Confluence and Jira into your terminal, editor, browser, and CI pipeline.**

Sync Confluence spaces as Markdown, export pages and page trees to DOCX or PDF,
and automate Jira workflows. Use the CLI for repeatable work or the Chrome side
panel for private, local exports with a visual preview.

[Documentation](https://atlcli.sh/) ·
[Getting started](https://atlcli.sh/getting-started/) ·
[CLI reference](https://atlcli.sh/reference/cli-commands/)

[![Build](https://github.com/BjoernSchotte/atlcli/actions/workflows/ci.yml/badge.svg)](https://github.com/BjoernSchotte/atlcli/actions)
[![Version](https://img.shields.io/github/v/release/BjoernSchotte/atlcli)](https://github.com/BjoernSchotte/atlcli/releases)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![Docs](https://img.shields.io/badge/docs-atlcli.sh-brightgreen)](https://atlcli.sh/)

## What you can do

### Confluence as code

Pull pages into a local Markdown workspace, edit them with your usual tools,
inspect changes, and push them back with conflict detection. Page hierarchy,
attachments, macros, labels, comments, and frontmatter stay part of the
workflow.

[Explore Confluence workflows →](https://atlcli.sh/confluence/)

### Publication-ready exports

Turn one page, a page tree, or an entire space into a single DOCX or PDF. Use
reusable templates, label filters, deterministic macro handling, durable export
jobs, and machine-readable reports for repeatable publishing and CI.

[Explore DOCX and PDF export →](https://atlcli.sh/confluence/export/)

### World-class document fidelity

atlcli does not print a web page or flatten Confluence into a screenshot. It
interprets the document, resolves its content, and produces real, structured
PDF and Word files:

- **ADF-first on Confluence Cloud** — validated Atlassian Document Format is
  decoded into a shared, typed document model. Data Center and rollback paths
  use Confluence Storage Format without creating a second-class export path.
- **Rich Confluence content** — headings, nested lists, task lists, tables,
  multi-column layouts, panels, status badges, mentions, Smart Links, media
  placement, captions, inline comments, attachments, and typed emoji retain
  their document semantics.
- **An adaptive Confluence table layouter** — authored column widths, header
  rows, cell colors, vertical alignment, incomplete rows, and real
  `rowspan`/`colspan` geometry survive export. The PDF engine measures the
  available portrait or landscape region and escalates deterministically from
  normal to dense and scaled layouts, with specialized wrapping for long URLs,
  status badges, mentions, and other atomic values. Header rows repeat across
  pages, low-contrast cell themes are reported, and irreducible overflow is
  surfaced instead of silently clipping content. DOCX emits a fixed Word table
  grid with native merged cells, proportional widths, and optional
  template-owned table styles.
- **Serious macro support** — info, note, warning, tip, panel, code, expand,
  TOC, anchors, excerpts, Jira issue tables, datasources, children, details
  summaries, includes, Scroll export controls, and more render natively or
  through a controlled fallback chain.
- **Mermaid as a real diagram** — flowcharts, state, sequence, class, ER, and
  XY charts render as vector SVG. DOCX also embeds a high-resolution PNG
  fallback for older Word and LibreOffice versions.
- **Draw.io and Gliffy support** — `drawio`, `inc-drawio`, `drawio-sketch`, and
  `gliffy` macros resolve their Confluence preview assets into the exported
  document.
- **No silent content loss** — unsupported or inaccessible macros fall back
  through Confluence `export_view` and finally to a visible, readable
  placeholder. The export report records exactly what rendered, degraded, or
  was skipped.
- **Durable background exports** — the browser extension persists the job
  before the first page is read and runs source discovery, asset fetching,
  rendering, validation, and artifact delivery outside the side panel. Navigate
  elsewhere or close the panel and the export keeps running. Service-worker and
  offscreen-document restarts recover from fenced checkpoints; quitting Chrome
  pauses work and the durable queue resumes when Chrome starts again.
- **Observable and operable jobs** — every export carries a bounded,
  versioned operational log and event timeline for state changes, stages,
  progress, backoff, classified issues, recovery, and the final artifact.
  The Activity view and `atlcli wiki export jobs` expose list, show, watch,
  cancel, resume, retry, and run-again workflows, including **Resume after
  sign-in** for blocked browser sessions. Retry and Run again create linked
  history rather than rewriting the original job, while lease epochs,
  checkpoint chains, and content hashes stop stale runners from publishing the
  wrong bytes. CLI exports intentionally remain foreground jobs, but another
  process can watch or cancel their durable journal.
- **A purpose-built PDF engine** — local Typst/WASM compilation produces tagged
  PDFs with document language, bookmark outlines, internal TOC links, embedded
  fonts, syntax-highlighted code, alt-text pass-through, and deterministic
  output.
- **Native Word documents** — template-driven OOXML preserves editable
  structure and uses Word-native TOC fields, bookmarks, comments, captions,
  page breaks, and portrait/landscape sections.

PDF and DOCX share the same neutral content model and macro resolution pipeline,
so fidelity is a property of the export engine rather than a lucky property of
one output format or host.

### Browser-native exports

Open the Chrome side panel on any Confluence Cloud page and export it to Word or
PDF using the session you are already signed in with. Preview PDFs, configure
document branding, manage per-space template sets, and leave long-running
exports in the Activity view.

Compilation happens locally in your browser: the extension bundles its PDF
compiler, WebAssembly module, fonts, and export engines. Page content is not
sent to an external rendering service.

The extension currently installs from a local build and requires Chrome 140 or
newer.

### Jira from the terminal

Search, create, update, and transition issues without leaving your current
workflow. Work with attachments, boards, sprints, epics, bulk operations,
templates, analytics, and timer-based time tracking.

[Explore Jira workflows →](https://atlcli.sh/jira/)

## Get started

### Install

macOS or Linux:

```bash
curl -fsSL https://atlcli.sh/install.sh | bash
```

With Homebrew:

```bash
brew install bjoernschotte/tap/atlcli
```

Windows binaries, manual downloads, checksums, and platform-specific setup are
covered in the [installation guide](https://atlcli.sh/getting-started/#installation).

### Connect your Atlassian site

```bash
atlcli auth init
atlcli doctor
```

`auth init` guides you through creating a profile. `doctor` checks the
configuration, credentials, connectivity, and permissions before you start.
atlcli supports named profiles for multiple Atlassian sites.

## Your first Confluence workspace

```bash
# Create a Markdown workspace for a Confluence space
atlcli wiki docs init ./team-docs --space TEAM

cd team-docs
atlcli wiki docs pull

# Edit Markdown files, then inspect and publish the changes
atlcli wiki docs status
atlcli wiki docs push --validate
```

Try an export or query Jira next:

```bash
# Export a page tree as one PDF
atlcli wiki export 12345 --scope tree --output handbook.pdf

# Find your current Jira work
atlcli jira search --assignee me --status "In Progress"
```

## Built for terminals, scripts, and agents

- Human-readable output by default
- Stable machine-readable results with `--json`
- Validation and strict modes for CI
- Classified exit codes and export reports
- Named profiles for multiple Atlassian sites
- Bash and Zsh completion
- Diagnostic checks through `atlcli doctor`
- An extensible plugin system

| Workflow | Start here |
| --- | --- |
| Sync Confluence and Markdown | `atlcli wiki docs --help` |
| Manage pages and spaces | `atlcli wiki --help` |
| Export DOCX or PDF | `atlcli wiki export --help` |
| Export visually in Chrome | Open the atlcli side panel on a Confluence page |
| Search and manage Jira | `atlcli jira --help` |
| Diagnose configuration | `atlcli doctor` |
| Automate in CI | `--json`, `--strict`, and documented exit codes |
| Extend atlcli | `atlcli plugin --help` |

## CLI or browser extension?

Both use the same Confluence, DOCX, and PDF engines.

| Use the CLI when you need… | Use the browser extension when you need… |
| --- | --- |
| Repeatable, scriptable exports | A one-off export from the page you are viewing |
| CI and headless automation | PDF preview before download |
| JSON reports and classified exit codes | Visual PDF settings and branding |
| Cloud or Data Center support | Your existing Confluence Cloud browser session |
| Git-based Markdown workflows | Background activity you can leave and revisit |

## Documentation

The complete and maintained documentation lives at
**[atlcli.sh](https://atlcli.sh/)**.

- [Getting started](https://atlcli.sh/getting-started/)
- [Authentication](https://atlcli.sh/authentication/)
- [Confluence](https://atlcli.sh/confluence/)
- [DOCX and PDF export](https://atlcli.sh/confluence/export/)
- [Jira](https://atlcli.sh/jira/)
- [Recipes](https://atlcli.sh/recipes/)
- [CLI reference](https://atlcli.sh/reference/cli-commands/)
- [Troubleshooting](https://atlcli.sh/reference/troubleshooting/)

## Development

atlcli is a Bun workspace monorepo.

```bash
bun install
bun run build
bun run test
bun run typecheck
```

Run the CLI directly from source:

```bash
bun --conditions=development run --cwd apps/cli src/index.ts --help
```

See the [contributing guide](https://atlcli.sh/contributing/) for repository
structure, testing conventions, documentation development, and release
procedures.

## License

Licensed under the [Apache License 2.0](LICENSE). See [NOTICE](NOTICE) for
additional attribution.

Jira and Confluence are trademarks of Atlassian Corporation Plc, registered in
the US and other countries. atlcli is not affiliated with, endorsed by, or
sponsored by Atlassian.
