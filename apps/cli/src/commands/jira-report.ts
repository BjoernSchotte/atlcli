/**
 * `jira version notes` and `jira sprint review`: render Jira data through a
 * template and create or update a Confluence page (spec
 * jira-content-workflows A3). Re-running updates the same page; a page with
 * the same title that atlcli did not create is never overwritten without
 * `--force`.
 */
import {
  ERROR_CODES,
  type OutputOptions,
  GlobalTemplateStorage,
  ProfileTemplateStorage,
  SpaceTemplateStorage,
  TemplateEngine,
  TemplateResolver,
  fail,
  getActiveProfile,
  getFlag,
  getFlags,
  hasFlag,
  loadConfig,
  output,
  parseTemplate,
  resolveDefaults,
  type Template,
} from "@atlcli/core";
import { ConfluenceClient, hashContent, markdownToStorage } from "@atlcli/confluence";
import {
  JiraClient,
  loadSprintHistory,
  buildReportData,
  calculateSprintMetrics,
  sprintIssueAt,
  type JiraIssue,
  type ReportData,
} from "@atlcli/jira";
import { assertCliAuthSupported } from "./session-guard.js";
import { BUNDLED_REPORT_TEMPLATES } from "./jira-report-templates.js";
import { loadStatusResolver } from "./jira-flow.js";

export const REPORT_PROPERTY_KEY = "atlcli.jira-report";

type Flags = Record<string, string | boolean | string[]>;

/** Identity stored on a generated page so re-runs find and update it. */
export interface ReportIdentity {
  v: 1;
  kind: "release" | "sprint";
  jiraSite: string;
  sourceId: string;
  /** Hash of the generated storage, to report `unchanged`. */
  contentHash?: string;
}

const REPORT_FIELDS = ["summary", "status", "issuetype", "assignee", "parent", "description"];

export async function handleVersionNotes(args: string[], flags: Flags, opts: OutputOptions): Promise<void> {
  if (await printTemplateIfAsked(flags, opts)) return;
  const ref = args[0] ?? getFlag(flags, "id");
  const { jira, confluence, defaults, profile } = await clients(flags, opts);
  const project = getFlag(flags, "project") ?? defaults.project;
  if (!ref) fail(opts, 1, ERROR_CODES.USAGE, "Version id or name is required: jira version notes <id|name> --project <KEY>.");

  let version;
  if (/^\d+$/.test(ref)) {
    version = await jira.getVersion(ref);
  } else {
    if (!project) fail(opts, 1, ERROR_CODES.USAGE, "--project is required to find a version by name.");
    const matches = (await jira.getProjectVersions(project)).filter((v) => v.name === ref);
    if (matches.length !== 1) {
      fail(opts, 1, ERROR_CODES.USAGE, matches.length ? `Several versions are named "${ref}"; pass the id.` : `No version "${ref}" in ${project}.`);
    }
    version = matches[0]!;
  }

  const pointsField = getFlag(flags, "points-field");
  const issues = await fetchAll(jira, `fixVersion = ${version.id} ORDER BY key`, pointsField);
  const data = buildReportData({
    kind: "release",
    source: {
      id: version.id,
      name: version.name,
      description: version.description,
      released: version.released,
      startDate: version.startDate,
      releaseDate: version.releaseDate,
    },
    issues,
    baseUrl: jira.siteUrl,
    pointsField,
    resolve: await reportStatusResolver(jira, flags, opts),
    now: new Date(),
  });
  const groupBy = getFlag(flags, "group-by") ?? "type";
  if (groupBy !== "type" && groupBy !== "epic") fail(opts, 1, ERROR_CODES.USAGE, "--group-by must be type or epic.");
  const bundled = groupBy === "epic" ? "release-notes-by-epic" : "release-notes";

  await publishReport(flags, opts, { jira, confluence, defaults, profileName: profile.name }, data, {
    defaultTemplate: bundled,
    defaultTitle: `Release notes – ${version.name}`,
  });
}

