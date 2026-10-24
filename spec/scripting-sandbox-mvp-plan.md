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

1. **WASM-Variante:** `@jitl/quickjs-ng-wasmfile-release-sync@0.32.0`, exakt gepinnt.
   - Die Variante bleibt austauschbar. Sie wird an genau einer Stelle in `sandbox.ts` an
     `newQuickJSWASMModuleFromVariant` übergeben. Alle `@jitl`-Varianten haben dieselbe
     FFI-Schnittstelle (`quickjs-ffi-types`).
   - Ein Wechsel ist ein Einzeiler plus Dependency-Tausch. Die Sandbox-Tests aus T2 dienen dabei
     als Regressionsnetz für Unterschiede im ES-Verhalten.
2. **Befehlsname:** `atlcli script …`.
3. **`run --apply`** ist im MVP enthalten: interaktive Bestätigung, ohne TTY ist `--yes` Pflicht.
