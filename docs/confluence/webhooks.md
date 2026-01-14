# Webhooks

Set up webhooks to receive real-time notifications when Confluence content changes.

## Overview

Webhooks allow external systems to be notified when events occur in Confluence:

- Page created, updated, or deleted
- Page moved or renamed
- Page trashed or restored
- Comments added

atlcli supports both registering webhooks with Confluence and running a local webhook server.

## Register Webhook

Register a webhook to receive events:

```bash
atlcli webhook register --url https://your-server.com/webhook --events page_created,page_updated
```

Options:

| Flag | Description |
|------|-------------|
| `--url` | Webhook endpoint URL (required) |
| `--events` | Comma-separated event types |
| `--space` | Filter to specific space key |
| `--pages` | Filter to specific page IDs |
| `--secret` | HMAC secret for signature verification |

### Event Types

| Event | Description |
|-------|-------------|
| `page_created` | New page created |
| `page_updated` | Page content updated |
| `page_removed` | Page permanently deleted |
| `page_trashed` | Page moved to trash |
| `page_restored` | Page restored from trash |
| `page_moved` | Page moved to new location |
| `comment_created` | Comment added to page |
| `comment_updated` | Comment edited |
| `comment_removed` | Comment deleted |

### Examples

```bash
# All page events in a space
atlcli webhook register \
  --url https://ci.company.com/confluence-hook \
  --events page_created,page_updated,page_removed \
  --space DOCS

# Specific pages only
atlcli webhook register \
  --url https://notify.company.com/hook \
  --events page_updated \
  --pages 12345,67890

# With HMAC signature verification
atlcli webhook register \
  --url https://secure.company.com/hook \
  --events page_updated \
  --secret "your-webhook-secret"
```

## List Webhooks

View registered webhooks:

```bash
atlcli webhook list
```

Output:

```
ID        URL                                    EVENTS                 SPACE
wh-001    https://ci.company.com/hook           page_created,updated   DOCS
wh-002    https://notify.company.com/hook       page_updated           (all)
```

Options:

| Flag | Description |
|------|-------------|
| `--format` | Output format: `table`, `json` |

## Delete Webhook

Remove a registered webhook:

```bash
atlcli webhook delete wh-001 --confirm
```

## Local Webhook Server

Run a local server to receive and process webhook events:

```bash
atlcli webhook server --port 8080
```

Options:

| Flag | Description |
|------|-------------|
| `--port` | Port to listen on (default: 8080) |
| `--secret` | HMAC secret for verification |
| `--handler` | Custom handler script path |

### Server Output

The server logs incoming events:

```
[2025-01-14 10:30:00] Webhook server started on :8080
[2025-01-14 10:30:15] page_updated: "API Reference" (12345) by alice@company.com
[2025-01-14 10:31:22] page_created: "New Guide" (12346) by bob@company.com
```

### Custom Handler

Process events with a custom script:

```bash
atlcli webhook server --port 8080 --handler ./process-event.sh
```

Handler receives JSON via stdin:

```bash
#!/bin/bash
# process-event.sh
EVENT=$(cat)
TYPE=$(echo $EVENT | jq -r '.eventType')
PAGE_ID=$(echo $EVENT | jq -r '.page.id')

case $TYPE in
  page_updated)
    echo "Page $PAGE_ID was updated"
    # Trigger rebuild, notification, etc.
    ;;
esac
```

## Sync Integration

Use webhooks with `docs sync` for real-time updates:

```bash
# Start sync with webhook support
atlcli wiki docs sync ./docs --watch --webhook-port 8080
```

When a page is updated in Confluence:
1. Webhook receives the event
2. Sync automatically pulls the changed page
3. Local file is updated

### Register Sync Webhook

```bash
# Register webhook and start sync
atlcli wiki docs sync ./docs \
  --watch \
  --webhook-port 8080 \
  --webhook-url https://your-server.com:8080/webhook
```

## Webhook Payload

Event payloads contain:

```json
{
  "eventType": "page_updated",
  "timestamp": "2025-01-14T10:30:15Z",
  "user": {
    "accountId": "abc123",
    "displayName": "Alice",
    "email": "alice@company.com"
  },
  "page": {
    "id": "12345",
    "title": "API Reference",
    "spaceKey": "DOCS",
    "version": 5,
    "url": "https://company.atlassian.net/wiki/spaces/DOCS/pages/12345"
  }
}
```

## Signature Verification

When using `--secret`, atlcli signs payloads with HMAC-SHA256:

```
X-Atlcli-Signature: sha256=abc123...
```

Verify in your handler:

```python
import hmac
import hashlib

def verify_signature(payload, signature, secret):
    expected = 'sha256=' + hmac.new(
        secret.encode(),
        payload.encode(),
        hashlib.sha256
    ).hexdigest()
    return hmac.compare_digest(signature, expected)
```

## Health Check

The webhook server exposes a health endpoint:

```bash
curl http://localhost:8080/health
```

```json
{"status": "ok", "uptime": 3600}
```

## Use Cases

### CI/CD Documentation Build

```bash
# In your CI/CD pipeline
atlcli webhook register \
  --url https://ci.company.com/trigger/docs-build \
  --events page_updated \
  --space DOCS
```

When documentation changes, trigger a rebuild.

### Slack Notifications

```bash
# Custom handler for Slack
atlcli webhook server --port 8080 --handler ./slack-notify.sh
```

```bash
#!/bin/bash
# slack-notify.sh
EVENT=$(cat)
TITLE=$(echo $EVENT | jq -r '.page.title')
USER=$(echo $EVENT | jq -r '.user.displayName')
URL=$(echo $EVENT | jq -r '.page.url')

curl -X POST -H 'Content-type: application/json' \
  --data "{\"text\": \"$USER updated <$URL|$TITLE>\"}" \
  $SLACK_WEBHOOK_URL
```

### Audit Logging

```bash
# Log all changes to file
atlcli webhook server --port 8080 --handler ./audit-log.sh
```

```bash
#!/bin/bash
# audit-log.sh
cat >> /var/log/confluence-audit.jsonl
```
