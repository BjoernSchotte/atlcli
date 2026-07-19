# Export-Baseline — Umsetzungsdesigns (Cluster A–G)

Status: Design, 2026-07-18. Technische Umsetzungskonzepte für den Ausbau der
shape-agnostischen Export-Engines (`@atlcli/confluence` → `ExportBlock[]` →
`@atlcli/docx` / `@atlcli/pdf`), identisch konsumiert von CLI und
Browser-Extension (weitere Hosts können die Pakete über dieselben Ports
konsumieren). Je Arbeitspaket: (a) Nutzerwert, (b) Lösungsansatz,
(c) technische Umsetzung, (d) Aufwand S/M/L, (e) Risiken.
Reihenfolge/Parallelisierung: siehe `UMSETZUNGSPLAN.md`.

## 1. Cluster A — Export-Scope & Orchestrierung (A1–A5)

Grundprinzip aller Vorschläge: **eine** scope-agnostische Orchestrierungsschicht in `@atlcli/confluence` (Fetch + Komposition auf `ExportBlock[]`-Ebene), die unverändert von CLI und Extension konsumiert wird. Die Engines (`packages/docx/src/serialize.ts`, `packages/pdf/src/serialize.ts`) bleiben Ein-Dokument-Serializer — sie sehen nie, dass das Dokument aus mehreren Seiten stammt.

### Gemeinsames Fundament: `ExportScope` + `tree-fetch` + `composeChapters`

Neue Dateien: `packages/confluence/src/export-scope.ts`, `tree-fetch.ts`, `compose-document.ts` (alle isomorph, Export über `index.ts` **und** `index.browser.ts`).

```ts
// export-scope.ts — serialisierbar (CLI-Flags, URL-Params identisch)
export type ExportScope =
  | { kind: "page"; pageId: string }
  | { kind: "tree"; rootPageId: string; includeRoot?: boolean; maxDepth?: number }
  | { kind: "space"; spaceKey: string };

export interface LabelFilter {
  include?: string[];            // OR-Semantik (verbreitete Exporter-Konvention)
  exclude?: string[];            // OR-Semantik
  excludeMode?: "prune-subtree" | "page-only";  // Default: prune-subtree
}

// tree-fetch.ts — Port statt ConfluenceClient, damit weitere Hosts
// (z. B. Extension mit Session-Fetch) dieselbe Logik nutzen (Muster: PdfAssetResolver)
export interface TreeSource {
  getPage(id: string): Promise<{ id: string; title: string; storage: string;
    version?: number; labels?: string[]; spaceKey?: string }>;
  getChildren(id: string): Promise<Array<{ id: string; title: string; position: number | null }>>;
  getSpaceHomepageId(spaceKey: string): Promise<string>;
  searchPages?(cql: string): Promise<Array<{ id: string }>>;  // für Label-Batch-Filter
}

export interface TreeFetchProgress {
  fetched: number; total: number | null; currentTitle: string;
}

export interface ExportPageNode {
  pageId: string; title: string; depth: number; parentId: string | null;
  blocks: ExportBlock[]; notes: ExportNote[];
  meta: { version?: number; labels: string[]; position: number | null };
}

export async function fetchExportTree(
  source: TreeSource,
  scope: ExportScope,
  opts: { labels?: LabelFilter; maxPages?: number; concurrency?: number;
          signal?: AbortSignal; onProgress?: (p: TreeFetchProgress) => void }
): Promise<{ pages: ExportPageNode[]; notes: ExportNote[] }>
```

*Superseded: the implemented model discriminates tree nodes by kind —
`ExportNode = ExportPageNode | ExportFolderNode` (folder nodes carry no
`blocks`/`storage`), fetched via `TreeFetchOptions`/`FetchExportTreeResult`
(`{ nodes, notes, complete }`), not a bare `{ pages, notes }` tuple — see
002-scope-orchestration/PLAN.md.*

Implementierungsdetails `fetchExportTree`:
- **Reihenfolge**: Tiefensuche pre-order; Kindreihenfolge aus `ConfluenceClient.getChildrenWithPosition` (`client.ts:911`, echte UI-Position) — nicht das CQL-basierte `getChildren` (`client.ts:998`), das keine Positionsgarantie hat. Der Node-Adapter des Ports mappt 1:1 auf den bestehenden Client; `getFolderChildren` (`client.ts:2521`) für Folder-Knoten (Folder = Struktur ohne Body → Kapitel-Heading ohne Inhalt).
- **Zyklen/Duplikate**: `visited: Set<pageId>`; bei Wiedersehen `ExportNote { code: "tree-cycle" }` und Skip. Confluence-Bäume sind azyklisch, aber der Guard kostet nichts und macht die Funktion gegen kaputte APIs robust.
- **Nebenläufigkeit**: Kinder-Listing sequentiell (Ordnung!), Body-Fetch + `storageToBlocks` (`export-blocks.ts`) mit Concurrency-Pool (Default 4), `signal` wird an jeden Fetch durchgereicht.
- **UX**: `maxPages` Default 500 mit klarer Fehlermeldung statt stillem Hängen; `onProgress` treibt CLI-Spinner bzw. Panel-Fortschrittsbalken ("Seite 37/210: ‹Titel›"); Abbruch jederzeit via AbortSignal (Muster existiert bereits in `run-export.ts:59` `throwIfAborted`).

```ts
// compose-document.ts — Kapitel-Merge, von DOCX UND PDF konsumiert
export interface ComposeOptions {
  chapterBreak?: "none" | "pageBreak";   // Default: pageBreak
  chapterTitleFromPage?: boolean;        // Default: true (Seitentitel = Kapitelüberschrift)
}
export function composeChapters(pages: ExportPageNode[], opts?: ComposeOptions):
  { blocks: ExportBlock[]; notes: ExportNote[] }
```

*Superseded: `composeChapters` is total over `ExportNode` (not
`ExportPageNode`-only) via an exhaustive `switch (node.kind)` — `"folder"`
nodes emit a chapter heading with no body content — see
002-scope-orchestration/PLAN.md.*

Dafür zwei kleine, rückwärtskompatible Modell-Erweiterungen in `export-blocks.ts`:
- `{ type: "heading"; ...; explicitAnchor?: string }` — stabiler Anker unabhängig vom Text (nötig für Duplikat-Titel und seitenübergreifende Links).
- neuer Block `{ type: "pageBreak" }` — dient gleichzeitig C5 (`scroll-pagebreak`). DOCX: `<w:p><w:r><w:br w:type="page"/></w:r></w:p>`; PDF: `#pagebreak(weak: true)`.

---

### A1 — Page-Tree-Export

**(a) Nutzerwert.** "Exportiere dieses Handbuch" heißt praktisch nie "diese eine Seite": Doku lebt als Baum. Heute lehnt die ts-Engine `--include-children` explizit ab (`apps/cli/src/commands/export.ts:759-761`); nur die alte Python-Engine kann es. JTBD: *ein* versandfertiges Dokument aus einem Seitenbaum, ohne Copy-Paste.

**(b) Ansatz.** Orchestrierung oberhalb der Engines (s.o.), Merge auf `ExportBlock[]`-Ebene. Verworfen: (1) Merge auf Storage-XML-Ebene (verliert Seitenmetadaten, Anker-Namespacing unmöglich); (2) N Einzel-PDFs + pdf-Merge (kein gemeinsames Inhaltsverzeichnis, keine Kapitelnummerierung, DOCX gar nicht mergefähig).

**(c) Umsetzung.**
- CLI: `atlcli export docx|pdf <pageId> --tree [--max-depth N]` in `apps/cli/src/commands/export.ts`; ersetzt die cliNote bei Zeile 759. `parseScope` (`packages/confluence/src/scope.ts:32`) liefert das Flag-Muster (`--ancestor` ≙ tree) — `ExportScope` konvergiert bewusst mit `SyncScope` (`client.ts:76`).
- DOCX: `runExport` (`packages/docx/src/env.ts:90`) bekommt statt `details.storage`-Single-Page die komponierten Blocks; `ExportInput.details` (`export.ts:112`) bleibt die Root-Seite (Platzhalter wie `$scroll.title` beziehen sich auf die Wurzel — konsistent mit den etablierten `$scroll.*`-Template-Konventionen). `serializeBlocks` unverändert.
- PDF: `RunPdfExportInput.blocks` (`run-export.ts:22`) ist bereits scope-agnostisch — es nimmt einfach die komponierten Blocks. Asset-Fetch pro Seite: der `PdfAssetResolver` (`types.ts:26`) braucht den **Seitenkontext**, weil Attachment-Refs nur `filename` tragen (`ImageSource` in `export-blocks.ts:91`). Lösung: `composeChapters` qualifiziert Attachment-Quellen nicht um, sondern `fetchExportTree` liefert pro Node eine Ref-Map; der Host baut daraus einen multiplexenden Resolver (`filename@pageId`). Alternativ (sauberer, ein S-Aufwand mehr): `ImageSource` um optionales `pageId` erweitern und im Walker setzen — empfohlen.
- Progress: `runPdfExport.onPhase` (`run-export.ts:30`) wird um `onProgress?: (p: { phase; done; total; detail? }) => void` ergänzt; `preparePdfDocument` meldet pro eingebettetem Asset.

**UX-Entscheidungen**: Default bleibt Einzelseite; `--tree` ist explizit. Kapitel = Seitenwechsel per Default. Bei Überschreiten von Limits (Seitenzahl, 50-MB-Asset-Budget) harter, früher Fehler mit Handlungsvorschlag ("--max-depth", "--no-images"), kein degradiertes Riesen-PDF. **DX**: `fetchExportTree`/`composeChapters` sind pure-ish und mit Fake-`TreeSource` unit-testbar (functional core, imperative shell — CLAUDE.md-Muster).

**(d) Aufwand**: **M** (tree-fetch S, compose M, CLI-Wiring S, Host-Adapter je Host S). Abhängigkeiten: keine — Basis für A2–A4.
**(e) Risiken**: 50-MB-Cap (`prepare.ts:20`, `PDF_MAX_TOTAL_ASSET_BYTES`) bei bildlastigen Bäumen → Asset-Dedupe per sha256 vor dem Cap-Check + verständliche Fehlermeldung mit Verursacher-Liste. Offen: sollen Berechtigungslücken (Seite nicht lesbar) den Export abbrechen oder als Kapitel-Platzhalter erscheinen? Vorschlag: Note + Auslassung, Report zählt sie.

### A2 — Space-Export

**(a) Nutzerwert.** Compliance/Offboarding/Archiv: "der ganze Space als ein PDF". Verbreitete Exporter-Workflows decken das ab; uns fehlt es bisher komplett.

**(b) Ansatz.** Space = Tree mit Wurzel Space-Homepage. Kein eigener Codepfad: `scope.kind === "space"` löst per `getSpaceHomepageId` auf und delegiert an den Tree-Walk. Verworfen: CQL `space = X` flach abziehen — verliert Hierarchie und Ordnung, genau die Struktur ist der Wert.

**(c) Umsetzung.** In `fetchExportTree`: `case "space"` → Homepage-Id via bestehendem `getSpaceWithIcon`/Homepage-Helper (`client.ts`, vgl. `getSpaceHomepageStorage`-Nutzung in `export.ts:773`), dann Tree ab Homepage inkl. Root. CLI: `atlcli export pdf --space DOCSY`. Weitere Hosts können eine "Export space"-Aktion mit identischem Scope-Objekt anbieten. Metadaten: `PdfExportMetadata.space` (`types.ts:5`) wird Titelquelle (Cover = Space-Name).
**UX**: Vor Start eine Zählabfrage (ein Kinder-Listing-Durchlauf oder CQL-Count) → "212 Seiten, geschätzt ~3 min. Fortfahren?" im Panel; im CLI nur Info-Zeile. **DX**: identische Tests wie A1, nur anderer Scope-Konstruktor.

**(d) Aufwand**: **S** auf A1. **(e) Risiken**: Riesen-Spaces sprengen Browser-Memory (Extension und andere Browser-Hosts): Blocks sind klein, Assets groß → Asset-Streaming in den Compiler-VFS pro Kapitel statt alles vorab wäre L-Folgearbeit; v1 begrenzt per `maxPages` + Asset-Cap. Offen: Folder-only-Wurzeln (Spaces ohne klassische Homepage).

### A3 — Label-Include/Exclude

**(a) Nutzerwert.** Kuratierte Exporte aus gemischten Bäumen: `internal`-Seiten raus, nur `handbook`-Seiten rein — ein Standardmuster in verbreiteten Exporter-Workflows und damit ein wichtiger Migrationspfad für Bestandsinhalte.

**(b) Ansatz.** Filter als Baum-Beschneidung im Fetch, nicht in der Komposition. Label-Beschaffung batched via CQL statt N Einzel-Requests. Verworfen: reiner CQL-Fetch des ganzen Scopes (`label not in (...)`) — CQL kann keine Subtree-Pruning-Semantik ("Kinder ausgeschlossener Seiten auch weg") ausdrücken.

**(c) Umsetzung.** In `fetchExportTree`, nach dem Ordnungs-Walk (Ids bekannt, Bodies noch nicht geladen):
```ts
// Ein CQL-Roundtrip pro Filterliste statt pro Seite:
const excluded = new Set((await source.searchPages?.(
  `id in (${ids.join(",")}) and label in (${labels.exclude.map(q).join(",")})`
) ?? []).map(r => r.id));
```
nutzt `ConfluenceClient.searchPages` (`client.ts:694`, paginiert bereits). `excludeMode: "prune-subtree"` (Default, kompatibel zu verbreiteten Exporter-Workflows) entfernt Knoten samt Nachfahren **vor** dem Body-Fetch → gefilterte Seiten werden nie geladen (Kosten- und Privacy-Vorteil). `include` wirkt page-only (Kind einer Nicht-Include-Seite darf drin sein — etablierte OR-Semantik), leere Include-Menge ⇒ Fehler statt leerem Dokument. CLI: `--label-include a,b --label-exclude internal`. Panel: zwei Tag-Eingabefelder unter "Advanced" (Progressive Disclosure — Default ist filterlos).
**UX**: Report nennt "n Seiten durch Labelfilter ausgelassen" (`ExportNote code: "label-filtered"`), damit niemand fehlende Kapitel für einen Bug hält. **DX**: Filter ist pure Funktion `applyLabelFilter(nodes, labelsById, filter)` — trivially testbar.

**(d) Aufwand**: **S** auf A1. **(e) Risiken**: CQL `id in (...)`-Länge bei 500+ Seiten → chunken (à 100). Offen: Root-Seite selbst ausgeschlossen — Fehler oder Kinder als Top-Kapitel? Vorschlag: Fehler mit Hinweis.

### A4 — Hierarchie→Kapitel-Merge (Heading-Normalisierung über Seiten)

**(a) Nutzerwert.** Der Baum soll ein *Buch* ergeben: Seitentiefe = Kapitelebene, Überschriften innerhalb der Seite fügen sich darunter ein, Inhaltsverzeichnis und seitenübergreifende Links funktionieren. Genau dieses "hierarchy to sections"-Verhalten erwarten Nutzer aus verbreiteten Exporter-Workflows.

**(b) Ansatz.** Zweistufige Normalisierung in `composeChapters`: pro Seite erst Promotion (vorhandene Logik), dann Depth-Shift. Verworfen: globale Promotion über alle Seiten (eine Seite, die mit H4 beginnt, würde die Ebenen aller anderen verzerren); Word-Sections/Typst-Chapters als Sonderstruktur (unnötig — Ebenen + Pagebreaks reichen, Engines bleiben unangetastet).

**(c) Umsetzung.** Kern von `compose-document.ts`:
```ts
for (const page of pages) {
  const chapterLevel = clamp(page.depth + 1, 1, 6);
  out.push({ type: "pageBreak" });                       // per ComposeOptions
  out.push({ type: "heading", level: chapterLevel,
             content: [{ type: "text", text: page.title }],
             explicitAnchor: `page-${page.pageId}` });
  const offset = computeHeadingOffset(page.blocks);       // aus serialize.ts:243
  out.push(...shiftHeadings(page.blocks, chapterLevel - offset)); // level' = level - offset + chapterLevel, clamp 6 + Note "heading-depth-clamped"
}
```
Dafür wird `computeHeadingOffset`/`minHeadingLevel` aus `packages/docx/src/serialize.ts:243` nach `@atlcli/confluence` gehoben (z. B. `export-blocks.ts` oder `compose-document.ts`) und von DOCX **und** PDF-Writer (`packages/pdf/src/serialize.ts:654`, `writer.headingOffset`) re-importiert — heute existiert die Promotion doppelt. Da das komponierte Dokument immer mit Level 1 beginnt, ergeben beide bestehenden Offsets automatisch 0 (kein Engine-Umbau nötig).
**Anker-Namespacing**: `composeChapters` rewritet Inline-Links (`LinkTarget`, `export-blocks.ts:45`): `{kind:"page", contentTitle}` mit Titel im Kapitelset → `{kind:"anchor", anchor:"page-<id>"}`; `{kind:"anchor"}` in-page → `"p<pageId>-<anchor>"` (Kollisionsfreiheit bei gleichnamigen Überschriften in verschiedenen Seiten). PDF: `resolveLink` (`serialize.ts:227`) findet den Label über die Map, `explicitAnchor` emittiert `<page-123>` hinter dem `#heading(...)` (Muster `serialize.ts:664`). DOCX: Heading mit `explicitAnchor` bekommt Bookmark, interne Links werden echte Sprünge (heute nur blau gefärbt, `serialize.ts:166`):
```xml
<w:bookmarkStart w:id="41" w:name="page-123456"/><w:r>…Titel…</w:r><w:bookmarkEnd w:id="41"/>
<w:hyperlink w:anchor="page-123456" w:history="1"><w:r>…Linktext…</w:r></w:hyperlink>
```
Typst-Kapitelbild (nur Doku, Template `template.ts` bleibt kompatibel — `outline(depth: 3)` Zeile 142 zeigt Kapitel automatisch):
```typst
#pagebreak(weak: true)
#heading(level: 1, outlined: true)[Installation Guide] <page-123456>
// Querverweis aus anderem Kapitel:
#link(<page-123456>)[siehe Installation Guide]
```
**UX**: Links auf Seiten *außerhalb* des Exports werden externe URLs (`baseUrl + /wiki/...`) statt toter Anker — Note `"link-outside-scope"`. **DX**: `composeChapters` ist deterministisch und snapshot-testbar; Golden-Test analog `packages/docx/src/golden.test.ts`.

