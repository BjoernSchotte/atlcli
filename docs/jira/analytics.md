# Analytics

Sprint velocity, burndown, and predictability metrics.

## Velocity

View story points completed per sprint:

```bash
atlcli jira analytics velocity --board 123
```

Options:

| Flag | Description |
|------|-------------|
| `--sprints` | Number of sprints (default: 5) |
| `--field` | Story points field |

## Burndown

Sprint burndown chart data:

```bash
atlcli jira analytics burndown --sprint 456
```

Returns daily remaining work for charting.

## Burnup

Cumulative flow:

```bash
atlcli jira analytics burnup --sprint 456
```

## Predictability

Team predictability metrics:

```bash
atlcli jira analytics predictability --board 123
```

Metrics include:

- **Commitment accuracy** - Planned vs completed
- **Velocity variance** - Standard deviation across sprints
- **Completion rate** - Percentage of committed work done

## Cycle Time

Average time from start to done:

```bash
atlcli jira analytics cycle-time --project PROJ --from 2025-01-01
```

## Lead Time

Time from creation to completion:

```bash
atlcli jira analytics lead-time --project PROJ --from 2025-01-01
```
