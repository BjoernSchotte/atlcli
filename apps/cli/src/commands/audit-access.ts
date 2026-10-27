/**
 * `audit access` (spec audit-access): who can see and change what in
 * Confluence and Jira. Reads space permissions and roles, permission schemes
 * and project roles, groups and users (and, with --pages, page restrictions)
 * into one model, judged by access rule scripts. What could not be read
 * (no Administer Projects, invisible spaces) is reported as coverage.
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";
import { parse as parseYaml } from "yaml";
import { ERROR_CODES, type OutputOptions, type Profile, fail, getActiveProfile, getFlag, hasFlag, loadConfig, output } from "@atlcli/core";
import {
  AUDIT_SEVERITY_RANK,
  type AccessGroup,
  type AccessModel,
  type AccessPage,
  type AccessPrincipal,
  type AccessPrincipalType,
  type AccessResource,
  type AccessUser,
  AuditRulesError,
  AuditScriptError,
  type AuditSeverity,
  auditAccess,
  confluenceSpaceGrants,
  createAuditBaseline,
  inheritedReadRestrictions,
  jiraProjectGrants,
  parseSectionAuditRules,
  type PermissionSchemeGrant,
  type ProjectRoleRecord,
  pruneAuditBaseline,
  renderAuditText,
  resolveAuditChecks,
  restrictAuditRules,
  type SpacePermissionRecord,
  type SpaceRoleAssignmentRecord,
  type SpaceRoleRecord,
} from "@atlcli/audit";
import { ConfluenceClient } from "@atlcli/confluence";
import { JiraClient } from "@atlcli/jira";
import { emitAuditOutput, handleRuleListing, loadAuditScripts, registryOf, runAuditFixes, scriptFlags } from "./audit-scripts.js";
import { auditRulesCandidates, readBaseline } from "./audit-jira.js";
import { profileFilePath, writeJsonAtomic } from "./profile-paths.js";

type Flags = Record<string, string | boolean | string[]>;

const FAIL_ON = ["info", "warning", "error", "never"] as const;
const CONCURRENCY = 8;
const DEFAULT_MAX_PAGES = 5000;

export const accessBaselinePath = (profile: string) => profileFilePath(profile, "audit-access-baseline.json");

// ============================================================================
// Data source: the API calls the model needs (clients in the CLI, fakes in tests)
// ============================================================================

export interface AccessUserDetails {
  accountId: string;
  displayName: string;
  active: boolean | null;
  status: string;
  accountType: string;
  external: boolean;
  guest: boolean;
}

export interface AccessSource {
  confluence?: {
    spaces(keys: string[] | "*", personal: boolean): Promise<Array<{ id: string; key: string; name: string }>>;
    roleMode(): Promise<string>;
    roles(): Promise<SpaceRoleRecord[]>;
    permissions(spaceId: string): Promise<SpacePermissionRecord[]>;
    roleAssignments(spaceId: string): Promise<SpaceRoleAssignmentRecord[]>;
    groups(): Promise<Array<{ id: string; name: string }>>;
    groupMembers(groupId: string): Promise<AccessUserDetails[]>;
    users(accountIds: string[]): Promise<AccessUserDetails[]>;
    pages(spaceId: string, max: number): Promise<{ pages: Array<{ id: string; title: string; parentId: string | null }>; truncated: boolean }>;
    restrictions(pageId: string): Promise<{ read: { accountIds: string[]; groupIds: string[] }; update: { accountIds: string[]; groupIds: string[] } }>;
    url: { space(key: string): string; page(id: string): string };
  };
  jira?: {
    projects(keys: string[] | "*"): Promise<Array<{ id: string; key: string; name: string; style: string }>>;
    projectScheme(key: string): Promise<{ id: number; name: string }>;
    schemes(): Promise<Array<{ id: number; name: string; grants: PermissionSchemeGrant[] }>>;
    projectRoles(key: string): Promise<ProjectRoleRecord[]>;
    groups(): Promise<Array<{ id: string; name: string }>>;
    groupMembers(groupId: string): Promise<AccessUserDetails[]>;
    users(accountIds: string[]): Promise<AccessUserDetails[]>;
    url: { project(key: string): string };
  };
}

export interface AccessScope {
  spaces?: string[] | "*";
  projects?: string[] | "*";
  personal: boolean;
  /** Read page restrictions of the spaces in scope. */
  pages: boolean;
  maxPages: number;
}

