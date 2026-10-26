# Plan: Scripting-Bündel – REST-Writes, neue Verben, Runtime-Fähigkeiten, `atlcli script test`

## Kontext
Die Lückenanalyse hat ergeben: Ein Skript kann nur, was ein Verb anbietet. `jira.rest`/`confluence.rest` sind nur GET. Viele Jira- und Confluence-Funktionen haben einen Client, aber kein Verb. Die Sandbox kennt keine Imports, kein externes HTTP, keine Secrets, keinen Zustand und keine Dateien. Testen kann man Skripte nur live.

Der User will die Punkte 1–4 und `atlcli script test` als **ein Bündel in einem PR** (Branch `feat/script-bundle`, Spec unter `specs/script-bundle/PLAN.md`).

### Leitprinzip
Alles, was etwas verändert, ist eine **geplante Operation**: im Plan sichtbar, reviewbar, mit Journal und Resume. Das gilt auch für HTTP-POST, Dateischreiben und Zustand-Setzen. Lesen passiert sofort beim Planen. So bleibt `script run` ohne `--apply` frei von Nebenwirkungen.

### Ist-Stand (Kartierung)
Alle Pfade sind relativ zu main.
- **Verben:**
  - Jedes Verb ist ein Eintrag `verb(zod, run)` in `VERBS` (`packages/script-runtime/src/verbs.ts:394`).
  - Writes laufen über `r.record()` (`:347`); zugelassen sind nur Verben aus der geschlossenen Liste `WRITE_VERBS` (`:19`). Preconditions sind eine Union aus 5 Arten (`:54`), Platzhalter haben die Form `plan:<n>`.
  - Apply ist ein `switch(op.verb)` (`apply.ts:~250`); die Reihenfolge ergibt sich aus `TARGET_ARGS`.
  - Die Texte für die Plananzeige stehen in `describeOperation` (`apps/cli/src/commands/script.ts:662`).
- **Plan:** `ScriptPlanV1` (`plan.ts:14`) wird strikt geparst: `verb` muss in `WRITE_VERBS` stehen. Der sha256 geht nur über die Entry-Datei. Es gibt genau ein Ziel `target.baseUrl`.
- **Permissions:** `PERMISSION_PATTERN` (`meta.ts:13`) wird in `Recorder.require` (`verbs.ts:256`) per String-Vergleich geprüft. Ohne `permissions` ist alles erlaubt.
- **Laden:** `transpile()` (`script.ts:465`, als Duplikat in `audit-scripts.ts:31`) entfernt nur die Typen. Der Modul-Loader (`sandbox.ts:199`) lehnt jeden Import ab. Ob eine Datei per-Issue läuft, entscheidet ein `/\beach\b/`-Regex über den Quelltext (`script.ts:150`).
- **Vorbilder:**
  - `confluence.export`: Dateischreiben mit Pfadprüfung beim Planen und beim Apply (`verbs.ts:~880`).
  - Jobs unter `~/.atlcli/jobs/` (`script-jobs.ts:77`).
- **Testdoubles:**
  - `StatefulPort` (`plan-apply.test.ts:11`) und `FakePort` (`verbs.test.ts:8`) liegen in Testdateien und sind nicht exportiert.
  - CLI-Tests nutzen `Bun.serve`-Stubs (`script-cli.test.ts:26`).
- **Typen:** `ATLCLI_SCRIPT_TYPES` ist ein handgeschriebener String (`script-types.ts:6`). `script-types.test.ts:18` und `verbs.test.ts:761` prüfen, dass er zu `SCRIPT_VERBS` passt.
- **Clients:** fast alles existiert schon (Details bei den Verben unten). Es fehlen: Jira-Gruppen, Confluence-Property-Delete, Blogposts, `listSpaces` mit Paginierung. Clone steckt in `handleIssueClone` (`jira.ts:1544`) und lässt sich so nicht wiederverwenden. Die User-Auflösung macht `resolveUser` (`packages/jira/src/input.ts:34`).

---

