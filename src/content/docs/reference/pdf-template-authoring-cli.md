---
title: "PDF Template Authoring CLI"
description: "Command, state, JSON, automation, graphics, and recovery reference for creating PDF template packs from Word documents"
---

# PDF Template Authoring CLI

`atlcli pdf-template` turns design evidence from a `.docx` into a reviewed,
compiled `.wiki-pdf-template` pack. The primary commands are task-oriented;
expert commands expose the same host-neutral workflow for scripts and future
browser-based authoring surfaces.

Start with [Create a PDF template from Word](/confluence/pdf-template-from-word/)
if you want the guided workflow.

## On this page

- [Command model](#command-model)
- [Primary commands](#primary-commands)
- [Import options](#import-options)
- [Review and graphics options](#review-and-graphics-options)
- [Expert commands](#expert-commands)
- [Stages and resumability](#stages-and-resumability)
- [TTY and non-TTY behavior](#tty-and-non-tty-behavior)
- [JSON and progress contracts](#json-and-progress-contracts)
- [Project layout and privacy](#project-layout-and-privacy)
- [Automation example](#automation-example)
- [Exit behavior and recovery](#exit-behavior-and-recovery)
- [Related topics](#related-topics)

## Command model

```text
atlcli pdf-template <command> [source-or-project] [options]
```

`pdf-template` manages local PDF design packs. It is unrelated to
`atlcli wiki template`, which manages Confluence page templates.

## Primary commands

| Command | Input | Effect |
|---|---|---|
| `import <docx>` | New Word source | Creates a no-clobber project; applies no suggestion by default |
| `status <project>` | Existing project | Reads the current generation without changing it |
| `review <project>` | Existing project | Runs interactive review, or explicit batch actions |
| `preview <project>` | Reviewed project | Writes design-review and compatibility PDFs |
| `build <project>` | Freshly previewed project | Writes one verified pack and a content-addressed local dist generation |
| `undo <project>` | Project with history | Restores prior authoring intent as a new generation |

Project paths can be positional or supplied with `--dir` where the command
supports it. Use the positional form in human workflows.

## Import options

| Option | Type | Default | Required | Constraints |
|---|---|---|---|---|
| `--dir <path>` | path | `./<source-name>-pdf-template` | No | Must not already exist on initial import |
| `--baseline <id>` | string | `builtin.editorial-indigo` | No | Must name a supported complete baseline |
| `--policy <policy>` | enum | `suggest-only` | No | `suggest-only`, `safe`, or `recommended` |
| `--metadata-only` | boolean | `false` | No | Skips graphic-byte extraction |

`suggest-only` is the human-safe default: it creates candidates but no
decisions. `safe` and `recommended` are explicit automation policies and
produce different, deterministic decision sets.

## Review and graphics options

Explicit batch review:

```bash
atlcli pdf-template review ./brand-pdf-template --apply-ready
atlcli pdf-template review ./brand-pdf-template \
  --keep-current-for-remaining --acknowledge-unsupported
```

These flags are independent. Each applies only when the current import view
offers the matching action.

Expert graphic acceptance uses a candidate ID obtained from `--json` or
`--details`:

```bash
atlcli pdf-template decide \
  --dir ./brand-pdf-template \
  --candidate '<candidate-id>' \
  --accept-asset \
  --role page-background \
  --rights-confirmed \
  --decorative \
  --slot-default
```

| Choice | Accepted values or rule |
|---|---|
| `--role` | `logo`, `page-background`, `cover-art`, `header-decoration`, `footer-decoration`, or their `asset.*` names |
| Rights | `--rights-confirmed` is mandatory for inclusion |
| Accessibility | Exactly one of `--decorative` or `--meaningful --alt <text>` |
| Placement | Exactly one of `--slot-default`, `--use-candidate-placement`, or `--custom-placement <json-object>` |

Candidate placement is rejected when the Word placement depends on layout or
uses a reference frame the PDF runtime cannot reproduce safely.

## Expert commands

| Command | Purpose |
|---|---|
| `analyze <docx>` | Import-compatible analysis surface for automation |
| `reanalyze <docx> --dir <project>` | Analyze changed source while preserving and reconciling intent |
| `diff <project>` | Show resolved baseline-to-draft differences |
| `decide` | Apply one typed candidate, asset, group, or inventory action |
| `set --target <path> --value <json>` | Set one catalog-validated override |
| `clear-override --target <path>` | Remove an explicit override |
| `clear-optional --target <path>` | Explicitly clear a supported optional value |
| `validate <project>` | Validate the current build inputs without writing a pack |
| `pack <project> --output <path>` | Expert spelling of the verified build boundary |

Unknown capability paths, wrong JSON value types, out-of-range values,
duplicate flags, and conflicting actions fail without moving the active
generation.

## Stages and resumability

| Stage | Meaning | Typical next action |
|---|---|---|
| `analyzing` | Import is in progress | Wait for the command |
| `review-required` | Decisions remain | `review` |
| `ready-to-preview` | Review is complete | `preview` |
| `ready-to-build` | Proof artifacts match the active generation | `build` |
| `built` | A verified pack was written | Use it in `wiki export` |
| `source-changed` | Source identity no longer matches | `reanalyze` |
| `blocked` | A validation or compatibility blocker remains | Follow the reported recovery command |

Every mutation appends an immutable generation, then atomically selects it.
`status` is read-only. `undo` appends a restored generation instead of deleting
history. A crash or concurrent writer cannot expose a partially written
generation.

## TTY and non-TTY behavior

Interactive review starts only when both standard input and the presentation
stream are TTYs and neither `--json` nor `--non-interactive` is active.

| Environment | Behavior |
|---|---|
| Interactive TTY | Questions, back/skip/stop controls, business-facing copy |
| Redirected input or output | No prompt and no inferred mutation |
| `--non-interactive` | No prompt; only explicit action flags can mutate |
| `--json` | Implies non-interactive; one result document on stdout |
| `--details` in text mode | Adds generations, capability targets, candidate IDs, and digests |
| `--no-color` or `NO_COLOR` | Disables ANSI status color; non-TTY output is plain automatically |
| `--ascii` | Uses ASCII status markers instead of Unicode |

A plain non-interactive `review` is a read-only status response with exact
commands for the available explicit actions.

## JSON and progress contracts

Machine mode uses versioned, structured-clone-safe contracts:

| Stream or file | Schema | Purpose |
|---|---|---|
| stdout | `atlcli.pdf-template-result/1` | One command result, including `ok`, `exitCode`, command, view, diagnostics, outputs, and next actions |
| nested `view` | `wiki.pdf-template-import-view/v1` | Stage, grouped sections/items, counts, diagnostics, available actions, next actions, and preview freshness |
| stderr JSONL | `wiki.pdf-template-import-progress/v1` | Bounded progress events for analysis, preview, and build |
| `proof/results.json` | `atlcli.pdf-template-proof/1` | Preview generation, snapshot digest, compiler version, artifact hashes, page counts, and semantic regions |
| project marker | `wiki.pdf-template-project/v1` | Opaque local project identity |

Example:

```bash
atlcli pdf-template status ./brand-pdf-template \
  --json --no-log >status.json 2>progress.jsonl

jq -r '.view.stage' status.json
jq -r '.nextActions[0]' status.json
```

`--json` writes exactly one JSON document to stdout. Progress, if any, is
newline-delimited JSON on stderr; ordinary log output is disabled explicitly
with `--no-log` in automation.

Candidate IDs and digests are opaque. Persist semantic decisions through the
command contract, not by editing project JSON or deriving meaning from an ID.

## Project layout and privacy

The local project separates portable authoring state from private intake
material:

```text
brand-pdf-template/
├── project.json          # project identity
├── current.json          # active immutable generation
├── state/                # hash-addressed authoring generations
├── .intake/              # private source sidecar and extracted graphics
├── proof/                # human PDFs plus results.json
└── dist/                 # content-addressed generated runtime and pack
```

The implementation refuses symlink traversal, corrupt markers, unexpected
replacement, and concurrent same-base writes. Private directories and files
use restrictive permissions. The pack contains accepted graphics, not every
graphic found in Word; it contains neither the source DOCX nor authoring
history.

Do not hand-edit project internals. Use `review`, `decide`, `set`,
`clear-override`, `reanalyze`, and `undo`.

## Automation example

This advanced workflow keeps every mutation explicit and gates on the stage:

```bash
set -euo pipefail

project=./brand-pdf-template
pack=./brand.wiki-pdf-template

atlcli pdf-template import ./brand.docx \
  --dir "$project" --policy suggest-only --json --no-log >state.json

if jq -e '.view.availableActions[]
  | select(.kind == "apply-ready" and .enabled)' state.json >/dev/null; then
  atlcli pdf-template review "$project" \
    --apply-ready --non-interactive --json --no-log >state.next.json
  mv state.next.json state.json
fi

if jq -e '.view.availableActions[]
  | select(.kind == "keep-current-for-remaining" and .enabled)' \
  state.json >/dev/null; then
  atlcli pdf-template review "$project" \
    --keep-current-for-remaining --non-interactive \
    --json --no-log >state.next.json
  mv state.next.json state.json
fi

if jq -e '.view.availableActions[]
  | select(.kind == "acknowledge-inventory" and .enabled)' \
  state.json >/dev/null; then
  atlcli pdf-template review "$project" \
    --acknowledge-unsupported --non-interactive \
    --json --no-log >state.next.json
  mv state.next.json state.json
fi

test "$(jq -r '.view.stage' state.json)" = "ready-to-preview"

atlcli pdf-template preview "$project" \
  --non-interactive --json --no-log >preview.json

test "$(jq -r '.view.stage' preview.json)" = "ready-to-build"

atlcli pdf-template build "$project" --output "$pack" \
  --non-interactive --json --no-log >build.json
```

If graphics are present, the workflow must make explicit `decide
--accept-asset` or rejection decisions before the final review step. Do not
automatically confirm rights or accessibility on behalf of a person.

## Exit behavior and recovery

| Exit code | Class | Project behavior |
|---|---|---|
| `0` | Success or read-only status | Reported generation is authoritative |
| `1` | Usage or local I/O | Active draft retained |
| `5` | Analysis, validation, preview, or build failure | Active draft and last valid proof retained |

Failures include a stable diagnostic code and zero or more recovery commands.
They do not partially activate a generation or leave a partial pack at the
requested output path.

Common recovery:

```bash
# Find the current state and next valid action
atlcli pdf-template status ./brand-pdf-template

# Refresh changed source facts while retaining compatible intent
atlcli pdf-template reanalyze ./brand-v2.docx \
  --dir ./brand-pdf-template

# Restore the prior committed intent
atlcli pdf-template undo ./brand-pdf-template
```

## Related topics

- [Create a PDF template from Word](/confluence/pdf-template-from-word/) —
  guided business-user workflow
- [DOCX and PDF Export](/confluence/export/) — apply a built pack
- [Template Pack Format](/reference/template-pack-format/) — canonical source,
  hashes, and resource limits
- [PDF Template Contract](/reference/pdf-template-contract/) — runtime API
- [Export Automation](/recipes/export-automation/) — CI export workflow
