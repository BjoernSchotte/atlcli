# CalVer für atlcli: Analyse und Umstellungsvorschlag

Stand: 2026-10-14, atlcli HEAD `22857951`. Status: Vorschlag, keine Implementierung oder Release-Freigabe.

## Ziel und bestätigte Abgrenzung

Produkt-Releases von CLI und Chrome-Extension verwenden künftig `YYYY.M.N`.
Die `@atlcli/*`-Bibliotheken behalten ihre SemVer/API-Politik. Diese Trennung wurde
vom Maintainer bestätigt. Ein Produkt-Release ist keine automatische
Versionsänderung sämtlicher Workspace-Pakete.
Der Release-Monat wird wie bei agentglass in UTC bestimmt; auch diese Entscheidung
ist vom Maintainer bestätigt.

## Befund aus agentglass

- `scripts/release-lib.sh:2-20`: UTC-Monat, keine führenden Nullen, pro Monat
  höchster vorhandener Zähler plus eins; neuer Monat beginnt bei eins.
  Tags `v2026.10.1`. Lücken werden nicht wiederverwendet. Der letzte Stable-Tag
  wird numerisch ausgewählt und muss vom Release-Commit erreichbar sein.
- `scripts/release.sh:8-26`: sauberes main, Fetch von main/Tags, Gleichheit mit
  origin/main, CI-Prüfung, Changelog, Release-Commit, annotierter Tag,
  `git push --atomic origin main v<version>`.
- `scripts/publish-release.sh:3-19`: zuerst Draft; heruntergeladene Assets
  verifizieren; dann veröffentlichen. Veröffentlichte Releases nicht verändern.
- `.github/workflows/release.yml:17-22`: Version aus dem Tag; Erreichbarkeit von main.
- `docs/cli-contract.md:7-16`: separate Vertragsversion für Breaking Changes.
- `scripts/release-lib.test.sh:19-29`: Erstversion, Monatswechsel, Zählerlücken,
  numerische Sortierung und ignorierte Dev-/fehlerhafte Tags.

Nicht blind übernehmen: Die Monatsregex erlaubt dort auch 13–99. Für neue
atlcli-CalVer-Versionen Monate 1–12 erzwingen. Außerdem sortiert agentglass
Dev-Versionen nach dem Stable-Basisrelease (`src/features/version.ts:25-27`);
atlcli verwendet bereits SemVer-Prerelease-Ordnung und getrennte Update-Kanäle.
Ein neuer Comparator ist für diese Migration nicht erforderlich.

## Befund aus atlcli

| Verantwortliche Stelle | Aktuelles Verhalten | Konsequenz |
|---|---|---|
| `scripts/release.ts` | Root-Version 0.17.2, patch/minor/major; nur Root-package.json ändern | Versionsvergabe und Bedienung ersetzen |
| `scripts/release-artifacts.ts:75-159` | Drei numerische Komponenten, Chrome-Limit 65535; Stable-/Dev-Identität zentral | CalVer passt schon; Policy beim Release-Schnitt validieren |
| `packages/core/src/update.ts:237-289` | Numerischer SemVer-Vergleich | Legacy → CalVer und Monats-/Jahreswechsel funktionieren bereits |
| `apps/extension/release-context.ts:24-35` | 1–4 numerische Komponenten bis 65535 | 2026.10.1 passt ohne Mapping |
| `.github/workflows/release.yml:47-81` | Tag-/Input-Version muss Root-package.json entsprechen; Identität wird eingefroren | Diese Konsistenz erhalten; CalVer-Policy ergänzen |
| `.github/workflows/release.yml` | SHA-bound Preflight, Draft, Download-Verifikation, native CLI-Smokes, Publish, Public-Verifikation | Bestehenden Graph beibehalten |
| `scripts/release.ts:232`, `.github/workflows/release.yml:142` | Vorheriger Tag via ungefiltertem git describe | Dev-Tags können Changelog-Basis beeinflussen; Stable-Auswahl explizit machen |
| `scripts/release.ts:524-529` | main und Tag werden getrennt gepusht | Atomaren Push verwenden; Rollback-Zustand anpassen |
| `cliff.toml` | Conventional Commits, keine eigene Breaking-Gruppe | Breaking Changes sichtbar priorisieren |
| `src/content/docs/reference/versioning.md` | Fünf eingefrorene Bibliotheken bei 1.0.0, weitere 0.x; Registry-Publish zurückgestellt | Bibliotheks-SemVer separat erhalten und Trennung dokumentieren |

