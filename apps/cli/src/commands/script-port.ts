import { mkdir, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { ConfluenceClient, type FooterComment, markdownToStorage, storageToMarkdown } from "@atlcli/confluence";
import type { Profile } from "@atlcli/core";
import { copyAttachment, findTransition, JiraClient, type JiraIssue, type JiraSprint, resolveUser, toJiraRichText } from "@atlcli/jira";
import type {
  AttachmentInput,
  ConfluenceCommentView,
  JiraBoardView,
  JiraIssueView,
  JiraSprintView,
  ScriptPort,
} from "@atlcli/script-runtime";
import { createTemplateRenderer } from "./template-flags.js";

/** A port whose clients are created on first use: a Confluence-only script never builds a Jira client. */
export function createLazyCliScriptPort(profile: Profile, outDir = process.cwd()): ScriptPort {
  return createCliScriptPort(once(() => new JiraClient(profile)), once(() => new ConfluenceClient(profile)), profile.baseUrl, {
    profileName: profile.name,
    outDir,
  });
}

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
  { profileName, outDir = process.cwd() }: { profileName: string; outDir?: string },
): ScriptPort {
  const conversion = { baseUrl };
  const richText = (markdown: string) => toJiraRichText(jira(), markdown);

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
    async jiraTransitionIssue(key, name) {
      const transitions = await jira().getTransitions(key);
      const transition = findTransition(transitions, name);
      if (!transition) {
        throw new Error(`Transition "${name}" is not available for ${key} (available: ${transitions.map((t) => t.name).join(", ") || "none"})`);
      }
      await jira().transitionIssue(key, { transition: { id: transition.id } });
    },
    async jiraSetStatus(key, status) {
      const wanted = status.toLowerCase();
      const transitions = await jira().getTransitions(key);
      const transition =
        transitions.find((t) => t.to?.name?.toLowerCase() === wanted) ?? transitions.find((t) => t.name.toLowerCase() === wanted);
      if (!transition) return { moved: false };
      await jira().transitionIssue(key, { transition: { id: transition.id } });
      return { moved: true, transition: transition.name };
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
    async confluenceCreatePage({ spaceKey, title, markdown, parentId }) {
      const page = await confluence().createPage({
        spaceKey,
        title,
        storage: markdownToStorage(markdown, conversion),
        ...(parentId ? { parentId } : {}),
      });
      return { id: page.id, version: page.version ?? 1 };
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
