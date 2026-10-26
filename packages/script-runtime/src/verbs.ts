import { z } from "zod";
import { extractScriptMeta, maxWritesOf, parseScriptMeta, resolveScriptParams, type ScriptMeta, type ScriptParams } from "./meta.js";
import type { AttachmentInput, ConfluencePageView, ExportFormat, JiraSprintState, JiraUserRef } from "./port.js";
import {
  capRest,
  hostOp,
  id,
  ISSUE_KEY,
  issueUnchanged,
  pageUnchanged,
  PLACEHOLDER,
  Recorder,
  restOptions,
  restPath,
  sameUser,
  str,
  untouchedIssue,
  pagedIterator,
  verb,
  type PlanScriptOptions,
  type Precondition,
  type ScriptRunPlan,
  type Verb,
} from "./recorder.js";
import { runScript, ScriptError, type HostFunction, type RunScriptOptions } from "./sandbox.js";
import { CONFLUENCE_VERBS, CONFLUENCE_WRAPPERS } from "./verbs-confluence.js";
import { JIRA_VERBS } from "./verbs-jira.js";
import { LOCAL_VERBS, LOCAL_WRAPPERS } from "./verbs-local.js";

export * from "./recorder.js";
export { checkLocalPath, MAX_LOCAL_BYTES, MAX_STATE_BYTES, SECRET_REFERENCE } from "./verbs-local.js";
export { parseDuration } from "./verbs-jira.js";

const SEARCH_PAGE_SIZE = 100;
const AGILE_PAGE_SIZE = 50;
/** Decoded size per attachment; the content travels through the plan file. */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

const fieldsOpt = z.strictObject({ fields: z.array(str).optional() });
const startAt = z.number().int().nonnegative().optional();
const isoDate = z.iso.datetime({ offset: true });
const label = str.regex(/^\S+$/, "labels cannot contain whitespace");
const labels = z.array(label).min(1);
const jiraCreate = z
  .strictObject({
    project: str,
    type: str,
    summary: str,
    description: z.string().optional(),
    fields: z.record(z.string(), z.unknown()).optional(),
    properties: z.record(str, z.unknown()).optional(),
  })
  .refine(
    (c) => c.description === undefined || c.fields?.description === undefined,
    "pass one of description (Markdown) or fields.description (raw), not both",
  );
/** Markdown, or `{ raw }`: the site's own comment format (ADF on Cloud), sent unchanged. */
const commentBody = z.union([z.string().min(1), z.strictObject({ raw: z.union([z.string().min(1), z.record(z.string(), z.unknown())]) })]);
const jiraUpdate = z
  .strictObject({
    summary: str.optional(),
    description: z.string().optional(),
    fields: z.record(z.string(), z.unknown()).optional(),
  })
  .refine((u) => Object.keys(u).length > 0, "nothing to update");
const pageInput = z.strictObject({ space: str, title: str, markdown: z.string(), parentId: str.optional() });
/** createPage also takes raw storage (lossless copies) and content properties. */
const createPageInput = z
  .strictObject({
    space: str,
    title: str,
    markdown: z.string().optional(),
    storage: z.string().optional(),
    parentId: str.optional(),
    properties: z.record(str, z.unknown()).optional(),
  })
  .refine((p) => (p.markdown === undefined) !== (p.storage === undefined), "pass markdown or storage, exactly one");
const attachmentInput = z.strictObject({
  name: str.max(255).refine((n) => !/[\\/]/.test(n), "name cannot contain path separators"),
  content: z.string(),
  encoding: z.enum(["utf8", "base64"]).optional(),
});
/** A sprint id: a number, a numeric string (e.g. from params), or `plan:<n>` of a created sprint. */
const sprintRef = z.union([id, z.string().regex(/^\d+$/).transform(Number), z.string().regex(PLACEHOLDER)]);
const sprintFields = {
  name: str.optional(),
  goal: z.string().optional(),
  startDate: isoDate.optional(),
  endDate: isoDate.optional(),
};
const exportOptions = z.strictObject({ format: z.enum(["pdf", "docx"]), path: str.optional() });

/** Transition screen fields and a Markdown comment (`transition`, `setStatus`). */
const transitionOptions = z.strictObject({
  fields: z.record(z.string(), z.unknown()).optional(),
  comment: z.string().min(1).optional(),
});
const withTransitionOptions = (o: z.output<typeof transitionOptions> | undefined) => ({
  ...(o?.fields && Object.keys(o.fields).length ? { fields: o.fields } : {}),
  ...(o?.comment ? { comment: o.comment } : {}),
});
const notifyInput = z.strictObject({
  subject: str,
  markdown: str,
  to: z
    .strictObject({
      users: z.array(str).optional(),
      groups: z.array(str).optional(),
      reporter: z.boolean().optional(),
      assignee: z.boolean().optional(),
      watchers: z.boolean().optional(),
      voters: z.boolean().optional(),
    })
    .refine((t) => Boolean(t.users?.length || t.groups?.length || t.reporter || t.assignee || t.watchers || t.voters), "name at least one recipient"),
});

