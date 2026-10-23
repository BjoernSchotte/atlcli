# Sprint metrics as of the sprint (snapshot from the changelog)

Status: implemented · 2026-10-22

Decisions (user): changelog replay as the only source; all sprint metrics switch over; committed means in the sprint at the exact start time (no grace period, like Jira).

## Problem

`calculateSprintMetrics` computes sprint metrics from the issues' **current** state. It feeds the sprint report, velocity, predictability, the sprint review and the version notes.

| Metric | Today | Correct |
|---|---|---|
| Committed | points of the issues in the sprint *now*, at their *current* estimate | points of the issues in the sprint at the **start**, at their estimate then |
| Completed | the *current* status is done | the status at the **end** (`completeDate ?? endDate`) is done (under `flow.statusMap`) |
| Added / removed | always 0: `parseSprintIds` looks for `id=123` in `fromString`, but Cloud puts the sprint names there and the ids in `from` | membership changes between start and end |

Effects:
- Predictability for old sprints is almost always 100 %, because almost everything is done by now.
- Velocity counts work finished after the sprint (TCW 910: 12 points).
- Scope change is always 0 (live TCW 910 / 844: Jira says 1 / 4 issues added).

## Live reference (Jira's own sprint report, `greenhopper/1.0/rapid/charts/sprintreport`)

| Sprint | Completed | Not completed | Completed in another sprint | Added | Completed / all points |
|---|---|---|---|---|---|
| TCW 910 | 5 | 8 | 1 | 1 | 14 / 52 |
| TCW 844 | 11 | 2 | 0 | 4 | 32 / 40 |
| MFA 1208 | 1 | 7 | 0 | 1 | – |

Jira counts only the **Done category**: "Fertig" (In Progress) is not done there. These numbers therefore check membership and points, not completion.

## Approach (recommended): replay the changelog

A new pure function `sprintSnapshot(sprint, issuesWithChangelog, pointsField, resolve)` in `analysis.ts`:

1. Per issue, replay the changelog **backwards** from the current state, to `start` and to `end`.
   - Sprint membership comes from the `Sprint` item; its `from`/`to` hold the ids.
   - The estimate comes from the points field: match on `fieldId`, with the field name as a fallback.
   - The status comes from the `status` item.
2. Committed = Σ points at start, for the issues in the sprint at the exact start time.
3. Completed = the issues in the sprint at the end whose status at the end resolves to done; Σ their points at the end.
4. Added = joined after the start; removed = left before the end.
5. The sprint is still active → end = now.

`calculateSprintMetrics` uses the snapshot whenever changelogs are present. Every CLI caller already loads them in bulk (`getChangelogs`) except velocity, predictability and the review. They load them too: one bulk request per 1000 issues.

`parseSprintIds` reads `from`/`to` (ids). The burndown keeps its own logic, but uses the same membership.

**Limitation (resolved 2026-10-23):** an issue removed from the sprint before it closed no longer appears in `sprint/{id}/issue`. JQL `sprint WAS` is not supported (400). `loadSprintHistory` now adds the keys from Jira's own sprint report (`greenhopper/1.0/rapid/charts/sprintreport`, `puntedIssues`), best effort. Added and removed follow Jira: added = joined after the start (also if removed again), removed = in the sprint at some point and out at the end. Live: TCW 811 shows 2 added / 2 removed (TCW-201, TCW-202), as Jira does.

## Alternative: Jira's sprint report endpoint

- **Pro:** exact membership, punted issues, estimates as of the sprint.
- **Contra:**
  - The API is internal and undocumented.
  - It ignores `flow.statusMap`, so completion would be wrong for TCW, MFA and PAN.
  - The DC/Cloud differences are untested.
- **Possible as a hybrid:** membership from greenhopper, status from the changelog. That is two sources and more complexity, so not recommended.

## Tests

- Pure tests for `sprintSnapshot`:
  - an issue finished after the end → not completed;
  - an estimate changed during the sprint → committed at the old value;
  - an issue added after the start → added, not committed;
  - an issue moved out → removed;
  - "Fertig" under a status map;
  - an active sprint.
- Regression: scope change ≠ 0 with Cloud `from`/`to` ids.
- Live: TCW 910/844 and MFA 1208, against the table above (membership and points); TCW 910 completed under the status map.

## Docs

`jira/analytics.md`:
- a new section "As of the sprint", which says what committed, completed and added mean;
- the limitation on removed issues.

`jira/report-pages.md`: one line.

## Outcome

Implemented as `issueAt` / `sprintIssueAt` in `analysis.ts`. Two rules were added after the live comparison with Jira's sprint report:
- **Sub-tasks** never count (TCW 910 listed two).
- **Issues done before the start** count for nothing (TCW-63, "completed outside this sprint").

With both rules, the numbers match Jira's sprint report for TCW 910/877/844/811, MFA 1240 and PAN 598 (board 278): done, not done, and completed points.