/** Runs `fn` over `items`, at most `n` at a time, keeping the order. */
async function inPool<T, R>(items: T[], n: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  return out;
}

const why = (error: unknown): string => {
  const status = (error as { status?: number }).status;
  if (status === 401 || status === 403) return "not permitted";
  if (status === 404) return "not found or not visible";
  return error instanceof Error ? error.message : String(error);
};

/**
 * Reads the model: grants per space and project, then the users and groups
 * they name. A resource whose grants could not be read completely is kept
 * with `complete: false` and listed in the coverage.
 */
export async function collectAccessModel(source: AccessSource, scope: AccessScope): Promise<{ model: AccessModel; partial: string[] }> {
  const principals = new Map<string, AccessPrincipal>();
  const principal = (type: AccessPrincipalType, id: string, name?: string): AccessPrincipal => {
    const key = `${type}\u0000${id}`;
    let p = principals.get(key);
    if (!p) {
      p = { type, id, name: name ?? defaultName(type, id) };
      principals.set(key, p);
    } else if (name && p.name === defaultName(type, id)) {
      p.name = name;
    }
    return p;
  };
  const resources: AccessResource[] = [];
  const incomplete: AccessModel["coverage"]["incomplete"] = [];
  const notes: string[] = [];
  const partial: string[] = [];
  const spaceIds: Array<{ id: string; key: string }> = [];

  const c = source.confluence;
  if (c && scope.spaces !== undefined) {
    const spaces = await c.spaces(scope.spaces, scope.personal);
    const mode = await c.roleMode().catch(() => "PRE_ROLES");
    const roles = mode === "PRE_ROLES" ? [] : await c.roles().catch(() => []);
    await inPool(spaces, CONCURRENCY, async (space) => {
      const resource: AccessResource = { kind: "space", product: "confluence", key: space.key, id: space.id, name: space.name, url: c.url.space(space.key), mode, grants: [], complete: true };
      try {
        const [permissions, assignments] = await Promise.all([c.permissions(space.id), mode === "PRE_ROLES" ? [] : c.roleAssignments(space.id).catch(() => [])]);
        resource.grants = confluenceSpaceGrants(permissions, assignments, roles, principal).map(({ permissionIds: _, ...g }) => g);
      } catch (error) {
        resource.complete = false;
        resource.note = `permissions not readable (${why(error)})`;
        incomplete.push({ kind: "space", key: space.key, note: resource.note });
      }
      resources.push(resource);
      spaceIds.push({ id: space.id, key: space.key });
    });
  }

  const j = source.jira;
  if (j && scope.projects !== undefined) {
    const projects = await j.projects(scope.projects);
    const schemes = new Map((await j.schemes()).map((s) => [s.id, s]));
    await inPool(projects, CONCURRENCY, async (project) => {
      const resource: AccessResource = { kind: "project", product: "jira", key: project.key, id: project.id, name: project.name, url: j.url.project(project.key), mode: project.style, grants: [], complete: true };
      try {
        const ref = await j.projectScheme(project.key);
        const scheme = schemes.get(ref.id);
        resource.scheme = ref;
        let roles: ProjectRoleRecord[] | undefined;
        try {
          roles = await j.projectRoles(project.key);
        } catch (error) {
          resource.complete = false;
          resource.note = `role members not readable (${why(error)}; needs Administer Projects)`;
        }
        resource.grants = jiraProjectGrants(scheme?.grants ?? [], roles, principal, project.style === "team");
        if (!scheme) {
          resource.complete = false;
          resource.note = `permission scheme ${ref.name} not readable`;
        }
      } catch (error) {
        resource.complete = false;
        resource.note = `permission scheme not readable (${why(error)})`;
      }
      if (!resource.complete) incomplete.push({ kind: "project", key: project.key, note: resource.note! });
      resources.push(resource);
    });
  }

  const pages: AccessPage[] = [];
  if (c && scope.pages) {
    let budget = scope.maxPages;
    for (const space of spaceIds) {
      if (budget <= 0) {
        partial.push(`pages (--max-pages ${scope.maxPages})`);
        break;
      }
      const listed = await c.pages(space.id, budget).catch((error) => {
        notes.push(`Pages of ${space.key} not readable (${why(error)}).`);
        return { pages: [], truncated: false };
      });
      if (listed.truncated) partial.push(`pages of ${space.key} (--max-pages ${scope.maxPages})`);
      budget -= listed.pages.length;
      const restricted = await inPool(listed.pages, CONCURRENCY, async (p) => {
        const r = await c.restrictions(p.id).catch(() => undefined);
        const list = (set: { accountIds: string[]; groupIds: string[] } | undefined) => [
          ...(set?.accountIds ?? []).map((id) => principal("user", id)),
          ...(set?.groupIds ?? []).map((id) => principal("group", id)),
        ];
        return { kind: "page" as const, id: p.id, title: p.title, spaceKey: space.key, url: c.url.page(p.id), parentId: p.parentId, read: list(r?.read), update: list(r?.update), inheritedRead: [] };
      });
      const inherited = inheritedReadRestrictions(restricted);
      for (const page of restricted) pages.push({ ...page, inheritedRead: inherited.get(page.id) ?? [] });
    }
  }

  // Users and groups the grants and restrictions name.
  const userIds = [...principals.values()].filter((p) => p.type === "user").map((p) => p.id);
  const users: AccessUser[] = [];
  const userSource = c ?? j;
  if (userSource && userIds.length) {
    for (const u of await userSource.users(userIds).catch((error) => {
      notes.push(`Users could not be looked up (${why(error)}); their status is unknown.`);
      return [] as AccessUserDetails[];
    })) {
      users.push(u);
    }
  }
  const byUser = new Map(users.map((u) => [u.accountId, u]));
  const groupIds = [...principals.values()].filter((p) => p.type === "group").map((p) => p.id);
  const groupSource = j ?? c;
  const groupNames = new Map<string, string>();
  const groups: AccessGroup[] = [];
  if (groupSource && groupIds.length) {
    for (const g of await groupSource.groups().catch(() => [])) groupNames.set(g.id, g.name);
    await inPool(groupIds, CONCURRENCY, async (id) => {
      try {
        const members = await groupSource.groupMembers(id);
        for (const m of members) if (!byUser.has(m.accountId)) byUser.set(m.accountId, m);
        groups.push({ id, name: groupNames.get(id) ?? id, activeMembers: members.filter((m) => m.active !== false && m.accountType !== "app").length, members: members.map((m) => m.accountId) });
      } catch (error) {
        groups.push({ id, name: groupNames.get(id) ?? id, activeMembers: null, members: [] });
        notes.push(`Members of group ${groupNames.get(id) ?? id} not readable (${why(error)}).`);
      }
    });
  }
  const byGroup = new Map(groups.map((g) => [g.id, g]));
  for (const p of principals.values()) {
    if (p.type === "user") {
      const u = byUser.get(p.id);
      p.active = u ? u.active : null;
      if (u) {
        p.name = u.displayName || p.name;
        p.accountType = u.accountType;
        p.external = u.external || u.guest;
      }
    } else if (p.type === "group") {
      const g = byGroup.get(p.id);
      p.name = g?.name ?? groupNames.get(p.id) ?? p.name;
      p.activeMembers = g ? g.activeMembers : null;
    }
  }

  resources.sort((a, b) => a.kind.localeCompare(b.kind) || a.key.localeCompare(b.key));
  return {
    model: {
      resources,
      pages,
      users: [...byUser.values()].sort((a, b) => a.displayName.localeCompare(b.displayName)),
      groups: groups.sort((a, b) => a.name.localeCompare(b.name)),
      coverage: {
        spaces: resources.filter((r) => r.kind === "space").length,
        projects: resources.filter((r) => r.kind === "project").length,
        pages: pages.length,
        incomplete,
        notes,
      },
    },
    partial,
  };
}

