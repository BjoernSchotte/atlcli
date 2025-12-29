# MCP-over-code (atlcli)

## Purpose

Define how an MCP server uses **atlcli** as the execution layer. The MCP server **invokes the CLI** for all tool actions, keeping atlcli the single source of truth and avoiding a separate hosted service.

## Design Principles

- **CLI-first:** MCP calls the CLI; the CLI does not depend on MCP.
- **Stable contracts:** Commands expose stable JSON output and exit codes.
- **Least privilege:** MCP can only execute allowed commands via an allowlist.
- **Deterministic:** Outputs are machine-readable and consistent across versions.

## Architecture Overview

```
[MCP Client]
     |
     v
[MCP Server @atlcli/mcp]
     |
     v
[atlcli binary] --> Atlassian Cloud APIs
```

## Invocation Model

The MCP server shells out to `atlcli` with JSON output enabled:

```bash
atlcli <command> --json --no-color
```

### Required CLI Guarantees

- `--json` produces a single JSON object on stdout.
- Errors are returned as JSON with a non-zero exit code.
- `--no-color` disables ANSI output.
- `--quiet` (optional) suppresses progress logs.

### Standard Error Shape

```json
{
  "error": {
    "code": "ATLCLI_ERR_<TYPE>",
    "message": "Human-readable summary",
    "details": { "...": "..." }
  }
}
```

## Security & Policy

- **Allowlist**: MCP server only exposes specific commands/subcommands.
- **Read vs write**: Read operations are default; write operations require explicit enablement.
- **Redaction**: Sensitive fields are removed or masked in logs.
- **Rate limiting**: MCP server enforces per-user limits to protect API quotas.

### Allowlist & Tool Surface (v1)

| Tool | CLI Command | Type | Notes |
|------|-------------|------|-------|
| jira.issue.list | `atlcli issue list --jql <JQL> --json` | Read | Required |
| jira.issue.get | `atlcli issue get --key <KEY> --json` | Read | Required |
| jira.issue.create | `atlcli issue create --project <KEY> --type <TYPE> --summary <TEXT> --json` | Write | Explicit enablement |
| jira.issue.transition | `atlcli issue transition --key <KEY> --to <STATE> --json` | Write | Explicit enablement |
| confluence.page.get | `atlcli page get --id <ID> --json` | Read | Required |
| confluence.page.update | `atlcli page update --id <ID> --body <PATH> --json` | Write | Explicit enablement |
| confluence.page.create | `atlcli page create --space <KEY> --title <TEXT> --body <PATH> --json` | Write | Explicit enablement |
| docs.sync.pull | `atlcli docs pull --space <KEY> --out <DIR> --json` | Write | Explicit enablement |
| docs.sync.push | `atlcli docs push <DIR> --json` | Write | Explicit enablement |

All MCP tools map to a single CLI invocation with `--json --no-color`.

## Auth & Config

- MCP server relies on existing CLI auth config (`atlcli auth`).
- No auth credentials are stored inside the MCP server.
- Users can configure MCP to run under a restricted CLI profile.

## Versioning & Compatibility

- MCP server checks `atlcli --version` and enforces a minimum compatible version.
- CLI outputs include a `schemaVersion` for JSON responses.

## Command Output Schemas (Examples)

Each command returns a single JSON object with a `schemaVersion` field.

### 1) Jira issue list

```json
{
  "schemaVersion": "1",
  "issues": [
    { "key": "PROJ-123", "summary": "Fix login timeout", "status": "In Progress" }
  ]
}
```

### 2) Jira issue create

```json
{
  "schemaVersion": "1",
  "issue": { "key": "PROJ-124", "url": "https://<site>/browse/PROJ-124" }
}
```

### 3) Jira issue transition

```json
{
  "schemaVersion": "1",
  "issue": { "key": "PROJ-123", "status": "Done" }
}
```

### 4) Confluence page get

```json
{
  "schemaVersion": "1",
  "page": { "id": "12345", "title": "Auth ADR", "version": 7 }
}
```

### 5) Docs sync push

```json
{
  "schemaVersion": "1",
  "results": {
    "updated": 3,
    "created": 1,
    "skipped": 2,
    "conflicts": 0
  }
}
```

## Example Tools

### Jira issue search

```bash
atlcli issue list --jql "assignee = currentUser()" --json
```

### Confluence page update

```bash
atlcli page update --id 12345 --body ./page.md --json
```

## MCP in CI

- **Default posture:** read-only allowlist and `--dry-run` where supported.
- **Write enablement:** requires explicit CI config, e.g. `ATLCLI_MCP_ALLOW_WRITE=1`.
- **Auditability:** log CLI command, exit code, and redacted JSON output.
- **Isolation:** run MCP with a dedicated CLI profile and limited scopes.
- **Fail closed:** non-zero exit codes stop the pipeline step.

## Open Questions

- Should MCP expose a generic `atlcli exec` tool, or only curated tools?
- How strict should the allowlist be in CI vs interactive use?
- Should MCP provide a sandbox mode for safe dry runs?