## Empfohlene Policy

1. Stable `YYYY.M.N`, Tag `vYYYY.M.N`, UTC als gemeinsame Release-Zeitzone wie
   agentglass und der vorhandene Dev-Kanal. N ist Release-Zähler, kein Tag des Monats.
   Beispiel: `2026.10.1`, `2026.10.2`, `2026.11.1`.
2. Bestehende `v0.x`-Tags, Releases und Changelog-Historie unverändert erhalten.
   Der erste CalVer-Release ist nur dann `2026.10.1`, wenn im tatsächlichen
   Release-Monat keine höheren passenden Tags reserviert sind.
3. Root-package.json bleibt die Produkt-Version; Release-Tag und Root-Version
   müssen identisch sein. Anders als agentglass benötigt atlcli keinen Umbau
   auf ausschließlich tagbasierte lokale Build-Versionen.
4. Monat/Zähler validieren, keine führenden Nullen; alle Produkt-Komponenten
   innerhalb des bestehenden Chrome-Limits. Kandidat muss größer als Root-Version
   und höchster bekannter Stable-Version sein. Zukunftstags oder rückwärts
   laufende Uhr blockieren den Schnitt statt einen Downgrade zu erzeugen.
5. N aus allen bekannten passenden Tags nach Refresh berechnen, nicht bloß aus
   Root-package.json oder veröffentlichten GitHub-Releases. Auch reservierte
   Tags fehlgeschlagener Releases verbrauchen eine Nummer. Keine Wiederverwendung.
6. Dev-Tags, Run/Attempt/SHA-Identität, Homebrew-Dev-Version und Update-Kanaltrennung
   beibehalten. Neue Dev-Builds übernehmen die CalVer-Root-Version automatisch.
7. CalVer macht keine Kompatibilitätszusage. Breaking Changes bekommen eine
   prominente Gruppe und konkrete Migrationshinweise. Bestehende Schema-Versionen
   und API-Freeze-Regeln behalten ihre eigene Bedeutung. Eine globale neue
   CLI-contract-Zahl ist kein notwendiger Teil dieser Umstellung.

## Umsetzung in drei reviewbaren Einheiten

### 1. Versionsvergabe und Release-Schnitt

Dateien: `scripts/release.ts`, `scripts/release.test.ts`; ein kleiner reiner
CalVer-Helper mit Tests unter `scripts/`, falls die Logik das Release-Skript
sonst unnötig belastet. Keine generische Versionierungsstrategie-Abstraktion.

- [ ] `patch/minor/major` entfernen und mit verständlicher Migrationsmeldung
  ablehnen; kein stilles Ignorieren alter Eingaben. Neuer Aufruf:
  `bun scripts/release.ts --dry-run`, `--preview`, oder ohne diese Flags.
- [ ] Eine Uhrzeit pro Aufruf erfassen und durchreichen; UTC-Monat nicht zwischen
  mehreren Date-Aufrufen berechnen. Version, Preview und Commit verwenden denselben Kandidaten.
- [ ] Reiner Kern: Tags normalisieren/validieren, numerische Tupel vergleichen,
  Monatsmaximum bestimmen, Kandidat berechnen, Monotonie und Chrome-Limit prüfen.
  Legacy-Stable-Tags bleiben als Vergleichs-/Changelog-Basis lesbar.
