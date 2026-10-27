import { z } from "zod";
import type { ConfluencePrincipalRef, ConfluenceRestrictionsView, RestWriteMethod } from "./port.js";
import { hostOp, pagedIterator, restOptions, restPath, str, verb, type Verb } from "./recorder.js";

const SEARCH_PAGE_SIZE = 100;
const SPACE_PAGE_SIZE = 100;
const method = z
  .string()
  .transform((m) => m.toUpperCase())
  .pipe(z.enum(["POST", "PUT", "PATCH", "DELETE"], { message: "POST, PUT, PATCH or DELETE (GET is confluence.rest)" }));
const requestOptions = restOptions.extend({ body: z.unknown().optional() });
const pageId = str.regex(/^(?:\d+|plan:\d+)$/, "a page id");
const propertyKey = str.max(255).regex(/^[^\s/\\]+$/, "property keys cannot contain whitespace or slashes");
const principals = z.strictObject({ accountIds: z.array(str).optional(), groupIds: z.array(str).optional() });
const restrictions = z
  .strictObject({ read: principals.optional(), update: principals.optional() })
  .refine((r) => r.read !== undefined || r.update !== undefined, "pass read, update or both");

const spaceKey = str.regex(/^[A-Za-z0-9~_-]+$/, "a space key such as DOCSY");
const groupId = str.max(255);
const principal = z.strictObject({ type: z.enum(["user", "group", "access-class"]), id: str });
/** Most account ids confluence.users takes in one call. */
const MAX_USER_IDS = 500;

/**
 * Same principal in either API: access classes are spelled ALL_LICENSED_USERS
 * in permissions and all-licensed-users in role assignments.
 */
const samePrincipal = (a: { type: string; id: string }, b: ConfluencePrincipalRef) =>
  a.type === b.type && (b.type === "access-class" ? a.id.toLowerCase().replace(/_/g, "-") === b.id.toLowerCase().replace(/_/g, "-") : a.id === b.id);

const canonical = (value: unknown): string =>
  JSON.stringify(value, (_k, v) => (v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v));
const sameSet = (a: readonly string[] = [], b: readonly string[] = []) => a.length === b.length && [...a].sort().join("\0") === [...b].sort().join("\0");

