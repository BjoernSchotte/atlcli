# CLI flag audit

**Question asked:** for every flag documented in a `--help` block — is it read,
and does it do what the help says?

**Answer:** ~380 documented options across 8 command surfaces, **~60 findings**.
Roughly one in six documented options does not do what it promises.

The audit ran as eight parallel read-only passes, one per command surface, each
required to cite a *consumption site* (`file.ts:line` where the value changes
output, an API request, an exit code, or a file) rather than a parse site. A
passing test was explicitly ruled out as evidence — three test blocks
encountered during the audit assert nothing about the behaviour their names
claim (see [Test blocks with no teeth](#test-blocks-with-no-teeth)).

---

## Contents

- [How the classes are defined](#how-the-classes-are-defined)
- [Fixed](#fixed)
- [Open findings by severity](#open-findings-by-severity)
  - [A — silently wrong results](#a--silently-wrong-results)
  - [B — inert flags](#b--inert-flags)
  - [C — silent conflicts](#c--silent-conflicts)
  - [D — unreachable help](#d--unreachable-help)
  - [E — `--json` violations](#e---json-violations)
- [The structural pattern](#the-structural-pattern)
- [Test blocks with no teeth](#test-blocks-with-no-teeth)
- [Reproducing the audit](#reproducing-the-audit)

---

## How the classes are defined

| Class | Meaning |
|---|---|
| **inert** | Read, but the value never reaches behaviour — assigned and dropped, used only in a log or note, or overwritten unconditionally |
| **partial** | Works on one engine, format or subcommand and is silently ignored on another the *same help block* advertises |
| **conflict** | Two flags can contradict; one wins silently, with no warning or error |
| **unreachable** | Documented in a help block no user can print |

A flag is only "wired" if the value demonstrably reaches an observable effect.

---

## Fixed

Shipped in [PR #76](https://github.com/BjoernSchotte/atlcli/pull/76) (data loss
and wrong target) and PR #75 (export surface). All mutation-verified.

| Flag | Was |
|---|---|
| `jira worklog timer stop` | Timer cleared before the worklog existed; four losing paths, `addWorklog` with no `catch` |
| `wiki template delete --level profile` | Deleted the **space** template, reported success |
| `wiki docs sync --dry-run` | Deleted `.meta.json` and `.base`, the only copy of that metadata |
| `docs pull` (attachments) | Overwrote edited attachments without `--force`, after `status` said there was nothing to lose |
| `jira template --project` + `--profile` | Wrote to profile storage; then unfindable and undeletable with the same flags |
| `--on-conflict local` | Unbounded mutual recursion — 33,782 GETs, 0 PUTs |
| `--on-conflict remote` | Wrote a new file, left the local edit in place |
| `docs push --validate` | Never validated the push target |
| `docs check --dir` | "0 files, 0 errors", exit 0 — a green gate that validated nothing |
| `wiki template validate` | Exit 0 on invalid templates |
| `wiki template update --force` | Inert; removed |
| `wiki export -t` | Short alias never read — exported with the bundled default |
| `wiki export --no-toc-prompt` | Honoured by the Python engine, ignored by the `ts` engine we ship |
| `wiki export --keep-ignored` | Inert on every path: the spec-008 mention pre-walk took over the walk that applied export controls |

---

## Open findings by severity

### A — silently wrong results

The user gets an answer that looks right and is not.

| Flag | Class | Site | What happens |
|---|---|---|---|
| Leading global flags | parser | `packages/core/src/utils.ts:52-56` | `atlcli --json wiki page get --id X` prints the **root help** and **exits 0**. A value-less flag swallows the next token, so `--json` becomes `json="wiki"`. Affects every boolean global flag; the natural invocation returns garbage with a success exit code |
| `atlcli update <version> --check` | conflict | `update.ts:136` | `if (checkOnly && !targetVersion)` — with a version argument, `--check` falls through and **installs** |
| `atlcli update --json` | partial | `update.ts:207-220` | The human path calls `process.exit(1)`; the JSON path `return`s. A failed update **exits 0** |
| `wiki page list --space` | partial | `page.ts:191` read, consumed only in the `--label` branch at `:197` | On the CQL branch the flag is dropped — `--space DOCSY` silently searches **every** space |
| `wiki page list --limit` | partial | label path capped at `client.ts:2432`; CQL path drained at `client.ts:1074` | `--limit 2` returned **90** rows. Same help line, two behaviours |
| `wiki page children --limit` | inert | `page.ts:1311` → `drainPaginated` | `--limit 2` → 19 results; `--limit 100` → 19. The value is only an API page size |
| `docs pull --limit` | inert | `docs.ts:488` → `drainPaginated` | `--limit 1` on DOCSY pulled 90 pages. Same cause: the pagination fix removed the early break, the flag feeding it was never rechecked |
| `wiki page sort --by created\|modified` | inert | `page.ts:1208-1210` → `reorder.ts:47-68` | `createdAt` is never populated (`ConfluencePage` has no such field), so it always sorts A–Z — while the JSON reports `strategy: "created"`, making the wrong order look confirmed |
| `audit wiki --all` | partial | `:379-390` vs `:406-424` | Without `audit.staleThresholds` in config — the shipped default — `--all` silently omits the STALE check. Knock-on: `--all --fix --dry-run` then generates **zero** label and archive actions while still offering `Delete page:` prompts. The safe action vanishes, the destructive one remains |
| `audit wiki --include-remote` | broken | `client.ts:1736-1739` | Passes `limit: 500`; Confluence Cloud v2 caps at 250 → HTTP 400. The throw escapes `runAudit`, so **0 bytes on stdout, exit 1** — the already-computed local audit is discarded. One-character fix |
| `jira export --format <bogus>` | partial | `jira.ts:3823` casts without validating | `--format xml` writes a **CSV** file named `.xml`, exit 0, and reports `"format":"xml"` |
| `jira issue get --expand` | inert | `jira.ts:441`, `formatIssue` `:3794` | Every expand target lands top-level; `formatIssue` projects onto 15 keys inside `fields`. Output identical with and without — 424 bytes each. Costs a round-trip |
| `jira bulk link-page --comment` | inert | `jira.ts:3217` uses `getFlag` | `getFlag` returns `undefined` for booleans, so bulk-linking adds **zero** comments. The sibling `issue link-page` correctly uses `hasFlag` at `:802` |
| `jira bulk edit --set labels=a,b,c` | rejected | `jira.ts:2936` | The comma split before `parseFieldAssignments` makes the help's own documented form a usage error; `case "labels"` at `:2906` is dead code |
| `sync --label` | partial | `sync.ts:300-329` only | Holds for the initial sync; the poller and webhook filter have no label awareness, so the daemon then pulls every changed page regardless |
| `wiki search --label a --label b` | partial | `search.ts:132` | `getFlag` returns only the first. **The help block's own example is the broken form** |
| `wiki search --format` + `--json` | conflict | `search.ts:275` returns before the format switch | `--format compact` under `--json` silently strips fields from the machine-readable payload (6 expand fields → 1) |
| `docs resolve --accept` | partial | `docs.ts:3048` | Bails on the legacy `.meta.json` format, so it is unreachable for anything produced by the documented `docs init` + `docs pull` flow. The advertised `merged` value can only ever produce a usage error |
| `log tail --since/--until/--type` | partial | read only in `handleList` | `handleTail` passes only `{level, limit}`, though `streamLogs` supports all of them. `log tail --type api` prints every type |
| `doctor --profile` | partial | `doctor.ts:222, 277` | `getActiveProfile(config)` with no second argument — the one command whose job is per-profile diagnosis silently diagnoses the wrong profile |
| `export --no-images` | partial | PDF branch returns at `export.ts:143` before the read | Accepted on `--format pdf`, images embedded anyway. `RunPdfExportInput` has no image toggle at all |
| `export --no-live-macros` | partial | PDF hard-codes `live: true` at `export-pdf.ts:267` | The DOCX path fails fast when it cannot honour it; the PDF path silently no-ops. Since `--engine` is rejected with `--format pdf`, a deterministic PDF is unobtainable and unsignalled |
| `export --no-merge` | partial | `export.ts:474`, python branch only | Accepted and dropped on `--engine ts` |
| `export template save --level <bogus>` | inert | `export.ts:933`, no validation | Writes to global and **reports the invalid level back** in the JSON. Every other enum flag in this command validates |

### B — inert flags

| Flag | Site | Note |
|---|---|---|
| `audit wiki --local-only` | help `audit-wiki.ts:1392`; zero consumers repo-wide | `localOnly` is derived solely from `!hasFlag(flags,"include-remote")` at `:437`. With both flags, the widening one wins — the opposite of what was asked. Also breaks positional dir resolution, since the value-less flag swallows the path |
| `audit wiki --rebuild-graph` | `:944-954` | A stub that prints "Note: Full rebuild requires re-reading all markdown files." The graph is not rebuilt |
| `template init --profile` | `template.ts:1117` | `getActiveProfile(config)` without the flag — fetches the page as the *active* profile. Its error message points at `atlcli config profile`, which is not a command |
| `jira template get`/`apply --level` | `jira.ts:5479, 5522, 5600` | Call `ctx.resolver.resolve(name)` unconditionally. Read-only, so no destructive analogue |

### C — silent conflicts

| Flags | Site | Winner |
|---|---|---|
| `--page-id` / `--ancestor` / `--space` | `packages/confluence/src/scope.ts:38-62` | An **empty stub** `if (scopeCount > 1 && pageId) { /* ignore others */ }`. Backs `init`, `pull` and `sync` |
| `epic list --project` vs `--board` | `jira.ts:2043-2047` | Board wins — **including when the user passes only `--project`** and `defaults.board` is configured, so a board they never mentioned filters the results |
| `template copy --to-*` vs `template import --to-*` | `template.ts:1137-1150` vs `importer.ts:175-177` | **Opposite precedence for identically-named flags.** `import` also gives no clue where files went |
| `template create --interactive` + `--file` | `template.ts:361-384` | The wizard returns before `--file` is ever consumed; the file content is silently lost |
| `page sort --alphabetical/--natural/--by` | `page.ts:1204-1215` | An if/else chain with no arity check. `handleMove` errors on multiple positioning flags; `handleSort` does not, and then rewrites page order |
| `filter list --favorite` vs `--query`/`--limit` | `jira.ts:3432-3443` | Favourites branch returns first; both narrowing flags silently ignored |
| `template list --level` vs `--profile`/`--project` | `jira.ts:5335, 5339` | Overwrite `filter.level`, so `--level global --profile x` returns profile templates |
| `audit wiki --folders` | `:351-365` | The one check flag missing from `hasExplicitCheckFlags`, so it alone fails to suppress config defaults — an explicit narrowing flag that silently widens the run |
| `--skip-user-check` vs `--refresh-users` | `user-fetcher.ts:182` | "Force" loses silently |

### D — unreachable help

Documented options no user can print.

| Surface | Cause |
|---|---|
| `audit wiki` (32 options) | `showCommandHelp` (`index.ts:226-268`) has **no `case "audit"`**. `auditWikiHelp()` is dead code; `atlcli audit wiki --help` prints the root help |
| `jira search` / `jira my` | No help function at all — one example line in `jiraHelp` |
| `wiki recent` / `wiki my` | Read five flags each; `wikiHelp()` lists only subcommand names |

`wiki docs sync` had the same defect and is fixed in PR #76.

### E — `--json` violations

`--json` is advertised on every command. These break machine consumers.

| Site | Problem |
|---|---|
| `plugin.ts:94, 191, 238, 292, 333` | `output(JSON.stringify(x), opts)` double-encodes — a JSON *string* containing JSON. `jq '.[0].name'` fails |
| `log.ts:261-297` | `log tail` never branches on `opts.json`; emits human text |
| `page.ts:1359, 1461` | `--dry-run --json` prints a human string **and then** the JSON object — two documents |
| `config.ts` (9 sites) | Every error path ignores `--json` **and** returns exit 0 |
| `flag.ts:120-144` | `set`/`unset` always print prose |
| `audit-wiki.ts:314-328` | With `--fix`, JSON is followed by human text — unparseable, breaking exactly the scripted use the flag exists for |
| `template.ts` | `validate --all --json` emits one document per invalid template |
| `docs.ts` | `check --json` prints report + error as two documents |

---

## The structural pattern

Nearly every finding is the same shape: **two code paths behind one help line,
and only one honours the flag.**

- `wiki page list --space` — applied in the label branch, not the CQL branch
- `--limit` — capped on one path, drained on the other
- `--comment` — `hasFlag` at one call site, `getFlag` at the other
- `--level` — filters on `list`, ignored on `show`/`delete`
- `--dry-run` — eleven guarded write sites, one unguarded
- `--force` — guards markdown, not attachments
- `--keep-ignored` — honoured by the engine's walk, and the CLI stopped using that walk

This is what happens when a command gains a second path and the help text stays
as it was. Two mitigations worth considering:

1. **A parse-time contract.** Declare each command's flags in one place — name,
   type, which subcommands accept it — and generate the help from that
   declaration. Then "documented but never read" becomes impossible by
   construction, which is the entire class the mechanical pass found.
2. **Enum validation as a house rule.** `wiki export` rejects unknown values for
   `--format`, `--engine`, `--scope`, `--completeness`, `--label-exclude-mode`,
   `--auth-type` and `--report`, and accepts anything for `--level`. Several
   findings above are exactly this omission.

---

## Test blocks with no teeth

Three blocks whose names claim coverage they do not provide. Worth knowing
before trusting a green run in these areas.

| File | Problem |
|---|---|
| `apps/cli/src/commands/audit.test.ts:906-1050` | `describe("fix action generation")` never calls `generateFixActions`. All three cases only assert the adapter returns the seeded page — nothing about `--fix`, `--fix-label` or `--dry-run` |
| `apps/cli/src/commands/sync.test.ts` | Contains only regex assertions against the **source text** of `sync.ts`. It caught none of the three sync defects |
| `packages/docx/src/export.test.ts:1383` | The only `--keep-ignored` test passes `details.storage` with no `blocks` — the one path the CLI never takes. Green throughout the defect's lifetime |

---

## Reproducing the audit

The mechanical half — "documented but never read" — is deterministic and worth
keeping. It extracts every flag named in an indented help line, every flag name
appearing in a flag-reading expression, and diffs them.

Two lessons for anyone re-running it:

- **Match accessors generically.** A narrow list (`getFlag`, `hasFlag`, …)
  produced six false positives, because `--max-depth` and friends go through
  command-local helpers like `parseBoundedInt(flags, "max-depth", …)`. Matching
  any call whose first argument is a flags-ish identifier fixed it.
- **Treat `--no-x` and `x` as one name.** Otherwise every negated flag reads as
  a false positive.

With both corrections the mechanical pass reports exactly two hits repo-wide, so
its value is as a cheap regression gate, not as the audit itself. **The
semantic half — flags that are read and still do nothing — is where ~58 of the
60 findings came from, and it needs someone to trace each flag to its
consumption site.**
