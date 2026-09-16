# Confluence Virtual Filesystem (VFS) für Coding Agents

**Status:** Konzept mit getroffenen Entscheidungen, Implementierungsplan in Abschnitt 11
**Datum:** 2026-09-15 (Recherche), 2026-09-16 (Entscheidungen, Plan)
**Ziel:** Coding Agents (Claude Code, Codex, Cursor, …) arbeiten mit `ls`, `cd`, `cat`, `grep`, `find`, `sed` direkt auf Confluence-Inhalten. Sichtbarkeit exakt wie der authentifizierte Nutzer. Keine MCP-Tool-Aufrufe nötig.

Quellen: drei parallele Recherchen (just-bash, Mount-Technologien, Atlassian-Auth/Prior Art), alle Quellen live geprüft am 2026-09-15. Befunde älter als 6 Monate sind mit **[alt]** markiert.

---

## 1. Kurzfazit

- **Machbar, und zwar kurzfristig.** atlcli hat alle Bausteine schon: `ConfluenceClient` (Hierarchie, Suche, Versionen, Move, Trash), `storageToMarkdown`/`markdownToStorage`, Pfad-Mapping (`hierarchy.ts`, Index-Pattern), Frontmatter mit Page-ID, SQLite-Sync-DB.
- **Architektur:** ein gemeinsamer **VFS-Kern** (reine Logik: Pfad ↔ Page, Cache, Write-Back, CQL-Beschleunigung) mit **zwei Frontends, beide in v1**:
  1. **`atlcli wiki sh`** – eingebettete Bash auf Basis von **just-bash** (Vercel Labs). Kein Mount, kein Treiber, funktioniert überall.
  2. **`atlcli wiki mount`** – echter OS-Mount über einen **lokalen WebDAV-Server** (Loopback). Kext-frei auf macOS und Windows, Linux braucht `davfs2`.
- **Nicht gewählt:** FUSE (macFUSE proprietär, FUSE-T nur nicht-kommerziell frei, Node-Bindings unter Bun unerprobt, Windows braucht WinFsp-Installer).
- **just-bash mit deaktiviertem Defense-in-Depth**, drei bekannte Risiken (Bun-Crash bei aktivem DiD, `fetch` im Backend, `grep -r` ohne Cache) sind damit bzw. über den Cache abgedeckt.
- **Berechtigungen:** Confluence erzwingt Sichtbarkeit serverseitig pro Aufrufer. Das VFS braucht keine eigene ACL-Logik, nur konsequent den Profil-Token des Nutzers und einen **profilgebundenen Cache**.
- **Schreiben ist von Anfang an Teil des Kerns**, Modus `ro`/`rw` ist ein Parameter, Default `ro`.

---

## 1a. Entscheidungen (2026-09-16)

| # | Frage | Entscheidung | Konsequenz |
|---|---|---|---|
| 1 | just-bash-Variante | **3.4.2 mit `defenseInDepth: false`** | `ctx.origCommand` für `grep`/`find`-Overrides nutzbar; Version pinnen; Bun-Issue #386 beobachten und DiD wieder aktivieren, sobald es gefixt ist |
| 2 | Mount in v1? | **Ja**, `wiki sh` und `wiki mount` gehören beide zu v1 | Kern muss von Beginn an beide Adapter tragen; WebDAV-Spezifika (LOCK, ETag, `._*`) sind Teil des Plans |
| 3 | OAuth 3LO | **Nein, API-Token reichen** (Cloud scoped/classic, DC-PAT) | Kein App-Registrierungs-Aufwand; kein geteiltes Punkte-Budget; Concurrency-Limit ~8 und `Retry-After` gegen Burst-Limits |
| 4 | Pfad-Schema | **Slug mit ID-Suffix**: `architecture-623869955.md` | Pfade sind kollisionsfrei und über Umbenennungen hinweg auflösbar; Slug dient nur der Lesbarkeit |
| 5 | Cache-Ort | **Frei wählbar** (`--cache-dir`, Config `vfs.cacheDir`), Default `~/.atlcli/vfs/` | Innerhalb des gewählten Verzeichnisses bleibt die Unterteilung nach Profil und Account-ID Pflicht (Berechtigungs-Isolation) |
| 6 | Schreibrechte | **Parametrisierbar** `--mode ro|rw` (Default `ro`), zusätzlich `--allow-delete`; Schreibpfad wird direkt mitgebaut | Write-Back, Konfliktbehandlung und Audit sind Teil von Phase 1, nicht Nachrüstung |

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
- Read-only per Default, Schreiben per Parameter (`--mode rw`).
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
cat script.sh | atlcli wiki sh --space DOCSY --mode rw
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

Das Layout folgt dem Index-Pattern aus `hierarchy.ts` (Seite mit Kindern = Verzeichnis mit `_index.md`), ergänzt um ein **ID-Suffix** in jedem Datei- und Verzeichnisnamen (Entscheidung 4).

