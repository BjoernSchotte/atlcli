# Troubleshooting

Common issues and solutions for atlcli.

::: toc

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
Error: Unable to verify certificate
```

**Solutions:**
1. Update system certificates
2. Check for corporate proxy/firewall

## Confluence Issues

### Sync Conflicts

```
Conflict: file.md was modified both locally and on Confluence
```

**Solutions:**
1. Pull latest changes: `atlcli wiki docs pull`
2. Merge manually
3. Force push: `atlcli wiki docs push --force`

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
