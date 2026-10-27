/**
 * `audit access`: who can see and change what in Confluence and Jira. The
 * host reads space permissions and roles, permission schemes and project
 * roles, groups and users into one model (joined on Atlassian account ids);
 * rule scripts judge its spaces, projects, pages and users in the sandbox.
 * Grant building and the run are pure here; fetching lives in the CLI.
 */
import { type AuditRegistry, type AuditRules, type AuditSeverity, isRuleActive, isRuleOff, ruleTitle } from "./config.js";
import { type AuditBaseline, type AuditFinding, type AuditReportV3, type AuditTargetKind, buildReport, type CandidateFinding, sortCandidates } from "./report.js";
import { type AuditRuleScript, type RuleHit, type RunRuleOptions, runDataRule, runItemRule } from "./rules.js";

export type AccessLevel = "read" | "write" | "admin";
export const ACCESS_LEVEL_RANK: Record<AccessLevel, number> = { read: 0, write: 1, admin: 2 };

/**
 * Who holds access. `all-users`: every licensed user (Confluence access class,
 * Jira application role); `product-admins`: site and product admins;
 * `dynamic`: decided per issue (reporter, assignee, project lead, a field).
 */
export type AccessPrincipalType = "user" | "group" | "anonymous" | "all-users" | "product-admins" | "dynamic";

export interface AccessPrincipal {
  type: AccessPrincipalType;
  id: string;
  name: string;
  /** Users: null when the account could not be looked up. */
  active?: boolean | null;
  /** Users: atlassian, app, customer. */
  accountType?: string;
  /** Users: an external collaborator or guest. */
  external?: boolean;
  /** Groups: members whose account is active; null when the members could not be read. */
  activeMembers?: number | null;
}

/** One principal's access to a resource through one path: a role, or direct grants. */
export interface AccessGrant {
  principal: AccessPrincipal;
  level: AccessLevel;
  /** Confluence `operation:target` keys or Jira permission keys. */
  operations: string[];
  /** The Confluence space role or Jira project role the access comes through. */
  role?: { id: string; name: string };
  /** Jira: the permission scheme grants that name the principal directly. */
  grantIds?: number[];
}

export interface AccessUser {
  accountId: string;
  displayName: string;
  active: boolean | null;
  /** active, inactive, closed, unknown. */
  status: string;
  accountType: string;
  external: boolean;
  guest: boolean;
}

export interface AccessGroup {
  id: string;
  name: string;
  activeMembers: number | null;
  /** Account ids of the members (for access through the group). */
  members: string[];
}

/** A space or project, what space and project rules get. */
export interface AccessResource {
  kind: "space" | "project";
  product: "confluence" | "jira";
  key: string;
  id: string;
  name: string;
  url?: string;
  /** Spaces: PRE_ROLES, ROLES_TRANSITION or ROLES. Projects: classic or team. */
  mode: string;
  /** Projects: the permission scheme. */
  scheme?: { id: number; name: string };
  grants: AccessGrant[];
  /** False when some grants could not be read (see `note`); rules see what was readable. */
  complete: boolean;
  note?: string;
}

/** A page with its restrictions (`--pages`), what page rules get. */
export interface AccessPage {
  kind: "page";
  id: string;
  title: string;
  spaceKey: string;
  url?: string;
  parentId: string | null;
  /** Who may view (empty: no restriction on the page itself). */
  read: AccessPrincipal[];
  /** Who may edit (empty: no restriction on the page itself). */
  update: AccessPrincipal[];
  /** Read restrictions of ancestors, nearest first: a viewer must pass each of them too. */
  inheritedRead: Array<{ pageId: string; title: string; principals: AccessPrincipal[] }>;
}

/** A user with everything they can reach, what user rules get. */
export interface AccessUserItem extends AccessUser {
  kind: "user";
  access: Array<{ kind: "space" | "project"; key: string; name: string; level: AccessLevel; via: string }>;
}

export interface AccessCoverage {
  spaces: number;
  projects: number;
  pages: number;
  /** Resources whose grants are incomplete, with why. */
  incomplete: Array<{ kind: string; key: string; note: string }>;
  notes: string[];
}

export interface AccessModel {
  resources: AccessResource[];
  pages: AccessPage[];
  users: AccessUser[];
  groups: AccessGroup[];
  coverage: AccessCoverage;
}