## 1. Schreibender REST-Ausweg
- Neue Write-Verben:
  - `jira.request(method, path, { body?, query? })`
  - `confluence.request(method, path, { body?, query? })`

  `method` ist einer von `POST | PUT | PATCH | DELETE`; GET bleibt bei `rest`.
- Validierung: dieselbe `restPath`-Prüfung wie `rest` (`verbs.ts:189`), dazu die Präfix-Prüfung auf dem Host (`checkRestPath`).
- Permission:
  - Jira: `jira:write:<P>`, wenn der Pfad einen Projekt- oder Issue-Key enthält (`/issue/ABC-1…`, `/project/ABC…`). Sonst gilt ein neues `jira:write:*`. Das ist ehrlich: beliebige Writes brauchen die volle Freigabe.
  - Confluence: `confluence:write:*`.
- Keine Precondition. Der Rückgabewert ist der Platzhalter `{ id, key }` (`plan:<n>`). Beim Apply wird er mit `id`/`key` aus der Antwort aufgelöst; damit funktionieren Folge-Operationen.
- Client: generisches `requestJson(method, path, body, query)` neben `getJson` in beiden Clients, mit derselben Pfadprüfung. Port: `jiraRequest?` und `confluenceRequest?`.

## 2. Neue Jira-Verben
| Verb | Art | Client (vorhanden) | Precondition |
|---|---|---|---|
| `jira.comments(key)` | read | `getComments` | – |
| `jira.updateComment(key, id, body)` / `deleteComment(key, id)` | write | `updateComment` / `deleteComment` | keine |
| `jira.worklogs(key)` | read | `getWorklogs` | – |
| `jira.addWorklog(key, { timeSpent, started?, comment? })` | write | `addWorklog` | keine |
| `jira.versions(project)` / `components(project)` | read | `getProjectVersions` / `getProjectComponents` | – |
| `jira.createVersion(project, {…})` / `updateVersion(id, { released?, archived?, releaseDate?, name?, description? })` | write | `createVersion` (projectKey → id auflösen) / `updateVersion` | Skip, wenn unverändert |
| `jira.createComponent` / `updateComponent` | write | `createComponent` / `updateComponent` | Skip, wenn unverändert |
| `jira.rank(keys, { before \| after })` | write | `rankIssues` | keine |
| `jira.deleteIssue(key)` | write | `deleteIssue` | issue unchanged (bestehende Art) |
| `jira.clone(key, { summary?, project?, link? })` | write (Producer) | neu `cloneIssue` in `packages/jira`, aus `handleIssueClone` extrahiert; die CLI nutzt es dann auch | keine |
| `jira.links(key)` / `jira.unlink(key, linkId)` | read / write | `getIssue(issuelinks)` / `deleteIssueLink` | keine |
| `jira.fields()` / `jira.fieldId(name)` | read | `getFields`; Namensauflösung wie in `resolveColumns` (`input.ts:313`) | – |
| `jira.users(query)` | read | `searchUsers` + `pickUser`-Regeln | – |
| `jira.attachments(key)` | read | `getIssueAttachments` | – |

Gruppen-Lookup entfällt (es gibt keinen Client dafür). Wer Gruppen braucht, nimmt `jira.rest`.

## 3. Neue Confluence-Verben
| Verb | Art | Client |
|---|---|---|
| `confluence.properties(pageId)` | read | neu `listPageProperties` (v2 `/pages/{id}/properties`, paginiert) |
| `confluence.setProperty(pageId, key, value)` / `deleteProperty(pageId, key)` | write | `upsertPageProperty` / neu `deletePageProperty` |
| `confluence.restrictions(pageId)` / `setRestrictions(pageId, { read?, update? })` | read / write | `getContentRestrictions` / `setContentRestrictions` |
| `confluence.versions(pageId)` | read | `getPageHistory` |
| `confluence.descendants(pageId)` | read (async iterator) | `getPageDescendants` |
| `confluence.spaces({ type?, limit? })` | read (async iterator) | `listSpaces` erweitern: Paginierung |
| `confluence.inlineComments(pageId)` | read | `getInlineComments` |
| `confluence.createBlogPost({ space, title, markdown })` / `getBlogPost(id)` | write (Producer) / read | neu: v2 `/blogposts` |

