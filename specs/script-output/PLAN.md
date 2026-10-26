# Plan: Gestreamte Ausgabedateien für Skripte und Audit (inkl. Jinja-Streaming)

## Kontext
Skripte können heute nur geplant schreiben (`files.write`). Der ganze Inhalt landet im Plan, wird erst bei `--apply` geschrieben und darf höchstens 10 MB groß sein (`packages/script-runtime/src/verbs-local.ts:243`).

Audit-Berichte entstehen immer als ein großer String. Das betrifft drei Stellen:
- Der Jinja-Report wird komplett im Speicher aufgebaut: `renderJinja` gibt den ganzen Text zurück, Nunjucks sammelt intern in `output += …`, und das Limit liegt bei 5 s und 64 MB (`packages/jinja/src/sandbox.ts:20`).
- `export function report` muss einen String zurückgeben (`apps/cli/src/commands/audit-scripts.ts:288`).
- `--json` macht ein `JSON.stringify` über den ganzen Report.

Bei großen Audits sprengt das Speicher und Zeitlimit.

**Ziel:** Berichte und Exporte werden Zeile für Zeile in Dateien geschrieben. **Jinja-Templates streamen dabei vollständig**, mit byte-identischer Ausgabe zum heutigen Rendern (Wunsch des Users).

Mitgenommen werden außerdem `files.lines` (Lesen als Stream) und der DNS-Rebinding-Fix bei `http`. Triggers kommen in einen eigenen PR.

**Entscheidungen (User):**
- Ausgabedateien werden sofort geschrieben, auch im Dry-Run (wie stdout).
- Das Skript nennt nur relative Namen; `--out-dir` legt die Wurzel fest (Standard ist das CWD).
- Grenzen: 256 MB und 50 Dateien pro Lauf.

Branch `feat/script-output`, Spec `specs/script-output/PLAN.md`, ein PR.

---

## A. Jinja-Streaming (`packages/jinja`) – das Fundament

### Neue API
`streamJinja(source, vars, write: (chunk: string) => void, options)`
- Gleiche Optionen wie `renderJinja` (`templates`, `lines`, `tolerant`).
- Die tolerante Vorverarbeitung (`analyze` und `applyLiteral`) bleibt identisch. Nicht auflösbare Ausdrücke bleiben also wie geschrieben stehen.
- **Anders als heute:** Ein Render-Fehler wirft einen `JinjaError` statt den Quelltext zurückzugeben, denn es ist schon etwas geschrieben. Der Aufrufer verwirft dann die Datei.

### Guest-Seite (`guest.ts`)
Der Compiler von Nunjucks wird erweitert, aber nur für die Stream-Environments (`streamExact`/`streamLines`). Der Wrapper um `nunjucks.compiler.compile` setzt dafür ein Flag, während kompiliert wird.

**Kopf-Prinzip:** Gestreamt wird nur aus dem Puffer, dessen gesamte vorherige Ausgabe schon geschrieben ist.
- **Flush-Punkte:** `compileOutput` hängt nach jedem `output += …` Folgendes an: `if (output.length > 16384 && runtime.__head(frame-token)) output = runtime.__flush(output)`.
- **Wer Kopf werden darf:** Root-Funktion, Blöcke, die per `{% block %}` als Statement aufgerufen werden, und `{% include %}`. Vor ihrem Aufruf leert der Aufrufer seinen Puffer (`__flush`) und gibt die Kopfrolle weiter; nach der Rückkehr bekommt er sie zurück.
  - Damit streamen auch Templates mit `{% extends %}` blockweise und Includes inline.
- **Wer nur sammelt (wie heute):** `super()`, Makros, `caller()`, `{% set %}…{% endset %}` (Capture) und `{% filter %}`.
  - Bei `{% filter %}` und `caller()` haben die Puffer ohnehin eigene Namen (`_pushBuffer`). Capture setzt `buffer = 'output'` in einer IIFE und bekommt deshalb ein explizites Flag „kein Flush“.
- **Text vor `{% extends %}`:** Nunjucks verwirft ihn. Deshalb flusht eine Root-Funktion nur, solange das Template kein `Extends` enthält; das weiß der Compiler über `node.findAll(nodes.Extends)`.
  - In dem Fall übernimmt die Root-Funktion des Eltern-Templates die Kopfrolle.
- Am Ende wird der Rest geflusht.

### Host-Seite (`sandbox.ts`)
- Die synchrone Host-Funktion `__atlcliSink(chunk)` wird über `ctx.newFunction` gesetzt und ruft `write` auf. Das ist synchron, damit es zum Sync-API-Muster dieses Pakets passt.
- Limits im Stream-Modus:
  - Deadline standardmäßig 5 min (`limits.timeoutMs`).
  - Speicher: `max(64 MB, 4 × JSON-Größe von vars)`. Damit passt auch ein großes Report-Modell.
  - `ponytail:` Das Modell liegt weiter ganz im Gast; lazy Findings erst, wenn es gemessen nötig ist.