const renderOptions = z.strictObject({
  vars: z.record(z.string(), z.unknown()).optional(),
  format: z.enum(["text", "adf", "storage", "wikimarkup"]).optional(),
  source: z.unknown().optional(),
  parent: z.unknown().optional(),
  unit: z.string().optional(),
  kind: z.enum(["summary", "label", "name", "string", "number", "date", "option"]).optional(),
});

const CORE_VERBS: Record<string, Verb> = {
  // Not a write: renders on the host, records only warnings.
  render: verb(z.tuple([z.unknown(), renderOptions.optional()]), async (r, [input, o = {}]) => {
    const render = r.port.render?.bind(r.port);
    if (!render) throw new Error("atlcli.render is not available on this host");
    const unit = o.unit ?? `render#${++r.renderCount}`;
    r.rendered = true;
    try {
      const out = await render(input, {
        format: o.format,
        source: o.source,
        parent: o.parent,
        unit,
        ...(o.kind ? { kind: o.kind } : {}),
        vars: { ...r.templating.vars, ...(o.vars ?? {}) },
        now: r.templating.now,
        strict: r.templating.strict,
      });
      r.renderWarnings.push(...out.warnings);
      return out.value;
    } catch (error) {
      if ((error as Error)?.name === "RenderError") throw new ScriptError("template", (error as Error).message);
      throw error;
    }
  }),
  "jira.search": verb(
    z.tuple([
      str,
      z.strictObject({ fields: z.array(str).optional(), properties: z.array(str).optional(), pageToken: str.optional() }).optional(),
    ]),
    async (r, [jql, options], signal) => {
      r.require("jira:read");
      return r.port.jiraSearch(jql, { ...options, maxResults: SEARCH_PAGE_SIZE, signal });
    },
  ),
  "jira.get": verb(z.tuple([str, fieldsOpt.optional()]), async (r, [key, options], signal) => {
    r.require("jira:read");
    return r.port.jiraGetIssue(r.readable(key), { ...options, signal });
  }),
  "jira.create": verb(z.tuple([jiraCreate]), async (r, [input]) => {
    r.require(`jira:write:${input.project}`);
    const seq = await r.record("jira.create", input);
    return { id: `plan:${seq}`, key: `plan:${seq}` };
  }),
  "jira.update": verb(z.tuple([str, jiraUpdate]), async (r, [key, input], signal) => {
    r.require(`jira:write:${r.jiraProject(key)}`);
    await r.record("jira.update", { key, ...input }, `jira:${key}`, () => issueUnchanged(r, key, signal));
    return null;
  }),
  "jira.transition": verb(z.tuple([str, str, transitionOptions.optional()]), async (r, [key, transition, options], signal) => {
    r.require(`jira:write:${r.jiraProject(key)}`);
    if (!PLACEHOLDER.test(key)) {
      const available = await r.port.jiraGetTransitions(key, { signal });
      if (!available.some((name) => name.toLowerCase() === transition.toLowerCase())) {
        throw new Error(`Transition "${transition}" is not available for ${key} (available: ${available.join(", ") || "none"})`);
      }
    }
    await r.record("jira.transition", { key, transition, ...withTransitionOptions(options) }, `jira:${key}`, () => issueUnchanged(r, key, signal));
    return null;
  }),
  "jira.setStatus": verb(z.tuple([str, str, transitionOptions.optional()]), async (r, [key, status, options], signal) => {
    r.require(`jira:write:${r.jiraProject(key)}`);
    const issue = await untouchedIssue(r, key, ["status"], signal);
    if (issue && String((issue.fields.status as { name?: string } | undefined)?.name ?? "").toLowerCase() === status.toLowerCase()) {
      r.skipped.push({ verb: "jira.setStatus", target: key, title: status, reason: "unchanged" });
      return null;
    }
    await r.record("jira.setStatus", { key, status, ...withTransitionOptions(options) }, `jira:${key}`, async () =>
      issue ? { kind: "jira-issue-unchanged", key, updated: issue.fields.updated } : undefined,
    );
    return null;
  }),
  "jira.transitions": verb(z.tuple([str]), async (r, [key], signal) => {
    r.require("jira:read");
    return hostOp(r.port.jiraTransitions?.bind(r.port), "jira.transitions")(r.readable(key), { signal });
  }),
  "jira.history": verb(z.tuple([str, z.strictObject({ fields: z.array(str).optional() }).optional()]), async (r, [key, o], signal) => {
    r.require("jira:read");
    return hostOp(r.port.jiraHistory?.bind(r.port), "jira.history")(r.readable(key), { ...(o?.fields ? { fields: o.fields } : {}), signal });
  }),
  "jira.watchers": verb(z.tuple([str]), async (r, [key], signal) => {
    r.require("jira:read");
    return hostOp(r.port.jiraWatchers?.bind(r.port), "jira.watchers")(r.readable(key), { signal });
  }),
  "jira.addWatcher": verb(z.tuple([str, str]), async (r, [key, user], signal) => {
    r.require(`jira:write:${r.jiraProject(key)}`);
    const ref = await r.findUser(user, signal);
    if (!PLACEHOLDER.test(key) && (await watching(r, key, ref, signal))) {
      r.skipped.push({ verb: "jira.addWatcher", target: key, title: user, reason: "unchanged" });
      return null;
    }
    await r.record("jira.addWatcher", { key, user: ref, query: user });
    return null;
  }),
  "jira.removeWatcher": verb(z.tuple([str, str]), async (r, [key, user], signal) => {
    r.require(`jira:write:${r.jiraProject(key)}`);
    const ref = await r.findUser(user, signal);
    if (!PLACEHOLDER.test(key) && !(await watching(r, key, ref, signal))) {
      r.skipped.push({ verb: "jira.removeWatcher", target: key, title: user, reason: "unchanged" });
      return null;
    }
    await r.record("jira.removeWatcher", { key, user: ref, query: user });
    return null;
  }),
  "jira.notify": verb(z.tuple([str, notifyInput]), async (r, [key, input], signal) => {
    r.require(`jira:write:${r.jiraProject(key)}`);
    const { users, ...rest } = input.to;
    const resolved = users ? await Promise.all(users.map((u) => r.findUser(u, signal))) : undefined;
    await r.record("jira.notify", { key, subject: input.subject, markdown: input.markdown, to: { ...rest, ...(resolved ? { users: resolved } : {}) } });
    return null;
  }),
  "jira.comment": verb(z.tuple([str, commentBody]), async (r, [key, body]) => {
    r.require(`jira:write:${r.jiraProject(key)}`);
    const seq = await r.record("jira.comment", typeof body === "string" ? { key, markdown: body } : { key, raw: body.raw });
    return { id: `plan:${seq}` };
  }),
  "jira.link": verb(z.tuple([str, str, str]), async (r, [from, type, to], signal) => {
    r.require(`jira:write:${r.jiraProject(from)}`);
    r.require(`jira:write:${r.jiraProject(to)}`);
    const types = await r.linkTypes(signal);
    const t = type.toLowerCase();
    const outward = types.find((l) => l.name.toLowerCase() === t || l.outward.toLowerCase() === t);
    const inward = outward ? undefined : types.find((l) => l.inward.toLowerCase() === t);
    if (!outward && !inward) {
      throw new Error(`Unknown link type "${type}" (available: ${types.map((l) => `${l.outward} / ${l.inward}`).join(", ") || "none"})`);
    }
    // Stored in the outward direction: "from <outward> to".
    const args = outward ? { from, type: outward.name, to } : { from: to, type: inward!.name, to: from };
    await r.record("jira.link", args);
    return null;
  }),
  "jira.assign": verb(z.tuple([str, str.optional()]), async (r, [key, user], signal) => {
    r.require(`jira:write:${r.jiraProject(key)}`);
    const assignee = user === undefined ? null : await r.findUser(user, signal);
    const issue = await untouchedIssue(r, key, ["assignee"], signal);
    if (issue && sameUser(issue.fields.assignee, assignee)) {
      r.skipped.push({ verb: "jira.assign", target: key, reason: "unchanged" });
      return null;
    }
    await r.record("jira.assign", { key, assignee, ...(user !== undefined ? { user } : {}) }, `jira:${key}`, async () =>
      issue ? { kind: "jira-issue-unchanged", key, updated: issue.fields.updated } : undefined,
    );
    return null;
  }),
  "jira.addLabels": verb(z.tuple([str, labels]), (r, [key, list], signal) => editIssueLabels(r, "jira.addLabels", key, list, signal)),
  "jira.removeLabels": verb(z.tuple([str, labels]), (r, [key, list], signal) =>
    editIssueLabels(r, "jira.removeLabels", key, list, signal),
  ),
  "jira.attach": verb(z.tuple([str, attachmentInput]), async (r, [key, file]) => {
    r.require(`jira:write:${r.jiraProject(key)}`);
    const seq = await r.record("jira.attach", { key, ...checkAttachment(file) });
    return { id: `plan:${seq}` };
  }),
  "jira.copyAttachment": verb(z.tuple([str, str]), async (r, [id, to], signal) => {
    r.require("jira:read");
    r.require(`jira:write:${r.jiraProject(to)}`);
    const source = await r.port.jiraAttachmentInfo(r.readable(id), { signal });
    const target = await untouchedIssue(r, to, ["attachment"], signal);
    const existing = ((target?.fields.attachment as Array<{ id: string; filename: string; size: number }> | undefined) ?? []).find(
      (a) => a.filename === source.filename && Number(a.size) === source.size,
    );
    if (existing) {
      r.skipped.push({ verb: "jira.copyAttachment", target: to, title: source.filename, reason: "unchanged" });
      return { id: String(existing.id) };
    }
    // The source is the object: copying never changes the target issue's own fields.
    const seq = await r.record("jira.copyAttachment", { id, to, filename: source.filename, size: source.size }, `jira-attachment:${id}`, async () => ({
      kind: "jira-attachment-unchanged",
      id,
      size: source.size,
    }));
    return { id: `plan:${seq}` };
  }),
  "jira.boards": verb(
    z.tuple([z.strictObject({ project: str.optional(), name: str.optional(), startAt }).optional()]),
    async (r, [options], signal) => {
      r.require("jira:read");
      const { startAt = 0, ...rest } = options ?? {};
      return r.port.jiraBoards({ ...rest, startAt, maxResults: AGILE_PAGE_SIZE, signal });
    },
  ),
  "jira.sprints": verb(
    z.tuple([id, z.strictObject({ state: z.enum(["future", "active", "closed"]).optional(), startAt }).optional()]),
    async (r, [boardId, options], signal) => {
      r.require("jira:read");
      const { startAt = 0, ...rest } = options ?? {};
      return r.port.jiraSprints(boardId, { ...rest, startAt, maxResults: AGILE_PAGE_SIZE, signal });
    },
  ),
  "jira.createSprint": verb(
    z.tuple([z.strictObject({ board: id, ...sprintFields, name: str })]),
    async (r, [{ board: boardId, ...input }], signal) => {
      const board = await r.port.jiraGetBoard(boardId, { signal });
      r.requireBoardWrite(board, `Board ${boardId}`);
      if (board.type !== "scrum") throw new Error(`Board ${boardId} is a ${board.type} board; sprints need a scrum board`);
      const seq = await r.record("jira.createSprint", { boardId, ...input });
      r.sprintStates.set(`plan:${seq}`, "future");
      r.sprintDates.set(`plan:${seq}`, { startDate: input.startDate, endDate: input.endDate });
      return { id: `plan:${seq}` };
    },
  ),
  "jira.updateSprint": verb(
    z.tuple([
      sprintRef,
      z
        .strictObject({ ...sprintFields, state: z.enum(["active", "closed"]).optional() })
        .refine((u) => Object.keys(u).length > 0, "nothing to update"),
    ]),
    async (r, [ref, input], signal) => {
      const sprint = await sprintFor(r, ref, signal);
      const next = input.state;
      const allowed = { active: "future", closed: "active" } as const;
      if (next && sprint.state !== allowed[next]) {
        throw new Error(`Sprint ${ref} is ${sprint.state}; only a ${allowed[next]} sprint can become ${next}`);
      }
      if (sprint.state === "closed") throw new Error(`Sprint ${ref} is closed and cannot be changed`);
      // Jira refuses to start a sprint without both dates.
      if (next === "active" && !((input.startDate ?? sprint.startDate) && (input.endDate ?? sprint.endDate))) {
        throw new Error(`Starting sprint ${ref} needs a startDate and an endDate`);
      }
      await r.record("jira.updateSprint", { id: ref, ...input }, `jira-sprint:${ref}`, async () =>
        sprint.live ? { kind: "jira-sprint-unchanged", id: ref as number, state: sprint.state } : undefined,
      );
      if (next) r.sprintStates.set(String(ref), next);
      r.sprintDates.set(String(ref), {
        startDate: input.startDate ?? sprint.startDate,
        endDate: input.endDate ?? sprint.endDate,
      });
      return null;
    },
  ),
  "jira.moveToSprint": verb(z.tuple([sprintRef, z.array(str).min(1)]), async (r, [ref, keys], signal) => {
    const sprint = await sprintFor(r, ref, signal);
    for (const key of keys) r.require(`jira:write:${r.jiraProject(key)}`);
    if (sprint.state === "closed") throw new Error(`Sprint ${ref} is closed; issues cannot be moved into it`);
    await r.record("jira.moveToSprint", { sprintId: ref, keys: [...new Set(keys)] });
    return null;
  }),

  "jira.rest": verb(z.tuple([restPath, restOptions.optional()]), async (r, [path, o], signal) => {
    r.require("jira:read");
    return capRest(await hostOp(r.port.jiraRest?.bind(r.port), "jira.rest")(path, { query: o?.query, signal }), path);
  }),
  "confluence.rest": verb(z.tuple([restPath, restOptions.optional()]), async (r, [path, o], signal) => {
    r.require("confluence:read");
    return capRest(await hostOp(r.port.confluenceRest?.bind(r.port), "confluence.rest")(path, { query: o?.query, signal }), path);
  }),
  "confluence.search": verb(
    z.tuple([str, z.strictObject({ cursor: str.optional() }).optional()]),
    async (r, [cql, options], signal) => {
      r.require("confluence:read");
      return r.port.confluenceSearch(cql, { ...options, limit: SEARCH_PAGE_SIZE, signal });
    },
  ),
  "confluence.getPage": verb(z.tuple([str, z.strictObject({ storage: z.boolean().optional() }).optional()]), async (r, [id, o], signal) => {
    r.require("confluence:read");
    if (!o?.storage) return r.port.confluenceGetPage(r.readable(id), { signal });
    return hostOp(r.port.confluenceGetPageStorage, "confluence.getPage({ storage: true })").call(r.port, r.readable(id), { signal });
  }),
  "confluence.children": verb(z.tuple([str]), async (r, [id], signal) => {
    r.require("confluence:read");
    return hostOp(r.port.confluenceChildren, "confluence.children").call(r.port, r.readable(id), { signal });
  }),
  "confluence.copyAttachment": verb(z.tuple([str, str, str]), async (r, [attachmentId, sourcePageId, toPageId], signal) => {
    r.require("confluence:read");
    const target = await r.confluencePage(toPageId, signal);
    r.require(`confluence:write:${target.spaceKey}`);
    const source = (await r.port.confluenceAttachments(r.readable(sourcePageId), { signal })).find((a) => a.id === attachmentId);
    if (!source) throw new Error(`Page ${sourcePageId} has no attachment ${attachmentId}`);
    if (target.live) {
      const existing = (await r.port.confluenceAttachments(toPageId, { signal })).find((a) => a.name === source.name && a.size === source.size);
      if (existing) {
        r.skipped.push({ verb: "confluence.copyAttachment", target: toPageId, title: source.name, reason: "unchanged" });
        return { id: existing.id };
      }
    }
    // Copying never changes the target page's own content, so the target is no precondition object.
    const seq = await r.record("confluence.copyAttachment", { attachmentId, sourcePageId, toPageId, name: source.name, size: source.size });
    return { id: `plan:${seq}` };
  }),
  "confluence.comments": verb(z.tuple([str]), async (r, [pageId], signal) => {
    r.require("confluence:read");
    return r.port.confluenceComments(r.readable(pageId), { signal });
  }),
  "confluence.attachments": verb(z.tuple([str]), async (r, [pageId], signal) => {
    r.require("confluence:read");
    return r.port.confluenceAttachments(r.readable(pageId), { signal });
  }),
  "confluence.createPage": verb(z.tuple([createPageInput]), async (r, [input]) => {
    r.require(`confluence:write:${input.space}`);
    return { id: `plan:${await createPage(r, input)}` };
  }),
  "confluence.updatePage": verb(
    z.tuple([str, z.strictObject({ title: str.optional(), markdown: z.string() })]),
    async (r, [id, input], signal) => {
      const page = await r.confluencePage(id, signal);
      r.require(`confluence:write:${page.spaceKey}`);
      await updatePage(r, id, input.title ?? page.title, input.markdown, page.live);
      return { id };
    },
  ),
  "confluence.upsertPage": verb(z.tuple([pageInput]), async (r, [input], signal) => {
    r.require(`confluence:write:${input.space}`);
    const planned = r.lastWrite(titleObject(input.space, input.title));
    if (planned) {
      await updatePage(r, `plan:${planned}`, input.title, input.markdown);
      return { id: `plan:${planned}`, created: true };
    }
    const existing = await r.port.confluenceFindPage(input.space, input.title, { signal });
    if (!existing) return { id: `plan:${await createPage(r, input)}`, created: true };
    const page = await r.confluencePage(existing.id, signal);
    await updatePage(r, existing.id, input.title, input.markdown, page.live);
    return { id: existing.id, created: false };
  }),
  "confluence.addLabels": verb(z.tuple([str, labels]), async (r, [pageId, list], signal) => {
    const page = await r.confluencePage(pageId, signal);
    r.require(`confluence:write:${page.spaceKey}`);
    await r.record("confluence.addLabels", { pageId, labels: list });
    return null;
  }),
  "confluence.removeLabels": verb(z.tuple([str, labels]), async (r, [pageId, list], signal) => {
    const page = await r.confluencePage(pageId, signal);
    r.require(`confluence:write:${page.spaceKey}`);
    await r.record("confluence.removeLabels", { pageId, labels: list });
    return null;
  }),
  "confluence.comment": verb(z.tuple([str, z.string().min(1)]), async (r, [pageId, markdown], signal) => {
    const page = await r.confluencePage(pageId, signal);
    r.require(`confluence:write:${page.spaceKey}`);
    const seq = await r.record("confluence.comment", { pageId, markdown });
    return { id: `plan:${seq}` };
  }),
  "confluence.movePage": verb(z.tuple([str, z.strictObject({ parentId: str })]), async (r, [id, { parentId }], signal) => {
    const page = await r.confluencePage(id, signal);
    const parent = await r.confluencePage(parentId, signal);
    r.require(`confluence:write:${page.spaceKey}`);
    if (parent.spaceKey !== page.spaceKey) {
      throw new Error(`Page ${id} is in ${page.spaceKey} and cannot move under ${parentId} in ${parent.spaceKey}`);
    }
    if (parentId === id) throw new Error(`Page ${id} cannot be its own parent`);
    const untouched = page.live && r.lastWrite(`confluence:${id}`) === undefined;
    if (untouched && page.live!.parentId === parentId) {
      r.skipped.push({ verb: "confluence.movePage", target: id, title: page.title, reason: "unchanged" });
      return { id };
    }
    await r.record("confluence.movePage", { id, parentId }, `confluence:${id}`, async () => pageUnchanged(page.live));
    return { id };
  }),
  "confluence.deletePage": verb(z.tuple([str]), async (r, [id], signal) => {
    if (PLACEHOLDER.test(id)) throw new Error(`${id} is created by this plan; leave out the createPage instead`);
    const page = await r.confluencePage(id, signal);
    r.require(`confluence:write:${page.spaceKey}`);
    await r.record("confluence.deletePage", { id, title: page.title }, `confluence:${id}`, async () => pageUnchanged(page.live));
    r.markDeleted(id);
    return null;
  }),
  "confluence.archivePage": verb(z.tuple([str]), async (r, [id], signal) => {
    if (PLACEHOLDER.test(id)) throw new Error(`${id} is created by this plan; leave out the createPage instead`);
    const page = await r.confluencePage(id, signal);
    r.require(`confluence:write:${page.spaceKey}`);
    await r.record("confluence.archivePage", { id, title: page.title }, `confluence:${id}`, async () => pageUnchanged(page.live));
    return null;
  }),
  "confluence.attach": verb(z.tuple([str, attachmentInput]), async (r, [pageId, file], signal) => {
    const page = await r.confluencePage(pageId, signal);
    r.require(`confluence:write:${page.spaceKey}`);
    const seq = await r.record("confluence.attach", { pageId, ...checkAttachment(file) });
    return { id: `plan:${seq}` };
  }),
  "confluence.export": verb(z.tuple([str, exportOptions]), async (r, [pageId, { format, path }], signal) => {
    r.require("confluence:read");
    await r.confluencePage(pageId, signal);
    const file = checkExportPath(path ?? `${pageId.replace(":", "-")}.${format}`, format);
    if (r.exportPaths.has(file)) throw new Error(`${file} is already exported by this plan`);
    r.exportPaths.add(file);
    await r.record("confluence.export", { pageId, format, path: file });
    return { path: file };
  }),
};