```
/                                        # Root: alle sichtbaren Spaces
├── DOCSY/                               # Space-Key
│   ├── _space.json                      # id, name, homepageId (read-only)
│   ├── _index.md                        # Homepage-Body
│   ├── getting-started-623869001.md     # Blattseite: <slug>-<id>.md
│   ├── architecture-623869955/          # Seite mit Kindern: <slug>-<id>/
│   │   ├── _index.md                    # eigener Body
│   │   ├── _attachments/                # Lazy: Metadaten aus v2, Bytes bei open()
│   │   │   └── diagram.png
│   │   ├── .versions/                   # Read-only, max. 50 mit Body
│   │   │   ├── 12.md
│   │   │   └── 11.md
│   │   ├── .comments.md                 # Footer-/Inline-Kommentare gerendert
│   │   └── deployment-623870112.md
│   ├── runbooks-623871000/              # Confluence-Folder (type: folder)
│   │   └── _index.md                    # nur Frontmatter
│   ├── .by-id/                          # virtuell: stabile Adresse ohne Slug
│   │   └── 623869955.md → ../architecture-623869955/_index.md
│   ├── .labels/                         # virtuell: GET /labels/{id}/pages
│   │   └── runbook/ → Symlinks auf Seiten
│   ├── .recent/                         # virtuell: CQL lastmodified >= now("-7d")
│   │   ├── 24h/ 7d/ 30d/
│   └── .search/                         # virtuell: mkdir = Query anlegen
│       └── text ~ "kubernetes"/         # ls = CQL ausführen, Symlinks
└── .me.json                             # aktueller Nutzer, Profil, Deployment
```

Regeln:
- Dateiname = `slugifyTitle(title)` + `-` + Page-ID. Die ID ist der Schlüssel; der Slug-Teil wird beim Auflösen ignoriert, sodass `cat architecture-623869955/_index.md` auch nach einer Umbenennung funktioniert, wenn der Aufrufer die alte Slug-Form nutzt (Auflösung über die ID, `ls` zeigt den aktuellen Slug).
- Kollisionen sind damit ausgeschlossen; `generateUniqueFilename()` wird nicht benötigt.
- Für Agenten, die nur eine Page-ID kennen: `/DOCSY/.by-id/<id>.md` als Symlink auf die kanonische Datei.
- Beim Anlegen neuer Dateien (`rw`) darf der Name ohne ID geschrieben werden (`echo > neue-seite.md`); nach dem `POST` benennt das VFS die Datei in `neue-seite-<id>.md` um und meldet den kanonischen Pfad in stderr/`--json`.
- Nicht-Seiten-Kinder (Whiteboard, Database, Embed) erscheinen als `name-<id>.whiteboard.json` mit Link, read-only.
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
2. **BodyCache** (SQLite, Schlüssel `(pageId, version)`): Versionen sind monoton, Einträge sind unveränderlich, Invalidierung nur über den TreeIndex. Wiederverwendung des `SyncDbAdapter`-Musters aus `packages/confluence/src/sync-db`.
3. **Cache-Ort frei wählbar** (Entscheidung 5): `--cache-dir <pfad>`, Config `vfs.cacheDir` (global oder pro Profil), Default `~/.atlcli/vfs/`. Innerhalb des Verzeichnisses liegt die DB immer unter `<profile>/<accountId>/<siteHash>.db`. Profilwechsel = anderer Cache. Damit sieht niemand über den Cache Inhalte, die sein Token nicht liefern würde. Optional `--cache-dir` auf ein `docs pull`-Verzeichnis zeigen lassen ist **kein** Ziel; die beiden Formate bleiben getrennt (unterschiedliches Pfadschema).
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
- **Modus als Parameter** (Entscheidung 6): `--mode ro|rw`, Default `ro`; Config `vfs.mode` pro Profil. `rw` schaltet Create/Update/Rename/Move frei, `--allow-delete` zusätzlich Papierkorb. Im `ro`-Modus liefert jeder Schreibversuch `EROFS`. Das spiegelt Atlassians Rovo-MCP-Gruppen (`delete` per Default aus).
- `--confirm-destructive` (Default im interaktiven Modus): `rm`/`mv` über Space-Grenzen fragen nach; im `-c`-Modus per Flag oder Umgebungsvariable freigeben.
- Audit-Log: jede Schreiboperation als JSONL unter `~/.atlcli/vfs/audit.jsonl` (bestehendes JSONL-Logging, `spec/jsonl-logging.md`).
- Tokens verlassen nie den Prozess; der WebDAV-Server ist unauthentifiziert nur auf Loopback, ansonsten Bearer-Pflicht.
- Sichtbarkeit: Cloud v2 filtert Spaces, Seiten, Kinder serverseitig („Only pages that the user has permission to view will be returned“). Rovo MCP und TWG CLI geben dieselbe Garantie. Das VFS darf deshalb keine Cross-Profil-Caches teilen und muss bei 401/403/404 konsequent `ENOENT`/`EACCES` liefern statt zu raten.

### Auth-Lage 2026
- Cloud API-Tokens: scoped (Gateway `api.atlassian.com/ex/confluence/{cloudId}`) und classic. Vor 2024-12-15 erzeugte Tokens sind zwischen 2026-03-14 und 2026-05-12 abgelaufen (erledigt). **Kein veröffentlichtes Enddatum für classic Tokens auf REST**; einziger harter Termin ist JPD-GraphQL am 2026-10-31.
- Atlassian-Policy seit 2026-01-01: verteilte Integrationen sollen Nutzer nicht zum Einfügen von API-Tokens auffordern. Ein persönliches CLI-Skript ist Grauzone. **Entscheidung 3: v1 bleibt bei API-Token** (Cloud scoped/classic, DC-PAT), OAuth 2.0 (3LO) wird nicht gebaut. Falls später nötig: Loopback-Redirect mit `offline_access` (Scopes: `read:page`, `write:page`, `delete:page`, `read:space`, `read:hierarchical-content`, `read:attachment`, `read:label`, `search:confluence`); OAuth-Verkehr würde im **globalen 65k-Punkte-Pool pro App** landen, API-Token bleiben deshalb ohnehin der leistungsfähigere Pfad.
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

