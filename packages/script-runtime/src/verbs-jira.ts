import { z } from "zod";
import type { JiraUserRef, JiraVersionInput, JiraVersionView, RestWriteMethod } from "./port.js";
import { hostOp, id, issueUnchanged, PLACEHOLDER, type Recorder, restOptions, restPath, str, verb, type Verb } from "./recorder.js";

const KEY = /^[A-Z][A-Z0-9_]*$/;
const project = str.regex(KEY, "a project key such as ATLCLI");
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "a date like 2026-10-31");
/** Version and component ids are numeric strings; numbers are accepted. `plan:<n>` stands for one created by this plan. */
const objectId = z.union([id.transform(String), z.string().regex(/^\d+$/), z.string().regex(PLACEHOLDER)]);
const method = z
  .string()
  .transform((m) => m.toUpperCase())
  .pipe(z.enum(["POST", "PUT", "PATCH", "DELETE"], { message: "POST, PUT, PATCH or DELETE (GET is jira.rest)" }));
const requestOptions = restOptions.extend({ body: z.unknown().optional() });
/** Markdown, or `{ raw }` in the site's own format (ADF on Cloud), as for jira.comment. */
const commentBody = z.union([z.string().min(1), z.strictObject({ raw: z.union([z.string().min(1), z.record(z.string(), z.unknown())]) })]);
const versionFields = {
  description: z.string().optional(),
  startDate: date.optional(),
  releaseDate: date.optional(),
  released: z.boolean().optional(),
  archived: z.boolean().optional(),
};
const nonEmpty = (o: object) => Object.keys(o).length > 0;

/** Seconds of a Jira duration: "1h 30m", "2d", "45m", or a number of seconds. Jira's defaults: 1d = 8h, 1w = 5d. */
export function parseDuration(input: string | number): number {
  if (typeof input === "number") {
    if (!Number.isInteger(input) || input <= 0) throw new Error(`timeSpent must be a positive number of seconds, got ${input}`);
    return input;
  }
  const units: Record<string, number> = { w: 5 * 8 * 3600, d: 8 * 3600, h: 3600, m: 60, s: 1 };
  const parts = input.trim().split(/\s+/);
  let seconds = 0;
  for (const part of parts) {
    const match = /^(\d+(?:\.\d+)?)([wdhms])$/.exec(part);
    if (!match) throw new Error(`timeSpent ${JSON.stringify(input)} is not a duration like "1h 30m"`);
    seconds += Number(match[1]) * units[match[2]!]!;
  }
  if (seconds <= 0) throw new Error(`timeSpent ${JSON.stringify(input)} is no time`);
  return Math.round(seconds);
}

/** The project a REST path names (`/issue/ABC-1…`, `/project/ABC…`), else undefined. */
export function restProject(path: string): string | undefined {
  return /\/issue\/([A-Z][A-Z0-9_]*)-\d+(?:\/|$)/.exec(path)?.[1] ?? /\/project\/([A-Z][A-Z0-9_]*)(?:\/|$)/.exec(path)?.[1];
}

async function requireVersionWrite(r: Recorder, ref: string, signal: AbortSignal): Promise<JiraVersionView | undefined> {
  const planned = PLACEHOLDER.exec(ref);
  if (planned) {
    const op = r.operation(Number(planned[1]));
    if (op.verb !== "jira.createVersion") throw new Error(`${ref} is not a version created by this plan`);
    r.require(`jira:write:${op.args.project as string}`);
    return undefined;
  }
  const live = await hostOp(r.port.jiraGetVersion?.bind(r.port), "jira.updateVersion")(ref, { signal });
  if (live.project) r.require(`jira:write:${live.project}`);
  else r.require("jira:write:*");
  return live;
}