**(d) Aufwand**: **M** (compose+shift S, Anker-Rewrite M, DOCX-Bookmarks S, PDF-explicitAnchor S). Abhängig von A1. **(e) Risiken**: Tiefe > 6 → Clamp + Note (übliches Verhalten verbreiteter Exporter); Titel-Duplikate sind durch id-basierte Anker gelöst. Offen: Kapitelnummerierung (Typst `set heading(numbering: "1.1")`) als Theme-Option — Vorschlag ja, Default aus.

### A5 — Export-API-Story (client-side Architektur)

**(a) Nutzerwert.** Verbreitete Exporter-Workflows bieten gehostete REST-Jobs (start/poll/download) für CI-Pipelines. Unsere Zero-Backend-Architektur (Entscheidung: Compile im Client, kein Server) *kann* strukturell keine gehostete REST-API anbieten — die ehrliche Antwort ist eine erstklassige Headless-/Library-Story, die für den JTBD ("Export in meiner Pipeline") sogar besser ist: kein Polling, keine Region, keine Datenübertragung an Dritte.

**(b) Ansatz.** Drei Ebenen: (1) CLI headless als "API" (`atlcli export pdf --tree --json` → maschinenlesbarer Report auf stdout, Exit-Codes), (2) publizierte Library-API — `runPdfExport`/`PdfExportEnv` (`run-export.ts:111`) und `runExport`/`ExportEnv` (`env.ts:90`) *sind* bereits die API, es fehlt nur ein Node-Batteries-Paket, (3) dokumentiertes GitHub-Action-Rezept. Verworfen: eigener gehosteter Export-Service (zerstört das Zero-Egress-Verkaufsargument und die Kostenstruktur); server-seitiges Kompilieren in gehosteten Functions (Typst-WASM in kurzlebigen Function-Umgebungen = Timeout-/Kostenrisiko, konterkariert die Zero-Backend-Entscheidung).

**(c) Umsetzung.** Neues Paket `@atlcli/export-node`: bündelt `fileOutputSink`, Token-`AssetFetcher` (heute CLI-intern in `apps/cli/src/commands/export-internals.ts` — herausziehen), `PdfCompilePort`-Node-Adapter. Ziel-DX:
```ts
import { fetchExportTree, composeChapters } from "@atlcli/confluence";
import { runPdfExport } from "@atlcli/pdf";
import { nodePdfEnv, confluenceTreeSource } from "@atlcli/export-node";

const tree = await fetchExportTree(confluenceTreeSource(profile), 
  { kind: "tree", rootPageId: "123" }, { labels: { exclude: ["internal"] } });
const doc = composeChapters(tree.pages);
await runPdfExport({ blocks: doc.blocks, metadata, filename: "handbook.pdf" },
  nodePdfEnv(profile, { outDir: "dist" }));
```
CLI-Report-Schema versionieren (`ExportReport`/`PdfExportReport`, `types.ts:128`) und im `--json`-Output stabil halten; Exit-Codes dokumentieren (0 ok, 2 mit Warnungen bei `--strict`, …). Docs: `docs/`-Guide "Automate exports (CI)" mit Minimal- und Advanced-Beispiel (Docs-Standard aus CLAUDE.md).
**UX/Positionierung**: Die Doku sagt explizit "Automation = CLI/Action, kein Cloud-Job-Polling nötig".

**(d) Aufwand**: **S–M** (Extraktion + Paketierung + Doku; PDF-CLI-Command, falls noch fehlend, S auf bestehenden Seams). Abhängig: A1 für `--tree`. **(e) Risiken**: SemVer-Pflicht auf bisher interne Typen; Typst-WASM-Node-Pfad muss im CI-Kontext (Linux-Runner) getestet sein. Offen: npm-Publikation der Pakete (heute workspace-privat?).

---

**Reihenfolge-Empfehlung**: A1 → A4 (zusammen ein Release-Feature "Book Export"), dann A3, A2 (billige Aufsätze), A5 parallel dokumentierbar.

## 2. Cluster B — Templates, Branding & Settings

Gemeinsame Basis aller Arbeitspakete: der Vertrag `atlcli.pdf-template/v1` mit `render(meta, body, settings)` (TEMPLATE-UX §7) und ein abgestuftes Modell der Template-Quellen (gebündelt → Site-Library → extern). Heute ruft `serializePdfDocument` (`packages/pdf/src/serialize.ts:849`) nur `atlcli-doc.with(meta: (...))` auf — **der erste Schritt für fast alle Pakete unten ist, `settings` als drittes Argument durch `PdfSerializeOptions` → `main.typ` zu fädeln.** Shape-agnostisch: alles läuft über `PdfExportEnv`/`ExportEnv`-Ports, Hosts (CLI, Extension) liefern nur Storage-Adapter.