Ziel v1: `wiki sh` **und** `wiki mount`, Lesen und Schreiben (`--mode ro|rw`), ID-Suffix-Pfade, frei wählbarer Cache. Aufwand grob 6–7 Wochen für eine Person; Arbeitspakete (AP) sind so geschnitten, dass AP2–AP5 parallel zu AP6/AP7 laufen können, sobald AP1 steht.

Konventionen für alle APs:
- Neue Logik als Package `packages/confluence-vfs` (functional core, keine CLI-Abhängigkeit), Adapter und Kommandos in `apps/cli`.
- Jeder Task hat Tests (`bun run test`), Bugfixes bekommen Regressionstests.
- Commits nach Conventional Commits: `feat(vfs): …`, `feat(cli): …`, `docs: …`.
- E2E gegen Profil `mayflower`, Space `DOCSY`, Testseiten mit Präfix `vfs-e2e-` und danach löschen.
- Kein Push ohne `bun run typecheck`.

### AP0 – Spike und Absicherung (2 Tage)

- [ ] **AP0.1** `just-bash@3.4.2` als Dependency in `apps/cli` aufnehmen, Version exakt pinnen, `bun install` ohne Postinstall-Fehler.
- [ ] **AP0.2** Spike-Skript `spikes/vfs-just-bash/spike.ts`: `new Bash({ defenseInDepth: false, fs: new MountableFs({ mounts: [{ mountPoint: "/DOCSY", filesystem: fakeFs }] }) })`, Befehle `ls -R`, `cat`, `grep -rn`, `find -name`, `sed`, `jq`, `echo > file` gegen ein Fake-`IFileSystem` unter Bun 1.3.14. Erwartung: alle laufen ohne `DefenseInDepthBox`-Fehler.
- [ ] **AP0.3** Spike gegen echten `ConfluenceClient` (Profil `mayflower`, Space `DOCSY`, nur lesend): `ls /DOCSY`, `cat` einer Seite, `grep -rl` über 20 Seiten. Latenz und Request-Anzahl loggen.
- [ ] **AP0.4** Bundle-Messung: `bun run build:cli` mit und ohne just-bash, Größe von `dist/index.js` und der `--compile`-Binary notieren; `commands: [...]`-Restriktion (ohne python3, js-exec, sqlite3, curl) anwenden und erneut messen. Ergebnis in `spikes/vfs-just-bash/README.md`.
- [ ] **AP0.5** `webdav-server@2.6.3` Smoke-Test unter Bun: In-Memory-FS auf `127.0.0.1:0` starten, mit `curl -X PROPFIND` und auf macOS mit `mount_webdav` mounten, `ls` im Finder-Mount. Ergebnis (funktioniert / Workarounds) im Spike-README.
- [ ] **AP0.6** Entscheidung dokumentieren: Bundle-Größe akzeptabel? Falls nein: Lazy-Import von just-bash nur im `wiki sh`-Pfad (dynamic `import()`), damit andere Kommandos nicht belastet werden.

### AP1 – Package-Gerüst und Kern-API (3 Tage)

- [ ] **AP1.1** `packages/confluence-vfs/` anlegen: `package.json` (Name `@atlcli/confluence-vfs`, Exports mit `development`-Condition wie `@atlcli/confluence`), `tsconfig.json`, `src/index.ts`, Build- und Typecheck-Skripte, in Turbo-Pipeline aufnehmen. `bun run typecheck` grün.
- [ ] **AP1.2** Kern-Typen in `src/types.ts`: `VfsNode` (`kind: "space" | "page" | "folder" | "attachment" | "virtual-dir" | "virtual-file" | "symlink"`, `id`, `title`, `slug`, `version`, `parentId`, `mtime`, `size?`), `VfsStat`, `VfsError` mit Codes `ENOENT | EACCES | EROFS | EISDIR | ENOTDIR | EEXIST | EBUSY | ENOTEMPTY`.
- [ ] **AP1.3** Kern-Interface `ConfluenceVfs` in `src/vfs.ts`: `stat(path)`, `readdir(path)`, `readFile(path)`, `readFileBytes(path)`, `writeFile(path, content)`, `mkdir(path)`, `rename(from, to)`, `rm(path, {recursive})`, `copy(from, to)`, `readlink(path)`. Alle async, alle werfen `VfsError`.
- [ ] **AP1.4** Optionen `VfsOptions`: `profile`, `client: ConfluenceClient`, `spaces?: string[]` (Einschränkung auf Spaces), `mode: "ro" | "rw"`, `allowDelete: boolean`, `cacheDir: string`, `offline: boolean`, `concurrency: number` (Default 8), `treeTtlMs` (Default 60 000), `logger`.
- [ ] **AP1.5** Fehler-Mapping `src/errors.ts`: HTTP 401/403 → `EACCES`, 404 → `ENOENT`, 409 → `EBUSY`, 429 → Retry über bestehendes `retry-after.ts`, danach `EAGAIN`-ähnlicher `VfsError` mit Hinweis. Unit-Tests für jeden Fall.
- [ ] **AP1.6** `FakeConfluenceClient` in `src/testing/fake-client.ts` (In-Memory-Spaces/-Seiten/-Versionen/-Labels/-Attachments, Berechtigungs-Simulation über „sichtbare IDs“, konfigurierbare 409/429). Grundlage aller Unit-Tests.
- [ ] **AP1.7** Modus-Guard: zentrale `assertWritable(op)` in `src/mode.ts`; im `ro`-Modus wirft jede Schreiboperation `EROFS`, `rm` ohne `allowDelete` wirft `EACCES` mit erklärender Meldung. Tests für alle Schreiboperationen in beiden Modi.

### AP2 – Pfad-Mapping und Baum-Index (4 Tage)

