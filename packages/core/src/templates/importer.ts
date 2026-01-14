/**
 * Template import/export functionality.
 * Handles exporting templates to directory packs and importing from various sources.
 */

import { existsSync } from "node:fs";
import { readdir, readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { join, basename, dirname } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type {
  Template,
  TemplatePackManifest,
  TemplateFilter,
  TemplateSummary,
} from "./types.js";
import type { TemplateStorage } from "./storage.js";
import { TemplateResolver } from "./resolver.js";
import { parseTemplate, serializeTemplate } from "./parser.js";

/**
 * Options for importing templates.
 */
export interface ImportOptions {
  /** Target level - flattens all templates to this level */
  toLevel?: "global";
  /** Target profile - flattens all templates to this profile */
  toProfile?: string;
  /** Target space - flattens all templates to this space */
  toSpace?: string;
  /** Replace existing templates (default: skip) */
  replace?: boolean;
  /** Only import these template names */
  templateNames?: string[];
  /** Source URL for tracking */
  sourceUrl?: string;
}

/**
 * Result of an import operation.
 */
export interface ImportResult {
  imported: string[];
  skipped: string[];
  errors: Array<{ name: string; error: string }>;
}

/**
 * Export templates to a directory with manifest.
 */
export async function exportToDirectory(
  resolver: TemplateResolver,
  outputDir: string,
  filter?: TemplateFilter
): Promise<{ exported: string[]; manifest: TemplatePackManifest }> {
  const templates = await resolver.listAll(filter);
  const exported: string[] = [];

  const manifest: TemplatePackManifest = {
    name: basename(outputDir),
    version: "1.0.0",
    exported_at: new Date().toISOString(),
    templates: {
      global: [],
      profiles: {},
      spaces: {},
    },
  };

  // Create output directory
  await mkdir(outputDir, { recursive: true });

  for (const summary of templates) {
    const template = await resolveTemplateFromSummary(resolver, summary);
    if (!template) continue;

    // Determine output path based on level
    let subDir: string;
    if (summary.level === "global") {
      subDir = "global";
      manifest.templates.global!.push(summary.name);
    } else if (summary.level === "profile" && summary.profile) {
      subDir = join("profiles", summary.profile);
      if (!manifest.templates.profiles![summary.profile]) {
        manifest.templates.profiles![summary.profile] = [];
      }
      manifest.templates.profiles![summary.profile].push(summary.name);
    } else if (summary.level === "space" && summary.space) {
      subDir = join("spaces", summary.space);
      if (!manifest.templates.spaces![summary.space]) {
        manifest.templates.spaces![summary.space] = [];
      }
      manifest.templates.spaces![summary.space].push(summary.name);
    } else {
      continue;
    }

    // Create subdirectory
    const targetDir = join(outputDir, subDir);
    await mkdir(targetDir, { recursive: true });

    // Write template file
    const content = serializeTemplate(template.metadata, template.content);
    await writeFile(join(targetDir, `${summary.name}.md`), content, "utf8");
    exported.push(summary.name);
  }

  // Write manifest
  const manifestContent = stringifyYaml(manifest);
  await writeFile(join(outputDir, "manifest.yml"), manifestContent, "utf8");

  return { exported, manifest };
}

/**
 * Export a single template to a string (for stdout or single file).
 */
export async function exportSingleTemplate(
  resolver: TemplateResolver,
  name: string,
  level?: "global" | "profile" | "space",
  profile?: string,
  space?: string
): Promise<string | null> {
  let template: Template | null = null;

  if (level === "global") {
    const storage = resolver.getStorage("global");
    template = storage ? await storage.get(name) : null;
  } else if (level === "profile" && profile) {
    const storage = resolver.getStorage("profile");
    template = storage ? await storage.get(name) : null;
  } else if (level === "space" && space) {
    const storage = resolver.getStorage("space");
    template = storage ? await storage.get(name) : null;
  } else {
    // Resolve by precedence
    template = await resolver.resolve(name);
  }

  if (!template) return null;

  return serializeTemplate(template.metadata, template.content);
}

/**
 * Import templates from a local directory.
 */
export async function importFromDirectory(
  dir: string,
  storages: {
    global: TemplateStorage;
    getProfile: (name: string) => TemplateStorage;
    getSpace: (key: string) => TemplateStorage;
  },
  options: ImportOptions = {}
): Promise<ImportResult> {
  const result: ImportResult = { imported: [], skipped: [], errors: [] };

  // Read manifest if exists
  let manifest: TemplatePackManifest | null = null;
  const manifestPath = join(dir, "manifest.yml");
  if (existsSync(manifestPath)) {
    const content = await readFile(manifestPath, "utf8");
    manifest = parseYaml(content) as TemplatePackManifest;
  }

  // Determine target storage
  const getTargetStorage = (
    level: "global" | "profile" | "space",
    profileName?: string,
    spaceKey?: string
  ): TemplateStorage => {
    if (options.toLevel === "global") return storages.global;
    if (options.toProfile) return storages.getProfile(options.toProfile);
    if (options.toSpace) return storages.getSpace(options.toSpace);

    // Respect original level
    if (level === "global") return storages.global;
    if (level === "profile" && profileName) return storages.getProfile(profileName);
    if (level === "space" && spaceKey) return storages.getSpace(spaceKey);
    return storages.global;
  };

  // Import from global/
  const globalDir = join(dir, "global");
  if (existsSync(globalDir)) {
    await importTemplatesFromDir(globalDir, "global", undefined, undefined);
  }

  // Import from profiles/
  const profilesDir = join(dir, "profiles");
  if (existsSync(profilesDir)) {
    const profiles = await readdir(profilesDir);
    for (const profile of profiles) {
      const profileDir = join(profilesDir, profile);
      const stat = await import("node:fs/promises").then((m) => m.stat(profileDir));
      if (stat.isDirectory()) {
        await importTemplatesFromDir(profileDir, "profile", profile, undefined);
      }
    }
  }

  // Import from spaces/
  const spacesDir = join(dir, "spaces");
  if (existsSync(spacesDir)) {
    const spaces = await readdir(spacesDir);
    for (const space of spaces) {
      const spaceDir = join(spacesDir, space);
      const stat = await import("node:fs/promises").then((m) => m.stat(spaceDir));
      if (stat.isDirectory()) {
        await importTemplatesFromDir(spaceDir, "space", undefined, space);
      }
    }
  }

  // Also check root level for flat exports
  const rootFiles = await readdir(dir);
  for (const file of rootFiles) {
    if (file.endsWith(".md") && file !== "README.md") {
      const name = file.slice(0, -3);
      if (options.templateNames && !options.templateNames.includes(name)) continue;

      try {
        const content = await readFile(join(dir, file), "utf8");
        const parsed = parseTemplate(content);
        const storage = getTargetStorage("global", undefined, undefined);

        if (!options.replace && (await storage.exists(name))) {
          result.skipped.push(name);
          continue;
        }

        const template: Template = {
          metadata: {
            ...parsed.metadata,
            name,
            _source: options.sourceUrl,
            _source_version: manifest?.version,
          },
          content: parsed.content,
          source: { level: "global", path: "" },
        };

        await storage.save(template);
        result.imported.push(name);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        result.errors.push({ name, error: message });
      }
    }
  }

  async function importTemplatesFromDir(
    templateDir: string,
    level: "global" | "profile" | "space",
    profileName?: string,
    spaceKey?: string
  ) {
    const files = await readdir(templateDir);
    for (const file of files) {
      if (!file.endsWith(".md")) continue;

      const name = file.slice(0, -3);
      if (options.templateNames && !options.templateNames.includes(name)) continue;

      try {
        const content = await readFile(join(templateDir, file), "utf8");
        const parsed = parseTemplate(content);
        const storage = getTargetStorage(level, profileName, spaceKey);

        if (!options.replace && (await storage.exists(name))) {
          result.skipped.push(name);
          continue;
        }

        const template: Template = {
          metadata: {
            ...parsed.metadata,
            name,
            _source: options.sourceUrl,
            _source_version: manifest?.version,
          },
          content: parsed.content,
          source: {
            level: options.toLevel ?? options.toProfile ? "profile" : options.toSpace ? "space" : level,
            profile: options.toProfile ?? profileName,
            space: options.toSpace ?? spaceKey,
            path: "",
          },
        };

        await storage.save(template);
        result.imported.push(name);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        result.errors.push({ name, error: message });
      }
    }
  }

  return result;
}

/**
 * Import templates from a Git URL (shallow clone).
 */
export async function importFromGitUrl(
  url: string,
  storages: {
    global: TemplateStorage;
    getProfile: (name: string) => TemplateStorage;
    getSpace: (key: string) => TemplateStorage;
  },
  options: ImportOptions = {}
): Promise<ImportResult> {
  const tmpDir = join(tmpdir(), `atlcli-import-${randomUUID()}`);

  try {
    // Shallow clone
    const { execSync } = await import("node:child_process");
    execSync(`git clone --depth 1 "${url}" "${tmpDir}"`, {
      stdio: "pipe",
      timeout: 60000,
    });

    // Import from cloned directory
    return await importFromDirectory(tmpDir, storages, {
      ...options,
      sourceUrl: url,
    });
  } finally {
    // Cleanup
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Import templates from a direct URL (tar.gz).
 */
export async function importFromUrl(
  url: string,
  storages: {
    global: TemplateStorage;
    getProfile: (name: string) => TemplateStorage;
    getSpace: (key: string) => TemplateStorage;
  },
  options: ImportOptions = {}
): Promise<ImportResult> {
  const tmpDir = join(tmpdir(), `atlcli-import-${randomUUID()}`);

  try {
    await mkdir(tmpDir, { recursive: true });

    // Download and extract
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`);
    }

    const buffer = await response.arrayBuffer();

    if (url.endsWith(".tar.gz") || url.endsWith(".tgz")) {
      // Use tar command to extract
      const tarFile = join(tmpDir, "archive.tar.gz");
      await writeFile(tarFile, Buffer.from(buffer));

      const { execSync } = await import("node:child_process");
      execSync(`tar -xzf "${tarFile}" -C "${tmpDir}"`, {
        stdio: "pipe",
        timeout: 60000,
      });

      // Find the extracted directory (often has a single subdirectory)
      const entries = await readdir(tmpDir);
      const subdirs = entries.filter(
        (e) => e !== "archive.tar.gz" && existsSync(join(tmpDir, e))
      );

      let importDir = tmpDir;
      if (subdirs.length === 1) {
        const stat = await import("node:fs/promises").then((m) =>
          m.stat(join(tmpDir, subdirs[0]))
        );
        if (stat.isDirectory()) {
          importDir = join(tmpDir, subdirs[0]);
        }
      }

      return await importFromDirectory(importDir, storages, {
        ...options,
        sourceUrl: url,
      });
    } else if (url.endsWith(".zip")) {
      // Use unzip command
      const zipFile = join(tmpDir, "archive.zip");
      await writeFile(zipFile, Buffer.from(buffer));

      const { execSync } = await import("node:child_process");
      execSync(`unzip -q "${zipFile}" -d "${tmpDir}"`, {
        stdio: "pipe",
        timeout: 60000,
      });

      // Find extracted directory
      const entries = await readdir(tmpDir);
      const subdirs = entries.filter(
        (e) => e !== "archive.zip" && existsSync(join(tmpDir, e))
      );

      let importDir = tmpDir;
      if (subdirs.length === 1) {
        const stat = await import("node:fs/promises").then((m) =>
          m.stat(join(tmpDir, subdirs[0]))
        );
        if (stat.isDirectory()) {
          importDir = join(tmpDir, subdirs[0]);
        }
      }

      return await importFromDirectory(importDir, storages, {
        ...options,
        sourceUrl: url,
      });
    } else {
      throw new Error("Unsupported archive format. Use .tar.gz, .tgz, or .zip");
    }
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Detect the type of import source.
 */
export function detectImportSourceType(
  source: string
): "directory" | "git" | "url" {
  if (existsSync(source)) {
    return "directory";
  }
  if (source.startsWith("https://github.com/") || source.startsWith("git@") || source.endsWith(".git")) {
    return "git";
  }
  if (source.startsWith("http://") || source.startsWith("https://")) {
    return "url";
  }
  // Assume directory path that doesn't exist yet
  return "directory";
}

/**
 * Get templates that have tracked sources for update.
 */
export async function getTrackedTemplates(
  resolver: TemplateResolver,
  sourceUrl?: string
): Promise<Array<{ name: string; level: string; source: string; version?: string }>> {
  const templates = await resolver.listAll({ includeOverridden: true });
  const tracked: Array<{ name: string; level: string; source: string; version?: string }> = [];

  for (const summary of templates) {
    const template = await resolveTemplateFromSummary(resolver, summary);
    if (!template) continue;

    if (template.metadata._source) {
      if (!sourceUrl || template.metadata._source === sourceUrl) {
        tracked.push({
          name: summary.name,
          level: summary.level + (summary.profile ? `:${summary.profile}` : "") + (summary.space ? `:${summary.space}` : ""),
          source: template.metadata._source,
          version: template.metadata._source_version,
        });
      }
    }
  }

  return tracked;
}

/**
 * Helper to resolve a template from its summary.
 */
async function resolveTemplateFromSummary(
  resolver: TemplateResolver,
  summary: TemplateSummary
): Promise<Template | null> {
  const storage = resolver.getStorage(summary.level);
  if (!storage) return null;
  return storage.get(summary.name);
}