export async function handleSprintReview(args: string[], flags: Flags, opts: OutputOptions): Promise<void> {
  if (await printTemplateIfAsked(flags, opts)) return;
  const sprintId = Number(args[0] ?? getFlag(flags, "id"));
  if (!Number.isInteger(sprintId) || sprintId <= 0) fail(opts, 1, ERROR_CODES.USAGE, "Sprint id is required: jira sprint review <id>.");
  const { jira, confluence, defaults, profile } = await clients(flags, opts);

  // Points are optional on a review page: use the flag, else detect, else none.
  const pointsField = getFlag(flags, "points-field") ?? (await jira.detectStoryPointsField().catch(() => null)) ?? undefined;
  const sprint = await jira.getSprint(sprintId);
  // As of its end, removed issues included: one bulk changelog read.
  const history = await loadSprintHistory(jira, sprint, [...REPORT_FIELDS, ...(pointsField ? [pointsField] : [])]);
  const issues = history;
  const resolve = await reportStatusResolver(jira, flags, opts);
  const asOf = new Map(history.map((issue) => [issue.key, sprintIssueAt(issue, sprint, pointsField ?? "", resolve).end]));
  const metrics = pointsField ? calculateSprintMetrics(sprint, history, pointsField, history, resolve) : undefined;
  const data = buildReportData({
    kind: "sprint",
    source: {
      id: String(sprint.id),
      name: sprint.name,
      goal: sprint.goal,
      state: sprint.state,
      startDate: sprint.startDate,
      endDate: sprint.completeDate ?? sprint.endDate,
    },
    issues,
    baseUrl: jira.siteUrl,
    pointsField,
    sprintMetrics: metrics,
    asOf,
    resolve,
    now: new Date(),
  });

  await publishReport(flags, opts, { jira, confluence, defaults, profileName: profile.name }, data, {
    defaultTemplate: "sprint-review",
    defaultTitle: `Sprint review – ${sprint.name}`,
  });
}

/** Done follows `flow.statusMap` and `--status-map`, as in flow metrics and sprint reports. */
async function reportStatusResolver(jira: JiraClient, flags: Flags, opts: OutputOptions) {
  const config = await loadConfig();
  const profile = getActiveProfile(config, getFlag(flags, "profile"))!;
  return (await loadStatusResolver({ client: jira, config, profile }, flags, opts)).resolve;
}

async function clients(flags: Flags, opts: OutputOptions) {
  const config = await loadConfig();
  const profile = getActiveProfile(config, getFlag(flags, "profile"));
  if (!profile) fail(opts, 1, ERROR_CODES.AUTH, "No active profile found. Run `atlcli auth login`.");
  assertCliAuthSupported(profile, opts);
  return {
    profile,
    jira: new JiraClient(profile),
    confluence: new ConfluenceClient(profile),
    defaults: resolveDefaults(config, profile),
  };
}

async function fetchAll(jira: JiraClient, jql: string, pointsField?: string): Promise<JiraIssue[]> {
  const issues: JiraIssue[] = [];
  let nextPageToken: string | undefined;
  do {
    const page = await jira.search(jql, {
      maxResults: 100,
      nextPageToken,
      fields: [...REPORT_FIELDS, ...(pointsField ? [pointsField] : [])],
    });
    issues.push(...page.issues);
    nextPageToken = page.nextPageToken;
  } while (nextPageToken && issues.length < 5000);
  return issues;
}

async function printTemplateIfAsked(flags: Flags, opts: OutputOptions): Promise<boolean> {
  if (hasFlag(flags, "list-templates")) {
    output({ schemaVersion: "1", bundled: Object.keys(BUNDLED_REPORT_TEMPLATES) }, opts);
    return true;
  }
  const name = getFlag(flags, "print-template");
  if (name === undefined) return false;
  const raw = BUNDLED_REPORT_TEMPLATES[name];
  if (!raw) fail(opts, 1, ERROR_CODES.USAGE, `No bundled template "${name}". Bundled: ${Object.keys(BUNDLED_REPORT_TEMPLATES).join(", ")}.`);
  process.stdout.write(raw);
  return true;
}

