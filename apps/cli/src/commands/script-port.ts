import type { LookupAddress, LookupOptions } from "node:dns";
import { lookup } from "node:dns/promises";
import { lstat, mkdir, open, readdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { brotliDecompressSync, gunzipSync, inflateSync } from "node:zlib";
import { ConfluenceClient, type FooterComment, type InlineComment, markdownToStorage, storageToMarkdown } from "@atlcli/confluence";
import type { Profile } from "@atlcli/core";
import {
  adfToMarkdown,
  cloneIssue,
  copyAttachment,
  findTransition,
  formatWorklogDate,
  JiraClient,
  type JiraComponent,
  type JiraIssue,
  type JiraSprint,
  type JiraTransition,
  type JiraUser,
  type JiraVersion,
  resolveUser,
  toJiraRichText,
} from "@atlcli/jira";
import type {
  AttachmentInput,
  ConfluenceCommentView,
  HttpRequestInput,
  HttpResponseView,
  ConfluenceInlineCommentView,
  JiraBoardView,
  JiraIssueView,
  JiraSprintView,
  ScriptPort,
} from "@atlcli/script-runtime";
import { readLinesPage } from "./file-lines.js";
import { createTemplateRenderer } from "./template-flags.js";

/** Content property linking a copied page to its original (read back for resuming). */
const COPIED_FROM = "atlcli.copiedFrom";

/** A port whose clients are created on first use: a Confluence-only script never builds a Jira client. */
export function createLazyCliScriptPort(profile: Profile, outDir = process.cwd()): ScriptPort {
  return createCliScriptPort(once(() => new JiraClient(profile)), once(() => new ConfluenceClient(profile)), profile.baseUrl, {
    profileName: profile.name,
    outDir,
  });
}

/** Largest HTTP response and local file the port hands to a script. */
const MAX_LOCAL_BYTES = 10 * 1024 * 1024;
const HTTP_TIMEOUT_MS = 60_000;
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
/** State stores: one JSON file per script name. */
export const stateRoot = () => join(homedir(), ".atlcli", "state");

function once<T>(make: () => T): () => T {
  let value: T | undefined;
  return () => (value ??= make());
}

/**
 * ScriptPort over the CLI's REST clients: paging, retries and Markdown ↔
 * Storage/ADF conversion are the clients' and converters' existing behaviour.
 */
export function createCliScriptPort(
  jira: () => JiraClient,
  confluence: () => ConfluenceClient,
  baseUrl: string,
  { profileName, outDir = process.cwd(), stateDir = stateRoot() }: { profileName: string; outDir?: string; stateDir?: string },
): ScriptPort {
  const conversion = { baseUrl };
  const richText = (markdown: string) => toJiraRichText(jira(), markdown);
  /**
   * Moves an issue with screen fields and a comment. Jira drops a comment sent
   * with a transition that has no screen (silently), so it is added after.
   */
  const transitionWith = async (key: string, transition: JiraTransition, options?: { fields?: Record<string, unknown>; comment?: string }) => {
    const inline = options?.comment && transition.hasScreen !== false;
    await jira().transitionIssue(key, {
      transition: { id: transition.id },
      ...(options?.fields ? { fields: options.fields } : {}),
      ...(inline ? { update: { comment: [{ add: { body: richText(options!.comment!) } }] } } : {}),
    });
    if (options?.comment && !inline) await jira().addComment(key, richText(options.comment));
  };

  const projects = new Map<string, Promise<{ id: string; key: string }>>();
  /** Project id and key by key or id, looked up once per port. */
  const projectRef = (keyOrId: string) => {
    let hit = projects.get(keyOrId);
    if (!hit) {
      hit = jira()
        .getProject(keyOrId)
        .then((p) => ({ id: String(p.id), key: p.key }));
      projects.set(keyOrId, hit);
    }
    return hit;
  };
  const projectKey = async (id: string) => (await projectRef(id)).key;

  return {
    async jiraSearch(jql, { fields, properties, pageToken, maxResults, signal }) {
      const page = await jira().search(jql, {
        fields: withUpdated(fields),
        ...(properties?.length ? { properties } : {}),
        maxResults,
        ...(pageToken ? { nextPageToken: pageToken } : {}),
        signal,
      });
      return { issues: page.issues.map(issueView), ...(page.nextPageToken ? { nextPageToken: page.nextPageToken } : {}) };
    },
    jiraRest: (path, { query, signal }) => jira().getJson(path, { query, signal }),
    confluenceRest: (path, { query, signal }) =>
      confluence().getJson(path, {
        query: query && Object.fromEntries(Object.entries(query).map(([k, v]) => [k, typeof v === "boolean" ? String(v) : v])),
        signal,
      }),
    async jiraGetIssue(key, { fields, signal }) {
      return issueView(await jira().getIssue(key, { fields: withUpdated(fields), signal }));
    },
    async jiraGetTransitions(key) {
      return (await jira().getTransitions(key)).map((t) => t.name);
    },
    async jiraCreateIssue({ project, type, summary, description, fields, properties }) {
      const issue = await jira().createIssue({
        fields: {
          ...fields,
          project: { key: project },
          issuetype: { name: type },
          summary,
          ...(description !== undefined ? { description: richText(description) } : {}),
        },
        ...(properties ? { properties: Object.entries(properties).map(([key, value]) => ({ key, value })) } : {}),
      });
      return { id: issue.id, key: issue.key };
    },
    async jiraUpdateIssue(key, { summary, description, fields }) {
      await jira().updateIssue(key, {
        fields: {
          ...fields,
          ...(summary !== undefined ? { summary } : {}),
          ...(description !== undefined ? { description: richText(description) } : {}),
        },
      });
    },
    async jiraTransitionIssue(key, name, options) {
      const transitions = await jira().getTransitions(key);
      const transition = findTransition(transitions, name);
      if (!transition) {
        throw new Error(`Transition "${name}" is not available for ${key} (available: ${transitions.map((t) => t.name).join(", ") || "none"})`);
      }
      await transitionWith(key, transition, options);
    },
    async jiraSetStatus(key, status, options) {
      const wanted = status.toLowerCase();
      const transitions = await jira().getTransitions(key);
      const transition =
        transitions.find((t) => t.to?.name?.toLowerCase() === wanted) ?? transitions.find((t) => t.name.toLowerCase() === wanted);
      if (!transition) return { moved: false };
      await transitionWith(key, transition, options);
      return { moved: true, transition: transition.name };
    },
    async jiraTransitions(key) {
      return (await jira().getTransitions(key)).map((t) => ({
        name: t.name,
        to: { name: t.to?.name ?? "", ...(t.to?.statusCategory?.key ? { category: t.to.statusCategory.key } : {}) },
      }));
    },
    async jiraHistory(key, { fields }) {
      const wanted = fields?.map((f) => f.toLowerCase());
      const changes = [];
      for (let startAt = 0; ; ) {
        const page = await jira().getChangelog(key, { startAt, maxResults: 100 });
        for (const entry of page.values) {
          for (const item of entry.items) {
            const field = item.fieldId ?? item.field;
            if (wanted && !wanted.includes(field.toLowerCase()) && !wanted.includes(item.field.toLowerCase())) continue;
            changes.push({
              at: entry.created,
              ...(entry.author?.displayName ? { author: entry.author.displayName } : {}),
              field,
              from: item.fromString ?? item.from ?? null,
              to: item.toString ?? item.to ?? null,
            });
          }
        }
        startAt += page.values.length;
        if (page.isLast || page.values.length === 0) break;
      }
      return changes.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    },
    async jiraWatchers(key) {
      return (await jira().getWatchers(key)).watchers.map((w) => ({
        ...(w.accountId ? { accountId: w.accountId } : {}),
        ...((w as { name?: string }).name ? { name: (w as { name?: string }).name } : {}),
        ...(w.displayName ? { displayName: w.displayName } : {}),
      }));
    },
    async jiraAddWatcher(key, user) {
      await jira().addWatcher(key, "accountId" in user ? user.accountId : user.name);
    },
    async jiraRemoveWatcher(key, user) {
      await jira().removeWatcher(key, "accountId" in user ? user.accountId : user.name);
    },
    async jiraNotify(key, { subject, markdown, to }) {
      const { users, groups, ...flags } = to;
      await jira().notifyIssue(key, {
        subject,
        textBody: markdown,
        htmlBody: markdownToStorage(markdown, conversion),
        to: { ...flags, ...(users ? { users } : {}), ...(groups ? { groups: groups.map((name) => ({ name })) } : {}) },
      });
    },
    async jiraAddComment(key, body) {
      const comment = await jira().addComment(key, typeof body === "string" ? richText(body) : (body.raw as never));
      return { id: String(comment.id) };
    },
    async jiraLinkTypes() {
      return (await jira().getIssueLinkTypes()).issueLinkTypes.map(({ name, inward, outward }) => ({ name, inward, outward }));
    },
    async jiraLinkIssues({ type, from, to }) {
      // Jira reads the pair as "inwardIssue <outward phrase> outwardIssue", as `jira issue link` sends it.
      await jira().createIssueLink({ type: { name: type }, inwardIssue: { key: from }, outwardIssue: { key: to } });
    },
    async jiraFindUser(query) {
      const user = await resolveUser(jira(), query);
      if (!user) throw new Error(`"${query}" names no user; pass null to unassign`);
      return user;
    },
    async jiraAssignIssue(key, user) {
      await jira().assignIssue(key, user);
    },
    async jiraEditLabels(key, { add = [], remove = [] }) {
      await jira().updateIssue(key, {
        update: { labels: [...add.map((label) => ({ add: label })), ...remove.map((label) => ({ remove: label }))] },
      });
    },
    async jiraAttach(key, file) {
      const [attachment] = await jira().uploadAttachment(key, file.name, Buffer.from(decode(file)));
      return { id: String(attachment?.id ?? "") };
    },
    async jiraAttachmentInfo(id) {
      const { filename, size, mimeType } = await jira().getAttachment(id);
      return { id, filename, size, mimeType };
    },
    async jiraCopyAttachment(id, toKey) {
      return { id: String((await copyAttachment(jira(), id, toKey)).id) };
    },
    async jiraBoards({ project, name, startAt, maxResults }) {
      const page = await jira().listBoards({ startAt, maxResults, ...(project ? { projectKeyOrId: project } : {}), ...(name ? { name } : {}) });
      const boards = page.values.map((b) => boardView(b));
      const next = startAt + page.values.length;
      return { boards, ...(page.values.length > 0 && next < page.total ? { next } : {}) };
    },
    async jiraGetBoard(id) {
      return boardView(await jira().getBoard(id));
    },
    async jiraSprints(boardId, { state, startAt, maxResults }) {
      const page = await jira().listSprints(boardId, { startAt, maxResults, ...(state ? { state } : {}) });
      const sprints = page.values.map((s) => sprintView({ ...s, originBoardId: boardId } as JiraSprint));
      const next = startAt + page.values.length;
      return { sprints, ...(page.values.length > 0 && next < page.total ? { next } : {}) };
    },
    async jiraGetSprint(id) {
      return sprintView(await jira().getSprint(id));
    },
    async jiraCreateSprint({ boardId, ...input }) {
      const sprint = await jira().createSprint({ ...input, name: input.name, originBoardId: boardId });
      return { id: sprint.id };
    },
    async jiraUpdateSprint(id, input) {
      await jira().updateSprint(id, input.state === "closed" ? { ...input, completeDate: new Date().toISOString() } : input);
    },
    async jiraMoveToSprint(sprintId, keys) {
      // The Agile API takes at most 50 issues per call.
      for (let i = 0; i < keys.length; i += 50) await jira().moveIssuesToSprint(sprintId, keys.slice(i, i + 50));
    },

    async confluenceSearch(cql, { cursor, limit, signal }) {
      const start = cursor ? Number(cursor) : 0;
      const page = await confluence().search(cql, { limit, start, detail: "minimal", signal });
      return {
        results: page.results.map((r) => ({ id: r.id, title: r.title, spaceKey: r.spaceKey ?? "" })),
        ...(page.hasMore ? { nextCursor: String(start + page.results.length) } : {}),
      };
    },
    async confluenceGetPage(id, { signal }) {
      const page = await confluence().getPage(id, { signal });
      return {
        id: page.id,
        title: page.title,
        spaceKey: page.spaceKey ?? "",
        version: page.version ?? 1,
        ...(page.parentId ? { parentId: page.parentId } : {}),
        markdown: storageToMarkdown(page.storage, conversion),
      };
    },
    async confluenceFindPage(spaceKey, title, { signal }) {
      const matches = (await confluence().findPagesByTitle(title, { spaceKey, signal }))
        .filter((p) => p.title === title)
        .sort((a, b) => Number(a.id) - Number(b.id));
      if (matches.length === 0) return null;
      const page = await confluence().getPage(matches[0]!.id, { signal });
      return { id: page.id, version: page.version ?? 1 };
    },
    async confluenceCreatePage({ spaceKey, title, markdown, storage, parentId, properties }) {
      const page = await confluence().createPage({
        spaceKey,
        title,
        storage: storage ?? markdownToStorage(markdown ?? "", conversion),
        ...(parentId ? { parentId } : {}),
      });
      for (const [key, value] of Object.entries(properties ?? {})) await confluence().upsertPageProperty(page.id, key, value);
      return { id: page.id, version: page.version ?? 1 };
    },
    async confluenceGetPageStorage(id, { signal }) {
      const page = await confluence().getPage(id, { signal });
      const copiedFrom = await confluence().getPagePropertyByKey(page.id, COPIED_FROM);
      return {
        id: page.id,
        title: page.title,
        spaceKey: page.spaceKey ?? "",
        version: page.version ?? 1,
        ...(page.parentId ? { parentId: page.parentId } : {}),
        storage: page.storage ?? "",
        properties: copiedFrom === undefined ? {} : { [COPIED_FROM]: copiedFrom },
      };
    },
    async confluenceChildren(id, { signal }) {
      // In page-tree order, so copies keep their siblings' order.
      const children = await confluence().getChildrenWithPosition(id, { signal });
      return children.map((c) => ({ id: c.id, title: c.title, spaceKey: c.spaceKey ?? "" }));
    },
    async confluenceCopyAttachment(attachmentId, sourcePageId, toPageId) {
      // ponytail: in memory, one attachment at a time; stream through a temp file like Jira if pages carry huge files
      const source = (await confluence().listAttachments(sourcePageId, { limit: 250 })).find((a) => a.id === attachmentId);
      if (!source) throw new Error(`Page ${sourcePageId} has no attachment ${attachmentId}`);
      const data = await confluence().downloadAttachment(source);
      const copy = await confluence().uploadAttachment({ pageId: toPageId, filename: source.filename, data, mimeType: source.mediaType });
      return { id: copy.id };
    },
    async confluenceUpdatePage({ id, title, markdown, version }) {
      const page = await confluence().updatePage({ id, title, storage: markdownToStorage(markdown, conversion), version: version + 1 });
      return { id: page.id, version: page.version ?? version + 1 };
    },
    async confluenceAddLabels(pageId, labels) {
      await confluence().addLabels(pageId, labels);
    },
    async confluenceRemoveLabels(pageId, labels) {
      for (const label of labels) {
        try {
          await confluence().removeLabel(pageId, label);
        } catch (error) {
          // Confluence answers 404 for a label the page does not have; removing it is then done.
          if (!/No label found/.test(String(error))) throw error;
        }
      }
    },
    async confluenceComments(pageId) {
      const view = (c: FooterComment): ConfluenceCommentView => ({
        id: c.id,
        ...(c.author?.accountId ? { authorId: c.author.accountId } : {}),
        ...(c.created ? { created: c.created } : {}),
        status: c.status,
        markdown: storageToMarkdown(c.body, conversion),
        replies: (c.replies ?? []).map(view),
      });
      return (await confluence().getFooterComments(pageId)).map(view);
    },
    async confluenceAddComment(pageId, markdown) {
      const comment = await confluence().createFooterComment({ pageId, body: markdownToStorage(markdown, conversion) });
      return { id: comment.id };
    },
    async confluenceMovePage(id, parentId) {
      const page = await confluence().movePage(id, parentId);
      return { id: page.id, version: page.version ?? 1 };
    },
    async confluenceArchivePage(id) {
      await confluence().archivePage(id);
    },
    async confluenceDeletePage(id) {
      await confluence().deletePage(id);
    },
    async confluenceAttachments(pageId, { signal }) {
      return (await confluence().listAttachments(pageId, { signal })).map((a) => ({
        id: a.id,
        name: a.filename,
        mediaType: a.mediaType,
        size: a.fileSize,
        version: a.version,
      }));
    },
    async confluenceAttach(pageId, file) {
      const data = decode(file);
      const existing = (await confluence().listAttachments(pageId)).find((a) => a.filename === file.name);
      const attachment = existing
        ? await confluence().updateAttachment({ attachmentId: existing.id, pageId, filename: file.name, data })
        : await confluence().uploadAttachment({ pageId, filename: file.name, data });
      return { id: attachment.id };
    },
    async confluenceExport({ pageId, format, path }) {
      // The id becomes a positional argument of the child CLI: a plan file is
      // editable, so anything but a page id (e.g. "--template=…") is refused.
      if (!/^\d+$/.test(pageId)) throw new Error(`Not a Confluence page id: ${JSON.stringify(pageId)}`);
      if (format !== "pdf" && format !== "docx") throw new Error(`Unknown export format: ${JSON.stringify(format)}`);
      const target = resolve(outDir, path);
      await mkdir(dirname(target), { recursive: true });
      await runSelf(["wiki", "export", pageId, "--format", format, "--output", target, "--profile", profileName]);
      return { path, bytes: (await stat(target)).size };
    },
    confluenceNormalizeMarkdown(markdown) {
      return storageToMarkdown(markdownToStorage(markdown, conversion), conversion);
    },

    async jiraRequest(method, path, { body, query }) {
      return jira().requestJson(method, path, { body, query });
    },
    async confluenceRequest(method, path, { body, query }) {
      return confluence().requestJson(method, path, {
        body,
        query: query && Object.fromEntries(Object.entries(query).map(([k, v]) => [k, typeof v === "boolean" ? String(v) : v])),
      });
    },
    async jiraComments(key) {
      const comments = [];
      for (let startAt = 0; ; ) {
        const page = await jira().getComments(key, { startAt, maxResults: 100 });
        comments.push(...page.comments);
        startAt += page.comments.length;
        if (page.comments.length === 0 || startAt >= page.total) break;
      }
      return comments.map((c) => ({
        id: String(c.id),
        ...userView(c.author),
        ...(c.created ? { created: c.created } : {}),
        ...(c.updated ? { updated: c.updated } : {}),
        markdown: adfToMarkdown(c.body, conversion),
      }));
    },
    async jiraUpdateComment(key, id, body) {
      await jira().updateComment(key, id, typeof body === "string" ? richText(body) : (body.raw as never));
    },
    async jiraDeleteComment(key, id) {
      await jira().deleteComment(key, id);
    },
    async jiraWorklogs(key) {
      const worklogs = [];
      for (let startAt = 0; ; ) {
        const page = await jira().getWorklogs(key, { startAt, maxResults: 1000 });
        worklogs.push(...page.worklogs);
        startAt += page.worklogs.length;
        if (page.worklogs.length === 0 || startAt >= page.total) break;
      }
      return worklogs.map((w) => ({
        id: String(w.id),
        ...userView(w.author),
        started: w.started,
        timeSpentSeconds: w.timeSpentSeconds,
        ...(w.comment ? { markdown: adfToMarkdown(w.comment, conversion) } : {}),
      }));
    },
    async jiraAddWorklog(key, { timeSpentSeconds, started, comment }) {
      const worklog = await jira().addWorklog(key, timeSpentSeconds, {
        ...(started ? { started: formatWorklogDate(new Date(started)) } : {}),
        ...(comment ? { comment: richText(comment) } : {}),
      });
      return { id: String(worklog.id) };
    },
    async jiraVersions(project) {
      return (await jira().getProjectVersions(project)).map((v) => versionView(v, project));
    },
    async jiraGetVersion(id) {
      const version = (await jira().getVersion(id)) as JiraVersion & { projectId?: number | string };
      return versionView(version, version.projectId === undefined ? undefined : await projectKey(String(version.projectId)));
    },
    async jiraCreateVersion({ project, released, archived, ...input }) {
      const { id } = await projectRef(project);
      const version = await jira().createVersion({ projectId: id, ...(input as { name: string }) });
      // Jira's create takes no released/archived flags; they are set right after.
      if (released !== undefined || archived !== undefined) {
        await jira().updateVersion(version.id, { ...(released !== undefined ? { released } : {}), ...(archived !== undefined ? { archived } : {}) });
      }
      return { id: String(version.id) };
    },
    async jiraUpdateVersion(id, input) {
      await jira().updateVersion(id, input);
    },
    async jiraComponents(project) {
      return (await jira().getProjectComponents(project)).map((c) => componentView(c, project));
    },
    async jiraGetComponent(id) {
      const component = (await jira().getComponent(id)) as JiraComponent & { project?: string };
      return componentView(component, component.project);
    },
    async jiraCreateComponent({ project, name, description, lead }) {
      const component = await jira().createComponent({
        project,
        name,
        ...(description !== undefined ? { description } : {}),
        ...(lead && "accountId" in lead ? { leadAccountId: lead.accountId } : {}),
      });
      return { id: String(component.id) };
    },
    async jiraUpdateComponent(id, { lead, ...input }) {
      await jira().updateComponent(id, { ...input, ...(lead && "accountId" in lead ? { leadAccountId: lead.accountId } : {}) });
    },
    async jiraRank(keys, position) {
      const failed = await jira().rankIssues({ issues: keys, ...position });
      if (failed.length) throw new Error(`Rank failed for ${failed.map((f) => `${f.issueKey} (${f.errors.join("; ")})`).join(", ")}`);
    },
    async jiraDeleteIssue(key, { subtasks }) {
      await jira().deleteIssue(key, { deleteSubtasks: subtasks === true });
    },
    async jiraCloneIssue(key, { project, summary, link, attachments }) {
      const clone = await cloneIssue(jira(), key, {
        ...(project ? { project } : {}),
        ...(summary ? { summary } : {}),
        ...(link === false ? { link: false } : {}),
        ...(attachments ? { attachments: true } : {}),
      });
      // The clone exists; a failed link or attachment copy is reported, not undone.
      for (const warning of clone.warnings) process.stderr.write(`warning: ${warning}\n`);
      return { id: clone.id, key: clone.key };
    },
    async jiraLinks(key) {
      const issue = await jira().getIssue(key, { fields: ["issuelinks"] });
      return (issue.fields.issuelinks ?? []).map((l) => {
        const other = l.outwardIssue ?? l.inwardIssue!;
        const outward = l.outwardIssue !== undefined;
        return {
          id: String(l.id),
          type: l.type.name,
          direction: outward ? ("outward" as const) : ("inward" as const),
          phrase: outward ? l.type.outward : l.type.inward,
          issue: {
            key: other.key,
            ...(other.fields?.summary ? { summary: other.fields.summary } : {}),
            ...(other.fields?.status?.name ? { status: other.fields.status.name } : {}),
          },
        };
      });
    },
    async jiraDeleteLink(id) {
      await jira().deleteIssueLink(id);
    },
    async jiraFields() {
      return (await jira().getFields()).map((f) => ({ id: f.id, name: f.name, custom: f.custom, ...(f.schema?.type ? { type: f.schema.type } : {}) }));
    },
    async jiraUsers(query) {
      return (await jira().searchUsers(query, 50)).map((u) => ({
        ...(u.accountId ? { accountId: u.accountId } : {}),
        ...((u as { name?: string }).name ? { name: (u as { name?: string }).name } : {}),
        ...(u.displayName ? { displayName: u.displayName } : {}),
        ...(u.emailAddress ? { email: u.emailAddress } : {}),
        active: u.active !== false,
      }));
    },
    async jiraAttachments(key) {
      return (await jira().getIssueAttachments(key)).map((a) => ({
        id: String(a.id),
        filename: a.filename,
        size: a.size,
        mimeType: a.mimeType,
        ...(a.created ? { created: a.created } : {}),
        ...(a.author?.displayName ? { author: a.author.displayName } : {}),
      }));
    },

    async confluenceProperties(pageId, { signal }) {
      return confluence().listPageProperties(pageId, { signal });
    },
    async confluenceSetProperty(pageId, key, value) {
      await confluence().upsertPageProperty(pageId, key, value);
    },
    async confluenceDeleteProperty(pageId, key) {
      await confluence().deletePageProperty(pageId, key);
    },
    async confluenceRestrictions(pageId) {
      return confluence().getContentRestrictions(pageId);
    },
    async confluenceSetRestrictions(pageId, input) {
      // The REST call replaces the operations it names, so an operation left out keeps its restrictions.
      await confluence().setContentRestrictions(pageId, input);
    },
    async confluenceVersions(pageId) {
      return (await confluence().getPageHistory(pageId, { limit: 200 })).versions.map((v) => ({
        number: v.number,
        ...(v.when ? { when: v.when } : {}),
        ...(v.by?.displayName ? { by: v.by.displayName } : {}),
        ...(v.message ? { message: v.message } : {}),
        minorEdit: v.minorEdit,
      }));
    },
    async confluenceSpaces({ type, cursor, limit, signal }) {
      const start = cursor ? Number(cursor) : 0;
      const spaces = await confluence().listSpaces(limit, { start, ...(type ? { type } : {}), signal });
      return {
        results: spaces.map((sp) => ({ ...(sp.id !== undefined ? { id: String(sp.id) } : {}), key: sp.key, name: sp.name, type: sp.type })),
        ...(spaces.length === limit ? { nextCursor: String(start + spaces.length) } : {}),
      };
    },
    async confluenceInlineComments(pageId) {
      const view = (c: InlineComment): ConfluenceInlineCommentView => ({
        id: c.id,
        ...(c.author?.accountId ? { authorId: c.author.accountId } : {}),
        ...(c.created ? { created: c.created } : {}),
        status: c.status,
        ...(c.textSelection ? { selection: c.textSelection } : {}),
        markdown: storageToMarkdown(c.body, conversion),
        replies: (c.replies ?? []).map(view),
      });
      return (await confluence().getInlineComments(pageId)).map(view);
    },
    async confluenceCreateBlogPost({ spaceKey, title, markdown }) {
      return confluence().createBlogPost({ spaceKey, title, storage: markdownToStorage(markdown, conversion) });
    },

    httpFetch: (request, { signal }) => sendHttp(request, signal),
    secret(name) {
      return process.env[`ATLCLI_SECRET_${name}`];
    },
    async fileRead(path, { encoding }) {
      const target = await inside(outDir, path);
      if ((await stat(target)).size > MAX_LOCAL_BYTES) throw new Error(`${path} is larger than ${MAX_LOCAL_BYTES} bytes`);
      const data = await readFile(target);
      return encoding === "base64" ? data.toString("base64") : data.toString("utf8");
    },
    async fileLines(path, { format, limit, cursor }) {
      const target = await inside(outDir, path);
      const [offset, line] = (cursor ?? "0:0").split(":").map(Number) as [number, number];
      const file = await open(target, "r");
      try {
        // Grows the window until it holds a whole record (up to MAX_LOCAL_BYTES for one record).
        for (let size = 1024 * 1024; ; size *= 4) {
          const buffer = Buffer.alloc(size);
          const { bytesRead } = await file.read(buffer, 0, size, offset);
          const eof = bytesRead < size;
          let page;
          try {
            page = readLinesPage(buffer.subarray(0, bytesRead), { format, eof, max: limit, line, start: offset === 0 });
          } catch (error) {
            throw new Error(`${path}: ${error instanceof Error ? error.message : String(error)}`);
          }
          if (page.items.length === 0 && page.consumed === 0 && !eof) {
            if (size >= MAX_LOCAL_BYTES) throw new Error(`${path}: a record longer than ${MAX_LOCAL_BYTES} bytes at line ${line + 1}`);
            continue;
          }
          const done = eof && page.consumed >= bytesRead;
          return { items: page.items, ...(done ? {} : { cursor: `${offset + page.consumed}:${line + page.lines}` }) };
        }
      } finally {
        await file.close();
      }
    },
    async fileList(path) {
      const dir = await inside(outDir, path);
      const entries = await readdir(dir, { withFileTypes: true });
      const out = [];
      for (const entry of entries) {
        if (!entry.isFile() && !entry.isDirectory()) continue;
        out.push({ name: entry.name, type: entry.isFile() ? ("file" as const) : ("directory" as const), size: entry.isFile() ? (await stat(join(dir, entry.name))).size : 0 });
      }
      return out.sort((a, b) => a.name.localeCompare(b.name));
    },
    async fileWrite(path, content, { encoding }) {
      const target = resolve(outDir, path);
      await mkdir(dirname(target), { recursive: true });
      // The parent must resolve inside the output directory, and an existing link is never followed.
      await inside(outDir, dirname(path) || ".");
      const existing = await lstat(target).catch(() => undefined);
      if (existing?.isSymbolicLink()) throw new Error(`${path} is a symbolic link; not written`);
      const data = encoding === "base64" ? Buffer.from(content, "base64") : Buffer.from(content, "utf8");
      await writeFile(target, data);
      return { path, bytes: data.length };
    },
    async stateGet(store, key) {
      return (await readState(stateDir, store))[key];
    },
    async stateSet(store, key, value) {
      const state = await readState(stateDir, store);
      if (value === undefined) delete state[key];
      else state[key] = value;
      const file = statePath(stateDir, store);
      await mkdir(dirname(file), { recursive: true, mode: 0o700 });
      const tmp = `${file}.${process.pid}.tmp`;
      await writeFile(tmp, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
      await rename(tmp, file);
    },
    render: createTemplateRenderer(profileName),
  };
}

/** `updated` is the precondition basis, so it is always fetched. */
function withUpdated(fields: string[] | undefined): string[] | undefined {
  if (!fields) return undefined;
  return fields.includes("updated") || fields.includes("*all") || fields.includes("*navigable") ? fields : [...fields, "updated"];
}

function issueView(issue: JiraIssue): JiraIssueView {
  const fields = (issue.fields ?? {}) as unknown as Record<string, unknown> & { updated?: string };
  const properties = (issue as { properties?: Record<string, unknown> }).properties;
  return {
    id: issue.id,
    key: issue.key,
    fields: { ...fields, updated: String(fields.updated ?? "") },
    ...(properties && Object.keys(properties).length ? { properties } : {}),
  };
}

function boardView(board: { id: number; name: string; type: string; location?: { projectKey?: string } }): JiraBoardView {
  return { id: board.id, name: board.name, type: board.type, ...(board.location?.projectKey ? { projectKey: board.location.projectKey } : {}) };
}

function sprintView(s: JiraSprint): JiraSprintView {
  const boardId = s.originBoardId ?? s.boardId;
  return {
    id: s.id,
    name: s.name,
    state: s.state,
    ...(boardId !== undefined ? { boardId } : {}),
    ...(s.startDate ? { startDate: s.startDate } : {}),
    ...(s.endDate ? { endDate: s.endDate } : {}),
    ...(s.goal ? { goal: s.goal } : {}),
  };
}

function decode(file: AttachmentInput): Uint8Array {
  return file.encoding === "base64" ? Buffer.from(file.content, "base64") : new TextEncoder().encode(file.content);
}

/**
 * Runs this CLI as a child process. Export already exists as a command with
 * its own templates, engines and error handling, and `fail()` ends the
 * process, so a child keeps a failed export from ending the apply mid-plan.
 */
async function runSelf(args: string[]): Promise<void> {
  const entry = process.argv[1] ?? "";
  // A compiled binary's entry lives in Bun's embedded file system; the binary is the CLI.
  const compiled = entry.startsWith("/$bunfs/") || /^[A-Za-z]:[\\/]~BUN[\\/]/.test(entry);
  const command = compiled ? [process.execPath, ...args] : [process.execPath, ...process.execArgv, entry, ...args];
  const child = Bun.spawn(command, { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code === 0) return;
  // The command's own error is its last line; earlier lines are progress.
  const message = (stderr.trim() || stdout.trim()).split("\n").at(-1)?.replace(/\.$/, "");
  throw new Error(`${args.slice(0, 2).join(" ")} failed (exit ${code}): ${message || "no output"}`);
}

function userView(user: JiraUser | undefined): { author?: { accountId?: string; displayName?: string } } {
  if (!user) return {};
  return { author: { ...(user.accountId ? { accountId: user.accountId } : {}), ...(user.displayName ? { displayName: user.displayName } : {}) } };
}

function versionView(v: JiraVersion, project: string | undefined) {
  return {
    id: String(v.id),
    name: v.name,
    ...(project ? { project } : {}),
    ...(v.description ? { description: v.description } : {}),
    released: v.released === true,
    archived: v.archived === true,
    ...(v.startDate ? { startDate: v.startDate } : {}),
    ...(v.releaseDate ? { releaseDate: v.releaseDate } : {}),
  };
}

function componentView(c: JiraComponent, project: string | undefined) {
  return {
    id: String(c.id),
    name: c.name,
    ...(project ? { project } : {}),
    ...(c.description ? { description: c.description } : {}),
    ...(c.lead ? { lead: { ...(c.lead.accountId ? { accountId: c.lead.accountId } : {}), ...(c.lead.displayName ? { displayName: c.lead.displayName } : {}) } } : {}),
  };
}

/**
 * One HTTP request, redirects not followed. Hosts other than the explicit
 * local names may not be or resolve to private, loopback or link-local
 * addresses: the check runs in the connection's own DNS lookup, so the
 * address checked is the address connected to (no DNS rebinding).
 */
export function sendHttp(request: HttpRequestInput, signal?: AbortSignal): Promise<HttpResponseView> {
  const url = new URL(request.url);
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const local = LOCAL_HOSTS.has(url.hostname);
  if (!local && isIP(host) && isPrivateAddress(host)) return Promise.reject(new Error(`${url.hostname} is a private address; refused`));
  const timeout = AbortSignal.timeout(HTTP_TIMEOUT_MS);
  return new Promise((done, fail) => {
    const req = (url.protocol === "https:" ? httpsRequest : httpRequest)(
      url,
      {
        method: request.method,
        headers: request.headers,
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        ...(local ? {} : { lookup: publicLookup }),
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_LOCAL_BYTES) req.destroy(new Error(`Response is larger than ${MAX_LOCAL_BYTES} bytes`));
          else chunks.push(chunk);
        });
        res.on("error", fail);
        res.on("end", () => {
          try {
            const body = decoded(Buffer.concat(chunks), res.headers["content-encoding"]);
            if (body.length > MAX_LOCAL_BYTES) throw new Error(`Response is larger than ${MAX_LOCAL_BYTES} bytes`);
            const headers = Object.fromEntries(Object.entries(res.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(", ") : String(v ?? "")]));
            done({ status: res.statusCode ?? 0, headers, text: body.toString("utf8") });
          } catch (error) {
            fail(error);
          }
        });
      },
    );
    req.on("error", fail);
    req.end(request.body);
  });
}

