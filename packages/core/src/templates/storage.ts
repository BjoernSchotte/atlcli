import { existsSync } from "node:fs";
import { readdir, readFile, writeFile, mkdir, unlink, rename } from "node:fs/promises";
import { join } from "node:path";
import os from "node:os";
import type {
  Template,
  TemplateMetadata,
  TemplateSource,
  TemplateFilter,
  TemplateSummary,
} from "./types.js";
import { parseTemplate, serializeTemplate } from "./parser.js";

/**
 * Get the base directory for templates.
 * Can be overridden with ATLCLI_TEMPLATES_DIR environment variable.
 */
export function getTemplatesBaseDir(): string {
  return process.env.ATLCLI_TEMPLATES_DIR ?? join(os.homedir(), ".atlcli", "templates");
}

/**
 * Interface for template storage operations.
 */
export interface TemplateStorage {
  /** List templates, optionally filtered */
  list(filter?: TemplateFilter): Promise<TemplateSummary[]>;

  /** Get a template by name */
  get(name: string): Promise<Template | null>;

  /** Save a template (create or update) */
  save(template: Template): Promise<void>;

  /** Delete a template by name */
  delete(name: string): Promise<void>;

  /** Check if a template exists */
  exists(name: string): Promise<boolean>;

  /** Rename a template */
  rename(oldName: string, newName: string): Promise<void>;
}

/**
 * Base class for template storage implementations.
 */
export abstract class BaseTemplateStorage implements TemplateStorage {
  /**
   * Get the directory path for this storage.
   */
  protected abstract getDir(): string;

  /**
   * Get the template source info for this storage.
   */
  protected abstract getSource(path: string): TemplateSource;

  /**
   * Get the level for this storage (global, profile, space).
   */
  protected abstract getLevel(): "global" | "profile" | "space";

  /**
   * Get profile name if applicable.
   */
  protected getProfile(): string | undefined {
    return undefined;
  }

  /**
   * Get space key if applicable.
   */
  protected getSpace(): string | undefined {
    return undefined;
  }

  /**
   * Ensure the storage directory exists.
   */
  protected async ensureDir(): Promise<void> {
    const dir = this.getDir();
    if (!existsSync(dir)) {
      await mkdir(dir, { recursive: true });
    }
  }

  /**
   * Get the file path for a template name.
   */
  protected getFilePath(name: string): string {
    return join(this.getDir(), `${name}.md`);
  }

  /**
   * Read and parse a template file.
   */
  protected async readTemplate(filePath: string): Promise<Template | null> {
    try {
      const raw = await readFile(filePath, "utf8");
      const { metadata, content } = parseTemplate(raw);
      return {
        metadata,
        content,
        source: this.getSource(filePath),
      };
    } catch {
      return null;
    }
  }

  async list(filter?: TemplateFilter): Promise<TemplateSummary[]> {
    const dir = this.getDir();
    if (!existsSync(dir)) {
      return [];
    }

    const files = await readdir(dir);
    const templates: TemplateSummary[] = [];

    for (const file of files) {
      if (!file.endsWith(".md")) continue;

      const name = file.slice(0, -3); // Remove .md extension
      const filePath = join(dir, file);
      const template = await this.readTemplate(filePath);

      if (!template) continue;

      // Apply filters
      if (filter) {
        // Level filter
        if (filter.level && filter.level !== this.getLevel()) continue;

        // Profile filter
        if (filter.profile && filter.profile !== this.getProfile()) continue;

        // Space filter
        if (filter.space && filter.space !== this.getSpace()) continue;

        // Tags filter
        if (filter.tags && filter.tags.length > 0) {
          const templateTags = template.metadata.tags ?? [];
          const hasTag = filter.tags.some((t) => templateTags.includes(t));
          if (!hasTag) continue;
        }

        // Search filter (searches name and description)
        if (filter.search) {
          const searchLower = filter.search.toLowerCase();
          const nameMatch = name.toLowerCase().includes(searchLower);
          const descMatch = template.metadata.description
            ?.toLowerCase()
            .includes(searchLower);
          if (!nameMatch && !descMatch) continue;
        }
      }

      templates.push({
        name,
        description: template.metadata.description,
        level: this.getLevel(),
        profile: this.getProfile(),
        space: this.getSpace(),
        tags: template.metadata.tags,
      });
    }

    return templates;
  }