- [ ] Echter Schnitt: main/sauber prüfen, origin/main und Tags aktualisieren,
  Gleichheit mit origin/main prüfen, Kandidat vor Mutation neu bestimmen.
  Vorhandene Tests/Typecheck und SHA-bound CI-Publication-Gates behalten.
- [ ] Dry-run bleibt auf Review-Branches und mit schmutzigem Worktree nutzbar.
  Er verändert keine Dateien/Git-Refs und bezeichnet lokale Tags als Snapshot;
  vor dem echten Schnitt wird der Remote-Stand nochmals aktualisiert.
- [ ] Commit und annotierten Tag atomar pushen. Rollback darf nach erfolgreichem
  Push oder unklarem Transportergebnis keinen publizierten Zustand umschreiben.
  Bei unklarem Ergebnis Remote-Refs lesen oder manuelle Recovery verlangen.
- [ ] Parallel gestartete Schnitte reservieren nie durch Force-Push: ein zweiter
  Push desselben Tags scheitert. Danach neu prüfen und neue Version berechnen.
- [ ] Dry-run-Text/Help/Preview auf CalVer umstellen, besonders die bisherige
  Ableitung des Release-Typs aus `.0`-Suffixen entfernen.

Tests: kein CalVer-Tag → `.1`; `.2` und `.10` → `.11`; Lücken;
September→Oktober; Dezember→Januar; UTC-Monatsgrenze; Dev-/Legacy-Tags;
Monat 0/13; Padding; N=0; Chrome-Überlauf; Zukunftstag;
Root-Version höher als Tags; Legacy-Aufruf; keine Mutation im Dry-run;
Push-Konflikt, atomarer Erfolg, unklarer Remote-Ausgang und Rollback.
Git-Fixtures nach dem vorhandenen Muster in `scripts/release.test.ts` isolieren.

### 2. Release-Notes und Workflow-Konsistenz

Dateien: `cliff.toml`, `scripts/release.ts`, `.github/workflows/release.yml`,
`scripts/ci/workflow-policy.test.ts`; passende neue Changelog-Fixturetests unter `scripts/`.

- [ ] Stable-Vorgänger explizit auswählen: höchster numerischer, von HEAD
  erreichbarer Stable-Tag, inklusive historischer `v0.x`; Dev-Tags ausschließen.
  Dieselbe Basis für Changelog, Thanks und New Contributors verwenden.
- [ ] `feat!:`/`fix(scope)!:` und `BREAKING CHANGE:` im Body unter einer
  priorisierten Breaking-Changes-Gruppe rendern. Nicht durch gewöhnliche
  feat/fix-Parser verdecken lassen.
- [ ] GitHub-Release-Notes aus dem exakten neuen CHANGELOG-Abschnitt erstellen;
  bestehenden Checksums-/Installationsblock ergänzen. Der aktuelle rohe git-log
  Fallback würde die redaktionellen Migrationshinweise verlieren.
- [ ] Workflow-Eingabe/Beispiele auf CalVer umstellen; neue Stable-Schnitte
  strikt validieren. Historische Artefakt-/Metadaten-Validatoren weiterhin
  Legacy-Versionen lesen lassen. Kein Schema-Bump allein für neue Versionszahlen.
- [ ] Tag/Root-Version/exakter SHA, Draft-Verifikation, native Smokes und
  Public-Verifikation unverändert als Gates erhalten. Keine neue Release-Cut-CI
  und kein Wechsel auf das Shell-System von agentglass nötig.

Tests: vorheriger Dev-Tag, erster CalVer-Release nach v0.17.2, Breaking-Header
und Body-Footer, fehlender Changelog-Abschnitt führt zum Abbruch;
Versionen `2026.10.1` und `2026.10.10` in Stable-/Dev-Identität und Assetnamen;
Update-Vergleich Legacy→CalVer, Monats-/Jahreswechsel und gleiche Basis mit Dev.