/** DNS lookup for `http.request` that fails on private addresses. */
function publicLookup(hostname: string, options: LookupOptions, callback: (error: Error | null, address: string | LookupAddress[], family?: number) => void): void {
  lookup(hostname, { all: true, ...(options.family ? { family: options.family } : {}) }).then(
    (addresses) => {
      const blocked = addresses.find((a) => isPrivateAddress(a.address));
      if (blocked) callback(new Error(`${hostname} resolves to the private address ${blocked.address}; refused`), []);
      else if (options.all) callback(null, addresses);
      else callback(null, addresses[0]!.address, addresses[0]!.family);
    },
    (error: Error) => callback(error, []),
  );
}

/** A body as sent: gzip, deflate and br are undone (the script may ask for them). */
function decoded(body: Buffer, encoding: string | undefined): Buffer {
  if (encoding === "gzip") return gunzipSync(body, { maxOutputLength: MAX_LOCAL_BYTES + 1 });
  if (encoding === "deflate") return inflateSync(body, { maxOutputLength: MAX_LOCAL_BYTES + 1 });
  if (encoding === "br") return brotliDecompressSync(body, { maxOutputLength: MAX_LOCAL_BYTES + 1 });
  return body;
}

export function isPrivateAddress(address: string): boolean {
  const v4 = /^(?:::ffff:)?(\d+)\.(\d+)\.(\d+)\.(\d+)$/i.exec(address);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  // The URL parser writes every IPv6 form the same way, an IPv4-mapped address as ::ffff:7f00:1.
  const v6 = new URL(`http://[${address}]`).hostname.slice(1, -1);
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(v6);
  if (mapped) {
    const [hi, lo] = [parseInt(mapped[1]!, 16), parseInt(mapped[2]!, 16)];
    return isPrivateAddress(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
  }
  return v6 === "::1" || v6 === "::" || /^f[cd]/.test(v6) || /^fe[89ab]/.test(v6);
}

/** `path` below `root`, after resolving links: a link pointing outside is refused. */
async function inside(root: string, path: string): Promise<string> {
  const base = await realpath(root);
  const target = await realpath(resolve(root, path));
  if (target !== base && !target.startsWith(base + sep)) throw new Error(`${path} leads outside the working directory`);
  return target;
}

const statePath = (dir: string, store: string) => {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(store) || store.includes("..")) throw new Error(`Invalid state store name: ${JSON.stringify(store)}`);
  return join(dir, `${store}.json`);
};

async function readState(dir: string, store: string): Promise<Record<string, unknown>> {
  try {
    const value = JSON.parse(await readFile(statePath(dir, store), "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}
