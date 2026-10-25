# Plan: Script-Runtime für große Mengen (Bündel 2+3+4+5 aus der Hooks-Analyse)

## Kontext

Die Analyse von Taskhooker „Hooks“ hat vier Lücken in `atlcli script` gezeigt, die als ein Bündel kommen sollen:

- **(2) Skripte pro Issue über große JQL-Mengen**, ohne Abbruch bei 100 Writes. Ziel: **zehntausende Issues**, mit Fortsetzen nach Abbruch.
- **(3) Lesender REST-Zugang** in Skripten, für alles, was die festen Verben nicht abdecken.
- **(4) Skript-Gerüst und Beispiele**: `script init` aus JQL und mit Beispielsammlung.
- **(5) JQL-Funktionen auf der Client-Seite**, z. B. `linkedIssuesOf`, `subtasksOf`, `hasAttachments`.

### Was heute bremst (Stand origin/main, f279a5d1)

| Grenze | Wo | Wirkung bei 10k+ Issues |
|---|---|---|
| `DEFAULT_MAX_WRITES = 100` | `packages/script-runtime/src/meta.ts` | Der Lauf bricht mit `write-limit` ab |
| `maxHostCalls 10_000`, `deadlineMs 5 min`, `memory 64 MB` gelten **pro Lauf** | `sandbox.ts` `DEFAULT_SANDBOX_LIMITS` | Ein einziger Sandbox-Lauf über alle Issues läuft in Calls, Zeit oder Speicher über |
| Der Plan liegt komplett im Speicher und als eine JSON-Datei | `plan.ts` | Bei 50k Operationen kaum noch reviewbar; `renderPlan` gibt jede Operation einzeln aus |
| Apply prüft **alle** Preconditions vorab; ein einziger Drift bricht alles ab | `apply.ts` | Bei 50k Issues, an denen nebenher gearbeitet wird, praktisch immer Drift |
| Apply stoppt beim ersten Fehler und kann nicht fortsetzen | `apply.ts` | Ein Fehler nach Stunden, und es geht nur von vorn los |
| Apply läuft sequenziell | `apply.ts` | 50k Ops × ~300 ms ≈ 4 h |

Die Runtime selbst taugt als Basis: Recorder, Preconditions, Skip-unchanged und `applyScriptPlan` lassen sich pro Issue wiederverwenden. Die Wrapper rufen den Host über Promises auf, ohne Asyncify; mehrere QuickJS-Runtimes können also parallel laufen.

## Ansatz

Zwei Skalierungsachsen, beide nötig:

- **A. Pro-Issue-Modus `--each`** für unabhängige Änderungen. Hier liegt der Hauptnutzen für zehntausende Issues.
- **B. Große Gesamtpläne** für Skripte mit Abhängigkeiten über mehrere Issues hinweg, z. B. `copy-issues` mit Links zwischen den Kopien. Sie werden skalierbar gemacht, aber nicht zerlegt.

### A. `atlcli script run x.ts --each "<jql>"`

**Der Skriptautor schreibt kein Boilerplate:**
```ts
export const meta = { each: { jql: "project = ATLCLI AND updated < -180d", fields: ["summary", "status"] } };
export default async (issue) => {
  if (issue.fields.status.name !== "Fertig") await atlcli.jira.comment(issue.key, "Noch nötig?");
};
```
- `meta.each = { jql?, fields? }` ist neu im `scriptMetaSchema`. Das CLI-Flag `--each <jql>` überschreibt die JQL.
- Im `--each`-Modus wird der Default-Export **pro Issue** als `default(issue, params)` aufgerufen. `atlcli.params` bleibt wie bisher.
- **Pro Issue eine frische QuickJS-Runtime**, über den unveränderten `runScript`, das Issue kommt als zusätzliches Global. Das gibt Isolation zwischen den Issues, Limits pro Issue und einen deterministischen Plan pro Issue. Der Overhead von wenigen ms pro Issue ist gegenüber dem Netz vernachlässigbar. Lesende Metadaten (Link-Typen, Transitions-Cache) teilen sich die Issues über einen Cache auf Host-Seite.
- **Limits gelten pro Issue** (Defaults: maxWrites 50, Calls 500, Deadline 60 s). Insgesamt gibt es **keine Write-Obergrenze**. Optional begrenzen `--max-items <n>` oder `--max-failures <n|%>` den Lauf; der Abbruch über die Fehlerschwelle hat den Default 10 %.

