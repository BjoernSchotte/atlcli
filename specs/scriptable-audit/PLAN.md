# Plan: Script-Verben aus der JWT-Analyse + skriptbares Audit (TS-Regeln in der Sandbox)

## Kontext

Aus der Analyse von „Jira Workflow Toolbox“ hat der User die Punkte 1, 2, 3 und 5 gewählt. Dazu kommt ein neuer, größerer Wunsch: **`atlcli audit` wird skriptbar.**
- Die eingebauten Audits (Jira **und** Wiki) werden zu TypeScript-Regel-Skripten, die automatisch in der Sandbox laufen.
- Eigene Audits schreibt man genauso in TypeScript.
- Findings können einen Fix vorschlagen, der als normaler Plan oder Job (review → apply) umgesetzt wird.

Geliefert wird alles in **einem PR**, in den Phasen A, C und B (Reihenfolge siehe unten):
- **Phase A:** Punkte 1–3, also Script-Verben und Beispiele.
- **Phase C:** Handlebars → Jinja, eine Engine für alles.
- **Phase B:** skriptbares Audit; enthält Punkt 5 („Prüfregeln als Skripte“).

### Brainstorm-Entscheidungen (User)
- **Form:** Regeln pro Item, batchweise über einen gemeinsamen Datenabruf für alle Regeln. Dazu freie Audits, die selbst suchen.
- **Fixes:** ja, über `audit … --fix` als Plan bzw. Job.
- **Discovery:** `.atlcli/audit/*.ts` (Projekt) und `~/.atlcli/audit/*.ts`, dazu `--script <file>` (wiederholbar) und `scripts: [...]` in `audit-rules.yaml`.
- **Umfang:** Jira und Wiki jetzt.

### Ist-Stand Audit (Kartierung)
**Jira:**
- `collectJiraAudit` (`apps/cli/src/commands/audit-jira.ts:142-246`) holt per IO: offene und erledigte Issues (90 Tage), Changelogs, Open-Sprint-Keys, Projektversionen, ein Workflow-Sample, JQL für Custom-Regeln und für Overrides.
- `auditJiraIssues` (`packages/jira/src/audit.ts`) ist rein (pure). Darin stecken 11 Regeln mit je 4–43 Zeilen, Threshold-Logik (`severityForValue`), Suppression (Baseline → Legacy → minLevel → listed), Sortierung und `JiraAuditReportV2`.
- Konfiguration: `audit-rules.yaml` mit Profilen, Patches, Overrides und Custom-JQL (`packages/jira/src/audit-rules.ts`).
- Die Digest-Funktion nutzt beides mit.
- Tests pinnen exakte Detail-Strings: `audit.test.ts`, `audit-rules.test.ts`, `audit-jira.test.ts`, `digest-core.test.ts`.

**Wiki:**
- `audit-wiki.ts` (1459 Zeilen) liest die lokale Sync-DB. Die Prüflogik ist mit IO verwoben (`getUser`/`getPageLabels` in Schleifen; Orphans und Broken Links per SQL).
- Optional kommen HTTP-Checks, Ordner-Validierung und Remote-Seiten dazu.
- Es gibt kein einheitliches Finding (`AuditResult` hat ein Array pro Check), kein `--fail-on`, keine Baseline. Die Fixes (Label setzen, archivieren, löschen) laufen interaktiv.
- Das ganze Kommando steht hinter dem Feature-Flag `audit`.

---

## Phase A: Script-Verben und Beispiele (JWT 1–3)

1. **Transition mit Feldern:** `jira.transition(key, to, { fields?, comment? })` und `jira.setStatus(key, status, { fields?, comment? })`.
   - Port `jiraTransitionIssue`/`jiraSetStatus` erhält `fields`/`update.comment`. `TransitionIssueInput` (`packages/jira/src/types.ts:409`) kann das schon.
   - Ein Kommentar wird als Markdown → ADF übergeben (`toJiraRichText`).