/** Whether `user` watches the issue now; hosts without watcher reads count as "not known" (false). */
async function watching(r: Recorder, key: string, user: JiraUserRef, signal: AbortSignal): Promise<boolean> {
  if (!r.port.jiraWatchers) return false;
  return (await r.port.jiraWatchers(key, { signal })).some((w) => sameUser(w, user));
}

async function editIssueLabels(
  r: Recorder,
  verb: "jira.addLabels" | "jira.removeLabels",
  key: string,
  list: string[],
  signal: AbortSignal,
): Promise<null> {
  r.require(`jira:write:${r.jiraProject(key)}`);
  const issue = await untouchedIssue(r, key, ["labels"], signal);
  if (issue) {
    const current = new Set((issue.fields.labels as string[] | undefined) ?? []);
    const effective = list.filter((l) => current.has(l) === (verb === "jira.removeLabels"));
    if (effective.length === 0) {
      r.skipped.push({ verb, target: key, reason: "unchanged" });
      return null;
    }
  }
  await r.record(verb, { key, labels: [...new Set(list)] }, `jira:${key}`, async () =>
    issue ? { kind: "jira-issue-unchanged", key, updated: issue.fields.updated } : undefined,
  );
  return null;
}

/** A sprint's state and dates as the plan leaves them, plus write permission on its board's project. */
async function sprintFor(
  r: Recorder,
  ref: number | string,
  signal: AbortSignal,
): Promise<{ state: JiraSprintState; live: boolean; startDate?: string; endDate?: string }> {
  const placeholder = PLACEHOLDER.exec(String(ref));
  if (placeholder) {
    const op = r.operation(Number(placeholder[1]));
    if (op.verb !== "jira.createSprint") throw new Error(`${ref} is not a sprint created by this plan`);
    const boardId = op.args.boardId as number;
    r.requireBoardWrite(await r.port.jiraGetBoard(boardId, { signal }), `Board ${boardId}`);
    return { state: r.sprintStates.get(String(ref)) ?? "future", live: false, ...r.sprintDates.get(String(ref)) };
  }
  const sprint = await r.port.jiraGetSprint(ref as number, { signal });
  const board = sprint.boardId === undefined ? undefined : await r.port.jiraGetBoard(sprint.boardId, { signal });
  r.requireBoardWrite(board, `Sprint ${ref}`);
  const planned = r.sprintStates.get(String(ref));
  const dates = r.sprintDates.get(String(ref)) ?? { startDate: sprint.startDate, endDate: sprint.endDate };
  return { state: planned ?? sprint.state, live: planned === undefined, ...dates };
}

