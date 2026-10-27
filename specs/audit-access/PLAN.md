# Plan: `atlcli audit access` – Zugriffs-Governance als scriptbares Audit

## Kontext
Wer darf in Confluence und Jira was sehen oder ändern? Heute beantwortet atlcli das nicht:
- Es gibt keine Verben oder Client-Methoden für Space-Berechtigungen, Gruppen, Jira-Projektrollen oder Permission Schemes.
- Die Wiki-Regel `content/restricted` löst nie aus. Sie liest `pages.is_restricted` aus der Sync-DB, und kein Pull setzt diesen Wert je auf `true` (`apps/cli/src/commands/docs.ts:1540`, `packages/confluence/src/sync-db/types.ts:429`).

Ziel ist ein drittes Audit-Produkt, `audit access`, auf dem bestehenden Audit- und Script-Framework. Es baut ein produktübergreifendes Zugriffsmodell (Spaces, Projekte, Gruppen, User, über die `accountId` verknüpft), prüft es mit sandboxierten Regel-Skripten und erzeugt Fix-Pläne, die erst nach Review angewendet werden.

**Entscheidungen des Users:**
- eigener Befehl `audit access`
- Org-Admin-API erst in Phase 3
- Lesen und Fixes in einem PR
- Seiten-Restrictions nur opt-in und eingegrenzt

Branch: `feat/audit-access`. Spec: `specs/audit-access/PLAN.md`.

## Was die APIs mit einem normalen API-Token hergeben
(Recherche 2026-10-27, Quellen in der Spec)

**Confluence**
- `GET /wiki/api/v2/spaces/{id}/permissions`: `principal` (user/group/role, anonym = `role ANONYMOUS`) und `operation`. Lesbar für jeden, der den Space sieht.
- Seit dem Rollenmodell zusätzlich:
  - `GET /wiki/api/v2/space-role-mode` (`PRE_ROLES` / `ROLES_TRANSITION` / `ROLES`)
  - `/space-roles`
  - `/spaces/{id}/role-assignments`
- Seitenebene:
  - Restrictions über v1 `/content/{id}/restriction/byOperation` (vorhanden) oder v2 `/pages/{id}/permissions` (mit `createdAt`)
  - Vorfahren über `/pages/{id}/ancestors`
- Gruppen über v1 `/group`, `/group/{groupId}/membersByGroupId`.
- User über v1 `/user/bulk` (max. 100): `accountStatus`, `accountType`, `isExternalCollaborator`, `isGuest`.

**Jira**
- `GET /rest/api/3/permissionscheme?expand=all`: Holder `anyone` / `group` / `projectRole` / `user` / `applicationRole` …
- `GET /project/{key}/permissionscheme` und `/project/{key}/role/{id}`: Akteure, braucht **Administer Projects**.
- `/group/member` (mit `active`).
- `/users/search` (alle User inklusive inaktiver, `accountType`).
- `/mypermissions`: was der Aufrufer prüfen darf.

**Nicht ohne Admin oder Org-Key:**
- unsichtbare Spaces und Projekte
- eingeschränkte Seiten (außer mit Admin-Key)
- Rollen-Akteure fremder Projekte
- Issue Security
- letzte Aktivität

Deshalb meldet der Lauf eine **Abdeckung** (was gelesen werden konnte und was nicht), statt Lücken zu verschweigen.

---

## A. Client-Methoden (`packages/confluence`, `packages/jira`)

**Confluence** (`packages/confluence/src/client.ts`; vorhandene Helfer `requestV2` und `request` nutzen):
- `getSpacePermissionsV2(spaceId)`
- `getSpaceRoleMode()`, `listSpaceRoles()`, `getSpaceRoleAssignments(spaceId)`
- `listGroups()`, `getGroupMembers(groupId)`
- `getUsersBulkV1(ids)` (Batches à 100, ersetzt die 5er-Einzelabrufe in `getUsersBulk`)
- `getPageAncestors(pageId)`
- Schreiben:
  - `removeSpacePermission(spaceKey, permissionId)` (v1 `DELETE /space/{key}/permission/{id}`)
  - `removeSpaceRoleAssignment(spaceId, …)`, **erst nach Live-Prüfung**: Endpunkt und Rechte des Rollen-Writes im Rollenmodus werden zuerst gegen `kiteweave` (Admin) verifiziert. Fehlt er, ist dieser Fix im Rollenmodus nicht verfügbar und wird übersprungen, mit einem Grund im Plan.
