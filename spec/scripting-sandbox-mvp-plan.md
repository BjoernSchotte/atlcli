# Script-Runtime MVP: Implementierungsplan (nur atlcli)

Stand: 2026-10-24, Basis `origin/main` `18f5007c`. Spec: [scripting-sandbox.md](./scripting-sandbox.md).
Forge ist bewusst ausgeklammert. Die Runtime bleibt trotzdem browser-sicher, damit der
Forge-Host später nur einen Port liefern muss.

## Inhalt

- [MVP-Schnitt](#mvp-schnitt)
- [Andockpunkte im Code](#andockpunkte-im-code)
- [Paketzuschnitt](#paketzuschnitt)
- [Tasks](#tasks)
- [Abnahme](#abnahme)
- [Bewusst ausgelassen](#bewusst-ausgelassen)
- [Offene Fragen](#offene-fragen)

## MVP-Schnitt

- **Befehle:** `atlcli script init | check | run | apply`.
- **Verben:**
  - `atlcli.jira.{search, get, create, update, transition, comment}`
  - `atlcli.confluence.{search, getPage, createPage, updatePage, upsertPage, addLabels}`
  - `atlcli.{log, params, host}`
- **Plan/Apply:** Dry-Run ist Standard, `--plan-out` schreibt den Plan, `apply` ist an Digest
  und Vorbedingungen gebunden.
- **Typisierung:** `atlcli.d.ts` plus `tsconfig` mit `erasableSyntaxOnly`. Damit genügt reines
  Type-Stripping: Bun.Transpiler in der CLI, später sucrase im Browser, ohne Verhaltensdrift.

## Andockpunkte im Code

| Was | Wo |
|---|---|
| Befehls-Dispatch | `apps/cli/src/index.ts` (`switch`), `apps/cli/src/root-commands.ts` |
| Profil und Auth | `loadConfig`/`getActiveProfile` (`packages/core/src/config.ts`), `assertCliAuthSupported` (`apps/cli/src/commands/session-guard.ts`), Muster in `digest.ts:296–381` |
| Ausgabe und Fehler | `output`/`fail` (`packages/core/src/utils.ts:165,178`) |
| Jira | `JiraClient.search` (Token-Paging, `client.ts:1152`), `getIssue`, `createIssue`, `updateIssue`, `getTransitions`/`transitionIssue`, `addComment` |
| Confluence | `getPage` (liefert `storage` und Version), `search`, `createPage`, `updatePage({version})`, `addLabels` |
| Konvertierung | `markdownToStorage`/`storageToMarkdown` (`packages/confluence/src/markdown.ts`) |
| Digest und kanonisches JSON | `canonicalJsonV1`, `digestCanonicalJsonV1` (`@atlcli/change-set`, browser-sicher) |
| QuickJS | `quickjs-emscripten-core@0.32.0` (im Lockfile vorhanden) |
| Browser-Gate | Entry-Liste in `scripts/check-browser-build.ts:71ff` |
| API-Report | `scripts/api-report.ts`, `packages/*/etc/*.api.md` |

## Paketzuschnitt

```
packages/script-runtime/          isomorph, im Browser-Gate
  src/sandbox.ts       QuickJS-Lifecycle, Limits, Promise-Brücke, Marshalling
  src/meta.ts          meta-Export auslesen + validieren
  src/verbs.ts         Verb-Registry: Schema, read|write, Permission, Vorbedingung
  src/plan.ts          Plan-Schema atlcli.script-plan/1, Digest, Parse
  src/apply.ts         Vorbedingungen prüfen, Ops ausführen, Platzhalter auflösen
  src/port.ts          ScriptPort-Interface (operationsbasiert)
  src/index.ts
  types/atlcli.d.ts    Skriptautoren-Typen (wird von script init kopiert)
apps/cli/src/commands/script.ts        Befehl
apps/cli/src/commands/script-port.ts   ScriptPort über JiraClient/ConfluenceClient
```

**Port auf Operationsebene, nicht auf Request-Ebene.** Die Spec sah zunächst vor, dass die
Verben Raw-Requests bauen. Das würde die Client-Logik (Paging, Fehlerformen, ADF) duplizieren.
`ScriptPort` beschreibt deshalb Operationen wie `jiraSearchPage`, `jiraGetIssue` oder
`confluenceGetPage`, die Markdown und Version liefern. Die CLI implementiert sie über die
bestehenden Clients, der spätere Forge-Host über `requestConfluence`.

Die Markdown-Konvertierung sitzt im Adapter. `ponytail:` Damit konvertiert jeder Host selbst.
`packages/confluence/src/markdown.ts` und `packages/jira/src/client.ts` stehen bereits im
Browser-Gate. Die Konvertierung kann also in die Runtime wandern, sobald der zweite Host kommt.

## Tasks

Jeder Task wird per TDD umgesetzt und endet mit einem eigenen Commit.

### T1: Paketgerüst

- `packages/script-runtime` nach dem Muster von `packages/change-set`: package.json mit
  `development`-Condition, tsconfig, tsconfig.build.
- Den Entry in die Liste von `check-browser-build.ts` und in `api-report` aufnehmen.
- Dependencies: `quickjs-emscripten-core@0.32.0` sowie die WASM-Variante (siehe Offene Fragen),
  beide exakt gepinnt.
- **Check:** `bun scripts/check-browser-build.ts` und `bun run typecheck` laufen grün.

**Umgesetzt (T1):** Das Paket ist `private` wie `import-docx` und deshalb noch nicht im
API-Report. Die öffentliche Skript-API ist `atlcli.d.ts` (T8), nicht der Paket-Export. Für
`build` gilt `lib: ES2022, DOM, ESNext.Disposable` ohne Node- oder Bun-Typen. Der Debug-Build
(`@jitl/quickjs-ng-wasmfile-debug-sync`) ist eine Dev-Dependency für die Leak-Erkennung.

### T2: Sandbox-Kern

**Umgesetzt:** `runScript(js, { host, params, limits, onLog, variant })`. Die Verb- und
Plan-Felder (`mode`, `ops`) kommen mit T4. Erkenntnisse aus dem Debug-Build:

- Das Ergebnis meldet der Guest synchron über `done(ok, payload)` zurück, nicht über
  `ctx.resolvePromise`. `resolvePromise` hält Host-Handles fest, die bei einem frühen Abbruch
  (Deadline oder Limit) lecken bzw. nach dem Dispose noch benutzt werden.
- `deferred.resolve/reject` übernehmen den Wert-Handle nicht; er muss selbst freigegeben werden.
- Host-Fehler gehen als JSON-String über die Grenze, und der Guest baut daraus einen `Error`
  mit explizitem `stack`. Ein lazy erfasster Stack eines im Promise-Job erzeugten Errors hat
  sonst die Leak-Assertion im Debug-Build ausgelöst.
- Nach OOM wird die WASM-Instanz verworfen (`ponytail:` grob, aber sicher).

Signatur:

```
runScript(js, { port, limits, params, mode, onLog }) → { result, logs, ops }
```

- Eine Runtime pro Lauf, Freigabe in `finally`.
- Limits: `setMemoryLimit`, `setMaxStackSize` und eine Interrupt-Deadline.
- Host-Funktionen geben `ctx.newPromise()` zurück; nach dem Resolve läuft `executePendingJobs()`.
- Zusätzlich hat jeder Host-Call ein eigenes Timeout und einen `AbortSignal`, und die Zahl der
  Calls ist gedeckelt (`maxCalls`).
- Marshalling geht ausschließlich über JSON: `dump` → validieren → `JSON.parse`, in die
  Gegenrichtung `ctx.newString(JSON.stringify)` + `JSON.parse` im Guest.
- `atlcli` wird per `Object.freeze` eingefroren. Es gibt kein `fetch`, `process` oder `require`.
- Modul-Loader: nur die Skriptdatei selbst; Imports schlagen fehl.

Tests mit echtem QuickJS:
- Rückgabewert kommt korrekt an.
- `Promise.all` über zehn Calls läuft tatsächlich parallel (maximale gleichzeitige Calls im
  Fake-Port messen).
- Eine Endlosschleife wird abgebrochen; eine Speicherexplosion wird abgebrochen.
- Ein hängender Host-Call endet per Timeout.
- Ein Host-Fehler kommt als Guest-Exception an.
- `globalThis.fetch` ist `undefined`, `atlcli` lässt sich nicht verändern.
- Imports werden abgelehnt.
- Nach jedem Test meldet der Debug-Build keine Handle-Leaks.

### T3: meta und Parameter

- Das Modul wird in einer Sandbox ohne Port ausgewertet (Host-Calls werfen), dann werden
  `meta` und die Default-Export-Funktion gelesen.
- `meta` wird mit einem zod-Schema validiert:
  - `name`
  - `permissions` im Format `jira:read`, `jira:write:<PROJECT>`, `confluence:read`,
    `confluence:write:<SPACE>`
  - `limits.maxWrites`
  - `params` (Typ `number|string|boolean`, Default)
- `--param k=v` wird gegen die `params` geparst.
- **Tests:** Fehlt `meta` oder ist es ungültig, entsteht ein klarer Fehler. Unbekannte und falsch
  typisierte Parameter werden abgelehnt.

### T4: Verben, Permissions, Plan-Recorder

Jedes Verb ist ein Registry-Eintrag mit `{ name, kind, schema, permission(args), precondition?, execute(port, args) }`.

- Die Permission-Prüfung läuft vor jedem Call, Default ist deny. Bei Writes leitet sich das
  Projekt bzw. der Space aus den Argumenten ab, bei `update` und `transition` aus dem Issue-Key.
- Search-Verben sind Async-Iteratoren im Guest. Ein Guest-Shim ruft dafür seitenweise
  `__page(token)` auf.
- **Dry-Run:** Reads laufen live. Writes werden als Operation aufgezeichnet, zusammen mit ihrer
  Vorbedingung:

  | Verb | Vorbedingung |
  |---|---|
  | Confluence-Seite ändern | `version.number` |
  | Jira-Issue ändern | `fields.updated` |
  | `upsertPage` | beim Planen auf create oder update aufgelöst, dazu `absent` bzw. Version |

- Ein Write gibt einen Platzhalter zurück (`{ id: "plan:<n>", key: "plan:<n>" }`). Spätere
  Operationen, die ihn verwenden, tragen `dependsOn`.
- Reads auf Platzhalter liefern einen klaren Fehler („im Plan erzeugt, erst nach Apply lesbar“).
- `maxWrites` wird erzwungen.
- **Tests:**
  - Permission deny und allow.
  - Projekt aus dem Issue-Key ableiten.
  - Pagination über drei Seiten.
  - Platzhalterkette `createPage` → `createPage(parentId)`.
  - Das Write-Limit greift.

**Umgesetzt (T3+T4).** Abweichungen und Präzisierungen gegenüber oben:

- **`meta` und Parameter:** Sie werden nicht in einem eigenen Lauf gelesen. Die Sandbox ruft
  nach dem Laden des Moduls synchron `prepare(meta)` auf, und dessen Rückgabe wird zum Argument
  des Default-Exports. `atlcli.*` ist auf Modul-Top-Level gesperrt, damit kein Code vor der
  Validierung handelt.
  - `inspectScript` nutzt denselben Weg mit `callDefault: false`.
  - `meta` ist `strict`: Unbekannte Keys sind Fehler (Schutz vor Tippfehlern). `meta.hosts`
    entfällt bis zum zweiten Host.
- **Verben:**
  - `atlcli.log`, `atlcli.params` und `atlcli.host` entfallen. `console.*` und das
    Default-Export-Argument decken beides ab.
  - `jira.transition(key, to)` hat keine `comment`-Option; dafür gibt es `jira.comment`.
  - Transitions werden schon beim Planen gegen die verfügbaren geprüft.
  - Search-Verben nehmen `{ limit }` und sind Async-Iteratoren über einen Guest-Wrapper
    (Sandbox-Option `wrappers`).
- **Permissions:**
  - Eine Verweigerung, eine Überschreitung von `maxWrites` (Default 100) und jedes
    `ScriptError` aus einem Host-Verb beenden den Lauf, auch wenn das Skript den Fehler fängt.
  - Kaputte Argumente und ein unbekannter Issue-Key sind dagegen fangbare Fehler.
- **Mehrfach-Writes auf dasselbe Objekt:**
  - Nur der erste Write trägt eine Vorbedingung. Spätere Writes hängen per `dependsOn` am
    vorherigen, sonst würde Apply am eigenen ersten Write scheitern.
  - Wird dieselbe Seite zweimal per `createPage` angelegt, ist das ein Fehler.
  - `upsertPage` erkennt Seiten, die im Plan angelegt wurden, und aktualisiert dann den
    Platzhalter.
- **Grenze:** Reads im Dry-Run sehen den Stand vor allen geplanten Writes. Das wird in T9
  dokumentiert.

### T5: Plan-Datei

Schema `atlcli.script-plan/1`. Inhalt:

- Skript: Pfad, SHA-256 der Quelle, `meta`
- Parameter
- Ziel: Site-`baseUrl` und Profilname, keine Credentials
- Operationen mit Vorbedingungen und `dependsOn`
- Logs (gekürzt)

Kanonisches JSON wird über `digestCanonicalJsonV1` in einen `digest` überführt. Die Funktion
`parseScriptPlanV1` prüft Schema, Digest und Größenbudget.

**Tests:**
- Roundtrip.
- Eine manipulierte Operation führt zu einem Digest-Fehler.
- Credentials gelangen nie in den Plan.

### T6: Apply

Ablauf:
1. Plan parsen.
2. Prüfen, dass die `baseUrl` zum aktiven Profil passt.
3. Alle Vorbedingungen vorab prüfen. Bei Drift wird abgebrochen, bevor auch nur eine Operation
   geschrieben ist.
4. Operationen in Reihenfolge ausführen und Platzhalter durch echte IDs ersetzen.
5. Beim ersten Fehler stoppen und einen Bericht ausgeben: ausgeführt, fehlgeschlagen, offen.

`ponytail:` Zwischen Prüfung und Write besteht ein Race-Fenster. Confluence `updatePage` mit
`version` scheitert dabei hart, das genügt. Bei Jira gibt es keinen atomaren Check; das wird
dokumentiert.

**Tests:**
- Drift bei Seite und Issue.
- Falsche Site.
- Teilfehler mit Bericht.
- Platzhalter-Auflösung.

**Umgesetzt (T5+T6).**

- `createScriptPlan`, `serializeScriptPlan` und `parseScriptPlan` liegen in `plan.ts`,
  `applyScriptPlan` in `apply.ts`.
- Die Plan-Datei ist kanonisches JSON, gleiche Pläne ergeben also gleiche Bytes. Der Digest
  läuft über alle Felder außer `digest`. Damit fällt auch ein manipuliertes `target` auf.
- Die Konsistenz wird vor dem Digest geprüft: `seq` ist fortlaufend, `dependsOn` verweist nur
  auf frühere Operationen.
- Die Logs des Laufs stehen **nicht** im Plan. Sie sind nicht reviewrelevant und würden
  harmlose Unterschiede erzeugen; die CLI gibt sie direkt aus.
- Apply ergibt `applied`, `drift` (nichts geschrieben) oder `failed` (bis zum Fehler
  geschrieben, der Rest übersprungen). Konnte eine Vorbedingung nicht gelesen werden, zählt
  das als Drift.
- Für `updatePage` kommt die Version aus der Vorbedingung bzw. aus dem Ergebnis des
  vorherigen Writes im selben Apply. So läuft z. B. `updatePage` gefolgt von `upsertPage` auf
  dieselbe Seite als 7 → 8 → 9 durch.

### T7: CLI-Port-Adapter

`script-port.ts` implementiert `ScriptPort` über `JiraClient` und `ConfluenceClient`:

- Markdown ↔ Storage
- Transition per Name über `getTransitions`
- Confluence-Search mit Cursor

Rate-Limit: Die vorhandene Retry- und Backoff-Logik der Clients wird geprüft. Fehlt sie, kommt
ein einfacher Concurrency-Limiter dazu (Default 4, per `--concurrency` einstellbar).

**Tests:** gegen aufgezeichnete Fixtures, im Muster der bestehenden Client-Tests.

### T8: Befehl `atlcli script`

- `init [dir]` schreibt `atlcli.d.ts` und eine `tsconfig.json` mit `strict`,
  `erasableSyntaxOnly`, `noEmit` und `types: ["./atlcli.d.ts"]`. Vorhandene Dateien werden nicht
  überschrieben, es sei denn mit `--force`.
- `check <file>` startet `tsc --noEmit -p` als Subprozess (TS 7 hat keine API) und validiert `meta`.
- `run <file> [--param] [--plan-out] [--apply [--yes]] [--json]` übersetzt per Bun.Transpiler
  (`loader: "ts"`) und führt das Skript aus. Ausgegeben wird eine Plan-Zusammenfassung mit Ops
  pro Verb und je einer Zeile pro Operation. `--apply` fragt interaktiv nach; ohne TTY ist
  `--yes` Pflicht.
- `apply <plan.json> [--yes] [--json]`.
- Hilfetexte, Shell-Completion und `ROOT_COMMANDS` werden ergänzt.
- **Tests:** CLI-Tests im Muster von `jira-board-cli.test.ts`, inklusive Exit-Codes.

**Umgesetzt (T7+T8), inklusive DX-Umbau:**

- **Skript-Vertrag vereinfacht** (Wunsch: so wenig Boilerplate wie möglich):
  - Der Modul-Body ist das Skript, `atlcli.*` funktioniert auf Top-Level.
  - `meta` ist optional und wird statisch vor der Ausführung gelesen (`extractScriptMeta`).
    Damit entfallen der `prepare`-Hook und die Sperre auf Top-Level-Ebene.
  - `atlcli.params` ist eingebaut.
  - Ohne `permissions` ist alles erlaubt; Writes laufen weiterhin nur über Plan/Apply.
- **Engine:** quickjs-ng **asyncify** statt sync. quickjs-ng hat keinen Single-File-Build, und
  beide Varianten erwarten `emscripten-module.wasm` neben dem Bundle. Die CLI liefert die
  asyncify-WASM bereits aus (`apps/cli/build-assets.ts`), also bleibt es bei einer Engine.
  - Die Promise-Brücke und damit echtes `Promise.all` bleibt erhalten, weil keine
    asyncified Host-Funktionen genutzt werden.
  - Die Leak-Tests laufen weiter auf dem ng-Debug-Build (sync); die Sandbox akzeptiert beide
    Modularten.
- **Patch:** `quickjs-emscripten-core@0.32.0` meldet asyncify-Runtimes vor `QTS_FreeRuntime`
  ab. Host-Funktionen, die erst beim Teardown-GC freigegeben werden, warfen dann „QuickJSRuntime
  not found when trying to free HostRef“. Behoben über `patches/`, Regressionstest in
  `sandbox.test.ts`.
- **Plan-Referenzen in Texten:** `plan:<n>` wird auch innerhalb von Strings aufgelöst und in
  `dependsOn` erfasst (z. B. eine Seite, die ein neues Issue nennt). Nur Referenzen auf
  erzeugende Operationen (`jira.create`, `confluence.createPage`) werden ersetzt; anderer Text
  bleibt unverändert.
- **CLI:** `atlcli script run <file> | -e <code>`, `--param`, `--plan-out`, `--apply`, `--yes`,
  `--json`, außerdem `apply`, `check` (Validierung von `meta` plus `tsc --noEmit`, falls `tsc`
  vorhanden ist) und `init` (`atlcli.d.ts`, `tsconfig.json` mit `moduleDetection: force`,
  `example.ts`).
  - Exit-Code 2 bei Drift.
  - `--apply` ohne Terminal oder mit `--json` verlangt `--yes`.
- **Live-E2E (mayflower, DOCSY/ATLCLI):**
  - Lesezugriff aus dem gebauten `dist/`.
  - Plan und Apply mit 7 Operationen (Issue anlegen, kommentieren, transitionieren; zwei
    Seiten in Hierarchie, Label, Upsert): alles verifiziert, danach gelöscht.
  - Drift live geprüft: Exit 2, nichts geschrieben.
  - Teilfehler live gesehen: Die Transition „Done“ gibt es im deutschen Workflow nicht
    („Fertig“). Der Stopp war sauber, die Fehlermeldung nennt jetzt die verfügbaren
    Transitions.
- **Bekannte Grenze:** Transitions für Issues, die erst im Plan angelegt werden, lassen sich
  beim Planen nicht prüfen. Das wird in T9 dokumentiert.

### T9: Doku, Skill, E2E

- **Doku:** `docs/` bekommt einen Feature-Guide (Erstes Skript, Plan/Apply, CI-Rezept mit
  GitHub Actions: Plan als Artefakt im PR, Apply nach Merge) und eine Referenz (Verben,
  `meta`-Felder mit Typ, Default und Constraints, Limits, Exit-Codes). Dazu ein Abschnitt
  Troubleshooting.
- **Skill:** In `skills/atlcli/` kommt ein Abschnitt dazu, wie man Skripte schreibt und ausführt.
- **Live-E2E** mit Profil `mayflower`, nur in Space `DOCSY` und Projekt `ATLCLI`. Die Testressourcen
  werden danach gelöscht und im PR aufgelistet.
  1. Ein Skript legt ein Issue an, kommentiert und transitioniert es: Plan, dann Apply.
  2. Ein Skript legt per `upsertPage` eine Release-Notes-Seite an, ein zweiter Lauf aktualisiert
     sie.
  3. Drift-Test: Die Seite wird zwischen Plan und Apply manuell geändert; Apply muss abbrechen.
  4. Ein Endlosschleifen-Skript wird abgebrochen.

**Umgesetzt (T9):**

- **Doku:**
  - Guide `src/content/docs/scripts.md`: erstes Skript, Skripte schreiben, Plan/Apply,
    `meta`, Editor und Typecheck, Beispiele, Limits, Troubleshooting.
  - Referenz `reference/scripts.md`: Befehle und Flags, Globals, `meta` mit Typ, Default und
    Constraints, Verben, Platzhalter, Vorbedingungen, Limits, Plan-Datei, JSON-Formate,
    Exit-Codes.
  - Rezept `recipes/scripts-in-ci.md`: Plan als PR-Artefakt, Apply des freigegebenen
    Artefakts per `workflow_dispatch` mit Environment-Approval, wöchentliche Routine mit
    `permissions` und `maxWrites`.
  - Dazu: Sidebar, `cli-commands.md#scripts`, Rezept-Übersicht und Related Topics.
  - Statt „Apply nach Merge“ wendet das CI-Rezept das *geprüfte Artefakt* an. Ein frischer
    Lauf nach dem Merge würde nicht genau das ausführen, was im Review stand.
- **Doku-Beispiele geprüft:**
  - Alle 12 TypeScript-Blöcke der drei Seiten bestehen den Typecheck gegen die generierte
    `atlcli.d.ts`. Dabei fiel auf, dass `ScriptMeta.name` und `.permissions` dort noch
    Pflichtfelder waren; das ist korrigiert.
  - Das Release-Notes-Beispiel lief live unverändert, nur mit Space `DOCSY` statt `DOCS`:
    temporäre Fix-Version und temporäres Issue (beides per Skript angelegt), dann Anlegen,
    Labeln und ein zweiter Lauf als Upsert.
  - Das Minimal-Beispiel lief live.
  - Alle Testressourcen sind gelöscht.
- **Live-Szenarien 1–3:** abgedeckt durch die T7/T8-E2E. Szenario 4 (Endlosschleife) lief
  aus dem gebauten CLI.
- **Follow-ups (umgesetzt am 2026-10-24):**
  - **Inhaltsgleiche Updates:**
    - Der Port hat jetzt `confluenceNormalizeMarkdown`, also den Rundweg Markdown → Storage →
      Markdown des Hosts.
    - Das erste `updatePage`/`upsertPage` auf eine Seite wird übersprungen, wenn Titel und
      normalisierter Body gleich sind. Es landet dann in `plan.skipped` und erscheint in der
      Ausgabe unter „Unchanged, not planned“.
    - Spätere Writes auf eine im Plan schon geänderte Seite bleiben immer erhalten, sonst ginge
      A → B → A verloren.
    - Live gegen Confluence geprüft mit Tabelle, Codeblock und Link: Der identische Re-Run
      plant nichts.
    - Für Jira-Updates und Labels gibt es keinen No-op-Vergleich; dafür würden zusätzliche
      Reads gebraucht.
  - **Limits per Flag:** `--timeout` (Dauer), `--max-writes` (gewinnt über
    `meta.limits.maxWrites`), `--max-calls`, `--memory <MB>`. Fest bleiben der Stack und das
    60-s-Timeout pro Call.
  - **Doku-Fehler zu Umgebungsvariablen korrigiert:**
    - Betroffen: `reference/environment.md`, `authentication.md`, `configuration.md`, die
      Rezepte `ci-cd-docs.md` (`wiki docs push`) und `sprint-reporting.md`.
    - Kern: Umgebungsvariablen ersetzen kein Profil. `auth login` liest `ATLCLI_SITE` und
      `ATLCLI_EMAIL`, zur Laufzeit wirkt nur `ATLCLI_API_TOKEN`; Ausnahme ist der profilfreie
      `wiki export`.
    - Außerdem stand in `authentication.md` eine nicht existierende `credentials.json`.
    - Gegen einen Stub verifiziert: ohne Login „No active profile“, `auth login` liest die
      Variablen ohne Rückfrage, danach läuft der Befehl.
  - **Offen:** Data Center live verifizieren.

## Abnahme

- `bun run test`, `bun run typecheck`, das Browser-Gate und `api-report --check` laufen grün.
- Die vier E2E-Szenarien laufen live grün, die Ressourcen sind aufgeräumt.
- Ein Skript aus dem Feature-Guide läuft unverändert per Copy & Paste.

## Bewusst ausgelassen

| Was | Wann nachziehen |
|---|---|
| `atlcli.fs`, relative Imports | wenn das erste reale Skript Hilfsmodule braucht |
| `jira.link`, Confluence-Kommentare, `labels.remove` | nach Nachfrage, je ein Registry-Eintrag |
| Semantischer Diff im Plan (Change-Set-Matcher für Seiteninhalt) | wenn Pläne mit Seiten-Updates schwer reviewbar sind |
| Extension-Host | Phase 2 |
| Forge-Host, sucrase | Phase 3 |
| Monaco/Editor | Forge-Phase |

## Entscheidungen (2026-10-24)

1. **WASM-Variante:** zunächst `@jitl/quickjs-ng-wasmfile-release-sync@0.32.0`. In T7/T8
   wurde aus Packaging-Gründen auf die asyncify-Variante gewechselt (siehe dort).
   - Die Variante bleibt austauschbar. Sie wird an genau einer Stelle in `sandbox.ts` an
     `newQuickJSWASMModuleFromVariant` übergeben. Alle `@jitl`-Varianten haben dieselbe
     FFI-Schnittstelle (`quickjs-ffi-types`).
   - Ein Wechsel ist ein Einzeiler plus Dependency-Tausch. Die Sandbox-Tests aus T2 dienen dabei
     als Regressionsnetz für Unterschiede im ES-Verhalten.
2. **Befehlsname:** `atlcli script …`.
3. **`run --apply`** ist im MVP enthalten: interaktive Bestätigung, ohne TTY ist `--yes` Pflicht.