/** Decoded size check; base64 must be well-formed. */
function checkAttachment(file: z.output<typeof attachmentInput>): AttachmentInput {
  const encoding = file.encoding ?? "utf8";
  let bytes: number;
  if (encoding === "base64") {
    const clean = file.content.replace(/\s+/g, "");
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(clean) || clean.length % 4 !== 0) throw new Error(`Attachment ${file.name}: content is not valid base64`);
    bytes = (clean.length / 4) * 3 - (clean.endsWith("==") ? 2 : clean.endsWith("=") ? 1 : 0);
  } else {
    bytes = new TextEncoder().encode(file.content).length;
  }
  if (bytes > MAX_ATTACHMENT_BYTES) {
    throw new Error(`Attachment ${file.name} is ${bytes} bytes; the limit is ${MAX_ATTACHMENT_BYTES} bytes`);
  }
  return { name: file.name, content: file.content, encoding };
}

/**
 * An export target must stay below the host's output directory: relative,
 * forward slashes, no `..` or empty segments, extension matching the format.
 * Checked when planning and again by the host before writing, because a plan
 * file is editable.
 */
export function checkExportPath(path: string, format: ExportFormat): string {
  const segments = path.split("/");
  const bad =
    path.startsWith("/") ||
    path.includes("\\") ||
    /^[A-Za-z]:/.test(path) ||
    path.startsWith("~") ||
    segments.some((s) => s === "" || s === "..") ||
    /[\u0000-\u001f]/.test(path);
  if (bad) throw new Error(`Export path must be relative and stay inside the output directory: ${JSON.stringify(path)}`);
  if (!path.toLowerCase().endsWith(`.${format}`)) throw new Error(`Export path ${JSON.stringify(path)} must end in .${format}`);
  return segments.filter((s) => s !== ".").join("/");
}