function defaultName(type: AccessPrincipalType, id: string): string {
  if (type === "anonymous") return "Anyone (anonymous)";
  if (type === "all-users") return id === "ALL_LICENSED_USERS" || id === "any" ? "All licensed users" : `Users of ${id}`;
  if (type === "product-admins") return "Product admins";
  return id;
}

// ============================================================================
// The source over the API clients
// ============================================================================

const cursorOf = (next: unknown): string | undefined => {
  if (typeof next !== "string") return undefined;
  return new URL(next, "https://x").searchParams.get("cursor") ?? undefined;
};

/** Every item of a Confluence v2 list endpoint. */
async function allV2<T>(client: ConfluenceClient, path: string, query: Record<string, string | number> = {}, max = Infinity): Promise<{ items: T[]; truncated: boolean }> {
  const items: T[] = [];
  let cursor: string | undefined;
  do {
    const data = (await client.getJson(path, { query: { ...query, limit: 250, ...(cursor ? { cursor } : {}) } })) as { results?: T[]; _links?: { next?: string } };
    items.push(...(data.results ?? []));
    cursor = cursorOf(data._links?.next);
    if (items.length >= max) return { items: items.slice(0, max), truncated: Boolean(cursor) || items.length > max };
  } while (cursor);
  return { items, truncated: false };
}

