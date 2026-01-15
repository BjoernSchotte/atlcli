/**
 * Jira issue template storage and management.
 *
 * Templates are stored in hierarchical storage:
 *   ~/.atlcli/templates/jira/
 *   ├── global/                    # Base templates
 *   ├── profiles/{profileName}/    # Profile-specific
 *   └── projects/{projectKey}/     # Project-specific (highest precedence)
 *
 * Precedence: project > profile > global
 */

import { homedir } from "os";
import { join } from "path";
import { existsSync } from "fs";
import { mkdir, readdir, readFile, writeFile, unlink, rename as fsRename, cp } from "fs/promises";
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

/** Template source/location tracking */
export interface JiraTemplateSource {
  level: "global" | "profile" | "project";
  profile?: string;
  project?: string;
  path: string;
}

/** Jira issue template */
export interface JiraTemplate {
  name: string;
  description?: string;
  createdAt: string;
  sourceIssue?: string;
  tags?: string[];
  fields: JiraTemplateFields;
  source?: JiraTemplateSource;
}

/** Filter options for listing templates */
export interface JiraTemplateFilter {
  level?: "global" | "profile" | "project";
  profile?: string;
  project?: string;
  tags?: string[];
  search?: string;
  issueType?: string;
  includeOverridden?: boolean;
}

/** Summary info for template listing */
export interface JiraTemplateSummary {
  name: string;
  description?: string;
  level: "global" | "profile" | "project";
  profile?: string;
  project?: string;
  issueType: string;
  fieldCount: number;
  tags?: string[];
  createdAt: string;
  sourceIssue?: string;
  overrides?: JiraTemplateSource;
}

/** Template metadata for listing (legacy compat) */
export interface JiraTemplateInfo {
  name: string;
  description?: string;
  createdAt: string;
  sourceIssue?: string;
}

// ============ Storage Configuration ============

/**
 * Get the base directory for Jira templates.
 * Can be overridden with ATLCLI_TEMPLATES_DIR environment variable.
 */
export function getJiraTemplatesBaseDir(): string {
  const base = process.env.ATLCLI_TEMPLATES_DIR ?? join(homedir(), ".atlcli", "templates");
  return join(base, "jira");
}

/**
 * Get the old templates directory path (for migration).
 */
export function getLegacyTemplatesDir(): string {
  return join(homedir(), ".config", "atlcli", "templates", "jira");
}

/**
 * Sanitize template name for file system.
 */
function sanitizeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, "_");
}

/**
 * Get issue type from template fields.
 */
function getIssueType(fields: JiraTemplateFields): string {
  const issuetype = fields.issuetype;
  if ("name" in issuetype) return issuetype.name;
  return "Unknown";
}

// ============ Storage Interface ============

/**
 * Interface for Jira template storage operations.
 */
export interface JiraTemplateStorage {
  /** List templates, optionally filtered */
  list(filter?: JiraTemplateFilter): Promise<JiraTemplateSummary[]>;
  /** Get a template by name */
  get(name: string): Promise<JiraTemplate | null>;
  /** Save a template (create or update) */
  save(template: JiraTemplate): Promise<void>;
  /** Delete a template by name */
  delete(name: string): Promise<void>;
  /** Check if a template exists */
  exists(name: string): Promise<boolean>;
  /** Rename a template */
  rename(oldName: string, newName: string): Promise<void>;
}

// ============ Base Storage Implementation ============

/**
 * Base class for Jira template storage implementations.
 */
abstract class BaseJiraTemplateStorage implements JiraTemplateStorage {
  protected abstract getDir(): string;
  protected abstract getSource(path: string): JiraTemplateSource;
  protected abstract getLevel(): "global" | "profile" | "project";
  protected getProfile(): string | undefined { return undefined; }
  protected getProject(): string | undefined { return undefined; }

  protected async ensureDir(): Promise<void> {
    const dir = this.getDir();
    if (!existsSync(dir)) {
      await mkdir(dir, { recursive: true });
    }
  }

  protected getFilePath(name: string): string {
    return join(this.getDir(), `${sanitizeName(name)}.json`);
  }

  protected async readTemplate(filePath: string): Promise<JiraTemplate | null> {
    try {
      const raw = await readFile(filePath, "utf-8");
      const template = JSON.parse(raw) as JiraTemplate;
      // Ensure source is set
      if (!template.source) {
        template.source = this.getSource(filePath);
      }
      return template;
    } catch {
      return null;
    }
  }

