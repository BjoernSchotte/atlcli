---
title: "Webhooks"
description: "Webhooks - atlcli documentation"
---

# Webhooks

Receive Jira events on a local server, and register webhooks with Jira Cloud.

## Prerequisites

- Authenticated profile (`atlcli auth login`)
- **Jira permission**: Administer Jira, to create webhooks in the Jira admin UI (**Settings → System → WebHooks**) that point at `serve`
- `list`, `register`, `delete` and `refresh` use Jira Cloud's dynamic webhook API. Jira allows it only for Connect and OAuth 2.0 apps: with an API token it answers 403. With an API token, create the webhook in the admin UI instead
- Publicly accessible URL (use ngrok, a Cloudflare tunnel or similar for local development)

## Start Server

```bash
atlcli jira webhook serve
atlcli jira webhook serve --port 3000 --projects PROJ,TEAM --events jira:issue_created,comment_created
```

The server accepts `POST` requests on `--path` and answers `GET /health`. Each received event is printed as one line:

```
[2025-01-14T10:00:00.000Z] CREATED: PROJ-123 - Fix login bug
[2025-01-14T10:05:00.000Z] UPDATED: PROJ-123 - Fix login bug (status: To Do → In Progress)
[2025-01-14T10:07:00.000Z] COMMENT: PROJ-123 - New comment by Alice Lee
```

Options:

| Flag | Default | Description |
|------|---------|-------------|
| `--port` | `8080` | Server port |
| `--path` | `/webhook` | Endpoint path |
| `--secret` | none | Shared secret; requests without a valid `X-Hub-Signature: sha256=<hmac>` header are rejected with 401 |
| `--projects` | all | Comma-separated project keys to accept |
| `--events` | all | Comma-separated event types to accept |

Stop the server with Ctrl+C.

## Events

| Area | Event types |
|------|-------------|
| Issues | `jira:issue_created`, `jira:issue_updated`, `jira:issue_deleted` |
| Comments | `comment_created`, `comment_updated`, `comment_deleted` |
| Attachments | `attachment_created`, `attachment_deleted` |
| Issue links | `issuelink_created`, `issuelink_deleted` |
| Worklogs | `worklog_created`, `worklog_updated`, `worklog_deleted` |
| Sprints | `sprint_created`, `sprint_updated`, `sprint_started`, `sprint_closed`, `sprint_deleted` |
| Boards | `board_created`, `board_updated`, `board_deleted` |

## Process Events in a Script

atlcli has no handler configuration. With `--json`, `serve` prints a `{"type": "started", …}` object, then one `{"schemaVersion": "1", "type": "event", "payload": {…}}` object per event; pipe that stream into your own script:

```bash
atlcli jira webhook serve --json --events jira:issue_created | \
  jq -c --unbuffered 'select(.type == "event") | .payload.issue.key' | \
  while read -r key; do
    ./scripts/notify-slack.sh "$key"
  done
```

## Webhook Setup

1. Start the server: `atlcli jira webhook serve`
2. Expose it: `ngrok http 8080`
3. Add a webhook in Jira (**Settings** → **System** → **WebHooks**) with the public URL plus `/webhook`, or register it with `webhook register`

## Manage Registered Webhooks (Cloud)

```bash
# Register; --jql limits the issues (default: all issues)
atlcli jira webhook register --url https://abc.ngrok.io/webhook \
  --events jira:issue_updated,comment_created --jql "project = PROJ"

# List
atlcli jira webhook list

# Extend the expiration (registered webhooks expire after 30 days)
atlcli jira webhook refresh 12345

# Delete (comma-separated IDs work for refresh and delete)
atlcli jira webhook delete 12345
```

| Command | Options | Prints |
|---------|---------|--------|
| `register` | `--url` (required), `--events` (required), `--jql` | `registered`, `webhookId`, `url`, `jqlFilter`, `events` |
| `list` | | `webhooks` (`id`, `jqlFilter`, `events`, `expirationDate`), `total` |
| `refresh <id>` | | `refreshed`, `expirationDate` |
| `delete <id>` | | `deleted` |

## Troubleshooting

- **401 Invalid signature**: the sender's secret differs from `--secret`, or it sends no `X-Hub-Signature` header. Drop `--secret` to test.
- **Events arrive but nothing prints**: check `--projects` and `--events`; filtered events are acknowledged but not printed.
- **403 "Only Connect and OAuth 2.0 apps can use this operation"** on `list`, `register`, `delete` or `refresh`: the profile uses an API token. Create the webhook in the Jira admin UI and run `serve` to receive it.

## Related Topics

- [Issues](issues.md) - Issue events and lifecycle
- [Boards & Sprints](boards-sprints.md) - Sprint events