Writes nutzen `confluence:write:<space>`; der Space wird wie bei den vorhandenen Seiten-Verben aus der Seite ermittelt.

## 4. Runtime-Fähigkeiten

### 4a. Imports
- Relative Imports (`./util.ts`) bündelt der Host mit `Bun.build` (`target: "browser"`, `format: "esm"`) vor dem Transpilieren.
  - Ein Plugin lehnt nicht-relative Imports (Pakete, `node:`) mit klarer Meldung ab. Ebenso Pfade außerhalb des Skriptverzeichnisses.
- Neues Modul `script-source.ts` mit `loadScriptSource(path) → { entrySource, bundle, files[], sha256 }`. Es ersetzt beide `transpile()`-Kopien, auch für Audit-Regel-Skripte.
  - `meta` und die `each`-Erkennung kommen weiter aus der **Entry**-Datei.
  - `sha256` geht über alle gebündelten Dateien (sortiert nach Pfad und Inhalt). Damit erkennt `apply` Änderungen auch in Hilfsdateien.
- Die Sandbox bleibt unverändert: Sie bekommt ein einziges Modul `script`.
- `script check` lässt `tsc` über die Entry-Datei samt Imports laufen. Die tsconfig-`include` wird auf `**/*.ts` erweitert.

### 4b. Externes HTTP: `atlcli.http`
- `http.get(url, { headers?, query? })` ist read und läuft sofort. Die Antwort kommt als `{ status, headers, json?, text }`, maximal 5 MB.
- `http.request(method, url, { headers?, body?, json? })` ist write und wird geplant; die Antwort landet im Journal.
- Permission `http:<host>` ist **Pflicht**: Ohne Eintrag in `meta.permissions` gibt es kein HTTP, anders als bei Atlassian.
  - Nur `https:`; `http:` nur für localhost.
  - Die Allowlist wird bei jedem Redirect erneut geprüft. Kein Zugriff auf private IP-Bereiche außer localhost.
- Port: `httpFetch?` mit Timeout pro Aufruf. GETs zählen zu `maxHostCalls`.
- Plan: Die Operation trägt die URL als Ziel. `target.baseUrl` bleibt das Atlassian-Ziel, HTTP-Operationen gelten als unabhängig davon.

### 4c. Secrets: `atlcli.secret(name)`
- Gibt dem Skript **nie den Wert**, sondern den Platzhalter `secret:<NAME>`.
- Den Wert setzt der Host erst ein, und zwar nur in Headers, URL und Body von `http.get` und `http.request`: bei GET beim Planen, bei request erst beim Apply.
- Plan, Journal, Logs und Testfixtures enthalten so nur den Namen.
- Quelle: nur die Umgebungsvariable `ATLCLI_SECRET_<NAME>` (Entscheidung des Users). Keine Datei, kein Keychain.
- Die verwendeten Namen werden in `meta.secrets: ["SLACK_WEBHOOK"]` deklariert. Ein nicht deklarierter Name oder ein fehlender Wert bricht vor dem Lauf mit Fehler ab.

### 4d. Zustand zwischen Läufen: `atlcli.state`
- `state.get(key)` ist read.
- `state.set(key, value)` und `state.delete(key)` sind write und werden geplant. Ein Dry-Run verändert den Zustand also nicht.
- Speicher: `~/.atlcli/state/<meta.name oder Dateiname>.json`. JSON-Werte, insgesamt maximal 1 MB. Geschrieben wird atomar (tmp + rename).
- Preconditions: Skip, wenn der Wert gleich ist. Neue Precondition-Art `state unchanged` (der Wert beim Planen). Läuft ein anderer Lauf dazwischen, kommt Drift wie bei Issues.