export const CONFLUENCE_VERBS: Record<string, Verb> = {
  "confluence.request": verb(z.tuple([method, restPath, requestOptions.optional()]), async (r, [m, path, o]) => {
    if (!path.startsWith("/rest/api/") && !path.startsWith("/api/v2/")) {
      throw new Error(`Confluence REST paths start with /rest/api/ or /api/v2/: ${JSON.stringify(path)}`);
    }
    // A path names no space reliably, so arbitrary writes need the full grant.
    r.require("confluence:write:*");
    const seq = await r.record("confluence.request", {
      method: m as RestWriteMethod,
      path,
      ...(o?.query ? { query: o.query } : {}),
      ...(o?.body !== undefined ? { body: o.body } : {}),
    });
    return { id: `plan:${seq}` };
  }),
  "confluence.properties": verb(z.tuple([pageId]), async (r, [id], signal) => {
    r.require("confluence:read");
    return hostOp(r.port.confluenceProperties?.bind(r.port), "confluence.properties")(r.readable(id), { signal });
  }),
  "confluence.setProperty": verb(z.tuple([pageId, propertyKey, z.unknown()]), async (r, [id, key, value], signal) => {
    if (value === undefined || value === null) throw new Error("A property needs a value; use deleteProperty to remove it");
    const page = await r.confluencePage(id, signal);
    r.require(`confluence:write:${page.spaceKey}`);
    const object = `confluence-property:${id}\u0000${key}`;
    if (page.live && r.lastWrite(object) === undefined) {
      const current = (await hostOp(r.port.confluenceProperties?.bind(r.port), "confluence.setProperty")(id, { signal }))[key];
      if (current !== undefined && canonical(current) === canonical(value)) {
        r.skipped.push({ verb: "confluence.setProperty", target: id, title: key, reason: "unchanged" });
        return null;
      }
    }
    await r.record("confluence.setProperty", { pageId: id, key, value }, object);
    return null;
  }),
  "confluence.deleteProperty": verb(z.tuple([pageId, propertyKey]), async (r, [id, key], signal) => {
    const page = await r.confluencePage(id, signal);
    r.require(`confluence:write:${page.spaceKey}`);
    const object = `confluence-property:${id}\u0000${key}`;
    if (page.live && r.lastWrite(object) === undefined) {
      const current = await hostOp(r.port.confluenceProperties?.bind(r.port), "confluence.deleteProperty")(id, { signal });
      if (!Object.hasOwn(current, key)) {
        r.skipped.push({ verb: "confluence.deleteProperty", target: id, title: key, reason: "unchanged" });
        return null;
      }
    }
    await r.record("confluence.deleteProperty", { pageId: id, key }, object);
    return null;
  }),
  "confluence.restrictions": verb(z.tuple([pageId]), async (r, [id], signal) => {
    r.require("confluence:read");
    return hostOp(r.port.confluenceRestrictions?.bind(r.port), "confluence.restrictions")(r.readable(id), { signal });
  }),
  "confluence.setRestrictions": verb(z.tuple([pageId, restrictions]), async (r, [id, input], signal) => {
    const page = await r.confluencePage(id, signal);
    r.require(`confluence:write:${page.spaceKey}`);
    const wanted: Partial<ConfluenceRestrictionsView> = {};
    for (const op of ["read", "update"] as const) {
      const set = input[op];
      if (set) wanted[op] = { accountIds: [...new Set(set.accountIds ?? [])], groupIds: [...new Set(set.groupIds ?? [])] };
    }
    const object = `confluence-restrictions:${id}`;
    if (page.live && r.lastWrite(object) === undefined) {
      const live = await hostOp(r.port.confluenceRestrictions?.bind(r.port), "confluence.setRestrictions")(id, { signal });
      const same = (["read", "update"] as const).every(
        (op) => !wanted[op] || (sameSet(wanted[op]!.accountIds, live[op].accountIds) && sameSet(wanted[op]!.groupIds, live[op].groupIds)),
      );
      if (same) {
        r.skipped.push({ verb: "confluence.setRestrictions", target: id, title: page.title, reason: "unchanged" });
        return null;
      }
    }
    await r.record("confluence.setRestrictions", { pageId: id, ...wanted }, object);
    return null;
  }),
  "confluence.versions": verb(z.tuple([pageId]), async (r, [id], signal) => {
    r.require("confluence:read");
    return hostOp(r.port.confluenceVersions?.bind(r.port), "confluence.versions")(r.readable(id), { signal });
  }),
  // Paged through CQL `ancestor`, which every deployment supports; an iterator in the guest.
  "confluence.descendants": verb(
    z.tuple([pageId, z.strictObject({ cursor: str.optional() }).optional()]),
    async (r, [id, options], signal) => {
      r.require("confluence:read");
      return r.port.confluenceSearch(`ancestor = ${r.readable(id)} AND type = page`, { ...options, limit: SEARCH_PAGE_SIZE, signal });
    },
  ),
  "confluence.spaces": verb(
    z.tuple([z.strictObject({ type: z.enum(["global", "personal"]).optional(), cursor: str.optional() }).optional()]),
    async (r, [options], signal) => {
      r.require("confluence:read");
      return hostOp(r.port.confluenceSpaces?.bind(r.port), "confluence.spaces")({ ...options, limit: SPACE_PAGE_SIZE, signal });
    },
  ),
  "confluence.inlineComments": verb(z.tuple([pageId]), async (r, [id], signal) => {
    r.require("confluence:read");
    return hostOp(r.port.confluenceInlineComments?.bind(r.port), "confluence.inlineComments")(r.readable(id), { signal });
  }),
  "confluence.createBlogPost": verb(z.tuple([z.strictObject({ space: str, title: str, markdown: z.string() })]), async (r, [input]) => {
    r.require(`confluence:write:${input.space}`);
    const seq = await r.record("confluence.createBlogPost", { spaceKey: input.space, title: input.title, markdown: input.markdown });
    return { id: `plan:${seq}` };
  }),
  "confluence.spacePermissions": verb(z.tuple([spaceKey]), async (r, [key], signal) => {
    r.require("confluence:read");
    return hostOp(r.port.confluenceSpacePermissions?.bind(r.port), "confluence.spacePermissions")(key, { signal });
  }),
  "confluence.spaceRoles": verb(z.tuple([]), async (r, [], signal) => {
    r.require("confluence:read");
    return hostOp(r.port.confluenceSpaceRoles?.bind(r.port), "confluence.spaceRoles")({ signal });
  }),
  "confluence.roleAssignments": verb(z.tuple([spaceKey]), async (r, [key], signal) => {
    r.require("confluence:read");
    return hostOp(r.port.confluenceRoleAssignments?.bind(r.port), "confluence.roleAssignments")(key, { signal });
  }),
  "confluence.groupMembers": verb(z.tuple([groupId]), async (r, [group], signal) => {
    r.require("confluence:read");
    return hostOp(r.port.confluenceGroupMembers?.bind(r.port), "confluence.groupMembers")(group, { signal });
  }),
  "confluence.users": verb(z.tuple([z.array(str).max(MAX_USER_IDS, `at most ${MAX_USER_IDS} account ids per call`)]), async (r, [ids], signal) => {
    r.require("confluence:read");
    if (ids.length === 0) return [];
    return hostOp(r.port.confluenceUsers?.bind(r.port), "confluence.users")([...new Set(ids)], { signal });
  }),
  /**
   * Removes a principal's access to a space: its role assignment (role model)
   * and/or its permission records (before roles, and custom records during
   * the transition). Skipped when it has neither.
   */
  "confluence.removeSpaceAccess": verb(z.tuple([spaceKey, principal]), async (r, [key, who], signal) => {
    r.require(`confluence:write:${key}`);
    const title = `${who.type}:${who.id}`;
    const object = `confluence-space-access:${key}\u0000${title}`;
    const unchanged = () => {
      r.skipped.push({ verb: "confluence.removeSpaceAccess", target: key, title, reason: "unchanged" });
      return null;
    };
    if (r.lastWrite(object) !== undefined) return unchanged();
    const verbName = "confluence.removeSpaceAccess";
    const { mode } = await hostOp(r.port.confluenceSpaceRoles?.bind(r.port), verbName)({ signal });
    const assignment =
      mode === "PRE_ROLES"
        ? undefined
        : (await hostOp(r.port.confluenceRoleAssignments?.bind(r.port), verbName)(key, { signal })).find((a) => samePrincipal(a.principal, who));
    // In the role model a space's permissions follow from its roles.
    const permissionIds =
      assignment && mode === "ROLES"
        ? []
        : (await hostOp(r.port.confluenceSpacePermissions?.bind(r.port), verbName)(key, { signal })).filter((p) => samePrincipal(p.principal, who)).map((p) => p.id);
    if (!assignment && permissionIds.length === 0) return unchanged();
    const role = assignment
      ? { spaceId: await hostOp(r.port.confluenceSpaceId?.bind(r.port), verbName)(key, { signal }), roleId: assignment.roleId }
      : {};
    await r.record(
      "confluence.removeSpaceAccess",
      { spaceKey: key, ...role, principal: assignment?.principal ?? who, ...(permissionIds.length ? { permissionIds } : {}) },
      object,
    );
    return null;
  }),
};

export const CONFLUENCE_WRAPPERS: Record<string, string> = {
  "confluence.descendants": pagedIterator("results", "cursor", "nextCursor"),
  "confluence.spaces": pagedIterator("results", "cursor", "nextCursor", false),
};
