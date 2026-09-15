# Confluence Virtual Filesystem (VFS) für Coding Agents

**Status:** Konzept / Machbarkeitsstudie
**Datum:** 2026-09-15
**Ziel:** Coding Agents (Claude Code, Codex, Cursor, …) arbeiten mit `ls`, `cd`, `cat`, `grep`, `find`, `sed` direkt auf Confluence-Inhalten. Sichtbarkeit exakt wie der authentifizierte Nutzer. Keine MCP-Tool-Aufrufe nötig.

Quellen: drei parallele Recherchen (just-bash, Mount-Technologien, Atlassian-Auth/Prior Art), alle Quellen live geprüft am 2026-09-15. Befunde älter als 6 Monate sind mit **[alt]** markiert.

---

## 1. Kurzfazit

- **Machbar, und zwar kurzfristig.** atlcli hat alle Bausteine schon: `ConfluenceClient` (Hierarchie, Suche, Versionen, Move, Trash), `storageToMarkdown`/`markdownToStorage`, Pfad-Mapping (`hierarchy.ts`, Index-Pattern), Frontmatter mit Page-ID, SQLite-Sync-DB.
- **Empfohlene Architektur:** ein gemeinsamer **VFS-Kern** (reine Logik: Pfad ↔ Page, Cache, Write-Back, CQL-Beschleunigung) mit **zwei Frontends**:
  1. **`atlcli wiki sh`** – eingebettete Bash auf Basis von **just-bash** (Vercel Labs). Kein Mount, kein Treiber, funktioniert überall. Erstes Ziel.
  2. **`atlcli wiki mount`** – echter OS-Mount über einen **lokalen WebDAV-Server** (Loopback). Kext-frei auf macOS und Windows, Linux braucht `davfs2`. Zweites Ziel.
- **Nicht empfohlen:** FUSE (macFUSE proprietär, FUSE-T nur nicht-kommerziell frei, Node-Bindings unter Bun unerprobt, Windows braucht WinFsp-Installer).
- **just-bash ist ein Kandidat, mit drei konkreten Risiken** (Bun-Crash bei aktivem Defense-in-Depth, `fetch` im Backend muss in Trusted-Scope laufen, `grep -r` ohne Cache = ein Request pro Seite). Alle drei sind beherrschbar.
- **Berechtigungen:** Confluence erzwingt Sichtbarkeit serverseitig pro Aufrufer. Das VFS braucht keine eigene ACL-Logik, nur konsequent den Profil-Token des Nutzers und einen **profilgebundenen Cache**.

---

## 2. Warum ein Dateisystem statt MCP

Belege aus 2025/2026 (Details in Abschnitt 10):

- Anthropic „Code execution with MCP“: Tool-Definitionen als Dateibaum, 150k → 2k Tokens in einem Workflow **[alt, 2025-11]**.
- Vercel „How to build agents with filesystems and bash“: Agentenkosten 1,00 $ → 0,25 $ pro Lauf **[alt, 2026-01]**.
- Arize „MCP vs CLI skills“ (2026-05): gleiche Korrektheit, harte Aufgaben ≈ 2,00 $ / 71 Calls (MCP) vs. ≈ 0,19 $ / 7 Calls (CLI + Skill).
- **Gegenbeleg** Vercel/Braintrust „Testing if bash is all you need“ (2026-01): reines Bash/Filesystem auf semistrukturierten Daten 53–63 % korrekt bei 7× Kosten gegenüber SQL. Lehre: das VFS braucht einen **strukturierten Suchpfad** (CQL), sonst brennt `grep -r` Tokens und API-Budget.
- Atlassian selbst hat mit dem **Teamwork Graph CLI** (GA 2026-06-30) „CLI over MCP“ validiert, liefert aber keine Dateisicht, nur OAuth, und rechnet angereicherte Suchen in Rovo-Credits ab.

**Differenzierung atlcli:** Datei-Sicht + `grep`, kostenlose REST-Nutzung ohne Credits, Data-Center-Support, Offline-Cache, bestehende Markdown-Konvertierung.

---

## 3. Anforderungen

### Muss
- Lesen: Spaces, Seitenbaum, Seiteninhalt als Markdown, Attachments, Labels, Versionen.
- Sichtbarkeit exakt wie der Nutzer des aktiven Profils (Cloud API-Token, OAuth, DC-PAT).
- `ls`, `cat`, `find`, `grep -r`, `tree` in akzeptabler Zeit für Spaces mit 1.000–5.000 Seiten.
- Read-only per Default, Schreiben per Opt-in (`--rw`).
- Kein Kernel-Treiber, keine Admin-Rechte für den Default-Pfad.

### Soll
- Schreiben: Seite anlegen/ändern (`echo`, `sed -i`, Editor), umbenennen, verschieben (`mv`), in Papierkorb (`rm`).
- Convenience-Verzeichnisse: Suche, Labels, kürzlich geändert, Versionen, Kommentare.
- Wiederverwendung im eingebauten `chat`/`research`-Agenten als Bash-Tool.

### Nicht-Ziele (v1)
- Whiteboards, Datenbanken, Embeds bearbeiten (nur als Platzhalter listen).
- Jira als Dateisystem (später über denselben Kern möglich: `/jira/ATLCLI/ATLCLI-123.md`).
- Purge (endgültiges Löschen) und Space-Administration.

---