2. **Neue Verben:**
   - lesend: `jira.transitions(key)` → `[{ name, to: { name, category } }]`. Der Port liefert heute nur Namen; er wird auf `getTransitions` erweitert.
   - lesend: `jira.history(key, { fields? })` → Statuswechsel und optional weitere Feldänderungen, über `client.getChangelogs` und `extractStatusTransitions` (`packages/jira/src/flow.ts:150`).
   - lesend: `jira.watchers(key)`.
   - schreibend: `jira.addWatcher(key, user)` / `jira.removeWatcher(key, user)`. Der Client hat `addWatcher`/`removeWatcher`. Unverändertes wird übersprungen, wenn die Person schon beobachtet bzw. nicht beobachtet.
   - schreibend: `jira.notify(key, { subject, markdown, to: { users?, groups?, reporter?, assignee?, watchers?, voters? } })`. Dafür braucht der Client die neue Methode `notifyIssue` (POST `/issue/{key}/notify`). Keine Precondition, Jira verschickt die Mail selbst.
3. **Vier Beispiele** unter `apps/cli/src/builtin-scripts/examples/`:
   - `close-parent-when-subtasks-done` (each)
   - `propagate-fix-version` (each)
   - `unblock-when-blocker-done` (each, `linkedIssuesOf`)
   - `subtasks-from-checklist` (run, Parameter mit Liste)

   Sie werden in `examples.test.ts` aufgenommen (Typecheck plus Planen).
- Typen (`script-types.ts`), Verbs-Liste, Doku (Script-API-Referenz, `scripts.md`) und Skill `skills/atlcli/references/scripts.md` werden nachgezogen.

---

## Phase B: Skriptbares Audit

### Grundidee
- Eine **Audit-Regel ist ein Script mit `meta.audit`**.
- Der Host sammelt die Daten (wie heute), führt die Regel-Skripte batchweise in der Sandbox aus und wendet Konfiguration, Severity, Suppression, Baseline und Report **einheitlich** an.
- Die eingebauten Regeln liegen als `.ts`-Dateien vor und laufen genauso. Man kann sie auswerfen (`--print-rule <id>`) und mit gleicher id überschreiben.

### Regel-API
```ts
// .atlcli/audit/done-without-component.ts
export const meta = {
  audit: {
    id: "team/done-without-component",   // <bereich>/<name>, eindeutig
    product: "jira",                      // jira | confluence
    kind: "flag",                         // flag | age | until  (wie heute)
    defaults: { severity: "warning" },    // Patch-Grammatik wie audit-rules.yaml
    profiles: { strict: { severity: "error" } },   // optional: minimal/default/strict
    fields: ["components", "status"],     // zusätzliche Felder fürs Laden
    needs: [],                            // jira: changelog | done | sprint | versions | flow
    title: "Done issues need a component",
  },
};

export default (issue: JiraIssue, rule: AuditRule) => {
  if (rule.isDone(issue) && !(issue.fields.components as unknown[]).length) {
    return rule.finding({ detail: "Done without component." });                 // flag
  }
  // age/until: rule.finding({ value: days, detail: `…` }) → Severity aus Thresholds
};

// optional: Fix-Vorschlag, läuft nur mit --fix im normalen Plan-Modus
export async function fix(finding: AuditFinding, issue: JiraIssue) {
  await atlcli.jira.update(issue.key, { fields: { components: [{ name: "General" }] } });
}
```
**Freie Audits:**
- `meta.audit.scope: "run"` mit `export default async (audit) => { … audit.finding({ target, summary, detail, value? }) … }`.
- Sie suchen selbst über `atlcli.*`, etwa für Querschnittsregeln oder Prüfungen über Jira und Confluence hinweg.

**Kontext `rule`:** `now`, `config` (die wirksame Regelkonfiguration für dieses Item, inklusive Overrides), `resolve(status)` → Kategorie, `isDone`/`isWip`, `finding()`, dazu vom Host vorberechnete Fakten unter `issue.audit`:
- `startedAt`
- `inOpenSprint`
- `projectUsesVersions`
- `flaggedSince`
- `flow` (P85/P95 je Status und Cycle)
- `resolvedNotDone`-Gruppen

Querschnitts-Statistiken wie Perzentile rechnet der Host (`buildIssueFlowTimeline`, `percentile` gibt es schon), damit Regel-Skripte rein und einfach bleiben.