// ============================================================================
// Grants from Confluence space permissions and roles
// ============================================================================

export interface SpacePermissionRecord {
  id: string;
  principal: { type: string; id: string };
  operation: string;
  targetType: string;
}

export interface SpaceRoleRecord {
  id: string;
  name: string;
  permissions: string[];
}

export interface SpaceRoleAssignmentRecord {
  roleId: string;
  principal: { type: string; id: string };
}

/** Confluence access classes and principal types as one principal type. */
export function confluencePrincipalType(type: string, id: string): AccessPrincipalType {
  const t = type.toLowerCase();
  if (t === "user") return "user";
  if (t === "group") return "group";
  const cls = id.toUpperCase().replace(/-/g, "_");
  if (cls.includes("ANONYMOUS")) return "anonymous";
  if (cls === "ALL_LICENSED_USERS") return "all-users";
  if (cls === "ALL_PRODUCT_ADMINS") return "product-admins";
  return "dynamic";
}

const WRITE_TARGETS = new Set(["page", "blogpost", "attachment", "whiteboard", "database", "folder", "embed"]);

/**
 * Access level of a space permission record (`administer:space`, `create:page`,
 * `read:space`, …). `delete:space` is "delete own content", which viewers have too.
 */
export function confluenceOperationLevel(operation: string, targetType: string): AccessLevel {
  if (operation === "administer" && targetType === "space") return "admin";
  if (["create", "update", "delete", "archive", "restrict_content"].includes(operation) && WRITE_TARGETS.has(targetType)) return "write";
  return "read";
}