const titleObject = (space: string, title: string) => `confluence-title:${space}\u0000${title}`;

function createPage(r: Recorder, input: z.output<typeof createPageInput>): Promise<number> {
  if (r.lastWrite(titleObject(input.space, input.title))) {
    throw new Error(`Page "${input.title}" in ${input.space} is already created by this plan; use updatePage or upsertPage`);
  }
  if (input.parentId) r.notDeleted(input.parentId);
  const args = {
    spaceKey: input.space,
    title: input.title,
    ...(input.storage !== undefined ? { storage: input.storage } : { markdown: input.markdown }),
    ...(input.parentId ? { parentId: input.parentId } : {}),
    ...(input.properties ? { properties: input.properties } : {}),
  };
  return r.record("confluence.createPage", args, titleObject(input.space, input.title), async () => ({
    kind: "confluence-title-absent",
    spaceKey: input.space,
    title: input.title,
  }));
}

async function updatePage(r: Recorder, id: string, title: string, markdown: string, live?: ConfluencePageView): Promise<void> {
  // Reads show the state before the plan, so only a page the plan has not
  // written yet can be compared; after an earlier write, A → B → A is real.
  const untouched = live && r.lastWrite(`confluence:${id}`) === undefined;
  if (untouched && live.title === title && r.port.confluenceNormalizeMarkdown(markdown) === live.markdown) {
    r.skipped.push({ verb: "confluence.updatePage", target: id, title, reason: "unchanged" });
    return;
  }
  await r.record("confluence.updatePage", { id, title, markdown }, `confluence:${id}`, () => pageUnchanged(live));
}