export const JIRA_VERBS: Record<string, Verb> = {
  "jira.request": verb(z.tuple([method, restPath, requestOptions.optional()]), async (r, [m, path, o]) => {
    if (!path.startsWith("/rest/")) throw new Error(`Jira REST paths start with /rest/: ${JSON.stringify(path)}`);
    const projectKey = restProject(path);
    r.require(projectKey ? `jira:write:${projectKey}` : "jira:write:*");
    const seq = await r.record("jira.request", {
      method: m as RestWriteMethod,
      path,
      ...(o?.query ? { query: o.query } : {}),
      ...(o?.body !== undefined ? { body: o.body } : {}),
    });
    return { id: `plan:${seq}`, key: `plan:${seq}` };
  }),
  "jira.comments": verb(z.tuple([str]), async (r, [key], signal) => {
    r.require("jira:read");
    return hostOp(r.port.jiraComments?.bind(r.port), "jira.comments")(r.readable(key), { signal });
  }),
  "jira.updateComment": verb(z.tuple([str, str, commentBody]), async (r, [key, commentId, body]) => {
    r.require(`jira:write:${r.jiraProject(key)}`);
    await r.record("jira.updateComment", { key, id: commentId, ...(typeof body === "string" ? { markdown: body } : { raw: body.raw }) });
    return null;
  }),
  "jira.deleteComment": verb(z.tuple([str, str]), async (r, [key, commentId]) => {
    r.require(`jira:write:${r.jiraProject(key)}`);
    await r.record("jira.deleteComment", { key, id: commentId });
    return null;
  }),
  "jira.worklogs": verb(z.tuple([str]), async (r, [key], signal) => {
    r.require("jira:read");
    return hostOp(r.port.jiraWorklogs?.bind(r.port), "jira.worklogs")(r.readable(key), { signal });
  }),
  "jira.addWorklog": verb(
    z.tuple([
      str,
      z.strictObject({ timeSpent: z.union([str, z.number()]), started: z.iso.datetime({ offset: true }).optional(), comment: z.string().min(1).optional() }),
    ]),
    async (r, [key, input]) => {
      r.require(`jira:write:${r.jiraProject(key)}`);
      const seq = await r.record("jira.addWorklog", {
        key,
        timeSpentSeconds: parseDuration(input.timeSpent),
        ...(input.started ? { started: input.started } : {}),
        ...(input.comment ? { comment: input.comment } : {}),
      });
      return { id: `plan:${seq}` };
    },
  ),
  "jira.versions": verb(z.tuple([project]), async (r, [key], signal) => {
    r.require("jira:read");
    return hostOp(r.port.jiraVersions?.bind(r.port), "jira.versions")(key, { signal });
  }),
  "jira.createVersion": verb(
    z.tuple([project, z.strictObject({ name: str, ...versionFields })]),
    async (r, [key, input], signal) => {
      r.require(`jira:write:${key}`);
      // Version names are unique per project, so an existing one is reused rather than failing on apply.
      const existing = (await hostOp(r.port.jiraVersions?.bind(r.port), "jira.createVersion")(key, { signal })).find((v) => v.name === input.name);
      if (existing) {
        r.skipped.push({ verb: "jira.createVersion", target: key, title: input.name, reason: "unchanged" });
        return { id: existing.id };
      }
      const seq = await r.record("jira.createVersion", { project: key, ...input });
      return { id: `plan:${seq}` };
    },
  ),
  "jira.updateVersion": verb(
    z.tuple([objectId, z.strictObject({ name: str.optional(), ...versionFields }).refine(nonEmpty, "nothing to update")]),
    async (r, [ref, input], signal) => {
      const live = await requireVersionWrite(r, ref, signal);
      if (live && r.lastWrite(`jira-version:${ref}`) === undefined) {
        const same = (Object.keys(input) as Array<keyof JiraVersionInput>).every((k) => (live[k] ?? (k === "released" || k === "archived" ? false : undefined)) === input[k]);
        if (same) {
          r.skipped.push({ verb: "jira.updateVersion", target: ref, title: live.name, reason: "unchanged" });
          return null;
        }
      }
      await r.record("jira.updateVersion", { id: ref, ...input }, `jira-version:${ref}`);
      return null;
    },
  ),
  "jira.components": verb(z.tuple([project]), async (r, [key], signal) => {
    r.require("jira:read");
    return hostOp(r.port.jiraComponents?.bind(r.port), "jira.components")(key, { signal });
  }),
  "jira.createComponent": verb(
    z.tuple([project, z.strictObject({ name: str, description: z.string().optional(), lead: str.optional() })]),
    async (r, [key, { lead, ...input }], signal) => {
      r.require(`jira:write:${key}`);
      const existing = (await hostOp(r.port.jiraComponents?.bind(r.port), "jira.createComponent")(key, { signal })).find((c) => c.name === input.name);
      if (existing) {
        r.skipped.push({ verb: "jira.createComponent", target: key, title: input.name, reason: "unchanged" });
        return { id: existing.id };
      }
      const leadRef: JiraUserRef | undefined = lead ? await r.findUser(lead, signal) : undefined;
      const seq = await r.record("jira.createComponent", { project: key, ...input, ...(leadRef ? { lead: leadRef, leadQuery: lead } : {}) });
      return { id: `plan:${seq}` };
    },
  ),
  "jira.updateComponent": verb(
    z.tuple([
      objectId,
      z.strictObject({ name: str.optional(), description: z.string().optional(), lead: str.optional() }).refine(nonEmpty, "nothing to update"),
    ]),
    async (r, [ref, { lead, ...input }], signal) => {
      const planned = PLACEHOLDER.exec(ref);
      if (planned) {
        const op = r.operation(Number(planned[1]));
        if (op.verb !== "jira.createComponent") throw new Error(`${ref} is not a component created by this plan`);
        r.require(`jira:write:${op.args.project as string}`);
      } else {
        const live = await hostOp(r.port.jiraGetComponent?.bind(r.port), "jira.updateComponent")(ref, { signal });
        r.require(live.project ? `jira:write:${live.project}` : "jira:write:*");
        const leadChanged = lead !== undefined;
        const same = !leadChanged && (Object.keys(input) as Array<"name" | "description">).every((k) => live[k] === input[k]);
        if (same && r.lastWrite(`jira-component:${ref}`) === undefined) {
          r.skipped.push({ verb: "jira.updateComponent", target: ref, title: live.name, reason: "unchanged" });
          return null;
        }
      }
      const leadRef = lead ? await r.findUser(lead, signal) : undefined;
      await r.record("jira.updateComponent", { id: ref, ...input, ...(leadRef ? { lead: leadRef, leadQuery: lead } : {}) }, `jira-component:${ref}`);
      return null;
    },
  ),
  "jira.rank": verb(
    z.tuple([
      z.array(str).min(1),
      z.union([z.strictObject({ before: str }), z.strictObject({ after: str })]),
    ]),
    async (r, [keys, position]) => {
      const anchor = "before" in position ? position.before : position.after;
      for (const key of [...keys, anchor]) r.require(`jira:write:${r.jiraProject(key)}`);
      if (keys.includes(anchor)) throw new Error(`${anchor} cannot be ranked relative to itself`);
      await r.record("jira.rank", { keys: [...new Set(keys)], ...position });
      return null;
    },
  ),
  "jira.deleteIssue": verb(z.tuple([str, z.strictObject({ subtasks: z.boolean().optional() }).optional()]), async (r, [key, o], signal) => {
    if (PLACEHOLDER.test(key)) throw new Error(`${key} is created by this plan; leave out the create instead`);
    r.require(`jira:write:${r.jiraProject(key)}`);
    await r.record("jira.deleteIssue", { key, ...(o?.subtasks ? { subtasks: true } : {}) }, `jira:${key}`, () => issueUnchanged(r, key, signal));
    return null;
  }),
  "jira.clone": verb(
    z.tuple([
      str,
      z
        .strictObject({ project: project.optional(), summary: str.optional(), link: z.boolean().optional(), attachments: z.boolean().optional() })
        .optional(),
    ]),
    async (r, [key, o = {}]) => {
      r.require("jira:read");
      r.require(`jira:write:${o.project ?? r.jiraProject(key)}`);
      const seq = await r.record("jira.clone", { key, ...o });
      return { id: `plan:${seq}`, key: `plan:${seq}` };
    },
  ),
  "jira.links": verb(z.tuple([str]), async (r, [key], signal) => {
    r.require("jira:read");
    return hostOp(r.port.jiraLinks?.bind(r.port), "jira.links")(r.readable(key), { signal });
  }),
  "jira.unlink": verb(z.tuple([str, z.union([str, id.transform(String)])]), async (r, [key, linkId], signal) => {
    r.require(`jira:write:${r.jiraProject(key)}`);
    if (!PLACEHOLDER.test(key)) {
      const links = await hostOp(r.port.jiraLinks?.bind(r.port), "jira.unlink")(key, { signal });
      if (!links.some((l) => l.id === linkId)) {
        r.skipped.push({ verb: "jira.unlink", target: key, title: linkId, reason: "unchanged" });
        return null;
      }
    }
    await r.record("jira.unlink", { key, linkId });
    return null;
  }),
  "jira.fields": verb(z.tuple([]), async (r, [], signal) => {
    r.require("jira:read");
    return r.fields(signal);
  }),
  "jira.fieldId": verb(z.tuple([str]), async (r, [name], signal) => {
    r.require("jira:read");
    const fields = await r.fields(signal);
    const exact = fields.find((f) => f.id === name);
    if (exact) return exact.id;
    const matches = fields.filter((f) => f.name.toLowerCase() === name.toLowerCase());
    if (matches.length === 1) return matches[0]!.id;
    if (matches.length > 1) throw new Error(`Several fields are named "${name}": ${matches.map((f) => f.id).join(", ")}; pass the id`);
    throw new Error(`No field is named "${name}"`);
  }),
  "jira.users": verb(z.tuple([str]), async (r, [query], signal) => {
    r.require("jira:read");
    return hostOp(r.port.jiraUsers?.bind(r.port), "jira.users")(query, { signal });
  }),
  "jira.attachments": verb(z.tuple([str]), async (r, [key], signal) => {
    r.require("jira:read");
    return hostOp(r.port.jiraAttachments?.bind(r.port), "jira.attachments")(r.readable(key), { signal });
  }),
};