/** Access level of a space role from its permission names (`administer/space`, `write/space`, …). */
export function confluenceRoleLevel(permissions: string[]): AccessLevel {
  if (permissions.some((p) => /^(administer|manage)\/space/.test(p) || p.includes("admin"))) return "admin";
  if (permissions.some((p) => /^(write|edit|create|manage|archive)\//.test(p) || (/^delete\//.test(p) && !p.includes("own")))) return "write";
  return "read";
}

const maxLevel = (levels: AccessLevel[]): AccessLevel => levels.reduce<AccessLevel>((a, b) => (ACCESS_LEVEL_RANK[b] > ACCESS_LEVEL_RANK[a] ? b : a), "read");
const principalKey = (p: { type: string; id: string }) => `${p.type}\u0000${p.id}`;

/**
 * A space's grants: one per principal from its permission records, with the
 * role it holds attached; a role holder without records gets the role's level.
 */
export function confluenceSpaceGrants(
  permissions: SpacePermissionRecord[],
  assignments: SpaceRoleAssignmentRecord[],
  roles: SpaceRoleRecord[],
  principal: (type: AccessPrincipalType, id: string) => AccessPrincipal,
): Array<AccessGrant & { permissionIds: string[] }> {
  const roleById = new Map(roles.map((r) => [r.id, r]));
  const roleOf = new Map<string, SpaceRoleRecord>();
  for (const a of assignments) {
    const role = roleById.get(a.roleId);
    const type = confluencePrincipalType(a.principal.type, a.principal.id);
    if (role) roleOf.set(principalKey({ type, id: normalizeClassId(type, a.principal.id) }), role);
  }
  const byPrincipal = new Map<string, { type: AccessPrincipalType; id: string; ops: string[]; levels: AccessLevel[]; ids: string[] }>();
  for (const p of permissions) {
    const type = confluencePrincipalType(p.principal.type, p.principal.id);
    const id = normalizeClassId(type, p.principal.id);
    const key = principalKey({ type, id });
    const entry = byPrincipal.get(key) ?? { type, id, ops: [], levels: [], ids: [] };
    entry.ops.push(`${p.operation}:${p.targetType}`);
    entry.levels.push(confluenceOperationLevel(p.operation, p.targetType));
    entry.ids.push(p.id);
    byPrincipal.set(key, entry);
  }
  for (const [key, role] of roleOf) {
    if (byPrincipal.has(key)) continue;
    const [type, id] = key.split("\u0000") as [AccessPrincipalType, string];
    byPrincipal.set(key, { type, id, ops: [], levels: [confluenceRoleLevel(role.permissions)], ids: [] });
  }
  return [...byPrincipal.entries()].map(([key, e]) => {
    const role = roleOf.get(key);
    return {
      principal: principal(e.type, e.id),
      level: maxLevel(role ? [...e.levels, confluenceRoleLevel(role.permissions)] : e.levels),
      operations: [...new Set(e.ops)].sort(),
      ...(role ? { role: { id: role.id, name: role.name } } : {}),
      permissionIds: e.ids,
    };
  });
}

/** Access classes come as ALL_LICENSED_USERS or all-licensed-users; one spelling for both. */
function normalizeClassId(type: AccessPrincipalType, id: string): string {
  return type === "user" || type === "group" ? id : id.toUpperCase().replace(/-/g, "_");
}

// ============================================================================
// Grants from Jira permission schemes and project roles
// ============================================================================

export interface PermissionSchemeGrant {
  id: number;
  permission: string;
  holder: { type: string; value?: string; parameter?: string; name?: string };
}

export interface ProjectRoleRecord {
  id: number;
  name: string;
  actors: Array<{ type: "user" | "group"; id: string; name: string }>;
}

const JIRA_WRITE = new Set([
  "CREATE_ISSUES",
  "EDIT_ISSUES",
  "TRANSITION_ISSUES",
  "DELETE_ISSUES",
  "ASSIGN_ISSUES",
  "RESOLVE_ISSUES",
  "CLOSE_ISSUES",
  "MOVE_ISSUES",
  "SCHEDULE_ISSUES",
  "LINK_ISSUES",
  "MANAGE_SPRINTS_PERMISSION",
  "EDIT_ALL_COMMENTS",
  "DELETE_ALL_COMMENTS",
  "DELETE_ALL_ATTACHMENTS",
  "EDIT_ALL_WORKLOGS",
  "DELETE_ALL_WORKLOGS",
  "MODIFY_REPORTER",
]);

/** Access level of a set of Jira project permissions; undefined without Browse or Administer. */
export function jiraPermissionLevel(permissions: string[]): AccessLevel | undefined {
  if (permissions.includes("ADMINISTER_PROJECTS")) return "admin";
  if (!permissions.includes("BROWSE_PROJECTS")) return undefined;
  return permissions.some((p) => JIRA_WRITE.has(p)) ? "write" : "read";
}

/**
 * A project's grants from its permission scheme: role grants become one grant
 * per role actor (when the roles could be read), the rest one per holder.
 * Team-managed projects mirror their access level (open, limited) as
 * application role grants that also list Administer Projects; administration
 * there goes through the Administrator role only, so those grants count as
 * edit access at most.
 */
export function jiraProjectGrants(
  scheme: PermissionSchemeGrant[],
  roles: ProjectRoleRecord[] | undefined,
  principal: (type: AccessPrincipalType, id: string, name?: string) => AccessPrincipal,
  teamManaged = false,
): AccessGrant[] {
  const paths = new Map<string, { type: AccessPrincipalType; id: string; name?: string; role?: { id: string; name: string }; perms: string[]; grantIds: number[] }>();
  const add = (type: AccessPrincipalType, id: string, name: string | undefined, permission: string, role?: { id: string; name: string }, grantId?: number) => {
    const key = `${type}\u0000${id}\u0000${role?.id ?? ""}`;
    const entry = paths.get(key) ?? { type, id, ...(name ? { name } : {}), ...(role ? { role } : {}), perms: [], grantIds: [] };
    entry.perms.push(permission);
    if (grantId !== undefined) entry.grantIds.push(grantId);
    paths.set(key, entry);
  };
  const roleById = new Map((roles ?? []).map((r) => [String(r.id), r]));
  for (const g of scheme) {
    const h = g.holder;
    switch (h.type) {
      case "projectRole": {
        const role = roleById.get(String(h.value ?? h.parameter));
        for (const a of role?.actors ?? []) add(a.type, a.id, a.name, g.permission, { id: String(role!.id), name: role!.name });
        break;
      }
      case "group":
        add("group", String(h.value ?? h.parameter), h.name ?? h.parameter, g.permission, undefined, g.id);
        break;
      case "user":
        add("user", String(h.value ?? h.parameter), h.name, g.permission, undefined, g.id);
        break;
      case "anyone":
        add("anonymous", "anyone", "Anyone (anonymous)", g.permission, undefined, g.id);
        break;
      case "applicationRole":
        add("all-users", h.value || h.parameter || "any", h.value || h.parameter ? `Users of ${h.value ?? h.parameter}` : "All licensed users", g.permission, undefined, g.id);
        break;
      default:
        add("dynamic", h.parameter ? `${h.type}:${h.parameter}` : h.type, h.type, g.permission, undefined, g.id);
    }
  }
  const out: AccessGrant[] = [];
  for (const e of paths.values()) {
    let level = jiraPermissionLevel(e.perms);
    if (!level) continue;
    // ponytail: inferred from the scheme Jira shows for team-managed projects; verify against a non-admin account if findings look off.
    if (teamManaged && e.type === "all-users" && level === "admin") level = jiraPermissionLevel(e.perms.filter((p) => p !== "ADMINISTER_PROJECTS")) ?? "read";
    out.push({
      principal: principal(e.type, e.id, e.name),
      level,
      operations: [...new Set(e.perms)].sort(),
      ...(e.role ? { role: e.role } : {}),
      ...(e.grantIds.length ? { grantIds: e.grantIds } : {}),
    });
  }
  return out;
}

// ============================================================================
// Pages: effective read restrictions
// ============================================================================

/** Read restrictions of each page's ancestors, nearest first, from parent links within the fetched pages. */
export function inheritedReadRestrictions(pages: Array<Pick<AccessPage, "id" | "title" | "parentId" | "read">>): Map<string, AccessPage["inheritedRead"]> {
  const byId = new Map(pages.map((p) => [p.id, p]));
  const out = new Map<string, AccessPage["inheritedRead"]>();
  for (const page of pages) {
    const chain: AccessPage["inheritedRead"] = [];
    const seen = new Set([page.id]);
    let parent = page.parentId ? byId.get(page.parentId) : undefined;
    while (parent && !seen.has(parent.id)) {
      seen.add(parent.id);
      if (parent.read.length) chain.push({ pageId: parent.id, title: parent.title, principals: parent.read });
      parent = parent.parentId ? byId.get(parent.parentId) : undefined;
    }
    out.set(page.id, chain);
  }
  return out;
}

// ============================================================================
// Users
// ============================================================================

/** Every user with what they reach, directly or through a group in a grant. */
export function accessUserItems(model: Pick<AccessModel, "resources" | "users" | "groups">): AccessUserItem[] {
  const items = new Map<string, AccessUserItem>(model.users.map((u) => [u.accountId, { ...u, kind: "user", access: [] }]));
  const groups = new Map(model.groups.map((g) => [g.id, g]));
  for (const r of model.resources) {
    for (const g of r.grants) {
      const via = g.role ? `role ${g.role.name}` : "direct";
      if (g.principal.type === "user") {
        items.get(g.principal.id)?.access.push({ kind: r.kind, key: r.key, name: r.name, level: g.level, via });
      } else if (g.principal.type === "group") {
        for (const member of groups.get(g.principal.id)?.members ?? []) {
          items.get(member)?.access.push({ kind: r.kind, key: r.key, name: r.name, level: g.level, via: `group ${g.principal.name}${g.role ? ` (role ${g.role.name})` : ""}` });
        }
      }
    }
  }
  return [...items.values()];
}

// ============================================================================
// The run
// ============================================================================

/** Which items a rule judges: `meta.audit.items`. */
export type AccessItems = "resources" | "spaces" | "projects" | "pages" | "users";
export const ACCESS_ITEMS: readonly AccessItems[] = ["resources", "spaces", "projects", "pages", "users"];

export interface AccessAuditInput {
  rules: AuditRules;
  registry: AuditRegistry;
  scripts: AuditRuleScript[];
  model: AccessModel;
  now: Date;
  baseline?: AuditBaseline;
  useBaseline: boolean;
  partial?: string[];
  diagnostics?: string[];
  query: string;
  /** Page rules run only when pages were read (`--pages`). */
  pagesRead: boolean;
}

type AccessItem = AccessResource | AccessPage | AccessUserItem;

/** The items of a kind, as rules see them. */
export function accessItems(model: AccessModel, items: AccessItems, users?: AccessUserItem[]): AccessItem[] {
  switch (items) {
    case "spaces":
      return model.resources.filter((r) => r.kind === "space");
    case "projects":
      return model.resources.filter((r) => r.kind === "project");
    case "pages":
      return model.pages;
    case "users":
      return users ?? accessUserItems(model);
    default:
      return model.resources;
  }
}

/** Finding key of an item: space or project key, page id, account id. */
export const accessItemKey = (item: AccessItem): string => (item.kind === "user" ? item.accountId : item.kind === "page" ? item.id : item.key);

/** Runs every active access rule and builds the report. */
export async function auditAccess(input: AccessAuditInput, run: RunRuleOptions): Promise<{ report: AuditReportV3; candidates: AuditFinding[]; items: Map<string, AccessItem> }> {
  const { rules, registry, model } = input;
  const users = accessUserItems(model);
  const items = new Map<string, AccessItem>();
  for (const kind of ["resources", "pages", "users"] as const) for (const item of accessItems(model, kind, users)) items.set(`${item.kind}:${accessItemKey(item)}`, item);
  const raw: CandidateFinding[] = [];
  const diagnostics = [...(input.diagnostics ?? [])];
  for (const script of input.scripts) {
    const id = script.meta.id;
    if (!isRuleActive(rules, id, registry)) continue;
    const config = rules.rules[id] ?? {};
    const level = (config.level as AuditSeverity | undefined) ?? "warning";
    if (script.meta.scope === "run") {
      const hits = await runDataRule(script, { ...model, userAccess: users }, config, run);
      for (const hit of hits) raw.push({ finding: assemble(script, hit, hit.target ? items.get(`${hit.target.kind}:${hit.target.key}`) : undefined, level) });
      continue;
    }
    if (isRuleOff(config, id, registry)) continue;
    const kind = (script.meta.items ?? "resources") as AccessItems;
    if (kind === "pages" && !input.pagesRead) {
      diagnostics.push(`${id} checks page restrictions; run with --pages to include it.`);
      continue;
    }
    const list = accessItems(model, kind, users);
    for (const { index, hits } of await runItemRule(script, list.map((item) => ({ item, config })), run)) {
      for (const hit of hits) raw.push({ finding: assemble(script, hit, list[index], level) });
    }
  }
  const order = new Map(registry.ids().map((rid, i) => [rid, i]));
  const candidates = sortCandidates(raw, (rid) => order.get(rid) ?? Number.MAX_SAFE_INTEGER);
  const report = buildReport({
    product: "access",
    query: input.query,
    rules,
    now: input.now,
    candidates,
    ...(input.baseline ? { baseline: input.baseline } : {}),
    useBaseline: input.useBaseline,
    partial: input.partial ?? [],
    diagnostics,
    titles: Object.fromEntries(registry.ids().map((rid) => [rid, ruleTitle(rid, registry)])),
  });
  return { report, candidates: candidates.map((c) => c.finding), items };
}

function assemble(script: AuditRuleScript, hit: RuleHit, item: AccessItem | undefined, level: AuditSeverity): AuditFinding {
  const target: AuditFinding["target"] = hit.target ?? (item ? { kind: item.kind as AuditTargetKind, key: accessItemKey(item), ...(item.kind !== "user" && item.url ? { url: item.url } : {}) } : { kind: "other", key: hit.key ?? "" });
  const name = item ? (item.kind === "user" ? item.displayName : item.kind === "page" ? item.title : item.name) : "";
  const principal = hit.principal;
  return {
    rule: script.meta.id,
    category: script.def.category,
    severity: hit.severity ?? level,
    target,
    key: hit.key ?? target.key,
    summary: hit.summary ?? name,
    status: hit.status ?? (item && item.kind !== "page" && item.kind !== "user" ? item.mode : ""),
    // A user finding's summary is already the user's name.
    ...((hit.assignee ?? principal?.name) && item?.kind !== "user" ? { assignee: (hit.assignee ?? principal?.name)! } : {}),
    detail: hit.detail,
    ...(hit.ageDays !== undefined ? { ageDays: Math.floor(hit.ageDays) } : {}),
    subject: hit.subject ?? `${target.kind}:${target.key}${principal ? `|${principal.type}:${principal.id}` : ""}`,
    ...(principal ? { principal } : {}),
    ...(script.hasFix ? { fixable: true } : {}),
  };
}
