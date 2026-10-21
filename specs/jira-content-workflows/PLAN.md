# Bundle A: Jira content & Jira↔Confluence workflows

- Status: **Planned**, questions decided (2026-10-21)
- Directory: `specs/jira-content-workflows`
- Planning baseline: `main` @ a6d4d51b (record the commit SHA here when work starts)
- Scope: A1 Jira Markdown↔ADF + Jira content CLI gaps; A2 meeting-note tasks → Jira issues; A3 release notes / sprint review pages. Also fixes Jira doc drift.

## Decisions (2026-10-21)

These answer the original open questions and override the body where they conflict.

| # | Question | Decision |
|---|---|---|
| 1 | A2 command name | `atlcli wiki page tasks-to-issues`. No alias. |
| 2 | `--description` as markdown | Markdown by default, immediately. CHANGELOG entry under "Changed". |
| 3 | Data Center | **Cloud first, DC best effort.** New features are specified and E2E-tested on Cloud. DC gets the documented fallbacks (markdown string to API v2, body-marker-only idempotency for A2, no assignee). The DC `/search/jql` problem becomes a separate issue, not part of this bundle. |
| 4 | Runtime ADF validation | Tests only, plus an opt-in strict path (`ATLCLI_STRICT_ADF=1`). A validator false positive must never block a write. |
| 5 | Sentinel format | `<!--adf:BASE64URL(JSON)-->`. |
| 6 | `issue unlink --confirm` | Required only when the link was resolved by key pair. |
| 7 | Release-notes grouping | Default by type, switchable to epic. Several bundled templates; see A3 "Templates". Contributors are assignees only (no per-issue changelog calls). |
| 8 | Two-way task sync | **In this bundle.** See A2 "Status sync". |
| 9 | `bulk move` doc drift | **Implement** `jira bulk move`. See A1 "bulk move". |
| 10 | DC search | Separate issue (see 3). |

### Implementation notes (deviations found while building)

- A1a: no `markdown-it-task-lists` dependency. Task lists are detected from `[ ]`/`[x]` list items in the token walker; only `markdown-it` was added.
- A1b: `jira my --all` already means "include resolved", so the uncapped search flag is `--all-results` (both `search` and `my`).
- A1b: `JiraClient` honours an explicit `profile.deploymentType` (custom-domain Cloud); without it the `*.atlassian.net` heuristic stays.
- A1b: core `parseArgs` now treats a lone `-` after a long flag as its value, so `--description-file -` reads stdin.
- A1b: fixed `bulk edit --set` reading only the first `--set` and splitting `labels=a,b` at the comma.
- A2: tasks are addressed by document position and text fingerprint, not `<ac:task-id>`: atlcli's markdown push numbers ids per list, so ids repeat on one page. The ledger is keyed by issue key (`{v:1, issues:{KEY:{fingerprint, createdAt, tickedBySync}}}`); `tickedBySync` is what lets `--sync` untick only the tasks it ticked.
- A2: the page marker is an inline smart link to `/browse/KEY` instead of a Jira macro (a macro without `serverId` may not render on Cloud). `docs pull` turns it into a plain link; both forms count as linked.
- A3: the identity property stores a hash of the generated **storage**, not the markdown, so converter fixes also count as changes.
- A3: `sprint review` shows no scope change (it needs one changelog request per issue); add it after digest-flow-metrics T1 (bulk changelogs).
- A3: found and fixed a Confluence converter bug: a line starting with a smart link (`[KEY](url) text`) became a raw HTML block, so the rest of the line skipped inline markdown and escapes leaked onto the page.
- A3: `sprint review` was not E2E-tested live: the ATLCLI board is a simple board without sprints. Covered by template/planner tests.

## Summary decision

Ship three features in dependency order. **A1 lands first.** A2 and A3 both write rich Jira and Confluence content and need A1's converter.

1. **A1:** add one browser-safe module, `packages/jira/src/adf-markdown.ts`, with `markdownToAdf()` and `adfToMarkdown()`.
   - It reuses what already exists: ADF types and `validateAdf` from `@atlcli/change-set/adf` (`packages/change-set/src/adf/{types,validate}.ts`), the `markdown-it` + `markdown-it-task-lists` parser stack that `packages/confluence/src/markdown.ts` already uses, and the same atlcli markdown dialect: `@[Name](accountId)`, `{date:…}`, `{status:…}`, `{jira:KEY}`, `:::info` panels.
   - It does **not** route through Confluence storage XML or `adfToBlocks`. `adf-to-blocks.ts` is an export decoder into `ExportBlock` and has no path back to markdown, and `@atlcli/jira` must not depend on `@atlcli/confluence`.
   - The CLI gets `--description-file`, `--body-file`, `issue get --format markdown`, `issue comments list|add|edit|delete`, `issue history`, `issue unlink`, and real `jira search` pagination.
2. **A2:** `atlcli wiki page tasks-to-issues --id <page> --project <KEY>`. It is a dry run unless `--confirm` is passed.
   - It reads the page's storage format, extracts `ac:task` items (assignee from the first mention, due date from `<time>`), and creates issues whose descriptions go through A1.
   - It adds a remote link using the existing `atlcli-confluence-<pageId>` scheme, then prepends a Jira macro to each converted task body.
   - Idempotency rests on two things: a marker in the task body (the durable truth) and a page content property ledger (covers the crash window).