### Garantie: identische Ausgabe
Ein Äquivalenz-Test vergleicht `streamJinja` (Chunks verbunden) mit `renderJinja` für ein Korpus, jeweils in `exact` und `lines`:
- for/else, `loop.*`, if/elif, extends mit mehreren Ebenen, Blöcke, `super()`, include (auch verschachtelt und in Schleifen)
- Makros und `caller`, `set`-Capture, `filter`-Block, Whitespace-Control `{%- -%}`
- `trimBlocks`/`lstripBlocks`, `raw`, unaufgelöste Ausdrücke (tolerant)
- `DEFAULT_MARKDOWN_TEMPLATE` aus `packages/audit/src/report.ts:227` mit großem Modell
- alle mitgelieferten Report- und Seiten-Templates aus `packages/core/src/templates/builtins.ts` und `apps/cli/src/commands/jira-report-templates.ts`

Der Test läuft mit Flush-Schwelle 1, damit jede Flush-Stelle getroffen wird, und mit der Standardschwelle. Ein Fehler-Test prüft, dass ein Fehler mitten im Render wirft.

---

## B. `atlcli.output()` – gestreamte Ausgabedateien für Skripte

```ts
const out = atlcli.output("report/worklogs.csv");   // format aus Endung: csv | jsonl | sonst text
out.row(["Key", "Stunden"]); out.line("…"); out.write("…"); out.json({…});
out.render(template, vars, { lines: true });         // Jinja direkt in die Datei (A)
await out.close();
```

### Runtime (`verbs-local.ts`)
- Host-Verben `output.open` (gibt ein Handle zurück), `output.write(handle, chunk)`, `output.render(handle, template, vars, opts)` und `output.close(handle)`.
- Es sind **keine** Write-Verben: Sie werden nicht über `r.record` geplant. Permission `file:output`.
- Der Pfad wird geprüft wie bei `checkLocalPath`.
- Der Guest-Wrapper in `LOCAL_WRAPPERS` (Muster wie `secret`) baut das Objekt.
  - Es puffert bis 64 KB und gibt dann einen Host-Aufruf ab.
  - CSV-Quoting nach RFC 4180 übernimmt `row`.
- Nicht geschlossene Writer werden am Laufende vom Host geschlossen. Ein Fehlschlag wirft und die Datei wird verworfen.

### Port (`port.ts`, `script-port.ts`)
- `outputOpen`, `outputWrite`, `outputRender` und `outputClose` werden zu optionalen Port-Methoden.
- Die CLI schreibt zuerst `.<name>.atlcli-tmp` per `fs.open` und `writeSync` unter `--out-dir`.
  - Das Elternverzeichnis wird über `inside()` geprüft, Symlinks werden abgelehnt (wie `fileWrite`, `script-port.ts:645`).
  - Bei `close` wird `rename` ausgeführt. Bricht der Lauf ab, wird die tmp-Datei gelöscht.
- Limits pro CLI-Lauf (über alle `--each`-Jobs hinweg):
  - 256 MB, `--max-output <size>` hebt die Grenze an.
  - 50 Dateien.
  - Wird derselbe Pfad zweimal geöffnet, ist das ein Fehler. Das betrifft auch parallele `--each`-Jobs.
- `outputRender` ruft `streamJinja` (A) mit dem `write` des Handles auf.

### Sichtbarkeit
- Ergebnis und `--json` erhalten `outputs: [{ path, bytes, sha256 }]`.
- Die Plananzeige und das Journal-Ende nennen die Dateien ohne Inhalt.
- `apply` eines gespeicherten Plans schreibt nichts neu, weil die Ausgaben beim Planen entstanden sind.

### Weitere Stellen
- **Audit-Regeln:** Item- und Data-Regeln bekommen `output` gesperrt (Meldung im Stil von `READ_ONLY`). Erlaubt ist es nur im `report`-Export.
- **`script test`** (`fixture-port.ts`, `script-test.ts`):
  - Ausgaben gehen in den Speicher.
  - `expect.outputs` speichert pro Pfad den Inhalt (bis 64 KB) oder sonst den sha256.
  - `--record` und `--update` schreiben sie mit.
- **Typen** (`script-types.ts`): `OutputWriter` und `atlcli.output`.

---

## C. Audit streamt (`audit-scripts.ts`, `audit-jira.ts`, `audit-wiki.ts`, `packages/audit/src/report.ts`)

### Neue Flags
`--output <file>` und `--format md|json|jsonl|csv`. Ohne `--format` entscheidet die Dateiendung, sonst gilt `md`.
- `--report <file>` bleibt als Alias für `--format md --output`.
- Ohne `--output` wird genauso gestreamt, aber auf stdout. Es entsteht also auch ohne Datei kein Gesamtstring.