/** Same-title page decision (pure). */
export function decideReportTarget(
  candidates: Array<{ id: string; identity?: ReportIdentity }>,
  wanted: Omit<ReportIdentity, "contentHash">,
  force: boolean
): { action: "create" } | { action: "update"; pageId: string; identity?: ReportIdentity } | { action: "conflict"; pageId: string } {
  const own = candidates.find(
    (c) => c.identity?.kind === wanted.kind && c.identity.jiraSite === wanted.jiraSite && c.identity.sourceId === wanted.sourceId
  );
  if (own) return { action: "update", pageId: own.id, identity: own.identity };
  const other = candidates[0];
  if (!other) return { action: "create" };
  return force ? { action: "update", pageId: other.id } : { action: "conflict", pageId: other.id };
}

async function publishReport(
  flags: Flags,
  opts: OutputOptions,
  ctx: {
    jira: JiraClient;
    confluence: ConfluenceClient;
    defaults: { space?: string };
    profileName: string;
  },
  data: ReportData,
  options: { defaultTemplate: string; defaultTitle: string }
): Promise<void> {
  const space = getFlag(flags, "space") ?? ctx.defaults.space;
  if (!space) fail(opts, 1, ERROR_CODES.USAGE, "--space is required (or set a default: atlcli config set global.space <value>).");
  const title = getFlag(flags, "title") ?? options.defaultTitle;
  const templateName = getFlag(flags, "template") ?? options.defaultTemplate;

  const template = await resolveReportTemplate(templateName, ctx.profileName, space);
  if (!template) fail(opts, 1, ERROR_CODES.USAGE, `Template "${templateName}" not found (user levels or bundled).`);

  const variables: Record<string, unknown> = { ...data };
  for (const assignment of getFlags(flags, "var")) {
    const eq = assignment.indexOf("=");
    if (eq <= 0) fail(opts, 1, ERROR_CODES.USAGE, `Invalid --var "${assignment}". Use name=value.`);
    variables[assignment.slice(0, eq)] = assignment.slice(eq + 1);
  }
  const markdown = new TemplateEngine().render(template, {
    variables,
    builtins: { space, title, profile: ctx.profileName, user: ctx.profileName },
  }).content;
  const storage = markdownToStorage(markdown, { baseUrl: ctx.jira.siteUrl });
  // Hash what Confluence receives, so converter changes also count as changes.
  const contentHash = hashContent(storage);
  const wanted = { v: 1 as const, kind: data.kind, jiraSite: ctx.jira.siteUrl, sourceId: data.source.id };

  const sameTitle = await ctx.confluence.findPagesByTitle(title, { spaceKey: space, limit: 10 });
  const candidates = await Promise.all(
    sameTitle
      .filter((page) => page.title === title)
      .map(async (page) => ({ id: page.id, identity: asIdentity(await ctx.confluence.getPagePropertyByKey(page.id, REPORT_PROPERTY_KEY)) }))
  );
  const target = decideReportTarget(candidates, wanted, hasFlag(flags, "force"));
  if (target.action === "conflict") {
    fail(opts, 1, ERROR_CODES.USAGE, `A page "${title}" (${target.pageId}) already exists in ${space} and was not created by atlcli for this ${data.kind}. Use --title or --force.`, { pageId: target.pageId });
  }
  const action = target.action === "update" && target.identity?.contentHash === contentHash ? "unchanged" : target.action;
  const templateInfo = { name: template.metadata.name || templateName, source: template.source.level === "global" && template.source.path.startsWith("bundled:") ? "bundled" : template.source.level };

  if (hasFlag(flags, "dry-run")) {
    output({ schemaVersion: "1", dryRun: true, action, title, space, template: templateInfo, markdown, issues: data.issues.length }, opts);
    return;
  }

  const identity: ReportIdentity = { ...wanted, contentHash };
  let pageId: string;
  if (target.action === "create") {
    const page = await ctx.confluence.createPage({
      spaceKey: space,
      title,
      storage,
      parentId: getFlag(flags, "parent"),
      properties: { [REPORT_PROPERTY_KEY]: identity },
    });
    pageId = page.id;
    const labels = template.metadata.labels ?? [];
    if (labels.length > 0) await ctx.confluence.addLabels(pageId, labels);
  } else {
    pageId = target.pageId;
    if (action === "update") {
      const current = await ctx.confluence.getPage(pageId);
      await ctx.confluence.updatePage({ id: pageId, title, storage, version: (current.version ?? 1) + 1 });
      if (ctx.confluence.deploymentType === "cloud") await ctx.confluence.upsertPageProperty(pageId, REPORT_PROPERTY_KEY, identity);
    }
  }

  const page = await ctx.confluence.getPageMetadata(pageId);
  output({ schemaVersion: "1", action, title, space, pageId, url: page.url, version: page.version, template: templateInfo, issues: data.issues.length }, opts);

  const exportPath = getFlag(flags, "export");
  if (exportPath) {
    // Same code path as `atlcli wiki export`; with --json its report follows
    // the page result as a second JSON document.
    const { handleExport } = await import("./export.js");
    const exportFlags = reportExportFlags(
      exportPath,
      markdown,
      getFlag(flags, "export-template") ?? REPORT_EXPORT_TEMPLATE,
    );
    const profileFlag = getFlag(flags, "profile");
    if (profileFlag) exportFlags.profile = profileFlag;
    await handleExport([pageId], exportFlags, opts);
  }
}

