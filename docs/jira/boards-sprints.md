# Boards & Sprints

Manage Scrum and Kanban boards, sprints, and backlogs.

## Boards

### List Boards

```bash
atlcli jira board list
```

### Get Board

```bash
atlcli jira board get 123
```

### Board Issues

```bash
atlcli jira board issues 123
```

## Sprints

### List Sprints

```bash
atlcli jira sprint list --board 123
```

### Get Sprint

```bash
atlcli jira sprint get 456
```

### Sprint Issues

```bash
atlcli jira sprint issues 456
```

### Create Sprint

```bash
atlcli jira sprint create --board 123 --name "Sprint 10" --start "2025-01-20" --end "2025-02-03"
```

### Start Sprint

```bash
atlcli jira sprint start 456
```

### Complete Sprint

```bash
atlcli jira sprint complete 456 --move-to 789
```

## Backlog

### View Backlog

```bash
atlcli jira backlog --board 123
```

### Move to Sprint

```bash
atlcli jira sprint add 456 --issues PROJ-1,PROJ-2,PROJ-3
```

### Move to Backlog

```bash
atlcli jira backlog add --board 123 --issues PROJ-1,PROJ-2
```

### Rank Issues

```bash
atlcli jira rank PROJ-1 --before PROJ-2
atlcli jira rank PROJ-1 --after PROJ-3
```