## 4. Architekturüberblick

```
┌──────────────────────────────────────────────────────────────┐
│ Frontends (imperative Shell)                                 │
│  A) atlcli wiki sh  ── just-bash ── IFileSystem-Adapter      │
│  B) atlcli wiki mount ── webdav-server v2 ── FS-Adapter      │
│  C) chat/research Agent ── bash-Tool ── (A wiederverwendet)  │
└───────────────┬──────────────────────────────────────────────┘
                │  VfsNode-API (stat/readdir/read/write/rename/rm)
┌───────────────▼──────────────────────────────────────────────┐
│ packages/confluence-vfs (functional core)                    │
│  • PathMapper:   /DOCSY/Parent/Child.md ⇄ pageId            │
│  • TreeIndex:    Space-Baum im Speicher (id, title, parent)  │
│  • BodyCache:    (pageId, version) → Markdown, SQLite/Disk   │
│  • SearchBridge: grep/find → CQL, danach lokales Regex       │
│  • WriteBack:    version+1, 409-Handling, 3-Way-Merge        │
│  • VirtualDirs:  /.search/, /.labels/, /.recent/, /.versions │
└───────────────┬──────────────────────────────────────────────┘
                │
        ConfluenceClient (bestehend) ── REST v2 / v1 / DC v1
```

Prinzip „functional core, imperative shell“: der Kern kennt weder just-bash noch WebDAV, nur eine schmale asynchrone Node-API. Beide Frontends sind dünne Adapter. Tests laufen gegen den Kern mit einem Fake-Client.

---

## 5. Frontend A: eingebettete Shell mit just-bash

### Warum just-bash
- Einzige gepflegte JS/TS-Bibliothek, die **Bash-Interpreter + asynchrones, pluggbares Dateisystem** kombiniert. Apache-2.0 wie atlcli.
- Stand 2026-09-15: Version **3.4.2** (2026-08-22), letzte Commits 2026-09-07, 4,3k Stars, ~876k Downloads/Woche, offiziell noch „beta“.
- Befehle: `ls cat find grep rg sed awk jq yq sort head tail wc tree diff xargs …`, Pipes, Redirections, Schleifen, Funktionen, Globs, Heredocs.
- `IFileSystem` ist vollständig async (`readFile`, `writeFile`, `readdir`, `stat`, `mkdir`, `rm`, `mv`, …). Nur `resolvePath` und `getAllPaths` sind sync; `getAllPaths` darf `[]` liefern. Ein Subagent hat ein 40-Zeilen-Fake-REST-Backend über `MountableFs.mount("/confluence", fs)` getestet: `ls -R`, `grep -rn`, `find -name`, `sed`, `awk`, `jq`, `echo > file` und Globs funktionieren, nur `stat/readdir/readFile/writeFile` wurden aufgerufen.
- Prior Art mit genau diesem Muster: Dropbox (`just-bash-dropbox`), S3/Postgres (`just-bash-openfs`), Redis (Upstash, 2026-04), SQLite (Turso AgentFS), Chroma (Mintlify ChromaFs, 2026-03).

### Risiken und Gegenmaßnahmen

