---
title: "Export Jobs & Operations"
description: "Operate, monitor, recover, and troubleshoot durable DOCX and PDF exports"
---

# Export Jobs & Operations

DOCX and PDF share one durable lifecycle, queue policy, Activity model, and
resource budget. Their engines, prepared inputs, reports, and output validation
remain format-specific.

## On this page

- [Lifecycle](#lifecycle)
- [CLI operation](#cli-operation)
- [Browser extension operation](#browser-extension-operation)
- [Recovery and retries](#recovery-and-retries)
- [Buffering and resource limits](#buffering-and-resource-limits)
- [Retention and cleanup](#retention-and-cleanup)
- [Privacy and storage](#privacy-and-storage)
- [Incident procedure](#incident-procedure)
- [Known limits](#known-limits)
- [Related topics](#related-topics)

## Lifecycle

The host commits an unresolved request before its first Confluence/source read.
The durable row then moves through these states:

| State | Meaning | Typical action |
|-------|---------|----------------|
| `queued` | Eligible but not claimed | Wait or cancel |
| `running` | A runner owns a fenced lease | Monitor or cancel |
| `waiting` | Blocked on auth, backoff, quota, resource, or host | Fix the named blocker; resume when offered |
| `cancelling` | Cancellation requested; runner is unwinding | Wait |
| `succeeded` | Artifact and bounded report committed | Download/reveal or Run again |
| `failed` | Terminal classified failure | Inspect protocol; Retry |
| `interrupted` | Runner was lost and safe automatic recovery ended | Retry |
| `cancelled` | Terminal user/system cancellation | Retry if still wanted |

A terminal row never returns to `running`. **Retry** creates a linked job from a
failed, interrupted, or cancelled row. **Run again** creates a linked job from a
successful row. The original record stays immutable history.

## CLI operation

An ordinary CLI export is still foreground. The process submits and claims its
job, prints the job id and stages, writes the artifact atomically, then emits
the normal report. Another process can observe or cancel it:

```bash
atlcli wiki export jobs list --status running,waiting --format pdf --since 12h
atlcli wiki export jobs show <job-id>
atlcli wiki export jobs watch <job-id>
atlcli wiki export jobs cancel <job-id>
atlcli wiki export jobs resume <queued-id>
```

Use `--json` on list/show/actions and `--jsonl` on watch for automation. `show`
acknowledges terminal work; `list` and `watch` do not. There is intentionally no
CLI daemon and no `--detach` mode: if the exporting process exits, another
command reconciles its stale lease to a safe queued checkpoint or to terminal
`interrupted`. Use `jobs resume <queued-id>` to reclaim the same safe checkpoint
in an explicit foreground runner. Resume does not create a new history row.

Replay and cleanup:

```bash
atlcli wiki export jobs retry <failed-id> --output ./retry.docx
atlcli wiki export jobs rerun <succeeded-id> --output ./copy.pdf
atlcli wiki export jobs clear --before 30d --confirm
```

Use a new output path, or `--force` only when replacing an existing regular file
is intentional. Cleanup is confirmation-gated and never deletes active work or
an undelivered successful artifact.

## Browser extension operation

The extension executes the full source, asset, DOCX/PDF render, validation, and
artifact pipeline outside the side panel. Leaving the tab or closing the panel
does not stop it.

**Activity** can filter current/all sites, DOCX/PDF, state group, and time.
Rows and details expose safe progress, statistics, report issues, and bounded
events. Available actions are derived from state: Cancel, Retry, Run again,
Resume after sign-in, Download, Mark as read, and Dismiss.

The toolbar badge is a compact durable projection:

| Condition | Badge |
|-----------|-------|
| One or more unfinished jobs | Count, capped at `9+` |
| No active job; unread failure/interruption | `!` |
| No active/failure; unread success | `✓` |
| Nothing active or unread | Empty |

Opening Activity alone does not clear the badge. Viewing the relevant detail,
downloading it, or selecting **Mark as read** acknowledges the terminal job.
The short completion/failure color pulse is optional and best-effort; turn it
off in Activity without losing the static status.

## Recovery and retries

Source pages are normalized and committed in deterministic order. Assets are
stored by SHA-256 with bounded reference checkpoints. A replacement runner
validates request identity, lease epoch, checkpoint chain, order, and hashes
before it reuses any bytes.

- Service-worker loss does not interrupt an offscreen-owned job.
- Offscreen-document loss reclaims an expired lease and continues at the first
  uncommitted source/asset slot.
- Quitting Chrome pauses local execution. On the next start, the extension
  reclaims queued or stale leased work from durable state.
- Expired browser auth becomes `waiting/auth`; sign in to the recorded site and
  use **Resume after sign-in**. CLI authentication errors require a valid
  profile before an explicit foreground Retry.
- HTTP 429 and transient network/5xx failures use bounded automatic backoff.
  Permanent or exhausted failures become terminal and offer Retry.

Retry and Run again copy only replay-safe references. They never copy tokens,
cookies, source bodies, signed URLs, or old artifact bytes into metadata.

## Buffering and resource limits

Large spaces are not held as one unbounded in-memory value:

- at most 4 page/source fetches per site;
- at most 8 normalized page results ready but not committed;
- at most 6 asset fetches, additionally limited by a shared 50 MiB in-flight
  byte reservation;
- 25 MiB per asset and 50 MiB aggregate export asset budget;
- one diagram/raster task and one global heavy DOCX/PDF render slot;
- one extension export runner in the first delivery.

Current extension persistence/output caps:

| Resource | Limit |
|----------|------:|
| One persisted spool object | 128 MiB |
| One job's persisted spool | 256 MiB |
| Common spool across jobs | 512 MiB |
| Final DOCX or PDF artifact | 64 MiB |

Chrome origin quota may be smaller. Admission checks combine these product caps
with `navigator.storage.estimate()` when available. A job waits or fails with a
named shortfall instead of beginning a heavy render without capacity.

These values are product bounds, not promises about peak process memory. Both
engines still need a complete final archive/compiler input during their heavy
phase; the global slot prevents their peaks from overlapping.

## Retention and cleanup

Retention is shared by the CLI file journal and extension IndexedDB runtime:

| Payload | Policy |
|---------|--------|
| Successful artifact not yet delivered | Protected regardless of age/count |
| Artifact after delivery or dismissal | At least 24 hours after its last delivery/dismissal |
| Full report and bounded event protocol | 7 days after completion |
| Compact history | Intersection of newest 100 jobs and jobs younger than 30 days |
| Replay-safe request/template pins | Kept with retained history so replay remains possible |

**Dismiss** hides terminal history from the default Activity view; it is not
immediate deletion. **Mark as read** only acknowledges. Physical deletion uses
a durable tombstone and restart-safe cleanup so crashes cannot leave a deleted
row pointing at live payload, or a live row pointing at deleted payload.

## Privacy and storage

CLI job state defaults to `~/.atlcli/export-jobs/v1`; use
`ATLCLI_EXPORT_JOBS_DIR` only for managed hosts or isolated tests. Directories
use private modes. Extension state stays in the extension origin's IndexedDB.

Metadata, events, and logs may contain ids, site origin, display/source labels,
format, stages, counters, sizes, timings, bounded error codes, and opaque
references. They must not contain credentials, cookies, tokens, source bodies,
signed URLs, template bytes, spool bytes, artifacts, or full raw reports.

The extension contacts only the active permitted Atlassian tenant and approved
Atlassian attachment redirects. DOCX rendering and Typst/WASM PDF compilation
are local; the deprecated Python export engine is not used.

## Incident procedure

1. Identify the row without changing it:

   ```bash
   atlcli wiki export jobs list --status running,waiting,failed,interrupted
   atlcli wiki export jobs show <job-id> --json
   ```

2. Record job id, format, state, stage, waiting/failure code, attempt/recovery
   count, last event sequence, output size, and quota/spool statistics. Do not
   attach credentials or source bodies.
3. For extension incidents, keep Chrome open, open **Activity**, enable **All
   sites** if necessary, and inspect the detail protocol. Check
   `chrome://extensions` only when service-worker diagnostics are needed.
4. Resolve authentication/quota/host blockers before replaying. Let automatic
   backoff finish; do not create duplicates for the same transient failure.
5. Use Retry only for failed/interrupted/cancelled work, or Run again for a
   successful artifact that must be regenerated.

## Known limits

- No work executes while Chrome is fully closed; durable work resumes when
  Chrome starts.
- The CLI has no detached runner or daemon.
- Browser Data Center access is not in the current manifest; use the CLI.
- Future Forge support is an unproven browser-only PoC. Lifecycle, WASM support,
  quota, pricing, and whether it can avoid developer-operated infrastructure
  remain open; the Chrome behavior is not a Forge promise.
- Legacy export state remains readable for its migration window. Its cleanup is
  deferred until one release has shipped with the common runtime.

## Related topics

- [DOCX and PDF Export](/confluence/export/)
- [Exporting from the panel](/extension/export/)
- [Browser extension](/extension/)
- [Troubleshooting](/reference/troubleshooting/)
- [Export Performance Envelope](/reference/export-performance/)