const wikiBase = (baseUrl: string) => {
  const root = baseUrl.replace(/\/+$/, "");
  return /\.atlassian\.net$/.test(new URL(root).hostname) && !root.endsWith("/wiki") ? `${root}/wiki` : root;
};

const toDetails = (u: { accountId: string; displayName?: string; status?: string; active?: boolean; accountType?: string; external?: boolean; guest?: boolean }): AccessUserDetails => ({
  accountId: u.accountId,
  displayName: u.displayName ?? u.accountId,
  active: u.active ?? (u.status ? u.status === "active" : null),
  status: u.status ?? (u.active === undefined ? "unknown" : u.active ? "active" : "inactive"),
  accountType: u.accountType ?? "unknown",
  external: u.external ?? false,
  guest: u.guest ?? false,
});

export function clientAccessSource(profile: Profile, products: { confluence: boolean; jira: boolean }): AccessSource {
  const out: AccessSource = {};
  if (products.confluence) {
    const client = new ConfluenceClient(profile);
    const base = wikiBase(profile.baseUrl);
    out.confluence = {
      async spaces(keys, personal) {
        const query: Record<string, string | number> = { status: "current", ...(keys === "*" ? {} : { keys: keys.join(",") }) };
        const { items } = await allV2<{ id: string; key: string; name: string; type?: string }>(client, "/api/v2/spaces", query);
        // Shared spaces come as global, collaboration, knowledge_base, onboarding, …; only personal ones are left out.
        return items.filter((s) => keys !== "*" || personal || s.type !== "personal").map((s) => ({ id: String(s.id), key: s.key, name: s.name }));
      },
      roleMode: () => client.getSpaceRoleMode(),
      roles: async () => (await client.listSpaceRoles()).map((r) => ({ id: r.id, name: r.name, permissions: r.spacePermissions })),
      permissions: async (spaceId) =>
        (await client.getSpacePermissionsV2(spaceId)).map((p) => ({ id: String(p.id), principal: { type: p.principal.type, id: p.principal.id }, operation: p.operation.key, targetType: p.operation.targetType })),
      roleAssignments: async (spaceId) =>
        (await client.getSpaceRoleAssignments(spaceId)).map((a) => ({ roleId: a.roleId, principal: { type: a.principal.principalType, id: a.principal.principalId } })),
      groups: async () => {
        const out: Array<{ id: string; name: string }> = [];
        for (let start = 0; ; start += 200) {
          const data = (await client.getJson("/rest/api/group", { query: { start, limit: 200 } })) as { results?: Array<{ id: string; name: string }>; size?: number };
          out.push(...(data.results ?? []).map((g) => ({ id: g.id, name: g.name })));
          if ((data.results ?? []).length < 200) return out;
        }
      },
      groupMembers: async (groupId) => (await client.getGroupMembersById(groupId)).map(toDetails),
      users: async (ids) => (await client.getUsersDetails(ids)).map(toDetails),
      pages: async (spaceId, max) => {
        const { items, truncated } = await allV2<{ id: string; title: string; parentId?: string | null }>(client, `/api/v2/spaces/${spaceId}/pages`, { status: "current" }, max);
        return { pages: items.map((p) => ({ id: String(p.id), title: p.title, parentId: p.parentId ? String(p.parentId) : null })), truncated };
      },
      restrictions: (pageId) => client.getContentRestrictions(pageId),
      url: { space: (key) => `${base}/spaces/${encodeURIComponent(key)}`, page: (id) => `${base}/pages/viewpage.action?pageId=${id}` },
    };
  }
  if (products.jira) {
    const client = new JiraClient(profile);
    const base = profile.baseUrl.replace(/\/+$/, "");
    out.jira = {
      async projects(keys) {
        const out: Array<{ id: string; key: string; name: string; style: string }> = [];
        for (let startAt = 0; ; startAt += 50) {
          const query: Record<string, string | number> = { startAt, maxResults: 50, ...(keys === "*" ? {} : { keys: keys.join(",") }) };
          const data = (await client.getJson("/rest/api/3/project/search", { query })) as { values?: Array<{ id: string; key: string; name: string; style?: string }>; isLast?: boolean };
          out.push(...(data.values ?? []).map((p) => ({ id: String(p.id), key: p.key, name: p.name, style: p.style === "next-gen" ? "team" : "classic" })));
          if (data.isLast !== false || !(data.values ?? []).length) return out;
        }
      },
      projectScheme: (key) => client.getProjectPermissionScheme(key),
      schemes: async () => (await client.listPermissionSchemes()).map((s) => ({ id: s.id, name: s.name, grants: s.grants })),
      projectRoles: async (key) => (await client.getProjectRoles(key)).map((r) => ({ id: r.id, name: r.name, actors: r.actors })),
      groups: async () => {
        const out: Array<{ id: string; name: string }> = [];
        for (let startAt = 0; ; startAt += 50) {
          const data = (await client.getJson("/rest/api/3/group/bulk", { query: { startAt, maxResults: 50 } })) as { values?: Array<{ groupId: string; name: string }>; isLast?: boolean };
          out.push(...(data.values ?? []).map((g) => ({ id: g.groupId, name: g.name })));
          if (data.isLast !== false || !(data.values ?? []).length) return out;
        }
      },
      groupMembers: async (groupId) => (await client.getGroupMembers(groupId, { includeInactive: true })).map(toDetails),
      users: async (ids) => (await client.getUsersDetails(ids)).map(toDetails),
      url: { project: (key) => `${base}/browse/${encodeURIComponent(key)}` },
    };
  }
  return out;
}

