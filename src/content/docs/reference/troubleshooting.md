---
title: "Troubleshooting"
description: "Troubleshooting - atlcli documentation"
---

# Troubleshooting

Common issues and solutions for atlcli.

## On this page

- [Authentication errors](#authentication-errors)
- [Connection errors](#connection-errors)
- [Confluence issues](#confluence-issues)
- [Export jobs](#export-jobs)
- [Jira issues](#jira-issues)
- [Performance](#performance)
- [Debug mode](#debug-mode)
- [Getting help](#getting-help)

## Authentication Errors

### 401 Unauthorized

```
Error: Authentication failed (401)
```

**Causes:**
- Invalid or expired API token
- Wrong email address
- Incorrect instance URL

**Solutions:**
1. Regenerate API token at [Atlassian Account](https://id.atlassian.com/manage-profile/security/api-tokens)
2. Verify email matches your Atlassian account
3. Check URL includes `https://`

```bash
atlcli auth init  # Re-initialize credentials
```

### 403 Forbidden

```
Error: You don't have permission (403)
```

**Causes:**
- Account lacks required permissions
- Project/space access restricted

**Solutions:**
1. Verify account has access to the project/space
2. Contact your Atlassian admin for permissions

## Connection Errors

### Network Timeout

```
Error: Request timeout
```

**Solutions:**
1. Check internet connection
2. Verify Atlassian status at [status.atlassian.com](https://status.atlassian.com)
3. Try again with `--verbose` for details

### SSL Certificate Error

```
Error: self signed certificate in certificate chain
Error: unable to verify the first certificate
Error: Unable to verify certificate
```

**Causes:**
- On-premises Jira/Confluence Data Center using a self-signed certificate
- Instance certificate issued by an internal / enterprise Certificate Authority not in the system trust store
- Corporate TLS-intercepting proxy

**Solutions:**

1. **Point atlcli at your internal CA** (recommended). Re-run login with `--ca-file`:
   ```bash
   atlcli auth login --bearer --site https://jira.company.internal \
     --token YOUR_PAT --ca-file /etc/ssl/certs/company-ca.pem
   ```
   The CA file path is persisted on the profile and used for every subsequent request. See [TLS and Self-Signed Certificates](/authentication/#tls-and-self-signed-certificates).

2. **Install the CA into your system trust store** (alternative) — appropriate when many tools on the machine need it, not just atlcli.

3. **Check for a corporate TLS-intercepting proxy** — if traffic is being MITM'd by a proxy, you'll need its root CA from your IT team.

4. **Last resort: skip verification with `--insecure`** — only appropriate for disposable test instances. **Never use in production**, as it disables protection against MITM attacks:
   ```bash
   atlcli auth login --bearer --site https://jira.test.local --token YOUR_PAT --insecure
   ```

## Confluence Issues

### Sync Conflicts

```
Conflict: file.md was modified both locally and on Confluence
```

**Solutions:**
1. Pull latest changes: `atlcli wiki docs pull`
2. Merge manually
3. Force push: `atlcli wiki docs push --force`

### Duplicate `-2.md` Files After Pulling

A page you pull repeatedly shows up twice: `page.md` **and** `page-2.md`, each with the
same `id` in its frontmatter, plus a second `page-2.attachments/` directory.

**Cause:**
Older versions recorded a uniquified filename in `.atlcli/sync.db` for pages that had
not moved, so the next `pull` treated that alias as the page's location.

**Solutions:**
1. Upgrade and pull again — `atlcli wiki docs pull` re-adopts the original file and
   corrects the recorded path, as long as only one of the two files exists.
2. If both files are already on disk, delete the `-2` copy (and its
   `-2.attachments/` directory) after checking it holds no edits of yours, then pull
   again:
   ```bash
   atlcli wiki docs diff page-2.md   # confirm there is nothing to keep
   rm -r page-2.md page-2.attachments
   atlcli wiki docs pull
   ```

Note that a genuine `-2` suffix is also how atlcli keeps two *different* pages with the
same title apart — check the `id` in the frontmatter before deleting anything.

### Page Not Found

```
Error: Page not found (404)
```

**Causes:**
- Page was deleted on Confluence
- Page ID changed

**Solutions:**
1. Re-pull directory: `atlcli wiki docs pull`
2. Remove stale local file

## Export Jobs

### An extension export stopped after Chrome quit

The extension queue is local to Chrome. It continues across tab changes, panel
closure, service-worker suspension, and offscreen-document restart, but no code
runs while Chrome itself is closed. Start Chrome again: queued or checkpointed
work is reclaimed automatically. If the Confluence session expired, sign in to
the same site and select **Resume after sign-in** in **Activity**.

### A CLI export appears stuck or its terminal disappeared

Open another terminal and inspect the durable job:

```bash
atlcli wiki export jobs list --status running,waiting
atlcli wiki export jobs show <job-id>
atlcli wiki export jobs watch <job-id>
```

The ordinary CLI command is the runner; there is no detached daemon. If that
process ended, a stale lease is reconciled the next time an export-jobs command
opens the journal. Use `retry` for a resulting interrupted/failed job. If a
recoverable checkpoint was returned to `queued` without an owner, cancel that
row first and then retry it as an explicit foreground job.

### A job is waiting

Open its detail or run `jobs show`. The waiting reason distinguishes:

- `auth`: in the extension, sign in and choose **Resume after sign-in**; for the
  CLI, refresh the profile before an explicit foreground Retry;
- `backoff`: a bounded automatic retry is waiting for its deadline;
- `quota` or `resource`: free browser/disk space or narrow the export;
- `host`: the local browser runner is not currently available.

Do not repeatedly create new jobs for an automatic backoff. The existing row
retains its queue position and protocol.

### An export exceeds storage or memory limits

Narrow the tree with `--max-depth`, labels, or a smaller scope; downscale large
attachments; then retry. The browser checks product caps and origin quota before
heavy rendering. It fails closed rather than leaving a partial download.
Current browser caps are 128 MiB per spool object, 256 MiB spool per job,
512 MiB common spool total, and 64 MiB for the final DOCX/PDF artifact.

### A finished result is no longer downloadable

Succeeded-undelivered artifacts are protected. After download or dismissal,
artifact bytes are eligible for release after 24 hours. Full reports remain for
7 days; compact history may remain without the artifact. Use **Run again** in
the extension or `jobs rerun` in the CLI to create a new linked export.

See [Export Jobs & Operations](/reference/export-jobs/) for the complete
lifecycle and diagnostic procedure.

## Jira Issues

### Invalid JQL

```
Error: Invalid JQL query
```

**Solutions:**
1. Check JQL syntax
2. Verify field names exist
3. Quote values with spaces

```bash
# Correct
atlcli jira search --jql "status = 'In Progress'"

# Wrong
atlcli jira search --jql "status = In Progress"
```

### Issue Type Not Found

```
Error: Issue type 'Bug' not found in project
```

**Solutions:**
1. List available types: `atlcli jira field list --type issuetype`
2. Use correct type name for your project

### Field Not Editable

```
Error: Field 'status' cannot be set directly
```

**Solutions:**
- Use transitions for status changes
- Some fields are read-only

```bash
atlcli jira issue transition --key PROJ-123 --to "Done"
```

## Performance

### Slow Commands

**Solutions:**
1. Use `--limit` to reduce results
2. Use more specific JQL
3. Check network latency

### High Memory Usage

**Solutions:**
1. Process results in batches
2. Use `--json` and pipe to `jq` for large datasets

## Debug Mode

Enable verbose output:

```bash
ATLCLI_LOG_LEVEL=debug atlcli jira search --assignee me
```

## Getting Help

1. Check this documentation
2. Search [GitHub Issues](https://github.com/BjoernSchotte/atlcli/issues)
3. Open a new issue with:
   - atlcli version
   - Command that failed
   - Full error message
   - Steps to reproduce

## Related Topics

- [Doctor](doctor.md) - Automated health checks
- [Logging](logging.md) - Debug with logs
- [Authentication](../authentication.md) - Profile setup