  async get(name: string): Promise<Template | null> {
    const filePath = this.getFilePath(name);
    return this.readTemplate(filePath);
  }

  async save(template: Template): Promise<void> {
    await this.ensureDir();
    const filePath = this.getFilePath(template.metadata.name);
    const content = serializeTemplate(template.metadata, template.content);
    await writeFile(filePath, content, "utf8");
  }

  async delete(name: string): Promise<void> {
    const filePath = this.getFilePath(name);
    if (existsSync(filePath)) {
      await unlink(filePath);
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

    // Read, update name in metadata, write to new location, delete old
    const template = await this.readTemplate(oldPath);
    if (!template) {
      throw new Error(`Failed to read template '${oldName}'`);
    }

    template.metadata.name = newName;
    const content = serializeTemplate(template.metadata, template.content);
    await writeFile(newPath, content, "utf8");
    await unlink(oldPath);
  }
}

/**
 * Global template storage.
 * Directory: ~/.atlcli/templates/global/
 */
export class GlobalTemplateStorage extends BaseTemplateStorage {
  protected getDir(): string {
    return join(getTemplatesBaseDir(), "global");
  }

  protected getSource(path: string): TemplateSource {
    return { level: "global", path };
  }

  protected getLevel(): "global" {
    return "global";
  }
}

/**
 * Profile template storage.
 * Directory: ~/.atlcli/templates/profiles/{profileName}/
 */
export class ProfileTemplateStorage extends BaseTemplateStorage {
  constructor(private profileName: string) {
    super();
  }

  protected getDir(): string {
    return join(getTemplatesBaseDir(), "profiles", this.profileName);
  }