// ============================================================================
// The command
// ============================================================================

/** Rules for an access audit: the rules file's `access:` section and the rule scripts. */
export async function loadAccessAuditSetup(profileName: string, rulesFlag: string | undefined, cwd: string, extra: string[]) {
  const path = rulesFlag ? resolvePath(rulesFlag) : auditRulesCandidates(profileName, cwd).find((p) => existsSync(p));
  let parsed: unknown;
  if (path) {
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch {
      throw new AuditRulesError(`Cannot read the rules file ${path}.`);
    }
    try {
      parsed = parseYaml(text);
    } catch (err) {
      throw new AuditRulesError(`${path}: invalid YAML: ${(err as Error).message}`);
    }
  }
  const section = (parsed as { access?: { scripts?: unknown } } | undefined)?.access;
  const { scripts, diagnostics } = await loadAuditScripts("access", {
    cwd,
    ...(path && section?.scripts !== undefined
      ? { fileScripts: { base: resolvePath(path, ".."), paths: Array.isArray(section.scripts) ? section.scripts.map(String) : [String(section.scripts)] } }
      : {}),
    extra,
  });
  const registry = registryOf(scripts);
  try {
    const rules = parseSectionAuditRules(parsed ?? null, "access", path ?? "built-in profile default", registry);
    return { scripts, registry, rules: path ? rules : { ...rules, source: "built-in profile default" }, diagnostics };
  } catch (err) {
    if (path && err instanceof AuditRulesError && !err.message.startsWith(path)) throw new AuditRulesError(`${path}: ${err.message}`);
    throw err;
  }
}