### 3. Dokumentation, Probe und erster Release

Dateien: `src/content/docs/contributing.md`,
`src/content/docs/reference/versioning.md`,
`src/content/docs/reference/updating.md`, `CLAUDE.md` sowie dieser Plan.

- [ ] Produkt-CalVer und Bibliotheks-SemVer klar auseinanderhalten; Release-
  Beispiele, Dry-run-Pflicht, UTC, Zähler, Breaking-Policy und Recovery erklären.
- [ ] Historische Specs nicht massenhaft umschreiben. Aktuelle Runbooks haben Vorrang.
- [ ] Homebrew-Tap read-only prüfen: generischer Stable-Updater, Formula-Version,
  Download-URL, Checksums und Binary-Test müssen `2026.10.1` akzeptieren. Der Tap
  war in dieser Analyse nicht lokal verfügbar; GitHub-Abfrage scheiterte an Netzwerkzugriff.
- [ ] Lokal Dry-run und Preview durchführen, ohne einen Remote-Tag zu erzeugen.
  Ein Dry-run ist kein Beweis für GitHub-Publikation oder Homebrew-Installation.
- [ ] Vor Implementierungs-Commit nach Repo-Regel Live-E2E mit mayflower/DOCSY/
  ATLCLI durchführen und erzeugte Ressourcen entfernen. Erst danach committen.
- [ ] Ersten tatsächlichen Release separat autorisieren. Anschließend exakten
  SHA/Tag, neun Stable-Assets, Metadaten/Checksums, CLI release-info und Chrome-
  Manifest nach Download prüfen; Homebrew-Workflow bis zum Ergebnis verfolgen,
  `brew info atlcli` und installierte Binary-Version kontrollieren.

## Verifikationsbefehle für die Implementierung

Alle Shell-Aufrufe mit `rtk` bzw. `rtk proxy` ausführen.

```sh
bun run test scripts/release.test.ts scripts/release-artifacts.test.ts packages/core/src/update.test.ts apps/extension/release-context.test.ts scripts/ci/workflow-policy.test.ts scripts/ci/github-release-transaction.test.ts
bun run typecheck
bun run docs:check
bun run docs:build
bun scripts/release.ts --dry-run
bun scripts/release.ts --preview
git diff --check
```

Zusätzlich alle neu hinzugefügten Helper-/Changelog-Tests über `bun run test`
ausführen. Erwartung: exit 0, keine Tag-/Package-Mutation durch Probeaufrufe.
Nie bare `bun test` verwenden. Kein Push und kein Release ohne ausdrückliche Freigabe.

## Bereits erhobene Belege und Grenzen

- 34 bestehende Tests aus Release, Artefaktidentität, Update und Extension-Kontext:
  bestanden. Lokale Bun-Version 1.3.14; CI/Repo pinnt 1.4.2. Dieser Lauf ist keine
  vollständige CI-Freigabe mit dem gepinnten Runtime.
- Bestehende Funktionen direkt mit `2026.10.1` geprüft: Stable-/Dev-Identität,
  Chrome-Version und vier Vergleiche (Legacy, Monatswechsel, zweistellige N,
  Jahreswechsel) funktionieren ohne Codeänderung.
- agentglass Release-Library- und Publish-Fixturetests: bestanden.
- Keine Implementierung, E2E-Ressourcen, Commits, Tags, Pushes oder Veröffentlichungen.

## Offene Entscheidungen

- Zeitpunkt/Inhalt des ersten CalVer-Releases erst nach Umsetzung festlegen;
  Oktober 2026 ist ein Beispiel, keine reservierte Release-Version.

Aufwand: grob 1–2 Entwicklungstage inklusive Tests/Dokumentation, zuzüglich
Live-E2E und erster Release-/Homebrew-Verifikation. Hauptgefahr ist die
Release-Transaktion bzw. falsche Changelog-Basis, nicht das Zahlenformat.
