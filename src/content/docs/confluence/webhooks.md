---
title: "Webhooks"
description: "Receive Confluence page events in the sync daemon"
---

# Webhooks

The sync daemon can receive Confluence page events over HTTP, so remote changes arrive without waiting for the next poll.

atlcli has no standalone Confluence webhook command. Webhooks are an option of `atlcli wiki docs sync`. For Jira events, see [Jira webhooks](../jira/webhooks.md).

## Prerequisites

- Authenticated profile (`atlcli auth login`)
- A directory that syncs with Confluence (see [Sync](sync.md))
- A URL that Confluence can reach and that forwards to the daemon's port (a reverse proxy or a tunnel such as ngrok or a Cloudflare tunnel)
- A shared secret, if anything but a process on the same machine delivers the events (see [Security](#security))

## Start sync with a webhook server

```bash
atlcli wiki docs sync ./docs --space DEV --webhook-port 3000
```

The daemon then listens on `127.0.0.1:3000`. A tunnel or reverse proxy on the same machine reaches it there; other machines do not.

| Request | Result |
|---------|--------|
| `POST /webhook` | Processes a page event, answers `{"status":"ok"}` |
| `GET /health` | Answers `{"status":"ok"}` |
| anything else | `404` |

Polling and file watching keep running next to the webhook server. Add `--no-poll` to rely on webhooks alone.

## Options

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--webhook-port <port>` | integer, 1–65535 | none (server off) | Start the webhook server on this port |
| `--webhook-host <addr>` | IP address or `localhost` | `127.0.0.1` | Interface the server binds. Optional. Any address that is not loopback (`0.0.0.0`, `::`, a LAN address) requires a secret |
| `--webhook-secret <value>` | string | none | Shared secret that every event must prove. Optional. Prefer the environment variable, which keeps the secret out of the shell history and the process list |
| `--webhook-url <url>` | URL | none | Public URL to register with Confluence. Only used together with `--webhook-port` |

| Environment variable | Description |
|----------------------|-------------|
| `ATLCLI_WEBHOOK_SECRET` | The shared secret. `--webhook-secret` wins when both are set |

All other flags are those of [`wiki docs sync`](sync.md).

## Register the webhook with Confluence

With `--webhook-url`, the daemon registers a webhook named `atlcli-sync` for `page_created`, `page_updated`, `page_removed` and `page_trashed` when it starts:

```bash
atlcli wiki docs sync ./docs --space DEV \
  --webhook-port 3000 \
  --webhook-url https://sync.example.com/webhook
```

The URL must end in `/webhook` and reach the daemon's port. When a secret is set, it is sent with the registration (`configuration.secret`). Whether your Confluence then signs each delivery depends on the deployment: send a test event and check that it is accepted before relying on it.

If Confluence rejects the registration, the daemon reports `Failed to register webhook: ...` and keeps running with polling. The registration is not removed when the daemon stops; delete it in Confluence when you no longer need it.

Without `--webhook-url`, create the webhook yourself and point it at the server.

## Events

The server expects a JSON body of this shape:

```json
{
  "eventType": "page_updated",
  "timestamp": "2025-01-14T10:00:00Z",
  "page": { "id": "12345", "title": "API Guide", "spaceKey": "DEV", "version": 5 }
}
```

| `eventType` | What the daemon does |
|-------------|----------------------|
| `page_created`, `page_updated` | Pulls the page, as a detected remote change |
| `page_removed`, `page_trashed` | Reports `Remote page deleted: <title>` for a tracked page. The local file stays |
| other | Nothing |

Events without a `page` object or with a page id that is not numeric are ignored.

Only the page id is taken from an event. Title, space and version in the body are not used.

## Security

### Scope

The daemon never pulls a page because a request says so. For a page it does not track yet, it asks Confluence where the page is and pulls it only when it lies inside the sync scope:

| Scope | A page is pulled when |
|-------|-----------------------|
| `--page-id` | It is that page |
| `--ancestor` (page tree) | It is the root page or Confluence lists the root among its ancestors |
| `--space` | Confluence reports that space for it |

An event for any other page is answered with `{"status":"ok"}` and reported as `Webhook ignored: page <id> is outside the sync scope`. Nothing is written. If the lookup fails (page deleted, no permission, network error), the event is ignored with an error line.

A request cannot write to Confluence or choose what is written locally; the content always comes from Confluence.

### Authentication

Set a shared secret whenever events come from another machine:

```bash
export ATLCLI_WEBHOOK_SECRET="$(openssl rand -hex 32)"
atlcli wiki docs sync ./docs --space DEV --webhook-port 3000
```

With a secret, `POST /webhook` answers `401` unless the request proves it in one of two ways:

| Header | Value | Sent by |
|--------|-------|---------|
| `X-Hub-Signature` | `sha256=<hex HMAC-SHA256 of the raw body, keyed with the secret>` | Senders that sign the body with the shared secret |
| `Authorization` | `Bearer <secret>` | Senders that cannot sign a body, such as an automation rule's web request with a custom header |

A request that carries an `X-Hub-Signature` header is judged by that signature alone. `GET /health` needs no secret.

Not every sender can sign. If your Confluence does not send `X-Hub-Signature` (a test delivery answered with `401` shows it), deliver the events through a sender that can set a header, such as an automation rule's **Send web request** action, and add the `Authorization` header there.

### Bind address

| Secret | `--webhook-host` | Result |
|--------|------------------|--------|
| not set | not set or loopback | Listens on loopback only and prints a warning. Any local process can post events |
| not set | any other address | Usage error, the daemon does not start |
| set | not set | Listens on `127.0.0.1` |
| set | `0.0.0.0` or another address | Listens there |

A tunnel client or reverse proxy on the same machine connects through loopback and needs no `--webhook-host`. A proxy on another host or in another container needs `--webhook-host` and therefore a secret. A tunnel forwards requests from the internet to loopback, so set a secret for tunnels as well.

:::caution
Use HTTPS on the public side. A bearer secret sent over plain HTTP can be read in transit.
:::

## Examples

Minimal: webhook server for a single page, events delivered by a webhook you created yourself.

```bash
atlcli wiki docs sync ./docs --page-id 12345 --webhook-port 8080
```

Realistic: a space synced by webhooks only, authenticated, registered on start, with JSON output for a log collector.

```bash
export ATLCLI_WEBHOOK_SECRET="<secret>"
atlcli wiki docs sync ./docs --space DEV \
  --webhook-port 8080 \
  --webhook-url https://sync.example.com/webhook \
  --no-poll --json
```

## Troubleshooting

### No events arrive

**Symptom**: Remote edits only appear after the poll interval.

**Causes**: The public URL does not reach the daemon's port, the path is not `/webhook`, the registration failed, or the sender connects from another host while the daemon listens on loopback.

**Fix**: Request `GET /health` through the public URL. Check the daemon output for `Webhook registered with Confluence` or `Failed to register webhook`. If the proxy runs on another host, set a secret and `--webhook-host`.

### Events are answered with `401`

**Cause**: A secret is set and the request carries neither a matching `X-Hub-Signature` nor `Authorization: Bearer <secret>`.

**Fix**: Configure the same secret on the sender. For a signature, the HMAC must cover the exact bytes of the body.

### Events arrive but nothing is pulled

**Symptom**: The daemon prints `Webhook ignored: page <id> is outside the sync scope`.

**Cause**: Confluence places the page outside the sync scope.

**Fix**: Start the daemon with the scope (`--space`, `--ancestor` or `--page-id`) that contains the page.

### `--webhook-host ... needs a webhook secret`

**Cause**: The server was asked to bind a non-loopback address without a secret.

**Fix**: Set `ATLCLI_WEBHOOK_SECRET`, or drop `--webhook-host` and reach the daemon through loopback.

### `Invalid --webhook-port`

**Cause**: The value is not an integer between 1 and 65535.

## Related topics

- [Sync](sync.md) - the daemon and its options
- [Jira webhooks](../jira/webhooks.md) - `atlcli jira webhook`