/** `--space DOCSY,TEAM` / `--space '*'`; undefined when not given. */
function keyList(flags: Flags, name: string): string[] | "*" | undefined {
  const raw = getFlag(flags, name);
  if (raw === undefined) return undefined;
  if (raw.trim() === "*") return "*";
  return raw.split(",").map((k) => k.trim()).filter(Boolean);
}

export async function handleAuditAccess(args: string[], flags: Flags, opts: OutputOptions): Promise<void> {
  if (args[0] === "help" || hasFlag(flags, "help")) {
    output(auditAccessHelp(), opts);
    return;
  }
  const failOn = (getFlag(flags, "fail-on") ?? "error") as (typeof FAIL_ON)[number];
  if (!FAIL_ON.includes(failOn)) fail(opts, 1, ERROR_CODES.USAGE, `--fail-on must be one of ${FAIL_ON.join(", ")}.`);
  const minLevel = getFlag(flags, "min-level");
  if (minLevel !== undefined && !["info", "warning", "error"].includes(minLevel)) fail(opts, 1, ERROR_CODES.USAGE, "--min-level must be info, warning or error.");
  const maxPagesRaw = getFlag(flags, "max-pages");
  const maxPages = maxPagesRaw === undefined ? DEFAULT_MAX_PAGES : Number(maxPagesRaw);
  if (!Number.isInteger(maxPages) || maxPages < 1) fail(opts, 1, ERROR_CODES.USAGE, "--max-pages must be a positive integer.");
  const product = getFlag(flags, "product") ?? "both";
  if (!["confluence", "jira", "both"].includes(product)) fail(opts, 1, ERROR_CODES.USAGE, "--product must be confluence, jira or both.");

  let spaces = keyList(flags, "space");
  let projects = keyList(flags, "project");
  // Without --space/--project: everything of the products asked for.
  if (spaces === undefined && projects === undefined) {
    if (product !== "jira") spaces = "*";
    if (product !== "confluence") projects = "*";
  }
  if (product === "jira") spaces = undefined;
  if (product === "confluence") projects = undefined;
  if (hasFlag(flags, "pages") && spaces === undefined) fail(opts, 1, ERROR_CODES.USAGE, "--pages reads page restrictions of spaces; add --space.");

  const config = await loadConfig();
  const profile = getActiveProfile(config, getFlag(flags, "profile"));
  if (!profile) fail(opts, 1, ERROR_CODES.AUTH, "No active profile found. Run `atlcli auth login`.");

  let setup: Awaited<ReturnType<typeof loadAccessAuditSetup>>;
  try {
    setup = await loadAccessAuditSetup(profile.name, getFlag(flags, "rules"), process.cwd(), scriptFlags(flags));
  } catch (err) {
    if (err instanceof AuditRulesError || err instanceof AuditScriptError) fail(opts, 1, ERROR_CODES.USAGE, err.message);
    throw err;
  }
  if (handleRuleListing(setup.scripts, flags, opts)) return;
  const { registry } = setup;
  let rules = setup.rules;
  const checksFlag = getFlag(flags, "checks");
  if (checksFlag !== undefined) {
    const checks = resolveAuditChecks(checksFlag, registry, []);
    if (typeof checks === "string") fail(opts, 1, ERROR_CODES.USAGE, checks);
    rules = restrictAuditRules(rules, checks);
  }
  if (minLevel) rules.minLevel = minLevel as AuditSeverity;

  const baselinePath = accessBaselinePath(profile.name);
  const useBaseline = !hasFlag(flags, "no-baseline");
  const { baseline, warning: baselineWarning } = await readBaseline(baselinePath);

  const source = clientAccessSource(profile, { confluence: spaces !== undefined, jira: projects !== undefined });
  const scope: AccessScope = { ...(spaces !== undefined ? { spaces } : {}), ...(projects !== undefined ? { projects } : {}), personal: hasFlag(flags, "personal"), pages: hasFlag(flags, "pages"), maxPages };
  const { model, partial } = await collectAccessModel(source, scope);
  const query = [
    spaces !== undefined ? `spaces ${spaces === "*" ? `all${scope.personal ? "" : " shared"}` : spaces.join(", ")}` : "",
    projects !== undefined ? `projects ${projects === "*" ? "all" : projects.join(", ")}` : "",
    scope.pages ? "with pages" : "",
  ]
    .filter(Boolean)
    .join("; ");
  const diagnostics = [
    ...setup.diagnostics,
    `Read ${model.coverage.spaces} space(s), ${model.coverage.projects} project(s)${scope.pages ? `, ${model.coverage.pages} page(s)` : ""}, ${model.users.length} user(s), ${model.groups.length} group(s).`,
    ...model.coverage.incomplete.map((i) => `Incomplete: ${i.kind} ${i.key}: ${i.note}.`),
    ...model.coverage.notes,
  ];

  const { createLazyCliScriptPort } = await import("./script-port.js");
  const port = createLazyCliScriptPort(profile);
  let result;
  try {
    result = await auditAccess(
      { rules, registry, scripts: setup.scripts, model, now: new Date(), ...(baseline ? { baseline } : {}), useBaseline, partial, diagnostics, query, pagesRead: scope.pages },
      { port, now: new Date() },
    );
  } catch (err) {
    if (err instanceof AuditScriptError) fail(opts, 1, ERROR_CODES.VALIDATION, err.message);
    throw err;
  }
  const { report, candidates, items } = result;
  if (baselineWarning) report.diagnostics.push(baselineWarning);

  if (hasFlag(flags, "update-baseline")) {
    const next = createAuditBaseline(candidates, new Date(), baseline);
    await writeJsonAtomic(baselinePath, next);
    report.diagnostics.push(`Baseline: ${next.entries.length} finding(s) accepted in ${baselinePath}.`);
  } else if (hasFlag(flags, "prune-baseline") && baseline) {
    const next = pruneAuditBaseline(baseline, candidates);
    await writeJsonAtomic(baselinePath, next);
    report.diagnostics.push(`Baseline: ${baseline.entries.length - next.entries.length} stale entr(y/ies) removed.`);
    report.staleBaselineEntries = 0;
  }

  if (hasFlag(flags, "fix")) {
    await runAuditFixes(report, setup.scripts, (f) => items.get(`${f.target.kind}:${f.target.key}`), { profile, port, configFor: (f) => rules.rules[f.rule] }, flags, opts);
    return;
  }

  await emitAuditOutput(report, setup.scripts, port, flags, opts, () => renderAuditText(report));

  if (failOn !== "never" && report.findings.some((f) => AUDIT_SEVERITY_RANK[f.severity] >= AUDIT_SEVERITY_RANK[failOn])) {
    process.exitCode = 2;
  }
}

