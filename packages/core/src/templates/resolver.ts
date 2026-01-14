import type {
  Template,
  TemplateFilter,
  TemplateSummary,
  TemplateSource,
} from "./types.js";
import type { TemplateStorage } from "./storage.js";

/**
 * Resolves templates across multiple storage levels with precedence:
 * Space > Profile > Global
 *
 * The most specific level wins when the same template name exists at multiple levels.
 */
export class TemplateResolver {
  constructor(
    private global: TemplateStorage,
    private profile?: TemplateStorage,
    private space?: TemplateStorage
  ) {}

  /**
   * Resolve a template by name using precedence rules.
   * Returns the most specific template (space > profile > global).
   */
  async resolve(name: string): Promise<Template | null> {
    // Check space first (highest precedence)
    if (this.space) {
      const template = await this.space.get(name);
      if (template) return template;
    }

    // Check profile second
    if (this.profile) {
      const template = await this.profile.get(name);
      if (template) return template;
    }

    // Check global last (lowest precedence)
    return this.global.get(name);
  }

  /**
   * Find all templates with the given name across all levels.
   * Useful for showing what would be shadowed.
   */
  async findAllByName(name: string): Promise<Template[]> {
    const results: Template[] = [];

    // Check all levels
    if (this.space) {
      const template = await this.space.get(name);
      if (template) results.push(template);
    }

    if (this.profile) {
      const template = await this.profile.get(name);
      if (template) results.push(template);
    }

    const globalTemplate = await this.global.get(name);
    if (globalTemplate) results.push(globalTemplate);

    return results;
  }

  /**
   * List all templates across all levels.
   * By default, only returns the highest-precedence template for each name.
   * With includeOverridden, shows all templates including shadowed ones.
   */
  async listAll(filter?: TemplateFilter): Promise<TemplateSummary[]> {
    const seen = new Map<string, TemplateSummary>();
    const overridden: TemplateSummary[] = [];

    // Collect from space (highest precedence)
    if (this.space) {
      const spaceTemplates = await this.space.list(filter);
      for (const t of spaceTemplates) {
        seen.set(t.name, t);
      }
    }

    // Collect from profile
    if (this.profile) {
      const profileTemplates = await this.profile.list(filter);
      for (const t of profileTemplates) {
        if (seen.has(t.name)) {
          // This template is overridden by space
          if (filter?.includeOverridden) {
            const existing = seen.get(t.name)!;
            t.overrides = {
              level: existing.level,
              profile: existing.profile,
              space: existing.space,
              path: "",
            };
            overridden.push(t);
          }
        } else {
          seen.set(t.name, t);
        }
      }
    }

    // Collect from global (lowest precedence)
    const globalTemplates = await this.global.list(filter);
    for (const t of globalTemplates) {
      if (seen.has(t.name)) {
        // This template is overridden
        if (filter?.includeOverridden) {
          const existing = seen.get(t.name)!;
          t.overrides = {
            level: existing.level,
            profile: existing.profile,
            space: existing.space,
            path: "",
          };
          overridden.push(t);
        }
      } else {
        seen.set(t.name, t);
      }
    }

    // Combine: active templates + overridden (if requested)
    const results = [...seen.values()];
    if (filter?.includeOverridden) {
      results.push(...overridden);
    }

    return results;
  }

  /**
   * Check if a template exists at any level.
   */
  async exists(name: string): Promise<boolean> {
    if (this.space && (await this.space.exists(name))) return true;
    if (this.profile && (await this.profile.exists(name))) return true;
    return this.global.exists(name);
  }

  /**
   * Get summaries for all templates with a given name.
   * Returns which levels have the template.
   */
  async getTemplateLocations(name: string): Promise<TemplateSummary[]> {
    const results: TemplateSummary[] = [];

    if (this.space && (await this.space.exists(name))) {
      const templates = await this.space.list();
      const found = templates.find((t) => t.name === name);
      if (found) results.push(found);
    }

    if (this.profile && (await this.profile.exists(name))) {
      const templates = await this.profile.list();
      const found = templates.find((t) => t.name === name);
      if (found) results.push(found);
    }

    if (await this.global.exists(name)) {
      const templates = await this.global.list();
      const found = templates.find((t) => t.name === name);
      if (found) results.push(found);
    }

    return results;
  }

  /**
   * Get the storage instance for a specific level.
   */
  getStorage(
    level: "global" | "profile" | "space"
  ): TemplateStorage | undefined {
    switch (level) {
      case "global":
        return this.global;
      case "profile":
        return this.profile;
      case "space":
        return this.space;
    }
  }
}