3. **A3:** `atlcli jira version notes <id|name>` and `atlcli jira sprint review <id>`.
   - Both build a pure report data model, render it through the existing `TemplateEngine` (`packages/core/src/templates/engine.ts`) using a user template or a built-in default, and create or update a Confluence page idempotently (page property plus title).
   - `--export <file.pdf|.docx>` optionally chains into `wiki export`.

## Current state and evidence

### Jira rich text
- `packages/jira/src/client.ts:2125` `textToAdf(text)` wraps the whole string in one paragraph. `:2146` `adfToText()` concatenates text nodes and loses all structure, including paragraph breaks.
- Callers that write Jira content:
  - `apps/cli/src/commands/jira.ts:508` (issue create), `:541` (issue update), `:2601` (epic create), `:4904` (subtask create)
  - `client.ts:1196` (`addComment` when given a string), `:1264` / `:1303` (worklog comments)
  - `packages/jira/src/import.ts` passes `description` and comment strings through unchanged
- Caller that reads: `packages/jira/src/export.ts:149` (`adfToText` for comments).
- **Data Center bug:** `client.ts:135` switches to `/rest/api/2` when not on Cloud. API v2 expects wiki-markup **strings**, but every caller above sends an ADF object. Rich text on DC is broken today.
- **Import bug:** CSV/JSON import sends `description` as a plain string to `/rest/api/3`, which rejects it (v3 requires ADF).
- **Link-page comment bug:** `jira.ts:1224`, `jira.ts:3750` and `page.ts:1984` post `Linked to Confluence page: [title|url]`. That is wiki markup inside a plain-text ADF paragraph, so it renders literally.
- `formatIssue()` (`jira.ts:4241`) dumps raw ADF as `description`.

### Existing ADF / markdown machinery
- `@atlcli/change-set/adf`: ADF types, `validateAdf`, `canonicalizeAdfV1`. `@atlcli/jira` already depends on it (`packages/jira/package.json`, `src/types.ts:8`, `src/change-set.ts:16`).
- `packages/confluence/src/adf-to-blocks.ts` turns ADF into `ExportBlock`. It is export-only, has no inverse, and lives in a package Jira must not import.
- `packages/confluence/src/markdown.ts` is the markdown↔storage XHTML converter. It defines the dialect regexes (`MENTION_REGEX :1234`, `DATE_REGEX :1222`, `STATUS_REGEX :1205`, `JIRA_REGEX :1216`, `MACRO_REGEX :141` for `:::info|note|warning|tip|expand`) and the markdown-it setup (`:74`).
- No markdown→ADF or ADF→markdown code exists anywhere in the repo.

### Jira CLI gaps
- Comments: client has `getComments` (`client.ts:1172`) and `addComment`. There is no update/delete client method and no list/edit/delete CLI.
- History: changelog is reached only via `getIssue(…, {expand:"changelog"})` (`jira.ts:1705`), which Jira caps at roughly 100 histories. There is no `/issue/{key}/changelog` method and no CLI.
- Issue links: `deleteIssueLink(linkId)` exists (`client.ts:1387`) but the CLI has no unlink. `JiraIssueFields.issuelinks` is typed (`types.ts:198`).
- Search: `handleSearch` (`jira.ts:4143`) and `handleMy` (`:4198`) call `client.search` once. `--limit` above one API page is silently truncated. `total` falls back to `issues.length` (`client.ts:1125`) because `/search/jql` returns no total. A paginator `fetchAllIssues` already exists at `jira.ts:3271` but hard-codes its fields.

### Confluence tasks, links, templates
- Tasks in storage are `<ac:task-list><ac:task><ac:task-id>…<ac:task-status>…<ac:task-body>…`. `markdownToStorage` renumbers task ids 1..n on every push (`markdown.ts:1153`), so task ids are **not stable** across `docs push`.
- `parseXml` (`packages/confluence/src/export-blocks.ts:308`) is the budgeted storage parser. Its nodes carry no source offsets.
- Mentions in storage are `<ri:user ri:account-id>`. Dates are `<time datetime>`. The Jira macro is `ac:structured-macro ac:name="jira"`.
- Content properties: `getPagePropertyByKey` (Cloud and DC), `upsertPageProperty` (v2, Cloud) at `packages/confluence/src/client.ts:2071` and `:2100`.
- The remote-link payload is copy-pasted three times: `jira.ts:1203`, `jira.ts:3730`, `page.ts:1962`. All use `globalId = atlcli-confluence-<pageId>`.
- Templates: Handlebars `TemplateEngine.render()` accepts arbitrary non-declared variables, including arrays and objects for `{{#each}}`. `TemplateResolver` checks space, then profile, then global (`resolver.ts`). The page-from-template flow is in `page.ts:247-330`. There are **no** built-in or bundled templates.
- Sprint data: `handleSprintReport` (`jira.ts:1666`) with `calculateSprintMetrics` (`packages/jira/src/analysis.ts`). Versions: `getProjectVersions` and `getVersion` (`client.ts:638` and `:647`).