**Read-only:** Im Audit-Modus lehnt der Recorder jedes Write-Verb ab (`permission-denied: audits are read-only; propose a fix`). Lesen über `atlcli.*` ist erlaubt und wird gezählt.

### Ausführung
- **Sandbox:** neue Option `items` in `runScript`. Der Default-Export wird pro Item in **einer** Runtime aufgerufen und liefert ein Ergebnis-Array.
  - Ein Batch von 200 Items pro Regel bedeutet 1 Runtime statt 200. Das hält auch das RSS-Plateau aus PR #347 klein.
  - Limits gelten pro Batch.
  - `--each` aus PR #347 nutzt weiter ein einzelnes Item.
- **Neues isomorphes Paket `packages/audit`** (`@atlcli/audit`):
  - generisches Finding-Modell
  - Severity-Ableitung (`severityForValue` wandert hierher)
  - verallgemeinerte Regelkonfiguration (Profile/Patches/Overrides für beliebige Regel-ids; heute `packages/jira/src/audit-rules.ts`)
  - Engine `runAudit({ rules, items, facts, config })`, die Regeln nach Produkt gruppiert, über `script-runtime` ausführt und Findings einsammelt
  - Suppression und Baseline (aus `packages/jira/src/audit.ts`)
  - Report v3 und Renderer (Text, Markdown, JSON)

  `packages/jira` behält nur das, was Jira-spezifisch ist (Status-Resolver, Flow-Timeline).
- **Built-ins** unter `apps/cli/src/builtin-scripts/audit/jira/*.ts` (11 Regeln) und `…/audit/confluence/*.ts`. Die bisherige `PROFILES`-Tabelle wird zu `meta.audit.profiles` der jeweiligen Datei. Die Regeltexte bleiben **wörtlich** gleich.
- **Discovery und Reihenfolge:**
  1. Built-ins
  2. `~/.atlcli/audit/`
  3. `./.atlcli/audit/`
  4. `scripts:` in der YAML (relativ zur Datei)
  5. `--script`

  Eine gleiche id ersetzt die frühere Regel und erzeugt eine Diagnose „overrides built-in“. `--checks` und die Patches in `audit-rules.yaml` gelten für alle Regeln. Custom-JQL-Regeln bleiben YAML.

### Jira
- `collectJiraAudit` bleibt der IO-Teil. Er lädt zusätzlich die `fields`/`needs` aller aktiven Regeln (Vereinigungsmenge) und hängt Fakten an. `auditJiraIssues` wird zu einem dünnen Adapter auf `runAudit`.
- **Parität zuerst:**
  1. Ein Paritätstest läuft auf denselben Fixtures für den alten und den neuen Weg (`audit.test.ts`-Fixtures, CLI-Stub, Digest).
  2. Erst wenn beide identisch sind (Findings, Reihenfolge, Detail-Strings, Zähler), wird der alte Regelcode gelöscht.
- Das JSON-Schema wird **v3**: ein einheitliches Finding mit `target: { kind: "issue", key }` und optionalem `fix`. Die Felder von v2 bleiben als Teilmenge erhalten. Digest und Skill werden angepasst.

### Wiki
Der Host baut aus der Sync-DB einen **Snapshot** pro Seite:
- Metadaten, Labels, Status, Restriktionen, Versionsanzahl
- eingehende Links, Broken Links (aus `links.is_broken`), externe Links (mit HTTP-Status bei `--check-external`)
- Contributors mit `isActive`
- Ordner-Probleme

So laufen alle Checks als Regeln pro Seite in der Sandbox. Der IO-Teil wird aus den `detect*`-Funktionen herausgezogen.
- Severity: Wiki rechnet heute mit high/medium/low. Künftig gelten info/warning/error mit Monats-Thresholds über die normale Patch-Grammatik (`--stale-high` usw. werden auf diese Patches abgebildet).
- Neu für Wiki: `--fail-on`, Baseline und `audit-rules.yaml` (Abschnitt `confluence:`).
- **Fixes:** Die bisherigen Aktionen werden zu `fix`-Exporten. `--fix` ersetzt die interaktiven Prompts durch Plan-Review bzw. Apply. Dafür kommt das Verb `confluence.archivePage` dazu; `deletePage` und Labels gibt es schon.

