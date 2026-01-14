# Templates

Create pages from reusable templates with variable substitution.

## Using Templates

```bash
atlcli docs create --template meeting-notes --space TEAM --title "Team Meeting 2025-01-14"
```

## Template Variables

Templates support Handlebars-style variables:

```markdown
---
template: true
name: meeting-notes
---

# {{title}}

**Date:** {{date}}
**Attendees:** {{attendees}}

## Agenda

1.

## Notes

## Action Items

- [ ]
```

## Managing Templates

```bash
# List templates
atlcli docs template list

# Save a page as template
atlcli docs template save --page 12345 --name my-template

# Delete template
atlcli docs template delete my-template
```