- Alle Listen-Endpunkte paginieren vollständig: v2 per Cursor, v1 per Offset, wie `listSpacesV2`.

**Jira** (`packages/jira/src/client.ts`):
- Lesen:
  - `listPermissionSchemes()`, `getProjectPermissionScheme(key)`
  - `getProjectRoles(key)` mit Akteuren
  - `getGroupMembers(groupId, {includeInactive})`, `searchAllUsers()` (`/users/search`, paginiert)
  - `myPermissions(keys)`
- Schreiben:
  - `removeProjectRoleActor(key, roleId, {accountId | groupId})`
  - `deletePermissionGrant(schemeId, permissionId)`

Alle Methoden laufen über die bestehende Retry- und 429-Behandlung der Clients. API-Reports neu erzeugen (`bun scripts/api-report.ts --update`).

## B. Script-Verben (`packages/script-runtime`)
Neue Verben, damit Regeln, Fixes und eigene Skripte dieselben Daten haben:

| Verb | Art | Permission |
|---|---|---|
| `confluence.spacePermissions(spaceKey)` | lesen | `confluence:read` |
| `confluence.spaceRoles()` / `confluence.roleAssignments(spaceKey)` | lesen | `confluence:read` |
| `confluence.groups()` / `confluence.groupMembers(groupId)` | lesen, Async-Iterator | `confluence:read` |
| `confluence.users(ids)` | lesen (bulk) | `confluence:read` |
| `confluence.removeSpacePermission(spaceKey, grant)` | **geplanter Write** | `confluence:write:<SPACE>` |
| `jira.permissionSchemes()` / `jira.projectRoles(key)` | lesen | `jira:read` |
| `jira.groupMembers(groupId)` | lesen, Async-Iterator | `jira:read` |
| `jira.removeRoleActor(key, role, principal)` | **geplanter Write** | `jira:write:<KEY>` |
| `jira.deletePermissionGrant(schemeId, permissionId)` | **geplanter Write** | `jira:write:*` (schemeweit) |

Writes folgen dem Muster von `confluence.setRestrictions` (`verbs-confluence.ts:76`):
- live gegen den aktuellen Stand prüfen, sonst `skipped: unchanged`
- `r.record`
- `apply.ts` ruft die Port-Methode auf

Port (`port.ts`), CLI-Port (`apps/cli/src/commands/script-port.ts`), Typen (`script-types.ts`) und Fixture-Replay bekommen die neuen Methoden.

## C. Zugriffsmodell (Host, neu `packages/audit/src/access.ts` + `apps/cli/src/commands/audit-access.ts`)
Wird einmal pro Lauf gesammelt, nach Bedarf der aktiven Regeln (`needs`, wie in `collectJiraAudit`):

```ts
interface AccessModel {
  spaces:   AccessSpace[];    // key, id, name, type, mode, grants[]
  projects: AccessProject[];  // key, name, style (classic/team), scheme, grants[] (aus Scheme + Rollen aufgelöst)
  groups:   AccessGroup[];    // id, name, product, memberCount, members? (accountIds)
  users:    AccessUser[];     // accountId, displayName, status, accountType, external, guest, products
  pages?:   AccessPage[];     // nur mit --pages: id, spaceKey, title, read/update direct, readEffective (Vorfahren-Schnitt)
  coverage: { spaces: {seen, unreadable[]}, projects: {seen, rolesUnreadable[]}, pages?: {checked, skipped}, notes[] };
}
interface AccessGrant { principal: {type: "user"|"group"|"anonymous"|"all-users"|"role"|"app-role"|"reporter"|…, id, name}; operation; via?: string }
```

- **Display-Namen** für User und Gruppen löst der Host einmal auf. Dafür werden `mentionNames` bzw. der neue Bulk-Abruf wiederverwendet; ein `AuditUser` bleibt `{id, displayName, active}`.
- **Parallelität** ist auf 8 begrenzt.
- **Fehlende Rechte** (403/404) werden zur Abdeckung, nicht zum Fehler.
- **Geltungsbereich:** `--space`/`--project` (Liste oder `*`), `--product confluence|jira|both`.
- **`--pages [--cql <q>]`** prüft Seiten-Restrictions. Der Standardumfang sind die Seiten der gewählten Spaces. Restrictions der Vorfahren werden pro Lauf gecacht, und es gibt eine Obergrenze `--max-pages` (Standard 5000) mit Abdeckungshinweis.

