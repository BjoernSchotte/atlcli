---
name: confluence-publish
description: Building a static Astro or Starlight site from Confluence pages with wiki publish.
metadata:
  tags: confluence, publish, astro, starlight, static-site
---

# Web publishing

`atlcli wiki publish` turns a Confluence page, page tree or space into a
verified static site. It reads Confluence and writes only to local paths. It
does not deploy: the last stage reports `verified`, not `deployed`. Use it
only when the user wants a documentation site. For editable Markdown copies of
pages use [confluence-docs-sync.md](confluence-docs-sync.md).

## Contents

- [Project file](#project-file)
- [Stages](#stages)
- [Flags](#flags)
- [Pitfalls](#pitfalls)

## Project file

Everything is configured in a strict JSON file, by default
`.atlcli/publish.json` in the working directory. It holds no credentials.
Unknown fields are rejected and no object is filled with defaults, so start
from the schema-tested example on the atlcli documentation site
(`publishing/configuration`) instead of writing one from memory.

Fields that decide risk:

- `source`: exactly one of `{kind:"page",pageId}`, `{kind:"tree",rootPageId}`,
  `{kind:"space",spaceKey}`.
- `visibility`: `internal` or `public`. `public` requires `--confirm-public`
  on every command.
- `completeness`: `strict` or `allow-partial`. `allow-partial` requires
  `--allow-partial`.
- `builder.projectDir`: the Astro project that `build` runs.

Read the file and show the user `source`, `visibility` and `builder.projectDir`
before running anything beyond `plan`.

## Stages

```bash
atlcli wiki publish plan   --project .atlcli/publish.json --json
atlcli wiki publish refresh --project .atlcli/publish.json --dry-run --json
atlcli wiki publish refresh --project .atlcli/publish.json --json
atlcli wiki publish build  --project .atlcli/publish.json --json
atlcli wiki publish verify --project .atlcli/publish.json --json
atlcli wiki publish run    --project .atlcli/publish.json --json
atlcli wiki publish status --project .atlcli/publish.json --json
```

| Stage | Contacts Confluence | Writes |
| --- | --- | --- |
| `plan` | yes, reads the page graph | `last-plan.json` in the workspace |
| `refresh` | yes, reads pages and attachments | an immutable bundle, activated only when complete. `--dry-run` plans without activating |
| `build` | no | runs the project's Astro build, writes `dist/` under `builder.projectDir` and a build manifest |
| `verify` | no | nothing. Checks the latest build against the active bundle |
| `run` | yes | refresh, build and verify in sequence |
| `status` | no | nothing |
| `prune --confirm` | no | deletes verified unreachable bundles and builds |

The workspace defaults to `.atlcli/publish/<publicationKey>`, overridable
with `--workspace`.

## Flags

`--project <path>`, `--workspace <path>`, `--profile <name>`,
`--confirm-public`, `--allow-partial`, `--build <digest>` (verify a specific
build), `--dry-run`, `--json`. Here `--confirm` is only the gate for `prune`.

## Pitfalls

- `build` and `run` execute the Astro project at `builder.projectDir`,
  including its dependencies and config. Treat that directory as code you are
  running. Do not build a project the user has not named.
- `refresh --dry-run` still contacts Confluence and writes `last-plan.json`.
- A refresh that is incomplete (unreadable pages, changed versions) is not
  activated. Read `last-plan.json` instead of retrying with
  `--allow-partial`.
- Public output is public once the user deploys it. Do not set
  `visibility: "public"` or pass `--confirm-public` on your own.
- `prune` is the only stage that deletes. It needs `--confirm`; ask first.

Related: [confluence-export.md](confluence-export.md),
[safety.md](safety.md).
