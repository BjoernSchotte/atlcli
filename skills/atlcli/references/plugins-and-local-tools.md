---
name: plugins-and-local-tools
description: Plugins (git, drawio), pdf-template packs, local models, completion, update, log and release-info commands that act on the local machine.
metadata:
  tags: plugin, git, drawio, pdf-template, models, completion, update, log
---

# Plugins and local tools

Commands in this file never create or change Jira or Confluence content on
their own, with one exception: the git plugin's hook can push docs to
Confluence (see [Plugins](#plugins)).

## Contents

- [Plugins](#plugins)
- [pdf-template](#pdf-template)
- [models](#models)
- [log](#log)
- [update and release-info](#update-and-release-info)
- [completion](#completion)
- [skill](#skill)
- [Not for agents](#not-for-agents)

## Plugins

```bash
atlcli plugin list --json
atlcli plugin enable git
atlcli plugin disable git
atlcli plugin install ./my-plugin
atlcli plugin remove my-plugin
```

Two plugins are bundled, both installed but disabled by default: `git` and
`drawio`. A bundled plugin cannot be removed. `plugin install` accepts only a
local path, copies it to `~/.atlcli/plugins/<name>`, loads it and runs its
`initialize` function. A plugin is code that runs with the user's rights
and can hook every command. Install only a plugin the user named.

An enabled plugin changes what other commands do:

- `git`: after a `wiki docs pull` into a Git repository that changed files, it
  stages and commits the directory with the message `sync(confluence): pull N
  page(s) from Confluence`, where N counts the changed files. `atlcli git hook install [dir]` writes `.git/hooks/post-commit`,
  which runs `atlcli wiki docs push <dir> --quiet` after every `git commit` in
  that repository. That push writes to Confluence, and the hook file keeps working after the plugin is disabled. `atlcli git hook status` and
  `atlcli git hook remove` inspect and remove it. `--force` overwrites a foreign
  hook. The plugin has no `wiki docs commit` command.
- `drawio`: before every `wiki docs push` it renders stale Draw.io previews to
  PNG with a Draw.io executable and aborts the push if one fails.
  `atlcli drawio preview [dir] [--check] [--force] [--executable <path>]` runs the
  same step alone. `atlcli drawio watch` blocks until interrupted.

Before a push or commit in a docs repository, run `atlcli plugin list --json`
and `atlcli git hook status` and tell the user which hooks are active.

## pdf-template

`atlcli pdf-template` builds a `.wiki-pdf-template` pack from the design of a
Word file, for use as `--template` in a PDF export (see
[confluence-export.md](confluence-export.md)). It is separate from
`wiki template`, which manages Confluence page templates. It needs no
Confluence profile and writes only local files.

```bash
atlcli pdf-template import ./brand.docx        # creates ./brand-pdf-template, never overwrites
atlcli pdf-template status ./brand-pdf-template --json
atlcli pdf-template review ./brand-pdf-template --apply-ready --non-interactive
atlcli pdf-template preview ./brand-pdf-template
atlcli pdf-template build ./brand-pdf-template --output ./brand.wiki-pdf-template
atlcli pdf-template build ./template.yaml --output ./brand.wiki-pdf-template
```

- `--json` implies `--non-interactive` and prints exactly one result document.
- Plain `review` prompts on the terminal. In an agent shell use
  `--apply-ready --non-interactive`, which applies only choices marked ready.
- Build stays blocked while required decisions or unsupported-feature
  acknowledgements are open. Run `status` to see them.
- Embedded Word graphics enter the pack only after role, rights, alt text and
  placement are confirmed. Those are the user's decisions. Do not answer them.
- Expert commands: `analyze`, `reanalyze`, `diff`, `decide`, `set`,
  `clear-override`, `clear-optional`, `validate`, `explain`, `pack`,
  `migrate-runtime`. `undo <project>` restores earlier choices as a new generation.

## models

```bash
atlcli models list
atlcli models pull table-transformer [--variant fp32|quantized]
```

`pull` downloads a model (30 or 116 MB) and the onnxruntime-node runtime
(about 100 MB) into `~/.atlcli/models` (`ATLCLI_MODELS_DIR` overrides). It is
used only by `wiki import <file.pdf> --table-model table-transformer` (see
[confluence-import.md](confluence-import.md)). Nothing is downloaded without
`pull`. Ask before running it.

## log

```bash
atlcli log list --since 1h --level error --json
atlcli log list --type api --limit 50 --json
atlcli log show <id> --json
atlcli log clear --before 7d --confirm
```

`list`, `tail` and `show` read local activity logs (also what failed in an
earlier command). `tail -f` blocks. `clear` deletes log files and needs
`--confirm`.

## update and release-info

`atlcli version` and `atlcli release-info --json` print the installed version
and build provenance. `atlcli update --check` only checks. A bare
`atlcli update` on a Homebrew install prints the `brew upgrade` command and
does nothing else, but on a script install it replaces the binary. Never run
it without the user asking.

## completion

`atlcli completion zsh` and `atlcli completion bash` print a completion script
to stdout. The user installs it by adding `eval "$(atlcli completion zsh)"` to
their shell profile. Do not edit the profile yourself.

## skill

`atlcli skill` prints this skill as built into the installed binary, so an
agent can read it without an installed copy.

```bash
atlcli skill                                     # SKILL.md
atlcli skill --list                              # every file of the skill
atlcli skill references/safety.md                # one file
atlcli skill safety.md                           # a link inside a reference, as written
atlcli skill references/safety.md --json         # {"path": ..., "content": ...}
atlcli skill --install ~/.claude/skills          # writes ~/.claude/skills/atlcli/
```

- A path is a link from the skill, as written: a `#anchor` is ignored, and a
  name that is not found at the skill root is looked up under `references/`.
  An unknown path fails with `ATLCLI_ERR_USAGE` and lists the files (in JSON
  under `details.available`).
- Put `--json` after the path. `atlcli skill --json <path>` fails with
  `--json takes no value`, since the parser would take the path as the value.
- `<path>`, `--list` and `--install` exclude each other. `--help` prints the
  command help.
- `--install <skills-root>` writes the skill to `<skills-root>/atlcli/`,
  overwriting the skill's files there and leaving other files in place; the
  output lists those others (`extra` in JSON). A symbolic link in place of
  `atlcli/`, its `references/` or one of the skill's files is refused before
  anything is written. It is a local write: ask first and name the target
  directory.

## Not for agents

- `atlcli helloworld` prints a greeting and only when the `helloworld` flag is
  on.
- The Chrome side-panel extension (PDF and Word export, Ask AI) is a browser
  UI with no CLI surface. From a script, use `wiki export` for PDF and Word,
  and `atlcli chat` or `atlcli research` for questions (only when the user asks
  for them, see SKILL.md).