### 4e. Dateien: `atlcli.files`
- `files.read(path, { encoding? })` ist read und läuft sofort. Dazu `files.list(dir)`.
- `files.write(path, content, { encoding? })` ist write und wird geplant.
- Pfade sind relativ zum Arbeitsverzeichnis. Keine absoluten Pfade, kein `..` aus dem Arbeitsverzeichnis heraus, keine Symlinks nach außen. Die Prüfung entspricht `checkExportPath` und läuft beim Planen und beim Apply.
- Permissions: `file:read`, `file:write`.
- Ein CSV-Helfer wird **nicht** eingebaut: Der Parser ist ein Einzeiler bzw. kommt per Import als eigene Hilfsdatei.

### Gemeinsame Anpassungen für 4b–4e
- `PERMISSION_PATTERN` und der Typ erweitern um: `http:<host>` (Wildcard `*.example.com`), `file:read`, `file:write`, `jira:write:*`, `confluence:write:*`.
- `require` bekommt für Hosts eine Matcher-Funktion statt `includes`.
- `WRITE_VERBS` erweitern um: `jira.request`, `confluence.request`, `http.request`, `files.write`, `state.set`, `state.delete` sowie alle neuen Write-Verben aus 2 und 3.
- Nachziehen: die `execute`-Fälle, `TARGET_ARGS` (Ziel: URL, Datei bzw. State-Key) und `describeOperation`.
- Das Planformat bleibt `atlcli.script-plan/1`. Neue Verben erweitern es nur. Ältere CLIs lehnen solche Pläne ab; das ist korrekt.

---

## 5. `atlcli script test`
Die Tests arbeiten mit **Aufnahme und Wiedergabe auf Port-Ebene** sowie **Plan-Snapshots**. Es gibt keine Fake-Logik pro Verb.

- **Testdatei:** `<script>.test.json` neben dem Skript:
  ```json
  { "cases": [ { "name": "closes parent", "params": {}, "each": "ATLCLI-12", "now": "2026-10-26T09:00:00Z",
                 "fixture": { "calls": [ { "method": "jiraGetIssue", "args": [...], "result": {...} } ], "state": {}, "files": {} },
                 "expect": { "operations": [...], "skipped": [...], "value": ... } } ] }
  ```
- **`atlcli script test <script.ts> [--case <name>]`** führt jeden Fall aus:
  - mit einem `ReplayPort`, der Port-Aufrufe aus `fixture.calls` beantwortet (Schlüssel: Methode plus kanonische Argumente);
  - mit gefrorener Uhr (`now`) und einem Zustand/Dateien-Overlay im Speicher.

  Dann vergleicht es die Operationen, `skipped` und `value` mit `expect`. Bei Abweichung wird ein Diff ausgegeben und der Exit-Code ist 1.
  - Ein Aufruf, der nicht in der Fixture steht, ist ein Fehler, und die Meldung nennt den Aufruf.
- **`--record <case> [--param …] [--each KEY]`:** läuft einmal live (nur lesend, es wird nie angewendet). Ein `RecordingPort` umhüllt den echten Port und schreibt Fixture und Erwartung in die Testdatei.
  - Secrets bleiben Platzhalter.
  - Die Antworten von `http.get` werden mit aufgenommen.
- **`--update`:** schreibt die Erwartungen aller Fälle aus dem aktuellen Ergebnis neu, wie ein Snapshot-Update.
- **Optional:** Exportiert das Skript `export function test(plan)`, wird sie nach jedem Fall aufgerufen und darf mit `throw` fehlschlagen. Das ist für eigene Prüfungen ohne Snapshot gedacht.
- **`--json`:** liefert das Ergebnis pro Fall. Mehrere Skripte: `atlcli script test dir/` findet alle `*.test.json`.
- **Implementierung:** `RecordingPort` und `ReplayPort` sind generische Proxies über die Methoden von `ScriptPort` und liegen in `packages/script-runtime/src/fixture-port.ts` (exportiert). `runScript` bekommt den Port bereits als Parameter, das CLI baut nur ein anderes Port-Objekt.

