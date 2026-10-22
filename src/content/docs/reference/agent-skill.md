---
title: "Agent Skill"
description: "The atlcli agent skill in the repository and how to install it"
---

# Agent Skill

atlcli ships an agent skill that teaches a coding agent to drive atlcli for
Jira and Confluence: the flag grammar, JSON output and error codes, and the
rule to confirm every write with the user. It uses the Agent Skills layout, a
`SKILL.md` with linked files under `references/`, and lives at
[`skills/atlcli/`](https://github.com/BjoernSchotte/atlcli/tree/main/skills/atlcli)
in the repository.

## Prerequisites

- An agent that loads skills from a directory, such as `.claude/skills/`

## Install the skill

### From the repository

Copy `skills/atlcli/` from the repository into the agent's skills directory, or
point an installer that follows the Agent Skills layout at it. The repository
copy follows the `main` branch.

## Related topics

- [CLI Commands](/reference/cli-commands/)
- [Confluence for Coding Agents](/recipes/confluence-vfs-agents/)