**Ablauf (Job):**
1. **Snapshot:** Die JQL wird einmal mit `fields: ["id","key"]` paginiert ausgeführt, die Keys landen in `items.jsonl`. Das macht den Lauf deterministisch und fortsetzbar und liefert vorab eine Gesamtzahl. Ein Paging über eine Ergebnismenge, die sich durch die eigenen Writes verändert, würde Issues überspringen.
2. **Verarbeitung in Batches von 100 Keys:** Die Felder werden per `key in (…)` geladen, dann folgt pro Issue `planItem()` → Item-Plan. Parallelität über `--concurrency` (Default 4). Bei 429 greift das vorhandene Retry-After im JiraClient.
3. **Modi:**
   - ohne `--apply`: Die Item-Pläne werden in `plans.jsonl` gestreamt. Es gibt eine **Zusammenfassung** (Zähler pro Verb, die ersten 20 Operationen, Fehler-Samples), nichts wird verändert. Danach folgt `atlcli script apply <job>`.
   - `--apply [--yes]`: Planen und anwenden im Strom, Batch für Batch, ohne Zwischen-Review. Vorher kommt eine Bestätigung mit der Issue-Zahl aus dem Snapshot (Entscheidung: beide Wege anbieten).
4. **Apply pro Issue** über das vorhandene `applyScriptPlan`, angewendet auf den Item-Plan. Preconditions werden pro Issue direkt vor dessen Writes geprüft. Drift oder Fehler betreffen **nur dieses Issue** und werden protokolliert; der Lauf geht weiter.
5. **Fortsetzen:** `atlcli script resume <job>` (Ctrl-C beendet sauber: laufende Issues fertig, dann flush). Bereits erledigte Keys in `results.jsonl` werden übersprungen, der Rest wird **neu geplant**, also frisch gelesen und damit ohne falschen Drift. Die Semantik ist at-least-once wie bei Hooks: Ist ein Issue angewendet, das Ergebnis aber noch nicht geschrieben, wird es erneut geplant. Skip-unchanged fängt Status, Labels, Assign und Page-Updates ab. **Nicht idempotent sind Kommentare, create und attach**; das steht in der Doku samt Marker-Property-Muster wie bei `copy-issues`.

**Job-Verzeichnis** `~/.atlcli/jobs/<id>/` (oder `--job-dir`):
- `job.json`: Skript-sha256 plus Kopie des Quelltexts, Params, JQL, Profil/baseUrl, Modus, Limits, Zähler.
- `items.jsonl`, `plans.jsonl`, `results.jsonl` (`{key, status: applied|unchanged|drift|failed|planned, ops, error?, value?}`).
- `atlcli script jobs [id]` listet Jobs oder zeigt den Status eines Jobs (Fortschritt, Zähler, 20 Fehler-Samples). Das deckt auch einen Teil von „Run-History“ (Punkt 6) ab.
- `script apply <job>` prüft vor dem Anwenden, dass Skript-sha und Ziel-baseUrl passen. Die bisherige Digest-Logik bekommt für den Job eine Variante: Digest über `plans.jsonl`.

### B. Große Gesamtpläne (`script run` ohne `--each`, `script apply plan.json`)

- **Apply-Journal:** `script apply plan.json` schreibt `<plan>.journal.jsonl` (seq, Ergebnis, aufgelöste Platzhalter). Mit `--resume` werden die angewendeten Seqs übersprungen und `resolved` aus dem Journal wiederhergestellt; Preconditions werden nur für offene Ops geprüft. Folgewrites auf schon geschriebene Objekte haben ohnehin keine Precondition, nur `dependsOn`, die Logik passt also.
- **`--concurrency` für Apply:** ein Scheduler, der `dependsOn` beachtet. Bei Schreibzugriffen auf dasselbe Objekt steckt die Abhängigkeit schon in `dependsOn`. Default 1, damit das heutige Verhalten bleibt.
- **`renderPlan` fasst ab 200 Ops zusammen** (Zähler pro Verb, die ersten 50 Ops, Hinweis auf `--plan-out`/`--json`). Fortschritt bei mehr als 200 Ops als Zählerzeile statt `✓ seq` pro Zeile.
- **Limits (Entscheidung: Defaults deutlich hoch):** `DEFAULT_MAX_WRITES` von 100 auf **10.000**, `maxHostCalls` von 10k auf **100.000**, `deadlineMs` von 5 min auf **1 h**. Speicher bleibt bei 64 MB (per `--memory` anhebbar). Zusätzlich bedeutet `0` bei `--max-writes/--max-calls/--timeout` „unbegrenzt“. Der Schutz vor Versehen kommt aus Plan-Review und Bestätigung; der Bestätigungsprompt nennt ab 1.000 Ops zusätzlich Zähler pro Verb. Die bestehenden Tests, die auf 100 prüfen, werden angepasst; die Werte stehen in der Doku.