### Doc drift (verified against `src/content/docs/jira/*`)
| Documented | Reality | Decision |
|---|---|---|
| `jira import --map-field "Col=field"` (`import-export.md:59,80`) | not parsed anywhere | **Implement** (CSV header rename, small) |
| `bulk edit\|delete\|move --issues K1,K2` (`bulk-operations.md:28,54,120,139`) | `--jql` only | **Implement** `--issues` for edit/transition/label/delete/link-page via `key in (...)` |
| `bulk move` section | no `move` subcommand | **Implement** `bulk move --sprint <id> \| --backlog`, reusing the sprint add/remove client calls behind `jira sprint add/remove` (`jira.ts:1630`) |
| `bulk edit --confirm` "skip confirmation prompt" | no prompt exists | **Remove** the row |
| `export --fields` (`import-export.md`) | not implemented | **Remove** the row |
| CSV `labels`/`components` "semicolon-separated" | code splits on `,` (`import.ts:84`) | **Fix the doc** to say comma |
| sample dry-run and progress-bar text output | the CLI prints JSON-ish output | **Replace** with real output captured during E2E |

## Goals
- Markdown in, markdown out for Jira descriptions, comments and worklog comments on Cloud, with a documented and tested lossy-case policy.
- Editing a description as markdown and writing it back never silently drops content (attachments, unknown nodes).
- Comment CRUD, issue history, issue unlink, and correct search pagination in the CLI.
- Convert meeting-note task lists into Jira issues safely: preview by default, never duplicate, link both directions.
- Generate release notes and sprint review pages from Jira data through the existing template system, idempotently, with optional PDF/DOCX export.
- Docs match behaviour.

## Non-goals
- Markdown→wiki-markup conversion for Jira DC/Server. DC receives the markdown source as a plain string; this replaces today's broken behaviour.
- Uploading local images referenced in markdown as Jira attachments. `![x](./a.png)` stays a link; this is listed in the lossy table.
- Resolving `@email` or `@displayName` to an accountId. Mentions need an explicit accountId, exactly like the Confluence dialect.
- Auto-linking bare issue keys (`PROJ-1` in prose). Only `{jira:KEY}` and `/browse/KEY` URLs become smart links, to avoid false positives.
- Transitioning Jira issues from Confluence task state. Status sync is one-way, Jira → page (see A2 "Status sync"); a task ticked on the page while its issue is open is only reported.
- A new bundled-template storage level in `@atlcli/core`. Defaults are fallback constants; users override with a same-named template at any existing level.

## Design

### A1 — `packages/jira/src/adf-markdown.ts`

**Public API** (exported via `packages/jira/src/index.browser.ts`, so it reaches both barrels and is covered by `scripts/check-browser-build.ts`):

```ts
export interface MarkdownToAdfOptions { baseUrl?: string }          // for {jira:KEY} → inlineCard URL
export function markdownToAdf(markdown: string, options?: MarkdownToAdfOptions): AdfDocument;
export interface AdfToMarkdownOptions { baseUrl?: string }          // /browse/KEY detection
export function adfToMarkdown(adf: AdfDocument | string | null | undefined, options?: AdfToMarkdownOptions): string;
/** Cloud → ADF, DC → raw markdown string (API v2 takes strings). */
export function toJiraRichText(client: JiraClient, markdown: string): AdfDocument | string;
```

- Add a public read-only getter `JiraClient.isCloudSite` (the field at `client.ts:102` is private today). `toJiraRichText` depends on it.
- `textToAdf` and `adfToText` keep their exact semantics. They are public API in `packages/jira/etc/jira.api.md`. Mark them `@deprecated` in TSDoc and point to the new functions. `addComment(string)` stays plain text; the CLI passes ADF explicitly. No public API is broken.
- Dependencies: add `markdown-it` (^15) and `markdown-it-task-lists` to `packages/jira/package.json`. Both are already installed for confluence and are pure JS and isomorphic, so nothing new is downloaded. Regenerate `packages/jira/etc/jira.api.md` and `jira.closure.md` with `bun scripts/api-report.ts --update`.

**markdown → ADF** (markdown-it token stream walker, no HTML stage):
1. Pre-tokenise dialect inlines with the same regexes as `markdown.ts`. Copy the five regexes rather than import them, to keep the package boundary; add a comment pointing to the source. They map as follows:
   - `@[Name](id)` → `mention{id,text:"@Name"}`
   - `{date:YYYY-MM-DD}` → `date{timestamp: ms UTC}`
   - `{status:color}T{status}` → `status{text,color}`
   - `{jira:KEY}` → `inlineCard{url: baseUrl/browse/KEY}`
2. Block handling: `:::info|note|warning|tip|error|success` → `panel{panelType}` (tip maps to success); `:::expand Title` → `expand{title}`.
3. Token mapping:

