---
title: "Agent Skill"
description: "Install the atlcli agent skill, or read it from the installed binary with atlcli skill"
---

# Agent Skill

atlcli ships an agent skill that teaches a coding agent to drive atlcli for
Jira and Confluence: the flag grammar, JSON output and error codes, and the
rule to confirm every write with the user. It uses the Agent Skills layout, a
`SKILL.md` with linked files under `references/`, and lives at
[`skills/atlcli/`](https://github.com/BjoernSchotte/atlcli/tree/main/skills/atlcli)
in the repository. Every atlcli binary carries a copy built from the same
source, and `atlcli skill` prints it.

## Prerequisites

- atlcli installed and on `PATH`, for `atlcli skill`
- An agent that loads skills from a directory, such as `.claude/skills/`

## Install the skill

### From the installed binary

```bash
atlcli skill --install .claude/skills
```

writes the skill to `.claude/skills/atlcli/`. After an atlcli upgrade, run the
command again: an installed copy stays as it was.

Files of the skill already in that directory are overwritten. Other files stay
and are listed in the output. A symbolic link in place of `atlcli/`, its
`references/` directory or one of the skill's files is refused before anything
is written, so a linked checkout is never overwritten.

### From the repository

Copy `skills/atlcli/` from the repository into the agent's skills directory, or
point an installer that follows the Agent Skills layout at it. The repository
copy follows the `main` branch.

## Read the skill without installing it

```bash
atlcli skill                                           # SKILL.md
atlcli skill --list                                    # every file of the skill
atlcli skill references/safety.md                      # one file
atlcli skill 'references/invocation.md#flag-grammar'   # a link, as written
```

Every link in the skill works as the argument as written. A `#anchor` is
ignored. A link inside a reference file, such as `safety.md`, is found under
`references/`. Quote a link with `#` in zsh, where the `extendedglob` option
treats `#` as a pattern.

## Options

| Option | Type | Default | Required | Constraints |
| --- | --- | --- | --- | --- |
| `<path>` | string | `SKILL.md` | optional | A path from `--list`, or a link as written; not with `--list` or `--install` |
| `--list` | flag | off | optional | Takes no value; not with `<path>` or `--install` |
| `--install <skills-root>` | path | none | optional | One non-empty directory; `<skills-root>/atlcli`, its `references/` and the skill's files in it must not be symbolic links; not with `<path>` or `--list` |
| `--json` | flag | off | optional | Takes no value; put it after the path |

## JSON output

```bash
atlcli skill references/safety.md --json
# {"path": "references/safety.md", "content": "..."}

atlcli skill --list --json
# {"files": ["SKILL.md", "references/auth-and-config.md", ...]}

atlcli skill --install .claude/skills --json
# {"directory": "/home/me/project/.claude/skills/atlcli", "files": [...], "extra": ["notes.md"]}
```

`extra` lists the files in the directory that are not part of the skill, as
paths relative to it.

## Troubleshooting

**`Unknown skill file: ...`.** The path names no file of this version's skill.
The message lists the available files, and `atlcli skill --list` prints them.
In JSON mode the error is `ATLCLI_ERR_USAGE` with `details.available`.

**`--json takes no value`.** A flag takes the next word as its value, so
`atlcli skill --json references/safety.md` would read the path as the value of
`--json`. Put the path first: `atlcli skill references/safety.md --json`.

**`... is a symbolic link`, `... is not a directory` or `... is not a regular
file` from `--install`.** The skill directory, its `references/` directory or
one of the skill's files in it is a symbolic link or of the wrong type. Remove
it, or install into another skills directory.

## Related topics

- [CLI Commands](/reference/cli-commands/)
- [Shell Completion](/reference/shell-completions/)
- [Confluence for Coding Agents](/recipes/confluence-vfs-agents/)