export function auditAccessHelp(): string {
  return `Usage: atlcli audit access [--space KEYS|'*'] [--project KEYS|'*'] [options]

Who can see and change what: space permissions and roles, Jira permission schemes
and project roles, groups and users, and with --pages the restrictions of pages.
Without --space and --project every shared space and every project you can see
is read. What your account may not read is listed as incomplete, not guessed.

Rules (category/rule):
  exposure/anonymous-space     Anyone can open a space without logging in
  exposure/anonymous-project   A permission scheme lets anyone into a project
  exposure/all-users           Every licensed user can edit or administer
  stale/inactive-user-grant    Deactivated accounts still hold access
  stale/empty-group-grant      Groups without active members hold access
  stale/inactive-in-restriction  Page restrictions name inactive accounts (--pages)
  admin/no-active-admin        Nobody active administers a space or project
  admin/single-admin           Exactly one administrator
  admin/external-admin         External collaborators or guests administer
  reach/broad-admin            Someone administers many spaces and projects
  hygiene/direct-user-grants   Many users granted one by one instead of by group
  hygiene/unmigrated-access    Access outside space roles during the move to roles
  pages/locked-out             Pages nobody active can edit (--pages)

Rules file (first found): --rules <file>, ./.atlcli/audit-rules.yaml,
  ~/.atlcli/profiles/<profile>/audit-rules.yaml, ~/.atlcli/audit-rules.yaml (section access:)
Baseline: ~/.atlcli/profiles/<profile>/audit-access-baseline.json

Options:
  --space <keys>        Spaces (comma-separated, or '*' for all but personal spaces)
  --project <keys>      Projects (comma-separated, or '*')
  --product <p>         confluence, jira or both (default) when neither is given
  --personal            With --space '*': include personal spaces
  --pages               Also read page restrictions of the spaces (one request per page)
  --max-pages <n>       Stop reading pages after n (default: ${DEFAULT_MAX_PAGES})
  --rules <file>        Rules file to use
  --checks <list>       Only these rules: rule ids or categories
  --min-level <level>   List findings from this level (default: the rules file's minLevel)
  --fail-on <level>     Exit 2 when a listed finding reaches it: info, warning, error
                        (default), never
  --update-baseline     Accept every current finding into the baseline
  --prune-baseline      Remove baseline entries that no longer match
  --no-baseline         Ignore the baseline
  --markdown            Markdown report (the default Jinja template)
  --template <file>     Render the report with your own Jinja template
  --output <file>       Write the report to a file (replaced only once complete)
  --format <f>          md, json, jsonl or csv (default: from --output's extension, else md)
  --report <file>       Same as --format md --output <file>
  --json                JSON report (schemaVersion 3)

Rule scripts (TypeScript, run read-only in the script sandbox):
  --script <file>       Add a rule script (repeatable); also ./.atlcli/audit/*.ts,
                        ~/.atlcli/audit/*.ts and scripts: in the rules file's access: section
  --list-rules          List rules with their source
  --print-rule <id>     Print a rule's script
  --fix                 Plan the \`fix\` exports of listed findings (review, then apply)
    --apply [--yes]     Apply the plan right away
    --plan-out <file>   Save the plan for 'atlcli script apply'

Exit codes: 0 ran, 1 failed or wrong arguments, 2 findings at --fail-on.

Examples:
  atlcli audit access --space DOCSY --project ATLCLI
  atlcli audit access --product confluence --checks exposure --fail-on error
  atlcli audit access --space TEAM --pages --min-level info
  atlcli audit access --project '*' --checks stale --fix --plan-out access-fix.json
  atlcli audit access --output access.csv`;
}