| Markdown | ADF |
|---|---|
| headings 1–6 | `heading{level}` |
| paragraphs | `paragraph` |
| `-`/`1.` lists (nested) | `bulletList` / `orderedList{order}` / `listItem` |
| `- [ ]` / `- [x]` | `taskList` / `taskItem{localId,state TODO/DONE}` |
| fenced code (language) | `codeBlock{language}` |
| GFM table | `table` / `tableRow` / `tableHeader` / `tableCell` (each cell holds a `paragraph`) |
| `>` | `blockquote` |
| `---` | `rule` |
| `**` `*` `~~` `` ` `` | marks `strong` / `em` / `strike` / `code` |
| `[t](u)` | `text` + `link{href}` mark |
| bare `/browse/KEY` URL / autolink | `inlineCard{url}` |
| hard break | `hardBreak` |
| `:shortname:` | `emoji{shortName}` |

4. Generate `localId` with `crypto.randomUUID()`, which is available in Bun and browsers.
5. Output is validated with `validateAdf` in tests. At runtime it is validated only in a debug/strict path; this is open question 4.

**ADF → markdown** is a direct recursive tree walk and emits the same dialect, so roundtrips are stable:
- Marks are emitted in canonical nesting order (link outermost, then strong, em, strike, code) so that `md → adf → md` is idempotent after one normalisation pass.
- Tables become GFM. If a cell contains block content that GFM cannot hold (lists, multiple paragraphs), the whole table becomes an opaque sentinel (see the lossy policy).

**Lossy-case policy** (documented in `jira/issues.md` "Markdown support"):

| ADF node | Markdown output | Back to ADF |
|---|---|---|
| `media`, `mediaSingle`, `mediaGroup`, `mediaInline`, `extension*`, `bodiedExtension`, `layoutSection`, `nestedExpand`, complex table, unknown | `<!--adf:BASE64URL(JSON)-->` sentinel (an HTML comment, invisible when rendered) | **lossless**: html_block / html_inline token with an `adf:` prefix is decoded and re-inserted |
| `textColor`, `underline`, `subsup`, `alignment`, `indentation`, `border` marks | text kept, mark dropped | lost (listed in docs) |
| `mention` without text | `@[accountId](accountId)` | lossless |
| `date` | `{date:YYYY-MM-DD}` (UTC) | time of day lost (Jira dates are day-granular) |
| `inlineCard` / `blockCard` / `embedCard` with non-browse URL | `<url>` | becomes `inlineCard` (card or embed appearance lost) |
| local image `![a](./x.png)` (md → adf) | — | stays a link; warning on stderr |
| raw HTML (md → adf) | — | escaped as text; warning |

The rule: **anything we cannot represent is preserved opaquely, never dropped silently.** That is the data-loss guard for `issue get --format markdown` → edit → `issue update --description-file`. `ponytail:` the sentinel is base64 so it is not human-editable; a readable form can come later if users ask.

**CLI surface** (`apps/cli/src/commands/jira.ts`):
- Everywhere `--description` exists (issue create/update, epic create, subtask create; project create stays plain), plus worklog `--comment`:
  - `--description <markdown>` is interpreted as markdown. This is a behaviour change; plain text stays plain except for markdown punctuation. Noted in the changelog.
  - New `--description-file <path|->` (`-` = stdin). Mutually exclusive with `--description`. `fail(USAGE)` if both are given.
  - All of them route through one helper, `readRichTextFlag(flags, name)` → `toJiraRichText(client, md)`.
- `issue get --format json|markdown`. Default json; with `--json` the description is additionally emitted as `descriptionMarkdown`. `--format markdown` prints a YAML front block (key, summary, status, type, assignee, labels) plus the description markdown, suitable for piping into an editor.
- `issue comments <list|add|edit|delete>`, mirroring `wiki page comments` (`page.ts:1019`):
  - `list --key K [--limit n] [--format markdown]` pages through `getComments` with startAt.
  - `add --key K (<text>|--body-file f)`
  - `edit --key K --id C (--body <md>|--body-file f)`
  - `delete --key K --id C --confirm`
  - The existing `issue comment --key K <text>` stays as an alias of `comments add`, now markdown-aware.
  - Client additions: `updateComment(key, id, body)` (PUT `/issue/{key}/comment/{id}`) and `deleteComment(key, id)` (DELETE).
- `issue history --key K [--field status] [--limit n]`. Client addition: `getChangelog(key, {startAt,maxResults})` → GET `/issue/{key}/changelog`, paginated until `isLast`. Output rows: `{id, created, author, field, from, to}`, newest first. `handleSprintReport` keeps `expand=changelog` (not in scope).
- `issue unlink (--link <id> | --from K1 --to K2 [--type name]) [--confirm]`:
  - `--from/--to` resolves the link via `getIssue(K1,{fields:["issuelinks"]})`.
  - Ambiguity (several matching links) fails with the candidate ids.
  - `--confirm` is required only when the deletion was resolved by key pair. Open question 6.
- `jira search` / `jira my`:
  - Generalise `fetchAllIssues(client, jql, max, fields?)` (`jira.ts:3271`) and use it for search, my, bulk and A3.
  - `--limit` (default 25) is honoured across pages; `--all` means no cap, with a hard ceiling of 5000 and a warning.
  - Output gains `hasMore` and `nextPageToken`. `total` is documented as "returned count" because `/search/jql` has no total.
  - Regression test: limit 120 with a 2-page fetch stub returns 120.

**Collateral fixes in A1:**
- `importIssues` (`packages/jira/src/import.ts`) runs `description` and comment strings through `toJiraRichText`.
- `parseCsv` gets RFC 4180 quoted-newline support. Multi-line markdown descriptions need it; today `split(/\r?\n/)` breaks them.
- `collectExportData` (`export.ts:149`) uses `adfToMarkdown`, so export → import roundtrips rich comments.
- Link-page comments (3 sites) use markdown `[title](url)` through ADF.
- The 3× remote-link payload is extracted to `buildConfluencePageRemoteLink(profile, page)` in a new `apps/cli/src/commands/jira-confluence-link.ts`. It lives in the CLI because it needs `buildConfluenceUrl` from core and both command files use it. A2 reuses it.

### A2 — `wiki page tasks-to-issues`

**Command** (in `apps/cli/src/commands/page.ts` next to `link-issue` (`:115`); logic in a new `apps/cli/src/commands/page-tasks-to-issues.ts`):

```
atlcli wiki page tasks-to-issues --id <pageId> --project <KEY> [--type Task]
  [--include-done] [--label <l> ...] [--parent <EPIC-KEY>] [--no-link] [--no-mark]
  [--confirm] [--json]
