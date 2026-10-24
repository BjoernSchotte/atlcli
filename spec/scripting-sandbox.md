# Script-Runtime: TypeScript-Automationsskripte in einer QuickJS-Sandbox

Stand: 2026-10-24. Status: Spec, nicht implementiert. Forge-Gegenstück:
`~/code/kiteweave-forge-app/specs/SCRIPTS-APP.md`.

## Inhalt

- [Ziel und Abgrenzung](#ziel-und-abgrenzung)
- [Marktbild](#marktbild)
- [Getroffene Entscheidungen](#getroffene-entscheidungen)
- [Architektur](#architektur)
- [Skript-Vertrag](#skript-vertrag)
- [API-Oberfläche (MVP)](#api-oberfläche-mvp)
- [Plan/Apply](#planapply)
- [Sicherheit](#sicherheit)
- [CLI-Oberfläche](#cli-oberfläche)
- [JTBDs](#jtbds)
- [Phasen](#phasen)
- [Offene Fragen](#offene-fragen)
- [Quellen](#quellen)

## Ziel und Abgrenzung

Nutzer schreiben TypeScript-Skripte für Jira/Confluence, die in einer QuickJS-WASM-Sandbox
laufen. Die bestehenden atlcli-Fähigkeiten stehen dort als `atlcli.*` zur Verfügung. Dasselbe
Skript läuft in **CLI/CI**, **Browser-Extension** und **Forge Custom UI**.

Positionierung: *Ops- und Batch-Scripting als Code* — git-versioniert, typisiert, mit Dry-Run.

Nicht-Ziele:

- Keine In-Product-Trigger (Workflow-Validatoren, Behaviours, Listener). Das bleibt Forge/ScriptRunner.
- Kein eigener Scheduler — Zeitpläne laufen über CI-Cron.
- Keine Webhooks/Event-Trigger (bräuchten öffentlichen Endpoint oder Forge-Functions mit Kosten).
- Keine npm-Imports in Skripten; nur relative Module innerhalb des Skriptordners.
- Kein Skript-Marktplatz.

## Marktbild

| | ScriptRunner Cloud | ScriptRunner Connect | Atlassian Automation | atlcli scripts |
|---|---|---|---|---|
| Sprache | Groovy/HAPI, etwas JS/TS | TS (V8, WinterCG) | Smart Values | TS |
| Code-Ablage | Browser-Konsole | Web-Editor, CLI-Sync; lokal nur mit Mocks | UI | git, PR, CI |
| Limits | 240 s/Skript, Jobs ≥ 1 h, Escalation ≤ 50 Issues | 15 min async | Rule-Run-Quote (Confluence Standard: 100/Monat) | lokal/CI frei |
| Preis | pro User der ganzen Instanz | ab ~15.000 USD/Jahr (AWS-Listing) | Tier | keine Lizenz |
| Dry-Run | nein | nein | nein | **Standard** |

Lücke: SR Connect hat „typisierte TS-Skripte + gemanagte APIs“, aber lokales/CI-Ausführen mit
echten Credentials ist dort zweitklassig. Nachfrage-Signal: ScriptFree (Aug. 2026) konvertiert
SR-Groovy in typisiertes Forge-JS.

## Getroffene Entscheidungen

| Frage | Entscheidung | Begründung |
|---|---|---|
| Threat-Model | Auch geteilte und LLM-generierte Skripte | rechtfertigt echte Sandbox statt Bun-Worker |
| Hosts | Isomorph von Anfang an: CLI, Extension, Forge | Engine ist reines TS; Verlust nur bei Dateisystem-Verben |
| QuickJS-Build | `quickjs-emscripten-core` + **Sync**-Variante mit Promise-Brücke | echte Parallelität (`Promise.all`), kleiner/schneller; Asyncify erlaubt nur einen suspendierten Call |
| Default | Plan/Apply, Dry-Run ist Standard | Sicherheitsnetz, Hauptunterscheidungsmerkmal |
| Plan in CI | als Artefakt exportierbar, digest-gebundenes Apply | Review im PR, Apply nach Merge |

Die bestehende Research-Runtime (`@langchain/quickjs`, Asyncify) bleibt unverändert; LangChain
gibt die Variante dort vor. `quickjs-emscripten@0.32.0` liegt bereits im Lockfile.

## Architektur

```
packages/script-runtime   (neu, isomorph, keine Node/Bun/Chrome-APIs)
  ├─ sandbox     QuickJS-Lifecycle, Limits, Promise-Brücke, JSON-Marshalling, frozen global
  ├─ verbs       atlcli.* — validiert (zod), ruft Ports, schreibt Writes ins Change-Set
  ├─ plan        Change-Set-Aufbau, Digest, Apply mit Versions-Check
  └─ ports       ScriptPort (operationsbasiert: jiraSearchPage, confluenceGetPage, …), ScriptFs? (optional)

Hosts liefern nur Ports:
  CLI        fetch + Profil-Auth, ScriptFs auf den Skriptordner begrenzt
  Extension  bestehende Session-Transporte
  Forge      @forge/bridge requestConfluence (asUser)
```

- **Transpilierung:** Skripte müssen `erasableSyntaxOnly` erfüllen (kein `enum`/`namespace`), damit
  reines Type-Stripping genügt. Der Host liefert den Stripper: `Bun.Transpiler` in der CLI,
  später sucrase im Browser. Das erzeugt keine Verhaltensdrift.
- **Typen:** `atlcli.d.ts` wird aus den Verb-Definitionen generiert und in `scripts/api-report.ts`
  aufgenommen. `atlcli.*` ist öffentliche API und folgt der SemVer-Policy der Libraries.
- **Port auf Operationsebene:** `packages/confluence/src/client.ts` hängt an Profilen bzw.
  Session-Cookies und ist für Forge nicht direkt nutzbar (gleiche Erkenntnis wie beim Export).
  Verben bauen deshalb keine Raw-Requests, weil das Paging, Fehlerformen und ADF-Handling
  duplizieren würde. Sie rufen Operationen eines `ScriptPort` auf. Die CLI implementiert den Port
  über die bestehenden Clients, Forge später über `requestConfluence`.
- **Pagination:** Search-Verben sind Async-Iteratoren. `/rest/api/3/search/jql` hat Token-Paging
  und kein `total` mehr.

## Skript-Vertrag

```ts
export const meta = {
  name: "close-stale-bugs",
  permissions: ["jira:read", "jira:write:ATLCLI"],   // default-deny, Projekt-/Space-gebunden
  hosts: ["cli", "extension", "forge"],              // optional; script check prüft Verben dagegen
  limits: { maxWrites: 200 },
  params: { days: { type: "number", default: 180 } },
};

export default async function (params: { days: number }) {
  for await (const issue of atlcli.jira.search(
    `project = ATLCLI AND type = Bug AND updated < -${params.days}d`,
  )) {
    await atlcli.jira.comment(issue.key, "Auto-closed: stale");
    await atlcli.jira.transition(issue.key, "Won't Do");
  }
}
```

- `meta` ist ein reines Literal und wird statisch ausgelesen, bevor Code läuft.
- `permissions` sind nur eine Obergrenze. Tatsächlich gelten immer die Rechte des ausführenden
  Users bzw. Profils.

## API-Oberfläche (MVP)

Kuratiert statt aller ~200 Client-Methoden.

| Namespace | Verben |
|---|---|
| `atlcli.jira` | `search` (iter), `get`, `create`, `update`, `transition`, `comment`, `link` |
| `atlcli.confluence` | `search` (CQL, iter), `getPage` (`{ markdown }`), `createPage`, `updatePage`, `upsertPage`, `labels.add/remove`, `comment` |
| `atlcli` | `log`, `params`, `host` (Name + verfügbare Capabilities) |
| `atlcli.fs` | nur CLI: `read`/`write` innerhalb des Skriptordners |

Seiten werden als Markdown gelesen und geschrieben, über die bestehende Konvertierung.
Später wäre `atlcli.export.*` (DOCX/PDF) ein naheliegendes Verb; die Engine läuft bereits isomorph.

## Plan/Apply

- Ein Dry-Run führt das Skript vollständig aus. Reads gehen live, Write-Verben werden als
  Operationen in ein `@atlcli/change-set` aufgezeichnet und geben einen plausiblen Platzhalter
  zurück (z. B. eine vorläufige ID).
- Jede Operation trägt die Version des Zielobjekts zum Zeitpunkt des Plans.
- Apply prüft den Digest, danach pro Operation die Version. Bei Drift wird abgebrochen; es gibt
  keinen stillen Merge.
- Grenze: Skripte, deren Logik vom Ergebnis eines eigenen Writes abhängt (Seite anlegen, danach
  Kindseite darunter), werden mit Platzhalter-Referenzen geplant und beim Apply in Reihenfolge
  aufgelöst. Echte Read-after-Write-Abhängigkeiten werden im Plan als `dependsOn` markiert.

## Sicherheit

- **WASM-Grenze:** Engine-Bugs (QuickJS-CVEs 2025, quickjs-ng-CVEs 2026) korrumpieren nur den
  WASM-Speicher. Deshalb gehen keine Tokens, kein Profil und kein `fetch` in die Sandbox. Versionen
  werden exakt gepinnt, in CI läuft der Debug-Build mit Leak-Erkennung.
- **Marshalling:** Daten gehen ausschließlich als JSON-Kopie über die Grenze, nie als Host-Referenz.
  Jedes Argument wird auf dem Host validiert. Das `atlcli`-Global wird eingefroren.
- **DoS-Schutz:**
  - Speicher-, Stack- und Interrupt-Deadline.
  - Timeout und `AbortSignal` zusätzlich an jedem Host-Call, weil der Interrupt nicht feuert,
    solange auf ein Host-Promise gewartet wird.
  - Obergrenzen für Calls und Writes.
  - Ein Limiter mit Retry bei 429; die Werte bleiben konfigurierbar.
- **Lifecycle:** eine Runtime pro Lauf, Freigabe in `finally`.
- **Module:** nur relative Pfade innerhalb des Skriptordners.
- **Confused Deputy:** Ein geteiltes Skript handelt mit den Rechten dessen, der es startet. Die
  Sandbox schützt den Host, verhindert aber keine legitimen API-Calls. Gegenmittel ist der Plan:
  Er zeigt Herkunft und Version des Skripts, die deklarierten Permissions und jede Write-Operation.

## CLI-Oberfläche

```bash
atlcli script init [dir]                   # tsconfig.json + atlcli.d.ts
atlcli script check <file>                 # tsc --noEmit (Subprozess, TS 7) + meta/hosts-Prüfung
atlcli script run <file> [--param k=v]     # Dry-Run, Plan auf stdout bzw. --json
atlcli script run <file> --plan-out plan.json
atlcli script apply plan.json              # Digest- und Versions-Check
atlcli script run <file> --apply           # Plan und Apply in einem Schritt (interaktiv bestätigt; in CI mit --yes)
```

CI-Muster: Ein PR-Job erzeugt `plan.json` als Artefakt und postet die Zusammenfassung als Kommentar;
nach dem Merge führt ein Job `script apply` mit genau diesem Artefakt aus.

## JTBDs

| Job | Pain heute | Relief |
|---|---|---|
| Offboarding: Issues/Pages eines Users umhängen | Bulk-Edit per Klick, SR pro User lizenziert | kurzes Skript mit Plan |
| Backlog-Hygiene (stale, Labels, Komponenten) | Automation-Quote; SR ≤ 50 Issues, ≥ 1 h | CI-Cron, Plan im PR |
| Release Notes aus fixVersion → Seite | Groovy + Storage-XHTML | `upsertPage({ markdown })` |
| Wöchentlicher Sprint-/Statusreport | untypisierte Smart Values | typisiert, testbar, Bausteine `digest`/`jira-report` |
| Space-Governance (Owner, Alter, Labels, Archiv) | Confluence-Automation fast ohne Quote | eigene Regeln über `audit-wiki` hinaus |
| Epic ↔ Spec-Page-Konsistenz, tote Links | kein Tool deckt beide Produkte samt Inhalt ab | eine API über beide |
| Projekt-Bootstrapping aus Vorlage | manuell | Skript + Template-Engine, idempotent |
| Migrationen (Feldwerte, Seitenumzug, Template-Rollout) | Einmal-Skripte ohne Review | git, Plan, wiederholbar |
| Massenänderung freigeben lassen | kein Dry-Run am Markt | digest-gebundener Plan |
| Agentisch („räum das auf“) | LLM mit freiem API-Zugriff | LLM schreibt Skript → Sandbox → Mensch gibt Plan frei |

## Phasen

1. **Runtime + CLI:**
   - Inhalt: `packages/script-runtime`, die MVP-Verben, Plan/Apply, `script init|check|run|apply`.
   - Tests: echte QuickJS-Läufe, keine Mocks der Sandbox; Transport-Port mit aufgezeichneten
     Fixtures.
   - E2E: live gegen DOCSY/ATLCLI.
2. **Extension-Host:**
   - Inhalt: Skript ausführen und Plan anzeigen; der Agent erzeugt Skripte über dieselbe Runtime.
   - Abnahme: der Agent-Skill unter `skills/atlcli/` ist aktualisiert.
3. **Forge-Host:** siehe `SCRIPTS-APP.md`.
4. **Später:** `atlcli.export.*`, Skript-Sync zwischen git und Confluence-Library
   (`script push/pull`).

## Offene Fragen

1. Soll im Dry-Run ein Platzhalter-Ergebnis für Writes genügen, oder sollen Skripte mit
   Read-after-Write-Abhängigkeit im Dry-Run abbrechen? (Vorschlag: Platzhalter + `dependsOn`.)
2. Granularität der Permissions: Projekt-/Space-Ebene reicht für MVP?
3. ~~Transpiler~~ — entschieden: `erasableSyntaxOnly`, der Stripper kommt vom Host (siehe Architektur).

Implementierungsplan für das MVP: [scripting-sandbox-mvp-plan.md](./scripting-sandbox-mvp-plan.md).

## Quellen

- ScriptRunner Cloud: [Feature-Parität](https://docs.adaptavist.com/sr4jc/latest/differences-between-scriptrunner-for-jira-server-and-jira-cloud/feature-parity), [Limits](https://docs.adaptavist.com/sr4jc/latest/get-started/limitations), [Breaking Changes](https://docs.adaptavist.com/sr4jc/current/release-notes/breaking-changes), [HAPI](https://scriptrunnerhq.com/inspiration/blog/hapi-arrives-on-jira-cloud)
- ScriptRunner Connect: [Runtime](https://docs.adaptavist.com/src/latest/scripting/runtime), [Limits](https://docs.adaptavist.com/src/latest/limits-and-quotas), [lokal ausführen](https://docs.adaptavist.com/src/latest/external-coding/test-and-run-scripts-locally), [AWS-Listing](https://aws.amazon.com/marketplace/pp/prodview-g2kljjp2gkuac)
- Automation: [Usage](https://support.atlassian.com/jira-software-cloud/docs/how-is-my-usage-calculated/)
- ScriptFree: [Marketplace](https://marketplace.atlassian.com/apps/1095808148/scriptfree)
- QuickJS: [quickjs-emscripten](https://github.com/justjake/quickjs-emscripten), [CVE-2025-62491](https://nvd.nist.gov/vuln/detail/cve-2025-62491)
- Unsicher bzw. zu verifizieren:
  - SR-Per-User-Preise (Seitendatum unbekannt)
  - quickjs-ng-CVE-Details (nur Tracker als Quelle)
  - Zeitpunkt der Automation-Verbrauchsabrechnung