  protected getSource(path: string): TemplateSource {
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
 * Space template storage.
 * Two locations:
 * 1. Docs folder: {docsDir}/.atlcli/templates/ (primary, checked first)
 * 2. Config: ~/.atlcli/templates/spaces/{spaceKey}/ (fallback)
 */
export class SpaceTemplateStorage extends BaseTemplateStorage {
  private docsDir?: string;

  constructor(
    private spaceKey: string,
    docsDir?: string
  ) {
    super();
    this.docsDir = docsDir;
  }

  /**
   * Get the docs folder templates directory.
   */
  private getDocsTemplatesDir(): string | undefined {
    if (!this.docsDir) return undefined;
    return join(this.docsDir, ".atlcli", "templates");
  }

  /**
   * Get the config folder templates directory.
   */
  private getConfigTemplatesDir(): string {
    return join(getTemplatesBaseDir(), "spaces", this.spaceKey);
  }

  protected getDir(): string {
    // Primary: docs folder
    const docsDir = this.getDocsTemplatesDir();
    if (docsDir && existsSync(docsDir)) {
      return docsDir;
    }
    // Fallback: config folder
    return this.getConfigTemplatesDir();
  }

  protected getSource(path: string): TemplateSource {
    return { level: "space", space: this.spaceKey, path };
  }

  protected getLevel(): "space" {
    return "space";
  }

  protected getSpace(): string {
    return this.spaceKey;
  }

  /**
   * List templates from both locations, docs folder takes precedence.
   */
  async list(filter?: TemplateFilter): Promise<TemplateSummary[]> {
    const seen = new Set<string>();
    const templates: TemplateSummary[] = [];

    // First, list from docs folder (primary)
    const docsDir = this.getDocsTemplatesDir();
    if (docsDir && existsSync(docsDir)) {
      const docsTemplates = await this.listFromDir(docsDir, filter);
      for (const t of docsTemplates) {
        seen.add(t.name);
        templates.push(t);
      }
    }

    // Then, list from config folder (fallback, skip duplicates)
    const configDir = this.getConfigTemplatesDir();
    if (existsSync(configDir)) {
      const configTemplates = await this.listFromDir(configDir, filter);
      for (const t of configTemplates) {
        if (!seen.has(t.name)) {
          templates.push(t);
        }
      }
    }

    return templates;
  }

  /**
   * List templates from a specific directory.
   */
  private async listFromDir(
    dir: string,
    filter?: TemplateFilter
  ): Promise<TemplateSummary[]> {
    const files = await readdir(dir);
    const templates: TemplateSummary[] = [];

    for (const file of files) {
      if (!file.endsWith(".md")) continue;

      const name = file.slice(0, -3);
      const filePath = join(dir, file);
      const template = await this.readTemplate(filePath);

      if (!template) continue;

      // Apply filters
      if (filter) {
        if (filter.level && filter.level !== "space") continue;
        if (filter.space && filter.space !== this.spaceKey) continue;

        if (filter.tags && filter.tags.length > 0) {
          const templateTags = template.metadata.tags ?? [];
          const hasTag = filter.tags.some((t) => templateTags.includes(t));
          if (!hasTag) continue;
        }

        if (filter.search) {
          const searchLower = filter.search.toLowerCase();
          const nameMatch = name.toLowerCase().includes(searchLower);
          const descMatch = template.metadata.description
            ?.toLowerCase()
            .includes(searchLower);
          if (!nameMatch && !descMatch) continue;
        }
      }

      templates.push({
        name,
        description: template.metadata.description,
        level: "space",
        space: this.spaceKey,
        tags: template.metadata.tags,
      });
    }

    return templates;
  }

  /**
   * Get a template, checking docs folder first then config folder.
   */
  async get(name: string): Promise<Template | null> {
    // Try docs folder first
    const docsDir = this.getDocsTemplatesDir();
    if (docsDir) {
      const docsPath = join(docsDir, `${name}.md`);
      if (existsSync(docsPath)) {
        return this.readTemplate(docsPath);
      }
    }

    // Fallback to config folder
    const configPath = join(this.getConfigTemplatesDir(), `${name}.md`);
    if (existsSync(configPath)) {
      return this.readTemplate(configPath);
    }

    return null;
  }

  /**
   * Save a template to the appropriate location.
   * If docs folder exists, save there; otherwise save to config.
   */
  async save(template: Template): Promise<void> {
    const docsDir = this.getDocsTemplatesDir();

    // Prefer docs folder if it exists or we have a docsDir configured
    if (this.docsDir) {
      if (!existsSync(docsDir!)) {
        await mkdir(docsDir!, { recursive: true });
      }
      const filePath = join(docsDir!, `${template.metadata.name}.md`);
      const content = serializeTemplate(template.metadata, template.content);
      await writeFile(filePath, content, "utf8");
    } else {
      // Save to config folder
      const configDir = this.getConfigTemplatesDir();
      if (!existsSync(configDir)) {
        await mkdir(configDir, { recursive: true });
      }
      const filePath = join(configDir, `${template.metadata.name}.md`);
      const content = serializeTemplate(template.metadata, template.content);
      await writeFile(filePath, content, "utf8");
    }
  }

  /**
   * Check if template exists in either location.
   */
  async exists(name: string): Promise<boolean> {
    const docsDir = this.getDocsTemplatesDir();
    if (docsDir && existsSync(join(docsDir, `${name}.md`))) {
      return true;
    }
    return existsSync(join(this.getConfigTemplatesDir(), `${name}.md`));
  }

  /**
   * Delete a template from both locations if it exists.
   */
  async delete(name: string): Promise<void> {
    const docsDir = this.getDocsTemplatesDir();
    if (docsDir) {
      const docsPath = join(docsDir, `${name}.md`);
      if (existsSync(docsPath)) {
        await unlink(docsPath);
      }
    }

    const configPath = join(this.getConfigTemplatesDir(), `${name}.md`);
    if (existsSync(configPath)) {
      await unlink(configPath);
    }
  }
}