### B2 — Globale vs. Space-Templates
**(a)** JTBD: „Als Doku-Verantwortliche will ich ein Firmen-Template einmal zentral pflegen, aber einzelnen Spaces (z. B. Legal) ein abweichendes erlauben" — heute gibt es pro Host genau einen Template-Slot (`idbTemplateSource` in `apps/extension/utils/docx/template-store.ts`, `TemplateSource.getBytes("current")` in `packages/docx/src/env.ts:17`).
**(b)** Entscheidung: eine host-neutrale `TemplateLibrary`-Abstraktion mit Zwei-Ebenen-Lookup (Space schlägt Global). Verworfen: pro-User-Templates als dritte Ebene (v1 zu viel; Governance unklar) und quota-beschränkte Host-Key-Value-Stores als Storage.
**(c)** Neues Modul `packages/plugin-api` oder besser `packages/core/src/template-library.ts` (engine-neutral, von `@atlcli/docx` und `@atlcli/pdf` konsumierbar):
```ts
export interface TemplateLibraryEntry {
  id: string; displayName: string; engine: "docx" | "typst";
  scope: "global" | "space"; spaceKey?: string;
  sha256: string; size: number; uploadedAt: string;
}
export interface TemplateLibrary {
  list(engine: TemplateLibraryEntry["engine"], spaceKey?: string): Promise<TemplateLibraryEntry[]>;
  getBytes(entry: TemplateLibraryEntry): Promise<Uint8Array>; // sha256-verifiziert
}
export function resolveTemplate(entries: TemplateLibraryEntry[], id: string, spaceKey?: string) {
  return entries.find(e => e.id === id && e.scope === "space" && e.spaceKey === spaceKey)
      ?? entries.find(e => e.id === id && e.scope === "global");
}
```
Adapter: Extension = IndexedDB-Erweiterung des Single-Slot-Stores; CLI = `~/.atlcli/templates/` (global) + `.atlcli/templates/` im Sync-Verzeichnis (Space); weitere Hosts können einen `attachmentTemplateSource` mit Index in einer Content-Property (`atlcli-export:templates`) beisteuern. `resolveTemplate` bleibt pure → trivial testbar. Der Scan-Verdict (`scanTemplate`, `packages/docx/src/scan.ts:174`) wird **nie** persistiert, immer aus Bytes re-deriviert (Entscheidung: Verdicts sind ableitbar, nicht speicherbar).
**(d)** M. Abhängig von: verifiziertem binärtreuem Attachment-Roundtrip (für den Attachment-Adapter) und einer Admin-/Settings-Oberfläche im jeweiligen Host.
**(e)** UX: Default = globales Template, Space-Override nur via Progressive Disclosure im Admin-Panel („Dieser Space verwendet: Global ▾"); Fehlerbild bei sha256-Mismatch: harter Abbruch mit „Template wurde verändert — neu hochladen", nie stiller Fallback. Offen: Berechtigungsmodell für „wer darf global setzen" (z. B. Site-Admin via Confluence-Permissions der Library-Page).

### B3 — Template-Sharing-Format (`.atlcli-template` auch für DOCX)
**(a)** JTBD: „Als Agentur will ich ein Template bei Kunde A bauen und bei Kunde B importieren" — verbreitete Exporter-Workflows kennen dafür proprietäre Austauschdateien. Bei uns ist das Archiv (Level B) PDF-only geplant und unimplementiert.
**(b)** Entscheidung: **ja, ein Format für beide Engines** — `.atlcli-template` ist ein deterministisches Zip mit Manifest; `engine.kind` diskriminiert. Verworfen: separates `.atlcli-docx`-Format (zwei Import-Pfade, zwei Doku-Kapitel, kein Mehrwert); nackte `.docx`-Weitergabe (verliert Settings-Defaults, Herkunft, sha256). TEMPLATE-UX §11 („no coupling of Word template behavior to the Typst package API") bleibt gewahrt: nur das *Container*-Format ist geteilt, nicht der Render-Vertrag.
**(c)** Manifest-Schema (Erweiterung von TEMPLATE-UX §7):
```json
{
  "schemaVersion": 1, "id": "com.acme.word-report", "name": "Acme Report",
  "version": "1.0.0",
  "engine": { "kind": "docx", "api": "atlcli.docx-template/v1", "entry": "template.docx" },
  "settings": { "dateFormat": { "type": "text", "default": "dd.MM.yyyy" },
                "timeZone": { "type": "choice", "options": ["Europe/Berlin","UTC"], "default": "Europe/Berlin" } },
  "provenance": { "sha256": "…", "createdWith": "atlcli 0.x" }
}
```
Typst-Variante: `engine.kind: "typst"`, `api: "atlcli.pdf-template/v1"`, `entry: "template.typ"`, `assets/`, `LICENSES/`. Neues Paket `packages/template-pack/src/{pack,unpack,validate}.ts` (isomorph, pure): deterministische Zip-Reihenfolge, Pfad-Traversal-Rejection, Größen-Caps (`MAX_TEMPLATE_BYTES = 20 MiB` aus `scan.ts:30` wiederverwenden), beim DOCX-Import zwingend `scanTemplate()` + ✓/⚠/✗-Report vor Annahme. CLI: `atlcli template pack|validate` (verallgemeinert die in TEMPLATE-UX §5.2 vorgeschlagenen `pdf-template`-Kommandos).
**(d)** M. Abhängigkeit: B2 (Library als Import-Ziel).
**(e)** DX-Risiko: Versionierung des Settings-Schemas — `schemaVersion` + `api`-Range von Tag 1 pflegen. Offen: Signierung/Provenance für organisationsübergreifende Weitergabe (v2).

### B5 — Font-Upload
**(a)** JTBD: „Unser CI schreibt ‚Corporate Sans' vor — ohne die Hausschrift ist der Export für offizielle Dokumente unbrauchbar." Verbreitete Exporter-Workflows erlauben `.ttf/.ttc/.otf`-Upload.
**(b)** Entscheidung: Site-Library auf Basis von Confluence-Attachments als primärer Weg; Fonts fließen als `Uint8Array[]` in den bestehenden `BrowserPdfCompiler`-Konstruktor (`packages/pdf-compiler-browser`, Adapter fetcht nie selbst). Verworfen: WOFF2-Support zum Start (Typst konsumiert nur sfnt; Rejection mit Guidance, später brotli-wasm-Konvertierung).
**(c)** Neue Schnittstelle neben `PdfAssetResolver` in `packages/pdf/src/types.ts`:
```ts
export interface FontAsset { family: string; style: "normal" | "italic"; weight: number;
  sha256: string; license?: { kind: "OFL" | "Apache-2.0" | "proprietary"; evidence: string }; }
export interface FontSource { list(): Promise<FontAsset[]>; getBytes(sha256: string): Promise<Uint8Array>; }
```
Client-seitige Validierung vor Upload (pure Funktion `parseFontMeta(bytes)` in neuem `packages/pdf/src/fonts.ts`): Magic-Bytes `00 01 00 00` / `OTTO` / `ttcf`, `name`-Table (IDs 1/2/16/17) für Familie/Stil, Cap 10 MB/Font. Der Host baut den Compiler dann mit `bundledFonts ∪ (await Promise.all(selected.map(f => fontSource.getBytes(f.sha256))))`. Template-Manifest referenziert Fonts als `{"type": "choice"}`-Setting, dessen `options` das Formular aus `FontSource.list()` generiert — so bleibt Level A („font choice from an approved set") intakt.
**(d)** M. Abhängigkeiten: verifizierter binärtreuer Attachment-Roundtrip, B2-Library-Infrastruktur (gleicher Index, `kind: "font"` im `AssetSource`).
**(e)** UX: Lizenz-Attestierung als Pflichtschritt beim Upload (Checkbox + Freitext-Evidence, OFL/Apache aus Font-Tables vorbefüllt); Fehlerbild „WOFF2 erkannt → bitte TTF/OTF hochladen, so exportierst du aus …". Risiko: fehlende Glyphen (CJK) → Preflight-Warnung, wenn Dokumenttext Codepoints außerhalb der cmap enthält (Check ist teuer — nur Stichprobe, offene Frage).

### B6 — Stationery / SVG-Hintergründe
**(a)** JTBD: „Wir haben einen fertigen Briefbogen — der Export soll darauf laufen." Level C plant PDF-Stationery; SVG-Briefbögen sind in etablierten Workflows üblich und für uns der *einfachere* erste Schritt, weil Typst SVG nativ als `image()` rendert.
**(b)** Entscheidung: Stationery-Manifest (TEMPLATE-UX §7 `page`/`backgrounds`) unterstützt `image/svg+xml` **und** PDF; SVG zuerst shippen, PDF-Embed hinter Spike (natives `image("x.pdf", page: n)` erst ab Typst ≥ 0.13 — gegen die gepinnte typst-ts-0.7.0-Version verifizieren). Verworfen: Rasterisierung des PDFs zu PNG als Dauerlösung (Qualität, Dateigröße) — nur als Fallback.
**(c)** Typst-Umsetzung im generierten Wrapper (Level-C-Importer erzeugt dieses `template.typ` automatisch):
```typst
#let stationery(settings, body) = {
  let bg(role) = {
    let f = settings.backgrounds.at(role, default: none)
    if f != none { image(f, width: 100%, height: 100%, fit: "cover") } else { none }
  }
  set page(
    width: settings.page.width, height: settings.page.height,
    margin: settings.page.content-box, // (top: 32mm, right: 22mm, bottom: 25mm, left: 22mm)
    background: context {
      if counter(page).get().first() == 1 { bg("first") } else { bg("body") }
    },
  )
  body
}
```
Die Assets laufen als `PreparedPdfAsset` (`packages/pdf/src/types.ts:30`) in den Job-VFS — SVG-Sanitization + Size-Caps existieren in `prepare.ts` bereits und werden wiederverwendet. Wichtig für Tagged-PDF: Typst-Page-Backgrounds sind Artifacts (nicht AT-exponiert, TEMPLATE-UX §8) — genau richtig für dekorative Briefbögen; `validatePdfOutput` (`packages/pdf/src/validate.ts`) prüft die Struktur weiterhin.
**(d)** L (Wizard aus TEMPLATE-UX §6 inklusive); SVG-only-MVP ohne Wizard (Manifest von Hand): M. Abhängig von B3-Archivformat und `settings`-Durchstich.
**(e)** Risiko: PDF-Embed + PDF/UA-Claim (TEMPLATE-UX §8 — Konformität ggf. verweigern statt leise abschwächen). Offen: Odd/Even-Rectangles (§12.4) — v1: nein.

### B7 — Watermark (Quick Win)
**(a)** JTBD: „Entwürfe und vertrauliche Exporte müssen als solche erkennbar sein." Verbreitete Cloud-Exporter-Workflows bieten oft **kein** Watermark — für uns ein billiger, sichtbarer Differenzierer und Quick Win.
**(b)** Entscheidung: Watermark als Standard-`settings`-Block, den der **Engine-Wrapper** rendert (nicht jedes Template einzeln) — als Text-Layer im Page-Background, damit er unter dem Content liegt und im Tagged-PDF automatisch Artifact ist. Verworfen: Foreground-Layer (überdeckt Text, stört Lesbarkeit/Kopierbarkeit), Bild-Watermark v1 (Text deckt 95 % der Fälle).
**(c)** `PdfSerializeOptions` (`packages/pdf/src/types.ts:115`) erhält `settings?: PdfTemplateSettings` mit:
```ts
export interface PdfWatermarkSettings { text: string; color?: string; // "#DE350B"
  opacity?: number; /* 0..1, default 0.08 */ angle?: number; /* deg, default -54 */ size?: number; /* pt, default 96 */ }
```
Typst (in `createAtlcliTypstTemplate`, `packages/pdf/src/template.ts`, in den bestehenden `set page(...)`-Aufruf integriert):
```typst
#let watermark-layer(wm) = if wm != none {
  place(center + horizon, rotate(wm.at("angle", default: -54deg) * 1deg,
    text(font: "Source Sans 3", weight: "bold",
      size: wm.at("size", default: 96) * 1pt,
      fill: rgb(wm.at("color", default: "#DE350B"))
        .transparentize(100% - wm.at("opacity", default: 8%)),
      wm.text)))
}
// in atlcli-doc: set page(..., background: watermark-layer(settings.at("watermark", default: none)))
```
DOCX-Pendant: WordArt-Shape im Header (Standard-Word-Mechanismus, in `packages/docx/src/ooxml.ts` als `watermarkShape()`-Helper, injiziert in vorhandene Header-Parts über den bestehenden Header-Rewriting-Pfad):
```xml
<w:p><w:r><w:pict>
  <v:shape type="#_x0000_t136" style="position:absolute;width:412pt;height:247pt;rotation:315;
    mso-position-horizontal:center;mso-position-vertical:center;z-index:-251654144" fillcolor="silver" stroked="f">
    <v:fill opacity=".5"/><v:textpath style="font-family:'Calibri'" string="ENTWURF"/>
  </v:shape>
</w:pict></w:r></w:p>
```
**(d)** S (PDF), S–M (DOCX-Header-Injektion). Abhängig nur vom `settings`-Durchstich.
**(e)** UX: Presets „Entwurf / Vertraulich / Frei" im Export-Dialog, Freitext dahinter (Progressive Disclosure); Default aus. Risiko: Kontrast auf dunklen Cover-Seiten — Opacity-Default konservativ, eine Live-Preview zeigt es sofort. Offen: Watermark erzwingbar per Space-Policy (Admin-Lock)?

### B8 — Seitenformat/Orientierung + Sections
**(a)** JTBD: „US-Kunden brauchen Letter, breite Tabellen brauchen Querformat, und nicht jedes Dokument braucht Cover + Schlussseite." Heute ist `paper: "a4"` hart codiert (`template.ts:71`) und Cover/Outline/End-Page sind nicht abschaltbar (`template.ts:116–175`).
**(b)** Entscheidung: `page.size`/`page.orientation` als Manifest-Settings (Level A, wie geplant) **plus** ein `sections`-Block, der die vier Dokumentteile (cover, outline, body, colophon) einzeln toggelt — das deckt den üblichen „customize document sections"-Bedarf im 80 %-Fall ab, ohne per-Section-Designer. Verworfen: frei definierbare Section-Liste (Overengineering v1); per-Content-Orientation (`scroll-landscape`-Makro) gehört zu C6.
**(c)** Manifest:
```json
"page":        { "type": "choice", "options": ["a4", "letter", "legal", "a3"], "default": "a4" },
"orientation": { "type": "choice", "options": ["portrait", "landscape"], "default": "portrait" },
"cover":       { "type": "boolean", "default": true },
"outline":     { "type": "boolean", "default": true },
"colophon":    { "type": "boolean", "default": true }
```
Typst in `atlcli-doc` (ersetzt die fixen Aufrufe):
```typst
#let s = settings
#set page(paper: s.at("page", default: "a4"),
          flipped: s.at("orientation", default: "portrait") == "landscape",
          /* margin, header, footer wie bisher */)
#if s.at("cover", default: true) [ /* bisheriger Cover-Block */ #pagebreak() ]
#if s.at("outline", default: true) { outline(title: contents-label, depth: 3); pagebreak() }
body
#if s.at("colophon", default: true) [ #pagebreak() /* bisherige Schlussseite */ ]
```
`serializePdfDocument` emittiert `settings` als Typst-Dict neben `meta` (gleiches `typstString`-Escaping, `serialize.ts`); `RunPdfExportInput` (`run-export.ts:22`) bekommt `settings?: PdfTemplateSettings`. DOCX: Seitenformat kommt dort aus dem `.docx`-Template selbst (`w:sectPr/w:pgSz`) — kein Engine-Feature nötig, nur Doku.
**(d)** S–M. Kein Blocker; idealer erster `settings`-Durchstich (Grundlage für B6/B7/B10).
**(e)** Risiko: Header/Footer-Grid und Cover-Maße (`v(37mm)`, `block(width: 90%)`) sind auf A4 getunt — relative Maße prüfen, Golden-Tests je Format (`serialize.test.ts` erweitern + ein Compile-Smoke-Test pro Format im Harness). Offene UX-Frage: Letter-Default automatisch aus `meta.region == "US"`?

### B9 — Tabellen-Stilquelle (DOCX)
**(a)** JTBD: „Unsere Word-Vorlage hat einen Haus-Tabellenstil — der Export soll ihn nutzen statt Confluence-Farben mitzuschleppen." Etablierte Exporter-Workflows bieten die Wahl „Stil aus der Word-Datei" vs. „Stil aus der Confluence-Seite". Heute erzwingt `dataTable` (`packages/docx/src/ooxml.ts:230–243`) `w:tblStyle w:val="TableGrid"` **plus** hart codierte `w:tblBorders` (#AAAAAA) — Template-Stile haben keine Chance, weil Inline-Formatierung Stil-Definitionen überschreibt.
**(b)** Entscheidung: Export-Option `tableStyle: { source: "template" | "confluence"; styleId?: string }` (Default `"confluence"` = heutiges Verhalten, kein Breaking Change). `"template"` referenziert einen Stil (Default `"ScrollTable"`, Fallback `TableGrid` wenn im Template nicht vorhanden — via `styles.xml`-Lookup beim Scan) und lässt Borders/Shading weg. Verworfen: per-Tabelle-Auswahl im UI (kein Anker im Confluence-Content; auch etablierte Exporter lösen das nur global pro Template).
**(c)** `dataTable(gridCols, rowsXml, opts)` in `ooxml.ts`:
```xml
<!-- source: "template" — nur Stilreferenz, keine Inline-Borders/-Shading: -->
<w:tbl><w:tblPr><w:tblStyle w:val="ScrollTable"/><w:tblW w:w="9000" w:type="dxa"/>
  <w:tblLook w:firstRow="1" w:noVBand="1" w:val="04A0"/></w:tblPr>
  <w:tblGrid>…</w:tblGrid>…</w:tbl>
```
Bei `"template"` unterdrückt `serialize.ts` außerdem Zell-`w:shd`-Fills aus Confluence (Header-Zeile via `w:tblLook firstRow` dem Stil überlassen). Option wandert in `ExportInput` (`packages/docx/src/export.ts`) und wird vom Template-Manifest (B3, `settings.tableStyle`) vorbelegt. `scanTemplate` erweitert den Report: „Template definiert Tabellenstile: ScrollTable ✓". PDF-Analogon existiert schon als `PdfThemeOptions.table` (`types.ts:85`) — keine Arbeit.
**(d)** S–M. Synergie mit G3 (Spaltenbreiten, `ooxml.ts:231` teilt heute gleichmäßig) — im selben PR lösen.
**(e)** Roundtrip-Risiko: Word rendert Stil-Tabellen ohne `tblLook` falsch — E2E gegen echtes Word/LibreOffice testen (Workflow-Regel). Offen: benannter Stil pro Panel-Typ (v2).

### B10 — Template-Settings, Zeitzone, Presets
**(a)** JTBD: „Das Exportdatum muss in unserer Zeitzone und unserem Format stehen, und mein Team soll denselben vorkonfigurierten Export mit einem Klick bekommen." Ist-Zustand inkonsistent: PDF-`exportedDateLabel` formatiert hart in UTC (`serialize.ts:823`), DOCX-`formatSimpleDate` in der **lokalen** Zone des exportierenden Rechners (`dateformat.ts:14–16`) — zwei Engines, zwei Antworten auf dieselbe Frage.
**(b)** Entscheidung: ein gemeinsamer `ExportSettings`-Kern (language/region existieren, + `timeZone` als IANA-String, `dateFormat`), Default = Zeitzone des Betrachters (`Intl.DateTimeFormat().resolvedOptions().timeZone`), gespeichert pro Template-Instanz; darüber **Presets** = benannte `{templateId, settings}`-Bundles pro Space/global. Verworfen: eigene TZ-Datenbank bundlen (Intl reicht in allen Hosts, auch Node ≥ 18/Bun).
**(c)** Zeitzonen-Kern als pure Funktion in `packages/core/src/zoned-date.ts`, von beiden Engines konsumiert:
```ts
export function zonedParts(date: Date, timeZone: string) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  }).formatToParts(date).map(x => [x.type, x.value]));
  return { year: +p.year, month: +p.month, day: +p.day, hour: +p.hour % 24, minute: +p.minute, second: +p.second };
}
```
`formatSimpleDate(date, pattern, opts?: { timeZone?: string })` bezieht seine `values`-Map aus `zonedParts` statt `date.getMonth()` etc. (`dateformat.ts:59–77`); `exportedDateLabel` bekommt `timeZone` statt fixem `"UTC"`; `typstDate` (`serialize.ts:813`) baut das `datetime(...)` aus denselben Parts, damit Cover und Metadaten konsistent sind. `PdfExportMetadata` (`types.ts:3`) erhält `timeZone?: string`. Presets (Manifest-Schema, gespeichert als Space-Property `atlcli-export:presets` / CLI `~/.atlcli/config.json`-Profilfeld / Extension-IndexedDB):
```json
{ "id": "release-notes-de", "name": "Release Notes (DE)", "templateId": "com.acme.report",
  "scope": "space", "settings": { "language": "de", "timeZone": "Europe/Berlin",
  "watermark": null, "page": "a4", "cover": false } }
```
Der Export-Dialog rendert das Settings-Formular generisch aus dem Manifest (Typen `text|boolean|choice|color|number|asset` aus TEMPLATE-UX §5.1) — ein Renderer für alle Hosts, Preset = vorbefüllte Formularwerte. Regressionstests: DST-Kanten (31.12. 23:30 UTC in `Pacific/Auckland`), ungültige Zone → Fehler + Fallback auf Host-Zone mit Report-Note (ehrliches Fehlerbild statt stillem UTC).
**(d)** S (Zeitzone) + M (Preset-Storage je Host + Formular-Renderer). Der Formular-Renderer ist Voraussetzung für die B7/B8-UX — früh bauen.
**(e)** Offen: Preset-Sichtbarkeit (persönlich vs. Space — v1: nur Space/global, sonst Governance-Chaos); Verhalten wenn ein Preset auf ein gelöschtes Template zeigt (Fehlerbild: Preset deaktiviert anzeigen, nicht löschen).

### Empfohlene Reihenfolge (DX-getrieben)
1. `settings`-Durchstich + B8 (kleinster Schnitt, öffnet den Vertrag), 2. B7 Watermark (sichtbarer Quick-Win), 3. B10 Zeitzone (Konsistenz-Bugfix) + Formular-Renderer, 4. B2+B3 (Library + Archivformat), 5. B5 Fonts, 6. B9, 7. B6 Stationery (größter Brocken, eigener Spike).

## 3. Cluster C-content: Inhalts- und Dokumentfeatures (C1–C9)

### Gemeinsame Modell-Erweiterung (Voraussetzung für alle Pakete)

Alle neun Pakete setzen am selben Seam an: `ExportBlock` in `packages/confluence/src/export-blocks.ts` wird erweitert, `walkMacro()` (Zeile 667) lernt die `scroll-*`-Makros, und beide Engines rendern die neuen Blöcke — DOCX in `packages/docx/src/serialize.ts` (`serializeBlock`, exhaustiver `switch` mit `never`-Check Zeile 434) und PDF in `packages/pdf/src/serialize.ts` (`serializeBlock`, Zeile 639) plus `PreparedPdfBlock` in `packages/pdf/src/types.ts`. **DX-Vorteil der bestehenden Architektur:** Beide Serializer haben exhaustive Switches — jede neue Block-Variante erzeugt Compile-Fehler an exakt den Stellen, die Rendering brauchen. Kein Host-Code (CLI/Extension) muss angefasst werden, weil alle Hosts nur `storageToBlocks → Engine` durchreichen.

```ts
// export-blocks.ts — neue Varianten
export type CaptionKind = "figure" | "table" | "code" | "equation";
export interface Caption { kind: CaptionKind; content: InlineNode[] }

export type ExportBlock =
  | { type: "heading"; /* wie bisher */ }
  // ... bestehende Varianten, davon erweitert:
  | { type: "codeBlock"; language?: string; code: string; caption?: Caption }
  | { type: "table"; rows: TableRow[]; columnWidths?: number[]; caption?: Caption }
  | { type: "image"; source: ImageSource; alt?: string; width?: number; height?: number; caption?: Caption }
  // neu:
  | { type: "pageBreak" }
  | { type: "orientation"; landscape: boolean; content: ExportBlock[] }
  | { type: "anchor"; name: string }
  | { type: "unknown"; macroName: string };

export interface StorageToBlocksOptions {
  /** Exporter-Identität für scroll-only/scroll-ignore (C4). Default: beides anwenden. */
  exporter?: "pdf" | "word";
}
export function storageToBlocks(storage: string, options?: StorageToBlocksOptions): StorageToBlocksResult;
```

Der zentrale `walkMacro`-Patch (ein Dispatch für C3–C6, C9-Legacy):

```ts
// walkMacro() in export-blocks.ts, vor dem KNOWN_MACROS-Fallback einfügen:
if (macroName === "scroll-pagebreak") return [{ type: "pageBreak" }];

if (macroName === "scroll-landscape" || macroName === "scroll-portrait") {
  const body = childByName(el, "ac:rich-text-body");
  return [{ type: "orientation", landscape: macroName === "scroll-landscape",
             content: body ? walkBlocks(body.children, ctx) : [] }];
}

if (macroName === "scroll-ignore") {           // C4: Inhalt fällt raus
  ctx.notes.push({ level: "info", code: "scroll-ignore-applied",
    message: "Content inside a Scroll Ignore macro was excluded from the export." });
  return [];
}
if (macroName === "scroll-only") {             // C4: Inhalt bleibt drin
  const body = childByName(el, "ac:rich-text-body");
  return body ? walkBlocks(body.children, ctx) : [];
}

if (macroName === "scroll-title") {            // C3: Caption an Nachbarblock heften
  const body = childByName(el, "ac:rich-text-body");
  const inner = body ? walkBlocks(body.children, ctx) : [];
  const caption: Caption = {
    kind: (macroParam(el, "type")?.toLowerCase() as CaptionKind) ?? "figure",
    content: [{ type: "text", text: macroParam(el, "title") ?? "" }],
  };
  return attachCaption(inner, caption, ctx); // erster image/table/codeBlock erhält caption
}

if (macroName === "scroll-bookmark") {         // C7
  return [{ type: "anchor", name: macroParam(el, "name") ?? macroParam(el, "id") ?? "" }];
}
if (macroName === "anchor") {                  // natives Confluence-Anchor-Makro, heute Placeholder!
  const name = macroParam(el, "") ?? macroParam(el, "name") ?? "";
  return name ? [{ type: "anchor", name }] : [];
}
```

Zusätzlich `isInlineMacro()` (Zeile 397) um `scroll-only-inline`/`scroll-ignore-inline` erweitern und in `walkInlineElement` behandeln (ignore-inline → `[]`, only-inline → Inhalt). Die Makro-Namen und Parameter-Keys (`exporter`-Parameter zur Exporter-Selektion!) müssen vor Implementierung mit einem echten Storage-Fixture aus einer Instanz mit Bestandsinhalten (`scroll-*`-Makros) verifiziert werden — verlässliche öffentliche Dokumentation dazu ist schwer zugänglich.

---

### C4 — Scroll Only / Scroll Ignore (Export-Control-Makros)

**(a) Nutzerwert:** Kompatibilitätskritisch: Migrierende Teams haben diese Makros in hunderten Seiten Bestandsinhalt; heute rendert atlcli sie als `[scroll-ignore macro not rendered]` (DOCX, `serialize.ts:432`) bzw. Warnung + Auslassung (PDF, `pdf-unknown-block`). JTBD: "Ich pflege eine Quelle für Web und Print — im Export soll internes Material verschwinden und Print-Only-Material erscheinen", ohne dass der Kunde seine Seiten umbaut.

**(b) Lösungsansatz:** Semantik direkt im Walker (siehe Patch oben) statt in den Engines — die Entscheidung ist Content-, nicht Präsentationssache; Alternative "eigener exportControl-Block, Engines filtern" verworfen, weil beide Engines identischen Filter-Code duplizieren würden und der Block nie gerendert wird. **UX:** Default = Makros greifen (etabliertes Verhalten, das Bestandsinhalte erwarten); jede Anwendung erzeugt eine `info`-Note im Report, damit "warum fehlt Abschnitt X?" nie ein Rätsel ist. Progressive Disclosure: Host-Option `--keep-ignored` (CLI) / Checkbox „Export-Steuermakros ignorieren" (Extension-Panel) für Debugging.

**(c) Umsetzung:** `StorageToBlocksOptions.exporter` in den `WalkCtx` legen; wenn das Makro einen `exporter`-Parameter trägt, nur bei Match anwenden, sonst immer. Hosts: `apps/cli` DOCX-Command und Extension-Panel reichen `{ exporter: "word" }` bzw. `"pdf"` durch. Tests: Roundtrip-Fixtures in `packages/confluence` (Konvention „Confluence features: always test roundtrip").

**(d) Aufwand:** S (Walker + Notes + Tests), keine Engine-Änderung. **(e) Risiken:** Exakte Parameter-Namen/Werte des `exporter`-Selektors unverifiziert; Inline-Varianten-Namen prüfen. Fail-safe-Frage: Bei unbekanntem `exporter`-Wert lieber inkludieren + warnen als still droppen.

### C5 — Scroll Pagebreak

**(a) Nutzerwert:** Manuelle Seitenumbrüche sind das meistgenutzte Print-Steuerelement überhaupt (Kapitel auf neuer Seite, Tabelle nicht zerreißen). JTBD: „Mein exportiertes Dokument soll wie gesetzt aussehen, nicht wie ein Webseiten-Dump."

**(b) Lösungsansatz:** Eigener `pageBreak`-Block (Patch oben) statt Makro-Spezialfall in den Engines — so kann später auch eine Template-Regel („jede H1 auf neue Seite") denselben Block emittieren.

**(c) Umsetzung:**
- **PDF** (`packages/pdf/src/serialize.ts`, neuer `case` in `serializeBlock`): `value = "#pagebreak(weak: true)";` — `weak` verhindert Leerseiten bei Umbruch direkt an einer Seitengrenze. In `prepare.ts` läuft der Block durch den Passthrough-Arm (`case "divider": return block;`-Gruppe). In Tabellenzellen-Kontext (`context.inTable`) unterdrücken + `info`-Note.
- **DOCX** (`packages/docx/src/serialize.ts` + Helper in `ooxml.ts`):
```ts
export function pageBreakParagraph(): string {
  return `<w:p><w:r><w:br w:type="page"/></w:r></w:p>`;
}
```

**(d) Aufwand:** S. **(e) Risiken:** praktisch keine; Verhalten in Tabellenzellen/Callouts definieren (unterdrücken + Note).

### C6 — Scroll Landscape / Scroll Portrait

**(a) Nutzerwert:** Breite Tabellen und Diagramme sind DER Grund für Querformat-Abschnitte in technischen Dokumenten. Heute ist A4-Hochformat in beiden Engines hart verdrahtet (`template.ts:71 set page(paper: "a4", …)`; DOCX erbt die Template-`sectPr`).

**(b) Lösungsansatz:** `orientation`-Regionblock mit Kindern (Patch oben). Alternative „Flag am Einzelblock" verworfen: die Makro-Semantik ist ein Bereich, und OOXML kann Orientierung ohnehin nur pro Section wechseln.

**(c) Umsetzung:**
- **PDF:** neuer `case "orientation"` in `serializeBlock` — Typst-Set-Regeln sind block-scoped, Seitenwechsel an den Grenzen entstehen automatisch:
```typst
#[
  #set page(flipped: true)
  // …serializeBlocks(block.content)…
]
```
Header/Footer aus `atlcli-doc` bleiben aktiv, weil `set page(flipped: true)` die übrigen Seiteneigenschaften nicht zurücksetzt.
- **DOCX:** Section-Sandwich. Die Serializer-Ebene emittiert die Region mit zwei `sectPr`-Absätzen; die Portrait-`sectPr` wird aus der Body-`sectPr` des Templates geklont (Zugriff analog `injectContentTagAtEnd()` in `export.ts:845`, das die Body-`sectPr` bereits lokalisiert — daraus einen Helper `readBodySectPr(zip)` extrahieren und via `SerializeContext` durchreichen):
```xml
<w:p><w:pPr><w:sectPr><!-- Klon der Template-sectPr (Portrait, inkl. headerReference/footerReference) --></w:sectPr></w:pPr></w:p>
<!-- … Landscape-Inhalt … -->
<w:p><w:pPr><w:sectPr>
  <!-- Klon, aber: --> <w:pgSz w:w="16838" w:h="11906" w:orient="landscape"/>
  <w:type w:val="nextPage"/>
</w:sectPr></w:pPr></w:p>
```
(Eine `sectPr` in einem Absatz beendet die davor liegende Section — daher Portrait-Klon VOR der Region, Landscape-Klon danach.)

**(d) Aufwand:** M (DOCX-Seite; `headerReference`/`footerReference`-Klonen ist der Fleißanteil), PDF-Seite S. Abhängig von C5-Infrastruktur (gleiche Block-Pipeline). **(e) Risiken:** Templates ohne Body-`sectPr` (Fallback: Standard-A4-sectPr synthetisieren); Word-Randmaße beim Drehen (w/h tauschen, Margins übernehmen); verschachtelte Orientation-Regionen → äußere gewinnt + Warnung.

### C3 — Captions (Scroll Title)

**(a) Nutzerwert:** „Abbildung 3: Architekturübersicht" ist Grundvokabular formaler Dokumentation und Voraussetzung für C2. JTBD: „Meine Exporte müssen Behörden-/Normanforderungen an nummerierte Abbildungen und Tabellen erfüllen."

**(b) Lösungsansatz:** `caption?: Caption` als Feld auf `image`/`table`/`codeBlock` (statt eigener Wrapper-Block): Serializer behalten ihre Block-Struktur, und die Nummerierung übernimmt das jeweilige Zielformat nativ (Typst-Counter, Word-SEQ) — nie hart einnummerieren, sonst bricht Nachbearbeitung im Word.

**(c) Umsetzung:** `attachCaption()` im Walker (Patch oben) hängt die Caption an den ersten captionfähigen Block im Makro-Body; Fallback: kursiver Absatz + `info`-Note. `PreparedPdfBlock` (`types.ts:36`) erbt das Feld (auch `diagram`).
- **PDF:** die bestehenden `#figure(image(...))`-Aufrufe (`serialize.ts:678,691`) erhalten `caption` und `kind` — damit funktioniert C2 gratis:
```typst
#figure(image("assets/image-1-ab12cd34.png", alt: "…"),
  caption: [#text("Architekturübersicht")], kind: image)
// Tabelle: #figure(table(…), caption: […], kind: table)
// Code:    #figure(raw(…, block: true), caption: […], kind: raw)
```
Achtung Quelltreue-Kommentar in `serialize.ts:675`: kein `placement: auto` setzen, Figuren bleiben im Fluss.
- **DOCX** (neuer Helper in `ooxml.ts`, nach dem Block emittiert):
```xml
<w:p><w:pPr><w:pStyle w:val="Caption"/></w:pPr>
  <w:r><w:t xml:space="preserve">Abbildung </w:t></w:r>
  <w:r><w:fldChar w:fldCharType="begin"/></w:r>
  <w:r><w:instrText xml:space="preserve"> SEQ Abbildung \* ARABIC </w:instrText></w:r>
  <w:r><w:fldChar w:fldCharType="end"/></w:r>
  <w:r><w:t xml:space="preserve">: Architekturübersicht</w:t></w:r>
</w:p>
```
SEQ-Label sprachabhängig (de: „Abbildung/Tabelle", en: „Figure/Table") aus Template-Sprache; `Caption`-Style via `parseStyleNames`-Fallback wie `resolveHeadingStyleId` (`ooxml.ts:46`), sonst Style synthetisieren analog `codeStyleXml()`. `ensureUpdateFields` (`export.ts:908`) existiert schon → Nummern aktualisieren sich beim Öffnen.

**(d) Aufwand:** M. **(e) Risiken:** Genaue `scroll-title`-Storage-Struktur (Body-Wrapping vs. Adjazenz, Parameter-Namen) fixture-verifizieren; Caption-Position (über Tabellen, unter Abbildungen — die etablierte Konvention übernehmen, per Template-Option später konfigurierbar).

### C2 — Table of Tables / Figures / Code / Equations

**(a) Nutzerwert:** Verzeichnisse machen lange Spezifikationen navigierbar; zusammen mit C3 ein billiges Differenzierungs-Duo. JTBD: „Reviewer sollen Tabelle 7 finden, ohne zu blättern."

**(b) Lösungsansatz:** PDF: Typst-`outline` über `figure.where(kind:)` — fällt fast gratis aus C3 heraus. DOCX: keine eigene Verzeichnis-Generierung, sondern Word-native `TOC \c`-Felder — Alternative „Verzeichnis selbst rendern" verworfen (bricht bei jeder Nachbearbeitung).

**(c) Umsetzung:**
- **PDF:** `PdfSerializeOptions` (`types.ts:115`) um `lists?: { tables?: boolean; figures?: boolean; code?: boolean }` erweitern (Default: automatisch AN, wenn ≥2 Captions des Kinds existieren — Zero-Config-UX, im Report benannt). In `atlcli-doc` (`template.ts`, nach `outline(title: contents-label, depth: 3)`):
```typst
#outline(title: if is-german { [Abbildungsverzeichnis] } else { [List of Figures] },
  target: figure.where(kind: image))
#outline(title: if is-german { [Tabellenverzeichnis] } else { [List of Tables] },
  target: figure.where(kind: table))
#outline(title: [Code-Verzeichnis], target: figure.where(kind: raw))
```
- **DOCX:** Neuer Platzhalter `$scroll.figurelist` / `$scroll.tablelist` in der Klassifikation (`packages/docx/src/placeholder-map.ts`); der Preprocessor (`preprocessScrollText`, `export.ts:876`) ersetzt den Platzhalter-Absatz durch ein TOC-Feld statt durch Text:
```xml
<w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r>
  <w:r><w:instrText xml:space="preserve"> TOC \h \z \c "Abbildung" </w:instrText></w:r>
  <w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>…</w:t></w:r>
  <w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>
```
Das `\c`-Argument muss dem SEQ-Label aus C3 entsprechen (eine gemeinsame Konstante `captionSeqLabel(kind, lang)` in `ooxml.ts`). Template-authored „Insert > Table of Figures"-Felder funktionieren automatisch dank `ensureUpdateFields`.

**(d) Aufwand:** PDF S, DOCX M (Platzhalter-Route). Hart abhängig von C3. **(e) Risiken:** `kind: raw`-Outlines listen ALLE Code-Figuren — nur `codeBlock`s mit Caption als `figure` emittieren, caption-lose bleiben `#raw` wie heute; Equations erst relevant, wenn ein Mathe-Block im Modell existiert (heute nicht — als „später" ausweisen).

### C1 — Back-of-Book-Index aus Labels (Slash-Hierarchie)

**(a) Nutzerwert:** Stichwortverzeichnis für Handbuch-artige Exporte; verbreitete Exporter-Workflows bauen es aus Seiten-Labels (`begriff/unterbegriff/unterunterbegriff`). JTBD: „Print-Leser schlagen nach, statt zu suchen." Ehrliche Einordnung: Bei Single-Page-Export (heutiger Scope!) zeigt jeder Term auf dieselbe Startseite — echter Wert entsteht erst mit Tree-Export (A1/A4, Cluster A).

**(b) Lösungsansatz:** Labels sind bereits im Modell (`ConfluencePageDetails.labels?: string[]`, `client.ts:34`, expandiert via `getPageDetails` → `metadata.labels`, `client.ts:550`). Pro exportierter Seite wird ein unsichtbarer Marker an den Seitenanfang emittiert; das Verzeichnis löst Seitenzahlen zur Renderzeit auf. Alternative „Typst-Universe-Indexpaket" verworfen: die Package-Registry bleibt bei uns bewusst deaktiviert (Entscheidung: keine Remote-Pakete), also selbst implementieren (~30 Zeilen Typst).

**(c) Umsetzung:** Parser `parseIndexTerms(labels: string[]): string[][]` (Slash-Split, in `packages/confluence`) + neuer Block `{ type: "indexMarker"; terms: string[][] }`, den der Orchestrator (nicht der Walker — Labels sind Seitenmetadaten) vor die Seitenblöcke setzt.
- **PDF:** Marker: `#metadata(("Installation", "Linux")) <atlcli-idx>`; Indexsektion in `atlcli-doc` (Option `index: true`):
```typst
#context {
  let entries = query(<atlcli-idx>).map(e => (terms: e.value, page: e.location().page()))
  // gruppieren nach terms.at(0) → sortieren → primär fett, sekundär eingerückt,
  // Seitenzahlen dedupliziert mit ", " joinen; link((page: p, x: 0pt, y: 0pt))[#str(p)]
}
```
- **DOCX:** XE-Felder am Seitenanfang (Word-Syntax: Doppelpunkt trennt Ebenen) + `INDEX`-Feld hinter neuem Platzhalter `$scroll.index` (gleiche Route wie C2):
```xml
<w:r><w:fldChar w:fldCharType="begin"/></w:r>
<w:r><w:instrText xml:space="preserve"> XE "Installation:Linux" </w:instrText></w:r>
<w:r><w:fldChar w:fldCharType="end"/></w:r>
<!-- Verzeichnis: --> <w:instrText xml:space="preserve"> INDEX \c "2" \h "A" </w:instrText>
```
**UX:** Nur Labels mit einem konfigurierbaren Präfix (z. B. `idx-` oder alle mit `/`) werden Indexterme — sonst landen Prozess-Labels („draft", „reviewed") im Verzeichnis; Preflight-Report listet erkannte Terme.

**(d) Aufwand:** L (inkl. Sortierung/Locale, Gruppierung, Tests); sinnvoll erst nach/mit Tree-Export A1. **(e) Risiken:** Kollation (de: ä=a?) — v1: einfacher `localeCompare` mit Dokumentsprache; Kompatibilität der Label-Syntax mit Bestandsinhalten fixture-prüfen.

### C7 — Named Destinations / Bookmarks

**(a) Nutzerwert:** Deep-Links in exportierte Dokumente (`file.pdf#nameddest=api-auth`, Word-Querverweise). Bonus: Das native Confluence-`anchor`-Makro ist heute ebenfalls nur Placeholder — der `anchor`-Block heilt beides, und interne `LinkTarget.kind === "anchor"`-Links (heute PDF: nur Heading-Labels via `collectHeadingLabels`, `serialize.ts:488`; DOCX: gar nicht, `serialize.ts:166` rendert nur Styling) werden endlich klickbar.

**(b) Lösungsansatz:** `anchor`-Block (Patch oben); Auflösung im jeweiligen Zielformat nativ.

**(c) Umsetzung:**
- **PDF:** `case "anchor": value = `#[]#label("${typstLabel(block.name)}")`;` und `resolveLink` (`serialize.ts:227`) erweitert die `labels`-Map um Anchor-Blöcke (Sammel-Pass analog `collectHeadingLabels`). Echte PDF-*Named Destinations* emittiert Typst derzeit nicht — Stufe 2: Post-Processing im `PdfOutputSink`-Pfad (`/Names`-Dictionary aus dem SourceMap-Wissen injizieren) oder Upstream-Feature abwarten; interne Links + Outline decken 90 % des Nutzens sofort.
- **DOCX** (`ooxml.ts`-Helper, `id` dokumentweit eindeutig hochzählen via `SerializeContext`):
```xml
<w:bookmarkStart w:id="42" w:name="api-auth"/><w:bookmarkEnd w:id="42"/>
<!-- interner Link (serializeInline, target.kind === "anchor"): -->
<w:instrText xml:space="preserve"> HYPERLINK \l "api-auth" </w:instrText>
```
`hyperlinkField` (`ooxml.ts:166`) um eine `\l`-Variante ergänzen; `escapeFieldArgument` existiert bereits gegen Feld-Injection. Bookmark-Namen nach Word-Regeln normalisieren (≤40 Zeichen, Buchstabe am Anfang, `\W`→`_`) — eine gemeinsame `bookmarkName()`-Funktion, getestet.

**(d) Aufwand:** M (S ohne PDF-Named-Dest-Postprocessing). **(e) Risiken:** Typst-Named-Destinations offen (Upstream-Issue tracken); Kollision Anchor-Name ↔ Heading-Label deterministisch auflösen (Anchor gewinnt, Note).

### C8 — Status-Makro-Styling

**(a) Nutzerwert:** Status-Lozenges rendern bereits gut (PDF `status-badge`, `template.ts:202`; DOCX `statusBadgeRun`, `ooxml.ts:261`), aber Corporate-Design-Teams wollen Schrift/Größe/Radius/Farbabbildung steuern. JTBD: „Der Export soll aussehen wie unser CI, nicht wie Confluence."

**(b) Lösungsansatz:** Kein neues Modell — reines Theme-Thema. `PdfThemeOptions` (`types.ts:79`) erhält `status?: { font?: string; size?: string; weight?: string; radius?: string; uppercase?: boolean; palette?: Record<string,string> }`; `resolvePdfTheme` füllt Defaults (heutige Werte). Passt exakt in das geplante Level-A-Settings-Formular (TEMPLATE-UX) — shape-agnostisch, da Theme bereits durch `PdfSerializeOptions` aller Hosts fließt.

**(c) Umsetzung:** `createAtlcliTypstTemplate` interpoliert die Werte in `status-badge`/`dense-status-badge`:
```typst
#let status-badge(label, color: "#42526E", inset-x: 5pt) = box(
  fill: rgb(color).lighten(82%), inset: (x: inset-x, y: 2pt), radius: ${theme.status.radius},
  text(font: "${theme.status.font}", size: ${theme.status.size}, weight: "${theme.status.weight}",
       fill: rgb(color), label))
```
Die Farb-Map `CONFLUENCE_STATUS_COLORS` (`serialize.ts:263`) wird durch `theme.status.palette ?? Default` ersetzt (Merge, nicht Replace). DOCX analog: `statusBadgeRun` bekommt optionalen `StatusStyle`-Parameter aus einer künftigen DOCX-Theme-Option; kurzfristig reicht die PDF-Seite (auch etablierte Exporter bieten das nur im PDF-Template).

**(d) Aufwand:** S. **(e) Risiken:** Nur Kontrast — Werte durch die bestehende `pdfColorContrast`-Warnlogik (`noteLowCellContrast`-Muster) prüfen, damit ein Theme keine unlesbaren Status-Lozenges erzeugt.

### C9 — Seitentitel-Override für Exporte

**(a) Nutzerwert:** Confluence-Titel sind oft technisch („[WIP] v2 API Doku (neu)"), das Dokument braucht einen Publikationstitel — er steuert Cover (`template.ts:123 #meta.title`), Kopfzeile (`template.ts:79`), Dateiname (`toDownloadFilename`, `export.ts:187`) und `$scroll.title`-Platzhalter (Resolver).

**(b) Lösungsansatz:** Vier Quellen, klare Präzedenz: (1) expliziter Host-Override (CLI `--title`, Panel-Feld) > (2) Content-Property `atlcli.export.title` (persistente Seiteneinstellung, im Host-Panel les- und schreibbar) > (3) Legacy-Makro `scroll-pagetitle` im Body (nur Erkennung + Übernahme, Makro selbst wird nicht gerendert) > (4) Seitentitel. Alternative „nur CLI-Flag" verworfen: der Override gehört zur Seite, nicht zum Aufruf.

**(c) Umsetzung:** Engines sind fast fertig — beide nehmen den Titel als Input (`PdfExportMetadata.title`; DOCX `input.details.title`). Kern ist ein kleiner shared Helper in `packages/confluence`:
```ts
export function resolveExportTitle(details: ConfluencePageDetails, explicit?: string): 
  { title: string; source: "explicit" | "property" | "macro" | "page" }
```
Der Walker liefert dafür ein `scroll-pagetitle`-Erkennungsergebnis (Makro → `[]` + Note `scroll-pagetitle-applied`, Titel via neuem Feld auf `StorageToBlocksResult`, z. B. `titleOverride?: string`). Hosts rufen den Helper vor `exportDocx`/`serializePdfDocument` und setzen `details.title`/`metadata.title`. **UX:** Report-Note nennt Quelle des Titels („Titel aus Seiteneigenschaft überschrieben") — keine stille Magie; Dateiname folgt dem Override.

**(d) Aufwand:** S. **(e) Risiken:** Property-Key-Namensraum einmal festlegen (konsistent mit dem geplanten Space-Property-Index); `scroll-pagetitle`-Makroname/Parameter fixture-verifizieren; Verhalten bei Tree-Export (Override gilt pro Seite → Kapiteltitel) jetzt schon mitdenken.

---

**Empfohlene Reihenfolge:** C4+C5 (S, kompatibilitätskritisch) → C3 → C2 (Differenzierer) → C6, C7, C8, C9 → C1 (nach Tree-Export). Querschnitt: jedes Feature erzeugt Report-Notes (bestehendes `ExportNote`-Muster) und Roundtrip-/Golden-Tests (`golden.test.ts`, `serialize.test.ts` beider Engines); erster Schritt vor allem Code: ein Storage-Fixture-Satz echter `scroll-*`-Makros aus einer Testinstanz mit Bestandsinhalten.

## 4. Cluster D — Platzhalter

Kontext: Das DOCX-Platzhaltersystem lebt in `packages/docx/src/placeholder-map.ts` (Klassifikation `supported | unsupported | never`, `classifyPlaceholder()`) und `packages/docx/src/resolver.ts` (`resolvePlaceholders()`, lazy `ResolveDeps`). Die PDF-Seite (`packages/pdf/src/template.ts`, `serialize.ts:844ff`) hat heute **kein** nutzerseitiges Platzhaltersystem — `meta` ist fix verdrahtet. Leitidee aller Vorschläge: **eine gemeinsame Platzhalter-Grammatik** (`$scroll.*`) für DOCX und PDF, resolved in TS vor der Engine, plus wenige layout-zeitliche Tokens, die nur Typst kennt.

### D1 — `$scroll.includepage.(page)`

**(a) Erläuterung & Nutzerwert.** Templates nach den etablierten `$scroll.*`-Konventionen können an beliebiger Stelle den Inhalt einer *anderen* Seite einbetten (Deckblatt-Disclaimer, Firmen-Impressum, Standard-Anhang). JTBD: "Ich pflege rechtliche/organisatorische Standardtexte einmal zentral in Confluence und jeder Export zieht sie automatisch." Heute klassifizieren wir das Prefix als `unsupported` (`UNSUPPORTED_PREFIXES` in `placeholder-map.ts:220`) → leer + Report. Für migrierende Teams mit Bestandsinhalten ein sichtbares Loch im ⚠-Scan.

**(b) Lösungsansatz.** Includepage ist **kein Text-Platzhalter**, sondern — wie das Logo (`startLogoPass`/`finishLogoPass` in `export.ts`) und `$scroll.content` (`CONTENT_TAG_PARA`, `injectContentTag`) — ein **Dokument-Pass**: Absatz mit dem Token wird durch einen eigenen docxtemplater-rawxml-Tag ersetzt, dessen Wert der via `storageToBlocks` + `serializeBlocks` gerenderte Fremdseiten-Body ist. Verworfen: (1) Auflösung im Text-Resolver (der liefert Strings, kein OOXML); (2) clientseitiges Storage-Splicing in `details.storage` (verwischt Asset-Ownership: Bilder der inkludierten Seite brauchen deren `pageId` im `imageSeam`).

**(c) Technische Umsetzung.**
- `placeholder-map.ts`: Prefix aus `UNSUPPORTED_PREFIXES` entfernen; neue Klassifikation `{ status: "supported", dependency: "includePage" }` + `parseIncludePageArgs(raw)` analog `parsePagePropertyArgs`: `(Title)`, `(SPACE:Title)`, `(pageId)` (numerisch).
- `resolver.ts` → `ResolveDeps` erweitern (Host-Seam, shape-agnostisch — CLI und Extension liefern je ihre Implementierung, weitere Hosts analog):

```ts
export interface IncludePageRef { spaceKey?: string; title?: string; pageId?: string }
export interface ResolveDeps {
  // …bestehende Fetcher…
  /** Storage + Identität einer per $scroll.includepage referenzierten Seite. */
  getIncludedPage?: (ref: IncludePageRef) => Promise<ConfluencePageDetails | null>;
}
```

- Host-Wiring: `ConfluenceClient.getPage(id)` (client.ts:510, liefert `storage`) für die Id-Form; Titel-Form über `ConfluenceClient.search()` (client.ts:636, CQL `space = "KEY" and title = "…"`).
- Neuer Pass in `exportDocx` (`packages/docx/src/export.ts`), zwischen Schritt 3b (Logo) und 4 (`preprocessScrollText`), damit ein fehlgeschlagener Include dort garantiert geblankt wird (Never-a-literal-Invariante bleibt):

```ts
const includeTagPara = (i: number) =>
  `<w:p><w:r><w:t xml:space="preserve">${DELIM_START}@scrollInclude${i}${DELIM_END}</w:t></w:r></w:p>`;

async function runIncludePass(zip: Zip, deps: ResolveDeps, seams: BodySeams, notes: ExportNote[]) {
  const occurrences = findIncludeParagraphs(zip); // reuse Absatz-Scan des Logo-Passes
  const rendered = new Map<string, string>();     // rawxml-Key → OOXML
  const visited = new Set<string>();              // Zyklenschutz (pageId)
  for (const [i, occ] of occurrences.entries()) {
    const page = await deps.getIncludedPage?.(parseIncludePageArgs(occ.raw));
    if (!page) { notes.push({ level: "warning", code: "includepage-unresolved",
      message: `${occ.raw}: Seite nicht gefunden oder keine Leseberechtigung; leer gerendert.` }); continue; }
    if (visited.has(page.id)) { notes.push({ level: "warning", code: "includepage-cycle",
      message: `${occ.raw}: zyklischer Include auf "${page.title}" übersprungen.` }); continue; }
    visited.add(page.id);
    const { blocks, notes: walk } = storageToBlocks(page.storage ?? "");
    notes.push(...walk);
    // eigener imageSeam mit page.id, damit Attachments der Fremdseite korrekt geladen werden
    rendered.set(`scrollInclude${i}`, await serializeBlocks(blocks, seams.forPage(page.id)));
    swapParagraph(zip, occ, includeTagPara(i));
  }
  return rendered; // fließt zusätzlich in die docxtemplater-Datenmap neben CONTENT_KEY
}
```

- **UX**: Scan-Panel zeigt Include-Ziele vorab (✓ auflösbar / ⚠ nicht gefunden — der Scan darf dafür `getIncludedPage` proben); Berechtigungsfehler (403/404 sind auf Cloud ununterscheidbar) bekommen bewusst **eine** ehrliche Meldung "nicht gefunden *oder* keine Berechtigung" statt einer falschen Präzision. **DX**: Der Pass ist wie der Logo-Pass pur testbar (Zip rein, Notes raus), `getIncludedPage` mockbar; Regressionstest: Include-Token darf nie als Literal überleben.

**(d) Aufwand:** M (2–4 Tage inkl. Tests/E2E). Abhängigkeiten: keine neuen — nutzt vorhandene Seams. **(e) Risiken:** Heading-Kollision (inkludierte H1 landet im Dokumentfluss — v1: unverändert übernehmen, Note ausgeben; Heading-Offset später); Titel-Referenzen sind nicht eindeutig (CQL kann >1 Treffer liefern → Note + erster Treffer, deterministisch sortiert). PDF-Seite: Grammatik reservieren, Umsetzung erst mit D4-Templatesystem.

### D2 — `$scroll.metadata.(key)` Reklassifikation

**(a) Erläuterung & Nutzerwert.** Heute klassifiziert `NEVER_PREFIXES` (`placeholder-map.ts:240`) das Prefix als `never` mit Begründung "Comala Metadata app — third-party". Die öffentlich zugängliche Dokumentation der etablierten `$scroll.*`-Konventionen listet den Platzhalter aber **ohne** Comala-DC-Vorbehalt — unsere ✗-Anzeige ("hängt von App ab, die wir nie unterstützen") ist damit möglicherweise faktisch falsch und wirkt im Scan-Panel unnötig endgültig.

**(b) Lösungsansatz.** Zweistufig: (1) **Sofort** ehrlich reklassifizieren `never` → `unsupported` mit neuem Reason-Text — das ist eine reine Datenänderung und korrigiert die UX-Aussage von "nie" zu "noch nicht/ungeklärt". (2) **Brücke** für den häufigsten realen Bedarf: konfigurierbares Alias-Mapping `$scroll.metadata.(key)` → Content-Property/Page-Property, weil Cloud-Metadata-Apps (inkl. Comala Cloud) ihre Werte praktisch immer in Content Properties ablegen. Verworfen: direkte Comala-REST-Integration (App-spezifische, unstabile API; bindet uns an einen Dritt-Vendor).

**(c) Technische Umsetzung.** In `placeholder-map.ts`:

```ts
const UNSUPPORTED_PREFIXES: { prefix: string; reason: string }[] = [
  // …
  { prefix: "$scroll.metadata",
    reason: "metadata values live in a third-party app; map the key to a content property in the export settings to resolve it" },
];
```

Alias-Auflösung im Resolver: neuer `ResolveDeps.getContentProperty?: (pageId: string, key: string) => Promise<string | null>` (siehe D4 — dieselbe Client-Methode). Mapping-Quelle: Export-Settings des Hosts (Extension: Panel-Settings; CLI: `~/.atlcli/config.json`; weitere Hosts z. B. via Space-Property `atlcli-export:placeholder-aliases`). **UX**: Scan-Zeile zeigt bei gesetztem Alias ✓ "via content property ‹x›", sonst ⚠ mit Ein-Klick-Link "Alias anlegen" (Progressive Disclosure statt Konfigurationszwang). **DX**: Aliase sind reine Daten → tabellengetriebener Test in `placeholder-map.test.ts`/`resolver.test.ts`.

**(d) Aufwand:** S für die Reklassifikation (Stunden, inkl. Testupdate), M für das Alias-Mapping. Abhängigkeit: `getContentProperty` aus D4. **(e) Risiken/Offene Fragen:** Woher Cloud-Instanzen mit Bestandsinhalten die Werte tatsächlich beziehen, ist öffentlich nicht verlässlich dokumentiert — vor Kompatibilitätszusagen („Comala-kompatibel") ein Real-Instanz-Test nötig; Property-Werte können JSON sein → v1 nur String-Werte, sonst Note (konsistent mit dem offenen `$scroll.jsoncontentproperty`-Thema).

### D3 — `$scroll.custom.*`: bewusst skippen

**(a/b) Erläuterung & Entscheidung.** `$scroll.custom.*` transportiert Dokumenttitel- und Versions-Metadaten einer Dritt-App für Dokumentversionierung. Empfehlung: **bewusst nicht unterstützen**, Klassifikation `never` behalten. Begründung: (1) Die Daten liegen im App-Storage dieser Versionierungs-App; ohne die App und ohne dokumentierte öffentliche API gibt es nichts Belastbares zu lesen. (2) Unsere Zielgruppe für die D-Pakete sind Teams, die Bestandsinhalte mit `$scroll.*`-Platzhaltern migrieren; wer die Versionierungs-App weiter betreibt, nutzt fast sicher auch deren gebündelten Exporter — der adressierbare Nutzen ist minimal. (3) Jede Teil-Lösung würde eine mögliche spätere Versionierungs-Integration (F1) präjudizieren — das ist eine Produktentscheidung, kein Platzhalter-Feature.

**(c) Technische Umsetzung (nur Hygiene).** Reason-Text in `NEVER_PREFIXES` präzisieren: `"third-party document-versioning app — not integrated; document versions/variants are out of scope"` — der Text erscheint verbatim im Scan-Panel und im Report, Nutzer verstehen sofort *warum* ✗. Die Never-a-literal-Invariante blankt das Token weiterhin (Pinning-Test existiert).

**(d) Aufwand:** S (Textänderung). **(e) Revisit-Trigger:** Falls F1 priorisiert wird oder Nutzer wiederholt danach fragen — dann als Teil einer echten Versionierungs-Integration, nicht als Einzelplatzhalter.

### D4 — PDF-Platzhaltersystem (Chapter Heading, Content Property, Content Status, Datum)

**(a) Erläuterung & Nutzerwert.** Die etablierten PDF-Template-Konventionen erlauben Platzhalter in Kopf-/Fußzeilen und Deckblatt: laufende Kapitelüberschrift, Content Properties der Root-Seite, Content Status (Cloud), formatierte Daten. Unser Typst-Template (`createAtlcliTypstTemplate`, `template.ts:70–89`) rendert Header/Footer fix (`meta.title` / `meta.space` / Seitenzahl). JTBD: "Mein PDF-Header soll Dokumentnummer, Freigabestatus und aktuelles Kapitel zeigen — ohne dass ich Typst lerne." Das ist zugleich das Fundament für TEMPLATE-UX Level A (manifest-getriebene Settings-Formulare).

**(b) Lösungsansatz.** **Eine Grammatik, zwei Auflösungszeitpunkte**: (1) Alles, was vor dem Kompilieren bekannt ist (`$scroll.title`, `$scroll.pageproperty.(…)`, `$scroll.contentproperty.(…)`, `$scroll.contentstatus`, `$scroll.exportdate.("dd.MM.yyyy")`), wird vom **geteilten TS-Resolver** zu Strings aufgelöst und via `typstString()` (escape.ts) als Literal in die Typst-Quelle geschrieben. (2) Layout-zeitliche Tokens, die nur der Setzer kennt (`$scroll.chapterheading`, `$scroll.pagenumber`, `$scroll.totalpages`), mappen auf **Typst-Funktionsaufrufe**. Verworfen: Platzhalter-Ersetzung *in* Typst per String-Replace (Injection-Risiko, bricht die escape.ts-Invariante "user text only as string literals"); separates PDF-Vokabular (DX-Sünde — zwei Grammatiken für dieselben Nutzer).

**(c) Technische Umsetzung.**
1. **Resolver teilen**: `placeholder-map.ts`, `resolver.ts`, `dateformat.ts` aus `packages/docx` in ein neues Paket `packages/export-placeholders` (`@atlcli/export-placeholders`) extrahieren; `@atlcli/docx` re-exportiert (keine Breaking Changes), `@atlcli/pdf` konsumiert es neu. Beide Engines bleiben shape-agnostisch: die `ResolveDeps` bleiben das einzige IO-Seam.
2. **Schema** in `packages/pdf/src/types.ts`:

```ts
export interface PdfSlotTemplate { left?: string; center?: string; right?: string } // Platzhalter-Grammatik
export interface PdfTemplateSettings {
  header?: PdfSlotTemplate;   // Default: { left: "$scroll.title", right: "$scroll.space.name" }
  footer?: PdfSlotTemplate;   // Default: { center: "$scroll.pagenumber" }
}
export interface PdfSerializeOptions {
  metadata: PdfExportMetadata; profile?: PdfProfile; theme?: PdfThemeOptions;
  settings?: PdfTemplateSettings;   // NEU — optional, Defaults = heutiges Verhalten
}
```

3. **Slot-Kompilierung** in `serialize.ts` (bei der `meta`-Emission, heute Zeile 844ff): Slot-String tokenisieren; `$scroll.*`-Tokens gegen die vorab (im Host, via `resolvePlaceholders`) berechnete `Map<string,string>` ersetzen → `typstString(...)`-Literale; Layout-Tokens → Funktionsaufrufe. Ergebnis ist ein Typst-Ausdruck, nie roher Nutzertext.
4. **Typst: Chapter Heading** (neu in `template.ts`; kompilierbares Muster):

```typst
// Laufende Kapitelüberschrift: die auf dieser Seite beginnende H1 gewinnt,
// sonst die letzte H1 davor (etablierte "Chapter Heading"-Semantik).
#let atlcli-chapter-heading(level: 1) = context {
  let here-page = here().page()
  let on-page = query(heading.where(level: level))
    .filter(h => h.location().page() == here-page)
  if on-page.len() > 0 { on-page.first().body }
  else {
    let before = query(selector(heading.where(level: level)).before(here()))
    if before.len() > 0 { before.last().body } else { none }
  }
}
// Header-Slot-Beispiel, wie der Serializer ihn emittiert für
// header.left = "$scroll.chapterheading" / header.right = "Doc-Nr. QM-004 · $scroll.contentstatus":
header: context {
  set text(font: "Source Sans 3", size: 8pt, fill: rgb("#6B778C"))
  grid(columns: (1fr, auto), atlcli-chapter-heading(), [Doc-Nr. QM-004 · Freigegeben])
  line(length: 100%, stroke: rgb("#DFE1E6"))
},
```

5. **Neue Client-Methoden** in `packages/confluence/src/client.ts` (heute existiert nur der interne `/content/{id}/property/editor`-Zugriff, Zeile 2950 — keine generische Property-API; `requestV2` existiert bereits, Zeile 376):

```ts
/** GET /api/v2/pages/{id}/properties?key=… — erster Treffer oder null. */
async getContentProperty(pageId: string, key: string): Promise<string | null> {
  const data = (await this.requestV2(`/pages/${pageId}/properties`, { query: { key } })) as any;
  const value = data?.results?.[0]?.value;
  return typeof value === "string" ? value : value != null ? JSON.stringify(value) : null;
}
/** GET /content/{id}/state?status=current — Content-Status-Name (Cloud) oder null. */
async getContentState(pageId: string): Promise<string | null> {
  const data = (await this.request(`/content/${pageId}/state`, { query: { status: "current" } })) as any;
  return data?.contentState?.name ?? null;
}
```

Dazu zwei neue `ResolveDeps`-Fetcher (`getContentProperty`, `getContentState`) und zwei neue `supported`-Einträge (`$scroll.contentproperty` mit Arg-Parser analog `parsePagePropertyArgs`, `$scroll.contentstatus`) — DOCX bekommt sie **gratis** mit, weil Klassifikation+Resolver geteilt sind. Datum: `$scroll.exportdate.("…")` läuft unverändert über `formatDatePlaceholder` (`dateformat.ts`, SimpleDateFormat inkl. Quartale) — auch im PDF-Slot.

**UX**: Settings-Formular (TEMPLATE-UX Level A) zeigt drei Textfelder pro Header/Footer mit Platzhalter-Autocomplete aus `classifyPlaceholder`-Vokabular; unbekannte Tokens werden wie im DOCX geblankt + Report-Note (nie Literal im PDF). **DX**: Ein dokumentiertes Grammatik-Kontrakt (`docs/reference/placeholders.md`): eine Tabelle, zwei Spalten "DOCX" / "PDF", identische Basen; Golden-Test rendert einen Slot-String durch beide Engines.

**(d) Aufwand:** L gesamt; sinnvoll geschnitten: Paket-Extraktion S, Client-Methoden S, Slot-System + Typst M, Settings-UI (Extension) M. Abhängigkeiten: TEMPLATE-UX-Level-A-Manifest, spec 010 Phase 2. **(e) Risiken:** `query()`-basierte Header sind in Typst kontextabhängig — Interaktion mit `outline()`/Deckblatt testen (Header greift erst ab Seite 2, wie heute in `template.ts:77`); Content-State-v1-Endpoint ist auf manchen Sites deaktiviert (Feature-Flag) → Fetch-Fehler muss wie `space-fetch-failed` als Note degradieren; JSON-Properties nur als String-Dump (Note ausgeben).

### D5 — Fehler-Notification-Toggle

**(a) Erläuterung & Nutzerwert.** Verbreitete Exporter bieten eine Option, Platzhalter-Fehlermeldungen zu unterdrücken. Unser Modell ist besser (leer rendern + strukturierter Report statt Fehler-Popup), aber es gibt **keinen Nutzer-Hebel**: Wer ein bewusst "überinstrumentiertes" Template fährt (viele DC-Altplatzhalter), sieht bei jedem Export dieselben ⚠/ℹ-Zeilen — Alarmmüdigkeit, echte Warnungen gehen unter. JTBD: "Zeig mir nur, was ich noch nicht weiß."

**(b) Lösungsansatz.** **Engine unverändert lassen** — `ExportNote[]` wird immer vollständig produziert (Testbarkeit, Auditierbarkeit, CLI-`--json`). Der Toggle ist reine **Präsentationsschicht**: (1) globaler Schwellwert `reportLevel: "all" | "warnings" | "none"` und (2) per-Code-Mute ("diese Meldung nicht mehr zeigen") auf Basis der bereits stabilen `code`-Felder (`placeholder-unsupported`, `placeholder-empty`, `placeholder-substituted`, `includepage-unresolved`, …). Verworfen: Notes in der Engine unterdrücken (zerstört Report-Vollständigkeit und CLI/CI-Nutzung); ein grobes Alles-oder-nichts-Toggle (differenziert nicht nach Meldungstyp).

**(c) Technische Umsetzung.** Kein Engine-Code: Filterfunktion als pure Utility, z. B. in `@atlcli/export-placeholders`:

```ts
export interface NoteFilterPrefs { reportLevel: "all" | "warnings" | "none"; mutedCodes: string[] }
export function filterNotes(notes: ExportNote[], prefs: NoteFilterPrefs): ExportNote[] {
  if (prefs.reportLevel === "none") return notes.filter((n) => n.level === "error");
  return notes.filter((n) =>
    !prefs.mutedCodes.includes(n.code) &&
    (prefs.reportLevel === "all" || n.level !== "info"));
}
```

Konsumenten: Extension-Report-Views (`apps/extension/entrypoints/sidepanel/PdfSection.tsx`, DOCX-Report-View — Tests existieren in `apps/extension/tests/{pdf,docx}/report-view.test.tsx`), weitere Host-Panels identisch, CLI via `--quiet-report` Flag; Persistenz je Host (Extension-Storage / Space-Property / `~/.atlcli/config.json`). **UX**: Default bleibt "alles zeigen, Info-Zeilen eingeklappt" (Progressive Disclosure); Mute pro Zeile über ein "×"-Affordance mit Undo; ein permanenter Zähler "n Meldungen ausgeblendet" verhindert stilles Wegfiltern — Fehler (`level: "error"`) sind **nie** mutbar. **DX**: `filterNotes` ist pur und tabellengetrieben testbar; die `code`-Strings werden damit öffentlicher Vertrag → einmalig in `docs/reference/export-report-codes.md` dokumentieren.

**(d) Aufwand:** S (1–2 Tage inkl. UI + Tests). Abhängigkeiten: keine. **(e) Risiken:** gering; einzige Designfrage ist die Persistenz-Ebene (User- vs. Space-scoped — Empfehlung: User-scoped, weil Alarmtoleranz individuell ist).

### Querschnitt: gemeinsame Platzhalter-Grammatik (DX-Fundament für D1–D4)

Ein Dokument, ein Vokabular: `$scroll.<base>[.(args)]` — Basen und Klassifikation kommen aus **einer** Quelle (`classifyPlaceholder`), Argument-Parser (`parsePagePropertyArgs`, `parseLogoArgs`, neu `parseIncludePageArgs`, `parseContentPropertyArgs`) liegen daneben. DOCX konsumiert sie im Template-Text (docxtemplater-Preprocessing), PDF in Settings-Slots (Typst-Emission). Neue Platzhalter werden genau einmal implementiert und erscheinen in beiden Engines, im Scan-Panel und in der Doku-Referenz (Doku gemäß CLAUDE.md-Standard: Referenztabelle mit Typ/Default/Constraints + Minimal- und Praxisbeispiel). Das ist ein struktureller Vorteil gegenüber Werkzeuglandschaften, in denen Word- und PDF-Exporter getrennte Platzhalter-Doks pflegen — für uns ein echtes DX/Doku-Verkaufsargument.

**Relevante Dateien:** `/home/user/atlcli/packages/docx/src/placeholder-map.ts`, `/home/user/atlcli/packages/docx/src/resolver.ts`, `/home/user/atlcli/packages/docx/src/export.ts`, `/home/user/atlcli/packages/docx/src/env.ts`, `/home/user/atlcli/packages/pdf/src/template.ts`, `/home/user/atlcli/packages/pdf/src/serialize.ts`, `/home/user/atlcli/packages/pdf/src/types.ts`, `/home/user/atlcli/packages/pdf/src/run-export.ts`, `/home/user/atlcli/packages/confluence/src/client.ts`, `/home/user/atlcli/packages/confluence/src/export-blocks.ts`.

## 5. Cluster E — Makro-Rendering (E1–E5)

### Gemeinsame Architektur: `MacroRendererRegistry` als Port + gestufte Fallback-Kette

Heute endet jedes nicht nativ konvertierte Makro in `walkMacro` (`packages/confluence/src/export-blocks.ts:667`) als `{ type: "unknown", macroName }` — **Parameter und Body werden weggeworfen** (Z. 709). DOCX rendert daraus einen grauen Platzhalter (`packages/docx/src/serialize.ts:431`), PDF lässt das Makro mit Warning weg (`packages/pdf/src/serialize.ts:796`). Damit ist jede Renderer-Strategie strukturell unmöglich. Zwei Bausteine beheben das shape-agnostisch:

**1. Verlustfreier Makro-Block (Prerequisite, S):** `UnknownBlock` wird abwärtskompatibel angereichert — bestehende Serializer/Tests bleiben gültig, da nur optionale Felder hinzukommen:

```ts
// packages/confluence/src/export-blocks.ts
| { type: "unknown"; macroName: string;
    params?: Record<string, string>;          // alle <ac:parameter>
    body?: ExportBlock[];                     // ac:rich-text-body, rekursiv gewalkt
    plainBody?: string;                       // ac:plain-text-body
    macroId?: string }                        // ac:macro-id (für REST-Makro-Rendering)
```

*Superseded: the implemented model uses an ordered `MacroParameter[]`
(named/unnamed params with `ri:*` refs) — see
001-exportblock-model/PLAN.md and 004-macro-renderer/PLAN.md.*

**2. Async-Resolver-Pass zwischen `storageToBlocks` und Engine** (neues Paket `packages/export-macros`, nur Typ-Dependency auf `@atlcli/confluence`):

```ts
export interface MacroInstance { name: string; params: Record<string, string>;
  body?: ExportBlock[]; plainBody?: string; macroId?: string }
export type MacroRenderResult =
  | { kind: "blocks"; blocks: ExportBlock[]; notes?: ExportNote[] }
  | { kind: "skip" };                          // → nächste Stufe der Kette
export interface MacroRenderer {
  readonly macros: readonly string[];          // ac:name-Werte, lowercase
  render(m: MacroInstance, ctx: MacroExportContext): Promise<MacroRenderResult>;
}
export interface MacroExportContext {
  page: { id: string; spaceKey?: string };
  confluence?: ConfluenceContentPort;  // getPageStorage(title,space), getChildren(id), searchCql(cql)
  jira?: JiraIssuePort;                // getIssue(key), searchJql(jql, opts)   (E2)
  exportView?: ExportViewPort;         // renderMacroHtml(pageId, macroId)      (Stufe 3/4)
  depth: number; visited: Set<string>; // Include-Rekursionsschutz (E4/E5)
  signal?: AbortSignal;
}
export async function resolveMacroBlocks(blocks: ExportBlock[],
  registry: MacroRenderer[], ctx: MacroExportContext): Promise<{ blocks: ExportBlock[]; notes: ExportNote[] }>
```

*Superseded: the implemented model uses an ordered `MacroParameter[]`
(named/unnamed params with `ri:*` refs) — see
001-exportblock-model/PLAN.md and 004-macro-renderer/PLAN.md.*

`resolveMacroBlocks` traversiert auch verschachtelte Container (table/callout/list/blockquote — gleiche Walk-Struktur wie `countPrepared` in `packages/pdf/src/run-export.ts:74`). Einhängung: als optionales Feld `macros?` in `ExportEnv` (`packages/docx/src/env.ts:59`), angewandt in `exportDocx` direkt nach `storageToBlocks` (`packages/docx/src/export.ts:235`), und in `PdfExportEnv` (`packages/pdf/src/run-export.ts:33`), angewandt in der `preparing`-Phase vor `preparePdfDocument`. Ports statt Clients: CLI adaptiert `JiraClient`/`ConfluenceClient`, Extension nutzt Session-`fetch`, weitere Hosts ihren jeweiligen HTTP-Adapter — **eine** Renderer-Implementierung für alle Hosts.

**Fallback-Kette (Entscheidung, pro Makro von oben nach unten):**
1. Native Konvertierung im Walker (heute: Callouts, code, expand, status …) — bleibt unverändert.
2. Makro-spezifischer Renderer aus der Registry (E2–E5) → echte `ExportBlock[]`, volle Template-/Theme-Treue.
3. `export_view`-REST-Fallback: Confluence rendert das Makro serverseitig zu HTML (v1: `GET /wiki/rest/api/content/{id}?expand=body.export_view` bzw. gezielter der async Body-Convert nach `export_view`); ein kleiner HTML→`ExportBlock[]`-Konverter (Teilmenge: p/h/table/img/ul) übernimmt. Kein Headless-Browser nötig, funktioniert in CLI und Extension gleichermaßen.
4. `adfExport`-Konsum (Makros von Drittanbieter-Apps) — **kein eigener Kanal, sondern in Stufe 3 enthalten**, siehe E1.
5. Sichtbarer Platzhalter + Report-Note (heutiges Verhalten) als garantierter Boden — „never silently drop" bleibt Invariante.

**UX:** Der Report bekommt drei Klassen statt zwei: `rendered-via` (info, mit Stufe 2/3), `degraded` (warning, Stufe 5), `skipped-by-config`. Default: Kette voll aktiv; Progressive Disclosure: ein Schalter „Dynamische Makros live auflösen (kontaktiert Jira/Confluence)" für Compliance-Nutzer, die deterministische Exporte wollen. **DX:** Renderer sind pure Funktionen über Ports → trivial mit Fake-Ports testbar (Muster wie `ResolveDeps` in `resolver.ts`); Golden-Tests je Renderer in `packages/export-macros`.

---

### E1 — Third-Party-Makro-Strategie (`adfExport`/export_view)

**(a) Nutzerwert.** „Als Doku-Verantwortlicher exportiere ich Seiten mit Drittanbieter-Makros (Formatting Toolkit, Diagramm-Apps, …) und erwarte, dass der Export aussieht wie die Seite." Der größte Content-Fidelity-Gap und ein Adoptions-Blocker für migrierende Teams.

**(b) Lösungsansatz.** Recherche-Ergebnis zum Protokoll: Makros von Apps auf der aktuellen Atlassian-App-Plattform deklarieren im `manifest.yml` unter `macro:` eine optionale **`adfExport`-Function**, die eine ADF-Repräsentation des Makros zurückgibt; **Confluence selbst** ruft sie auf, wenn die Seite „to PDF/Word exportiert, in der Page History angezeigt **oder via REST API abgerufen** wird" ([Macro-Manifest-Referenz](https://developer.atlassian.com/platform/forge/manifest-reference/modules/macro/), [Macro-Export-Release-Ankündigung](https://community.developer.atlassian.com/t/forge-macro-export-release/58566)). Konsequenz: Wir können fremde App-Functions **nicht direkt invoken** (keine Cross-App-Invocation), aber wir bekommen ihre `adfExport`-Ausgabe **gratis über die `export_view`-Repräsentation** der REST API — genau so konsumieren etablierte Exporter sie („UI Kit macros work by default"). Verworfen: eigenes Vendor-SDK (Henne-Ei, kein Marktzugang); Headless-Rendering der Live-Seite (CLI-untauglich, CSP-Restriktionen in eingebetteten Hosts).

**(c) Umsetzung.** Stufe 3 der Kette wird zum generischen Third-Party-Pfad. Neuer Port + Default-Renderer, der **als letzter** in der Registry steht:

```ts
export interface ExportViewPort {
  /** export_view-HTML nur für dieses Makro (v1 macro-body + contentbody/convert). */
  renderMacroHtml(pageId: string, macroId: string): Promise<string>;
}
export function exportViewFallbackRenderer(): MacroRenderer {
  return { macros: ["*"], async render(m, ctx) {
    if (!ctx.exportView || !m.macroId) return { kind: "skip" };
    const html = await ctx.exportView.renderMacroHtml(ctx.page.id, m.macroId);
    const converted = htmlToExportBlocks(html);          // neue Teilmengen-Konvertierung
    return converted.blocks.length
      ? { kind: "blocks", blocks: converted.blocks,
          notes: [{ level: "info", code: "macro-rendered-via-export-view",
                    message: `\"${m.name}\" via Confluence export_view gerendert.`, macroName: m.name }] }
      : { kind: "skip" };
  } };
}
```

`ConfluenceClient` (`packages/confluence/src/client.ts`, nutzt bisher nur `body.storage`, z. B. Z. 512) bekommt zwei Methoden: `getMacroBodyByMacroId(pageId, version, macroId)` ([v1 macro-body API](https://developer.atlassian.com/cloud/confluence/rest/v1/api-group-content---macro-body/)) und `convertToExportView(storageFragment)` (async contentbody-convert). `htmlToExportBlocks` lebt in `@atlcli/confluence` neben dem Storage-Walker (gleicher XML-Tokenizer, HTML-Namensraum statt `ac:`). Bilder im export_view-HTML (`<img src>`) werden als `{ kind: "external", url }`-`ImageSource` emittiert und laufen durch die vorhandenen Asset-Seams (`AssetFetcher` / `PdfAssetResolver`, `packages/pdf/src/types.ts:26`).

**(d) Aufwand:** L (HTML-Konverter M, REST-Methoden S, Registry-Grundgerüst M). Abhängigkeit: Prerequisite-Block, Spike „liefert Cloud-`export_view` wirklich adfExport-Output für UI-Kit-Makros?" ([Community: inkonsistenter ADF-Export](https://community.developer.atlassian.com/t/inconsistent-adf-pdf-export/100230)).

**(e) Risiken:** export_view-HTML ist unversioniert (Markup-Drift → Golden-Tests gegen echte Instanz, E2E-Profil `mayflower`/`DOCSY`); Legacy-Makros (ältere App-Generation) ohne adfExport liefern weiterhin Leerkörper → Stufe 5 greift; Rate-Limits bei vielen Makros pro Seite (Batch: einmal `body.export_view` für die ganze Seite holen und per `data-macro-id` zuordnen statt N Einzel-Calls).

### E2 — Jira-Makro

**(a) Nutzerwert.** Statusberichte und Release-Notes betten fast immer das `jira`-Makro ein (Einzel-Issue oder JQL-Tabelle). Ein Export ohne Issues ist für den JTBD „Bericht an Stakeholder verschicken" wertlos. `jira` steht bereits in `KNOWN_MACROS` (`packages/confluence/src/markdown.ts:1146`) — erkannt, aber Platzhalter.

**(b) Lösungsansatz.** Nativer Renderer über einen `JiraIssuePort` (Stufe 2) — nicht export_view —, weil nur so Tabellenlayout, Spaltenwahl und Statusfarben unsere Theme-/Template-Pipeline durchlaufen (PDF-Tabellenkontrast-Policy, DOCX-Tabellenstile). export_view bleibt Fallback, wenn kein Jira-Zugang konfiguriert ist.

**(c) Umsetzung.** Makro-Parameter: `key` (Einzel-Issue), `jqlQuery`, `columns`, `maximumIssues`, `serverId`. Port-Implementierung für CLI existiert vollständig: `JiraClient.getIssue` (`packages/jira/src/client.ts:725`) und `JiraClient.search` (JQL via `POST /search/jql`, `client.ts:855`).

```ts
// packages/export-macros/src/jira.ts
export interface JiraIssuePort {
  getIssue(key: string): Promise<{ key: string; summary: string; status: { name: string; color: string }; url: string }>;
  searchJql(jql: string, opts: { maxResults: number; fields: string[] }): Promise<JiraIssueRow[]>;
}
export function jiraMacroRenderer(): MacroRenderer {
  return { macros: ["jira", "jiraissues"], async render(m, ctx) {
    if (!ctx.jira) return { kind: "skip" };                       // → export_view-Fallback
    if (m.params.key) {
      const i = await ctx.jira.getIssue(m.params.key);
      return { kind: "blocks", blocks: [{ type: "paragraph", content: [
        { type: "link", target: { kind: "external", href: i.url },
          content: [{ type: "text", text: `${i.key} ${i.summary}`, marks: ["bold"] }] },
        { type: "text", text: " " },
        { type: "status", text: i.status.name, color: i.status.color },   // vorhandener InlineNode-Typ
      ] }] };
    }
    const cols = (m.params.columns ?? "key,summary,status").split(/[,;]/).map(c => c.trim());
    const rows = await ctx.jira.searchJql(m.params.jqlQuery ?? "", {
      maxResults: Math.min(Number(m.params.maximumIssues ?? 20), 100), fields: cols });
    return { kind: "blocks", blocks: [issueTable(cols, rows)] };  // → ExportBlock { type: "table" }
  } };
}
```

Extension: Session-Fetch gegen `…/rest/api/3` derselben Site; weitere Hosts liefern den Port über ihren HTTP-Adapter (ohne Jira-Zugang greift Stufe 3).

**(d) Aufwand:** M. Abhängig von Registry-Grundgerüst; keine neuen Jira-Client-Features nötig. **(e) Risiken:** `serverId` bei Multi-Site-Verknüpfung (v1: ignorieren + Note); Berechtigungen — Nutzer ohne Jira-Zugriff bekommen 403 → sauberes Fehlerbild „Issue-Tabelle übersprungen: keine Jira-Berechtigung" statt Abbruch; Statusfarbe: Jira-`statusCategory.colorName` → Confluence-Farbnamen mappen.

### E3 — draw.io / Gliffy

**(a) Nutzerwert.** Architektur-Doku ohne Diagramme ist wertlos; drawio ist das meistinstallierte Confluence-Makro überhaupt. Heute: Platzhalter.

**(b) Lösungsansatz.** **PNG-Preview-Attachment nutzen** (Stufe 2): draw.io legt beim Speichern **zwei Attachments** an — die Diagrammdatei (XML/vektoriell) und ein gerendertes PNG-Preview ([drawio-FAQ Bildgenerierung](https://www.drawio.com/doc/faq/external-image-generation-drawio-confluence-server), [WikiTraccs-Analyse](https://www.wikitransformationproject.com/blog/2025/04/16/wikitraccs-creates-draw.io-preview-images/)). Kein neues Rendering nötig — der Renderer mappt das Makro auf einen vorhandenen `image`-Block; Bytes fließen durch die bestehenden Asset-Seams. Verworfen: drawio-XML selbst rendern (eigene Layout-Engine, Wahnsinn) und export_view-first (PNG-Attachment ist offline-fähig und deterministisch).

**(c) Umsetzung.** Reiner, IO-freier Renderer — die Engines fetchen selbst:

```ts
export function diagramMacroRenderer(): MacroRenderer {
  return { macros: ["drawio", "inc-drawio", "drawio-sketch", "gliffy"], async render(m) {
    const name = m.params.diagramName ?? m.params.name;            // drawio | gliffy
    if (!name) return { kind: "skip" };                            // → export_view
    return { kind: "blocks", blocks: [{ type: "image",
      source: { kind: "attachment", filename: `${name}.png` },     // Preview-PNG-Konvention
      alt: name }],
      notes: [{ level: "info", code: "diagram-preview-attachment",
        message: `Diagramm \"${name}\" als Preview-PNG-Attachment eingebettet.`, macroName: m.name }] };
  } };
}
```

Der `image`-Block läuft unverändert durch `preparePdfDocument` (`packages/pdf/src/prepare.ts`) bzw. den OOXML-Embedder (`packages/docx/src/image.ts`) — inklusive Fehlerpfad „Attachment fehlt → Note", der die Kette auf Stufe 3 (export_view liefert eine `<img>`-URL) und final Stufe 5 fallen lässt. Mermaid bleibt der nativ gerenderte Sonderweg (`prepare.ts:247`, `@atlcli/diagram`) — dort sind wir etablierten Exportern bereits voraus.

**(d) Aufwand:** S–M (Renderer S; **E2E-Verifikation der Attachment-Namenskonvention auf Cloud ist der eigentliche Aufwand**, Profil `mayflower`/`DOCSY`). **(e) Risiken:** Preview-PNG kann veraltet/fehlend sein (nur beim Speichern erzeugt — [Support-Case „Missing draw.io Images"](https://www.wikitransformationproject.com/blog/2025/04/08/support-case-missing-draw.io-images/)) → Note „Vorschau evtl. nicht aktuell" mit Versionsvergleich Attachment-Datum vs. Makro; Cloud-drawio-Varianten (`drawio-sketch`, Embed) haben abweichende Parameter; PNG-Auflösung ggf. niedrig — wenn zusätzlich `${name}.svg` existiert, bevorzugt SVG (PDF nativ, DOCX via `SvgRasterizer`-Seam, `packages/docx/src/env.ts:54`).

### E4 — Multiexcerpt + Table-Layout-Wrapper (`scroll-tablelayout`)

**(a) Nutzerwert.** Single-Sourcing-Teams (Appfire Multiexcerpt) und Teams mit Bestandsinhalten (`scroll-tablelayout` steuert Spaltenbreiten/Orientierung) sind exakt die Zielgruppe, die Word/PDF-Export kauft; bei ihnen zerfällt heute jede Seite zu Platzhaltern. Kompatibilitätskritisch für Migrationen (vgl. C4).

**(b) Lösungsansatz.** Zwei getrennte Renderer. Multiexcerpt-*Include*: Quellseite per REST holen, benannten Excerpt-Body extrahieren, rekursiv durch `storageToBlocks` — kein Rendering-Trick, echte Blöcke. Table-Layout: **transparenter Wrapper** — Body durchreichen und Breiten-Parameter auf das bereits existierende Feld `columnWidths` des `table`-Blocks mappen (`export-blocks.ts:108`; PDF honoriert Breiten heute schon, G3 dokumentiert die DOCX-Lücke).

**(c) Umsetzung.**

```ts
export function multiexcerptIncludeRenderer(deps: { storageToBlocks: typeof storageToBlocks }): MacroRenderer {
  return { macros: ["multiexcerpt-include-macro", "multiexcerpt-include"], async render(m, ctx) {
    const pageTitle = m.params.PageWithExcerpt ?? m.params.page, name = m.params.MultiExcerptName ?? m.params.name;
    if (!ctx.confluence || !pageTitle || !name) return { kind: "skip" };
    const key = `${pageTitle}#${name}`;
    if (ctx.visited.has(key) || ctx.depth > 5) return { kind: "skip" };   // Zyklen-/Tiefen-Guard
    ctx.visited.add(key);
    const storage = await ctx.confluence.getPageStorage(pageTitle, ctx.page.spaceKey);
    const fragment = extractMacroBody(storage, ["multiexcerpt-macro", "multiexcerpt"], name); // XML-Walker-Reuse
    if (!fragment) return { kind: "skip" };
    const { blocks, notes } = deps.storageToBlocks(fragment);
    return { kind: "blocks", blocks, notes };
  } };
}
// scroll-tablelayout: Wrapper auflösen, Breiten anwenden
export function scrollTableLayoutRenderer(): MacroRenderer {
  return { macros: ["scroll-tablelayout", "scroll-tablelayout-macro"], async render(m) {
    if (!m.body) return { kind: "skip" };
    const widths = (m.params.widths ?? "").split(",").map(Number).filter(n => n > 0);
    const blocks = m.body.map(b => b.type === "table" && widths.length
      ? { ...b, columnWidths: widths } : b);
    return { kind: "blocks", blocks };
  } };
}
```

Die Definitions-Seite (`multiexcerpt-macro` mit Body) rendert ihr Body transparent — gleiche Ein-Zeilen-Behandlung wie `expand` im Walker (`export-blocks.ts:693`). `extractMacroBody` nutzt den vorhandenen XML-Tokenizer (kein Regex — Kommentar `export-blocks.ts:170` erklärt warum).

**(d) Aufwand:** M. Abhängig von Registry + `ConfluenceContentPort`. **(e) Risiken:** Appfire hat Parameternamen zwischen Server/Cloud-Generationen geändert (`name` vs. `MultiExcerptName`) → beide akzeptieren, E2E gegen Cloud verifizieren; die `scroll-tablelayout`-Parametersemantik (px vs. %, `orientation=landscape`) ist öffentlich kaum verlässlich dokumentiert → `orientation` v1 als Note, später an die C6-Lösung (Querformat-Sektionen) andocken.

### E5 — Page-Properties-Report / children / TOC / include+excerpt

**(a) Nutzerwert.** Das sind die „Confluence-nativen" Dynamikmakros in praktisch jedem Doku-Space (Projektsteckbriefe via Page Properties Report, Kapitelübersichten via children, wiederverwendete Intros via include/excerpt). Alle stehen in `KNOWN_MACROS` — erkannt, nicht gerendert.

**(b) Lösungsansatz.** Ein Renderer-Satz „core-dynamic" über denselben `ConfluenceContentPort`. TOC ist der Sonderfall **ohne IO**: aus den bereits vorliegenden Heading-Blöcken generierbar — oder bewusst unterdrücken, wenn das Template ein natives TOC liefert (übliches Exporter-Verhalten: „TOC replaced by native TOC per template").

**(c) Umsetzung.**
- **`include`** (`$scroll.includepage`-Pendant, D1 gleich mit erledigt) und **`excerpt-include`**: identisches Muster wie Multiexcerpt-Include — Storage der Zielseite holen, bei excerpt nur den `excerpt`-Makro-Body extrahieren, rekursiv walken, `visited`-Guard teilt sich den Kontext.
- **`excerpt`** (Definitionsseite): Body transparent durchreichen; Parameter `hidden=true` → `[]`.
- **`children`**: `ctx.confluence.getChildren(ctx.page.id)` (Client-Basis vorhanden: `getPageChildren`-Pfad im v2-Client, `client.ts:2161` nutzt bereits `body-format=storage`) → verschachtelte `list`-Blöcke mit `link`-InlineNodes (`target: { kind: "page", contentTitle }` — Linkziel-Typ existiert, `export-blocks.ts:47`). Parameter `depth`, `sort` respektieren.
- **`detailssummary`** (= Page Properties Report): `searchCql("label=\"" + m.params.cql/label + "\"")`, je Treffer-Seite Storage holen und mit dem **vorhandenen** `parsePageProperties` (`packages/confluence/src/page-properties.ts:120`) die `details`-Tabelle lesen → aggregierte `table`-Block-Ausgabe (Spalten = Union der Property-Keys, erste Spalte Seitenlink). `details` selbst (auf der Seite) rendert nativ als Tabelle — Body durchreichen.
- **`toc`**: pure Funktion `tocFromHeadings(blocks, { minLevel, maxLevel, style })` → `list`-Block mit `anchor`-Links. **Default-UX:** DOCX unterdrückt das Body-TOC mit Info-Note, wenn das Template ein natives Word-TOC enthält (Scan kennt das Feld bereits — `updateFields`/TOC-Population in `placeholder-map.ts`); PDF rendert es nur, wenn das Template-Outline deaktiviert ist. Kein doppeltes Inhaltsverzeichnis als Default.

**(d) Aufwand:** M–L als Satz; einzeln je S–M. TOC hat null Abhängigkeiten und ist der ideale erste Registry-Renderer (pure, kein Port → Referenz-Testfall für die DX). **(e) Risiken:** `detailssummary`-CQL-Semantik (Spaces-Scope, `firstcolumn`-Param) muss gegen echte Cloud-Instanz kalibriert werden; children/CQL auf großen Bäumen → `maximumIssues`-artige Kappung (Default 50) + Note; Reihenfolge-Stabilität der Report-Tabelle (Sortierung nach Titel als deterministischer Default — Exporte müssen reproduzierbar bleiben).

---

**Priorisierung im Cluster:** Prerequisite-Block + Registry (Fundament) → E5-TOC (pure, DX-Referenz) → E3 (billigster sichtbarer Win) → E2 → E5-Rest → E4 → E1-export_view-Fallback (schließt den Long Tail). Alles setzt an den bestehenden Seams an (`ExportEnv`, `PdfExportEnv`, Asset-Resolver) und funktioniert damit unverändert in CLI und Extension; weitere Hosts implementieren die Ports über ihren jeweiligen HTTP-Adapter.

Quellen: [Macro-Manifest-Referenz (adfExport)](https://developer.atlassian.com/platform/forge/manifest-reference/modules/macro/) · [Macro-Export-Release-Ankündigung](https://community.developer.atlassian.com/t/forge-macro-export-release/58566) · [adfExport-Diskussion](https://community.developer.atlassian.com/t/how-use-adfexport-we-dont-have-a-way-to-export-this-macro/91755) · [Inconsistent ADF PDF Export](https://community.developer.atlassian.com/t/inconsistent-adf-pdf-export/100230) · [v1 Macro-Body-API](https://developer.atlassian.com/cloud/confluence/rest/v1/api-group-content---macro-body/) · [drawio: Bildgenerierung beim Speichern](https://www.drawio.com/doc/faq/external-image-generation-drawio-confluence-server) · [drawio Preview-PNG-Attachments](https://www.wikitransformationproject.com/blog/2025/04/16/wikitraccs-creates-draw.io-preview-images/) · [Missing draw.io Images](https://www.wikitransformationproject.com/blog/2025/04/08/support-case-missing-draw.io-images/)

## 6. Cluster G — Word-Output-Qualität (G1–G4)

Alle vier Pakete liegen vollständig in der puren Engine `@atlcli/docx` (Serializer + Zip-Chirurgie). Da CLI und Extension (und künftige weitere Hosts) denselben `exportDocx`-Pfad über `ExportEnv` (`packages/docx/src/env.ts`) fahren, ist jede Lösung automatisch shape-agnostisch — kein Host-Code nötig außer dort, wo ein Seam (Rasterizer) bereits existiert.

### G1 — StyleRef-E2E-Verifikation (Kapitelüberschrift in Kopfzeile)

**(a) Erläuterung & Nutzerwert.** Etablierte Word-Template-Konventionen realisieren „aktuelle Überschrift in der Kopfzeile" über das Word-`STYLEREF`-Feld. JTBD: „Wenn ich ein 40-seitiges Handbuch exportiere, will ich auf jeder Seite sehen, in welchem Kapitel ich bin." Unsere Einschätzung: das *sollte* bei uns bereits funktionieren, weil wir Template-Style-Ids emittieren — ist aber ungetestet. Vor jeder öffentlichen Kompatibilitätszusage muss das bewiesen sein.

**(b) Lösungsansatz.** Kein Feature bauen, sondern eine dreistufige Verifikation: (1) Unit-Invarianten (Feld überlebt, Style-Id stimmt, `updateFields` gesetzt), (2) automatisierter Render-Smoke via LibreOffice headless, (3) manuelles Word-Protokoll einmalig pro Release-Train. Alternative „nur manuell testen" verworfen: nicht regressionsfest; Alternative „eigenes STYLEREF emittieren" verworfen: das Feld gehört ins Template (Nutzerentscheidung), nicht in die Engine.

**(c) Technische Umsetzung.** Die drei Invarianten, die StyleRef tragen, existieren im Code:
- Headings bekommen die Template-Style-Id über `resolveHeadingStyleId` (`packages/docx/src/ooxml.ts:46`): `Scroll Heading N` → `Heading N` → Builtin `HeadingN` (Kette gegen `parseStyleNames` aus `word/styles.xml`, `export.ts:236`).
- Feld-Instruktionen werden vom Placeholder-Rewrite bewusst nicht angefasst (`export.ts:871`: „field INSTRUCTION … intentionally left literal").
- `ensureUpdateFields` (`export.ts:908`) erzwingt Feld-Neuberechnung beim Öffnen — davon profitiert STYLEREF wie der TOC.

Neuer Test `packages/docx/src/styleref.test.ts` mit den vorhandenen Fixture-Buildern (`fixtures.ts`: `buildDocx`, `headingStyle`, `fldSimpleResult`, `complexField`):

```ts
const headerXml =
  `<w:p><w:fldSimple w:instr=" STYLEREF &quot;Scroll Heading 1&quot; \\* MERGEFORMAT ">` +
  `<w:r><w:t>[stale chapter]</w:t></w:r></w:fldSimple></w:p>`;
const template = buildDocx({
  body: para("$scroll.content"),
  header: headerXml,
  styles: stylesXml(headingStyle("Scroll Heading 1", "ScrollHeading1")),
});
const { bytes } = await exportDocx({ templateBytes: template, details, template: meta });
const zip = new PizZip(bytes);
const header = zip.file("word/header1.xml")!.asText();
// 1. Instruktion überlebt Preprocessing + docxtemplater byte-genau:
expect(header).toContain('w:instr=" STYLEREF &quot;Scroll Heading 1&quot;');
// 2. Body-Headings referenzieren exakt die Id, deren NAME das Feld nennt:
expect(zip.file("word/document.xml")!.asText()).toContain('<w:pStyle w:val="ScrollHeading1"/>');
// 3. Word aktualisiert das Feld beim Öffnen:
expect(zip.file("word/settings.xml")!.asText()).toContain('<w:updateFields w:val="true"/>');
```

Zusätzlich ein Golden-Fixture-Template (echtes, in Word gebautes `.docx` mit STYLEREF in `header1.xml`, eingecheckt unter `packages/docx/test-fixtures/styleref-template.docx`) und ein Render-Smoke im E2E-Skript: `soffice --headless --convert-to pdf out.docx`, dann Textextraktion (`pdftotext`) und Assertion, dass der H1-Text auf Seite ≥2 auftaucht. Manuelles Protokoll (Word 365, einmalig): Feld zeigt pro Seite die letzte H1; dokumentieren in `docs/` (Troubleshooting-Sektion: „Kopfzeile zeigt [stale chapter]" → F9/Öffnen-Refresh).

**Wichtige inhaltliche Falle, die der Test aufdecken muss:** `STYLEREF` referenziert den Style-**Namen**, wir setzen die Style-**Id**. Das matcht nur, wenn das Template den Style wirklich definiert. Im Fallback-Fall `HeadingN` (Template ohne Heading-Styles) existiert kein `<w:style>` mit Namen „Heading 1" in `styles.xml` — Word legt Builtin-Styles zwar latent an, aber erst wenn ein Absatz sie nutzt, und lokalisierte Word-Versionen zeigen „Überschrift 1". Empfehlung aus dem Test ableiten: Report-Note (`level: "info"`, Code `styleref-fallback-style`), wenn ein STYLEREF-Feld im Template-Scan (`scan.ts` erweitern um Feld-Inventar) einen Style-Namen nennt, den `parseStyleNames` nicht kennt — Progressive Disclosure statt stillem Fehlbild.

**(d) Aufwand:** S (2–3 Tage inkl. Fixture + Docs). Keine Abhängigkeiten; sollte VOR G2 laufen, weil G2 `styles.xml` anfasst.

**(e) Risiken/offene Fragen.** LibreOffice berechnet STYLEREF anders als Word (bekannte Abweichungen bei Spalten-Layouts) — der soffice-Smoke ist notwendige, nicht hinreichende Evidenz; finale Wahrheit bleibt Word. Offen: Verhalten bei Heading-Promotion (`computeHeadingOffset`, `serialize.ts:243`) — ein Template-STYLEREF auf „Scroll Heading 2" kann nach Promotion leer laufen; Testfall aufnehmen.

### G2 — Natives Listen-Numbering (`w:numPr` + numbering.xml)

**(a) Erläuterung & Nutzerwert.** Heute rendert `serializeListItem` (`serialize.ts:519`) literale Marker-Runs (`•`, `1.`, ☑/☐) plus manuellen `w:ind`-Einzug (`INDENT_STEP`, `serialize.ts:118`). Folgen für den Nutzer: Templates können Listen nicht über „Scroll List Bullet/Number"-Styles stylen (etablierte Style-Namenskonvention), Nummern sind tote Zeichen (kein Fortsetzen/Neu-Nummerieren beim Nachbearbeiten, keine Feldreferenz), Screenreader lesen keine Listenstruktur. JTBD: „Ich exportiere nach Word, um dort *weiterzuarbeiten* — Listen müssen sich wie Word-Listen verhalten."

**(b) Lösungsansatz.** `word/numbering.xml` pro Export synthetisieren: je ein `abstractNum` für Bullet und Decimal (9 Ebenen), ein geteiltes `w:num` für alle Bullet-Listen, ein `w:num` **pro Top-Level-Ordered-List** mit `startOverride` (sonst zählt Word dokumentweit durch — Restart pro Liste ist das Confluence-Verhalten). Task-Listen bleiben auf dem ☑/☐-Pfad (Word hat kein natives Checkbox-Numbering; Alternative SDT-Checkboxen verworfen: nicht read-only-stabil, hoher Aufwand). Alternative „numbering ins Template verlangen" verworfen: bricht Zero-Config-UX.

**(c) Technische Umsetzung.** Der Serializer ist pur (Strings) — die Id-Vergabe braucht Export-Zustand. Analog zum `ImageEmbedder`-Muster: ein purer `NumberingAllocator` wandert in den `SerializeContext` (`serialize.ts:92`):

```ts
// packages/docx/src/numbering.ts (neu)
export class NumberingAllocator {
  private orderedNums: number[] = [];
  private bulletNum: number | null = null;
  constructor(private base: { abstractNumId: number; numId: number }) {} // > Max im Template
  acquire(ordered: boolean): number {
    if (!ordered) return (this.bulletNum ??= this.nextNumId());
    const id = this.nextNumId(); this.orderedNums.push(id); return id;
  }
  /** <w:abstractNum>-Definitionen + <w:num>-Instanzen für ensureNumberingPart. */
  toXml(): { abstractNums: string; nums: string } { /* siehe XML unten */ }
}
```

`serializeList` (`serialize.ts:504`) ruft `ctx.numbering.acquire(list.ordered)` **einmal pro Top-Level-Liste** und reicht `numId` an alle Ebenen durch; `serializeListItem` ersetzt Marker-Run + `w:ind` durch:

```xml
<w:p><w:pPr>
  <w:pStyle w:val="ListParagraph"/>   <!-- bzw. Template-Style, s.u. -->
  <w:numPr><w:ilvl w:val="0"/><w:numId w:val="101"/></w:numPr>
</w:pPr><w:r><w:t>alpha</w:t></w:r></w:p>
```

Style-Kette wie bei Headings, neue Funktion in `ooxml.ts` neben `resolveHeadingStyleId`: `resolveListStyleId(styleNames, ordered, level)` → `scroll list bullet ${level}` / `scroll list number ${level}` → `list bullet` / `list number` → `ListParagraph`. Damit greifen Bestands-Templates mit diesen List-Styles sofort, und die visuelle Kontrolle (Font, Abstand) liegt im Template — Einzug/Nummerformat liegen im `lvl`:

```xml
<w:abstractNum w:abstractNumId="90"><w:multiLevelType w:val="multilevel"/>
  <w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/>
    <w:lvlText w:val="%1."/><w:lvlJc w:val="left"/>
    <w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr></w:lvl>
  <w:lvl w:ilvl="1"><w:start w:val="1"/><w:numFmt w:val="lowerLetter"/>
    <w:lvlText w:val="%2."/><w:pPr><w:ind w:left="1440" w:hanging="360"/></w:pPr></w:lvl>
  <!-- … bis ilvl 8; Bullet-abstractNum analog: numFmt="bullet", lvlText="" (Symbol), rFonts Symbol -->
</w:abstractNum>
<w:num w:numId="101"><w:abstractNumId w:val="90"/>
  <w:lvlOverride w:ilvl="0"><w:startOverride w:val="1"/></w:lvlOverride></w:num>
```

Zip-Chirurgie in `export.ts` nach dem Render, im Muster von `ensureCodeStyle` (`export.ts:895`): `ensureNumberingPart(zip, allocator)` — (1) `word/numbering.xml` anlegen oder mergen (bestehende `abstractNumId`/`numId`-Maxima parsen, Basis darüber — Muster `maxExistingDrawingId`, `image.ts:529`), (2) `[Content_Types].xml`-Override via `ensureContentTypeDefault`-Analogon, (3) Relationship in `word/_rels/document.xml.rels` (`relsPathFor`, `image.ts:510`). Fortsetzungs-Blöcke eines Items (zweiter Absatz, Codeblock) bekommen **kein** `numPr`, nur `w:ind w:left` passend zur Ebene — das heutige `addParagraphProps` (`serialize.ts:200`) bleibt dafür in Dienst. Nested Non-List-Blöcke (Callout in Listenitem) ebenso.

DX/Tests: Snapshot-Tests auf `numbering.xml`-Synthese; Regressionstest „zwei getrennte `<ol>` starten beide bei 1"; Golden-Test (`golden.test.ts`) bricht absichtlich → Recapture mit dokumentiertem Diff (nur Listen-Markup + neues Part). E2E laut Workflow-Regeln gegen `DOCSY` mit verschachtelter Misch-Liste.

**(d) Aufwand:** M (Serializer-Umbau + Part-Synthese + Golden-Recapture + E2E). Abhängigkeit: G1-Testinfrastruktur (Fixture-Templates) zuerst; PDF-Seite unberührt.

**(e) Risiken/offene Fragen.** Golden-Recapture ist der teuerste Teil (bewusster Bruch). `placeMarker`-Sonderfälle (Item beginnt mit Callout-Tabelle, `serialize.ts:215`) brauchen weiterhin einen Marker-Ersatz — Entscheidung: solche Items bekommen einen leeren nummerierten Absatz vor dem Block (Word-üblich). Offen: sollen Checkbox-Items wenigstens `ListParagraph`-Style bekommen (Empfehlung: ja, für konsistenten Einzug).

### G3 — Tabellen-Spaltenbreiten in DOCX

**(a) Erläuterung & Nutzerwert.** Die Daten sind schon da: `tableColumnWidths` (`packages/confluence/src/export-blocks.ts:511`) parst `<colgroup>`-Breiten (px-normalisiert, `parseColumnWidth` inkl. pt/cm/mm, Spans expandiert, unvollständige Colgroups → `undefined` statt Raten) in `ExportBlock.columnWidths` (`export-blocks.ts:108`). Die PDF-Engine honoriert sie (`packages/pdf/src/serialize.ts:730/737`, fr-Ratios mit 1.05-Spread-Schwelle). DOCX wirft sie weg: `serializeBlock` ruft `serializeTable(block.rows, …)` ohne `columnWidths` (`serialize.ts:396`), und `dataTable` teilt 9000 dxa gleichmäßig (`ooxml.ts:230-231`). Nutzerbild: mühsam austarierte Confluence-Tabellen (schmale Status-Spalte, breite Beschreibung) kommen als Einheitsbrei in Word an — PDF und DOCX derselben Seite widersprechen sich.

**(b) Lösungsansatz.** Proportionale Skalierung der px-Gewichte auf die feste Tabellenbreite 9000 dxa + `w:tblLayout fixed` + per-Zelle `w:tcW`. Alternative „px → dxa absolut (×15)" verworfen: Confluence-Tabellen sind oft breiter als die Seitenspalte, absolute Werte sprengen den Satzspiegel; Proportionalität entspricht exakt der PDF-`fr`-Semantik → konsistentes Fehlerbild über beide Engines. Validierungslogik der PDF-Seite spiegeln (Längen-Match, alle > 0), sonst Fallback Gleichverteilung — niemals kaputte Grids.

**(c) Technische Umsetzung.** Drei kleine Änderungen:

1. `serialize.ts:396`: `serializeTable(block.rows, block.columnWidths, …)`; in `serializeTable` (`serialize.ts:568`) nach der Grid-Berechnung:

```ts
const widthsDxa = columnWidthsDxa(columnWidths, gridCols); // undefined → Gleichverteilung
// columnWidthsDxa: Länge === gridCols und alle finite/>0, sonst undefined;
// dann round(9000 * w/sum) mit Rest-Korrektur auf der letzten Spalte (Summe exakt 9000).
return dataTable(gridCols, rowsXml, widthsDxa);
```

2. `ooxml.ts` `dataTable(gridCols, rowsXml, widthsDxa?)`:

```xml
<w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="9000" w:type="dxa"/>
  <w:tblLayout w:type="fixed"/> <!-- neu: Word darf das Grid nicht neu autofitten -->
  …Borders…</w:tblPr>
<w:tblGrid><w:gridCol w:w="1500"/><w:gridCol w:w="4500"/><w:gridCol w:w="3000"/></w:tblGrid>
```

3. `tableCell` (`ooxml.ts:247`) bekommt `widthDxa?: number` und emittiert `<w:tcW w:w="…" w:type="dxa"/>` als erstes `tcPr`-Kind (Schema-Ordnung: `tcW` vor `gridSpan`); `serializeTable` reicht pro Zelle die Summe der überspannten `gridCol`-Breiten (`widthsDxa[col..col+colspan)`) — auch für vMerge-Continue- und Padding-Zellen, damit Word das Fixed-Layout nicht „repariert".

Wichtig: `hasCarryFrom`/Colspan-Logik bleibt unangetastet; die Breiten sind reine Zusatz-Properties. Tests: Unit (Ratios 100/300 → 2250/6750; Mismatch → Gleichverteilung; Colspan-Zelle = Summenbreite), Regressionstest gegen das PDF-Verhalten mit identischem Fixture (`pdf/serialize.test.ts:115` nutzt `columnWidths: [100, 300]` — gleiche Zahlen für DOCX übernehmen: Cross-Engine-Konsistenz als Test). Golden-Recapture nötig (Fixture-Zoo enthält Tabellen).

UX-Entscheidung: bewusst **keine** 1.05-Spread-Schwelle wie im PDF übernehmen? Doch — übernehmen: quasi-gleiche Breiten (Confluence-Default 226/226) sollen weiter die saubere Gleichverteilung bekommen, identisch zur PDF-Entscheidung; ein geteilter Helper wäre schön, aber die Engines teilen kein Layout-Paket — Duplikation mit Verweis-Kommentar ist hier billiger als ein neues Shared-Package (DX-Abwägung dokumentieren).

**(d) Aufwand:** S (1–2 Tage inkl. Golden-Recapture). Keine Abhängigkeiten; idealerweise mit G2 in einem Recapture-PR bündeln (nur einmal Golden brechen).

**(e) Risiken/offene Fragen.** `w:tblLayout fixed` ändert das Verhalten bei extrem langen unbrechbaren Inhalten (URLs) — Word clippt statt zu dehnen; akzeptiert, weil Confluence sich genauso verhält. Offen: sollen Prozent-Colgroups (`parseColumnWidth` behandelt `%` wie px-Gewicht) je als `w:type="pct"` emittiert werden — nicht nötig, Proportionalität deckt es ab.

### G4 — SVG-Embedding in DOCX (Attachments)

**(a) Erläuterung & Nutzerwert.** `ImageEmbedder.embed` wirft heute bei SVG-Attachments hart ab: „SVG images are not embedded yet (spec 005 deferral)" (`image.ts:380`) → Report-Note, Bild fehlt im Dokument. Dabei existiert der komplette svgBlip-Pfad bereits für Mermaid: `ImageEmbedder.embedSvg` (`image.ts:412`) schreibt SVG-Part + Pflicht-PNG-Fallback in **einen** `<a:blip>` (`inlineImageParagraph` mit `svgRelId`, `image.ts:257-261`), und der `SvgRasterizer`-Seam (`env.ts:54`) ist in allen Hosts implementiert (Extension: Canvas; Node/CLI: `resvgSvgRasterizer` in `node-adapters.ts`; weitere Browser-Hosts analog per Canvas). JTBD: Architektur-Diagramme liegen in Confluence oft als SVG-Attachment — die dürfen im Word-Export nicht verschwinden, und in modernem Word sollen sie vektor-scharf sein.

**(b) Lösungsansatz.** Den bestehenden `embedSvg`-Pfad für Attachment-SVGs wiederverwenden: im Image-Seam (`imageSeam`, `export.ts` um Z. 660–700) nach dem Fetch `isSvg(bytes)` prüfen; wenn ja und ein Rasterizer vorhanden ist → sanitizen, Intrinsic-Size parsen, PNG@2× rastern, `embedder.embedSvg` aufrufen. Ohne Rasterizer bleibt die heutige Degradation (Note `image-embed-failed` → präziser: neuer Code `image-svg-no-rasterizer`). Alternative „SVG ohne PNG-Fallback einbetten" verworfen: `svgBlip` ohne Raster-Blip bricht in älterem Word/Vorschauen (Spec-005a-Entscheidung gilt unverändert). Alternative „nur rastern, kein SVG-Part" verworfen: verschenkt Vektorqualität, die Mermaid schon hat.

**(c) Technische Umsetzung.**

1. **Sanitizing teilen, nicht duplizieren.** Die PDF-Engine prüft SVG-Attachments bereits in `validateResolvedAsset` (`packages/pdf/src/prepare.ts:57-66`): `script`/`foreignObject`, `on*`-Handler, externe/`data:`-`href`s → Reject. Diese Regexes als `assertSafeSvg(source: string): void` nach `@atlcli/confluence` (z. B. `packages/confluence/src/svg-safety.ts`) extrahieren; `prepare.ts` und der neue DOCX-Pfad importieren sie — **eine** Policy, ein Fehlertext („SVG contains active or externally loaded content"), beide Engines. (Beide Packages hängen schon an `@atlcli/confluence`.)

2. **Intrinsic-Size.** Neuer purer Helper in `image.ts`:

```ts
export function parseSvgSize(source: string): { width: number; height: number } | null {
  const open = source.match(/<svg\b[^>]*>/i)?.[0]; if (!open) return null;
  const dim = (name: string) => {
    const m = open.match(new RegExp(`\\b${name}\\s*=\\s*["']([0-9.]+)(px)?["']`, "i"));
    return m ? Number.parseFloat(m[1]) : undefined;
  };
  let w = dim("width"), h = dim("height");
  if (!w || !h) {
    const vb = open.match(/\bviewBox\s*=\s*["']\s*[-0-9.]+[\s,]+[-0-9.]+[\s,]+([0-9.]+)[\s,]+([0-9.]+)/i);
    if (vb) { w ??= Number.parseFloat(vb[1]); h ??= Number.parseFloat(vb[2]); }
  }
  return w && h && w > 0 && h > 0 ? { width: Math.round(w), height: Math.round(h) } : null;
}
```

3. **Seam-Verdrahtung** in `imageSeam` (`export.ts`), vor dem heutigen `embedder.embed`:

```ts
if (isSvg(bytes)) {
  if (!rasterizer) return { ok: false, reason: "SVG needs a rasterizer for the PNG fallback in this host" };
  const source = new TextDecoder().decode(bytes);
  assertSafeSvg(source);                                  // geteilte Policy (pdf/prepare.ts)
  const intrinsic = parseSvgSize(source) ?? { width: 600, height: 400 }; // Fallback + info-Note
  const size = resolveTargetSize(intrinsic, { widthPx: block.width, heightPx: block.height }, MAX_CONTENT_WIDTH_PX);
  const png = await rasterizer.rasterize(source, { widthPx: size.widthPx * 2, heightPx: size.heightPx * 2 });
  return { ok: true, xml: embedder.embedSvg(bytes, png, {
    alt: block.alt, name: block.source.kind === "attachment" ? block.source.filename : undefined,
    widthPx: size.widthPx, heightPx: size.heightPx,
  }) };
}
```

Dazu: `imageSeam` bekommt den Rasterizer durchgereicht (heute nur `diagramSeam`), Author-Maße `block.width/height` (`export-blocks.ts:109`) fließen wie bei Rastern in `resolveTargetSize` (`image.ts:159`). `embedSvg` selbst braucht **keine** Änderung — Dedup, Rel-Verwaltung, 004-F3-Invariante (kein Archive-Write vor Validierung) gelten fertig. Report: `renderedDiagrams` nicht mitzählen, stattdessen `embeddedImages` (es ist ein Bild); neuer Note-Code `image-svg-embedded` nicht nötig — Erfolg ist still (World-Class-Default: Erfolg braucht keine Meldung, nur Abweichung).

Tests: Unit für `parseSvgSize` (width/height, nur viewBox, beides fehlt), Seam-Test „SVG-Attachment + Rasterizer → `asvg:svgBlip` im document.xml + PNG-Part + SVG-Part", Negativ „`<script>`-SVG → Note, Archiv unberührt", „kein Rasterizer → Note". E2E gegen `DOCSY` mit echtem SVG-Attachment, Sichtprüfung in Word (Vektor) und LibreOffice (nimmt den PNG-Fallback).

**(d) Aufwand:** S–M (Extraktion `assertSafeSvg` + Seam + Tests ~2–3 Tage). Abhängigkeiten: keine; der `@atlcli/confluence`-Move berührt `@atlcli/pdf` (Importpfad) — Typecheck + PDF-Tests mitlaufen lassen.

**(e) Risiken/offene Fragen.** (1) SVGs mit CSS-`width:…` im `style`-Attribut oder `em`-Einheiten fallen auf den viewBox-/Default-Pfad — bewusst simpel halten, Note bei Default-Größe. (2) Der Canvas-Rasterizer der Extension rendert externe Fonts im SVG nicht — gleiche Einschränkung wie Mermaid heute, dokumentieren. (3) `data:`-hrefs werden von der geteilten Policy abgelehnt, obwohl eingebettete Rasterbilder in SVGs legitim sind — Policy-Lockerung (nur `data:image/png;base64` erlauben) als Follow-up für **beide** Engines diskutieren, nicht einseitig.

### Reihenfolge-Empfehlung

G1 (Testinfra zuerst, billig, entriskt öffentliche Kompatibilitätszusagen) → G3 + G2 in einem Golden-Recapture-Zug (G3 S, G2 M) → G4 parallel möglich (unabhängige Dateien). Alle vier landen ohne Host-Arbeit in CLI und Extension — und in jedem weiteren Host, der den `exportDocx`-Pfad konsumiert.
