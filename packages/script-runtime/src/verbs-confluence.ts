import { z } from "zod";
import type { ConfluenceRestrictionsView, RestWriteMethod } from "./port.js";
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
};

export const CONFLUENCE_WRAPPERS: Record<string, string> = {
  "confluence.descendants": pagedIterator("results", "cursor", "nextCursor"),
  "confluence.spaces": pagedIterator("results", "cursor", "nextCursor", false),
};
