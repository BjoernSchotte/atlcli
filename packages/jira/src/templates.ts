/**
 * Jira issue template storage and management.
 *
 * Templates are stored locally at ~/.config/atlcli/templates/jira/
 */

import { homedir } from "os";
import { join } from "path";
import { mkdir, readdir, readFile, writeFile, unlink } from "fs/promises";
import type { JiraIssue, AdfDocument } from "./types";

// ============ Types ============

/** Template field definitions */
export interface JiraTemplateFields {
  issuetype: { name: string } | { id: string };
  summary: string;
  description?: AdfDocument | string | null;
  priority?: { name: string } | { id: string };
  labels?: string[];
  components?: Array<{ name: string }>;
  fixVersions?: Array<{ name: string }>;
  duedate?: string;
  [key: string]: unknown;
}

/** Jira issue template */
export interface JiraTemplate {
  name: string;
  description?: string;
  createdAt: string;
  sourceIssue?: string;
  fields: JiraTemplateFields;
}

/** Template metadata for listing */
export interface JiraTemplateInfo {
  name: string;
  description?: string;
  createdAt: string;
  sourceIssue?: string;
}

// ============ Storage Functions ============

/**
 * Get the templates directory path.
 */
export function getTemplatesDir(): string {
  return join(homedir(), ".config", "atlcli", "templates", "jira");
}

/**
 * Ensure templates directory exists.
 */
async function ensureTemplatesDir(): Promise<void> {
  await mkdir(getTemplatesDir(), { recursive: true });
}

/**
 * Get template file path.
 */
function getTemplatePath(name: string): string {
  // Sanitize name to prevent path traversal
  const safeName = name.replace(/[^a-zA-Z0-9_-]/g, "_");
  return join(getTemplatesDir(), `${safeName}.json`);
}

/**
 * List all saved templates.
 */
export async function listTemplates(): Promise<JiraTemplateInfo[]> {
  await ensureTemplatesDir();

  try {
    const files = await readdir(getTemplatesDir());
    const templates: JiraTemplateInfo[] = [];

    for (const file of files) {
      if (!file.endsWith(".json")) continue;

      try {
        const content = await readFile(join(getTemplatesDir(), file), "utf-8");
        const template = JSON.parse(content) as JiraTemplate;
        templates.push({
          name: template.name,
          description: template.description,
          createdAt: template.createdAt,
          sourceIssue: template.sourceIssue,
        });
      } catch {
        // Skip invalid files
      }
    }

    return templates.sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

/**
 * Load a template by name.
 */
export async function loadTemplate(name: string): Promise<JiraTemplate> {
  const path = getTemplatePath(name);

  try {
    const content = await readFile(path, "utf-8");
    return JSON.parse(content) as JiraTemplate;
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === "ENOENT") {
      throw new Error(`Template not found: ${name}`);
    }
    throw error;
  }
}

/**
 * Check if a template exists.
 */
export async function templateExists(name: string): Promise<boolean> {
  try {
    await loadTemplate(name);
    return true;
  } catch {
    return false;
  }
}

/**
 * Save a template.
 */
export async function saveTemplate(
  template: JiraTemplate,
  options?: { force?: boolean }
): Promise<void> {
  await ensureTemplatesDir();

  if (!options?.force && (await templateExists(template.name))) {
    throw new Error(
      `Template already exists: ${template.name}. Use --force to overwrite.`
    );
  }

  const path = getTemplatePath(template.name);
  await writeFile(path, JSON.stringify(template, null, 2), "utf-8");
}

/**
 * Delete a template.
 */
export async function deleteTemplate(name: string): Promise<void> {
  const path = getTemplatePath(name);

  try {
    await unlink(path);
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === "ENOENT") {
      throw new Error(`Template not found: ${name}`);
    }
    throw error;
  }
}

// ============ Conversion Functions ============