### (3) Lesender REST-Zugang

- `atlcli.jira.rest(path, { query? })` und `atlcli.confluence.rest(path, { query? })`, **nur GET**.
- Pfadregeln: relativ, beginnt mit `/rest/`, kein `..`, kein Schema/Host, keine Steuerzeichen. Die Basis (`/wiki` bei Confluence Cloud) setzt der Client.
- Braucht `jira:read` bzw. `confluence:read`. Antwortgröße höchstens 5 MB (es bleibt JSON).
- Neue öffentliche `getJson(path, {query, signal})` in `JiraClient` und `ConfluenceClient`, die den vorhandenen privaten `request` nutzen, damit Auth, Retry, 429 und Redirect-Erkennung dieselben bleiben. Port-Methoden `jiraRest`/`confluenceRest` als **optional** im `ScriptPort` (Muster wie `render?`).
- Kein schreibender REST-Zugang, weil er das Plan-Modell untergräbt (keine Preconditions, kein Review).

### (4) Gerüst und Beispiele

- `atlcli script init [dir] --each "<jql>"` schreibt `each.ts` mit `meta.each.jql` und kommentiertem Skelett: Felder, Beispiel-Write, Idempotenz-Hinweis.
- `atlcli script init --example <name>` und `--list-examples`. Etwa sechs Beispiele unter `apps/cli/src/builtin-scripts/examples/`, nach Modus `run`/`each` getaggt: stale-Kommentar, Labels normalisieren, alte Issues schließen (`setStatus`), Feld kopieren, Wert eines Custom Fields per `rest` lesen, Confluence-Statusseite pro Epic.
- Jedes Beispiel wird im Test gegen den Fake-Port geplant, damit es nicht veraltet.

### (5) JQL-Funktionen auf der Client-Seite

- Neues reines Modul `packages/jira/src/jql-functions.ts`:
  - `findJqlFunctions(jql)`: Tokenizer, der Strings und Escapes beachtet.
  - `expandJqlFunctions(jql, search, {maxKeys, maxScan})`: ersetzt `issue [not] in fn("innerJql")` durch native JQL.
- **Native Umschreibung, wo möglich, sonst Key-Liste:**
  - `subtasksOf`, `childrenOf`, `issuesInEpics`: `parent in (keys der inneren JQL)`
  - `parentsOf`, `epicsOf`: Parent-Keys der Treffer
  - `linkedIssuesOf(jql[, linkType])`: `issuelinks` der Treffer
  - `has*`: Felder der Treffer prüfen (`subtasks`, `issuelinks`, `attachment`, `comment.total`, `worklog.total`), Ergebnis ist eine Key-Liste
- Leere Menge → ein gültiger No-Match-Ausdruck (wie Hooks); welcher genau, wird live ermittelt. Grenzen: höchstens 1.000 Keys und 2.000 gescannte Issues, per Flag anhebbar. Wird eine Grenze überschritten, gibt es einen klaren Fehler statt eines stillen Abschneidens. Verschachtelte Funktionen sind nicht erlaubt (Fehler).
- **Namen wie bei ScriptRunner** (Entscheidung). Ist ScriptRunner auf der Site installiert, überdeckt atlcli dessen Funktionen mit gleichem Namen; das steht in der Doku, `--no-jql-functions` ist der Ausweg.
- Wird an **einer** Stelle eingehängt: in `JiraClient.search` hinter einem Opt-in-Parameter, damit `jira search`, `jira bulk *`, `--each`, `atlcli.jira.search` und `copy-issues` es automatisch bekommen. Zusätzlich `--no-jql-functions` als Notausgang.
- Bezug zu `--each`: Der Snapshot wird **nach** der Expansion gezogen, große Mengen laufen also über die innere JQL. Ein `--each` über eine Funktion mit 50k Treffern sprengt den `key in`-Ansatz; dort schlägt die Fehlermeldung vor, die Bedingung ins Skript zu verlagern.

## Kritische Dateien