- [ ] **AP2.1** `src/path-mapper.ts`: `formatName(title, id, hasChildren)` → `<slug>-<id>.md` bzw. `<slug>-<id>/`; `parseName(name)` → `{ slug, id }` mit Regex `^(.*)-(\d+)(\.md)?$`, Fallback für Namen ohne ID (neue Dateien im `rw`-Modus). Slug via `slugifyTitle()` aus `@atlcli/confluence`. Unit-Tests inkl. Titeln mit Zahlen am Ende (`Release-2026-12345` darf nur die Page-ID abtrennen, die aus dem TreeIndex bekannt ist).
- [ ] **AP2.2** Auflösung `resolvePath(path)` → `VfsNode`: Segment für Segment; Space-Key → Space; Segment mit ID → Lookup per ID (Slug wird ignoriert); Segment ohne ID → Fehler `ENOENT` außer für reservierte Namen (`_index.md`, `_space.json`, `_attachments`, `.versions`, `.comments.md`, `.by-id`, `.labels`, `.recent`, `.search`, `.me.json`).
- [ ] **AP2.3** `src/tree-index.ts`: pro Space Laden über `listSpacesV2` + `getPageDescendants(homepage, depth 10)` in Batches à 250, Folders über `getSpaceFolders`; Struktur `Map<id, TreeNode>` mit `children: id[]` in `childPosition`-Reihenfolge. Zeit und Requestzahl für 5.000 Seiten im Fake messen (Ziel ≤ 25 Requests).
- [ ] **AP2.4** Revalidierung: TTL `treeTtlMs`; nach Ablauf body-loser Bulk-GET (`GET /pages?id=…&limit=250`) über alle bekannten IDs, Vergleich `version.number`; neue/gelöschte Seiten per erneutem `descendants`-Lauf nur, wenn sich die Homepage-`lastModified` oder Kinderanzahl geändert hat. Tests: Version-Bump, gelöschte Seite, neue Seite, verschobene Seite.
- [ ] **AP2.5** `readdir` für Space-Root, Seiten-Verzeichnisse und Folders aus dem TreeIndex (0 Requests nach Warmup). `stat` liefert `mtime` aus `version.createdAt`, `size` aus Cache oder Schätzung. Tests.
- [ ] **AP2.6** Data-Center-Pfad: gleicher TreeIndex über v1 (`getChildren`/`getAllPages` mit `deploymentType: "data-center"`) im Fake abgedeckt; ein Contract-Test wie `wiki-import-dc.contract.test.ts`.
- [ ] **AP2.7** Sichtbarkeit: Test, dass Seiten, die der Fake-Client als unsichtbar markiert, weder in `readdir` noch per `.by-id/` noch per direkter ID-Adresse auftauchen (`ENOENT`, nicht `EACCES`, um keine Existenz zu verraten, analog zur API).

### AP3 – Body-Cache und Konvertierung (3 Tage)

- [ ] **AP3.1** `src/body-cache.ts` auf `bun:sqlite`: Tabelle `bodies(page_id, version, markdown, storage_hash, fetched_at)`, `attachments(id, page_id, filename, media_type, size, version, blob_path)`, Schlüssel `(page_id, version)`. Migrationen nach dem Muster in `sync-db/migrations.ts`.
- [ ] **AP3.2** Cache-Ort: `resolveCacheDir(opts)` aus `--cache-dir` → Config `vfs.cacheDir` (Profil vor global) → Default `~/.atlcli/vfs/`; darunter fest `<profile>/<accountId>/<siteHash>.db`. `accountId` aus `getCurrentUser()` beim Start (ein Request, gecacht). Tests: Priorität der Quellen, Isolation zweier Profile im selben `--cache-dir`.
- [ ] **AP3.3** `readFile` für `_index.md`/`<slug>-<id>.md`: Cache-Hit bei passender Version, sonst `getPage` mit `body-format=storage`, `storageToMarkdown()`, Frontmatter (`id, title, version, parentId, labels, lastModified, url`) voranstellen, in Cache schreiben. Roundtrip-Test Storage → Markdown → Storage über bestehende Fixtures.
- [ ] **AP3.4** Prefetch `prefetchBodies(ids)`: `getPagesBatch`-ähnlich, aber über `GET /pages?id=…&body-format=storage&limit=250` (neue Client-Methode `getPagesBulk` in `@atlcli/confluence`, mit Test), Concurrency über `createInOrderLimiter`, `Retry-After` honoriert.
- [ ] **AP3.5** `--offline`: nur Cache; Cache-Miss → `ENOENT` mit Meldung „nicht im Cache, ohne --offline erneut versuchen“. TreeIndex wird als JSON im Cache-Verzeichnis persistiert (`tree-<spaceKey>.json`), damit `ls` offline funktioniert. Tests.
- [ ] **AP3.6** Cache-Wartung: `atlcli wiki vfs cache stats|clear [--space]` (Größe, Einträge, Alter); Größenlimit `vfs.cacheMaxMb` (Default 500) mit LRU-Eviction nach `fetched_at`. Tests.

### AP4 – Virtuelle Verzeichnisse und Nebenobjekte (3 Tage)