| Risiko | Befund | Maßnahme |
|---|---|---|
| **Bun-Inkompatibilität** | 3.4.2 wirft unter Bun 1.3.x bei jedem `exec()` `DefenseInDepthBox: critical patches failed` (Issue #386, offen, ohne Antwort). | `defenseInDepth: false` setzen (Host-Code ist laut THREAT_MODEL ohnehin trusted), alternativ `just-bash/browser`-Export oder Pin auf 2.14.5 (das pinnt auch `@ai-sdk/sandbox-just-bash`). Falls nötig: `bun patch`, atlcli nutzt `patchedDependencies` bereits. |
| **Backend-IO im Untrusted-Scope** | Bei aktivem Defense-in-Depth sind `fetch`, Timer und `process.env` im `IFileSystem` blockiert; `fetch` erscheint als `ENOENT`. | Jede Backend-Methode in `DefenseInDepthBox.runTrustedAsync()` kapseln (so macht es Commit #397 vom 2026-09-07 für Lazy-Provider), oder DiD aus. |
| **`grep -r` = N Requests** | just-bash läuft den Baum mit `stat` + `readFile` pro Datei; Hook `searchFiles` (Issue #185) ist nicht gemerged. | `grep` per `defineCommand` + `ctx.origCommand` überschreiben: erst CQL, dann Original-grep nur auf Treffer-Bodies (Abschnitt 8). |
| Paketgröße | 22,6 MB entpackt, 16 Runtime-Deps (QuickJS, sql.js, undici, …). | `commands: [...]` einschränken, Python/js-exec/sqlite nicht laden; Auswirkung auf `bun build --compile` messen. |
| Beta-Status, Remote-Backend-Issues ohne Maintainer-Antwort | #181, #185, #386 offen. | Kleine Workarounds selbst tragen, Version pinnen, Conformance-Tests im eigenen Repo. |

### Nutzung

```bash
# Einzelbefehl (Agent-freundlich, JSON-Exit-Code)
atlcli wiki sh --space DOCSY -c 'grep -rl "Kubernetes" /DOCSY | head'

# Interaktive Session
atlcli wiki sh --space DOCSY
/DOCSY $ ls
/DOCSY $ cat "Getting Started/_index.md"
/DOCSY $ find . -name "*.md" -newer .recent/7d

# Skript aus stdin
cat script.sh | atlcli wiki sh --space DOCSY --rw
```

Für Claude Code reicht ein `AGENTS.md`/Skill-Snippet („Für Confluence: `atlcli wiki sh -c '…'`, Space DOCSY, `--limit 10`“). Das ist das Muster, das Atlassian im Rovo-MCP-README und Arize in ihrer Eval als größten Token-Sparer nennen.

Gleicher Adapter, zweiter Konsument: der bestehende `chat`/`research`-Agent (DeepAgents + QuickJS) bekommt ein `bash`-Tool über dieselbe `IFileSystem`-Instanz (`bash-tool` von Vercel Labs, MIT, oder eigenes LangChain-Tool).

---

## 6. Frontend B: OS-Mount über WebDAV

### Bewertung der Mount-Technologien (Stand 2026-09-15)

| Ansatz | macOS | Linux | Windows | Zusatzinstallation | Bewertung |
|---|---|---|---|---|---|
| **WebDAV-Server in Bun + OS-Client** | `mount_webdav`/Finder, kein sudo | `davfs2` + root/fstab | `net use X: http://localhost:PORT/`, alle Editionen (50-MB-Limit) | keine auf macOS/Win | **Empfehlung** |
| NFSv3-Server (Rust `nfsserve` Sidecar) | eingebaut, kext-frei (rclone-erprobt) | `nfs-common` + root | nur Pro/Enterprise, „kinda works“ | Rust-Binary | Option 2, bessere Kernel-Caches |
| FUSE via `fuse-napi` (N-API, Aug 2026, 0 Stars) | macFUSE 5.3.1+ (proprietäre Lizenz, kein Auto-Install) | libfuse3 | nicht unterstützt | macFUSE | nur Linux denkbar, Bun ungetestet |
| FUSE-T | kext-frei, aber **nur nicht-kommerziell frei** | – | – | Cask | ungeeignet für Firmen-CLI |
| `bun:ffi` → libfuse3 | – | – | – | – | Bun-FFI offiziell „experimental, not for production“ |
| Apple FSKit / File Provider | signierte App-Extension nötig; FSKit-Backends von macFUSE/FUSE-T „experimental“, Bugs auf macOS 26.1/26.2 | – | ProjFS/Cloud Files | App-Bundle | nicht CLI-tauglich, 2027 neu bewerten |

Kein einziges Open-Source-Projekt mountet Confluence heute (GitHub-Suche 2026-09-15 leer). Jira: `jirafs` (2018, verwaist). Notion: `notionfs` ist Sync, kein Mount.

### Design des WebDAV-Frontends
- Bibliothek: `webdav-server` v2 (2.6.3, 2026-08-04, Unlicense), pluggbares `FileSystem`.
- Bindung nur an `127.0.0.1`, zufälliger Port, ohne Auth (Loopback), optional Bearer-Token im Header für Multi-User-Hosts.
- Pflicht für macOS Finder: `LOCK`/`UNLOCK` (sonst read-only gemountet), schnelle 404 für `._*` AppleDouble-Dateien, ETag aus `(pageId, version)`, `PROPFIND`-Antworten aus dem TreeIndex ohne API-Call.
- `atlcli wiki mount ~/confluence --space DOCSY` startet Server und ruft `mount_webdav` (macOS) bzw. `net use` (Windows) auf; Linux gibt `mount -t davfs`-Anleitung aus.
- Leistung: WebDAV-Clients sind gesprächig (Finder 2–5× Overhead). Die Latenz dominiert aber die Confluence-API, darum ist der Cache (Abschnitt 8) entscheidend, nicht das Protokoll. `grep -r` durch den Mount bleibt langsamer als in Frontend A, weil der Kernel keine CQL-Abkürzung kennt. Empfehlung in der Doku: für Volltextsuche `atlcli wiki sh -c 'grep …'` oder das Cache-Verzeichnis nutzen (so löst es auch `slack-fuse`: 15–25 Dateien/s durch FUSE vs. 62.000/s auf dem Projektionscache).

---

## 7. Pfadlayout und Metadaten

Das Layout folgt dem bestehenden Index-Pattern aus `hierarchy.ts`, damit `docs pull`-Arbeitsverzeichnisse und VFS austauschbar sind.

```
/                                   # Root: alle sichtbaren Spaces
├── DOCSY/                          # Space-Key
│   ├── _space.json                 # id, name, homepageId, permissions (read-only)
│   ├── _index.md                   # Homepage-Body
│   ├── getting-started.md          # Blattseite
│   ├── architecture/               # Seite mit Kindern
│   │   ├── _index.md               # eigener Body
│   │   ├── _attachments/           # Lazy: Metadaten aus v2, Bytes bei open()
│   │   │   └── diagram.png
│   │   ├── .versions/              # Read-only, max. 50 mit Body
│   │   │   ├── 12.md
│   │   │   └── 11.md
│   │   ├── .comments.md            # Footer-/Inline-Kommentare gerendert
│   │   └── deployment.md
│   ├── some-folder/                # Confluence-Folder (type: folder)
│   │   └── _index.md               # nur Frontmatter
│   ├── .labels/                    # virtuell: GET /labels/{id}/pages
│   │   └── runbook/ → Symlinks auf Seiten
│   ├── .recent/                    # virtuell: CQL lastmodified >= now("-7d")
│   │   ├── 24h/ 7d/ 30d/
│   └── .search/                    # virtuell: mkdir = Query anlegen
│       └── text ~ "kubernetes"/    # ls = CQL ausführen, Symlinks
└── .me.json                        # aktueller Nutzer, Profil, Deployment
```

Regeln:
- Slug-Erzeugung mit `slugifyTitle()` (bestehend). Kollisionen: `-2`, `-3` wie in `generateUniqueFilename()`. Confluence erzwingt eindeutige Titel pro Space, daher sind Kollisionen selten (nur Slug-Zusammenfall wie „A/B“ vs „A-B“).
- Nicht-Seiten-Kinder (Whiteboard, Database, Embed) erscheinen als `name.whiteboard.json` mit Link, read-only.
- Frontmatter wie heute plus VFS-Felder:

```markdown
---
atlcli:
  id: "623869955"
  title: "Architecture"
  version: 12
  parentId: "623869000"
  labels: [runbook, k8s]
  lastModified: "2026-09-14T10:22:00Z"
  url: https://site.atlassian.net/wiki/spaces/DOCSY/pages/623869955
---
```

- `stat`: `mtime` = `version.createdAt`, `size` = Länge des gerenderten Markdowns (aus Cache; unbekannt → geschätzt aus Body-Größe, damit `ls -l` nicht N Requests auslöst).
- Ein Symlink-Konzept (`.labels/x/page.md → ../../page.md`) hält Convenience-Verzeichnisse frei von Duplikaten; just-bash und WebDAV unterstützen beides (WebDAV: als Datei mit Weiterleitung im Body, da Clients keine Symlinks kennen).

---

## 8. Cache, Rate Limits und `grep`

### API-Fakten (Cloud v2, Spec geprüft 2026-09-15)
- Baum: `GET /spaces/{id}/pages?depth=root`, `GET /pages/{id}/direct-children` (das ältere `children` ist im Spec `deprecated`), `GET /pages/{id}/descendants?depth=10&limit=250` für `find`/`tree`.
- Bulk: `GET /pages?id=a,b,c&limit=250` mit oder ohne `body-format=storage` – bis zu 250 Seiten pro Request, der einzige „Bulk-Body-Fetch“. Das ist der Cache-Validator (ohne Body) und der Prefetcher (mit Body).
- Suche: nur v1 `GET /wiki/rest/api/search?cql=…` (nicht deprecated, Konsens 2026: bleibt). Liefert Excerpts.
- Rate Limits: Punktemodell seit 2026-03-02 gilt für **OAuth/Connect/Forge-Apps** (Tier 1: 65.000 Punkte/h **global pro App**, GET auf Seiten = 2 Punkte). API-Token-Verkehr ist explizit ausgenommen und nur durch unveröffentlichte Burst-Limits begrenzt; in der Praxis 429 ab ~20–30 parallelen Calls (atlassian-mcp-server #171, 2026-05). DC: admin-konfiguriertes Token-Bucket, ebenfalls 429 + `Retry-After`.

### Cache-Strategie
1. **TreeIndex** (Speicher, pro Profil + Space): beim ersten `ls` ganzen Baum per `descendants` laden (5.000 Seiten ≈ 20 Requests). TTL 60 s, danach Revalidierung per body-losem Bulk-GET (250 IDs/Request) über `version.number`.
2. **BodyCache** (SQLite `~/.atlcli/vfs/<profile>/<site>.db`, Schlüssel `(pageId, version)`): Versionen sind monoton, Einträge sind unveränderlich, Invalidierung nur über den TreeIndex. Wiederverwendung des `SyncDbAdapter`-Musters aus `packages/confluence/src/sync-db`.
3. **Profilbindung:** Cache-Pfad enthält Profilname und `accountId`. Profilwechsel = anderer Cache. Damit sieht niemand über den Cache Inhalte, die sein Token nicht liefern würde.
4. **Prefetch:** `grep -r` und `cat` mehrerer Dateien nutzen Bulk-GET mit Body in Batches à 250, maximal 8 parallele Requests, `Retry-After` mit Jitter (bestehendes `retry-after.ts`, `in-order-limiter.ts`).
5. **Offline-Modus:** `--offline` liest nur aus dem Cache; `docs pull`-Verzeichnisse können als Cache-Seed dienen (gleiches Layout, gleiche Frontmatter-IDs).

### `grep` und `find` beschleunigen
- `grep -r PATTERN /DOCSY` → Stufe 1: CQL `space = DOCSY AND type = page AND text ~ "PATTERN-Wörter"` (1 Request, Excerpts) → Stufe 2: Bodies der Treffer per Bulk-GET → Stufe 3: Original-`grep` von just-bash auf den gecachten Markdown-Dateien (exakte Regex-Semantik, Zeilennummern). Regex-Muster ohne extrahierbare Wörter fallen auf vollständigen Prefetch zurück, mit Warnung ab 500 Seiten.
- `find -name` läuft nur auf dem TreeIndex (0 Requests). `find -newer`/`-mtime` → CQL `lastmodified`.
- `grep -l label:x` gibt es nicht, dafür `.labels/x/`.
- Implementierung: `defineCommand("grep", …, { trusted: true })` mit `ctx.origCommand` (just-bash ≥ 3.4.0). Im WebDAV-Frontend ist diese Abkürzung nicht möglich, dort greift nur der Cache.

---

## 9. Schreiben, Konflikte, Sicherheit

### Semantik
| Shell-Operation | Confluence-Aufruf |
|---|---|
| `cat > neu.md`, `touch` | `POST /pages` (parentId aus Verzeichnis, Titel aus Frontmatter oder Dateiname, Body `markdownToStorage`) |
| `echo/sed -i` auf bestehende Datei | `PUT /pages/{id}` mit `version.number = cached + 1` |
| `mv a.md b.md` (gleiches Verzeichnis) | `PUT /pages/{id}/title` |
| `mv dir1/a.md dir2/` (gleicher Space) | `PUT /pages/{id}` mit neuem `parentId` |
| `mv` in anderen Space, Reihenfolge | v1 `PUT /content/{id}/move/{before|after|append}/{target}` |
| `mkdir neu/` | `POST /pages` mit leerem Body, Datei `_index.md` erscheint |
| `rm a.md` | `DELETE /pages/{id}` = Papierkorb. `purge` wird nie angeboten |
| `cp` | `copyPage` (bestehend) |
| Schreiben in `.versions/`, `.labels/`, `_attachments/` | `EROFS`, außer Attachment-Upload (v1 `child/attachment`) |

### Konflikte
- Write-Back vergleicht die Frontmatter-`version` der Datei mit der Serverversion. Abweichung oder 409 („Version must be incremented“) → Refetch und 3-Way-Merge über bestehendes `merge.ts`; scheitert der Merge, entsteht `a.conflict.md` und der Schreibvorgang schlägt mit `EBUSY` fehl. Das entspricht dem Verhalten von `docs push`.
- Editor-Writes kommen oft in mehreren Chunks (WebDAV: `PUT` + `LOCK`). Write-Coalescing: Änderungen 500 ms puffern, dann ein `PUT`. Frontmatter wird beim Zurückschreiben entfernt, `title` daraus übernommen.

### Sicherheit
- Default **read-only**; `--rw` schaltet Create/Update/Rename/Move frei, `--allow-delete` zusätzlich Papierkorb. Das spiegelt Atlassians Rovo-MCP-Gruppen (`delete` per Default aus).
- `--confirm-destructive` (Default im interaktiven Modus): `rm`/`mv` über Space-Grenzen fragen nach; im `-c`-Modus per Flag oder Umgebungsvariable freigeben.
- Audit-Log: jede Schreiboperation als JSONL unter `~/.atlcli/vfs/audit.jsonl` (bestehendes JSONL-Logging, `spec/jsonl-logging.md`).
- Tokens verlassen nie den Prozess; der WebDAV-Server ist unauthentifiziert nur auf Loopback, ansonsten Bearer-Pflicht.
- Sichtbarkeit: Cloud v2 filtert Spaces, Seiten, Kinder serverseitig („Only pages that the user has permission to view will be returned“). Rovo MCP und TWG CLI geben dieselbe Garantie. Das VFS darf deshalb keine Cross-Profil-Caches teilen und muss bei 401/403/404 konsequent `ENOENT`/`EACCES` liefern statt zu raten.

### Auth-Lage 2026
- Cloud API-Tokens: scoped (Gateway `api.atlassian.com/ex/confluence/{cloudId}`) und classic. Vor 2024-12-15 erzeugte Tokens sind zwischen 2026-03-14 und 2026-05-12 abgelaufen (erledigt). **Kein veröffentlichtes Enddatum für classic Tokens auf REST**; einziger harter Termin ist JPD-GraphQL am 2026-10-31.
- Atlassian-Policy seit 2026-01-01: verteilte Integrationen sollen Nutzer nicht zum Einfügen von API-Tokens auffordern. Ein persönliches CLI-Skript ist Grauzone. Empfehlung: OAuth 2.0 (3LO) mit Loopback-Redirect und `offline_access` als zweiten Pfad ergänzen (Scopes: `read:page`, `write:page`, `delete:page`, `read:space`, `read:hierarchical-content`, `read:attachment`, `read:label`, `search:confluence`). Achtung: OAuth-Verkehr landet im **globalen 65k-Punkte-Pool pro registrierter App**, geteilt über alle Nutzer. API-Token bleiben deshalb für Power-User der leistungsfähigere Pfad.
- DC: PAT als Bearer, v1-REST. Das VFS braucht einen Cloud-v2- und einen DC-v1-Backend-Adapter; `ConfluenceClient` kapselt das bereits über `deploymentType`.

---

## 10. Abhängigkeiten (Entscheidung)

| Zweck | Paket | Version/Stand | Lizenz | Anmerkung |
|---|---|---|---|---|
| Bash-Interpreter + VFS-Interface | `just-bash` | 3.4.2 (2026-08-22), pinnen | Apache-2.0 | Bun: `defenseInDepth: false` oder Patch; `commands` einschränken |
| Optional: AI-SDK-Tool für chat/research | `bash-tool` | 1.3.19 (2026-08-22) | MIT | Peer `just-bash ^3` |
| WebDAV-Server | `webdav-server` | 2.6.3 (2026-08-04) | Unlicense | v2-API, custom FileSystem |
| Cache | `bun:sqlite` | eingebaut | – | wie `sync-db` |
| **Nicht** aufnehmen | `fuse-napi`, `@cocalc/fuse-native`, `@zenfs/core` | – | MIT / LGPL | FUSE: Treiberpflicht; ZenFS: LGPL, sync+async-Pflichtmethoden, keine Shell |

Alternativen geprüft und verworfen: `memfs` (nur In-Memory), `unionfs` (2025 **[alt]**), `bash-emulator` (2016 **[alt]**), WebContainers (kommerzielle Lizenz für Produktion), `@wasmer/sdk` (kein Lazy-Backend), `@cloudflare/shell` (Fork von just-bash, experimentell), `@anthropic-ai/sandbox-runtime` (sandboxt echte Bash, kein VFS).

---

## 11. Implementierungsplan

Ziel: nutzbares `wiki sh` innerhalb von ~3 Wochen, Mount in Woche 4–6.

### Phase 0 – Spike (2–3 Tage)
- `just-bash@3.4.2` unter Bun 1.3 mit `defenseInDepth: false` und `MountableFs` gegen `ConfluenceClient` für Space DOCSY: `ls`, `cat`, `grep -r`, `find`. Bundle-Größe von `bun build --compile` vorher/nachher messen.
- Entscheidung: 3.4.2 + DiD aus, `just-bash/browser`, oder 2.14.5.

### Phase 1 – Kern `packages/confluence-vfs` (Woche 1–2)
- `VfsNode`-API, `PathMapper` (Wiederverwendung `hierarchy.ts`, `slugifyTitle`, Frontmatter), `TreeIndex`, `BodyCache` (SQLite, Profil-Scope), Fehler-Mapping (401/403/404 → `EACCES`/`ENOENT`).
- Read-only-Pfad komplett, inkl. `_attachments/` (lazy), `.versions/`, `.labels/`, `.recent/`.
- Tests: Unit gegen Fake-Client, Roundtrip Markdown ↔ Storage (bestehende Konvention), Conformance-Suite von just-bash für den Adapter.

### Phase 2 – `atlcli wiki sh` (Woche 2–3)
- Kommando in `apps/cli/src/commands/wiki-sh.ts`: `-c`, stdin, interaktiv (readline), `--space`, `--rw`, `--allow-delete`, `--offline`, `--json` (stdout/stderr/exitCode als JSON für Agenten).
- `grep`-Override mit CQL-Vorfilter, `find`-Override auf TreeIndex.
- Docs: `src/content/docs/confluence/virtual-filesystem.md` (Intro, Prerequisites, Beispiele minimal + Agent-Workflow, Troubleshooting), Skill-Snippet für `AGENTS.md`/`CLAUDE.md`.
- E2E gegen Profil `mayflower`, Space `DOCSY`; Testseiten danach löschen.

### Phase 3 – Schreiben (Woche 3–4)
- `WriteBack` mit Version-Check, 409-Handling, 3-Way-Merge, `.conflict.md`, Audit-JSONL, Write-Coalescing.
- `mv`/`rename`/`rm`/`mkdir`/`cp`-Mapping, Regressionstests für Konfliktfälle.

### Phase 4 – `atlcli wiki mount` (Woche 4–6)
- WebDAV-Adapter, `LOCK/UNLOCK`, `._*`-Kurzschluss, ETags, `mount_webdav`/`net use`-Automatik, Linux-Anleitung.
- Performance-Messung Finder vs. `ls -R`, Doku-Abschnitt „grep bitte über `wiki sh` oder Cache-Verzeichnis“.

### Phase 5 – Integration (danach)
- `bash`-Tool im `chat`/`research`-Agenten über denselben Adapter.
- Optional NFSv3-Sidecar (`nfsserve`, Rust) für macOS/Linux, falls WebDAV-Leistung nicht reicht.
- Jira-Namespace `/jira/<PROJECT>/` über denselben Kern.

---

## 12. Selbstkritik und Unsicherheiten

- **Bun-Kompatibilität von just-bash 3.x ist der größte Einzelrisikopunkt.** Der Subagent hat den Crash unter Bun 1.3.11 reproduziert, atlcli nutzt Bun 1.3.14. `defenseInDepth: false` ist eine Sicherheitsabschwächung, die aber laut THREAT_MODEL nur eine Zweitschicht betrifft; atlcli führt Agenten-Skripte lokal mit Nutzerrechten aus, der Interpreter selbst bleibt sandboxed (kein Netz, Limits). Trotzdem: Spike zuerst.
- **Der 409-Konflikt** ist im v2-OpenAPI-Spec nicht formal gelistet (nur 200/400/401/404), aber durch Community-Berichte und `docs push`-Erfahrung belegt. Robust: eigenen Version-Check vor jedem `PUT`.
- **Rate-Limit-Zahlen** gelten nur für OAuth-Apps; für API-Token gibt es keine veröffentlichten Werte. Die Concurrency-Grenze von ~8 ist eine konservative Annahme aus dem MCP-Server-Issue, nicht aus Atlassian-Doku.
- **WebDAV-Leistung** wurde nicht gemessen, nur aus Quellen abgeleitet (Finder-Chattiness, `slack-fuse`-Zahlen). Phase 4 muss messen.
- **Titel-Kollisionen** über Slug-Zusammenfall sind theoretisch möglich; das bestehende `-2`-Schema ist nicht stabil über Umbenennungen. Für stabile Pfade könnte optional `--id-paths` (`623869955-architecture.md`) angeboten werden.
- Nichts im Bereich „Confluence als Dateisystem“ existiert als Open Source (Stand 2026-09-15). Das ist ein Marktvorteil, aber auch ein Hinweis, dass es keine erprobten Lösungen für Randfälle (Folders, Whiteboards, Inline-Kommentare) gibt.

---

## 13. Offene Fragen

1. **just-bash-Variante:** 3.4.2 mit `defenseInDepth: false` (aktuellste Features, `ctx.origCommand`) oder 2.14.5 (läuft unter Bun ohne Workaround, aber ohne `origCommand`)?
2. **Mount überhaupt in v1?** `wiki sh` deckt den Agenten-Use-Case ab; der Mount ist vor allem für Menschen mit Editor/Finder. Reihenfolge wie oben, oder Mount ganz nach hinten?
3. **OAuth 3LO jetzt ergänzen?** Nötig für die Atlassian-Policy bei Verteilung, kostet aber App-Registrierung und teilt sich das 65k-Punkte-Budget. Für interne Nutzung reichen API-Token.
4. **Pfad-Schema:** slug-basiert wie `docs pull` (menschenlesbar, Rename verschiebt Datei) oder ID-Präfix (stabil, hässlicher)? Beides anbieten?
5. **Cache-Ort:** eigener `~/.atlcli/vfs/`-Cache oder Wiederverwendung eines vorhandenen `docs pull`-Verzeichnisses als Projektion (dann ist `grep` auf dem Cache-Verzeichnis nativ schnell)?
6. **Schreibrechte für Agenten per Default aus?** Vorschlag: ja (`--rw` explizit), wie bei allen 2026-Prior-Art-Projekten.

---

## 14. Quellen

Alle Quellen am 2026-09-15 abgerufen. **[alt]** = älter als 6 Monate.

### just-bash und Alternativen
- npm-Registry `just-bash` 3.4.2: https://registry.npmjs.org/just-bash
- Repo, Commits bis 2026-09-07: https://github.com/vercel-labs/just-bash/commits/main
- README 3.4.2 (Befehle, `MountableFs`, Limits, Netzwerk): https://raw.githubusercontent.com/vercel-labs/just-bash/main/packages/just-bash/README.md
- CHANGELOG (3.0.0 2026-05-10, 3.2.0 Hardening, 3.4.0 `ctx.origCommand`): https://raw.githubusercontent.com/vercel-labs/just-bash/main/packages/just-bash/CHANGELOG.md
- Issue #386 Bun-Crash (2026-08-24, offen): https://github.com/vercel-labs/just-bash/issues/386
- Issue #181 async `getAllPaths` (2026-04-06): https://github.com/vercel-labs/just-bash/issues/181
- Issue #185 `searchFiles`-Hook für Remote-grep (2026-04-09): https://github.com/vercel-labs/just-bash/issues/185
- `bash-tool` (Vercel Labs): https://github.com/vercel-labs/bash-tool
- `@ai-sdk/sandbox-just-bash` 1.0.111 (2026-09-15): https://github.com/vercel/ai/releases/tag/%40ai-sdk%2Fsandbox-just-bash%401.0.111
- Vercel Blog „How to build agents with filesystems and bash“ (2026-01-09) **[alt]**: https://vercel.com/blog/how-to-build-agents-with-filesystems-and-bash
- Vercel/Braintrust „Testing if bash is all you need“ (2026-01-22) **[alt]**: https://vercel.com/blog/testing-if-bash-is-all-you-need
- Cloudflare-Fork-Kontroverse (2026-03): https://news.ycombinator.com/item?id=47392479
- just-bash-openfs (2026-02) **[alt]**: https://github.com/jeffchuber/just-bash-openfs
- Turso AgentFS + just-bash (2026-01-02) **[alt]**: https://turso.tech/blog/agentfs-just-bash
- Upstash Redis VFS (2026-04-20): https://upstash.com/blog/redis-virtual-fs
- Mintlify ChromaFs (2026-03-24): https://www.mintlify.com/blog/how-we-built-a-virtual-filesystem-for-our-assistant
- Knock „Files over tools“ (2026-07-09): https://news.ycombinator.com/item?id=48845364
- ZenFS Interface (sync+async-Pflicht): https://raw.githubusercontent.com/zen-fs/core/main/src/internal/filesystem.ts
- `@anthropic-ai/sandbox-runtime`: https://github.com/anthropic-experimental/sandbox-runtime

### Mount-Technologien
- fuse-napi 2.3.1 (2026-08-05): https://github.com/mmdevries/fuse-napi
- Bun Node-API: https://bun.com/docs/runtime/node-api · Bun FFI (experimental): https://bun.com/docs/runtime/ffi
- macFUSE 5.3.3 / FSKit-Backend: https://macfuse.github.io/ · https://github.com/macfuse/macfuse/wiki/FUSE-Backends
- macFUSE-Lizenz (kommerziell nur mit Erlaubnis) **[alt]**: https://github.com/macfuse/macfuse/issues/616
- FUSE-T 1.2.7, Lizenz nicht-kommerziell: https://github.com/macos-fuse-t/fuse-t · https://raw.githubusercontent.com/macos-fuse-t/fuse-t/main/License.txt
- FSKit-Bugs macOS 26.x **[alt, 2025-12]**: https://github.com/andrewgazelka/loaf/issues/1 · rclone-Forum 2026-03-31: https://forum.rclone.org/t/macos-rclone-mount-with-fuse-t-via-fskit/53608
- WinFsp Releases/Lizenz (GPLv3 + FLOSS-Exception): https://github.com/winfsp/winfsp/releases
- rclone `nfsmount`/`serve nfs`: https://rclone.org/commands/rclone_nfsmount/ · go-nfs: https://github.com/willscott/go-nfs
- Rust `nfsserve` 0.11.0 (2026-04-01): https://crates.io/api/v1/crates/nfsserve · `fuser` 0.18.0: https://crates.io/api/v1/crates/fuser
- `webdav-server` 2.6.3 (2026-08-04): https://registry.npmjs.org/webdav-server
- macOS Finder WebDAV-Eigenheiten: https://sabre.io/dav/clients/finder/ · Windows WebClient 50-MB-Limit: https://www.myworkdrive.com/blog/webdav-file-size-limit
- mirage NFS-Backend (2026-08-22): https://github.com/strukto-ai/mirage/issues/888
- slack-fuse (2026): https://github.com/synap5e/slack-fuse · notionfs: https://github.com/can1357/notionfs

### Atlassian
- API-Token-Verwaltung / Scoped Tokens: https://support.atlassian.com/atlassian-account/docs/manage-api-tokens-for-your-atlassian-account/ · https://support.atlassian.com/confluence/kb/scoped-api-tokens-in-confluence-cloud/
- Basic Auth für REST: https://developer.atlassian.com/cloud/confluence/basic-auth-for-rest-apis/
- Token-Migrationspflicht ab 2026-01-01 **[alt, 2025-11]**: https://community.developer.atlassian.com/t/reminder-migrate-from-using-api-tokens-to-officially-supported-authentication-for-atlassian-apps-integrations/97221
- JPD classic-token Cutoff 2026-10-31 (2026-04-29): https://community.atlassian.com/forums/Jira-Product-Discovery-articles/Deprecation-of-classic-API-token-access-for-Jira-Product/ba-p/3228037
- OAuth 2.0 (3LO): https://developer.atlassian.com/cloud/confluence/oauth-2-3lo-apps/ · Scopes: https://developer.atlassian.com/cloud/confluence/scopes-for-oauth-2-3LO-and-forge-apps/
- Rate Limiting (Punktemodell seit 2026-03-02): https://developer.atlassian.com/cloud/confluence/rate-limiting/
- 429 bei ~20–30 parallelen Calls mit API-Token (2026-05-29): https://github.com/atlassian/atlassian-mcp-server/issues/171
- v1-Deprecation endpoint-weise (2026-04-01): https://community.atlassian.com/forums/Confluence-questions/Confluence-API-v1-Deperecation/qaq-p/3215038
- Changelog (Versions-Limit 50 seit 2026-06-01): https://developer.atlassian.com/cloud/confluence/changelog/
- Space-Export-API offen seit 2016: https://jira.atlassian.com/browse/CONFCLOUD-40457
- DC Personal Access Tokens: https://confluence.atlassian.com/enterprise/using-personal-access-tokens-1026032365.html
- Rovo MCP Server (v2 GA 2026-09-08): https://github.com/atlassian/atlassian-mcp-server · Tools: https://support.atlassian.com/atlassian-rovo-mcp-server/docs/supported-tools/ · Credits (ab 2026-08-31): https://support.atlassian.com/rovo/docs/rovo-usage-limits/
- Teamwork Graph CLI GA (2026-06-30): https://community.atlassian.com/forums/Atlassian-AI-Rovo-articles/Teamwork-Graph-CLI-GA-connected-context-at-enterprise-scale/ba-p/3254146 · FAQ: https://developer.atlassian.com/cloud/twg-cli/faq/

### Agent-Interface-Evidenz
- Anthropic „Code execution with MCP“ (2025-11-04) **[alt]**: https://www.anthropic.com/engineering/code-execution-with-mcp
- Anthropic „Advanced tool use“ (2025-11-24) **[alt]**: https://www.anthropic.com/engineering/advanced-tool-use
- Agent Skills Spec: https://agentskills.io/
- Cloudflare Code Mode MCP (2026-02-20) **[alt]**: https://blog.cloudflare.com/code-mode-mcp/
- Arize „MCP vs CLI skills“ (2026-05): https://arize.com/blog/mcp-vs-cli-skills-for-agents-what-our-eval-found-and-which-you-should-use/
- Arize „Agent interfaces in 2026“ (2026-01) **[alt]**: https://arize.com/blog/agent-interfaces-in-2026-filesystem-vs-api-vs-database-what-actually-works/
- OpenViking (2026-01) **[alt]**: https://github.com/volcengine/OpenViking

---

## Verwandte Dokumente
- `spec/mcp-over-code.md` – MCP-Server, der die CLI aufruft (Gegenstück zum VFS-Ansatz)
- `spec/local-storage-plan.md` – Frontmatter/`.atlcli/`-Layout, das das VFS übernimmt
- `spec/sqlite-sync-foundation.md` – SQLite-Adapter, Vorlage für den BodyCache
- `spec/large-space-sync.md`, `spec/partial-sync.md` – Baum-Laden großer Spaces
- `packages/confluence/src/hierarchy.ts` – Index-Pattern und Slug-Regeln
