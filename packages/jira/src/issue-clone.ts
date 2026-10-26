import { copyAttachment } from "./attachment-copy.js";
import type { JiraClient } from "./client.js";
import type { AdfDocument, JiraIssue } from "./types.js";

/** Fields a clone reads from its source. */
export const CLONE_SOURCE_FIELDS = ["project", "summary", "description", "issuetype", "labels", "components", "parent", "attachment"];

export interface CloneIssueOptions {
  /** Target project key; components and the parent are kept only within the same project. */
  project?: string;
  type?: string;
  summary?: string;
  /** Raw description (ADF on Cloud, wiki markup on Data Center); the source's when absent. */
  description?: unknown;
  labels?: string[];
  priority?: string;
  parent?: string;
  assignee?: { accountId: string } | { name: string };
  /** Links the clone to its source ("Cloners"); default true. */
  link?: boolean;
  /** Copies the source's attachments. */
  attachments?: boolean;
}

export interface CloneIssueResult {
  id: string;
  key: string;
  attachments: Array<{ from: string; id: string; filename: string }>;
  /** Link or attachment steps that failed after the clone was created. */
  warnings: string[];
}

/**
 * Creates a copy of an issue: summary, description, type, labels, and within
 * the same project its components and parent. The link and attachment copies
 * run after the create; their failures are warnings, not errors, because the
 * clone already exists.
 */
export async function cloneIssue(
  client: JiraClient,
  source: string | JiraIssue,
  options: CloneIssueOptions = {},
): Promise<CloneIssueResult> {
  const issue = typeof source === "string" ? await client.getIssue(source, { fields: CLONE_SOURCE_FIELDS }) : source;
  const f = issue.fields;
  const project = options.project ?? f.project.key;
  const sameProject = project === f.project.key;
  const parent = options.parent ?? (sameProject ? f.parent?.key : undefined);
  const created = await client.createIssue({
    fields: {
      project: { key: project },
      issuetype: { name: (options.type ?? f.issuetype?.name)! },
      summary: options.summary ?? f.summary,
      description: (options.description ?? f.description ?? undefined) as AdfDocument | undefined,
      priority: options.priority ? { name: options.priority } : undefined,
      labels: options.labels ?? f.labels,
      components: sameProject && f.components?.length ? f.components.map((c) => ({ id: c.id })) : undefined,
      parent: parent ? { key: parent } : undefined,
      assignee: options.assignee,
    } as never,
  });
  const warnings: string[] = [];
  if (options.link !== false) {
    try {
      await client.createIssueLink({ type: { name: "Cloners" }, inwardIssue: { key: created.key }, outwardIssue: { key: issue.key } });
    } catch (err) {
      warnings.push(`Cloned, but not linked to ${issue.key}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const attachments: CloneIssueResult["attachments"] = [];
  if (options.attachments) {
    for (const attachment of f.attachment ?? []) {
      try {
        const copy = await copyAttachment(client, attachment.id, created.key, { source: attachment });
        attachments.push({ from: attachment.id, id: String(copy.id), filename: attachment.filename });
      } catch (err) {
        warnings.push(`Attachment ${attachment.filename} (${attachment.id}) not copied: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
  return { id: created.id, key: created.key, attachments, warnings };
}