---

## Kritische Dateien
- **Runtime:** `packages/script-runtime/src/{verbs,apply,plan,meta,port,sandbox,script-types}.ts`; neu `fixture-port.ts`
- **CLI:** `apps/cli/src/commands/{script,script-port,script-jobs,audit-scripts,jira}.ts`; neu `script-source.ts` (Bundling) und `script-test.ts`
- **Clients:**
  - `packages/jira/src/client.ts`: `requestJson`, `cloneIssue` (aus `jira.ts:1544`)
  - `packages/confluence/src/client.ts`: `requestJson`, `listPageProperties`, `deletePageProperty`, Blogposts, `listSpaces` mit Paginierung
- **Doku:** `src/content/docs/reference/scripts.md` (Verben, Permissions, http/secret/state/files, Imports), `scripts.md` (Guide, neuer Abschnitt Testing), Skill `skills/atlcli/references/scripts.md`, CHANGELOG
- **API-Reports und Closures** für `jira`, `confluence` und `script-runtime` neu erzeugen.

## Reihenfolge (ein PR, Commits je Schritt)
1. Spec nach `specs/script-bundle/PLAN.md`
2. Permissions und Plan-Erweiterungen (Grammatik, `WRITE_VERBS`, Precondition `state`, `describeOperation`)
3. REST-Writes (Client `requestJson`, Verben, Apply)
4. Jira-Verben (inklusive `cloneIssue`-Extraktion; der CLI-Clone nutzt es)
5. Confluence-Verben inklusive neuer Client-Methoden
6. Imports (`script-source.ts`, sha256, check/tsconfig, Audit-Skripte)
7. `files`, `state`, `http`, `secret`
8. `script test` (Fixture-Ports, Record/Replay/Update, eigener `test`-Export)
9. Typen (`ATLCLI_SCRIPT_TYPES`), Beispiele (z. B. „release version and post to Slack“, „worklog report to CSV“), Doku, Skill, CHANGELOG, API-Reports

## Entscheidungen (User)
- Secrets nur aus Env-Variablen `ATLCLI_SECRET_<NAME>`.
- `script test` arbeitet mit Record/Replay und Plan-Snapshots, dazu optional ein eigener `test(plan)`-Export.
- `http.get` liest beim Planen sofort, aber nur Hosts aus der Allowlist. HTTP-Writes werden immer geplant.

## Verifikation
- **Unit:**
  - pro Verb Planen und Apply gegen `StatefulPort`
  - Permission-Matrix (`http:*.x.com`, `jira:write:*`, `file:*`)
  - Pfad-Escape (`..`, absolut, Symlink)
  - Redirect auf einen fremden Host wird abgelehnt
  - Secret-Wert erscheint nie in Plan, Journal, stdout oder Fixture
  - State: atomares Schreiben und Drift
  - Imports: relativ ok, Paket abgelehnt, Escape abgelehnt; sha256 ändert sich bei geänderter Hilfsdatei
  - `script test`: Replay grün, Abweichung rot mit Diff, fehlender Aufruf, `--update`, `--record` gegen den CLI-Stub
- **CLI-Stub-Tests** (`Bun.serve`) für `request`, `http` (lokaler Server) und `files`/`state` mit Journal und Resume.
- **Live:**
  - mayflower/ATLCLI: Kommentare lesen, bearbeiten und löschen; Worklog; Version anlegen und releasen, danach löschen; Rank; Clone und `deleteIssue` an Temp-Issues; `jira.request` (z. B. `POST /rest/api/3/version`)
  - DOCSY: Properties setzen und löschen, Restrictions, Descendants, Blogpost anlegen und wieder löschen
  - `http` gegen einen lokalen Echo-Server mit Secret
  - `script test --record` gegen ATLCLI, danach Replay offline
  - Alle Testressourcen anschließend löschen.
- `bun run typecheck`, `bun run test`, API-Report und Closure. Merge nur auf Go.