- [ ] **AP4.1** `_space.json`, `.me.json` (read-only, JSON aus `getSpace`/`getCurrentUser`).
- [ ] **AP4.2** `_attachments/`: `readdir` aus `listAttachments` (gecacht per Seitenversion), `readFileBytes` lädt über `downloadAttachment` in `<cacheDir>/blobs/<attachmentId>-<version>` und streamt von dort; `size`/`mtime` aus Metadaten, damit `ls -l` keinen Download auslöst. Tests mit Fake.
- [ ] **AP4.3** `.versions/<n>.md`: `readdir` aus `getPageVersions` (max. 50), `readFile` über `getPageAtVersion` + Konvertierung, unveränderlich gecacht. Read-only (`EROFS`).
- [ ] **AP4.4** `.comments.md`: Footer- und Inline-Kommentare über `getAllComments`, gerendert als Markdown-Liste mit Autor, Datum, Auflösungsstatus. Read-only.
- [ ] **AP4.5** `.by-id/<id>.md`: Symlink auf kanonischen Pfad; `readlink` und transparentes `readFile`. Tests inkl. unbekannter ID → `ENOENT`.
- [ ] **AP4.6** `.labels/<label>/`: `readdir` der Label-Namen aus Space-Labels (`/spaces/{id}/content/labels`, neue Client-Methode), Inhalt über `getPagesByLabel` als Symlinks. TTL wie TreeIndex.
- [ ] **AP4.7** `.recent/{24h,7d,30d}/`: CQL `space = KEY AND type = page AND lastmodified >= now("-7d")` über `searchPages`, Symlinks. TTL 60 s.
- [ ] **AP4.8** `.search/<query>/`: Verzeichnisname ist die CQL (ohne `space =`-Teil, wird ergänzt); `mkdir` legt die Query an (In-Memory-Registry der Session), `readdir` führt sie aus und liefert Symlinks; `rmdir` entfernt sie. `.search/README` erklärt die Syntax. Tests mit Fake-CQL-Auswertung (einfacher `text ~`/`title ~`/`label =`-Interpreter im Fake).
- [ ] **AP4.9** Nicht-Seiten-Kinder (whiteboard, database, embed) als `name-<id>.<type>.json` read-only. Test.

### AP5 – Schreibpfad (5 Tage)

- [ ] **AP5.1** `src/write-back.ts`: `writeFile` auf bestehende Seite: Frontmatter parsen, `markdownToStorage()`, Version-Check gegen TreeIndex (`expected = cached.version`), `updatePage({ version: expected + 1 })`; Erfolg → TreeIndex und BodyCache aktualisieren. Titel-Änderung in der Frontmatter → zusätzlich `PUT /pages/{id}/title` (neue Client-Methode `updatePageTitle`) oder Titel im selben `PUT`.
- [ ] **AP5.2** Konflikt: Versionsabweichung vor dem `PUT` oder 409 danach → Refetch, 3-Way-Merge über `merge.ts` (Basis = gecachte Version, Ours = geschriebener Inhalt, Theirs = Server); Merge sauber → erneuter `PUT`; Merge mit Konflikten → Datei `<slug>-<id>.conflict.md` im Verzeichnis (virtuell, Session-Speicher) und `EBUSY`. Regressionstests: stale write, 409 vom Server, sauberer Merge, Konflikt-Merge.
- [ ] **AP5.3** Neue Seite: `writeFile` auf nicht existierenden Namen → Titel aus Frontmatter, sonst aus Dateiname (Slug → Titel mit Leerzeichen, erste Buchstaben groß); `parentId` aus Verzeichnis (Seite oder Folder, `movePageToFolder` bei Folder); `createPage`; Datei erscheint danach als `<slug>-<id>.md`, der ursprüngliche Name bleibt für die Session als Alias auflösbar. `EEXIST`, wenn im selben Verzeichnis bereits eine Seite mit diesem Titel existiert. Tests.
- [ ] **AP5.4** `mkdir <name>/` → leere Seite (oder mit `--folders` Folder via `createFolder`); `_index.md` erscheint. Test.
- [ ] **AP5.5** `rename` innerhalb desselben Verzeichnisses → Titeländerung; in anderes Verzeichnis desselben Space → `movePage`; in anderen Space oder mit Sortierposition → `movePageToPosition` (v1 `/content/{id}/move/…`, bestehend). `rename` auf Verzeichnisse verschiebt den Teilbaum (ein Call, Confluence nimmt Kinder mit). Tests je Fall, plus Test, dass das ID-Suffix beim Rename nicht verändert werden kann (`EINVAL`).
- [ ] **AP5.6** `rm` (nur mit `allowDelete`): Datei → `deletePage` (Papierkorb); Verzeichnis nur mit `recursive`, sonst `ENOTEMPTY`; Verzeichnis mit `recursive` → `deletePage` auf die Elternseite (Confluence verschiebt Kinder mit). `purge` wird nie aufgerufen. Tests.
- [ ] **AP5.7** `copy` → `copyPage` (bestehend), Ziel-Verzeichnis als Parent. Test.
- [ ] **AP5.8** Attachments im `rw`-Modus: `writeFile` in `_attachments/` → `uploadAttachment`/`updateAttachment`; `rm` → `deleteAttachment` (nur mit `allowDelete`). Tests.
- [ ] **AP5.9** Write-Coalescing: Schreibvorgänge auf dieselbe Datei innerhalb 500 ms zusammenfassen (WebDAV-Clients und Editoren schreiben chunked); `flush()` am Session-Ende, `--sync-writes` schaltet Coalescing ab. Tests mit Fake-Timer.
- [ ] **AP5.10** Audit-Log: jede erfolgreiche und fehlgeschlagene Schreiboperation als JSONL (`ts, profile, accountId, op, path, pageId, fromVersion, toVersion, result, error`) nach `<cacheDir>/audit.jsonl`; Rotation bei 10 MB. Test.
- [ ] **AP5.11** Roundtrip-E2E im Fake: Seite lesen → `sed`-artige Änderung → schreiben → erneut lesen → identischer Markdown (Normalisierung über `normalizeMarkdown`). Bekannte Verluste (Makros ohne Markdown-Äquivalent) werden als Warnung in stderr ausgegeben, nicht stumm verworfen.