- `packages/script-runtime/src/meta.ts`: `meta.each`, Limit-Semantik
- `packages/script-runtime/src/verbs.ts`: `planScript` → zusätzlich `planItem(js, issue, opts)` mit gemeinsamem Host-Cache; Verben `jira.rest`/`confluence.rest`
- `packages/script-runtime/src/sandbox.ts`: Issue als Argument an den Default-Export; Limit 0 = unbegrenzt
- `packages/script-runtime/src/apply.ts`: Journal-Hook (`onOperation` mit `resolved`), Resume-Startzustand, Scheduler, der `dependsOn` beachtet
- `packages/script-runtime/src/port.ts`, `script-types.ts`: optionale Rest-Ports, Typen für `atlcli.d.ts`
- neu `apps/cli/src/commands/script-jobs.ts`: Job-Store (jsonl), Snapshot, Batch- und Concurrency-Schleife, `resume`/`jobs`
- `apps/cli/src/commands/script.ts`: Flags `--each/--concurrency/--max-items/--max-failures/--resume/--job-dir`, `init --each/--example`, Zusammenfassung in `renderPlan`
- `apps/cli/src/commands/script-port.ts`: Rest-Ports, JQL-Expansion aktivieren
- `packages/jira/src/client.ts`, `packages/confluence/src/client.ts`: `getJson`, Opt-in für JQL-Funktionen in `search`
- neu `packages/jira/src/jql-functions.ts`
- Doku: `docs/…/scripts.md`, `reference/scripts.md`, neue Seite „Große Mengen und Jobs“, JQL-Funktionen in der Jira-Referenz; `skills/atlcli/` im selben PR (Memory „Agent-Skill folgt Verhalten“)
- Spec ablegen unter `specs/script-scale/PLAN.md` (erster Commit)

## Reihenfolge (ein PR, mehrere Commits)

1. `main` aktualisieren (der lokale Stand ist veraltet), Branch `feat/script-scale`, Spec-Datei.
2. (5) JQL-Funktionen: reines Modul plus Tests, danach Opt-in im Client.
3. (3) `getJson` und Rest-Verben plus Tests.
4. B: Limit 0, Zusammenfassung in `renderPlan`, Apply-Journal/Resume, Concurrency mit `dependsOn`.
5. A: `planItem`, Job-Store, `--each`, `resume`, `jobs`.
6. (4) `init --each` und Beispiele.
7. Doku, Skill, Live-E2E.

## Verifikation

- **Unit-Tests** (`bun run test packages/script-runtime …`, nie das nackte `bun test`):
  - Tokenizer und Expansion der JQL-Funktionen (Strings, Escapes, `not in`, leere Menge, Grenzen, Verschachtelung)
  - Pfad-Validierung der Rest-Verben
  - `planItem`-Isolation
  - Apply über Journal/Resume: Absturz nach Op k, dann wird ab k+1 fortgesetzt und Platzhalter werden aufgelöst
  - Scheduler hält die `dependsOn`-Reihenfolge ein
  - Job-Store-Resume überspringt erledigte Keys
  - `--max-failures` bricht ab
- **Skalierungstest ohne Netz:** Fake-Port mit 20.000 Issues, `--each` plus `--apply`, Prüfung von Speicherbedarf (kein Plan im RAM), Laufzeit und korrekten Zählern; dazu ein Abbruch per Signal in der Mitte und anschließendes `resume`.
- **Live-E2E:**
  - **mayflower/ATLCLI:** etwa 50 Temp-Issues anlegen, `--each` mit Labels und `setStatus` planen und anwenden, mittendrin abbrechen, `resume` ausführen, die Issues danach löschen.
  - **kiteweave**, weil Admin und Temp-Projekte erlaubt sind: Lastlauf mit 1.000+ Issues und `--concurrency 8`, dabei 429-Verhalten und Durchsatz beobachten. Anschließend das Projekt löschen.
  - JQL-Funktionen und `rest` gegen beide Sites.
- `bun run typecheck`, API-Report neu erzeugen (`bun scripts/api-report.ts --update`, da sich die öffentliche API von `@atlcli/jira` und `@atlcli/script-runtime` ändert).

## Bewusst weggelassen

- Event-Trigger (Punkt 1) und Run-History als eigenes Feature (Punkt 6); der Job-Store deckt das Nötigste ab.
- Schreibender REST-Zugang.
- Adaptive Drosselung bei 429: Jede Anfrage beachtet Retry-After; eine globale Drosselung kommt erst, wenn der Lastlauf zeigt, dass sie nötig ist (`ponytail:`-Kommentar).
- Data-Center-Live-Test für `--each` (Folgeaufgabe; der Pfad über `port.jiraSearch` bleibt derselbe).