### Ein Sink für alle Wege
Ein Datei-Sink (tmp und rename) oder `process.stdout.write`. Ihn nutzen:
- **md:** `streamJinja(DEFAULT_MARKDOWN_TEMPLATE | --template, markdownModel(report), sink, { lines: true })`. Die Template-Ladelogik aus `customAuditReport` (`audit-scripts.ts:260`) wird wiederverwendet.
- **json:** neu `writeReportJson(report, write)` in `packages/audit`. Erst der Kopf, dann `findings` einzeln, dann der Rest. Das ergibt dasselbe Dokument wie heute (Test: `JSON.parse` des Streams ist gleich dem Report).
- **jsonl:** ein Finding pro Zeile.
- **csv:** `key,rule,severity,title,target,…` mit demselben Quoting wie `row`.
- **`report`-Export:** `export async function report(model, out)`. Wird ein String zurückgegeben, wird er wie bisher in den Sink geschrieben (kompatibel). Der Report-Sandbox bekommt dafür `output` mit dem Pfad der CLI.

### Grenze
Für `--fail-on` und die Baseline bleibt das Findings-Array im Speicher. Was wegfällt, sind die gerenderten Gesamtstrings.

---

## D. `files.lines(path, { format? })`
- Async-Iterator, Muster wie `pagedIterator` in `recorder.ts`.
- Der Host hält pro Handle einen Zeilenleser (`readline` über einen Stream) und liefert Batches zu 1000 Zeilen.
- Formate:
  - `csv`: Zeilen als Arrays, mit RFC-4180-Parser einschließlich Zeilenumbrüchen in Quotes
  - `jsonl`: Objekte
  - sonst: Strings
- Permission `file:read`. Keine Größengrenze, weil gestreamt wird.

## E. DNS-Rebinding-Fix (`script-port.ts:760`)
- Die geprüfte Adresse wird für den Connect festgehalten: `node:https`/`node:http` mit einem `lookup`-Hook, der jede Antwort auf private Adressen prüft. So wird genau die geprüfte IP verbunden.
- Damit ersetzt diese Prüfung `refusePrivateAddress` vor dem `fetch`.
- Redirect-Logik und Timeout bleiben, ebenso `MAX_LOCAL_BYTES`.
- **Erster Schritt:** prüfen, ob Bun den `lookup`-Hook unterstützt. Falls nicht, bleibt die Vorab-Prüfung, die Notiz wird präzisiert und dem User gemeldet.

---

## Doku und Skill (im selben PR)
- `src/content/docs/reference/scripts.md`: `atlcli.output`, `file:output`, `--out-dir`, `--max-output`, `files.lines`.
- `src/content/docs/scripts.md`: Abschnitt „Berichte und Exporte schreiben“ mit minimalem Beispiel (CSV) und realistischem Beispiel (Jinja-Report).
- `jira/audit.md`, `confluence/audit.md`, `audit-scripts.md`: `--output`/`--format`, `report(model, out)`.
- `reference/cli-commands.md` und `templating.md` (Streaming, Fehlerverhalten).
- `skills/atlcli/references/{scripts,jira-audit,confluence-audit}.md`.
- Beispiel `worklog-report.script` auf `output()` umstellen.
- API-Reports und Closures für `jinja`, `audit`, `script-runtime` neu erzeugen.

## Reihenfolge (Commits)
1. Spec
2. A: Jinja-Streaming mit Äquivalenz-Korpus
3. B: Runtime-Verben und Wrapper, Port, CLI-Sink, Limits, `script test`
4. C: Audit-Sinks, `writeReportJson`, Flags
5. D: `files.lines`
6. E: DNS-Fix
7. Doku, Skill, Beispiele, API-Reports

## Verifikation
- **Unit:**
  - A: Äquivalenz-Korpus, Fehler mitten im Render, Speicherlimit-Skalierung, großes Modell (50k Findings) innerhalb der Limits
  - B: Pfad-Escapes, Symlink, Limit Bytes/Dateien, doppelter Pfad, atomar bei Abbruch (keine Datei, alte Datei unverändert), CSV-Quoting, Puffergrenzen, `output` in Item-Regeln gesperrt, `script test` mit `expect.outputs`
  - C: `JSON.parse(stream)` gleich dem Report, md gleich dem heutigen `renderJinja`, jsonl/csv, `report(model, out)` und String-Rückgabe
  - D: CSV mit Quotes und Zeilenumbrüchen, jsonl, großes File
  - E: Hostname, der auf `127.0.0.1` bzw. `10.x` auflöst, wird abgelehnt
- **CLI-Stub-Tests** (`Bun.serve`): `script run` mit `output` im Dry-Run (Datei da, nichts geplant) und `audit jira --output x.md|json|jsonl`.
- **Speicher:** Audit-Lauf mit 100k synthetischen Findings, gestreamt nach md und json; RSS-Vergleich vor und nach der Änderung kommt in den PR-Text.
- **Live (mayflower):**
  - `audit jira --project ATLCLI --output a.md`, `--format json`, `--template` mit `extends`/`include`
  - `audit wiki` in DOCSY mit `--output`
  - ein Skript mit `output()` und `out.render` über ATLCLI-Issues
  - `files.lines` über eine CSV
  - Testdateien anschließend löschen.
- `bun run typecheck` und `bun run test`. Merge und Release nur auf Go.
