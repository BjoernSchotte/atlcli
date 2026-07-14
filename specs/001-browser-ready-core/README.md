# Spec 001 — Phase 0: atlcli-Basis fit machen (Browser-Ready Core)

**Status:** Draft · **Stand:** 2026-07-14 · **Aufwand:** ~1–2 Wochen
**Quelle:** `~/code/rovo-skills/FAHRPLAN.md` Phase 0 · Detailrecherche: `~/code/rovo-skills/research/TYPST-EXPORT-ANGLE.md` §7.1–7.5, `~/code/rovo-skills/research/AGENT-OVERLAY-ANGLE.md` §1.2

## Ziel

Der isomorphe Kern von atlcli (Konverter + `ConfluenceClient`/`JiraClient` + URL-Helper) soll **nachweisbar und dauerhaft fürs Browser-Target bauen** — als Voraussetzung für die Chrome-Extension (Phase 1: Export-PoC) und alle späteren Ausbaustufen (Agent-Overlay, Studio).

Empirisch validiert (13.07.2026, `bun build --target=browser` gegen die echte Codebase):

- `packages/confluence/src/markdown.ts` baut **heute schon unverändert** fürs Browser-Target (88 Module, 1,24 MB, null `node:`-Imports im Output).
- `packages/jira/src/analysis.ts` baut ebenfalls.
- Beide **Clients scheitern** — nicht am eigenen Code, sondern am Core-Barrel: `packages/core/src/index.ts` re-exportiert per `export * from …` das gesamte Paket, inklusive der imperativen Shell (`config.ts`, `keychain.ts`, `update.ts`, …).

Phase 0 behebt genau das und ergänzt drei kleine Bausteine, die Phase 1 direkt braucht (Session-Auth, URL→Entität-Extraktor, Scroll-Platzhalter-Mapping).

## Ist-Zustand: Node-Abhängigkeiten in `@atlcli/core`

Was die Clients tatsächlich aus `@atlcli/core` importieren: `Profile` (Typ), `getLogger`, `generateRequestId`, `redactSensitive`, `buildAuthHeader`, `buildTlsOptions`, `TlsOptions`, `getConfluenceBaseUrl`.

| Modul | Node-Imports | Browser-tauglich? |
|---|---|---|
| `config.ts` | `node:fs`, `node:fs/promises`, `node:path`, `node:os` | ❌ (aber: nur die **Typen** `Profile`/`AuthType` werden von Clients gebraucht) |
| `keychain.ts` | `node:child_process` | ❌ |
| `update.ts` | `node:fs`, `node:stream`, `node:crypto`, `node:os` | ❌ |
| `prompt.ts` | `node:readline` | ❌ |
| `flags.ts` | `node:fs`, `node:path`, `node:os` | ❌ |
| `utils.ts` | `node:fs/promises`, `node:path` | ❌ |
| `logger.ts` | `node:fs`, `node:fs/promises`, `node:path`, `node:os`, `node:crypto` | ❌ heute — Sink muss austauschbar werden |
| `tls.ts` | `node:fs` (`readFileSync` für CA-Zertifikate) | ❌ Funktion / ✅ Typ `TlsOptions` |
| `auth.ts` | `node:buffer` + Import von `keychain.ts` | ❌ heute — Kern-Logik ist portierbar |
| `redact.ts` | — | ✅ |
| `confluence-url.ts` | — (nur Typ-Import aus `config.ts`) | ✅ |
| `templates/` | (Handlebars) | vermutlich ✅, für Clients irrelevant |

## Arbeitspakete

### 0.1 Core-Split (Barrel-Fix)

**Soll:** `@atlcli/core` bekommt zwei Entries:

- **Browser-sicherer Entry** (`src/index.browser.ts` o.ä.): Typen (`Profile`, `AuthType`, `DeploymentType`, `TlsOptions`, Log-Typen), `redact.ts`, `confluence-url.ts`, der neue Entitäts-Extraktor (0.5), Logger-Kern mit austauschbarem Sink, `generateRequestId`, entkoppeltes `buildAuthHeader` (0.2).
- **Node-Entry** (`@atlcli/core/node`): alles Bisherige — `config`-Datei-I/O, `keychain`, `update`, `prompt`, `flags`, `utils`, `tls`-Dateiladung, Datei-Logger-Sink, Keychain-Token-Resolver.

**Mechanik (Empfehlung, siehe offene Frage F1):** `exports`-Conditions in `packages/core/package.json` —