### AP6 – just-bash-Adapter und `atlcli wiki sh` (5 Tage)

- [ ] **AP6.1** `apps/cli/src/vfs/just-bash-fs.ts`: Klasse `ConfluenceJustBashFs implements IFileSystem`, delegiert an `ConfluenceVfs`; `resolvePath` über `path.posix`, `getAllPaths()` liefert die bekannten Pfade aus dem TreeIndex (sync, aus Speicher); `readdirWithFileTypes` implementiert, damit `ls -l`/`find` keine `stat`-Stürme auslösen; `readFileBytes` für Attachments; `VfsError` → Node-artige Fehler mit `code`. Conformance-Tests von just-bash (falls exportiert) oder eigener Satz: `ls`, `ls -la`, `cat`, `find`, `grep -rn`, `sed`, `awk`, `jq`, `wc`, `head`, `tail`, `tree`, Globs, `>`/`>>`, `mkdir`, `mv`, `rm`, `cp`.
- [ ] **AP6.2** Bash-Factory `createWikiShell(opts)`: `new Bash({ defenseInDepth: false, fs: MountableFs mit Mount pro Space unter "/<KEY>", cwd: "/<KEY>", commands: [zulässige Liste ohne curl/python3/js-exec/sqlite3], executionLimits: { maxExecutionTimeMs: 120_000, maxOutputSize: 8 MB }, customCommands: [...] })`. Kommentar im Code mit Link auf just-bash-Issue #386 und TODO „DiD reaktivieren“.
- [ ] **AP6.3** `grep`-Override (`defineCommand("grep", …, { trusted: true })` mit `ctx.origCommand`): Flags parsen (`-r/-R`, `-l`, `-n`, `-i`, `-E`, `-F`, `--include`), Suchwörter aus dem Muster extrahieren (Literale ≥ 3 Zeichen), CQL `space = KEY AND type = page AND text ~ "wort1" AND text ~ "wort2"` (bei `-i` identisch, CQL ist case-insensitive); Treffer-IDs → `prefetchBodies` → Original-`grep` nur über diese Dateien. Ohne extrahierbare Literale oder bei > 500 Treffern: Warnung in stderr und Fallback auf vollständigen Prefetch des Verzeichnisses. Nicht-rekursives `grep` (einzelne Dateien, stdin) geht unverändert an das Original. Tests: Flag-Parsing, Literal-Extraktion, Fallback, exakte Zeilennummern.
- [ ] **AP6.4** `find`-Override: `-name`/`-iname`/`-path`/`-type` laufen nur über den TreeIndex; `-newer`/`-mtime`/`-newermt` über CQL `lastmodified`; alle anderen Prädikate → Original-`find`. Tests.
- [ ] **AP6.5** Zusatzbefehle: `cql "<query>"` (führt CQL aus, gibt Pfade aus), `page-url <path>` (Confluence-URL), `page-id <path>`, `vfs-status` (Modus, Cache, Requests, Rate-Limit-Zähler). Tests.
- [ ] **AP6.6** Kommando `apps/cli/src/commands/wiki-sh.ts`, Dispatch in `wiki.ts` (`case "sh"`), Help-Text: Flags `--space <KEY[,KEY]>` (Default aus Profil-Defaults), `-c <script>`, stdin-Skript bei nicht-TTY, interaktive REPL bei TTY (Prompt `<KEY>:<cwd> $`, History in `<cacheDir>/history`), `--mode ro|rw`, `--allow-delete`, `--cache-dir`, `--offline`, `--cwd <pfad>`, `--timeout <ms>`, `--json` (Ausgabe `{ stdout, stderr, exitCode, requests, cacheHits }`), `--confirm-destructive` (Default bei TTY: fragt bei `rm`/Cross-Space-`mv`). Exit-Code = Bash-Exit-Code. Tests analog `docs.test.ts` (Flag-Parsing, Help, JSON-Form).
- [ ] **AP6.7** Config-Erweiterung in `@atlcli/core`: `vfs: { cacheDir?, mode?, spaces?, cacheMaxMb? }` global und pro Profil; `atlcli config` zeigt und setzt die Werte. Tests.
- [ ] **AP6.8** Lazy-Import von just-bash im Kommando (dynamisches `import()`), damit Startzeit anderer Kommandos unverändert bleibt. Messung in `spikes/vfs-just-bash/README.md` nachtragen.
- [ ] **AP6.9** E2E `apps/cli/src/e2e/wiki-sh-live.e2e.test.ts` (Env-Gate `ATLCLI_VFS_E2E=1`): `ls`, `cat`, `grep -rl`, `find -name` gegen `DOCSY`; im `rw`-Modus Seite `vfs-e2e-<ts>` anlegen, ändern, umbenennen, verschieben, löschen; Cleanup auch bei Fehlschlag (Muster aus `e2e/cleanup.ts`).

### AP7 – WebDAV-Adapter und `atlcli wiki mount` (6 Tage)

