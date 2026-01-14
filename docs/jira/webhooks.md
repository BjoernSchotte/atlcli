# Webhooks

Run a local webhook server for Jira events.

## Start Server

```bash
atlcli jira webhook serve --port 3000
```

Starts a server listening for Jira webhook events.

## Events

Supported events:

- `issue_created`
- `issue_updated`
- `issue_deleted`
- `comment_created`
- `sprint_started`
- `sprint_completed`

## Configuration

Configure webhook handlers in `.atlcli-webhooks.json`:

```json
{
  "handlers": [
    {
      "event": "issue_created",
      "command": "./scripts/notify-slack.sh"
    },
    {
      "event": "issue_updated",
      "filter": "project = PROJ AND type = Bug",
      "command": "./scripts/update-dashboard.sh"
    }
  ]
}
```

## Webhook Setup

1. Start the server: `atlcli jira webhook serve`
2. Expose with ngrok: `ngrok http 3000`
3. Add webhook in Jira project settings with ngrok URL

## Handler Scripts

Handler scripts receive event data via stdin:

```bash
#!/bin/bash
# notify-slack.sh
read -r event_data
key=$(echo "$event_data" | jq -r '.issue.key')
echo "Issue created: $key"
```