## D. Drittes Audit-Produkt `"access"` (`packages/audit`, `audit-scripts.ts`)

**Produktwert:** `"access"` an allen fest verdrahteten Stellen ergänzen:
- `rules.ts:19/71`
- `report.ts:32` und die Labels
- `AuditProduct` in `audit-scripts.ts`
- `script-types.ts:67`
- `audit.ts`-Switch
- `config.ts`: neue Sektion `access:` analog `confluence:` (`parseConfluenceAuditRules`)

**Target-Kinds:** `AuditTargetKind` um `"project" | "group" | "user"` erweitern (`"space"` gibt es schon), ebenso in `script-types.ts:179`.
- `RuleHit` bekommt optional `target: {kind, key, url?}`, damit Run-Regeln das Ziel selbst nennen. Bisher landet es als `"other"` oder mit falscher `/browse`-URL.
- Text-, Markdown- und CSV-Labels richten sich nach dem Kind.

**Items:** Regeln wählen per `meta.audit.items` eine der Gruppen `spaces | projects | users | groups | pages`.
- Item-Regeln laufen in Batches wie heute (`runItemRule`).
- `scope: "run"` bekommt das ganze `AccessModel` (`runDataRule`).
- Facts pro Item enthalten die aufgelösten Grants.

**Fix:** `fix(finding, item, rule)` bekommt das passende Item aus dem Modell, nicht `null` wie heute bei Run-Findings (`audit-scripts.ts:217`).

**Baseline:** `~/.atlcli/profiles/<p>/audit-access-baseline.json`, mit Subject-Schlüsseln wie `space:KEY|user:ID|read`.

**Ausgabe:** Alles Übrige wird wiederverwendet: `--checks`, `--min-level`, `--fail-on`, `--output`/`--format` (md/json/jsonl/csv, gestreamt), `--template`, `--report-script`, `--fix`/`--apply`/`--plan-out`, `--list-rules`/`--print-rule`, eigene Regeln aus `.atlcli/audit/`.

## E. Eingebaute Regeln (`apps/cli/src/builtin-scripts/audit/access/*.script`)

| id | Items | Prüft | Stufe (default) | Fix |
|---|---|---|---|---|
| `exposure/anonymous-space` | spaces | anonymer Lese- oder Schreibzugriff | error | Space-Recht entfernen |
| `exposure/anonymous-project` | projects | `anyone` mit Browse oder mehr im Scheme | error | Grant löschen (schemeweit, Detail nennt alle betroffenen Projekte) |
| `exposure/all-users` | spaces, projects | „alle lizenzierten User“ bzw. Standardgruppe mit Schreib- oder Adminrecht | warning | – |
| `stale/inactive-user-grant` | spaces, projects | inaktiver oder geschlossener User mit direktem Recht oder Rolle | warning | Recht bzw. Rollen-Akteur entfernen |
| `stale/inactive-in-restriction` | pages (`--pages`) | inaktiver User in einer Seiten-Restriction | info | `setRestrictions` ohne ihn |
| `stale/empty-group-grant` | spaces, projects | Gruppe ohne aktive Mitglieder hält Rechte | info | – |
| `admin/no-active-admin` | spaces, projects | kein aktiver Admin (Space-Admin bzw. Administer Projects) | error | – |
| `admin/single-admin` | spaces, projects | genau ein aktiver Admin | info | – |
| `admin/external-admin` | spaces, projects | externer Collaborator, Gast oder App-Account mit Adminrecht | warning | – |
| `hygiene/direct-user-grants` | spaces, projects | mehr als N (Option, Standard 10) direkte User-Rechte statt Gruppen | info | – |
| `hygiene/unmigrated-access` | spaces | Rollenmodus `ROLES_TRANSITION` und Space hat noch Custom Access | info | – |
| `pages/locked-out` | pages (`--pages`) | Restriction, bei der kein aktiver User mehr bearbeiten darf | warning | – |
| `reach/broad-admin` | run, users | User mit Adminrecht in mehr als N Spaces oder Projekten (Option, Standard 10) | info | – |

**Profile:** `minimal` umfasst nur `exposure/*` und `admin/no-active-admin`; `strict` enthält alle Regeln.

**Fix-Pläne** laufen read-only geprüft durch die Sandbox, wie bei Jira und Wiki. Vor dem Apply zeigen sie Space bzw. Projekt, Prinzipal mit Klarnamen und das Recht.