- [ ] **AP7.1** `apps/cli/src/vfs/webdav-fs.ts`: `webdav-server` v2 `FileSystem`-Implementierung (Serializer, `_openReadStream`, `_openWriteStream`, `_readDir`, `_type`, `_size`, `_lastModifiedDate`, `_creationDate`, `_create`, `_delete`, `_move`, `_copy`, `_rename`, `_lockManager`, `_propertyManager`) über `ConfluenceVfs`. `VfsError` → passende HTTP-Codes (404, 403, 409, 423, 507). Symlinks (`.by-id`, `.labels`, `.recent`, `.search`) werden als reguläre Dateien mit dem Zielinhalt ausgeliefert (WebDAV kennt keine Symlinks).
- [ ] **AP7.2** LOCK/UNLOCK mit In-Memory-Lock-Manager (Pflicht, sonst mountet Finder read-only); Locks laufen nach 10 min ab. ETag = `"<pageId>-<version>"`, `If-Match`-Handling beim `PUT` → Konfliktpfad aus AP5.2. Tests mit `webdav`-Client-Bibliothek gegen den Server im Prozess.
- [ ] **AP7.3** Client-Eigenheiten: sofortiges 404 für `._*`, `.DS_Store`, `.metadata_never_index`, `.hidden`, `desktop.ini`, `Thumbs.db` ohne Backend-Aufruf; `PROPFIND Depth: 1` aus dem TreeIndex ohne Body-Fetch; `Content-Length` für Markdown aus Cache oder als `getcontentlength` geschätzt und beim `GET` exakt gesetzt. Tests, dass ein `PROPFIND` auf ein Verzeichnis mit 250 Kindern 0 Body-Requests auslöst.
- [ ] **AP7.4** Server-Lebenszyklus `apps/cli/src/vfs/webdav-server.ts`: Bind auf `127.0.0.1`, Port aus `--port` oder zufällig; optional `--token` für Bearer-Auth (Pflicht bei `--bind` ≠ loopback); sauberes Herunterfahren bei SIGINT/SIGTERM inkl. `flush()` der gepufferten Writes und Unmount.
- [ ] **AP7.5** Kommando `apps/cli/src/commands/wiki-mount.ts`, Dispatch `case "mount"` und `case "unmount"`: `atlcli wiki mount <mountpoint> --space … --mode ro|rw --allow-delete --cache-dir … --port … --foreground|--daemon`. macOS: `mount_webdav -S -v atlcli-<KEY> http://127.0.0.1:<port>/ <mountpoint>` (`-S` unterdrückt Auth-Dialog); Windows: `net use <X:> http://127.0.0.1:<port>/`; Linux: Hinweis mit `mount -t davfs`-Zeile (Verzeichnis existiert, `davfs2` prüfen). `unmount` → `umount`/`net use /delete` + Server-Stop. PID/Port-Datei unter `<cacheDir>/mounts/<mountpoint-hash>.json`.
- [ ] **AP7.6** `--daemon`: Server als detached Prozess (`Bun.spawn` mit `detached`), Logs nach `<cacheDir>/mounts/<hash>.log`; `atlcli wiki mount list|status` zeigt aktive Mounts.
- [ ] **AP7.7** Performance-Messung auf macOS (Finder und Terminal): `ls -R` über 500 Seiten, `grep -r` über 100 Seiten, Öffnen/Speichern in einem Editor. Zahlen und Request-Anzahl in der Doku; Schwellwert: `ls` eines Verzeichnisses mit 100 Einträgen < 1 s nach Warmup.
- [ ] **AP7.8** Windows-Smoke-Test (WebClient, 50-MB-Limit dokumentieren) und Linux-Smoke-Test mit `davfs2` in CI-Container (nur Server + `curl`-PROPFIND/GET/PUT, kein Kernel-Mount in CI).
- [ ] **AP7.9** E2E `wiki-mount-live.e2e.test.ts` (Env-Gate, nur macOS-Runner lokal): mount, `ls`, `cat`, im `rw`-Modus Seite anlegen und ändern, unmount, Cleanup.

### AP8 – Dokumentation und Agenten-Integration (2 Tage)

- [ ] **AP8.1** `src/content/docs/confluence/virtual-filesystem.md` nach Docs-Template: Intro, Voraussetzungen (Profil, Token, Space), Schritte für `wiki sh` und `wiki mount` (getrennt nach macOS/Windows/Linux), Optionen-Referenz (Typ, Default, Pflicht), Beispiele minimal (`ls`, `cat`) und fortgeschritten (Agent-Workflow: CQL-`grep`, `sed -i`, `mv`, Konfliktdatei), Troubleshooting (Finder read-only → LOCK, 429 → Concurrency, `EROFS` → `--mode rw`, Bun/DiD-Hinweis), Related topics (`sync.md`, `search.md`, `file-format.md`).
- [ ] **AP8.2** `src/content/docs/reference/cli-commands` um `wiki sh`, `wiki mount`, `wiki unmount`, `wiki vfs cache` ergänzen; Config-Referenz um `vfs.*`.
- [ ] **AP8.3** Skill/AGENTS-Snippet `docs/agents/confluence-vfs.md` (und im Docs-Site-Abschnitt „Recipes“): Kurzanleitung für Claude Code/Codex/Cursor mit `atlcli wiki sh -c '…'`, Space-Default, `--json`, Hinweis „`grep -r` nutzt CQL, `limit`-Empfehlung“, Schreib-Freigabe nur mit `--mode rw`.
- [ ] **AP8.4** `README.md`-Abschnitt „Confluence as a filesystem“ mit zwei Beispielen; `CHANGELOG.md`-Eintrag (unreleased).
- [ ] **AP8.5** `spec/confluence-virtual-filesystem.md` (dieses Dokument) nach Abschluss auf Ist-Stand bringen: Abweichungen, Messwerte, offene Punkte.

### AP9 – Qualität, Sicherheit, Release (3 Tage)

