# Epics

Manage epics and their child issues.

## List Epics

```bash
atlcli jira epic list --project PROJ
```

## Get Epic

```bash
atlcli jira epic get PROJ-100
```

## Create Epic

```bash
atlcli jira epic create --project PROJ --name "User Authentication" --summary "Implement login system"
```

## Epic Issues

List issues in an epic:

```bash
atlcli jira epic issues PROJ-100
```

## Add to Epic

```bash
atlcli jira epic add PROJ-100 --issues PROJ-101,PROJ-102,PROJ-103
```

## Remove from Epic

```bash
atlcli jira epic remove PROJ-100 --issues PROJ-101
```

## Move Issues Between Epics

```bash
atlcli jira epic move --from PROJ-100 --to PROJ-200 --issues PROJ-101,PROJ-102
```

## Epic Progress

View completion status:

```bash
atlcli jira epic progress PROJ-100
```

Output includes total issues, completed, in progress, and percentage complete.