```

Without `--confirm` the command prints a plan and changes nothing (the default dry run). This is chosen over `jira issue from-page` because the page is the source and the page is what gets modified. Open question 1.

**Functional core**, a new file `packages/confluence/src/page-tasks.ts`. It is pure and browser-safe, exported from `index.browser.ts`:

```ts
export interface PageTask {
  taskId: string; status: "complete" | "incomplete";
  text: string;               // body text minus mentions/dates/jira macros, whitespace-collapsed
  bodyStorage: string;        // raw task-body XHTML (for description)
  assigneeAccountId?: string; // first <ri:user ri:account-id>
  mentionAccountIds: string[];
  dueDate?: string;           // first <time datetime="YYYY-MM-DD">
  linkedIssueKeys: string[];  // jira macro key params + /browse/KEY hrefs in body
}
export function extractPageTasks(storage: string): PageTask[];          // via parseXml (budgeted)
export function annotateTasksWithIssueKeys(storage: string, keys: ReadonlyMap<string, string>): string;
export function taskFingerprint(task: PageTask): string;                // sha256 of normalized text (existing ./sha256.js)
```

- `annotateTasksWithIssueKeys` splices strings; it does not re-serialise, because `parseXml` has no offsets and the rest of the page must stay byte-identical. For each task it finds `<ac:task-id>ID</ac:task-id>`, takes the first following `<ac:task-body>`, and **prepends** `<ac:structured-macro ac:name="jira"><ac:parameter ac:name="key">KEY</ac:parameter></ac:structured-macro> `. Prepending is depth-safe even when the body contains nested lists. Task ids are unique within one storage document. If an id is missing, the function throws: the page changed under us.
- Task descriptions: the CLI turns `bodyStorage` to markdown with the existing `storageToMarkdown`, appends `\n\n_Created from [Page title](url)_`, then calls A1 `markdownToAdf`.

**Planner** (pure, in `page-tasks-to-issues.ts`): `planTaskIssues(tasks, ledger, {includeDone})` gives each task one of:
- `create`
- `skip:linked` (body already has a jira macro or browse link, i.e. created by us earlier or linked by hand)
- `skip:ledger` (ledger entry with matching taskId **and** fingerprint, but the body is not yet annotated; re-apply the annotation only)
- `skip:done` (complete and no `--include-done`)
- `skip:empty` (no text)

**Idempotency and crash safety:**
- The body marker is the durable truth. It survives `docs pull/push`: `storageToMarkdown` turns the jira macro into a `/browse/KEY` link, `markdownToStorage` keeps the link, and `linkedIssueKeys` covers both forms. This matters because a push renumbers task ids.
- Ledger: page content property `atlcli.tasks-to-issues` = `{v:1, tasks:{[taskId]:{key, fingerprint, createdAt}}}`. It is written **immediately after each** `createIssue`, before the remote link and the page update. Content properties do not bump the page version.
- Execution order for each task: create the issue (summary = `text` truncated to 255; assignee; `duedate`; labels; parent), upsert the ledger, then create the remote link (shared helper, unless `--no-link`).
- After all tasks: re-fetch the page, recompute the annotation from the ledger, and call `updatePage({version: current+1})` once. On a 409 conflict, re-fetch and retry once; keys come from the ledger, so nothing is duplicated.
- If `createIssue` fails, record the failure, continue, and exit non-zero (the `executeInBatches` semantics).
- Data Center: `upsertPageProperty` is v2 and Cloud-only. On DC the ledger step is skipped with a warning; the body marker alone guards reruns. Open question 3.
- Jira DC: no `accountId`, so assignee is omitted with a warning.

**Output:** a plan table with `taskId`, `action`, `summary`, `assignee`, `due`, `key`. With `--json`, `{schemaVersion:"1", pageId, dryRun, tasks:[…], created, skipped, failed}`.

**Status sync** (`--sync`; same dry-run/`--confirm` contract):

```
atlcli wiki page tasks-to-issues --id <pageId> --sync [--confirm] [--json]
```

- With `--sync`, the command creates nothing (`--project` is not required). It only reconciles task status with the linked issues.
- For every task with `linkedIssueKeys` (body marker, ledger or hand-made link), fetch the issue status category in one `search` (`key in (…)`, fields `status`, `resolution`).
- Pure planner `planTaskStatusSync(tasks, issueStates)`:
  - task `incomplete`, issue category `done` → `complete`;
  - task `complete`, issue reopened (category not `done`) → `reopen` (set back to `incomplete`);
  - task `complete`, issue never done → `report:ticked-but-open`, page untouched, no transition (Jira stays the source of truth);
  - several linked keys → the task counts as done only when all are done;
  - issue not found or not visible → `report:missing`.
- New pure helper in `page-tasks.ts`: `setTaskStatuses(storage, Map<taskId, "complete"|"incomplete">)`. It string-splices `<ac:task-status>` after the matching `<ac:task-id>`, with the same byte-identical guarantee and missing-id throw as `annotateTasksWithIssueKeys`.
- One `updatePage` per run, 409 retry once, unchanged pages are not written.
- The normal (create) run also syncs status for tasks it skipped as `skip:linked` when `--sync` is given together with `--project`, so one cron line can do both.

### A3 — release notes and sprint review pages

**Commands** (existing nouns, `jira.ts` `handleVersion` `:5171` / `handleSprint` `:1443`):

```
atlcli jira version notes <id|name> --project <KEY> --space <SPACE> [--parent <pageId>]
  [--title <t>] [--template <name>] [--var k=v ...] [--dry-run] [--force]
  [--export <file.pdf|file.docx> [--export-template <name>]]