  protected templateToSummary(template: JiraTemplate): JiraTemplateSummary {
    return {
      name: template.name,
      description: template.description,
      level: this.getLevel(),
      profile: this.getProfile(),
      project: this.getProject(),
      issueType: getIssueType(template.fields),
      fieldCount: Object.keys(template.fields).filter(k => template.fields[k] != null).length,
      tags: template.tags,
      createdAt: template.createdAt,
      sourceIssue: template.sourceIssue,
    };
  }

  async list(filter?: JiraTemplateFilter): Promise<JiraTemplateSummary[]> {
    const dir = this.getDir();
    if (!existsSync(dir)) {
      return [];
    }

    const files = await readdir(dir);
    const templates: JiraTemplateSummary[] = [];

    for (const file of files) {
      if (!file.endsWith(".json")) continue;

      const filePath = join(dir, file);
      const template = await this.readTemplate(filePath);
      if (!template) continue;

      // Apply filters
      if (filter) {
        // Level filter
        if (filter.level && filter.level !== this.getLevel()) continue;
        // Profile filter
        if (filter.profile && filter.profile !== this.getProfile()) continue;
        // Project filter
        if (filter.project && filter.project !== this.getProject()) continue;
        // Issue type filter
        if (filter.issueType) {
          const issueType = getIssueType(template.fields);
          if (issueType.toLowerCase() !== filter.issueType.toLowerCase()) continue;
        }
        // Tags filter
        if (filter.tags && filter.tags.length > 0) {
          const templateTags = template.tags ?? [];
          const hasTag = filter.tags.some(t => templateTags.includes(t));
          if (!hasTag) continue;
        }
        // Search filter
        if (filter.search) {
          const searchLower = filter.search.toLowerCase();
          const nameMatch = template.name.toLowerCase().includes(searchLower);
          const descMatch = template.description?.toLowerCase().includes(searchLower);
          if (!nameMatch && !descMatch) continue;
        }
      }

      templates.push(this.templateToSummary(template));
    }

    return templates.sort((a, b) => a.name.localeCompare(b.name));
  }

  async get(name: string): Promise<JiraTemplate | null> {
    const filePath = this.getFilePath(name);
    return this.readTemplate(filePath);
  }

  async save(template: JiraTemplate): Promise<void> {
    await this.ensureDir();
    const filePath = this.getFilePath(template.name);
    // Update source info
    template.source = this.getSource(filePath);
    await writeFile(filePath, JSON.stringify(template, null, 2), "utf-8");
  }

  async delete(name: string): Promise<void> {
    const filePath = this.getFilePath(name);
    if (existsSync(filePath)) {
      await unlink(filePath);
    } else {
      throw new Error(`Template not found: ${name}`);
    }
  }

  async exists(name: string): Promise<boolean> {
    const filePath = this.getFilePath(name);
    return existsSync(filePath);
  }

  async rename(oldName: string, newName: string): Promise<void> {
    const oldPath = this.getFilePath(oldName);
    const newPath = this.getFilePath(newName);

    if (!existsSync(oldPath)) {
      throw new Error(`Template '${oldName}' not found`);
    }
    if (existsSync(newPath)) {
      throw new Error(`Template '${newName}' already exists`);
    }

    const template = await this.readTemplate(oldPath);
    if (!template) {
      throw new Error(`Failed to read template '${oldName}'`);
    }

    template.name = newName;
    template.source = this.getSource(newPath);
    await writeFile(newPath, JSON.stringify(template, null, 2), "utf-8");
    await unlink(oldPath);
  }
}

// ============ Storage Implementations ============

/**
 * Global Jira template storage.
 * Directory: ~/.atlcli/templates/jira/global/
 */
export class GlobalJiraTemplateStorage extends BaseJiraTemplateStorage {
  protected getDir(): string {
    return join(getJiraTemplatesBaseDir(), "global");
  }

  protected getSource(path: string): JiraTemplateSource {
    return { level: "global", path };
  }

  protected getLevel(): "global" {
    return "global";
  }
}

/**
 * Profile-specific Jira template storage.
 * Directory: ~/.atlcli/templates/jira/profiles/{profileName}/
 */
export class ProfileJiraTemplateStorage extends BaseJiraTemplateStorage {
  constructor(private profileName: string) {
    super();
  }

  protected getDir(): string {
    return join(getJiraTemplatesBaseDir(), "profiles", this.profileName);
  }

  protected getSource(path: string): JiraTemplateSource {
    return { level: "profile", profile: this.profileName, path };
  }

  protected getLevel(): "profile" {
    return "profile";
  }

  protected getProfile(): string {
    return this.profileName;
  }
}

/**
 * Project-specific Jira template storage.
 * Directory: ~/.atlcli/templates/jira/projects/{projectKey}/
 */
