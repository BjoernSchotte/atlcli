# T0 evidence: API verification (2026-10-22, Jira/Confluence Cloud, profile `mayflower`)

Measured with throwaway scripts against the live site; no bodies or tenant URLs are kept here.

| Question | Finding | Consequence |
|---|---|---|
| `POST /rest/api/3/changelog/bulkfetch` | Exists. Body `{ issueIdsOrKeys, fieldIds?, maxResults, nextPageToken? }`. Response `{ issueChangeLogs: [{ issueId, changeHistories }], nextPageToken? }`. `maxResults: 10000` is accepted. | `JiraClient.getChangelogs()` follows `nextPageToken` per chunk. |
| Issues per bulkfetch call | 1001 keys → HTTP 400 ("höchstens 1.000 Vorgänge"). | Chunks of 1000. |
| Order and timestamp format | `changeHistories` arrive **newest first**; `created` is **epoch milliseconds** (a number), not an ISO string. | The client converts to ISO and sorts ascending. |
| `fieldIds: ["status"]` | Filters to status items. Items carry `fieldId`; `fromString`/`toString` can be absent on some item kinds. | Flow reads `fieldId ?? field`; the digest reads `fromString`/`toString` as own properties (the first live E2E run crashed on a missing `toString`). |
| `GET /issue/{key}?expand=changelog` order | Also **newest first** (`2026-10-21…`, then `2026-01-17…`). | `findCompletionDate` (burndown), which takes the last status entry, picked the oldest one. Fixed by attaching ascending changelogs. |
| Embedded changelog cap | Not reproducible on ATLCLI (largest history 9 entries). Atlassian documents ~100. | Data Center fallback stays "best effort" (decision 8). |
| `getSprintIssues` page cap | `maxResults=500` is echoed back as 500; sprints of 25–45 issues return complete. | No pagination added; 200 stays the request size. |
| `mention = currentUser()`, `watcher = currentUser()` | Both valid CQL; `watcher` returned pages. | Used as specified. |
| `type = comment AND created >= now("-Nm")` with `container,extensions.resolution` | Works; `content.container.id`, `history.createdBy.{accountId,displayName}` and `extensions.resolution.status` (`open`) are present. | Comment fields parsed from v1 search. |
| Container-scoped comment CQL | `type = comment AND container = <pageId>` and `container IN (a, b)` work; `ancestor = <pageId>` does not match comments. | The digest queries comments with `container IN (<your 50 latest pages>)` instead of a site-wide comment query filtered client-side. |
| `/content/{id}/child/comment?location=inline&depth=all&expand=history,extensions.resolution` | Returns `extensions.resolution.status` and `history.createdBy.displayName`. | `ConfluenceClient.listPageCommentsV1()`. |
| Board filter | `GET /rest/agile/1.0/board/{id}/configuration` → `filter.id`; `GET /rest/api/3/filter/{id}` → `jql` ending in `ORDER BY Rank ASC`. Simple (team-managed) boards have no sprints (400). | `getBoardFilterJql()` + `stripOrderBy()`. |