/** Built-in PDF template a report exports with unless `--export-template` names another. */
export const REPORT_EXPORT_TEMPLATE = "report";

/** `wiki export` flags for a report's `--export` file. */
export function reportExportFlags(
  exportPath: string,
  markdown: string,
  template?: string,
): Flags {
  const format = exportPath.toLowerCase().endsWith(".pdf") ? "pdf" : "docx";
  // Regenerated on every run, so the file is replaced like the page is.
  const flags: Flags = { output: exportPath, format, force: true };
  // The PDF default names a PDF template; DOCX keeps its own default.
  if (template && (format === "pdf" || template !== REPORT_EXPORT_TEMPLATE)) {
    flags.template = template;
  }
  if (format === "pdf") {
    // A report is short: no cover or closing page on the built-in template. A
    // chosen template keeps its own page defaults.
    if (!template) {
      flags["no-cover"] = true;
      flags["no-closing-page"] = true;
    }
    // A contents page only once it has many sections.
    if (!reportNeedsToc(markdown)) flags["no-toc"] = true;
  }
  return flags;
}

/** ponytail: section count stands in for length; measure rendered pages if this misjudges. */
export const REPORT_TOC_MIN_HEADINGS = 8;

export function reportNeedsToc(markdown: string): boolean {
  return (markdown.match(/^#{1,3} \S/gm) ?? []).length >= REPORT_TOC_MIN_HEADINGS;
}

async function resolveReportTemplate(name: string, profileName: string, space: string): Promise<Template | null> {
  const resolver = new TemplateResolver(
    new GlobalTemplateStorage(),
    new ProfileTemplateStorage(profileName),
    new SpaceTemplateStorage(space)
  );
  const user = await resolver.resolve(name);
  if (user) return user;
  const raw = BUNDLED_REPORT_TEMPLATES[name];
  if (!raw) return null;
  const parsed = parseTemplate(raw);
  return { ...parsed, source: { level: "global", path: `bundled:${name}` } };
}

function asIdentity(value: unknown): ReportIdentity | undefined {
  if (!value || typeof value !== "object") return undefined;
  const v = value as ReportIdentity;
  return v.v === 1 && typeof v.sourceId === "string" ? v : undefined;
}