export class ProjectJiraTemplateStorage extends BaseJiraTemplateStorage {
  constructor(private projectKey: string) {
    super();
  }

  protected getDir(): string {
    return join(getJiraTemplatesBaseDir(), "projects", this.projectKey);
  }

  protected getSource(path: string): JiraTemplateSource {
    return { level: "project", project: this.projectKey, path };
  }

  protected getLevel(): "project" {
    return "project";
  }

  protected getProject(): string {
    return this.projectKey;
  }
}

// ============ Template Resolver ============

/**
 * Resolves templates with hierarchical precedence.
 * Precedence: project > profile > global
 */
export class JiraTemplateResolver {
  constructor(
    private global: GlobalJiraTemplateStorage,
    private profile?: ProfileJiraTemplateStorage,
    private project?: ProjectJiraTemplateStorage
  ) {}

  /**
   * Resolve a template by name using precedence rules.
   */
  async resolve(name: string): Promise<JiraTemplate | null> {
    // Check project first (highest precedence)
    if (this.project) {
      const template = await this.project.get(name);
      if (template) return template;
    }
    // Check profile
    if (this.profile) {
      const template = await this.profile.get(name);
      if (template) return template;
    }
    // Check global (lowest precedence)
    return this.global.get(name);
  }

  /**
   * List all templates with deduplication by precedence.
   */
  async listAll(filter?: JiraTemplateFilter): Promise<JiraTemplateSummary[]> {
    const seen = new Map<string, JiraTemplateSummary>();
    const overridden: JiraTemplateSummary[] = [];

    // Collect from all levels, tracking overrides
    // Start with global (lowest)
    const globalTemplates = await this.global.list(filter);
    for (const t of globalTemplates) {
      seen.set(t.name, t);
    }

    // Profile (middle)
    if (this.profile) {
      const profileTemplates = await this.profile.list(filter);
      for (const t of profileTemplates) {
        const existing = seen.get(t.name);
        if (existing) {
          // Mark as overridden
          existing.overrides = t.overrides ?? {
            level: t.level,
            profile: t.profile,
            project: t.project,
            path: "",
          };
          if (filter?.includeOverridden) {
            overridden.push(existing);
          }
        }
        seen.set(t.name, t);
      }
    }

    // Project (highest)
    if (this.project) {
      const projectTemplates = await this.project.list(filter);
      for (const t of projectTemplates) {
        const existing = seen.get(t.name);
        if (existing) {
          existing.overrides = t.overrides ?? {
            level: t.level,
            profile: t.profile,
            project: t.project,
            path: "",
          };
          if (filter?.includeOverridden) {
            overridden.push(existing);
          }
        }
        seen.set(t.name, t);
      }
    }

    // Return deduplicated list + overridden if requested
    const result = Array.from(seen.values());
    if (filter?.includeOverridden) {
      result.push(...overridden);
    }

    return result.sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * Get all locations where a template exists.
   */
  async getTemplateLocations(name: string): Promise<JiraTemplateSummary[]> {
    const locations: JiraTemplateSummary[] = [];

    const globalTemplate = await this.global.get(name);
    if (globalTemplate) {
      locations.push({
        name: globalTemplate.name,
        description: globalTemplate.description,
        level: "global",
        issueType: getIssueType(globalTemplate.fields),
        fieldCount: Object.keys(globalTemplate.fields).length,
        tags: globalTemplate.tags,
        createdAt: globalTemplate.createdAt,
        sourceIssue: globalTemplate.sourceIssue,
      });
    }

    if (this.profile) {
      const profileTemplate = await this.profile.get(name);
      if (profileTemplate) {
        locations.push({
          name: profileTemplate.name,
          description: profileTemplate.description,
          level: "profile",
          profile: this.profile["profileName"],
          issueType: getIssueType(profileTemplate.fields),
          fieldCount: Object.keys(profileTemplate.fields).length,
          tags: profileTemplate.tags,
          createdAt: profileTemplate.createdAt,
          sourceIssue: profileTemplate.sourceIssue,
        });
      }
    }

    if (this.project) {
      const projectTemplate = await this.project.get(name);
      if (projectTemplate) {
        locations.push({
          name: projectTemplate.name,
          description: projectTemplate.description,
          level: "project",
          project: this.project["projectKey"],
          issueType: getIssueType(projectTemplate.fields),
          fieldCount: Object.keys(projectTemplate.fields).length,
          tags: projectTemplate.tags,
          createdAt: projectTemplate.createdAt,
          sourceIssue: projectTemplate.sourceIssue,
        });
      }
    }

    return locations;
  }

  /**
   * Get storage by level.
   */
  getStorage(level: "global" | "profile" | "project"): JiraTemplateStorage | undefined {
    switch (level) {
      case "global": return this.global;
      case "profile": return this.profile;
      case "project": return this.project;
    }
  }
}

// ============ Migration ============

let migrationChecked = false;

/**
 * Migrate templates from old location to new hierarchical storage.
 */
export async function migrateTemplates(): Promise<{ migrated: string[]; skipped: string[]; errors: string[] }> {
  const oldDir = getLegacyTemplatesDir();
  const newDir = join(getJiraTemplatesBaseDir(), "global");

  const result = { migrated: [] as string[], skipped: [] as string[], errors: [] as string[] };

  if (!existsSync(oldDir)) {
    return result;
  }

  // Create new directory
  await mkdir(newDir, { recursive: true });

  try {
    const files = await readdir(oldDir);

    for (const file of files) {
      if (!file.endsWith(".json")) continue;

      const oldPath = join(oldDir, file);
      const newPath = join(newDir, file);

      try {
        // Check if already migrated
        if (existsSync(newPath)) {
          result.skipped.push(file.replace(".json", ""));
          continue;
        }

        // Read and update template
        const content = await readFile(oldPath, "utf-8");
        const template = JSON.parse(content) as JiraTemplate;

        // Add source info
        template.source = {
          level: "global",
          path: newPath,
        };

        // Write to new location
        await writeFile(newPath, JSON.stringify(template, null, 2), "utf-8");
        result.migrated.push(template.name);
      } catch (err) {
        result.errors.push(`${file}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  } catch (err) {
    result.errors.push(`Failed to read old directory: ${err instanceof Error ? err.message : String(err)}`);
  }

  return result;
}

/**
 * Check and run migration if needed.
 */
export async function ensureMigrated(): Promise<{ migrated: string[]; skipped: string[]; errors: string[] } | null> {
  if (migrationChecked) return null;
  migrationChecked = true;

  const oldDir = getLegacyTemplatesDir();
  const newGlobalDir = join(getJiraTemplatesBaseDir(), "global");

  // Only migrate if old directory exists and new doesn't
  if (existsSync(oldDir) && !existsSync(newGlobalDir)) {
    return migrateTemplates();
  }

  return null;
}

// ============ Legacy Compatibility Functions ============

/**
 * Get the templates directory path (legacy compat).
 * @deprecated Use GlobalJiraTemplateStorage instead
 */
export function getTemplatesDir(): string {
  return join(getJiraTemplatesBaseDir(), "global");
}

/**
 * List all saved templates (legacy compat).
 * @deprecated Use JiraTemplateResolver.listAll() instead
 */
export async function listTemplates(): Promise<JiraTemplateInfo[]> {
  await ensureMigrated();
  const storage = new GlobalJiraTemplateStorage();
  const summaries = await storage.list();
  return summaries.map(s => ({
    name: s.name,
    description: s.description,
    createdAt: s.createdAt,
    sourceIssue: s.sourceIssue,
  }));
}

/**
 * Load a template by name (legacy compat).
 * @deprecated Use JiraTemplateResolver.resolve() instead
 */
export async function loadTemplate(name: string): Promise<JiraTemplate> {
  await ensureMigrated();
  const storage = new GlobalJiraTemplateStorage();
  const template = await storage.get(name);
  if (!template) {
    throw new Error(`Template not found: ${name}`);
  }
  return template;
}

/**
 * Check if a template exists (legacy compat).
 * @deprecated Use JiraTemplateStorage.exists() instead
 */
export async function templateExists(name: string): Promise<boolean> {
  await ensureMigrated();
  const storage = new GlobalJiraTemplateStorage();
  return storage.exists(name);
}

/**
 * Save a template (legacy compat).
 * @deprecated Use JiraTemplateStorage.save() instead
 */
export async function saveTemplate(
  template: JiraTemplate,
  options?: { force?: boolean }
): Promise<void> {
  await ensureMigrated();
  const storage = new GlobalJiraTemplateStorage();

  if (!options?.force && (await storage.exists(template.name))) {
    throw new Error(
      `Template already exists: ${template.name}. Use --force to overwrite.`
    );
  }

  await storage.save(template);
}

/**
 * Delete a template (legacy compat).
 * @deprecated Use JiraTemplateStorage.delete() instead
 */
export async function deleteTemplate(name: string): Promise<void> {
  await ensureMigrated();
  const storage = new GlobalJiraTemplateStorage();
  await storage.delete(name);
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
  const issueFields = issue.fields as unknown as Record<string, unknown>;
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