/** Guest-side shims: list verbs become async iterators with an optional `limit`. */
const CORE_WRAPPERS: Record<string, string> = {
  "jira.search": pagedIterator("issues", "pageToken", "nextPageToken"),
  "jira.boards": pagedIterator("boards", "startAt", "next", false),
  "jira.sprints": pagedIterator("sprints", "startAt", "next"),
  "confluence.search": pagedIterator("results", "cursor", "nextCursor"),
};

const VERBS: Record<string, Verb> = { ...CORE_VERBS, ...JIRA_VERBS, ...CONFLUENCE_VERBS, ...LOCAL_VERBS };
const WRAPPERS: Record<string, string> = { ...CORE_WRAPPERS, ...CONFLUENCE_WRAPPERS, ...LOCAL_WRAPPERS };

/** Names of all `atlcli.*` functions a script can call. */
export const SCRIPT_VERBS = Object.freeze(Object.keys(VERBS));

/**
 * Runs a script in plan mode: reads go live through `port`, writes are
 * recorded as operations with preconditions. Nothing is written. `meta` is
 * read and validated before any script code runs.
 */
export async function planScript(js: string, options: PlanScriptOptions): Promise<ScriptRunPlan> {
  const meta = parseMetaOrThrow(await extractScriptMeta(js, { variant: options.variant }));
  let params: ScriptParams;
  try {
    params = resolveScriptParams(meta, options.params);
  } catch (error) {
    throw new ScriptError("invalid-script", error instanceof Error ? error.message : String(error));
  }
  for (const name of meta.secrets ?? []) {
    if (options.port.secret && !options.port.secret(name)) {
      throw new ScriptError("invalid-script", `Secret ${name} is not set: export ATLCLI_SECRET_${name}`);
    }
  }
  const recorder = new Recorder(
    options.port,
    meta,
    options.maxWrites ?? maxWritesOf(meta),
    options.templating,
    options.memo,
    options.readOnly,
    meta.name ?? options.name ?? "script",
  );
  if (options.noOutput !== undefined) recorder.noOutput = options.noOutput;
  const host: Record<string, HostFunction> = {};
  for (const [name, definition] of Object.entries(VERBS)) {
    host[name] = async (rawArgs, signal) => {
      const parsed = definition.args.safeParse(trimTrailingNulls(rawArgs));
      if (!parsed.success) {
        const issue = parsed.error.issues[0]!;
        throw new TypeError(`Invalid arguments for atlcli.${name}: ${[...issue.path].join(".") || "args"}: ${issue.message}`);
      }
      return definition.run(recorder, parsed.data as never, signal);
    };
  }
  const result = await runScript(js, {
    host,
    wrappers: WRAPPERS,
    params,
    ...(options.item !== undefined ? { item: options.item } : {}),
    ...(options.items !== undefined ? { items: options.items } : {}),
    ...(options.entry !== undefined ? { entry: options.entry } : {}),
    ...(options.prelude !== undefined ? { prelude: options.prelude } : {}),
    ...(options.modules !== undefined ? { modules: options.modules } : {}),
    limits: options.limits,
    onLog: options.onLog,
    variant: options.variant,
  });
  return {
    meta,
    params,
    value: result.value,
    operations: recorder.operations,
    skipped: recorder.skipped,
    hostCalls: result.hostCalls,
    // Only a run that rendered depends on the clock and vars, so only it records them.
    ...(options.templating && recorder.rendered ? { templating: { now: options.templating.now, vars: options.templating.vars } } : {}),
    renderWarnings: recorder.renderWarnings,
  };
}

/** Reads and validates a script's `meta` without running any script code. */
export async function inspectScript(js: string, options: Pick<RunScriptOptions, "variant"> = {}): Promise<ScriptMeta> {
  return parseMetaOrThrow(await extractScriptMeta(js, options));
}

function parseMetaOrThrow(raw: unknown): ScriptMeta {
  try {
    return parseScriptMeta(raw);
  } catch (error) {
    throw new ScriptError("invalid-script", error instanceof Error ? error.message : String(error));
  }
}

/** Optional trailing arguments arrive as JSON null; tuples expect them absent. */
function trimTrailingNulls(args: unknown[]): unknown[] {
  let end = args.length;
  while (end > 0 && args[end - 1] === null) end--;
  return args.slice(0, end);
}