atlcli jira sprint review <sprintId> --space <SPACE> [same options] [--points-field <id>]
```

**Data core** (pure), new file `packages/jira/src/report-data.ts`, exported from the Node barrel:

```ts
export interface ReportIssue { key; summary; type; status; statusCategory; assignee?; epic?: {key; summary}; points?; url }
export interface ReportData {
  kind: "release" | "sprint";
  source: { id: string; name: string; startDate?; endDate?; releaseDate?; released?; goal?; description? };
  issues: ReportIssue[];
  byType: Array<{ type: string; issues: ReportIssue[] }>;      // stable order: Epic, Story, Task, Bug, others A–Z
  byEpic: Array<{ epic?: {key; summary}; issues: ReportIssue[] }>;
  contributors: Array<{ name: string; accountId?: string; count: number }>;  // assignees, desc by count
  metrics: { total; done; inProgress; todo; donePercent; points?: { committed; completed } };
  sprint?: SprintMetrics;                                        // from calculateSprintMetrics (analysis.ts)
  generatedAt: string;
}
export function buildReportData(input: {...}): ReportData;
```

- Release issues come from `fetchAllIssues(client, 'fixVersion = <id> ORDER BY issuetype, key', 5000, fields)`.
- Sprint issues reuse `getSprintIssues` plus `calculateSprintMetrics`, the same as `handleSprintReport`. Extract the shared fetch part from `jira.ts:1693-1715` into a helper so `sprint report` and `sprint review` cannot drift.
- Version name resolution uses `getProjectVersions(project)`; exact-name match, otherwise a numeric id.
- Epic comes from `fields.parent` when the parent's issuetype is Epic.

**Templates** (decision 7): the template is the extension point, not a growing list of flags. `TemplateEngine` is Handlebars, so loops (`{{#each}}`), conditionals and partial-free composition already work; no new templating capability is needed.
- The **whole** `ReportData` model is passed in, so any template can iterate `issues`, `byType`, `byEpic`, `contributors` and read `metrics` / `sprint`.
- Bundled templates (built-in constants in `apps/cli/src/commands/jira-report-templates.ts`, parsed with `parseTemplate`): `release-notes` (by type), `release-notes-by-epic`, `sprint-review`. More can be added later as plain template files without code changes.
- `--group-by type|epic` only picks the default bundled template (`release-notes` vs `release-notes-by-epic`). `--template <name>` overrides it.
- `atlcli wiki template` gains nothing new; bundled templates are listed by `jira version notes --list-templates` and can be copied out with `--print-template <name>` to start a custom one.
- Test: every bundled template renders against a fixture `ReportData` and its markdown converts with `markdownToStorage` without error.

**Rendering:**
- Template lookup: `TemplateResolver` (global, profile, space) by name, then the bundled templates. A user template with the same name as a bundled one wins.
- Users customise by printing a bundled template, editing it, and saving it under any name. The resolved template name and source (user level or bundled) are shown in dry-run output.
- `TemplateEngine.render(template, {variables: {...reportData, ...varFlags}, builtins})`. Arrays already work with `{{#each}}`; this needs a verifying test.
- Precompute `url` in `ReportIssue` instead of adding a `{{jiraLink}}` Handlebars helper.
- Default templates use only the existing dialect: headings, a metrics table, `{status:green}Released{status}`, per-type sections with issue lists, a contributors list, and `:::info` for the sprint goal.

**Idempotent page write:**
- Title defaults to `Release notes – <version>` / `Sprint review – <sprint name>`.
- Identity property `atlcli.jira-report` = `{v:1, kind, jiraSite, sourceId}`.
- Lookup: `findPagesByTitle(space, title)`. If a page carries a matching property, update it with `updatePage(version+1)`, but only when the rendered storage differs. Hash compare via `hashContent` (`markdown.ts:3234`) yields `unchanged`. If no page exists, `createPage`, set the property, add labels from template metadata.
- A same-title page **without** the property means refusal unless `--force`, so a human page is never clobbered.
- `--dry-run` prints the rendered markdown and the action (create/update/unchanged), same shape as `page.ts:298`.

**Export chaining:** `--export <path>` calls the exported `handleExport` (`apps/cli/src/commands/export.ts:130`) in-process with `[pageId]` and `{output, template}` flags. This avoids re-implementing export and inherits all its options and validation.

## Implementation tasks

### Phase A1a — converter core
- [ ] Add `markdown-it` and `markdown-it-task-lists` to `packages/jira/package.json`; `bun install`.
- [ ] `packages/jira/src/adf-markdown.ts`: `markdownToAdf`, `adfToMarkdown`, sentinel encode/decode, `toJiraRichText`.
- [ ] `JiraClient.isCloudSite` getter; `@deprecated` TSDoc on `textToAdf` / `adfToText`.
- [ ] Export from `index.browser.ts`; `bun scripts/check-browser-build.ts` passes.
- [ ] `adf-markdown.test.ts` (see Tests).
- [ ] `bun scripts/api-report.ts --update`; review the `jira.api.md` diff.

### Phase A1b — CLI content surface
- [ ] `readRichTextFlag` helper; `--description-file` on issue create/update, epic create, subtask create; markdown worklog `--comment`.
- [ ] `issue get --format markdown` plus `descriptionMarkdown` in JSON.
- [ ] Client `updateComment`, `deleteComment`, `getChangelog`; CLI `issue comments …`, `issue history`, `issue unlink`.
- [ ] Generalise `fetchAllIssues(fields?)`; paginate `search` / `my`; `--all`; `hasMore`.
- [ ] Extract `buildConfluencePageRemoteLink`; switch the 3 call sites; markdown link comments.
- [ ] Import/export: `toJiraRichText` in `importIssues`, quoted-newline `parseCsv`, `adfToMarkdown` in export.
- [ ] Drift: `--map-field` (CSV header rename before field mapping, repeatable, `fail` on unknown column), `--issues` for bulk edit/transition/label/delete/link-page/move via `resolveBulkJql(flags)`; update `issueHelp` / `bulkHelp` / `importHelp`.
- [ ] `jira bulk move (--jql|--issues) (--sprint <id> | --backlog) [--dry-run] [--limit]`: resolve keys with `fetchAllIssues`, then call the same client methods as `sprint add` / `sprint remove` in chunks of 50 (Agile API limit). Dry run lists keys and target. Help text and docs section rewritten to match.

### Phase A2 — tasks to issues (depends on A1a)
- [ ] `packages/confluence/src/page-tasks.ts`: extract, annotate, fingerprint, plus tests.
- [ ] `apps/cli/src/commands/page-tasks-to-issues.ts`: `planTaskIssues` (pure) plus the shell; wire into `page.ts` and its help.
- [ ] Ledger property, retry-once on 409, DC degradation warnings.
- [ ] Status sync: `setTaskStatuses` (pure) in `page-tasks.ts`, `planTaskStatusSync` (pure), `--sync` wiring, combined `--project --sync` run.

### Phase A3 — report pages (depends on A1b `fetchAllIssues`)
- [ ] `packages/jira/src/report-data.ts` plus tests; extract the shared sprint fetch helper.
- [ ] `jira-report-templates.ts` (3 bundled: `release-notes`, `release-notes-by-epic`, `sprint-review`); `--group-by`, `--list-templates`, `--print-template`; `version notes`, `sprint review` handlers plus help.
- [ ] Idempotent upsert with property, `--force`, `--dry-run`; `--export` chaining.

### Phase D — docs (same PRs as behaviour, per CLAUDE.md)
- [ ] See "Docs updates".

## Tests

The repo convention is `bun run test` (never bare `bun test`). Use real code paths and pure functions. The **only** mock allowed is `globalThis.fetch`, as in the existing `packages/jira/src/client.test.ts:16-47`.

- `packages/jira/src/adf-markdown.test.ts`:
  - Table-driven roundtrips `md → adf → md` (idempotent after one pass) for every row of the mapping table, including nested lists, a task list inside a list, a code block with backticks, a table with inline marks, a link wrapping strong, mentions, dates (UTC boundary), status, panels, expand, and `{jira:KEY}` with and without `baseUrl`.
  - `adf → md → adf` deep-equal (ignoring `localId`) on fixtures. Reuse real ADF from `packages/confluence/src/__fixtures__` / `adf-direct-fixtures.test.ts` where the node types overlap; add 2–3 captured Jira Cloud descriptions (sanitised) under `packages/jira/src/__fixtures__/`.
  - Every `markdownToAdf` output passes `validateAdf`.
  - Lossy policy: media and extension survive via the sentinel byte-exactly; dropped marks keep their text; a local image warns.
  - `toJiraRichText`: Cloud returns ADF, DC returns a string. Regression for the DC bug.
- `packages/jira/src/client.test.ts`: `updateComment`, `deleteComment`, `getChangelog` pagination (`isLast`); request shape asserted via the fetch stub.
- `apps/cli/src/commands/jira-*.test.ts`, following `jira-attach.test.ts`:
  - search `--limit 120` over two stubbed pages returns 120 and `hasMore`.
  - `--description-file -` from stdin.
  - unlink ambiguity error.
  - `--issues` maps to `key in (…)`.
  - `--map-field`.
  - Regression: CSV import with a multi-line quoted description and a v3 ADF body.
  - Regression: the link-page comment body is ADF containing a `link` mark.
- `packages/confluence/src/page-tasks.test.ts`:
  - Extraction from real storage samples: `markdownToStorage` output plus a hand-captured Cloud editor storage with `ac:task-uuid`, mentions, `<time>`, nested lists, and an already-present jira macro.
  - Annotate keeps all other bytes identical (string diff equals only the inserted macros) and throws on a missing id.
  - Fingerprint stability.
  - Annotate → `storageToMarkdown` → `markdownToStorage` → `extractPageTasks` still reports `linkedIssueKeys`. Regression for task renumbering.
- `page-tasks-to-issues.test.ts`: planner matrix (linked / ledger hit / ledger fingerprint mismatch / done / empty).
- Status sync: `planTaskStatusSync` matrix (incomplete+done → complete, complete+reopened → reopen, ticked-but-open → report, multi-key partial, missing issue); `setTaskStatuses` byte-identical except the status elements, throws on missing id.
- `bulk move`: `--backlog` and `--sprint` request shapes, chunking at 50 (fetch stub).
- `packages/jira/src/report-data.test.ts`: grouping order, epic grouping, contributors, metrics, empty version. Plus a render test: default templates through the real `TemplateEngine` produce the expected markdown snapshot, and `markdownToStorage` of it does not throw.
- Gates: `bun run typecheck`, `bun run test`, `bun scripts/check-browser-build.ts`, `bun scripts/api-report.ts` (no unreviewed diff).

## E2E plan

Profile `mayflower`, Confluence space **DOCSY only**, Jira project **ATLCLI**. Use the existing harness `apps/cli/src/e2e/resources.ts` (`withE2eResources`, `E2eResourceTracker.trackPage/trackIssue`, `makeE2eTitle`, `E2E_RUN_ID_PROPERTY`) and `rest-ports.ts` (`createConfluencePort`, `createJiraPort`).

New file `apps/cli/src/e2e/jira-content-live.e2e.test.ts`:
- Gated by `ATLCLI_JIRA_CONTENT_E2E=1`.
- Script `test:e2e:jira-content`: `bun run build:cli && ATLCLI_JIRA_CONTENT_E2E=1 bun run test apps/cli/src/e2e/jira-content-live.e2e.test.ts`. Runs against the built `dist/index.js`, same as `wiki-import-pdf-live`.

Scenarios:
1. **A1:** create an issue with `--description-file` (fixture covering every mapping row).
   - `issue get --format markdown`: equals the source after normalisation.
   - Add an image attachment to the description through the UI-equivalent REST call (a media node), then get → update: the media node is still present.
   - `comments add / edit / list / delete`.
   - Two issues: `issue link`, then `issue unlink --from --to`.
   - `issue history` shows the summary change.
   - `search --jql "project = ATLCLI AND summary ~ <runId>"` paginates: create 3 issues and assert `hasMore` with `--limit 2`.
2. **A2:** create a DOCSY page from markdown with 3 tasks (one with `@[x](<self accountId>)` and `{date:…}`, one done, one already containing `{jira:…}`).
   - Dry run: 1 create, 2 skips, and the page version is unchanged.
   - `--confirm`: 1 issue with assignee and due date, remote link visible via `jira issue pages`, task body has the macro, ledger property present.
   - **Rerun with `--confirm`: 0 created.**
   - `docs pull` → `docs push` → rerun: still 0 created.
   - Transition the created issue to Done, run `--sync --confirm`: the task is ticked on the page. Reopen the issue, rerun: the task is unticked. Rerun without changes: page version unchanged.
   - Every CLI-created issue is passed to `trackIssue` **and** stamped with `setIssueProperty(E2E_RUN_ID_PROPERTY)` so the sweeper can also find it.
3. **A3:**
   - Create version `atlcli-e2e-<runId>` in ATLCLI and assign the A1 issues to it.
   - `version notes --space DOCSY --dry-run`, then real: page created with the property. Rerun: `unchanged`. Change one issue: `updated` (version +1).
   - Same-title page without the property: refused, unless `--force`.
   - `--export out.pdf` produces a non-empty PDF in a temp dir.
   - `sprint review` on an existing ATLCLI board sprint in `--dry-run` only (do not mutate the sprint).

Cleanup:
- `finally` runs `tracker.cleanup()`: pages, issues, plus `deleteVersion` for the e2e version (add it to the test's own `finally`).
- Temp dirs are removed.
- Check afterwards with `bun apps/cli/src/e2e/cleanup.ts --profile mayflower` dry-run sweep: nothing left.
- No tenant URLs or bodies are written to disk.

Also run the CLAUDE.md manual smoke in `~/wikisynctest/docs` before committing each phase.

## Docs updates

All under `src/content/docs/`, using the page template from CLAUDE.md (intro → prerequisites → steps → options → examples → troubleshooting → related):

- `jira/issues.md`:
  - New section "Markdown descriptions and comments": dialect table, lossy policy table, DC note.
  - `--description-file`, `get --format markdown`, `comments …`, `history`, `unlink`. Replace the "positional comment" text.
- `jira/search.md`: `--limit` across pages, `--all`, `hasMore`/`total` semantics.
- `jira/bulk-operations.md`: `--issues` for all subcommands; rewrite the `bulk move` section to the implemented `--sprint`/`--backlog` behaviour; remove the `--confirm` row on edit and the fake text output samples (replace with real JSON).
- `jira/import-export.md`: `--map-field` semantics (CSV only, `Column=field`), comma separators, multi-line quoted cells, markdown descriptions and comments both ways; remove `--fields`.
- `jira/boards-sprints.md`: `sprint review`. `jira/projects.md` or a new `jira/versions.md`: `version notes` (check where versions are documented; `projects.md` is the likely home).
- `confluence/pages.md`: `tasks-to-issues` including `--sync`. `confluence/templates.md`: report templates, the bundled template list, available variables (the `ReportData` reference table with type / description), a custom-template example with `{{#each byEpic}}`, and how to override the bundled ones.
- `confluence/export.md`: a short "export a generated report" example.
- `recipes/sprint-reporting.md`: rewrite around `sprint review --export`. New `recipes/meeting-notes-to-jira.md`. `recipes/index.md` link.
- `reference/cli-commands.md`: all new commands and flags.

## Git workflow

One branch per phase (A1a, A1b, A2, A3), Conventional Commits:
- `feat(jira): markdown↔ADF conversion`
- `feat(jira): comment CRUD, history, unlink`
- `fix(jira): paginate search`
- `fix(jira): ADF descriptions on import`
- `feat(confluence): tasks-to-issues`
- `feat(jira): release notes and sprint review pages`
- `feat(jira): bulk move to sprint or backlog`

Docs ship in the same PR as behaviour. No push until told.

## Open questions

None. All original questions were decided on 2026-10-21; see "Decisions" at the top.