/** Fields that should never be captured in templates */
const EXCLUDED_FIELDS = new Set([
  "key",
  "id",
  "self",
  "status",
  "created",
  "updated",
  "creator",
  "reporter",
  "assignee",
  "resolution",
  "resolutiondate",
  "project",
  "subtasks",
  "issuelinks",
  "changelog",
  "worklog",
  "comment",
  "attachment",
  "votes",
  "watches",
  "timetracking",
  "aggregatetimespent",
  "aggregatetimeoriginalestimate",
  "aggregatetimeestimate",
  "aggregateprogress",
  "progress",
  "lastViewed",
  "environment",
  "thumbnail",
  "statuscategorychangedate",
]);

/**
 * Convert a Jira issue to a template.
 */
export function issueToTemplate(
  issue: JiraIssue,
  name: string,
  description?: string
): JiraTemplate {
  const fields: JiraTemplateFields = {
    issuetype: { name: issue.fields.issuetype.name },
    summary: issue.fields.summary,
  };

  // Description
  if (issue.fields.description) {
    fields.description = issue.fields.description;
  }

  // Priority - use ID for reliable cross-project compatibility
  if (issue.fields.priority) {
    fields.priority = { id: issue.fields.priority.id };
  }

  // Labels
  if (issue.fields.labels && issue.fields.labels.length > 0) {
    fields.labels = issue.fields.labels;
  }

  // Components
  if (issue.fields.components && issue.fields.components.length > 0) {
    fields.components = issue.fields.components.map((c) => ({ name: c.name }));
  }

  // Fix Versions
  if (issue.fields.fixVersions && issue.fields.fixVersions.length > 0) {
    fields.fixVersions = issue.fields.fixVersions.map((v) => ({ name: v.name }));
  }

  // Due date
  if (issue.fields.duedate) {
    fields.duedate = issue.fields.duedate;
  }

  // Custom fields (those starting with customfield_)
  const issueFields = issue.fields as Record<string, unknown>;
  for (const [key, value] of Object.entries(issueFields)) {
    if (key.startsWith("customfield_") && value != null) {
      // Skip string values that look like rank/order values or empty objects
      if (typeof value === "string") {
        // Skip rank-like values (e.g., "0|zzsjuk:") and empty object strings
        if (value.match(/^\d+\|[a-z0-9]+:?$/i) || value === "{}" || value === "[]") {
          continue;
        }
        fields[key] = value;
      } else if (Array.isArray(value)) {
        // Keep non-empty arrays
        if (value.length > 0) {
          fields[key] = value;
        }
      } else if (typeof value === "object") {
        const obj = value as Record<string, unknown>;
        // Keep only simple option fields { value: string } or { name: string }
        if (obj.value !== undefined || obj.name !== undefined) {
          fields[key] = value;
        }
      } else if (typeof value === "number" || typeof value === "boolean") {
        // Keep primitives
        fields[key] = value;
      }
    }
  }

  return {
    name,
    description,
    createdAt: new Date().toISOString(),
    sourceIssue: issue.key,
    fields,
  };
}

/**
 * Convert template fields to CreateIssueInput fields.
 * Merges template with overrides (e.g., custom summary).
 */
export function templateToCreateInput(
  template: JiraTemplate,
  projectKey: string,
  overrides?: {
    summary?: string;
    description?: string;
    assignee?: string;
  }
): { fields: Record<string, unknown> } {
  const fields: Record<string, unknown> = {
    project: { key: projectKey },
    ...template.fields,
  };

  // Apply overrides
  if (overrides?.summary) {
    fields.summary = overrides.summary;
  }

  if (overrides?.description) {
    fields.description = overrides.description;
  }

  if (overrides?.assignee) {
    fields.assignee = { accountId: overrides.assignee };
  }

  return { fields };
}

/**
 * Get list of field names captured in a template.
 */
export function getTemplateFieldNames(template: JiraTemplate): string[] {
  return Object.keys(template.fields).filter(
    (key) => template.fields[key] != null
  );
}