```jsonc
{
  "exports": {
    ".": {
      "browser": "./src/index.browser.ts",
      "default": "./src/index.ts"
    },
    "./browser": "./src/index.browser.ts",
    "./node": "./src/index.node.ts"
  }
}
```

Damit bleibt `import { loadConfig } from "@atlcli/core"` im CLI **unverändert lauffähig** (non-breaking), während `bun build --target=browser` automatisch den browser-sicheren Entry zieht. Die expliziten Subpaths `./browser` und `./node` dokumentieren die Grenze und erlauben gezielte Imports.

**Schritte:**

1. Typen aus `config.ts` extrahieren: `Profile`, `AuthType`, `DeploymentType` etc. nach `src/types.ts` (reine Typen, null Imports); `config.ts` re-exportiert sie für Rückwärtskompatibilität.
2. `logger.ts` splitten: Kern (Level-Logik, Entry-Typen, Redaction, `generateRequestId`) von der Datei-Sink trennen. Interface `LogSink { write(entry: LogEntry): void | Promise<void> }`; Node-Sink = heutiges JSONL-Verhalten, Browser-Default = `console`-Sink (Level ≥ warn). `generateRequestId` auf `globalThis.crypto.randomUUID()` umstellen (läuft in Bun, Node ≥ 19, Browser — `node:crypto`-Import entfällt).
3. `tls.ts` splitten: Typ `TlsOptions` in den Browser-Entry; `buildTlsOptions` (liest CA-Dateien) in den Node-Entry. Clients: TLS-Optionen optional injizierbar machen bzw. bei `undefined` weglassen (im Browser gibt es kein `tls`-Feld auf `fetch`).
4. `index.browser.ts` + `index.node.ts` anlegen, `index.ts` bleibt als Node-Superset (Alias auf `index.node.ts`).
5. `apps/cli` und alle Nicht-Browser-Verbraucher kompilieren unverändert (Typecheck + Tests grün).

**Tests:** bestehende Core-Tests bleiben grün; neuer Test, dass der Browser-Entry keine `node:`-Module referenziert (Build-Assertion, siehe 0.4); Logger-Sink-Injektion unit-getestet.

### 0.2 `buildAuthHeader` entkoppeln

**Ist:** `auth.ts` importiert `Buffer` aus `node:buffer` und `getKeychainToken` aus `keychain.ts` (→ `child_process`); `buildAuthHeader(profile)` ruft intern `resolveToken` (env → Keychain → Config).

**Soll:** Kern-Funktion pur und isomorph:

```ts
// browser-safe
export type TokenResolver = (profile: Profile) => string | null;

export function buildAuthHeader(profile: Profile, resolveToken: TokenResolver): string;
```

- Base64 via `btoa()` statt `Buffer.from(...).toString("base64")` (Achtung Umlaute/Non-ASCII in E-Mail/Token: `btoa(String.fromCharCode(...new TextEncoder().encode(s)))` oder äquivalenter Helper — mit Test für Nicht-ASCII-Credentials).
- Node-Entry exportiert einen vorverdrahteten Wrapper mit heutiger Signatur (`buildAuthHeader(profile)` = Kern + Keychain-Resolver), damit CLI-Code und externe Nutzer nichts ändern müssen.
- `resolveToken` (env/Keychain/Config-Priorität) bleibt komplett im Node-Entry.

**Tests:** Header-Äquivalenz alt vs. neu (Basic + Bearer), Non-ASCII-Roundtrip, Fehlerfälle (kein Token, keine E-Mail) — Regressionstests gegen das heutige Verhalten.

### 0.3 Auth-Modus `session`

**Ist:** `AuthType = "apiToken" | "bearer" | "oauth"` (`config.ts:6`). Clients setzen immer einen `Authorization`-Header.

**Soll:** Neuer Modus für die Extension — sie reitet auf der bestehenden Atlassian-Browser-Session (Cookies), Zero-Config:

- `AuthType` um `"session"` erweitern.
- `ConfluenceClient` + `JiraClient`: bei `auth.type === "session"` **keinen** `Authorization`-Header setzen und alle `fetch`-Calls mit `credentials: "include"` absetzen (auch Attachment-Up-/Downloads).
- `buildAuthHeader` wird für Session-Profile nie aufgerufen (Guard im Client, nicht Exception-Pfad).
- CLI-Verhalten: `session` ist im CLI nicht sinnvoll (keine Browser-Session). `atlcli` lehnt Session-Profile mit klarer Fehlermeldung ab („auth type 'session' is only supported in browser contexts") — bewusst kein stiller Fallback.
- `resolveDeploymentType` in `confluence-url.ts` prüfen: `session` darf die Cloud/DC-Heuristik nicht kippen (Session-Profile sind Cloud-typisch, aber DC-Session ist denkbar → `deploymentType` bei Session-Profilen explizit setzen bzw. Default Cloud).

**Tests:** Client-Unit-Tests (Mock-Fetch): kein Authorization-Header, `credentials: "include"` gesetzt; CLI-Fehlerpfad; Typecheck über alle `auth.type`-Switches (exhaustiveness).

### 0.4 CI-Gate Browser-Build

**Soll:** Isomorphie darf nie wieder unbemerkt brechen. Pipeline-Check, der fürs Browser-Target baut:

- Script `scripts/check-browser-build.ts`: `bun build --target=browser` für
  - `packages/confluence/src/markdown.ts`
  - `packages/confluence/src/client.ts`
  - `packages/jira/src/client.ts`
  - `packages/core/src/index.browser.ts`
- Assertions: Exit-Code 0 **und** Bundle-Scan auf `node:`/`bun:`-Spezifier im Output (Belt-and-Suspenders — Bun externalisiert `node:`-Imports beim Browser-Build teils statt zu failen).
- Einbindung: `package.json`-Script `check:browser`, Turbo-Task, Job/Step in `.github/workflows/ci.yml` neben Typecheck/Tests.

**Akzeptanz:** CI rot, wenn jemand einen `node:`-Import in einen der vier Entrypoints (transitiv) einführt.

### 0.5 URL→Entität-Extraktor

**Ist:** `confluence-url.ts` kann Confluence-URLs nur *erkennen* (`isConfluencePageUrl`, Regex `/^\/(?:spaces|pages|display)\//`), aber nichts *extrahieren*.

**Soll:** Versionierte Pattern-Registry (Daten, nicht Code — per Update aktualisierbar, testbar), die aus einer Tab-URL die Atlassian-Entität ableitet. Browser-Entry von `@atlcli/core` (z.B. `src/entity-url.ts`).

```ts
export type AtlassianEntity =
  | { product: "confluence"; type: "page";     pageId: string; spaceKey?: string }
  | { product: "confluence"; type: "blogpost"; contentId: string; spaceKey?: string }
  | { product: "confluence"; type: "space";    spaceKey: string }
  | { product: "jira";       type: "issue";    issueKey: string; projectKey: string }
  | { product: "jira";       type: "board";    projectKey: string; boardId: string }
  | { product: "jira";       type: "queue";    projectKey: string; queueId: string };

export function extractEntityFromUrl(url: string, registry?: PatternRegistry): AtlassianEntity | null;
```

**Pattern-Registry v1** (aus `AGENT-OVERLAY-ANGLE.md` §1.2):

| Produkt | URL-Muster (Cloud) | Extrahiert |
|---|---|---|
| Confluence Page | `/wiki/spaces/{spaceKey}/pages/{pageId}/{slug}` | `spaceKey`, `pageId` |
| Confluence (legacy) | `/wiki/display/{spaceKey}/{title}` · `?pageId={id}` | `spaceKey` bzw. `pageId` |
| Confluence Blogpost | `/wiki/spaces/{spaceKey}/blog/{yyyy}/{mm}/{dd}/{contentId}/…` | `spaceKey`, `contentId` |
| Jira Issue | `/browse/{ISSUE-KEY}` · `…?selectedIssue={KEY}` | `issueKey`, `projectKey` (Präfix vor `-`) |
| Jira Board/Backlog | `/jira/software/(c/)?projects/{projectKey}/boards/{boardId}` | `projectKey`, `boardId` |
| JSM Queue | `/jira/servicedesk/projects/{projectKey}/queues/custom/{queueId}` | `projectKey`, `queueId` |

Dazu Data-Center-Varianten (Context-Path, `/display/`, `/pages/viewpage.action?pageId=`), die die bestehende `resolveDeploymentType`-Logik respektieren.

**Design-Prinzipien:**

- Registry als versionierte Datenstruktur (`{ version: 1, patterns: [...] }`) mit Default-Export im Core; die Extension kann später eine aktualisierte Registry injizieren (Remote-Config), ohne Code-Release.
- **DOM-Meta nur als Fallback und nicht Teil von Phase 0** — der Extraktor bleibt DOM-frei (reine URL-Funktion). Das Interface sieht optional einen `entityHint` vor, den die Extension aus DOM-Fallbacks (z.B. `meta[name=ajs-page-id]` auf DC) beisteuern kann; die Fallback-Implementierung selbst ist Phase-1-Arbeit.
- `isConfluencePageUrl` bleibt erhalten (wird intern auf den Extraktor umgestellt: `extract(...) !== null`).

**Tests:** Fixture-Tabelle echter URLs (Cloud + DC, mit/ohne Context-Path, Legacy-Formate, Query-Varianten, Negativ-Fälle wie Marketing-Seiten auf `atlassian.net`) — jede Registry-Zeile mindestens ein Positiv- und ein Negativ-Fixture.

### 0.6 Scroll-Platzhalter-Katalog (parallel, ~0,5 Tage)

**Ist:** [spec/scroll-word-exporter-features.md](../../spec/scroll-word-exporter-features.md) enthält bereits einen umfangreichen `$scroll.*`-Platzhalter-Katalog (Page-Info, Metadaten, Header/Footer, TOC) — die Rohdaten-Erhebung ist also weitgehend erledigt, aber laut Recherche **noch nicht gegen die aktuelle K15t-Doku verifiziert**.

**Soll (Pflicht vor Phase-1-Schritt 1.3):**

1. Katalog gegen die aktuelle K15t-Doku ([help.k15t.com/scroll-word-exporter](https://help.k15t.com/scroll-word-exporter)) verifizieren: Vollständigkeit (Titel-/Metadaten-Platzhalter, Content-Einfügepunkt, Header/Footer-Variablen, TOC-Marker), Abweichungen und neue Platzhalter nachtragen.
2. **Kompatibilitäts-Mapping-Tabelle** erstellen: `Scroll-Platzhalter → atlcli-Datenmodellfeld` (z.B. `$scroll.title` → `ConfluencePageDetails.title`, `$scroll.pageid` → `.id`, …) mit Status je Zeile: `direkt` / `ableitbar` / `nicht unterstützt (v1)` / `bewusst nie`.
3. Ergebnis als `specs/001-browser-ready-core/scroll-placeholder-mapping.md` ablegen (wird in Phase 1.3 zur Implementierungsvorlage).

**Akzeptanz:** Jeder dokumentierte Scroll-Platzhalter hat eine Mapping-Zeile mit Status; Lücken im atlcli-Datenmodell sind explizit benannt.

## Reihenfolge & Abhängigkeiten

```
0.1 Core-Split ──► 0.2 buildAuthHeader ──► 0.4 CI-Gate (Clients bauen erst nach 0.1–0.3)
                └► 0.3 Session-Auth    ──┘
0.5 URL-Extraktor   (unabhängig, kann parallel starten; landet im Browser-Entry aus 0.1)
0.6 Scroll-Katalog  (komplett parallel, kein Code)
```

Empfohlene Umsetzung als 3–4 PRs: (1) 0.1+0.2, (2) 0.3, (3) 0.4, (4) 0.5; 0.6 als Doku-PR jederzeit.

## Nicht-Ziele (Phase 1+)

- Kein `apps/extension`-Workspace, kein MV3-Skeleton, kein Side Panel.
- Kein DOCX-/PDF-Export, keine Templating-Engine-Entscheidung (`docx-templates` vs. docxtemplater — das ist der Phase-1-Spike).
- Keine DOM-Fallback-Implementierung für die Entitäts-Erkennung (nur das Hint-Interface).
- Kein Mermaid-Rendering, keine Font-Themen.

## Erfolgskriterien Phase 0 (gesamt)

1. `bun build --target=browser` baut `markdown.ts`, beide Clients und den Core-Browser-Entry ohne Fehler und ohne `node:`-Spezifier im Output — **abgesichert durch CI**.
2. CLI-Verhalten unverändert: alle bestehenden Tests grün, `bun run typecheck` grün, keine Änderung an Config-Format oder Auth-Verhalten bestehender Profile.
3. Ein Client mit `auth.type: "session"` sendet keinen Authorization-Header und nutzt `credentials: "include"` (unit-getestet; E2E folgt erst mit der Extension in Phase 1).
4. `extractEntityFromUrl` deckt alle Registry-Muster mit Fixtures ab.
5. Scroll-Platzhalter-Mapping-Tabelle liegt verifiziert vor.

## Entscheidungen

- **F1 — Exports-Strategie:** offen (Erläuterung der Auswirkungen angefragt, 2026-07-14). Spec geht bis zur Entscheidung von `exports`-Conditions aus.
- **F2 — Logger-Browser-Default:** ✅ entschieden (2026-07-14): `console`-Sink mit Level ≥ warn.
- **F3 — Registry-Scope 0.5:** ✅ entschieden (2026-07-14): Confluence + Jira; JSM-Queues erst mit Phase 3 (Agent-Overlay).
