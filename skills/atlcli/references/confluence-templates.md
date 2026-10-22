---
name: confluence-templates
description: Confluence page templates (storage levels, rendering, and creating pages from them).
metadata:
  tags: confluence, templates, variables
---

# Confluence page templates

Templates are Markdown stored locally. A name is resolved most-specific first:
**space > profile > global**, so a space template shadows a global one of the
same name. (`atlcli wiki template` prints the levels in the opposite order; the
resolver checks space first.) These are page templates. Word and PDF export
templates are a separate feature, see [confluence-export.md](confluence-export.md).

## Contents

- [Listing and inspecting](#listing-and-inspecting)
- [Managing templates](#managing-templates)
- [Rendering and creating from a template](#rendering-and-creating-from-a-template)
- [Anti-patterns](#anti-patterns)

## Listing and inspecting

```bash
atlcli wiki template list --json
atlcli wiki template list --level global --json
atlcli wiki template show meeting-notes --json
atlcli wiki template validate meeting-notes --json
atlcli wiki template validate --all --json
atlcli wiki template validate --file ./template.md --json
```

`list` hides templates shadowed by a more specific level; `--all` shows them.
`list` also filters with `--tag` and `--search`. `validate --all` exits 1 when
any template is invalid, warnings keep exit 0.

## Managing templates

```bash
atlcli wiki template create standup --file ./standup.md --json
atlcli wiki template init retro --from 12345 --json               # from a page, or a local file path
atlcli wiki template init retro --from 'Weekly Meeting' --from-space TEAM --json
atlcli wiki template copy meeting-notes --from-level global --to-space TEAM --json
atlcli wiki template export -o ./my-pack --json
atlcli wiki template import ./templates-export --json
atlcli wiki template import https://github.com/user/templates --json
atlcli wiki template update --json                                # re-pull tracked sources
atlcli wiki template rename old-name new-name --json
atlcli wiki template delete old-template --force --json
```

Target a level with `--level global|profile|space`, or with `--profile <name>`
or `--space <key>`, which also name the level. Two flags that name different
levels are rejected, and a named level without its context (no profile, no
space key) is an error. Without any of them, reads use the precedence order and
writes go to the current space when a space is known (`--space` or the
configured default space), otherwise to global. Pass `--level global` to be
sure. On the template commands `--profile` therefore selects the profile level,
not only the auth profile.

`init` and `copy` use their own flags: `--to-profile`, `--to-space`,
`--from-level`, `--from-profile`, `--from-space`. `create` fails on an existing
name unless `--force` is given; `init` and `copy` too. `create` without `--file`
needs a terminal. `create` and `render` accept `--interactive`. `edit` has no
such flag: it always opens `$EDITOR` and aborts with "Edit requires an
interactive terminal" otherwise, so it can never run unattended. `delete`
takes `--force`, not `--confirm`, and removes a local file; outside a terminal
it fails without `--force`.

`import` skips existing names unless `--replace` is given. `update` re-pulls
tracked sources and replaces what they provide (`--source <url>` limits it).

Built-in variables available inside a template: `@date`, `@datetime`, `@time`,
`@year`, `@month`, `@day`, `@weekday`, `@user`, `@space`, `@profile`, `@title`,
`@parent`, `@uuid`.

## Rendering and creating from a template

Render locally to inspect the result before anything is published:

```bash
atlcli wiki template render meeting-notes --var title='Sprint Planning' --json
atlcli wiki template render meeting-notes --var title='Planning' > ./out.md
```

`--var key=value` is repeatable. `@title` comes from `render --title`, not
from `--var title=`. Create the page from the same template:

```bash
atlcli wiki page create --space TEAM --template meeting-notes \
  --title 'Sprint Planning' --var title='Sprint Planning' --dry-run --json
atlcli wiki page create --space TEAM --template meeting-notes \
  --title 'Sprint Planning' --parent 12345 --json
```

`--title` is required in template mode, and so is a space (`--space`, a default
space, or the template's target). `--parent` overrides the template's target
parent. `--dry-run` prints the rendered Markdown and the labels that would be
applied without creating the page. Run it first and show the user.

## Anti-patterns

- Publishing a template-created page without a `--dry-run` review. An
  unresolved `{{variable}}` renders as an empty string, and
  `wiki page create --template` does not enforce required variables.
- Running `--interactive` or `wiki template edit` unattended. Both wait for a
  human.

Related: [confluence-pages.md](confluence-pages.md),
[confluence-export.md](confluence-export.md).