## F. Regressionsfix `content/restricted` (Wiki-Audit)
- `buildPageSnapshots` (`audit-wiki.ts:403`) füllt `restricted` künftig live über `getContentRestrictions` statt aus der toten Spalte. Das passiert nur, wenn die Regel aktiv ist (`needs: ["restrictions"]`), parallel und begrenzt.
- `wiki docs pull` setzt `is_restricted` beim Pull ebenfalls, damit `--restricted` offline wieder stimmt.
- Regressionstest: Eine Seite mit Restriction löst die Regel aus.

## G. Doku und Skill (im selben PR)
- **Neu `src/content/docs/access-audit.md`** mit Voraussetzungen und benötigten Rechten (Tabelle: was ohne Admin sichtbar ist), Schritten, Optionen, minimalem und realistischem Beispiel (CI mit `--fail-on error`, Fix-Plan), Abdeckung und Troubleshooting (403, Rollenmodus, eingeschränkte Seiten).
- **Anpassen:** `audit-scripts.md` (Produkt `access`, Items, Target-Kinds), `reference/scripts.md` (neue Verben), `reference/cli-commands.md`, `confluence/audit.md` (`content/restricted`), `astro.config.mjs`-Navigation, CHANGELOG via Commits.
- **Skill:** neu `skills/atlcli/references/access-audit.md`, plus Ergänzungen in `scripts.md`.

## Phase 3 (nicht in diesem PR, nur in der Spec)
- Org-Admin-API mit Bearer-Key im Profil: `lastActiveTimestamp` pro Produkt, gesperrte User, Gäste, Regel `stale/dormant-user-grant` (seit N Tagen inaktiv).
- Zugriffs-Snapshots und Diff: „wer hat seit letzter Woche Admin bekommen“.

## Reihenfolge (Commits)
1. Spec
2. A: Client-Methoden mit Stub-Tests
3. B: Verben, Port, Apply
4. D: Produkt `access` und Target-Kinds
5. C: Zugriffsmodell und Abdeckung
6. E: Regeln und Fixes
7. F: `content/restricted`
8. G: Doku, Skill, API-Reports

## Verifikation
**Unit**
- Paginierung aller neuen Client-Methoden (Cursor und Offset), 403 wird zur Abdeckung.
- Auflösung von Scheme und Rollen zu Grants.
- Schnitt der Lese-Restrictions über die Vorfahren.
- Jede Regel mit Treffer- und Nicht-Treffer-Fall.
- Fix-Pläne: unverändert führt zu skip; Apply ruft die richtige Port-Methode auf.
- Baseline-Subjects, Target-Kinds in md/csv/json.
- Config-Sektion `access:`.

**CLI-Stub-Tests** (`Bun.serve`):
- `audit access` über beide Produkte.
- `--fail-on`, `--fix --plan-out`, dann `script apply`.

**Live**
- `mayflower` (nur DOCSY/ATLCLI, ohne Adminrechte): `audit access --space DOCSY --project ATLCLI`. Erwartet wird eine sauber gemeldete Abdeckung (Rollen-Akteure eventuell nicht lesbar).
- `kiteweave` (Admin):
  - temporären Space und temporäres Projekt anlegen
  - anonymen Zugriff, einen deaktivierten Test-User bzw. eine Gruppe und eine Restriction setzen
  - Findings prüfen, `--fix --apply` ausführen, prüfen, dass die Rechte entfernt sind
  - Rollenmodus-Write für Spaces verifizieren
  - danach alles löschen
- `audit wiki --checks content/restricted` in DOCSY mit einer Testseite mit Restriction, danach aufräumen.

**Abschluss:** `bun run typecheck`, `bun run test`. Merge und Release nur auf Go.

## Offene Punkte (werden beim Bau live geklärt, nicht vorab)
- Gibt es im Rollenmodus einen REST-Write für Rollen-Zuweisungen? Wenn nicht, gibt es den Fix nur im Modus `PRE_ROLES`.
- Wie erkennt man „alle lizenzierten User“ bei Confluence (Principal-Typ im v2-Response)? Wird am kiteweave-Space beobachtet.
- Team-managed Jira-Projekte haben kein Permission Scheme. Erfasst werden ihre Rollen; ihr Zugriffsmodus (open/limited/private) kommt aus `/project/{key}`.