- [ ] **AP9.1** Security-Review des Schreibpfads: keine `purge`-Aufrufe, `ro` erzwingt `EROFS` auf allen Wegen (just-bash, WebDAV, Zusatzbefehle), Token nie im Audit-Log oder in `--json`-Ausgabe, WebDAV nur auf Loopback ohne `--token`. Checkliste im PR.
- [ ] **AP9.2** Berechtigungs-E2E: zweites Profil mit eingeschränktem Nutzer (oder Seite mit Restriktion via `setContentRestrictions` anlegen): Seite ist für Profil A sichtbar, für Profil B `ENOENT`; Cache von A liefert B nichts (getrennte DBs). Cleanup.
- [ ] **AP9.3** Lasttest im Fake: 5.000 Seiten, `ls -R`, `grep -r` mit CQL-Treffern 50, Fallback 5.000; Request-Zähler und Laufzeit als Snapshot-Test mit Toleranz.
- [ ] **AP9.4** Rate-Limit-Verhalten: Fake liefert 429 mit `Retry-After`; Test, dass Concurrency gedrosselt wird und Befehle nach Wartezeit erfolgreich enden, ohne dass der Nutzer Fehler sieht (nur Hinweis in stderr bei > 5 s Wartezeit).
- [ ] **AP9.5** `bun run typecheck`, `bun run test`, `bun run build`, Bundle-Größenvergleich zum Vorrelease; Homebrew-Formel und `--compile`-Binary auf macOS arm64 und Linux x64 manuell mit `wiki sh -c 'ls /DOCSY'` geprüft.
- [ ] **AP9.6** Release-Notes-Entwurf, Dry-Run `bun scripts/release.ts minor --dry-run`. Kein automatischer Release.

### AP10 – Nach v1 (nicht Teil dieses Plans)

- [ ] `bash`-Tool im `chat`/`research`-Agenten über `ConfluenceJustBashFs` (Vercel `bash-tool` oder eigenes LangChain-Tool).
- [ ] Defense-in-Depth wieder aktivieren, sobald just-bash #386 gefixt ist; dann Backend-Aufrufe in `runTrustedAsync()` kapseln.
- [ ] NFSv3-Sidecar (`nfsserve`, Rust) als schnellerer Mount für macOS/Linux, falls WebDAV-Messwerte aus AP7.7 nicht reichen.
- [ ] Jira-Namespace `/jira/<PROJECT>/<KEY>.md` über denselben Kern.
- [ ] Watch-Modus: Webhooks (`webhook-server.ts`) invalidieren TreeIndex/BodyCache statt TTL.

### Abhängigkeiten zwischen den Arbeitspaketen

```
AP0 ──► AP1 ──► AP2 ──► AP3 ──► AP4 ──┐
                 │                     ├──► AP6 (sh) ──┐
                 └──► AP5 (write) ─────┤               ├──► AP8 ──► AP9
                                       └──► AP7 (mount)┘
```

AP6 und AP7 können parallel starten, sobald AP2 und AP3 lesend stehen; AP5 wird in beide Adapter nachgezogen.

---

## 12. Selbstkritik und Unsicherheiten

- **Bun-Kompatibilität von just-bash 3.x ist der größte Einzelrisikopunkt.** Der Subagent hat den Crash unter Bun 1.3.11 reproduziert, atlcli nutzt Bun 1.3.14. `defenseInDepth: false` ist eine Sicherheitsabschwächung, die aber laut THREAT_MODEL nur eine Zweitschicht betrifft; atlcli führt Agenten-Skripte lokal mit Nutzerrechten aus, der Interpreter selbst bleibt sandboxed (kein Netz, Limits). Trotzdem: Spike zuerst.
- **Der 409-Konflikt** ist im v2-OpenAPI-Spec nicht formal gelistet (nur 200/400/401/404), aber durch Community-Berichte und `docs push`-Erfahrung belegt. Robust: eigenen Version-Check vor jedem `PUT`.
- **Rate-Limit-Zahlen** gelten nur für OAuth-Apps; für API-Token gibt es keine veröffentlichten Werte. Die Concurrency-Grenze von ~8 ist eine konservative Annahme aus dem MCP-Server-Issue, nicht aus Atlassian-Doku.
- **WebDAV-Leistung** wurde nicht gemessen, nur aus Quellen abgeleitet (Finder-Chattiness, `slack-fuse`-Zahlen). Phase 4 muss messen.
- **ID-Suffix-Pfade** lösen Kollisionen und Umbenennungen, machen Pfade aber länger und für Menschen weniger lesbar; `docs pull`-Verzeichnisse und VFS-Pfade sind damit nicht 1:1 austauschbar. Bewusst in Kauf genommen (Entscheidung 4).
- Nichts im Bereich „Confluence als Dateisystem“ existiert als Open Source (Stand 2026-09-15). Das ist ein Marktvorteil, aber auch ein Hinweis, dass es keine erprobten Lösungen für Randfälle (Folders, Whiteboards, Inline-Kommentare) gibt.

---

## 13. Offene Fragen

Die sechs Grundsatzfragen sind entschieden (Abschnitt 1a). Verbleibende Detailfragen, die während der Umsetzung geklärt werden können:

1. **`mkdir` im `rw`-Modus:** leere Seite (Default) oder Confluence-Folder? Vorschlag: Seite, Folder per `--folders`-Flag (AP5.4).
2. **`.search/`-Queries persistieren?** Aktuell nur Session-Speicher. Persistenz in `<cacheDir>/searches.json` wäre klein, aber ein weiterer Zustand.
3. **Konfliktdateien** nur virtuell (Session) oder auch im Cache-Verzeichnis ablegen, damit sie einen Prozess-Neustart überleben?
4. **Interaktive Bestätigung bei `rm`** im nicht-TTY-Modus: hart verweigern oder über `--yes` freigeben? Vorschlag: `--yes` erforderlich, sonst `EACCES` mit Hinweis.
5. **Bundle-Größe:** Grenzwert, ab dem just-bash nur als optionales Paket nachgeladen wird (Ergebnis AP0.4).

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
