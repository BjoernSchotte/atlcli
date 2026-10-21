---
title: "Meeting Notes to Jira"
description: "Turn action items in Confluence meeting notes into Jira issues and keep them in sync"
---

# Meeting Notes to Jira

Action items written in a meeting become Jira issues in one command, and the notes show which items are done.

## Prerequisites

- Authenticated profile with Confluence and Jira access (`atlcli auth login`)
- **Jira permission**: Create Issues in the target project
- **Confluence permission**: Edit on the meeting notes page

## Steps

1. Write the action items as tasks. Mention the owner and add a due date:

   ```markdown
   ## Action items

   - [ ] Draft the release plan @[Jane Doe](557058:abc123) {date:2026-12-15}
   - [ ] Review the export docs
   - [x] Book the room
   ```

   In the Confluence editor this is an action item list with `@mention` and a date.

2. Preview what would be created:

   ```bash
   atlcli wiki page tasks-to-issues --id 12345 --project PROJ
   ```

   Ticked tasks are skipped unless you add `--include-done`.

3. Create the issues:

   ```bash
   atlcli wiki page tasks-to-issues --id 12345 --project PROJ --label meeting --confirm
   ```

   Each task now starts with a link to its issue, and each issue links back to the page.

4. Later, tick the tasks whose issues are done:

   ```bash
   atlcli wiki page tasks-to-issues --id 12345 --sync --confirm
   ```

## Examples

Minimal:

```bash
atlcli wiki page tasks-to-issues --id 12345 --project PROJ --confirm
```

Recurring meeting, issues under an epic, run every morning from cron:

```bash
# crontab: 0 8 * * 1-5
atlcli wiki page tasks-to-issues --id 12345 --project PROJ \
  --type Story --parent PROJ-100 --label weekly-sync \
  --sync --confirm --json >> ~/logs/meeting-tasks.jsonl
```

All meeting pages with a label, using `jq`:

```bash
atlcli wiki search --cql 'label = "meeting-notes" AND lastmodified >= now("-7d")' --json \
  | jq -r '.results[].id' \
  | xargs -I{} atlcli wiki page tasks-to-issues --id {} --project PROJ --confirm
```

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| Nothing is created on the second run | Expected: converted tasks link to their issue | — |
| A task you edited heavily gets a second issue | The task had no link yet and its text no longer matches the recorded one | Delete the duplicate; keep the issue link in the task |
| `--sync` reports `report:ticked-but-open` | Someone ticked the task while the issue is open | Close the issue or untick the task |

## Related Topics

- [Pages: Turn Task Items into Jira Issues](../confluence/pages.md#turn-task-items-into-jira-issues)
- [Jira Issues](../jira/issues.md)
- [Sprint Reporting](sprint-reporting.md)