### `--fix`
- `audit jira|wiki --fix` sammelt die gelisteten Findings mit `fix`-Export und erzeugt einen **Job** (Infrastruktur aus PR #347).
- Items sind die Findings samt Ziel; ihre Daten liegen im Job, es wird nicht neu geladen. Pro Item läuft der `fix`-Export im Plan-Modus.
- Danach geht es weiter mit `script apply <job>`, oder sofort mit `--fix --apply`. Resume, Journal und Concurrency kommen gratis mit.
- Kleiner Umbau dafür: `script-jobs.ts` bekommt eine Item-Quelle „Liste mit Payload“ neben dem JQL-Snapshot.

### Audit-Berichte als Markdown (TypeScript + Jinja)
Ein Audit kann statt oder zusätzlich zur Standardausgabe einen **eigenen Markdown-Bericht** erzeugen.

- **Datenmodell:** `{ generatedAt, product, query, rules, summary, findings[], quiet, legacy, diagnostics }`, also Report v3, dazu was das Skript selbst berechnet.
Es gibt drei gleichwertige Wege. Ein Template ist **nicht nötig**, kann die Arbeit aber erleichtern:

1. **Frei in TypeScript:** `report(model)` baut den Markdown-String selbst zusammen (Strings, Arrays, `join`) und gibt ihn zurück.
   ```ts
   export function report(model: AuditReport) {
     const rows = model.findings.map((f) => `| ${f.target.key} | ${f.severity} | ${f.detail} |`);
     return [`# Audit ${model.generatedAt}`, "", "| Issue | Severity | Finding |", "|---|---|---|", ...rows].join("\n");
   }
   ```
2. **TypeScript mit Inline-Jinja:** Das Template entsteht als String im Code, auch dynamisch zusammengesetzt, und wird mit Jinja über die Findings befüllt.
   ```ts
   export async function report(model: AuditReport) {
     const byOwner = groupBy(model.findings, (f) => f.assignee ?? "unassigned");
     const tpl = `# Audit\n{% for owner, items in byOwner|dictsort %}\n## {{ owner }} ({{ items|length }})\n{% for f in items %}- {{ f.target.key|jiraLink }}: {{ f.detail }}\n{% endfor %}{% endfor %}`;
     return atlcli.render(tpl, { vars: { ...model, byOwner } });
   }
   ```
3. **Nur Template-Datei:** `atlcli audit jira --template report.md.j2 [--report out.md]` rendert ein Jinja-Template direkt über das Modell, ganz ohne eigenen Code.

Für alle drei Wege gilt: Ohne `--report` geht der Bericht nach stdout.

- **Details zum `report`-Export (Wege 1 und 2):**
  - Darin wird gerechnet, gruppiert und angereichert. Weitere Lesezugriffe über `atlcli.*` sind erlaubt, Writes nicht.
  - Zurück kommt der Markdown-String, meist über `atlcli.render(template, { vars })`.
  - `console.log` bleibt Logausgabe auf stderr. Der Bericht ist der Rückgabewert, damit er sauber in Datei oder stdout landet.
  - Mehrere `report`-Exporte: mit `--report-script <id>` wählt man einen aus, sonst gewinnt der letzte in Discovery-Reihenfolge.
- **Jinja-Engine:** Nunjucks (die Jinja2-kompatible JS-Implementierung): Filter, Macros, `{% extends %}`/`{% include %}`, `{% set %}`, Schleifen mit `loop`.
  - **Sie läuft in der QuickJS-Sandbox** über `@atlcli/jinja` (siehe Phase C), nicht auf dem Host.
  - `extends`/`include` laden aus einem Template-Verzeichnis (`.atlcli/audit/templates/` bzw. dem Verzeichnis neben `--template`). Der Host liest es vorab ein und übergibt eine Map von Namen auf Quelltext; Dateizugriff aus dem Guest gibt es nicht.
  - Eigene atlcli-Filter: `jiraLink(key)`, `pageLink(id)`, `date(fmt)`, `severityIcon`.
- **`atlcli.render` nutzt Jinja**, die einzige Engine nach Phase C. Damit steht Jinja auch normalen Skripten zur Verfügung.
- Ein eingebautes Default-Markdown-Template ersetzt den heutigen Markdown-Renderer (`renderJiraAuditMarkdown`, Wiki-`formatMarkdown`). So ist auch `--markdown` über Jinja anpassbar. `--print-template` wirft es aus, damit man es anpassen kann.
- **Später, nicht in diesem PR:** den Bericht als Confluence-Seite veröffentlichen. Das geht schon heute über einen `fix`-artigen `upsertPage` im Plan.

### CLI-Zusätze
- `atlcli audit jira|wiki --script <file>` (wiederholbar)
- `--print-rule <id>`, um ein Built-in auszuwerfen
- `--list-rules` (id, Quelle, Profil-Defaults)
- `atlcli audit init [--product jira|confluence]` schreibt ein Regel-Skelett nach `.atlcli/audit/` sowie `atlcli.d.ts` mit den Typen `AuditRule`/`AuditFinding`.

---

---

## Phase C: Handlebars → Jinja (eine Engine, breaking)

Entscheidung des Users: **Jinja überall**, im selben PR. Handlebars fliegt raus. Einen Konverter für Nutzer gibt es nicht; die Änderung gilt als breaking, weil die neuen Templating-Funktionen noch niemand nutzt. Im Repo werden alle 29 Dateien mit Handlebars-Syntax migriert: Built-in-Skripte, Report-Page-Templates, Seitentemplates, Tests, Doku, Skills.

### Architektur
- **Neues isomorphes Paket `@atlcli/jinja`**: Es bündelt Nunjucks und rendert **immer in einer QuickJS-Runtime**, über die `quickjs-emscripten-core`/asyncify-Variante, die schon ausgeliefert wird.
  - Grund: Nunjucks kompiliert zu JS, Template-Injection wäre auf dem Host eine RCE. Templates kommen auch aus geteilten Template-Packs.
  - Abhängigkeiten: `@atlcli/jinja` → `quickjs-emscripten-core` + Nunjucks-Bundle. Der Sandbox-Kern kommt aus `script-runtime` oder wird minimal geteilt; `script-runtime` hängt nicht an `core`, es entsteht also kein Zyklus.
  - `@atlcli/core/templates` nutzt `@atlcli/jinja` statt `handlebars`. Die Abhängigkeit `handlebars` wird entfernt.
  - **Synchrones Rendern bleibt:** `await initJinja()` lädt das WASM-Modul einmal asynchron (lazy, nur bei Bedarf). Danach rendert `renderJinja()` synchron über die synchrone QuickJS-API des geladenen Moduls. Die Signaturen von `render`/`port.render` bleiben damit synchron.
  - Templating-Einstiege müssen vorher `initJinja()` awaiten: CLI-Handler von copy-issues, copy-pages und Seitentemplates, Report-Pages, Script-Port, Audit. Eine Runtime wird pro Render-Batch wiederverwendet.
- **Kompilierte Templates** werden pro Runtime gecacht, vor allem für Audit-Berichte und große copy-issues-Läufe.

### Semantik (wie bisher, nur mit Jinja-Syntax)
- **Tolerant:** Ein unaufgelöstes `{{ x.y }}` bleibt **wörtlich** stehen und erzeugt eine Warnung mit Position.
  - Umsetzung: Der Nunjucks-Lexer findet Output-Blöcke samt Position und schreibt sie um zu `{{ __keep(expr, "<original>", line, col) }}`. `__keep` merkt Warnungen und gibt bei `undefined` das Original zurück.
  - Das entspricht dem heutigen AST-Rewrite für Handlebars. `--strict` macht aus jeder Warnung einen Fehler.
- **Kein Auto-Escape**, wie heute `noEscape`. Die Adapter escapen nach Format: Storage-XHTML, ADF-Textknoten, Wiki-Markup. Der Zahlen-Additions-Bug (`__atlcliStr`) entfällt mit Handlebars.
- **Builtins:** `@today`/`@now` werden zu den Globals `today`/`now` (eingefrorene Uhr über `--now`).
- **Helper werden Filter:** Die heutigen Handlebars-Helper aus `helpers.ts` werden zu Jinja-Filtern bzw. Globals; Nunjucks-Filter wie `default`, `upper`, `join`, `date` decken vieles schon ab.
- **Escapes:** Statt `{{"{{"}}` gilt `{% raw %}…{% endraw %}` bzw. `{{ "{{" }}`.
- **Adapter** (text, adf, adf-blocks, storage, wikimarkup) erkennen `{% … %}`-Blöcke statt `{{#…}}`/`{{/…}}`. Der Storage-Tokenizer und der ADF-Block-Adapter lassen Block-Tags über Knoten- bzw. Run-Grenzen hinweg zu, wie bisher bei `{{#each}}`.
- `atlcli.render` hat damit nur noch eine Engine (Jinja). Die Option `engine` aus Phase B entfällt, und Audit-Berichte nutzen dieselbe Engine.

### Migration im Repo
- **Built-ins:** `copy-issues.script`, `copy-pages.script`, `jira-report-templates.ts`, `template.ts`, Seitentemplates
- **Tests:** `packages/core/src/templates/*.test.ts`, CLI-Tests mit Templates. Erwartungen bleiben inhaltlich gleich, nur die Syntax ändert sich.
- **Doku:** `templating.md`, `confluence/templates.md`, `confluence/pages.md`, `jira/copy-issues.md`, `jira/report-pages.md`
- **Skills:** `jira-issues.md`, `confluence-pages.md`
- **CHANGELOG/Release-Notes:** Breaking-Hinweis „Templates nutzen jetzt Jinja-Syntax“ mit einer kurzen Tabelle `{{#if}}` → `{% if %}`, `{{#each}}` → `{% for %}`, `@today` → `today`.

### Verifikation Phase C
- Alle bisherigen Templating-Tests in Jinja-Syntax grün, mit den gleichen Ausgaben und Warnungen inklusive Zeile und Spalte.
- Sicherheitstests: Escape-Versuche wie `constructor.constructor("return process")()` erreichen den Host nicht; Speicher- und Zeitlimits greifen bei Endlosschleifen in Templates.
- Performance: copy-issues-Plan über 500 Issues mit Templates; Zeit vorher/nachher messen.
- Live:
  - `jira project copy-issues` mit Templates (kiteweave, Temp-Projekt)
  - `wiki` Seitentemplate in DOCSY
  - Report-Page

---

## Kritische Dateien
- **Sandbox/Runtime:** `packages/script-runtime/src/sandbox.ts` (`items`), `verbs.ts` (Audit-Read-only-Modus, neue Verben), `port.ts`, `script-types.ts`
- **neu:** `packages/audit/src/{model,config,engine,suppress,report,render}.ts`
- **neu:** `packages/jinja/src/{index,sandbox,tolerant,filters}.ts` plus das gebündelte Nunjucks
- **Templating:** `packages/core/src/templates/{render,helpers,builtins,engine,validation}.ts` und `adapters/*` (Handlebars raus); `packages/core/package.json`
- **Jira:** `packages/jira/src/audit.ts` und `audit-rules.ts` (dünner oder verschoben), `client.ts` (`notifyIssue`)
- **CLI:** `apps/cli/src/commands/audit-jira.ts`, `audit-wiki.ts` (Facts-Builder statt `detect*`), `audit-formatters.ts`, `digest.ts`, `script-jobs.ts` (Listen-Items), `script-port.ts`
- **neu:** `apps/cli/src/builtin-scripts/audit/{jira,confluence}/*.ts`
- **Doku:** `src/content/docs/jira/audit.md`, `jira/audit-rules.md`, `confluence/audit.md`, neue Seite „Eigene Audits schreiben“; Skills `skills/atlcli/references/jira-audit.md` und `confluence-audit.md`

## Reihenfolge
Alles läuft in **einem PR** auf dem Branch `feat/scriptable-audit`, mit Commits je Schritt. Phase C kommt **vor** den Audit-Berichten aus B, damit diese gleich auf Jinja aufsetzen.
1. **Phase A:** Verben (Transition mit Feldern, `transitions`, `history`, `watchers`, `add/removeWatcher`, `notify`), dann die vier Beispiele, dann Tests.
2. **Phase C:** Handlebars → Jinja
   1. `@atlcli/jinja`: Nunjucks-Bundle, QuickJS-Render, `initJinja`, tolerantes `__keep`, Filter und Globals
   2. `core/templates` und Adapter umstellen, `handlebars` entfernen
   3. Repo-Migration (Built-ins, Tests, Doku, Skills), Sicherheits- und Performance-Tests
3. **Phase B:** skriptbares Audit
   1. Sandbox-`items` und Read-only-Modus
   2. `packages/audit` mit Modell, Config, Engine, Suppression und Report v3
   3. Jira-Built-ins als TS, Paritätstest grün, alten Regelcode entfernen
   4. Discovery, `--script`, `--print-rule`, `--list-rules`, `audit init`
   5. Wiki-Facts-Builder und Wiki-Regeln, neue Formatter-Tests
   6. `--fix` über Jobs (Listen-Items); `confluence.archivePage`
   7. Berichte: `report`-Export (frei oder Inline-Jinja), `--template`, `--report`, Default-Template statt der Markdown-Renderer, `--print-template`
   8. Digest anpassen
4. Doku, Skills, CHANGELOG-Breaking-Hinweis, API-Reports und Closures, volle Testsuite, Live-E2E. Merge nur auf Go.

## Verifikation
- **Phase A:**
  - Unit-Tests pro Verb (Fake-Port, Skip-unchanged bei Watchers)
  - CLI-Stub für Transition mit Resolution/Kommentar
  - Beispiele per Typecheck und Planen
  - Live in ATLCLI: Transition nach „Fertig“ mit Resolution und Kommentar, Watcher hinzufügen/entfernen, `notify` an mich selbst, `history`/`transitions`; Testissues danach löschen
- **Phase B:**
  - Paritätstest alt/neu auf allen bestehenden Audit-Fixtures (exakt gleiche Findings und Texte)
  - bestehende Tests `audit.test.ts`, `audit-jira.test.ts`, `digest-core.test.ts` grün; Formatter-Tests für das neue Wiki-Format
  - Tests für eigene Regel, Override eines Built-ins, freies Audit, Read-only-Verstoß, Batch-Limits, `--fix` → Job → Apply
  - Live:
    - `audit jira` auf ATLCLI vor und nach der Umstellung vergleichen (gleiche Findings)
    - eigene Regel mit Fix auf Temp-Issues
    - `audit wiki` im DOCSY-Sync-Verzeichnis (`~/wikisynctest/docs`) vor und nach der Umstellung vergleichen
  - `bun run typecheck`, API-Report und Closure aktualisieren (neues Paket)
  - Jinja:
    - Tests für Filter, Macros, `extends`/`include` aus der Template-Map
    - Sicherheit: `{{ "".constructor.constructor("return process")() }}` darf nur den Guest erreichen, keinen Host-Zugriff
    - ein `report`-Export, der über TypeScript und Jinja ein Markdown baut
    - das Default-Template erzeugt dasselbe Markdown wie der alte Renderer (Paritätstest)
    - Größe und Ladezeit von `@atlcli/jinja` messen (lazy, nur beim Rendern)

## Entscheidungen zu den offenen Fragen
- Die Wiki-Ausgabe wird auf das einheitliche Finding-Format umgestellt (Schema v3). Wiki bekommt `--fail-on`, Baseline und Regel-Config.
- Wiki-Fixes laufen nur noch als Plan oder Job. Die interaktiven Prompts entfallen.
- Neues isomorphes Paket `@atlcli/audit`.
- **Alles in einem PR** (Branch `feat/scriptable-audit`), inklusive Handlebars → Jinja (Phase C), breaking und ohne Konverter.

Die Spec kommt als erster Commit nach `specs/scriptable-audit/PLAN.md`.
